/**
 * Runs the real machine setup script against a listening agentbox and checks
 * what each CLI wrapper hands to the real CLI. The "real" CLIs here are small
 * scripts that record their environment and arguments.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiKeySummary, MachineCreated } from '@agentbox/shared';
import { renderMachineScript } from '../src/gateway/script.ts';
import { Harness, type Browser } from './helpers/harness.ts';

const run = promisify(execFile);
const CLIS = ['claude', 'codex', 'grok', 'kimi', 'gemini'] as const;

let h: Harness;
let laptop: Browser;
let dir: string;

beforeEach(async () => {
  h = await Harness.create();
  laptop = h.browser();
  await h.completeSetup(laptop);
  dir = mkdtempSync(join(tmpdir(), 'agentbox-machine-'));
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

/** A computer: a home folder, and fake CLIs that write down how they were started. */
function computer() {
  const home = join(dir, 'home');
  const fakebin = join(dir, 'fakebin');
  const out = join(dir, 'out');
  for (const d of [home, fakebin, out]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.profile'), '# existing profile\n');
  for (const cli of CLIS) {
    const file = join(fakebin, cli);
    writeFileSync(
      file,
      `#!/bin/sh\n{ env; for a in "$@"; do printf 'ARG=%s\\n' "$a"; done; } >"${out}/${cli}"\n`,
    );
    chmodSync(file, 0o755);
  }
  const bin = join(home, '.local/share/agentbox/bin');
  const env = {
    HOME: home,
    PATH: `${bin}:${fakebin}:/usr/bin:/bin`,
    // Stale settings on the computer that must not reach the CLIs.
    ANTHROPIC_API_KEY: 'sk-ant-stale-local-key',
    OPENAI_API_KEY: 'sk-stale-local-key',
    GOOGLE_API_KEY: 'stale-google-key',
  };
  const sh = async (script: string, extra: Record<string, string> = {}) =>
    (await run('/bin/sh', ['-c', script], { env: { ...env, ...extra }, timeout: 20_000 })).stdout;
  /** How the fake CLI was started: its environment and arguments. */
  const seen = (cli: string) => {
    const lines = readFileSync(join(out, cli), 'utf8').trim().split('\n');
    const vars = new Map<string, string>();
    const args: string[] = [];
    for (const line of lines) {
      if (line.startsWith('ARG=')) args.push(line.slice(4));
      else {
        const eq = line.indexOf('=');
        if (eq > 0) vars.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
    return { vars, args };
  };
  return { home, bin, sh, seen };
}

describe('machine setup script', () => {
  it('wires up every CLI so it reaches only agentbox, with the pass and not a stored login', async () => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}`;

    const keys = [
      await addKey({ preset: 'anthropic', name: 'Claude', slug: 'anthropic' }),
      await addKey({ preset: 'openai', name: 'OpenAI', slug: 'openai', model: 'gpt-5.1-codex' }),
      await addKey({ preset: 'xai', name: 'xAI', slug: 'xai' }),
      await addKey({ preset: 'moonshot', name: 'Kimi', slug: 'kimi', model: 'kimi-k2' }),
      await addKey({ preset: 'gemini', name: 'Gemini', slug: 'gemini' }),
    ];
    await h.reauth(laptop);
    const created = await laptop.post('/api/gateway/machines', {
      name: 'gpu-1',
      keyIds: keys.map((k) => k.id),
      dailyTokenLimit: null,
    });
    expect(created.statusCode, created.body).toBe(200);
    const { pass } = created.json<MachineCreated>();

    const pc = computer();
    const script = join(dir, 'machine.sh');
    writeFileSync(script, renderMachineScript(base));
    const report = await pc.sh(`sh '${script}'`, { AGENTBOX_PASS: pass });
    expect(report).toContain(
      'These commands now use your agentbox keys: claude codex grok kimi gemini',
    );
    expect(statSync(join(pc.home, '.config/agentbox/pass')).mode & 0o777).toBe(0o600);

    for (const cli of CLIS) await pc.sh(`${cli} --flag 'two words'`);
    const url = (slug: string) => `${base}/gw/${slug}`;

    const claude = pc.seen('claude');
    expect(claude.vars.get('ANTHROPIC_BASE_URL')).toBe(url('anthropic'));
    expect(claude.vars.get('ANTHROPIC_AUTH_TOKEN')).toBe(pass);
    expect(claude.vars.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe('1');
    expect(claude.vars.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(claude.vars.has('ANTHROPIC_MODEL')).toBe(false);
    expect(claude.args).toEqual(['--flag', 'two words']);

    const codex = pc.seen('codex');
    expect(codex.vars.get('AGENTBOX_CODEX_KEY')).toBe(pass);
    expect(codex.vars.get('CODEX_HOME')).toBe(join(pc.home, '.local/share/agentbox/codex'));
    expect(codex.vars.has('OPENAI_API_KEY')).toBe(false);
    expect(codex.args).toEqual(
      expect.arrayContaining([
        'model_provider="agentbox"',
        `model_providers.agentbox.base_url="${url('openai')}/v1"`,
        'model_providers.agentbox.env_key="AGENTBOX_CODEX_KEY"',
        'model_providers.agentbox.wire_api="responses"',
        'analytics.enabled=false',
        'model="gpt-5.1-codex"',
      ]),
    );
    expect(codex.args.slice(-2)).toEqual(['--flag', 'two words']);

    const grok = pc.seen('grok');
    expect(grok.vars.get('XAI_API_KEY')).toBe(pass);
    expect(grok.vars.get('GROK_API_KEY')).toBe(pass);
    expect(grok.vars.get('GROK_XAI_API_BASE_URL')).toBe(`${url('xai')}/v1`);
    expect(grok.vars.get('GROK_BASE_URL')).toBe(`${url('xai')}/v1`);
    expect(grok.vars.get('GROK_HOME')).toBe(join(pc.home, '.local/share/agentbox/grok'));
    expect(grok.vars.get('GROK_TELEMETRY_ENABLED')).toBe('false');

    const kimi = pc.seen('kimi');
    expect(kimi.vars.get('KIMI_MODEL_BASE_URL')).toBe(`${url('kimi')}/v1`);
    expect(kimi.vars.get('KIMI_MODEL_API_KEY')).toBe(pass);
    expect(kimi.vars.get('KIMI_MODEL_NAME')).toBe('kimi-k2');
    expect(kimi.vars.get('KIMI_BASE_URL')).toBe(`${url('kimi')}/v1`);
    expect(kimi.vars.get('KIMI_API_KEY')).toBe(pass);
    expect(kimi.vars.get('KIMI_DISABLE_TELEMETRY')).toBe('1');

    const gemini = pc.seen('gemini');
    const geminiHome = join(pc.home, '.local/share/agentbox/gemini');
    expect(gemini.vars.get('GOOGLE_GEMINI_BASE_URL')).toBe(url('gemini'));
    expect(gemini.vars.get('GEMINI_API_KEY')).toBe(pass);
    expect(gemini.vars.get('GEMINI_CLI_HOME')).toBe(geminiHome);
    expect(gemini.vars.has('GOOGLE_API_KEY')).toBe(false);
    expect(JSON.parse(readFileSync(join(geminiHome, '.gemini/settings.json'), 'utf8'))).toEqual({
      security: { auth: { selectedType: 'gemini-api-key' } },
      privacy: { usageStatisticsEnabled: false },
    });

    // Nothing is exported into the normal shell.
    expect(await pc.sh('echo "[${ANTHROPIC_BASE_URL:-}${XAI_API_KEY:-}]"')).toBe('[]\n');

    // Uninstall leaves nothing behind, including the CLIs' own folders.
    await pc.sh('agentbox-machine uninstall');
    expect(existsSync(join(pc.home, '.local/share/agentbox'))).toBe(false);
    expect(readdirSync(join(pc.home, '.config'))).toEqual([]);
    expect(readFileSync(join(pc.home, '.profile'), 'utf8')).toBe('# existing profile\n');
  });

  it('skips a Kimi key without a model, and a CLI it does not know', async () => {
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${address.port}`;
    const kimi = await addKey({ preset: 'custom', name: 'Kimi', slug: 'kimi', cli: 'kimi' });
    const other = await addKey({ preset: 'openrouter', name: 'Router', slug: 'openrouter' });
    await h.reauth(laptop);
    const created = await laptop.post('/api/gateway/machines', {
      name: 'gpu-2',
      keyIds: [kimi.id, other.id],
      dailyTokenLimit: null,
    });
    const { pass } = created.json<MachineCreated>();
    const pc = computer();
    const script = join(dir, 'machine.sh');
    writeFileSync(script, renderMachineScript(base));
    const report = await pc.sh(`sh '${script}'`, { AGENTBOX_PASS: pass });
    expect(report).toContain('No AI tools are allowed for this machine yet');
    expect(existsSync(join(pc.bin, 'kimi'))).toBe(false);
  });
});
