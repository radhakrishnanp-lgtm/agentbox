/** Starts a fresh agentbox server for Playwright on an empty data directory. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DATA_DIR, e2eEnv } from './env.ts';

rmSync(E2E_DATA_DIR, { recursive: true, force: true });
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
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
