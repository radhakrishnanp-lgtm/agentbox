/**
 * The owner's first-day journey in a real browser, with Chrome's virtual
 * authenticator standing in for a phone's passkey:
 * setup link → passkey → authenticator app → recovery codes → home →
 * sign out → passkey sign-in → a second browser approved with TOTP →
 * add an AI key and a machine → set the machine up with the real setup
 * script → its `claude` command reaches a stand-in provider with the real key
 * → stop the machine and watch the command get refused.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { TOTP } from 'otpauth';
import { FakeProvider } from '../../apps/server/test/helpers/fake-provider.ts';
import { E2E_ORIGIN, e2eEnv } from './env.ts';

const SIGNIN_PASSWORD = 'e2e sign-in password, long enough';
const REAL_KEY = 'sk-ant-api03-E2E-REAL-KEY-never-leaves-agentbox-wxyz';

/**
 * A throwaway "machine": its own HOME, plus a stand-in `claude` that does
 * what Claude Code does with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.
 */
function makeMachine() {
  const home = mkdtempSync(join(tmpdir(), 'agentbox-machine-'));
  const tools = join(home, 'tools');
  execFileSync('mkdir', ['-p', tools]);
  writeFileSync(
    join(tools, 'claude'),
    [
      '#!/bin/sh',
      'curl -sS -X POST "$ANTHROPIC_BASE_URL/v1/messages" \\',
      '  -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H "content-type: application/json" \\',
      '  -H "anthropic-version: 2023-06-01" \\',
      `  -d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'`,
      '',
    ].join('\n'),
  );
  chmodSync(join(tools, 'claude'), 0o755);
  const env = {
    HOME: home,
    SHELL: '/bin/bash',
    PATH: `${tools}:/usr/local/bin:/usr/bin:/bin`,
  };
  // Async on purpose: the stand-in provider runs in this process and must keep answering.
  const sh = async (script: string, extra: Record<string, string> = {}) =>
    (
      await promisify(execFile)('/bin/sh', ['-c', script], {
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 20_000,
      })
    ).stdout;
  const cleanup = () => {
    rmSync(home, { recursive: true, force: true });
  };
  return { home, env, sh, cleanup };
}

function setupLink(): string {
  const out = execFileSync(
    process.execPath,
    [join(import.meta.dirname, '../../apps/server/src/cli.ts'), 'setup-link'],
    { env: { ...process.env, ...e2eEnv }, encoding: 'utf8' },
  );
  const match = /(http:\/\/\S+\/setup#[A-Za-z0-9_-]{43})/.exec(out);
  if (!match?.[1]) throw new Error(`No setup link in CLI output:\n${out}`);
  return match[1];
}

async function addAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Fails the test on any CSP violation or uncaught error in the page. */
/** Screenshots for the docs and PRs, only when E2E_SCREENSHOTS names a folder. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['E2E_SCREENSHOTS'];
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (msg) => {
    // Expected 4xx answers (like the deliberately wrong code) are logged by Chrome; skip those.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
      problems.push(msg.text());
    }
  });
  page.on('pageerror', (err) => problems.push(err.message));
  return problems;
}

test('owner sets up agentbox and signs in on two devices', async ({ browser }) => {
  test.setTimeout(180_000);
  const link = setupLink();

  // ── Device 1: setup ─────────────────────────────────────────────
  const laptop = await browser.newContext();
  const page = await laptop.newPage();
  const problems = watchConsole(page);
  const first: { cdp: CDPSession; authenticatorId: string } = await addAuthenticator(laptop, page);

  await page.goto(link);
  await expect(page).toHaveURL(/\/setup$/); // token moved out of the address bar
  await expect(page.getByRole('heading', { name: 'Set up agentbox' })).toBeVisible();
  await page.getByRole('button', { name: 'Create passkey' }).click();

  await expect(page.getByRole('heading', { name: 'Add an authenticator app' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  await page.getByText("Can't scan? Enter the key by hand").click();
  const secret = (await page.locator('details code').innerText()).replace(/\s/g, '');
  const totp = new TOTP({ secret, digits: 6, period: 30, algorithm: 'SHA1' });

  await page.getByLabel('6-digit code from the app').fill('000000');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByText("That code didn't match")).toBeVisible();

  await page.getByLabel('6-digit code from the app').fill(totp.generate());
  await page.getByRole('button', { name: 'Verify code' }).click();

  await expect(page.getByRole('heading', { name: 'Name this device' })).toBeVisible();
  await page.getByLabel('Device name').fill('E2E laptop');
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  await expect(codes.first()).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const continueButton = page.getByRole('button', { name: 'Continue to agentbox' });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("I've saved these codes somewhere safe").check();
  await continueButton.click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Signed in on E2E laptop.')).toBeVisible();

  // The setup link is single-use.
  const reuse = await laptop.newPage();
  await reuse.goto(link);
  await expect(reuse.getByRole('heading', { name: 'Setup link not valid' })).toBeVisible();
  await reuse.close();

  // ── Security page: the only passkey can't be removed ───────────
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Security' })
    .click();
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove passkey/ })).toBeDisabled();
  await expect(page.getByText('10 of 10 left')).toBeVisible();

  // ── Sign out, then back in with the passkey ─────────────────────
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto('/security');
  await expect(page).toHaveURL(/\/signin$/); // signed-out users are sent to sign-in
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByText('Signed in on E2E laptop.')).toBeVisible();

  // ── Device 2: same passkey (synced), new browser → needs TOTP ──
  const { credentials } = await first.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: first.authenticatorId,
  });
  const phone = await browser.newContext();
  const phonePage = await phone.newPage();
  const phoneProblems = watchConsole(phonePage);
  const second = await addAuthenticator(phone, phonePage);
  for (const credential of credentials) {
    await second.cdp.send('WebAuthn.addCredential', {
      authenticatorId: second.authenticatorId,
      credential,
    });
  }

  await phonePage.goto('/');
  await expect(phonePage).toHaveURL(/\/signin$/);
  await phonePage.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(phonePage.getByRole('heading', { name: 'Approve this device' })).toBeVisible();
  // The setup code's time step is spent (replay protection), so use the next one.
  await phonePage
    .getByLabel('6-digit code')
    .fill(totp.generate({ timestamp: Date.now() + 30_000 }));
  await phonePage.getByLabel('Name this device').fill('E2E phone');
  await phonePage.getByRole('button', { name: 'Approve and sign in' }).click();
  await expect(phonePage.getByText('Signed in on E2E phone.')).toBeVisible();

  // ── Computer without a passkey: password + authenticator code ──
  await page.goto('/security');
  await page.getByRole('button', { name: 'Set a password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(SIGNIN_PASSWORD);
  await page.getByLabel('Type it again').fill(SIGNIN_PASSWORD);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();

  const office = await browser.newContext(); // no passkey at all
  const officePage = await office.newPage();
  const officeProblems = watchConsole(officePage);
  await officePage.goto('/signin');
  await shot(officePage, 'signin');
  await officePage.getByRole('link', { name: 'Sign in with password and code' }).click();
  await expect(officePage.getByRole('heading', { name: 'Sign in with password' })).toBeVisible();
  await officePage.getByLabel('Password').fill(SIGNIN_PASSWORD);
  // The phone used the next time step, so wait for the clock to move on first.
  await officePage.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  await officePage
    .getByLabel('6-digit authenticator code')
    .fill(totp.generate({ timestamp: Date.now() + 30_000 }));
  await officePage.getByLabel('Name this computer').fill('E2E office PC');
  await shot(officePage, 'signin-password');
  await officePage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(officePage.getByText('Signed in on E2E office PC.')).toBeVisible();

  // A sensitive action here, when the passkey check can't be used: it asks for a code instead.
  // (A string, because this file is type-checked without the browser's types.)
  await officePage.evaluate(
    "navigator.credentials.get = () => Promise.reject(new DOMException('No passkey here', 'NotAllowedError'))",
  );
  let staleOnce = true;
  await officePage.route('**/api/security/password', async (route) => {
    if (staleOnce && route.request().method() === 'PUT') {
      staleOnce = false; // as if the last check were older than five minutes
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'fresh_auth_required', message: 'Confirm it is you.' },
        }),
      });
      return;
    }
    await route.continue();
  });
  await officePage.getByRole('link', { name: 'Security' }).first().click();
  await officePage.getByRole('button', { name: 'Change password' }).click();
  await officePage.getByLabel('New password').fill(SIGNIN_PASSWORD);
  await officePage.getByLabel('Type it again').fill(SIGNIN_PASSWORD);
  await officePage.getByRole('button', { name: 'Save password' }).click();
  const confirm = officePage.getByRole('alertdialog', { name: "Confirm it's you" });
  await expect(confirm).toBeVisible();
  await officePage.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  await confirm
    .getByLabel('6-digit authenticator code')
    .fill(totp.generate({ timestamp: Date.now() + 30_000 }));
  await shot(officePage, 'confirm-with-code');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(officePage.getByRole('button', { name: 'Change password' })).toBeVisible();
  expect(officeProblems).toEqual([]);
  await office.close();

  // ── Activity: events are recorded and the hash chain verifies ──
  await page.goto('/activity');
  await expect(page.getByText('Setup completed')).toBeVisible();
  await expect(page.getByText('Device approved')).toHaveCount(2); // phone and office PC
  await expect(page.getByText('Sign-in password set').first()).toBeVisible();
  await page.getByRole('button', { name: 'Check integrity' }).click();
  await expect(page.getByText('Log is intact')).toBeVisible();

  // ── Machines: keep the key here, give a computer a pass ────────
  const provider = await new FakeProvider().start();
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Machines' })
    .click();
  await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add' }).nth(1).click(); // AI keys → Add
  await page.getByLabel('Key', { exact: true }).fill(REAL_KEY);
  await page.getByLabel('Provider address').fill(provider.url);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('ends in ••••wxyz')).toBeVisible();
  await expect(page.getByText(REAL_KEY)).toHaveCount(0);

  await page.getByRole('button', { name: 'Add' }).first().click(); // Machines → Add
  await page.getByLabel('Name', { exact: true }).fill('e2e-gpu');
  await page.getByRole('button', { name: 'Create pass' }).click();
  await expect(page.getByRole('heading', { name: 'Set up “e2e-gpu”' })).toBeVisible();
  const pass = (await page.locator('code').filter({ hasText: /^abx_/ }).innerText()).trim();
  expect(pass).toMatch(/^abx_[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText(`curl -fsSL ${E2E_ORIGIN}/machine.sh | sh`)).toBeVisible();
  await expect(page.getByText(`irm ${E2E_ORIGIN}/machine.ps1 | iex`)).toBeVisible();

  const machine = makeMachine();
  try {
    const setupOut = await machine.sh(`curl -fsSL ${E2E_ORIGIN}/machine.sh | sh`, {
      AGENTBOX_PASS: pass,
    });
    expect(setupOut).toContain('This computer is set up as "e2e-gpu"');
    expect(setupOut).toContain('claude: ready');
    const bin = join(machine.home, '.local/share/agentbox/bin');
    // A new login shell picks up the PATH line, and `claude` now goes through agentbox.
    const answer = await machine.sh(`. "$HOME/.profile"; command -v claude; claude -p hi`);
    expect(answer).toContain(`${bin}/claude`);
    expect(answer).toContain('Hello from the fake provider');
    const seen = provider.last();
    expect(seen.headers['x-api-key']).toBe(REAL_KEY);
    expect(JSON.stringify(seen.headers)).not.toContain(pass);
    // The pass file is private to the machine's user, and no key was written anywhere.
    expect(await machine.sh('ls -l "$HOME/.config/agentbox/pass"')).toMatch(/^-rw-------/);
    expect(await machine.sh('grep -rl "E2E-REAL-KEY" "$HOME" || true')).toBe('');

    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    await expect(page.getByText('Active')).toBeVisible();
    await expect(page.getByText(/today 1 requests, 15 tokens/)).toBeVisible();
    await expect(
      page.getByText(/Only from 127\.0\.0\.1 \(First address used\), new ones need your OK/),
    ).toBeVisible();
    // The Windows setup script is served too.
    expect(await machine.sh(`curl -fsS ${E2E_ORIGIN}/machine.ps1`)).toContain(
      `$AgentboxUrl = '${E2E_ORIGIN}'`,
    );

    // The same pass from another address (127.0.0.2 here) is refused until it's allowed.
    const fromOther = () =>
      machine.sh(
        `curl -sS --interface 127.0.0.2 -X POST ${E2E_ORIGIN}/gw/anthropic/v1/messages ` +
          `-H "x-api-key: ${pass}" -H "content-type: application/json" ` +
          `-d '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'`,
      );
    expect(await fromOther()).toContain('(127.0.0.2) is new for this machine');
    await page.reload();
    await expect(page.getByText('Blocked a request from 127.0.0.2')).toBeVisible();
    await shot(page, 'machine-new-address');
    await page.getByRole('button', { name: 'Allow this address' }).click();
    await expect(
      page.getByText(
        /127\.0\.0\.1 \(First address used\), 127\.0\.0\.2 \(Allowed after it was blocked\)/,
      ),
    ).toBeVisible();
    expect(await fromOther()).toContain('Hello from the fake provider');

    // Stop it: the same command is refused at once.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Stop machine' }).click();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
    const refused = await machine.sh(`. "$HOME/.profile"; claude -p hi`);
    expect(refused).toContain('agentbox: this machine was stopped in agentbox.');

    const status = await machine
      .sh(`"$HOME/.local/share/agentbox/bin/agentbox-machine" status`)
      .catch((err: unknown) => String((err as { stderr?: string }).stderr ?? err));
    expect(status).toContain('stopped');

    // Start it again: the same pass works again.
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByText('Active')).toBeVisible();
    expect(await machine.sh(`. "$HOME/.profile"; claude -p hi`)).toContain(
      'Hello from the fake provider',
    );

    // Edit: rename it, remove the second address, add a range with a note, and
    // change the first address's note.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('e2e-gpu-renamed');
    await page.getByRole('button', { name: 'Remove 127.0.0.2' }).click();
    await page.getByLabel('IP address or range').fill('not an address');
    await page.getByRole('button', { name: 'Add address' }).click();
    await expect(page.getByText('“not an address” is not an IP address or range')).toBeVisible();
    await page.getByLabel('IP address or range').fill('10.9.0.0/16');
    await page.getByLabel('Note (optional)').fill('office');
    await page.getByRole('button', { name: 'Add address' }).click();
    await page.getByRole('button', { name: 'Edit 127.0.0.1' }).click();
    await expect(page.getByLabel('Change address')).toHaveValue('127.0.0.1');
    await page.getByLabel('Note (optional)').fill('this machine');
    await page.getByLabel('Note (optional)').press('Enter');
    const list = page.getByRole('list', { name: 'Allowed addresses' });
    await expect(list.getByRole('listitem')).toHaveText([
      '127.0.0.1 · this machine',
      '10.9.0.0/16 · office',
    ]);
    await shot(page, 'machine-edit');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved “e2e-gpu-renamed”')).toBeVisible();
    await expect(
      page.getByText(
        /Only from 127\.0\.0\.1 \(this machine\), 10\.9\.0\.0\/16 \(office\), new ones need your OK/,
      ),
    ).toBeVisible();
    expect(await fromOther()).toContain('(127.0.0.2) is new for this machine');

    // Logs: the computer, where it called from, and what it used.
    await page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Logs' })
      .click();
    await expect(page.getByRole('heading', { name: 'Logs', level: 1 })).toBeVisible();
    await expect(
      page.getByText('Kept for 7 days, then deleted by itself.', { exact: false }),
    ).toBeVisible();
    const computers = page.getByRole('img', { name: /^e2e-gpu-renamed: \d+ tokens$/ });
    await expect(computers).toBeVisible();
    await expect(page.getByRole('cell', { name: /127\.0\.0\.2/ }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: /claude-sonnet-4-5/ }).first()).toBeVisible();
    await shot(page, 'logs');
    await page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Machines' })
      .click();
    await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();

    // Stop, then delete: it is gone, and so is its pass.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Stop machine' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete machine' }).click();
    await expect(page.getByText('No machines yet')).toBeVisible();
    expect(await machine.sh(`. "$HOME/.profile"; claude -p hi`)).toContain(
      'no valid agentbox pass',
    );
    await machine.sh(`"$HOME/.local/share/agentbox/bin/agentbox-machine" uninstall`);
    // Nothing of agentbox is left behind: no pass, no wrappers, no PATH line.
    expect(
      await machine.sh(
        'ls -A "$HOME/.config" "$HOME/.local/share"; grep -c agentbox "$HOME/.profile" || true',
      ),
    ).toBe(`${machine.home}/.config:

${machine.home}/.local/share:
0
`);
  } finally {
    machine.cleanup();
    await provider.stop();
  }

  // ── Terminals: a live shell on the server ─────────────────────
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Terminals' })
    .click();
  await expect(page.getByRole('heading', { name: 'Terminals', level: 1 })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('e2e');
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/terminals\/e2e$/);
  await expect(page.getByText('Connected')).toBeVisible();
  // Give the new session a moment to settle its size, then type.
  await page.waitForTimeout(800);
  await page.keyboard.type('echo E2E-$((40+2))');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('E2E-42');
  // Leaving only detaches: the session is still listed.
  await page.getByRole('link', { name: 'Back to terminals' }).click();
  await expect(page.getByText('e2e', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close e2e' }).click();
  await page.getByRole('button', { name: 'Close session' }).click();
  await expect(page.getByText('No sessions')).toBeVisible();

  await page.goto('/activity');
  await expect(page.getByText('Terminal opened')).toBeVisible();
  await expect(page.getByText('Machine used for the first time')).toBeVisible();
  await expect(page.getByText('Machine stopped')).toHaveCount(2); // stopped twice
  await expect(page.getByText('Machine started again')).toBeVisible();
  await expect(page.getByText('Machine deleted')).toBeVisible();

  expect(problems, 'console errors on device 1').toEqual([]);
  expect(phoneProblems, 'console errors on device 2').toEqual([]);
  await laptop.close();
  await phone.close();
});
