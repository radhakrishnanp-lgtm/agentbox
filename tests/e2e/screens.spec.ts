/** Captures phone-width screenshots of the main screens when SCREENSHOT_DIR is set. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { TOTP } from 'otpauth';
import { e2eEnv } from './env.ts';

const dir = process.env['SCREENSHOT_DIR'];

test.skip(!dir, 'set SCREENSHOT_DIR to capture screenshots');

test('screenshots', async ({ browser }) => {
  const out = (name: string) => join(dir ?? '.', `${name}.png`);
  const link = /(http:\/\/\S+\/setup#\S+)/.exec(
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, '../../apps/server/src/cli.ts'), 'setup-link', '--reset'],
      { env: { ...process.env, ...e2eEnv }, encoding: 'utf8' },
    ),
  )?.[1];
  if (!link) throw new Error('no link');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(link);
  await page.getByRole('button', { name: 'Create passkey' }).waitFor();
  await page.screenshot({ path: out('1-setup-passkey') });
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await page.getByText("Can't scan? Enter the key by hand").click();
  const secret = (await page.locator('details code').innerText()).replace(/\s/g, '');
  await page.screenshot({ path: out('2-setup-totp'), fullPage: true });
  await page.getByLabel('6-digit code from the app').fill(new TOTP({ secret }).generate());
  await page.getByRole('button', { name: 'Verify code' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('list', { name: 'Recovery codes' }).waitFor();
  await page.screenshot({ path: out('3-recovery-codes'), fullPage: true });
  await page.getByLabel("I've saved these codes somewhere safe").check();
  await page.getByRole('button', { name: 'Continue to agentbox' }).click();
  await page.getByText(/Signed in on/).waitFor();
  await page.screenshot({ path: out('4-home'), fullPage: true });
  await page.goto('/security');
  await page.getByText('Authenticator app').waitFor();
  await page.screenshot({ path: out('5-security'), fullPage: true });
  await page.goto('/activity');
  await page.getByText('Setup completed').first().waitFor();
  await page.screenshot({ path: out('6-activity'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with passkey' }).waitFor();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: out('7-signin-light') });
  await ctx.close();
});
