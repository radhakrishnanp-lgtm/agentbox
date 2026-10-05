/**
 * Runs the real Windows setup script (machine.ps1) with PowerShell against a
 * listening agentbox, then runs the .cmd wrappers it writes with the Windows
 * command shell (wine's cmd) and checks what each hands to the real CLI. The
 * "real" CLIs here are small .cmd files that record their environment and
 * arguments; curl.exe is a small stand-in built from fixtures/fake-curl.c.
 *
 * Needs pwsh, and for the wrapper part wine and the mingw compiler. Tests
 * that can't run here are skipped. Point AGENTBOX_TEST_PWSH or
 * AGENTBOX_TEST_WINE at the programs if they aren't on PATH.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiKeySummary, MachineCreated } from '@agentbox/shared';
import { renderMachineScript } from '../src/gateway/script.ts';
import { Harness, type Browser } from './helpers/harness.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function program(envName: string, names: string[]): string | null {
  const given = process.env[envName];
  if (given) return given;
  for (const name of names) {
    if (name.startsWith('/')) {
      if (existsSync(name)) return name;
      continue;
    }
    try {
      return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || null;
    } catch {
      // not installed
    }
  }
  return null;
}

const PWSH = program('AGENTBOX_TEST_PWSH', ['pwsh']);
const WINE = program('AGENTBOX_TEST_WINE', ['wine64', 'wine', '/usr/lib/wine/wine64']);
const MINGW = program('AGENTBOX_TEST_MINGW', ['x86_64-w64-mingw32-gcc']);
const WINEPREFIX = join(tmpdir(), 'agentbox-test-wine');

let h: Harness;
let laptop: Browser;
let dir: string;

beforeEach(async () => {
  h = await Harness.create();
  laptop = h.browser();
  await h.completeSetup(laptop);
  dir = mkdtempSync(join(tmpdir(), 'agentbox-windows-'));
});
afterEach(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addKey(body: Record<string, unknown>): Promise<AiKeySummary> {
  await h.reauth(laptop);
  const res = await laptop.post('/api/gateway/keys', {
    secret: `real-secret-${String(body.slug)}-0000`,
    upstream: 'https://provider.example',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AiKeySummary>();
}

async function listen(): Promise<string> {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

async function addMachine(keyIds: string[]): Promise<MachineCreated> {
  await h.reauth(laptop);
  const res = await laptop.post('/api/gateway/machines', {
    name: 'windows-pc',
    keyIds,
    dailyTokenLimit: null,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<MachineCreated>();
}

const winPath = (p: string) => `Z:${p.replaceAll('/', '\\')}`;

/** A Windows computer: its AppData\Local folder, fake CLIs, and ways to run things. */
function computer(base: string) {
  const local = join(dir, 'Local');
  const fakebin = join(dir, 'fakebin');
  const out = join(dir, 'out');
  for (const d of [local, fakebin, out]) mkdirSync(d, { recursive: true });
  const data = join(local, 'agentbox');
  const bin = join(data, 'bin');
  const script = join(dir, 'machine.ps1');
  writeFileSync(script, renderMachineScript(base, 'machine.ps1'));

  /** Runs PowerShell the way "irm | iex" or agentbox-machine.cmd would. */
  const pwsh = async (file: string, args: string[] = [], extra: Record<string, string> = {}) => {
    if (!PWSH) throw new Error('no pwsh');
    try {
      const r = await run(PWSH, ['-NoProfile', '-NonInteractive', '-File', file, ...args], {
        env: { PATH: process.env.PATH, HOME: dir, LOCALAPPDATA: local, ...extra },
        timeout: 60_000,
      });
      return r.stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`pwsh failed:\n${err.stdout ?? ''}\n${err.stderr ?? ''}`, { cause: e });
    }
  };

  // The real CLIs: they write down their environment and arguments.
  const fakes = () => {
    for (const cli of ['claude', 'codex', 'grok', 'kimi', 'gemini']) {
      writeFileSync(
        join(fakebin, `${cli}.cmd`),
        [
          '@echo off',
          `set > "${winPath(join(out, `${cli}.env`))}"`,
          `echo ARGS=%*> "${winPath(join(out, `${cli}.args`))}"`,
          `if "%1"=="login" echo {"signed":"in"}> "%GROK_HOME%\\auth.json"`,
          'exit /b 0',
          '',
        ].join('\r\n'),
      );
    }
    if (!MINGW) throw new Error('no mingw');
    execFileSync(MINGW, [
      '-O2',
      '-o',
      join(fakebin, 'curl.exe'),
      join(here, 'fixtures/fake-curl.c'),
    ]);
  };

  /** Runs a command in the Windows command shell, with this computer's PATH. */
  const cmd = async (line: string, extra: Record<string, string> = {}) => {
    if (!WINE) throw new Error('no wine');
    const driver = join(dir, 'run.cmd');
    writeFileSync(
      driver,
      [
        '@echo off',
        `set "LOCALAPPDATA=${winPath(local)}"`,
        `set "PATH=${winPath(bin)};${winPath(fakebin)};%PATH%"`,
        line,
        '',
      ].join('\r\n'),
    );
    try {
      const r = await run(WINE, ['cmd', '/c', winPath(driver)], {
        env: { ...process.env, WINEPREFIX, WINEDEBUG: '-all', ...extra },
        timeout: 120_000,
      });
      return {
        code: 0,
        stdout: r.stdout.replaceAll('\r', ''),
        stderr: r.stderr.replaceAll('\r', ''),
      };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return {
        code: err.code ?? -1,
        stdout: (err.stdout ?? '').replaceAll('\r', ''),
        stderr: (err.stderr ?? '').replaceAll('\r', ''),
      };
    }
  };

  /** How the fake CLI was started: its environment (names upper-cased) and arguments. */
  const seen = (cli: string) => {
    const vars = new Map<string, string>();
    for (const line of readFileSync(join(out, `${cli}.env`), 'latin1').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) vars.set(line.slice(0, eq).toUpperCase(), line.slice(eq + 1));
    }
    const args = readFileSync(join(out, `${cli}.args`), 'latin1')
      .replace(/^ARGS=/, '')
      .replace(/\r?\n$/, '');
    return { vars, args };
  };

  return { local, data, bin, script, pwsh, fakes, cmd, seen, wLocal: winPath(local) };
}

describe.skipIf(!PWSH)('Windows machine setup script', () => {
  it('sets up, reports, refreshes and uninstalls with PowerShell', async () => {
    const base = await listen();
    const keys = [
      await addKey({ preset: 'anthropic', name: 'Claude', slug: 'anthropic' }),
      await addKey({ preset: 'openai', name: 'OpenAI', slug: 'openai', model: 'gpt-5.1-codex' }),
    ];
    const { pass } = await addMachine(keys.map((k) => k.id));
    const pc = computer(base);

    const report = await pc.pwsh(pc.script, [], { AGENTBOX_PASS: pass });
    expect(report).toContain('This computer is set up as "windows-pc"');
    expect(report).toContain('These commands now use your agentbox keys: claude codex');
    expect(report).toContain('claude: install the claude CLI as usual');
    expect(readFileSync(join(pc.data, 'pass'), 'utf8')).toBe(`${pass}\r\n`);
    expect(existsSync(join(pc.bin, 'claude.cmd'))).toBe(true);
    expect(existsSync(join(pc.bin, 'codex.cmd'))).toBe(true);
    expect(existsSync(join(pc.bin, 'grok.cmd'))).toBe(false);
    // The pass is read at run time, never written into a wrapper.
    expect(readFileSync(join(pc.bin, 'claude.cmd'), 'utf8')).not.toContain(pass);

    // The saved copy came from agentbox's public address; this one talks to the test server.
    const tool = join(pc.bin, 'agentbox-machine.ps1');
    expect(readFileSync(tool, 'utf8')).toBe(renderMachineScript(h.config.origin, 'machine.ps1'));
    writeFileSync(tool, readFileSync(pc.script));
    const status = await pc.pwsh(tool, ['status'], { AGENTBOX_CLI: '1' });
    expect(status).toContain('Machine: windows-pc');
    expect(status).toContain(`codex -> ${base}/gw/openai (OpenAI, model gpt-5.1-codex)`);

    // Refresh picks up a new key. (AGENTBOX_FRESH skips fetching the newest script,
    // which would come from agentbox's public address.)
    const more = await addKey({ preset: 'xai', name: 'xAI', slug: 'xai' });
    await h.reauth(laptop);
    const machineId = h.services.gateway.listMachines()[0]?.id ?? '';
    const edit = await laptop.request({
      method: 'PATCH',
      url: `/api/gateway/machines/${machineId}`,
      payload: { keyIds: [...keys.map((k) => k.id), more.id] },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const refreshed = await pc.pwsh(tool, ['refresh'], { AGENTBOX_CLI: '1', AGENTBOX_FRESH: '1' });
    expect(refreshed).toContain('These commands now use your agentbox keys: claude codex grok');
    expect(existsSync(join(pc.bin, 'grok.cmd'))).toBe(true);

    // Without AGENTBOX_FRESH it fetches the newest script and runs that, which here
    // tries agentbox's public address.
    await expect(pc.pwsh(tool, ['refresh'], { AGENTBOX_CLI: '1' })).rejects.toThrow(
      `could not reach ${h.config.origin}`,
    );

    await pc.pwsh(tool, ['uninstall'], { AGENTBOX_CLI: '1' });
    expect(existsSync(pc.data)).toBe(false);
  });

  it('moves a CLI installed just for you out of the system PATH, with your permission', async () => {
    const base = await listen();
    const keys = [
      await addKey({ preset: 'anthropic', name: 'Claude', slug: 'anthropic' }),
      await addKey({ preset: 'openai', name: 'OpenAI', slug: 'openai' }),
    ];
    const { pass } = await addMachine(keys.map((k) => k.id));
    const pc = computer(base);
    // Claude Code's own installer: just for you, but in the system PATH.
    const profile = join(dir, 'Users', 'radhakp');
    mkdirSync(join(profile, '.local', 'bin'), { recursive: true });
    writeFileSync(join(profile, '.local', 'bin', 'claude.exe'), '');
    // A codex installed for every user stays where it is.
    const shared = join(dir, 'Program Files', 'codex');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'codex.cmd'), '');
    const env = {
      AGENTBOX_PASS: pass,
      USERPROFILE: profile,
      AGENTBOX_TEST_SYSTEM_PATH: `C:\\Windows;%USERPROFILE%\\.local\\bin;${shared}`,
    };

    const denied = await pc.pwsh(pc.script, [], { ...env, AGENTBOX_TEST_ELEVATE: 'deny' });
    expect(denied).toContain('Windows finds your own claude in');
    expect(denied).toContain('Not changed, because Windows permission was not given');
    expect(denied).toMatch(/claude: Windows finds the claude in .*\(system PATH\) before agentbox/);

    const fixed = await pc.pwsh(pc.script, [], env);
    expect(fixed).toContain('Moving it to your own PATH, after agentbox.');
    expect(fixed).toContain('  Done.');
    expect(fixed).toContain('  claude: ready');
    // Not just for you: left alone, with a hint.
    expect(fixed).toMatch(/codex: Windows finds the codex in .*Program Files.*\(system PATH\)/);
    expect(fixed).toContain('Type codex.cmd instead of codex');
  });

  it('refuses a wrong pass and a stopped machine, with the reason', async () => {
    const base = await listen();
    const key = await addKey({ preset: 'anthropic', name: 'Claude', slug: 'anthropic' });
    const { pass, machine } = await addMachine([key.id]);
    const pc = computer(base);

    const bad = run(PWSH ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File', pc.script], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        LOCALAPPDATA: pc.local,
        AGENTBOX_PASS: 'nope',
        AGENTBOX_CLI: '1',
      },
    });
    await expect(bad).rejects.toMatchObject({ code: 1 });

    await laptop.post(`/api/gateway/machines/${machine.id}/revoke`);
    const stopped = run(PWSH ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File', pc.script], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        LOCALAPPDATA: pc.local,
        AGENTBOX_PASS: pass,
        AGENTBOX_CLI: '1',
      },
    });
    await expect(stopped).rejects.toMatchObject({
      stdout: expect.stringMatching(
        /agentbox said no \(HTTP 403\): this machine was stopped in agentbox/,
      ),
    });
    expect(existsSync(join(pc.data, 'pass'))).toBe(false);
  });

  it.skipIf(!WINE || !MINGW)(
    'writes wrappers that hand every CLI only agentbox and the pass',
    { timeout: 240_000 },
    async () => {
      const base = await listen();
      const keys = [
        await addKey({ preset: 'anthropic', name: 'Claude', slug: 'anthropic' }),
        await addKey({ preset: 'openai', name: 'OpenAI', slug: 'openai', model: 'gpt-5.1-codex' }),
        await addKey({ preset: 'xai', name: 'xAI', slug: 'xai' }),
        await addKey({ preset: 'moonshot', name: 'Kimi', slug: 'kimi', model: 'kimi-k2' }),
        await addKey({ preset: 'gemini', name: 'Gemini', slug: 'gemini' }),
      ];
      const { pass } = await addMachine(keys.map((k) => k.id));
      const pc = computer(base);
      pc.fakes();
      await pc.pwsh(pc.script, [], { AGENTBOX_PASS: pass });
      const url = (slug: string) => `${base}/gw/${slug}`;
      const stale = {
        ANTHROPIC_API_KEY: 'sk-ant-stale',
        OPENAI_API_KEY: 'sk-stale',
        GOOGLE_API_KEY: 'stale',
      };

      for (const cli of ['claude', 'codex', 'grok', 'kimi', 'gemini']) {
        const r = await pc.cmd(`${cli} --flag "two words"`, stale);
        expect(r.code, r.stderr).toBe(0);
      }

      const claude = pc.seen('claude');
      expect(claude.vars.get('ANTHROPIC_BASE_URL')).toBe(url('anthropic'));
      expect(claude.vars.get('ANTHROPIC_AUTH_TOKEN')).toBe(pass);
      expect(claude.vars.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe('1');
      expect(claude.vars.has('ANTHROPIC_API_KEY')).toBe(false);
      expect(claude.vars.has('ANTHROPIC_MODEL')).toBe(false);
      expect(claude.args).toBe('--flag "two words"');

      const codex = pc.seen('codex');
      // The pass comes from the helper, not the environment: codex starts its
      // background server apart from this wrapper, which would not see it.
      expect(codex.vars.has('AGENTBOX_CODEX_KEY')).toBe(false);
      expect(existsSync(join(pc.bin, 'agentbox-codex-token.cmd'))).toBe(true);
      expect(codex.vars.get('CODEX_HOME')).toBe(`${pc.wLocal}\\agentbox\\codex`);
      expect(codex.vars.has('OPENAI_API_KEY')).toBe(false);
      expect(codex.args).toContain('-c model_provider=agentbox');
      expect(codex.args).toContain(`-c model_providers.agentbox.base_url=${url('openai')}/v1`);
      expect(codex.args).toContain(
        // pwsh builds this from its own %LOCALAPPDATA%, which is this folder here.
        `-c model_providers.agentbox.auth.command=${pc.bin}\\agentbox-codex-token.cmd`,
      );
      expect(codex.args).toContain('-c model_providers.agentbox.wire_api=responses');
      expect(codex.args).toContain('-c analytics.enabled=false');
      expect(codex.args).toMatch(/-c model=gpt-5\.1-codex --flag "two words"$/);

      const grok = pc.seen('grok');
      expect(grok.vars.get('XAI_API_KEY')).toBe(pass);
      expect(grok.vars.get('GROK_XAI_API_BASE_URL')).toBe(`${url('xai')}/v1`);
      expect(grok.vars.get('GROK_HOME')).toBe(`${pc.wLocal}\\agentbox\\grok`);
      expect(grok.vars.get('GROK_TELEMETRY_ENABLED')).toBe('false');

      const kimi = pc.seen('kimi');
      expect(kimi.vars.get('KIMI_MODEL_BASE_URL')).toBe(`${url('kimi')}/v1`);
      expect(kimi.vars.get('KIMI_MODEL_API_KEY')).toBe(pass);
      expect(kimi.vars.get('KIMI_MODEL_NAME')).toBe('kimi-k2');

      const gemini = pc.seen('gemini');
      expect(gemini.vars.get('GOOGLE_GEMINI_BASE_URL')).toBe(url('gemini'));
      expect(gemini.vars.get('GEMINI_API_KEY')).toBe(pass);
      expect(gemini.vars.get('GEMINI_CLI_HOME')).toBe(`${pc.wLocal}\\agentbox\\gemini`);
      expect(gemini.vars.has('GOOGLE_API_KEY')).toBe(false);
      expect(
        JSON.parse(readFileSync(join(pc.data, 'gemini/.gemini/settings.json'), 'utf8')),
      ).toEqual({
        security: { auth: { selectedType: 'gemini-api-key' } },
        privacy: { usageStatisticsEnabled: false },
      });

      // A CLI that isn't installed gets a clear message, not the wrapper calling itself.
      rmSync(join(dir, 'fakebin', 'kimi.cmd'));
      const missing = await pc.cmd('kimi');
      expect(missing.code).toBe(127);
      expect(missing.stderr).toContain('kimi is not installed on this computer yet');

      // Without the pass the wrappers stop.
      rmSync(join(pc.data, 'pass'));
      const nopass = await pc.cmd('claude');
      expect(nopass.code).toBe(1);
      expect(nopass.stderr).toContain('no pass on this computer');
    },
  );

  it.skipIf(!WINE || !MINGW)(
    'signs grok in with the pass through agentbox, never an xAI token',
    { timeout: 240_000 },
    async () => {
      const base = await listen();
      const key = await addKey({
        preset: 'grok-login',
        name: 'SuperGrok',
        slug: 'supergrok',
        secret: '',
      });
      const { pass } = await addMachine([key.id]);
      const pc = computer(base);
      pc.fakes();
      // An older setup left a real xAI token here; setting up again removes it.
      mkdirSync(join(pc.data, 'grok-login'), { recursive: true });
      writeFileSync(join(pc.data, 'grok-login/auth.json'), '{"old":"real xAI token"}');
      const report = await pc.pwsh(pc.script, [], { AGENTBOX_PASS: pass });
      expect(report).toContain('These commands now use your agentbox keys: grok');

      const r = await pc.cmd('grok --flag', {
        XAI_API_KEY: 'xai-stale',
        GROK_AUTH_PATH: 'C:\\stolen',
      });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const grok = pc.seen('grok');
      expect(grok.args).toBe('--flag');
      expect(grok.vars.get('GROK_HOME')).toBe(`${pc.wLocal}\\agentbox\\grok-login`);
      expect(grok.vars.has('XAI_API_KEY')).toBe(false);
      expect(grok.vars.has('GROK_AUTH_PATH')).toBe(false);
      expect(grok.vars.get('GROK_CLI_CHAT_PROXY_BASE_URL')).toBe(`${base}/gw/supergrok/v1`);
      // The first run signed grok in through the helper (the fake grok wrote this).
      expect(readFileSync(join(pc.data, 'grok-login/auth.json'), 'utf8')).toContain('signed');
      expect([...grok.vars.values()].some((v) => v.includes(pass))).toBe(false);

      // grok runs its auth_provider_command through cmd /C, found on the wrapper's PATH.
      const command = grok.vars.get('GROK_AUTH_PROVIDER_COMMAND') ?? '';
      expect(command).toBe('agentbox-grok-token');
      const log = join(dir, 'curl.log');
      const session = await h.app.inject({
        method: 'GET',
        url: '/gw/supergrok/_session',
        headers: { authorization: `Bearer ${pass}` },
      });
      expect(session.statusCode).toBe(200);
      const ok = await pc.cmd(command, { FAKE_CURL_LOG: log, FAKE_CURL_BODY: session.body });
      expect(ok.code, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout)).toMatchObject({
        access_token: pass,
        issuer: 'https://auth.x.ai',
      });
      const sent = readFileSync(log, 'latin1');
      // The pass goes on stdin, not the command line.
      expect(sent).toContain(`STDIN=header = "Authorization: Bearer ${pass}"`);
      expect(sent).toContain(`ARG=${base}/gw/supergrok/_session`);
      expect(sent).toContain('ARG=--proto\nARG==http,https\n');
      expect(
        sent
          .split('\n')
          .filter((l) => l.startsWith('ARG='))
          .join('\n'),
      ).not.toContain(pass);

      // A stopped machine can't sign in again, and grok is told why.
      const no = await pc.cmd(command, {
        FAKE_CURL_LOG: log,
        FAKE_CURL_CODE: '401',
        FAKE_CURL_BODY: '{"message":"this machine was stopped in agentbox"}',
      });
      expect(no.code).toBe(1);
      expect(no.stdout).toBe('');
      expect(no.stderr).toContain('could not sign grok in, HTTP 401');
      expect(no.stderr).toContain('this machine was stopped in agentbox');
    },
  );
});
