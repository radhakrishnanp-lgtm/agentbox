/** Starts a fresh agentbox server for Playwright on an empty data directory. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DATA_DIR, e2eEnv, e2eTermdEnv } from './env.ts';

rmSync(E2E_DATA_DIR, { recursive: true, force: true });
// Sessions left over from an earlier run would clash with this one.
spawnSync('tmux', ['-L', e2eTermdEnv['AGENTBOX_TERMD_TMUX'] ?? '', 'kill-server']);
mkdirSync(e2eTermdEnv['AGENTBOX_TERMD_HOME'] ?? '', { recursive: true, mode: 0o700 });
// The terminal service, as the installer runs it (here as the current user).
const termd = spawn(process.execPath, [join(import.meta.dirname, '../../apps/termd/src/main.ts')], {
  env: { ...process.env, ...e2eTermdEnv },
  stdio: 'inherit',
});
const child = spawn(
  process.execPath,
  [join(import.meta.dirname, '../../apps/server/src/main.ts')],
  {
    env: { ...process.env, ...e2eEnv },
    stdio: 'inherit',
  },
);
const stop = () => {
  child.kill('SIGTERM');
  termd.kill('SIGTERM');
  spawn('tmux', ['-L', e2eTermdEnv['AGENTBOX_TERMD_TMUX'] ?? '', 'kill-server']);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => {
  termd.kill('SIGTERM');
  process.exit(code ?? 0);
});
