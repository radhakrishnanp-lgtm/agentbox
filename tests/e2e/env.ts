import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Throwaway settings for the end-to-end server. Never used outside tests. */
export const E2E_PORT = 8181;
export const E2E_ORIGIN = `http://localhost:${String(E2E_PORT)}`;
export const E2E_DATA_DIR = join(tmpdir(), 'agentbox-e2e');

export const e2eEnv: Record<string, string> = {
  NODE_ENV: 'test',
  AGENTBOX_ORIGIN: E2E_ORIGIN,
  AGENTBOX_LISTEN: `127.0.0.1:${String(E2E_PORT)}`,
  AGENTBOX_DATA_DIR: E2E_DATA_DIR,
  AGENTBOX_WEB_DIST: join(import.meta.dirname, '../../apps/web/dist'),
  // Fixed test-only values (32 zero-ish bytes); real installs generate their own.
  AGENTBOX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  AGENTBOX_SESSION_SECRET: 'e2e-session-secret-that-is-long-enough-000',
  LOG_LEVEL: 'warn',
};
