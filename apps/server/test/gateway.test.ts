import { connect } from 'node:net';
import { request as httpRequest } from 'undici';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiKeySummary, MachineCreated } from '@agentbox/shared';
import { aiKey, auditLog, machine as machineTable } from '../src/db/schema.ts';
import { ANTHROPIC_OAUTH_BETA, cleanQuery, safePath } from '../src/gateway/relay.ts';
import { renderMachineScript } from '../src/gateway/script.ts';
import { ipAllowed } from '../src/gateway/store.ts';
import { UsageMeter } from '../src/gateway/usage.ts';
import { FakeProvider } from './helpers/fake-provider.ts';
import { buildApp } from '../src/app.ts';
import { Harness, ORIGIN, RP_ID, testConfig, type Browser } from './helpers/harness.ts';

const REAL_KEY = 'sk-ant-api03-REAL-SECRET-KEY-0000000000000000000000000abcd';
const MACHINE_IP = '198.51.100.50';
const DAY = 86_400_000;

let h: Harness;
let laptop: Browser;
let provider: FakeProvider;

beforeEach(async () => {
  h = await Harness.create();
  laptop = h.browser();
  await h.completeSetup(laptop);
  provider = await new FakeProvider().start();
});
afterEach(async () => {
  await h.close();
  await provider.stop();
});

async function addKey(body: Record<string, unknown> = {}): Promise<AiKeySummary> {
  await h.reauth(laptop);
  const res = await laptop.post('/api/gateway/keys', {
    preset: 'anthropic',
    name: 'Claude API',
    slug: 'anthropic',
    secret: REAL_KEY,
    upstream: provider.url,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AiKeySummary>();
}

async function addMachine(keyIds: string[], body: Record<string, unknown> = {}) {
  await h.reauth(laptop);
  const res = await laptop.post('/api/gateway/machines', {
    name: 'gpu-1',
    keyIds,
    dailyTokenLimit: null,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<MachineCreated>();
}

/** A request from a CLI on a machine: no cookies, no browser headers. */
function gw(opts: {
  method?: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  payload?: string | Buffer | object;
  ip?: string;
}) {
  return h.app.inject({
    method: opts.method ?? 'POST',
    url: opts.url,
    headers: {
      host: RP_ID,
      'x-forwarded-for': opts.ip ?? MACHINE_IP,
      'x-forwarded-proto': 'https',
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.0.0 (external, cli)',
      ...opts.headers,
    },
    ...(opts.payload === undefined
      ? {}
      : {
          payload:
            typeof opts.payload === 'string' || Buffer.isBuffer(opts.payload)
              ? opts.payload
              : JSON.stringify(opts.payload),
        }),
  });
}

const messages = {
  model: 'claude-sonnet-4-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
};

describe('AI keys', () => {
  it('stores the key encrypted and never shows it again', async () => {
    const key = await addKey();
    expect(key.hint).toBe('abcd');
    expect(JSON.stringify(key)).not.toContain('REAL-SECRET');
    expect(key.gatewayUrl).toBe(`${ORIGIN}/gw/anthropic`);

    const overview = await laptop.get('/api/gateway');
    expect(overview.body).not.toContain('REAL-SECRET');

    const row = h.services.db.select().from(aiKey).get();
    expect(row?.secretEnc.startsWith('enc1.')).toBe(true);
    expect(row?.secretEnc).not.toContain('REAL-SECRET');
    const audit = h.services.db.select().from(auditLog).all();
    expect(JSON.stringify(audit)).not.toContain('REAL-SECRET');
    expect(audit.some((a) => a.action === 'ai_key.added')).toBe(true);
  });

  it('needs a fresh passkey check to add a key', async () => {
    h.clock.advance(6 * 60_000);
    const res = await laptop.post('/api/gateway/keys', {
      preset: 'anthropic',
      name: 'x',
      slug: 'anthropic',
      secret: REAL_KEY,
    });
    expect(res.json().error.code).toBe('fresh_auth_required');
  });

  it('refuses plain-HTTP, query-string and duplicate addresses', async () => {
    await h.reauth(laptop);
    const post = (body: Record<string, unknown>) =>
      laptop.post('/api/gateway/keys', {
        preset: 'custom',
        name: 'Other',
        slug: 'other',
        secret: 'secret-123456',
        ...body,
      });
    expect((await post({ upstream: 'http://api.example.com' })).json().error.message).toMatch(
      /https:\/\//,
    );
    expect((await post({ upstream: 'https://api.example.com/?key=1' })).statusCode).toBe(400);
    expect((await post({ upstream: 'https://user:pw@api.example.com' })).statusCode).toBe(400);
    expect((await post({ upstream: 'https://api.example.com', slug: '_machine' })).statusCode).toBe(
      400,
    );
    expect((await post({ upstream: 'https://api.example.com' })).statusCode).toBe(200);
    expect((await post({ upstream: 'https://api.example.com' })).statusCode).toBe(409);
  });
});

describe('machines', () => {
  it('shows the pass once and keeps only its hash', async () => {
    const key = await addKey();
    const created = await addMachine([key.id]);
    expect(created.pass).toMatch(/^abx_[A-Za-z0-9_-]{43}$/);
    expect(created.installCommand).toBe(`curl -fsSL ${ORIGIN}/machine.sh | sh`);
    expect(created.machine.expiresAt).not.toBeNull();

    const overview = await laptop.get('/api/gateway');
    expect(overview.body).not.toContain(created.pass);
    const row = h.services.db.select().from(machineTable).get();
    expect(JSON.stringify(row)).not.toContain(created.pass);
    expect(row?.passPrefix).toBe(created.pass.slice(0, 10));
  });

  it('refuses two keys for the same CLI on one machine', async () => {
    const a = await addKey();
    const b = await addKey({
      preset: 'anthropic-subscription',
      slug: 'claude',
      name: 'Claude Max',
    });
    await h.reauth(laptop);
    const res = await laptop.post('/api/gateway/machines', {
      name: 'gpu-1',
      keyIds: [a.id, b.id],
      dailyTokenLimit: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/both for claude/);
  });

  it('lets the setup script see which CLIs to wire up', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const text = await gw({
      method: 'GET',
      url: '/gw/_machine',
      headers: { authorization: `Bearer ${pass}`, accept: 'text/plain' },
    });
    expect(text.statusCode).toBe(200);
    const lines = text.body
      .trim()
      .split('\n')
      .map((l) => l.split('\t'));
    expect(lines[0]?.[0]).toBe('machine');
    expect(lines[0]?.[2]).toBe('gpu-1');
    expect(lines[1]).toEqual(['key', 'anthropic', 'claude', '-', 'Claude API']);
  });

  it('serves the setup script with this agentbox address and no secrets', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/machine.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`AGENTBOX_URL='${ORIGIN}'`);
    expect(res.body).not.toContain('@@');
    expect(() => renderMachineScript("https://x.example'; rm -rf ~")).toThrow();
  });
});

describe('relay', () => {
  it('swaps the pass for the real key and passes the answer back', async () => {
    const key = await addKey();
    const { pass, machine } = await addMachine([key.id]);
    const res = await gw({
      url: '/gw/anthropic/v1/messages?beta=true',
      headers: {
        'x-api-key': pass,
        'anthropic-version': '2023-06-01',
        cookie: 'agentbox_sid=stolen',
        'x-forwarded-host': 'evil.example',
      },
      payload: messages,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().content[0].text).toBe('Hello from the fake provider');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['request-id']).toBe('req_fake');

    const seen = provider.last();
    expect(seen.url).toBe('/v1/messages?beta=true');
    expect(seen.headers['x-api-key']).toBe(REAL_KEY);
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.headers['user-agent']).toContain('claude-cli');
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-forwarded-for']).toBeUndefined();
    expect(seen.headers['x-forwarded-host']).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(pass);
    expect(JSON.parse(seen.body)).toEqual(messages);

    const usage = h.services.gateway.recentUsage(10, machine.id);
    expect(usage[0]).toMatchObject({
      keySlug: 'anthropic',
      path: '/v1/messages',
      model: 'claude-sonnet-4-5',
      status: 200,
      inputTokens: 10,
      outputTokens: 5,
    });
    const overview = (await laptop.get('/api/gateway')).json();
    expect(overview.machines[0].today).toEqual({ requests: 1, inputTokens: 10, outputTokens: 5 });
    expect(overview.machines[0].lastIp).toBe(MACHINE_IP);
    expect(overview.keys[0].lastUsedAt).not.toBeNull();
  });

  it('streams server-sent events unchanged and counts their tokens', async () => {
    const key = await addKey();
    const { pass, machine } = await addMachine([key.id]);
    const res = await gw({
      url: '/gw/anthropic/v1/messages',
      headers: { authorization: `Bearer ${pass}` },
      payload: { ...messages, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('Hello from the fake provider');
    expect(res.body.match(/^event: /gm)).toHaveLength(6);
    const [row] = h.services.gateway.recentUsage(1, machine.id);
    expect(row).toMatchObject({ inputTokens: 15, outputTokens: 7 });
  });

  it('sends bearer keys and Claude subscription tokens the way the provider expects', async () => {
    const openai = await addKey({
      preset: 'openai',
      slug: 'openai',
      name: 'OpenAI',
      secret: 'sk-proj-REAL-OPENAI-1234',
    });
    const sub = await addKey({
      preset: 'anthropic-subscription',
      slug: 'claude',
      name: 'Claude Max',
      secret: 'sk-ant-oat01-REAL-SUB-5678',
    });
    const { pass } = await addMachine([openai.id, sub.id]);

    await gw({
      url: '/gw/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${pass}`, 'openai-organization': 'org-x' },
      payload: { model: 'gpt-5', messages: [] },
    });
    expect(provider.last().headers.authorization).toBe('Bearer sk-proj-REAL-OPENAI-1234');

    await gw({
      url: '/gw/claude/v1/messages',
      headers: {
        authorization: `Bearer ${pass}`,
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      },
      payload: messages,
    });
    const seen = provider.last();
    expect(seen.headers.authorization).toBe('Bearer sk-ant-oat01-REAL-SUB-5678');
    expect(seen.headers['x-api-key']).toBeUndefined();
    expect(seen.headers['anthropic-beta']).toBe(
      `fine-grained-tool-streaming-2025-05-14,${ANTHROPIC_OAUTH_BETA}`,
    );
  });

  it('takes a Gemini pass from ?key= and never forwards it', async () => {
    const key = await addKey({
      preset: 'gemini',
      slug: 'gemini',
      name: 'Gemini',
      secret: 'AIzaREAL-GEMINI-KEY',
    });
    const { pass, machine } = await addMachine([key.id]);
    const res = await gw({
      url: `/gw/gemini/v1beta/models/gemini-2.5-pro:generateContent?key=${pass}&alt=json`,
      payload: { contents: [] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const seen = provider.last();
    expect(seen.url).toBe('/v1beta/models/gemini-2.5-pro:generateContent?alt=json');
    expect(seen.headers['x-goog-api-key']).toBe('AIzaREAL-GEMINI-KEY');
    const [row] = h.services.gateway.recentUsage(1, machine.id);
    expect(row).toMatchObject({ model: 'gemini-2.5-pro', inputTokens: 8, outputTokens: 2 });
  });

  it('accepts large requests and passes large answers through', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const big = { ...messages, messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] };
    const res = await gw({
      url: '/gw/anthropic/v1/messages',
      headers: { 'x-api-key': pass },
      payload: big,
    });
    expect(res.statusCode).toBe(200);
    const bin = await gw({
      method: 'GET',
      url: '/gw/anthropic/big',
      headers: { 'x-api-key': pass },
    });
    expect(bin.rawPayload.length).toBe(3 * 1024 * 1024);
  });

  it('answers 502 with a clear message when the provider is down', async () => {
    const key = await addKey({ upstream: 'http://127.0.0.1:9' });
    const { pass } = await addMachine([key.id]);
    const res = await gw({
      url: '/gw/anthropic/v1/messages',
      headers: { 'x-api-key': pass },
      payload: messages,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/agentbox: could not reach 127\.0\.0\.1:9/);
  });
});

describe('who may use the relay', () => {
  it('rejects a missing or wrong pass in a format every CLI can show', async () => {
    const key = await addKey();
    await addMachine([key.id]);
    for (const headers of [
      {},
      { 'x-api-key': 'abx_' + 'A'.repeat(43) },
      { 'x-api-key': REAL_KEY },
    ]) {
      const res = await gw({ url: '/gw/anthropic/v1/messages', headers, payload: messages });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
      expect(res.json().error.message).toMatch(/^agentbox: /);
    }
    expect(provider.seen).toHaveLength(0);
  });

  it('ignores browser cookies: a signed-in browser still needs a pass', async () => {
    const key = await addKey();
    await addMachine([key.id]);
    const res = await laptop.request({
      method: 'POST',
      url: '/gw/anthropic/v1/messages',
      payload: messages,
    });
    expect(res.statusCode).toBe(401);
    expect(provider.seen).toHaveLength(0);
  });

  it('locks out an address that keeps guessing passes', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const wrong = { 'x-api-key': 'abx_' + 'B'.repeat(43) };
    for (let i = 0; i < 20; i++)
      await gw({ url: '/gw/anthropic/v1/messages', headers: wrong, ip: '192.0.2.66' });
    const locked = await gw({
      url: '/gw/anthropic/v1/messages',
      headers: { 'x-api-key': pass },
      ip: '192.0.2.66',
    });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // Other addresses are unaffected.
    const ok = await gw({
      url: '/gw/anthropic/v1/messages',
      headers: { 'x-api-key': pass },
      payload: messages,
    });
    expect(ok.statusCode).toBe(200);
    const actions = h.services.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toContain('machine.bad_pass_lockout');
  });

  it('stops a machine at once, and a stopped pass never works again', async () => {
    const key = await addKey();
    const { pass, machine } = await addMachine([key.id]);
    const call = () =>
      gw({ url: '/gw/anthropic/v1/messages', headers: { 'x-api-key': pass }, payload: messages });
    expect((await call()).statusCode).toBe(200);
    // Stopping needs no passkey check.
    h.clock.advance(10 * 60_000);
    expect((await laptop.post(`/api/gateway/machines/${machine.id}/revoke`)).statusCode).toBe(200);
    const res = await call();
    // 403 so CLIs show the message instead of retrying a login.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { type: 'permission_error' } });
    expect(res.json().error.message).toMatch(/stopped/);
  });

  it('expires passes, and renewing brings them back', async () => {
    const key = await addKey();
    const { pass, machine } = await addMachine([key.id], { lifetimeDays: 7 });
    const call = () =>
      gw({ url: '/gw/anthropic/v1/messages', headers: { 'x-api-key': pass }, payload: messages });
    h.clock.advance(7 * DAY + 1000);
    const expired = await call();
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error.message).toMatch(/expired.*Renew/);
    await h.signInWithPasskey(laptop);
    await h.reauth(laptop);
    const renew = await laptop.request({
      method: 'PATCH',
      url: `/api/gateway/machines/${machine.id}`,
      payload: { renewDays: 30 },
    });
    expect(renew.statusCode, renew.body).toBe(200);
    expect((await call()).statusCode).toBe(200);
  });

  it('keeps an IP-locked pass to its addresses', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id], { ipRules: ['198.51.100.0/24'] });
    const from = (ip: string) =>
      gw({
        url: '/gw/anthropic/v1/messages',
        headers: { 'x-api-key': pass },
        payload: messages,
        ip,
      });
    expect((await from('198.51.100.77')).statusCode).toBe(200);
    const blocked = await from('203.0.113.9');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/locked to other addresses/);
    const actions = h.services.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toContain('machine.blocked_ip');
  });

  it('only lets a machine use the keys it was given', async () => {
    const a = await addKey();
    await addKey({
      preset: 'openai',
      slug: 'openai',
      name: 'OpenAI',
      secret: 'sk-proj-OTHER-9999',
    });
    const { pass } = await addMachine([a.id]);
    const other = await gw({
      url: '/gw/openai/v1/chat/completions',
      headers: { authorization: `Bearer ${pass}` },
      payload: {},
    });
    expect(other.statusCode).toBe(403);
    const missing = await gw({
      url: '/gw/nope/v1/x',
      headers: { authorization: `Bearer ${pass}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(provider.seen).toHaveLength(0);
  });

  it('applies the per-minute speed limit', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id], { rpm: 3 });
    const call = () =>
      gw({ url: '/gw/anthropic/v1/messages', headers: { 'x-api-key': pass }, payload: messages });
    for (let i = 0; i < 3; i++) expect((await call()).statusCode).toBe(200);
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.type).toBe('rate_limit_error');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    h.clock.advance(61_000);
    expect((await call()).statusCode).toBe(200);
  });

  it('applies the daily token limit and resets it the next day', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id], { dailyTokenLimit: 1000 });
    const call = () =>
      gw({ url: '/gw/anthropic/v1/messages', headers: { 'x-api-key': pass }, payload: messages });
    // Each fake answer uses 15 tokens.
    h.services.gateway.recordUsage({
      ts: h.clock.now(),
      machineId: h.services.gateway.listMachines()[0]!.id,
      keyId: key.id,
      keySlug: key.slug,
      method: 'POST',
      path: '/v1/messages',
      model: null,
      status: 200,
      durationMs: 1,
      requestBytes: 1,
      responseBytes: 1,
      inputTokens: 990,
      outputTokens: 0,
    });
    expect((await call()).statusCode).toBe(200);
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.message).toMatch(/daily token limit/);
    h.clock.advance(DAY);
    await h.signInWithPasskey(laptop);
    expect((await call()).statusCode).toBe(200);
  });

  it('records a new address as a security event', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const call = (ip: string) =>
      gw({
        url: '/gw/anthropic/v1/messages',
        headers: { 'x-api-key': pass },
        payload: messages,
        ip,
      });
    await call(MACHINE_IP);
    await call(MACHINE_IP);
    await call('203.0.113.200');
    const events = h.services.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action.startsWith('machine.') && a.action !== 'machine.added');
    expect(events.map((e) => e.action)).toEqual(['machine.first_used', 'machine.ip_changed']);
    expect(JSON.parse(events[1]!.details)).toMatchObject({ previousIp: MACHINE_IP });
  });
});

describe('SuperGrok login', () => {
  const JWT = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.sig`;

  async function loginKey() {
    return addKey({ preset: 'grok-login', name: 'SuperGrok', slug: 'supergrok', secret: '' });
  }

  it('needs nothing pasted, and never stores a secret for it', async () => {
    const key = await loginKey();
    expect(key.auth).toBe('grok-login');
    expect(key.cli).toBe('grok');
    expect(key.hint).toBe('VPS login');
    await h.reauth(laptop);
    const custom = await laptop.post('/api/gateway/keys', {
      preset: 'custom',
      name: 'x',
      slug: 'x-login',
      secret: 'something-long',
      upstream: provider.url,
      auth: 'grok-login',
    });
    expect(custom.statusCode).toBe(400);
  });

  it('hands a machine a short-lived token from the vault login, and nothing else', async () => {
    const key = await loginKey();
    const { pass } = await addMachine([key.id]);
    const ask = vi
      .spyOn(h.services.terminals.client, 'request')
      .mockResolvedValue({ token: JWT, expiresAt: h.clock.now() + 3_600_000 });
    const res = await gw({
      method: 'GET',
      url: '/gw/supergrok/_token',
      headers: { authorization: `Bearer ${pass}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      access_token: JWT,
      expires_in: 3600,
      issuer: 'https://auth.x.ai',
    });
    expect(ask).toHaveBeenCalledWith({ op: 'grok.token' });
    // Not a relay: nothing is forwarded anywhere.
    const chat = await gw({
      url: '/gw/supergrok/v1/chat/completions',
      headers: { authorization: `Bearer ${pass}` },
      payload: {},
    });
    expect(chat.statusCode).toBe(404);
    expect(provider.seen).toHaveLength(0);
    const actions = h.services.audit.page(20).entries.map((e) => e.action);
    expect(actions).toContain('machine.grok_token');
  });

  it('needs a valid pass, and says clearly when the vault is locked', async () => {
    const key = await loginKey();
    const { pass, machine } = await addMachine([key.id]);
    const ask = vi.spyOn(h.services.terminals.client, 'request');
    const anon = await gw({ method: 'GET', url: '/gw/supergrok/_token' });
    expect(anon.statusCode).toBe(401);
    expect(ask).not.toHaveBeenCalled();

    const { TermdRefused } = await import('../src/terminals/client.ts');
    ask.mockRejectedValue(new TermdRefused('vault_locked', 'Unlock the vault first.'));
    const locked = await gw({
      method: 'GET',
      url: '/gw/supergrok/_token',
      headers: { authorization: `Bearer ${pass}` },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.message).toMatch(/vault on agentbox is locked/);

    await laptop.post(`/api/gateway/machines/${machine.id}/revoke`);
    const stopped = await gw({
      method: 'GET',
      url: '/gw/supergrok/_token',
      headers: { authorization: `Bearer ${pass}` },
    });
    expect(stopped.statusCode).toBe(403);
  });

  it('tells older setup scripts to skip it', async () => {
    const key = await loginKey();
    const { pass } = await addMachine([key.id]);
    const text = await gw({
      method: 'GET',
      url: '/gw/_machine',
      headers: { authorization: `Bearer ${pass}`, accept: 'text/plain' },
    });
    expect(text.body.trim().split('\n')[1]?.split('\t')).toEqual([
      'key',
      'supergrok',
      'grok-login',
      '-',
      'SuperGrok',
    ]);
  });
});

describe('live streams', () => {
  async function listen() {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function openSlow(base: string, pass: string) {
    const res = await httpRequest(`${base}/gw/anthropic/slow`, {
      method: 'GET',
      headers: { 'x-api-key': pass, 'x-forwarded-for': MACHINE_IP },
    });
    expect(res.statusCode).toBe(200);
    return res;
  }

  it('refuses paths that try to escape the provider address', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const base = await listen();
    const { port } = new URL(base);
    // A raw socket, because HTTP clients tidy up ../ before sending.
    const raw = (path: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = connect(Number(port), '127.0.0.1', () => {
          sock.write(
            `GET ${path} HTTP/1.1\r\nHost: ${RP_ID}\r\nx-api-key: ${pass}\r\nConnection: close\r\n\r\n`,
          );
        });
        let out = '';
        sock.on('data', (d: Buffer) => (out += d.toString()));
        sock.on('end', () => {
          resolve(out.split('\r\n')[0] ?? '');
        });
        sock.on('error', reject);
      });
    for (const path of [
      '/gw/anthropic/v1/../admin',
      '/gw/anthropic/v1/%2e%2e/admin',
      '/gw/anthropic/v1//x',
      '/gw/anthropic/v1/%2F..%2Fx',
      '/gw/anthropic/v1/a%5cb',
    ]) {
      expect(await raw(path), path).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(safePath('v1/messages')).toBe('/v1/messages');
    expect(safePath('v1/../x')).toBeNull();
    expect(safePath('v1/.')).toBeNull();
    expect(safePath('v1/a\\b')).toBeNull();
    expect(provider.seen).toHaveLength(0);
  });

  it('cuts a streaming answer the moment the machine is stopped', async () => {
    const key = await addKey();
    const { pass, machine } = await addMachine([key.id]);
    const base = await listen();
    const res = await openSlow(base, pass);
    const done = res.body.text().then(
      () => 'ended',
      () => 'cut',
    );
    await new Promise((r) => setTimeout(r, 150));
    expect((await laptop.post(`/api/gateway/machines/${machine.id}/revoke`)).statusCode).toBe(200);
    const started = Date.now();
    expect(['ended', 'cut']).toContain(await done);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect.poll(() => provider.slowClosed).toBe(true);
  });

  it('also cuts streams when a machine is stopped over SSH (another process)', async () => {
    const key = await addKey();
    const { pass, machine } = await addMachine([key.id]);
    const base = await listen();
    const res = await openSlow(base, pass);
    const done = res.body.text().catch(() => 'cut');
    // The SSH command only changes the database; the watchdog notices.
    h.services.db
      .update(machineTable)
      .set({ revokedAt: h.clock.now() })
      .where(eq(machineTable.id, machine.id))
      .run();
    const started = Date.now();
    await done;
    expect(Date.now() - started).toBeLessThan(3000);
    await expect.poll(() => provider.slowClosed).toBe(true);
  });

  it('stops the provider request when the machine hangs up', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const base = await listen();
    const res = await openSlow(base, pass);
    res.body.destroy();
    await expect.poll(() => provider.slowClosed).toBe(true);
    await expect.poll(() => h.services.gateway.recentUsage(5).length).toBe(1);
  });

  it('logs 499, not a gateway error, when the machine gives up before the answer', async () => {
    const key = await addKey();
    const { pass } = await addMachine([key.id]);
    const base = await listen();
    const ctrl = new AbortController();
    const pending = httpRequest(`${base}/gw/anthropic/hang`, {
      method: 'POST',
      headers: {
        'x-api-key': pass,
        'x-forwarded-for': MACHINE_IP,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: ctrl.signal,
    }).catch(() => 'aborted');
    await expect.poll(() => provider.seen.some((r) => r.url === '/hang')).toBe(true);
    ctrl.abort();
    expect(await pending).toBe('aborted');
    await expect.poll(() => provider.hangClosed).toBe(true);
    await expect.poll(() => h.services.gateway.recentUsage(5)[0]?.status).toBe(499);
  });
});

describe('logs', () => {
  it('never write a pass or key, even one sent in ?key=', async () => {
    const lines: string[] = [];
    const logged = new Harness(testConfig({ LOG_LEVEL: 'info' }));
    logged.app = await buildApp(logged.services, { logStream: { write: (l) => lines.push(l) } });
    await logged.app.ready();
    const pass = `abx_${'C'.repeat(43)}`;
    await logged.app.inject({
      method: 'POST',
      url: `/gw/gemini/v1beta/models/x:generateContent?key=${pass}`,
      headers: { 'x-api-key': pass, authorization: `Bearer ${pass}`, 'x-goog-api-key': pass },
      payload: '{}',
    });
    await logged.close();
    expect(lines.some((l) => l.includes('/gw/gemini/v1beta/models/x:generateContent'))).toBe(true);
    expect(lines.join('')).not.toContain(pass);
  });
});

describe('helpers', () => {
  it('matches IP locks for single addresses, ranges and IPv4-mapped IPv6', () => {
    expect(ipAllowed('10.1.2.3', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('10.2.0.1', ['10.1.0.0/16', '192.0.2.1'])).toBe(false);
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
  });

  it('drops key= from query strings', () => {
    expect(cleanQuery('/x?alt=sse&key=abc')).toEqual({ query: '?alt=sse', key: 'abc' });
    expect(cleanQuery('/x')).toEqual({ query: '', key: undefined });
  });

  it('reads token usage from OpenAI streams and Responses events', () => {
    const chat = new UsageMeter('text/event-stream');
    chat.push(Buffer.from('data: {"choices":[{"delta":{"content":"a"}}],"usage":null}\n\n'));
    chat.push(
      Buffer.from(
        'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      ),
    );
    expect(chat.finish()).toEqual({ inputTokens: 9, outputTokens: 3 });

    const responses = new UsageMeter('text/event-stream; charset=utf-8');
    responses.push(
      Buffer.from(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":6}}}\n',
      ),
    );
    expect(responses.finish()).toEqual({ inputTokens: 40, outputTokens: 6 });

    const other = new UsageMeter('application/octet-stream');
    other.push(Buffer.from('{"usage":{"prompt_tokens":1}}'));
    expect(other.finish()).toEqual({ inputTokens: null, outputTokens: null });
  });
});
