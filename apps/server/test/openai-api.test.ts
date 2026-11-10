import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiKeySummary, MachineCreated } from '@agentbox/shared';
import { chooseKey, openaiRoute, providerBody } from '../src/gateway/openai.ts';
import type { AiKeyRow } from '../src/gateway/store.ts';
import { FakeProvider } from './helpers/fake-provider.ts';
import { Harness, RP_ID, type Browser } from './helpers/harness.ts';

const ANTHROPIC_KEY = 'sk-ant-api03-REAL-ANTHROPIC-0000000000000000000000000abcd';
const GEMINI_KEY = 'AIza-REAL-GEMINI-KEY-00000000000000000wxyz';
const OPENROUTER_KEY = 'sk-or-REAL-OPENROUTER-0000000000000000mnop';
const MACHINE_IP = '198.51.100.60';

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

async function addKey(body: Record<string, unknown>): Promise<AiKeySummary> {
  await h.reauth(laptop);
  const res = await laptop.post('/api/gateway/keys', { upstream: provider.url, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AiKeySummary>();
}

async function addMachine(keyIds: string[]): Promise<MachineCreated> {
  await h.reauth(laptop);
  const res = await laptop.post('/api/gateway/machines', {
    name: 'my-app',
    keyIds,
    dailyTokenLimit: null,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<MachineCreated>();
}

/** A request from an OpenAI SDK: a bearer API key, JSON, no cookies. */
function api(opts: { method?: 'GET' | 'POST'; url: string; pass?: string; payload?: object }) {
  return h.app.inject({
    method: opts.method ?? 'POST',
    url: opts.url,
    headers: {
      host: RP_ID,
      'x-forwarded-for': MACHINE_IP,
      'x-forwarded-proto': 'https',
      'content-type': 'application/json',
      'user-agent': 'OpenAI/Python 2.3.0',
      ...(opts.pass ? { authorization: `Bearer ${opts.pass}` } : {}),
    },
    ...(opts.payload ? { payload: JSON.stringify(opts.payload) } : {}),
  });
}

const chat = (model: string, extra: object = {}) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

async function threeKeys() {
  const anthropic = await addKey({
    preset: 'anthropic',
    name: 'Claude API',
    slug: 'anthropic',
    secret: ANTHROPIC_KEY,
  });
  const gemini = await addKey({
    preset: 'gemini',
    name: 'Gemini',
    slug: 'gemini',
    secret: GEMINI_KEY,
    model: 'gemini-2.5-flash',
  });
  const openrouter = await addKey({
    preset: 'openrouter',
    name: 'OpenRouter',
    slug: 'openrouter',
    secret: OPENROUTER_KEY,
  });
  return { anthropic, gemini, openrouter };
}

describe('OpenAI-compatible API', () => {
  it('sends each model to its key’s OpenAI-compatible address with the real key', async () => {
    const { anthropic, gemini, openrouter } = await threeKeys();
    const { pass, machine } = await addMachine([anthropic.id, gemini.id, openrouter.id]);

    let res = await api({
      url: '/v1/chat/completions',
      pass,
      payload: chat('anthropic/claude-sonnet-4-5'),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().choices[0].message.content).toBe('hi');
    let seen = provider.last();
    expect(seen.url).toBe('/v1/chat/completions');
    expect(seen.headers.authorization).toBe(`Bearer ${ANTHROPIC_KEY}`);
    expect(seen.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(seen.body).model).toBe('claude-sonnet-4-5');
    expect(JSON.stringify(seen.headers)).not.toContain(pass);

    // A key with its own model: the key's name alone is enough.
    res = await api({ url: '/v1/chat/completions', pass, payload: chat('gemini') });
    expect(res.statusCode, res.body).toBe(200);
    seen = provider.last();
    expect(seen.url).toBe('/v1beta/openai/chat/completions');
    expect(seen.headers.authorization).toBe(`Bearer ${GEMINI_KEY}`);
    expect(JSON.parse(seen.body).model).toBe('gemini-2.5-flash');

    // Only the first part names the key; the rest is the provider's model.
    res = await api({
      url: '/v1/chat/completions',
      pass,
      payload: chat('openrouter/meta-llama/llama-4-scout'),
    });
    expect(res.statusCode, res.body).toBe(200);
    seen = provider.last();
    expect(seen.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(JSON.parse(seen.body).model).toBe('meta-llama/llama-4-scout');

    const usage = h.services.gateway.recentUsage(10, machine.id);
    expect(usage).toHaveLength(3);
    expect(usage.find((u) => u.keySlug === 'openrouter')).toMatchObject({
      keySlug: 'openrouter',
      path: '/v1/chat/completions',
      model: 'meta-llama/llama-4-scout',
      status: 200,
      inputTokens: 20,
      outputTokens: 4,
    });
  });

  it('lists the models of the pass’s keys, named <key>/<model>', async () => {
    const { anthropic, gemini } = await threeKeys();
    const { pass } = await addMachine([anthropic.id, gemini.id]);
    const res = await api({ method: 'GET', url: '/v1/models', pass });
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().data as { id: string }[]).map((m) => m.id).sort();
    expect(ids).toEqual(['anthropic/model-1', 'gemini/gemini-2.5-flash', 'gemini/model-1']);
    expect(res.json().object).toBe('list');
    // Anthropic lists models on its own API, with its own headers.
    const asked = provider.seen.find((r) => r.headers['x-api-key'] === ANTHROPIC_KEY);
    expect(asked?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('asks for token counts on a stream, and drops that for a provider that refuses it', async () => {
    const { openrouter } = await threeKeys();
    const { pass, machine } = await addMachine([openrouter.id]);
    let res = await api({
      url: '/v1/chat/completions',
      pass,
      payload: chat('openrouter/x-model', { stream: true }),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('[DONE]');
    expect(JSON.parse(provider.last().body).stream_options).toEqual({ include_usage: true });
    expect(h.services.gateway.recentUsage(1, machine.id)[0]).toMatchObject({
      inputTokens: 11,
      outputTokens: 3,
    });

    provider.rejectStreamOptions = true;
    res = await api({
      url: '/v1/chat/completions',
      pass,
      payload: chat('openrouter/x-model', { stream: true }),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('[DONE]');
    expect(JSON.parse(provider.last().body).stream_options).toBeUndefined();
  });

  it('never offers a subscription login as an API, and says why', async () => {
    const token = await addKey({
      preset: 'anthropic-subscription',
      name: 'Claude Max',
      slug: 'claude',
      secret: 'sk-ant-oat01-SUBSCRIPTION-TOKEN-0000',
    });
    const { pass } = await addMachine([token.id]);
    const before = provider.seen.length;
    const res = await api({
      url: '/v1/chat/completions',
      pass,
      payload: chat('claude/claude-sonnet-4-5'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Claude Pro\/Max subscription token/);
    const models = await api({ method: 'GET', url: '/v1/models', pass });
    expect(models.json().data).toEqual([]);
    expect(provider.seen.length).toBe(before);
  });

  it('needs a valid pass, and only uses the keys given to it', async () => {
    const { anthropic, gemini } = await threeKeys();
    const { pass, machine } = await addMachine([anthropic.id]);

    let res = await api({ url: '/v1/chat/completions', payload: chat('anthropic/x') });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/agentbox/);

    res = await api({ url: '/v1/chat/completions', pass, payload: chat('gemini') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/may not use the “gemini” key/);
    expect(gemini.id).toBeTruthy();

    res = await api({ url: '/v1/files', pass, payload: {} });
    expect(res.statusCode).toBe(404);

    // Stop cuts it off like any machine.
    await laptop.post(`/api/gateway/machines/${machine.id}/revoke`, {});
    res = await api({ url: '/v1/chat/completions', pass, payload: chat('anthropic/x') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/stopped/);
  });

  it('takes a model without a key name when the pass has only one key that fits', async () => {
    const { anthropic } = await threeKeys();
    const { pass } = await addMachine([anthropic.id]);
    const res = await api({ url: '/v1/chat/completions', pass, payload: chat('claude-haiku-4-5') });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(provider.last().body).model).toBe('claude-haiku-4-5');
  });
});

describe('OpenAI-compatible routing', () => {
  const row = (r: Partial<AiKeyRow>) =>
    ({ slug: 'k', model: null, upstream: 'https://api.example.com', ...r }) as AiKeyRow;

  it('finds each provider’s OpenAI-compatible base URL', () => {
    expect(
      openaiRoute(row({ auth: 'bearer', preset: 'openai', upstream: 'https://api.openai.com' })),
    ).toEqual({ base: 'https://api.openai.com/v1' });
    expect(
      openaiRoute(
        row({ auth: 'bearer', preset: 'kimi-code', upstream: 'https://api.kimi.com/coding' }),
      ),
    ).toEqual({ base: 'https://api.kimi.com/coding/v1' });
    expect(
      openaiRoute(
        row({
          auth: 'bearer',
          preset: 'moonshot-anthropic',
          upstream: 'https://api.moonshot.ai/anthropic',
        }),
      ),
    ).toEqual({ base: 'https://api.moonshot.ai/v1' });
    expect(
      openaiRoute(
        row({ auth: 'bearer', preset: 'openai-compatible', upstream: 'https://x.example/api/v1' }),
      ),
    ).toEqual({ base: 'https://x.example/api/v1' });
    expect(
      openaiRoute(
        row({
          auth: 'x-goog-api-key',
          preset: 'gemini',
          upstream: 'https://generativelanguage.googleapis.com',
        }),
      ),
    ).toEqual({ base: 'https://generativelanguage.googleapis.com/v1beta/openai' });
    for (const auth of [
      'anthropic-oauth',
      'codex-login',
      'grok-login',
      'opencode-login',
    ] as const) {
      expect(openaiRoute(row({ auth, preset: 'x' }))).toHaveProperty('refused');
    }
  });

  it('reads the key from the model name', () => {
    const keys = [
      row({ slug: 'a', auth: 'bearer', preset: 'openai' }),
      row({ slug: 'b', auth: 'bearer', preset: 'openai', model: 'saved' }),
    ];
    expect(chooseKey('a/gpt-5', keys)).toMatchObject({ model: 'gpt-5' });
    expect(chooseKey('b', keys)).toMatchObject({ model: 'saved' });
    expect(chooseKey('a', keys)).toMatchObject({ status: 400 });
    expect(chooseKey('gpt-5', keys)).toMatchObject({ status: 404 });
    // A key that exists but isn't on this pass is never guessed around.
    expect(chooseKey('c/x', keys.slice(0, 1), new Set(['c']))).toMatchObject({ status: 403 });
    expect(chooseKey('gpt-5', keys.slice(0, 1))).toMatchObject({ model: 'gpt-5' });
    expect(chooseKey(undefined, keys)).toMatchObject({ status: 400 });
  });

  it('keeps the program’s own stream_options', () => {
    const { body, plain } = providerBody(
      { model: 'x', stream: true, stream_options: { include_usage: true } },
      'y',
      '/chat/completions',
    );
    expect(plain).toBeNull();
    expect(JSON.parse(body.toString())).toEqual({
      model: 'y',
      stream: true,
      stream_options: { include_usage: true },
    });
  });
});
