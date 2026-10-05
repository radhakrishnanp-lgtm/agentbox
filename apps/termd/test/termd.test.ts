import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FrameDecoder, TERMD_FRAME, encodeFrame } from '@agentbox/shared/termd';
import { loadTermdConfig, terminalEnv, type TermdConfig } from '../src/config.ts';
import { Termd } from '../src/server.ts';
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL, CodexLogin, readCodexLogin } from '../src/codex.ts';
import { GrokLogin, XAI_ISSUER, jwtExpiry, readGrokLogin } from '../src/grok.ts';
import { explainMountFailure, mountPoints } from '../src/vault.ts';

const here = new URL('.', import.meta.url).pathname;
const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

function request(socket: string, req: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let buf = '';
    s.on('data', (d) => (buf += d.toString()));
    s.on('end', () => {
      resolve(JSON.parse(buf) as Record<string, unknown>);
    });
    s.on('error', reject);
    s.write(`${JSON.stringify(req)}\n`);
  });
}

/** Attaches, types `input`, and collects output until `until` shows up. */
function attachAndType(
  socket: string,
  name: string,
  input: string,
  until: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(socket);
    let head = Buffer.alloc(0);
    let ready = false;
    let out = '';
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`timed out; output so far: ${out}`));
    }, 10_000);
    s.on('data', (chunk: Buffer) => {
      let rest = chunk;
      if (!ready) {
        head = Buffer.concat([head, chunk]);
        const nl = head.indexOf(0x0a);
        if (nl === -1) return;
        const res = JSON.parse(head.subarray(0, nl).toString()) as { ok: boolean };
        if (!res.ok) {
          clearTimeout(timer);
          reject(new Error(head.subarray(0, nl).toString()));
          return;
        }
        ready = true;
        rest = head.subarray(nl + 1);
        s.write(encodeFrame(TERMD_FRAME.resize, JSON.stringify({ cols: 100, rows: 30 })));
        setTimeout(() => s.write(encodeFrame(TERMD_FRAME.data, input)), 700);
      }
      for (const f of decoder.push(rest)) {
        if (f.type === TERMD_FRAME.data) out += f.payload.toString();
      }
      if (out.includes(until)) {
        clearTimeout(timer);
        s.end();
        resolve(out);
      }
    });
    s.on('error', reject);
    s.write(`${JSON.stringify({ op: 'attach', name, cols: 80, rows: 24 })}\n`);
  });
}

describe.skipIf(!hasTmux)('agentbox-termd', () => {
  let dir: string;
  let config: TermdConfig;
  let termd: Termd;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'termd-'));
    config = loadTermdConfig({
      AGENTBOX_TERMD_SOCKET: join(dir, 'termd.sock'),
      AGENTBOX_TERMD_HOME: join(dir, 'home'),
      AGENTBOX_TERMD_VAULT: 'none',
      AGENTBOX_TERMD_TMUX: `agentbox-test-${process.pid}`,
      AGENTBOX_TERMD_TMUX_CONF: join(here, '../src/tmux.conf'),
      AGENTBOX_TERMD_PATH_EXTRA: join(dir, 'bin'),
      USER: 'dev',
    });
    execFileSync('mkdir', ['-p', config.home, join(dir, 'bin')]);
    // A fake "claude" on PATH, so the installed-CLI check has something to find.
    writeFileSync(join(dir, 'bin', 'claude'), '#!/bin/sh\necho fake-claude\n', { mode: 0o755 });
    termd = new Termd(config, terminalEnv(config, { USER: 'dev', SECRET_TOKEN: 'x' }), () => {});
    await termd.listen();
  });

  afterAll(async () => {
    await termd.tmux.killServer();
    await termd.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes the socket group-only', () => {
    expect(statSync(config.socket).mode & 0o777).toBe(0o660);
  });

  it('starts with no sessions and finds installed CLIs', async () => {
    const res = await request(config.socket, { op: 'overview' });
    expect(res).toMatchObject({ ok: true, vault: 'disabled', terminals: [] });
    expect(res['installed']).toEqual(['claude']);
  });

  it('creates, lists, renames and kills sessions', async () => {
    expect(
      await request(config.socket, {
        op: 'create',
        name: 'one',
        preset: 'shell',
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ ok: true });
    expect(
      await request(config.socket, {
        op: 'create',
        name: 'one',
        preset: 'shell',
        cols: 80,
        rows: 24,
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const list = await request(config.socket, { op: 'overview' });
    expect(list['terminals']).toMatchObject([{ name: 'one', preset: 'shell' }]);

    expect(await request(config.socket, { op: 'rename', name: 'one', to: 'two' })).toEqual({
      ok: true,
    });
    expect(await request(config.socket, { op: 'kill', name: 'one' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await request(config.socket, { op: 'kill', name: 'two' })).toEqual({ ok: true });
  });

  it('rejects unsafe names and unknown presets', async () => {
    for (const name of ['a b', '../x', '-t', 'x'.repeat(33), '', 'a;rm']) {
      if (name === '-t') continue; // "-t" is a valid name; tmux gets it as =-t.
      const res = await request(config.socket, {
        op: 'create',
        name,
        preset: 'shell',
        cols: 80,
        rows: 24,
      });
      expect(res).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    }
    const res = await request(config.socket, {
      op: 'create',
      name: 'p',
      preset: 'rm -rf /',
      cols: 80,
      rows: 24,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await request(config.socket, { op: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('streams a live shell with a clean environment, and the session survives detach', async () => {
    await request(config.socket, {
      op: 'create',
      name: 'live',
      preset: 'shell',
      cols: 80,
      rows: 24,
    });
    const out = await attachAndType(
      config.socket,
      'live',
      'echo "home=$HOME tok=${SECRET_TOKEN:-none} size=$(tput cols)"; echo DONE-$((40+2))\r',
      'DONE-42',
    );
    expect(out).toContain(`home=${config.home}`);
    expect(out).toContain('tok=none');
    expect(out).toContain('size=100');
    // Detached, not ended: the session is still there, and so is its output.
    const again = await attachAndType(config.socket, 'live', 'echo AGAIN-$((1+1))\r', 'AGAIN-2');
    expect(again).toContain('DONE-42');
    await request(config.socket, { op: 'kill', name: 'live' });
  });

  it('runs a preset CLI and leaves a shell behind when it exits', async () => {
    await request(config.socket, {
      op: 'create',
      name: 'cl',
      preset: 'claude',
      cols: 80,
      rows: 24,
    });
    const res = await request(config.socket, { op: 'overview' });
    expect(res['terminals']).toMatchObject([{ name: 'cl', preset: 'claude' }]);
    const out = await attachAndType(config.socket, 'cl', 'echo STILL-$((2+3))\r', 'STILL-5');
    expect(out).toContain('fake-claude');
    await request(config.socket, { op: 'kill', name: 'cl' });
  });

  it('refuses to attach to a missing session', async () => {
    await expect(attachAndType(config.socket, 'ghost', '', 'x')).rejects.toThrow('not_found');
  });
});

describe('mountPoints', () => {
  it('reads mount points and decodes escapes', () => {
    const info =
      '36 35 98:0 / /home/dev rw,nosuid - fuse.gocryptfs /var/lib/x rw\n' +
      '37 35 98:0 / /mnt/with\\040space rw - ext4 /dev/sda1 rw\n';
    expect(mountPoints(info)).toEqual([
      { point: '/home/dev', fstype: 'fuse.gocryptfs' },
      { point: '/mnt/with space', fstype: 'ext4' },
    ]);
  });
});

const canFuse = (() => {
  try {
    execFileSync('gocryptfs', ['-version']);
    return existsSync('/dev/fuse') && process.getuid?.() === 0 && hasTmux;
  } catch {
    return false;
  }
})();

describe.skipIf(!canFuse)('the vault (gocryptfs)', () => {
  let dir: string;
  let config: TermdConfig;
  let termd: Termd;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vault-'));
    config = loadTermdConfig({
      AGENTBOX_TERMD_SOCKET: join(dir, 'termd.sock'),
      AGENTBOX_TERMD_HOME: join(dir, 'home'),
      AGENTBOX_TERMD_VAULT: join(dir, 'vault', 'cipher'),
      AGENTBOX_TERMD_TMUX: `agentbox-vault-${process.pid}`,
      AGENTBOX_TERMD_TMUX_CONF: join(here, '../src/tmux.conf'),
    });
    termd = new Termd(config, terminalEnv(config, { USER: 'dev' }), () => {});
    await termd.listen();
  });

  afterAll(async () => {
    await termd.lock().catch(() => {});
    await termd.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps terminals off until the vault exists and is unlocked', async () => {
    expect(await request(config.socket, { op: 'overview' })).toMatchObject({
      vault: 'uninitialized',
    });
    expect(
      await request(config.socket, {
        op: 'create',
        name: 'a',
        preset: 'shell',
        cols: 80,
        rows: 24,
      }),
    ).toMatchObject({ ok: false, error: { code: 'vault_locked' } });
  });

  it('creates the vault, and files written in a terminal are stored encrypted', async () => {
    const password = 'correct horse battery staple';
    expect(await request(config.socket, { op: 'vault.init', password })).toEqual({ ok: true });
    expect(await request(config.socket, { op: 'overview' })).toMatchObject({ vault: 'unlocked' });
    expect(existsSync(join(config.home, '.npmrc'))).toBe(true);

    await request(config.socket, { op: 'create', name: 'a', preset: 'shell', cols: 80, rows: 24 });
    await attachAndType(
      config.socket,
      'a',
      'echo sk-secret-login-token > ~/login.json; echo OK-$((3*3))\r',
      'OK-9',
    );
    expect(readFileSync(join(config.home, 'login.json'), 'utf8')).toContain(
      'sk-secret-login-token',
    );

    // Locking stops the terminals and leaves only ciphertext on disk.
    expect(await request(config.socket, { op: 'vault.lock' })).toEqual({ ok: true });
    expect(await request(config.socket, { op: 'overview' })).toMatchObject({
      vault: 'locked',
      terminals: [],
    });
    expect(existsSync(join(config.home, 'login.json'))).toBe(false);
    // grep exits 1 when nothing on disk contains the token.
    const grep = spawnSync('grep', ['-rl', 'sk-secret-login-token', config.vaultCipher ?? '']);
    expect(grep.status).toBe(1);
  });

  it('rejects a wrong password and unlocks with the right one', async () => {
    expect(
      await request(config.socket, { op: 'vault.unlock', password: 'not the password!!' }),
    ).toMatchObject({ ok: false, error: { code: 'wrong_password' } });
    expect(
      await request(config.socket, {
        op: 'vault.unlock',
        password: 'correct horse battery staple',
      }),
    ).toEqual({ ok: true });
    expect(readFileSync(join(config.home, 'login.json'), 'utf8')).toContain(
      'sk-secret-login-token',
    );
  });

  it('resets only while locked', async () => {
    expect(await request(config.socket, { op: 'vault.reset' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    await request(config.socket, { op: 'vault.lock' });
    expect(await request(config.socket, { op: 'vault.reset' })).toEqual({ ok: true });
    expect(await request(config.socket, { op: 'overview' })).toMatchObject({
      vault: 'uninitialized',
    });
  });
});

describe('vault mount errors', () => {
  it('names an AppArmor-style mount denial and what fixes it', () => {
    const msg = explainMountFailure(
      'gocryptfs exit 19',
      'fusermount3: mount failed: Permission denied\nfuse: mount failed',
    );
    expect(msg).toContain('fusermount3: mount failed: Permission denied');
    expect(msg).toContain('AppArmor');
    expect(msg).toContain('Re-run the agentbox installer');
  });

  it('keeps the last line of any other failure', () => {
    expect(explainMountFailure('gocryptfs exit 6', 'something odd\nCipherdir is not empty\n')).toBe(
      'Could not unlock the vault (gocryptfs exit 6: Cipherdir is not empty).',
    );
    expect(explainMountFailure('gocryptfs exit timeout', '')).toBe(
      'Could not unlock the vault (gocryptfs exit timeout).',
    );
  });
});

describe('Grok login tokens for machines', () => {
  const jwt = (expMs: number) =>
    `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.signature-part`;
  const record = (key: string, expMs: number) => ({
    [`${XAI_ISSUER}::b1a00492-073a-47ea-816f-4c329264a828`]: {
      key,
      auth_mode: 'oidc',
      create_time: new Date(0).toISOString(),
      user_id: 'u1',
      refresh_token: 'the-refresh-token-stays-here',
      expires_at: new Date(expMs).toISOString(),
      oidc_issuer: XAI_ISSUER,
    },
  });

  it('reads the xAI login and ignores other issuers', () => {
    const exp = Date.now() + 3_600_000;
    const text = JSON.stringify({
      ...record(jwt(exp), exp),
      'https://acme.okta.com::x': {
        key: jwt(exp + 1e7),
        auth_mode: 'oidc',
        oidc_issuer: 'https://acme.okta.com',
      },
    });
    const got = readGrokLogin(text);
    expect(got?.token).toBe(jwt(exp));
    expect(Math.abs((got?.expiresAt ?? 0) - exp)).toBeLessThan(1000);
    expect(readGrokLogin('not json')).toBeNull();
    expect(readGrokLogin('{}')).toBeNull();
    expect(jwtExpiry('not-a-jwt')).toBeNull();
  });

  it('refreshes through grok itself when the token is about to expire', async () => {
    const home = mkdtempSync(join(tmpdir(), 'termd-grok-'));
    const bin = join(home, 'bin');
    execFileSync('mkdir', ['-p', join(home, '.grok'), bin]);
    const soon = Date.now() + 60_000;
    writeFileSync(join(home, '.grok/auth.json'), JSON.stringify(record(jwt(soon), soon)));
    const later = Date.now() + 3_600_000;
    // A stand-in for `grok models`: it rewrites the login like the real CLI would.
    writeFileSync(
      join(bin, 'grok'),
      `#!/bin/sh\n[ "$1" = models ] || exit 2\nprintf '%s' '${JSON.stringify(record(jwt(later), later))}' > "$HOME/.grok/auth.json"\n`,
    );
    execFileSync('chmod', ['755', join(bin, 'grok')]);
    const login = new GrokLogin(home, { HOME: home, PATH: `${bin}:/usr/bin:/bin` });
    const t = await login.token();
    expect(t.token).toBe(jwt(later));
    rmSync(home, { recursive: true, force: true });
  });

  it('says what to do when Grok is not signed in, or the login is dead', async () => {
    const home = mkdtempSync(join(tmpdir(), 'termd-grok-'));
    const login = new GrokLogin(home, { HOME: home, PATH: '/usr/bin:/bin' });
    await expect(login.token()).rejects.toThrow(/not signed in/);
    execFileSync('mkdir', ['-p', join(home, '.grok')]);
    const past = Date.now() - 1000;
    writeFileSync(join(home, '.grok/auth.json'), JSON.stringify(record(jwt(past), past)));
    await expect(login.token()).rejects.toThrow(/run grok login/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('Codex (ChatGPT) login for machines', () => {
  const jwt = (claims: object) =>
    `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature-part`;
  const access = (expMs: number) => jwt({ exp: Math.floor(expMs / 1000) });
  const idToken = jwt({
    email: 'krish@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-from-id-token',
      chatgpt_plan_type: 'plus',
    },
  });
  const authJson = (accessToken: string, extra: object = {}) =>
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'rt-1', ...extra },
      last_refresh: '2026-10-01T00:00:00Z',
    });
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), 'termd-codex-'));
    execFileSync('mkdir', ['-p', join(dir, '.codex')]);
    return dir;
  };

  it('reads the ChatGPT login, with the account from the file or the id token', () => {
    const exp = Date.now() + 3_600_000;
    const got = readCodexLogin(authJson(access(exp), { account_id: 'acct-1' }));
    expect(got?.token).toBe(access(exp));
    expect(got?.accountId).toBe('acct-1');
    expect(readCodexLogin(authJson(access(exp)))?.accountId).toBe('acct-from-id-token');
    // An API-key login, or anything else, is not a ChatGPT login.
    expect(readCodexLogin(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toBeNull();
    expect(readCodexLogin('not json')).toBeNull();
  });

  it('hands out the token while it has time left, without refreshing', async () => {
    const dir = home();
    const exp = Date.now() + 3_600_000;
    writeFileSync(join(dir, '.codex/auth.json'), authJson(access(exp)));
    let calls = 0;
    const fetchStub: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    };
    const login = new CodexLogin(dir, Date.now, fetchStub);
    const t = await login.token();
    expect(t).toEqual({
      token: access(exp),
      accountId: 'acct-from-id-token',
      expiresAt: Math.floor(exp / 1000) * 1000,
    });
    expect(calls).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refreshes like Codex does and writes the new tokens back, keeping the rest', async () => {
    const dir = home();
    const soon = Date.now() + 60_000;
    const later = Date.now() + 10 * 86_400_000;
    const path = join(dir, '.codex/auth.json');
    writeFileSync(path, authJson(access(soon), { account_id: 'acct-1' }));
    const sent: { url: string; body: unknown }[] = [];
    const login = new CodexLogin(dir, Date.now, (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ access_token: access(later), refresh_token: 'rt-2' }));
    }) as unknown as typeof fetch);
    // Two machines asking at once cause one refresh.
    const [a, b] = await Promise.all([login.token(), login.token()]);
    expect(a.token).toBe(access(later));
    expect(b.token).toBe(access(later));
    expect(sent).toEqual([
      {
        url: CODEX_TOKEN_URL,
        body: { client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt-1' },
      },
    ]);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      tokens: unknown;
      last_refresh: unknown;
      OPENAI_API_KEY: unknown;
    };
    expect(saved.tokens).toEqual({
      id_token: idToken,
      access_token: access(later),
      refresh_token: 'rt-2',
      account_id: 'acct-1',
    });
    expect(saved.OPENAI_API_KEY).toBeNull();
    expect(saved.last_refresh).not.toBe('2026-10-01T00:00:00Z');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says what to do when Codex is not signed in, or the login is dead', async () => {
    const dir = home();
    const refused = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch;
    const login = new CodexLogin(dir, Date.now, refused);
    await expect(login.token()).rejects.toThrow(/codex login --device-auth/);
    writeFileSync(join(dir, '.codex/auth.json'), authJson(access(Date.now() - 1000)));
    await expect(login.token()).rejects.toThrow(/has expired/);
    rmSync(dir, { recursive: true, force: true });
  });
});
