import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session as sessionTable } from '../src/db/schema.ts';
import { POLICIES } from '../src/security/lockout.ts';
import { Harness, type Browser } from './helpers/harness.ts';
import { VirtualAuthenticator, type RequestOptions } from './helpers/virtual-authenticator.ts';

let h: Harness;
let laptop: Browser;
let recoveryCodes: string[];

beforeEach(async () => {
  h = await Harness.create();
  laptop = h.browser();
  recoveryCodes = await h.completeSetup(laptop);
});
afterEach(() => h.close());

const MIN = 60_000;

describe('passkey sign-in', () => {
  it('signs in an approved device with one passkey tap', async () => {
    await laptop.post('/api/auth/logout');
    expect((await laptop.get('/api/security')).statusCode).toBe(401);
    const res = await h.signInWithPasskey(laptop);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('signed_in');
    expect((await laptop.get('/api/security')).statusCode).toBe(200);
  });

  it('asks a new device for a second check, then approves it with the authenticator code', async () => {
    const phone = h.browser('198.51.100.7', 'Mozilla/5.0 (iPhone) Safari/19');
    const res = await h.signInWithPasskey(phone);
    expect(res.json().status).toBe('device_approval_required');
    // No session yet.
    expect((await phone.get('/api/security')).statusCode).toBe(401);
    const { ticket } = res.json();
    const done = await phone.post('/api/auth/new-device/totp', {
      ticket,
      code: h.totp(),
      deviceName: 'Phone',
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().session.deviceName).toBe('Phone');
    expect((await phone.get('/api/security')).statusCode).toBe(200);
  });

  it('never accepts the same authenticator code twice', async () => {
    const phone = h.browser('198.51.100.7');
    const { ticket } = (await h.signInWithPasskey(phone)).json();
    const code = h.totp();
    expect(
      (await phone.post('/api/auth/new-device/totp', { ticket, code, deviceName: 'Phone' }))
        .statusCode,
    ).toBe(200);
    const tablet = h.browser('198.51.100.8');
    const t2 = (await h.signInWithPasskey(tablet)).json().ticket;
    const replay = await tablet.post('/api/auth/new-device/totp', {
      ticket: t2,
      code,
      deviceName: 'Tablet',
    });
    expect(replay.statusCode).toBe(401);
  });

  it('a login ticket only works in the browser it was issued to', async () => {
    const phone = h.browser('198.51.100.7');
    const { ticket } = (await h.signInWithPasskey(phone)).json();
    const attacker = h.browser('192.0.2.66');
    const res = await attacker.post('/api/auth/new-device/totp', {
      ticket,
      code: h.totp(),
      deviceName: 'Evil',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown passkey and records the failure', async () => {
    const stranger = new VirtualAuthenticator(h.passkey.origin, h.passkey.rpId);
    const res = await h.signInWithPasskey(laptop, stranger);
    expect(res.statusCode).toBe(401);
    expect(h.services.audit.page(5).entries[0]?.action).toBe('auth.login_failed');
  });

  it('rejects an assertion for another website (phishing site)', async () => {
    const opts = (await laptop.post('/api/auth/passkey/options')).json<RequestOptions>();
    const res = await laptop.post('/api/auth/passkey/verify', {
      response: h.passkey.get(opts, { origin: 'https://agent.example.test.evil.example' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('a challenge can be used only once', async () => {
    const opts = (await laptop.post('/api/auth/passkey/options')).json<RequestOptions>();
    const first = await laptop.post('/api/auth/passkey/verify', { response: h.passkey.get(opts) });
    expect(first.statusCode).toBe(200);
    const again = await laptop.post('/api/auth/passkey/verify', { response: h.passkey.get(opts) });
    expect(again.statusCode).toBe(401);
  });

  it('a challenge expires after 5 minutes', async () => {
    const opts = (await laptop.post('/api/auth/passkey/options')).json<RequestOptions>();
    h.clock.advance(5 * MIN + 1);
    const res = await laptop.post('/api/auth/passkey/verify', { response: h.passkey.get(opts) });
    expect(res.statusCode).toBe(401);
  });

  it('rate-limits rapid passkey attempts from one IP', async () => {
    const stranger = new VirtualAuthenticator(h.passkey.origin, h.passkey.rpId);
    const attacker = h.browser('192.0.2.66');
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1)
      codes.push((await h.signInWithPasskey(attacker, stranger)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toContain(429);
  });

  it('locks out an IP after 20 failed passkey attempts in an hour, but not other IPs', async () => {
    const stranger = new VirtualAuthenticator(h.passkey.origin, h.passkey.rpId);
    const attacker = h.browser('192.0.2.66');
    // 19 earlier failures from this IP (spread over the hour, below the rate limit).
    for (let i = 0; i < 19; i += 1) {
      h.services.lockouts.fail('passkey:ip:192.0.2.66', POLICIES.passkeyIp);
    }
    expect((await h.signInWithPasskey(attacker, stranger)).statusCode).toBe(401); // 20th
    const blocked = await attacker.post('/api/auth/passkey/options');
    expect(blocked.statusCode).toBe(423);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(3000);
    expect(h.services.audit.page(5).entries.map((e) => e.action)).toContain('auth.lockout');
    // You, from your own network, are unaffected.
    expect((await h.signInWithPasskey(laptop)).statusCode).toBe(200);
  });
});

describe('sessions', () => {
  it('expire after 30 minutes without activity', async () => {
    h.clock.advance(29 * MIN);
    expect((await laptop.post('/api/auth/activity')).statusCode).toBe(200);
    h.clock.advance(29 * MIN);
    expect((await laptop.get('/api/security')).statusCode).toBe(200); // passive: doesn't extend
    h.clock.advance(2 * MIN);
    const res = await laptop.get('/api/security');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('session_expired');
    // And stays dead.
    h.clock.advance(-10 * MIN);
    expect((await laptop.get('/api/security')).statusCode).toBe(401);
  });

  it('end after 12 hours even with constant activity', async () => {
    for (let i = 0; i < 12 * 4; i += 1) {
      h.clock.advance(15 * MIN);
      const res = await laptop.post('/api/auth/activity');
      if (i < 12 * 4 - 1) expect(res.statusCode).toBe(200);
      else expect(res.json().error.code).toBe('session_expired');
    }
  });

  it('respects a shorter idle timeout from settings', async () => {
    h.services.settings.update({ idleTimeoutMinutes: 5 });
    h.clock.advance(6 * MIN);
    expect((await laptop.get('/api/security')).statusCode).toBe(401);
  });

  it('logout ends the session on the server, so a copied cookie is useless', async () => {
    const stolen = new Map(laptop.cookies);
    await laptop.post('/api/auth/logout');
    const thief = h.browser('192.0.2.66');
    for (const [k, v] of stolen) thief.cookies.set(k, v);
    expect((await thief.get('/api/security')).statusCode).toBe(401);
  });

  it('revocation takes effect on the very next request', async () => {
    const state = (await laptop.get('/api/auth/state')).json();
    h.services.sessions.end(state.session.id, 'revoked');
    expect((await laptop.get('/api/security')).statusCode).toBe(401);
  });

  it('a late save cannot bring a revoked session back', async () => {
    const state = (await laptop.get('/api/auth/state')).json();
    const id: string = state.session.id;
    h.services.sessions.end(id, 'revoked');
    // Simulate an in-flight request saving the session after revocation.
    await new Promise<void>((resolve, reject) => {
      h.services.sessionStore.set(
        'whatever-sid',
        {
          cookie: { originalMaxAge: null },
          rowId: id,
          deviceId: state.session.deviceId,
          createdAtMs: h.clock.now(),
          expiresAtMs: h.clock.now() + 1000 * MIN,
        },
        (err) => {
          if (err) reject(err instanceof Error ? err : new Error('session store failed'));
          else resolve();
        },
      );
    });
    const row = h.services.db.select().from(sessionTable).where(eq(sessionTable.id, id)).get();
    expect(row?.revokedAt).not.toBeNull();
  });

  it('a session only works together with its own device cookie', async () => {
    const other = h.browser('198.51.100.7');
    const { ticket } = (await h.signInWithPasskey(other)).json();
    await other.post('/api/auth/new-device/totp', { ticket, code: h.totp(), deviceName: 'Phone' });
    // Mix the laptop's session cookie with the phone's device cookie.
    const mixed = h.browser('198.51.100.7');
    for (const [k, v] of laptop.cookies) if (k.includes('sid')) mixed.cookies.set(k, v);
    for (const [k, v] of other.cookies) if (k.includes('dev')) mixed.cookies.set(k, v);
    expect((await mixed.get('/api/security')).statusCode).toBe(401);
    // …and that attempt ended the laptop's session too.
    expect((await laptop.get('/api/security')).statusCode).toBe(401);
  });

  it('rotates the session id at sign-in (no session fixation)', async () => {
    const before = [...laptop.cookies].find(([k]) => k.includes('sid'))?.[1];
    await h.signInWithPasskey(laptop);
    const after = [...laptop.cookies].find(([k]) => k.includes('sid'))?.[1];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

describe('fresh authentication for sensitive actions', () => {
  it('requires a passkey tap within the last 5 minutes', async () => {
    h.clock.advance(6 * MIN);
    await laptop.post('/api/auth/activity');
    const stale = await laptop.post('/api/security/passkeys/options');
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('fresh_auth_required');
    expect((await h.reauth(laptop)).statusCode).toBe(200);
    expect((await laptop.post('/api/security/passkeys/options')).statusCode).toBe(200);
  });

  it('also accepts an authenticator code, once, for computers without a passkey', async () => {
    h.clock.advance(6 * MIN);
    await laptop.post('/api/auth/activity');
    expect((await laptop.post('/api/security/passkeys/options')).statusCode).toBe(403);
    const wrong = await laptop.post('/api/auth/reauth/code', { code: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect((await laptop.post('/api/security/passkeys/options')).statusCode).toBe(403);
    const code = h.totp();
    const ok = await laptop.post('/api/auth/reauth/code', { code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().freshAuthUntil).not.toBeNull();
    expect((await laptop.post('/api/security/passkeys/options')).statusCode).toBe(200);
    // A code works only once.
    h.clock.advance(6 * MIN);
    expect((await laptop.post('/api/auth/reauth/code', { code })).statusCode).toBe(401);
    // Signed-out browsers can't use it.
    const stranger = h.browser('198.51.100.40');
    expect((await stranger.post('/api/auth/reauth/code', { code: h.totp() })).statusCode).toBe(401);
  });

  it('adds a second passkey and refuses to remove the last one', async () => {
    const key2 = new VirtualAuthenticator(h.passkey.origin, h.passkey.rpId);
    const opts = (await laptop.post('/api/security/passkeys/options')).json();
    const added = await laptop.post('/api/security/passkeys', {
      response: key2.create(opts),
      name: 'YubiKey',
    });
    expect(added.statusCode).toBe(200);
    const list = (await laptop.get('/api/security')).json().passkeys as {
      id: string;
      name: string;
    }[];
    expect(list.map((p) => p.name)).toContain('YubiKey');
    const first = list.find((p) => p.name !== 'YubiKey')!;
    expect(
      (await laptop.request({ method: 'DELETE', url: `/api/security/passkeys/${first.id}` }))
        .statusCode,
    ).toBe(200);
    const last = await laptop.request({
      method: 'DELETE',
      url: `/api/security/passkeys/${added.json().id}`,
    });
    expect(last.statusCode).toBe(409);
    // The removed passkey no longer signs in; the new one does.
    await laptop.post('/api/auth/logout');
    expect((await h.signInWithPasskey(laptop)).statusCode).toBe(401);
    expect((await h.signInWithPasskey(laptop, key2)).statusCode).toBe(200);
  });
});

describe('recovery', () => {
  it('signs in with authenticator code + recovery code, and each code works once', async () => {
    const newLaptop = h.browser('198.51.100.9');
    const res = await newLaptop.post('/api/auth/recovery', {
      code: h.totp(),
      recoveryCode: recoveryCodes[0]!.toLowerCase(),
      deviceName: 'New laptop',
    });
    expect(res.statusCode).toBe(200);
    expect((await newLaptop.get('/api/security')).json().recoveryCodesRemaining).toBe(9);
    h.clock.advance(30_000);
    const again = h.browser('198.51.100.10');
    const reuse = await again.post('/api/auth/recovery', {
      code: h.totp(),
      recoveryCode: recoveryCodes[0],
      deviceName: 'Other',
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('a wrong authenticator code does not use up the recovery code', async () => {
    const b = h.browser('198.51.100.9');
    const bad = await b.post('/api/auth/recovery', {
      code: '000000',
      recoveryCode: recoveryCodes[1],
      deviceName: 'X',
    });
    expect(bad.statusCode).toBe(401);
    const good = await b.post('/api/auth/recovery', {
      code: h.totp(),
      recoveryCode: recoveryCodes[1],
      deviceName: 'X',
    });
    expect(good.statusCode).toBe(200);
  });

  it('locks recovery for an hour after 3 wrong attempts', async () => {
    const b = h.browser('192.0.2.66');
    for (let i = 0; i < 3; i += 1) {
      await b.post('/api/auth/recovery', {
        code: '123456',
        recoveryCode: 'AAAA-BBBB-CCCC',
        deviceName: 'X',
      });
    }
    const locked = await b.post('/api/auth/recovery', {
      code: h.totp(),
      recoveryCode: recoveryCodes[2],
      deviceName: 'X',
    });
    expect(locked.statusCode).toBe(423);
    h.clock.advance(61 * MIN);
    const ok = await b.post('/api/auth/recovery', {
      code: h.totp(),
      recoveryCode: recoveryCodes[2],
      deviceName: 'X',
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('password + authenticator code sign-in', () => {
  const PASSWORD = 'correct horse battery staple';

  async function setPassword(password = PASSWORD) {
    return laptop.request({ method: 'PUT', url: '/api/security/password', payload: { password } });
  }

  it('is off until a password is set, and then signs in a new computer', async () => {
    const other = h.browser('198.51.100.20', 'Mozilla/5.0 (Windows) Edge/140');
    const off = await other.post('/api/auth/password', {
      password: PASSWORD,
      code: h.totp(),
      deviceName: 'Office PC',
    });
    expect(off.statusCode).toBe(401);
    expect((await laptop.get('/api/security')).json().passwordEnabled).toBe(false);

    expect((await setPassword()).statusCode).toBe(200);
    expect((await laptop.get('/api/security')).json().passwordEnabled).toBe(true);
    h.clock.advance(30_000);
    const res = await other.post('/api/auth/password', {
      password: PASSWORD,
      code: h.totp(),
      deviceName: 'Office PC',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.deviceName).toBe('Office PC');
    expect((await other.get('/api/security')).statusCode).toBe(200);
    const actions = h.services.audit.page(10).entries.map((e) => e.action);
    expect(actions).toContain('password.set');
    expect(actions).toContain('auth.device_approved');
  });

  it('needs both parts, and a wrong password does not use up the code', async () => {
    await setPassword();
    h.clock.advance(30_000);
    const code = h.totp();
    const wrongPw = await h.browser('198.51.100.21').post('/api/auth/password', {
      password: 'not the password at all',
      code,
      deviceName: 'X',
    });
    expect(wrongPw.statusCode).toBe(401);
    const wrongCode = await h.browser('198.51.100.22').post('/api/auth/password', {
      password: PASSWORD,
      code: '000000',
      deviceName: 'X',
    });
    expect(wrongCode.statusCode).toBe(401);
    // Same message either way.
    expect(wrongCode.json().error.message).toBe(wrongPw.json().error.message);
    const ok = await h.browser('198.51.100.23').post('/api/auth/password', {
      password: PASSWORD,
      code,
      deviceName: 'X',
    });
    expect(ok.statusCode).toBe(200);
    // And that code can't be replayed.
    const replay = await h.browser('198.51.100.24').post('/api/auth/password', {
      password: PASSWORD,
      code,
      deviceName: 'Y',
    });
    expect(replay.statusCode).toBe(401);
  });

  it('pauses after 5 wrong passwords, while passkeys keep working', async () => {
    await setPassword();
    for (let i = 0; i < 5; i += 1) {
      await h.browser(`192.0.2.${String(10 + i)}`).post('/api/auth/password', {
        password: `guess number ${String(i)}`,
        code: '123456',
        deviceName: 'X',
      });
    }
    h.clock.advance(30_000);
    const locked = await h.browser('198.51.100.30').post('/api/auth/password', {
      password: PASSWORD,
      code: h.totp(),
      deviceName: 'X',
    });
    expect(locked.statusCode).toBe(423);
    await laptop.post('/api/auth/logout');
    expect((await h.signInWithPasskey(laptop)).statusCode).toBe(200);
    h.clock.advance(16 * MIN);
    const ok = await h.browser('198.51.100.31').post('/api/auth/password', {
      password: PASSWORD,
      code: h.totp(),
      deviceName: 'X',
    });
    expect(ok.statusCode).toBe(200);
  });

  it('setting or removing the password needs a fresh passkey check and a strong password', async () => {
    expect((await setPassword('short')).statusCode).toBe(400);
    h.clock.advance(6 * MIN);
    await laptop.post('/api/auth/activity');
    const stale = await setPassword();
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('fresh_auth_required');
    await h.reauth(laptop);
    expect((await setPassword()).statusCode).toBe(200);
    const removed = await laptop.request({ method: 'DELETE', url: '/api/security/password' });
    expect(removed.statusCode).toBe(200);
    expect((await laptop.get('/api/security')).json().passwordEnabled).toBe(false);
    h.clock.advance(30_000);
    const res = await h.browser('198.51.100.40').post('/api/auth/password', {
      password: PASSWORD,
      code: h.totp(),
      deviceName: 'X',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('audit trail', () => {
  it('records sign-ins and keeps an intact hash chain', async () => {
    await laptop.post('/api/auth/logout');
    await h.signInWithPasskey(laptop);
    const actions = h.services.audit.page(20).entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['setup.completed', 'auth.logout', 'auth.login']),
    );
    const verify = (await laptop.get('/api/audit/verify')).json();
    expect(verify.ok).toBe(true);
  });
});
