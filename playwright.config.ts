import { defineConfig } from '@playwright/test';
import { E2E_ORIGIN } from './tests/e2e/env.ts';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
    launchOptions: {
      // The sandbox and CI image ship Chromium here; locally Playwright finds its own.
      ...(process.env['PLAYWRIGHT_CHROMIUM_PATH']
        ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] }
        : {}),
    },
  },
  webServer: {
    command: 'node tests/e2e/server.ts',
    url: `${E2E_ORIGIN}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
