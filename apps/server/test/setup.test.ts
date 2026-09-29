import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, type Browser } from './helpers/harness.ts';
import type { CreationOptions } from './helpers/virtual-authenticator.ts';

let h: Harness;
let b: Browser;

beforeEach(async () => {
  h = await Harness.create();
  b = h.browser();
});
afterEach(() => h.close());

function tokenFrom(url: string): string {
  return url.split('#')[1]!;
}

describe('first-run setup', () => {
  it('reports setup required until complete, then signs the setup device in', async () => {
    expect((await b.get('/api/auth/state')).json()).toEqual({ setupRequired: true, session: null });
    const codes = await h.completeSetup(b, 'My laptop');
    expect(codes).toHaveLength(10);
    for (const c of codes)
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const state = (await b.get('/api/auth/state')).json();
    expect(state.setupRequired).toBe(false);
    expect(state.session.deviceName).toBe('My laptop');
    const security = (await b.get('/api/security')).json();
    expect(security.passkeys).toHaveLength(1);
    expect(security.recoveryCodesRemaining).toBe(10);
  });

  it('rejects an unknown or expired link', async () => {
    const bad = await b.post('/api/setup/status', { token: 'A'.repeat(43) });
    expect(bad.statusCode).toBe(401);
    const { url } = h.services.setup.createLink({ reset: false, actor: 'test' });
    h.clock.advance(31 * 60_000);
    const expired = await b.post('/api/setup/status', { token: tokenFrom(url) });
    expect(expired.statusCode).toBe(401);
  });

  it('only the newest link works', async () => {
    const first = h.services.setup.createLink({ reset: false, actor: 'test' });
    h.services.setup.createLink({ reset: false, actor: 'test' });
    const res = await b.post('/api/setup/status', { token: tokenFrom(first.url) });
    expect(res.statusCode).toBe(401);
  });

  it('closes the setup endpoints for good once complete', async () => {
    await h.completeSetup(b);
    expect(() => h.services.setup.createLink({ reset: false, actor: 'test' })).toThrow(
      /already complete/,
    );
    const res = await b.post('/api/setup/status', { token: 'A'.repeat(43) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('setup_complete');
  });

  it('refuses to skip steps', async () => {
    const { url } = h.services.setup.createLink({ reset: false, actor: 'test' });
    const token = tokenFrom(url);
    expect((await b.post('/api/setup/totp/init', { token })).statusCode).toBe(400);
    expect((await b.post('/api/setup/complete', { token, deviceName: 'x' })).statusCode).toBe(400);
  });

  it('rejects a passkey created for another website (origin check)', async () => {
    const { url } = h.services.setup.createLink({ reset: false, actor: 'test' });
    const token = tokenFrom(url);
    const opts = (await b.post('/api/setup/passkey/options', { token })).json<CreationOptions>();
    const res = await b.post('/api/setup/passkey', {
      token,
      response: h.passkey.create(opts, { origin: 'https://evil.example' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a passkey without user verification (biometric/PIN)', async () => {
    const { url } = h.services.setup.createLink({ reset: false, actor: 'test' });
    const token = tokenFrom(url);
    const opts = (await b.post('/api/setup/passkey/options', { token })).json<CreationOptions>();
    h.passkey.userVerified = false;
    const res = await b.post('/api/setup/passkey', { token, response: h.passkey.create(opts) });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong authenticator code', async () => {
    const { url } = h.services.setup.createLink({ reset: false, actor: 'test' });
    const token = tokenFrom(url);
    const opts = (await b.post('/api/setup/passkey/options', { token })).json<CreationOptions>();
    await b.post('/api/setup/passkey', { token, response: h.passkey.create(opts) });
    await b.post('/api/setup/totp/init', { token });
    const res = await b.post('/api/setup/totp/confirm', { token, code: '000000' });
    expect(res.statusCode).toBe(401);
  });

  it('reset wipes sign-in methods but keeps the audit log', async () => {
    await h.completeSetup(b);
    const before = h.services.audit.page(100).entries.length;
    h.services.setup.createLink({ reset: true, actor: 'cli' });
    expect(h.services.setup.isComplete()).toBe(false);
    expect((await b.get('/api/security')).statusCode).toBe(401);
    const after = h.services.audit.page(100).entries;
    expect(after.length).toBeGreaterThan(before);
    expect(after.map((e) => e.action)).toContain('setup.reset');
    expect(h.services.audit.verify().ok).toBe(true);
  });
});
