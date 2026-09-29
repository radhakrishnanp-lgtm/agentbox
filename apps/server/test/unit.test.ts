import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { recoveryCodeSchema } from '@agentbox/shared';
import { AuditLog, GENESIS_HASH } from '../src/audit/audit.ts';
import { generateRecoveryCode, normaliseRecoveryCode } from '../src/auth/recovery-codes.ts';
import { matchTotpStep, newTotpSecret, totpCodeAt } from '../src/auth/totp.ts';
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/db/client.ts';
import { SecretBox, scryptHash, scryptVerify, stableStringify } from '../src/lib/crypto.ts';
import { Lockouts, type LockoutPolicy } from '../src/security/lockout.ts';
import { TestClock } from './helpers/harness.ts';

const key = () => randomBytes(32);

describe('SecretBox (AES-256-GCM at rest)', () => {
  it('round-trips and never repeats ciphertext', () => {
    const box = new SecretBox(key());
    const a = box.encrypt('JBSWY3DPEHPK3PXP', 'owner.totp_secret');
    const b = box.encrypt('JBSWY3DPEHPK3PXP', 'owner.totp_secret');
    expect(a).not.toBe(b);
    expect(box.decrypt(a, 'owner.totp_secret')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('fails when moved to another context, tampered with, or opened with another key', () => {
    const box = new SecretBox(key());
    const ct = box.encrypt('secret', 'ctx-a');
    expect(() => box.decrypt(ct, 'ctx-b')).toThrow();
    const parts = ct.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0]! ^= 1;
    parts[3] = flipped.toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'ctx-a')).toThrow();
    expect(() => new SecretBox(key()).decrypt(ct, 'ctx-a')).toThrow(/unknown key/);
  });

  it('supports key rotation', () => {
    const oldKey = key();
    const ct = new SecretBox(oldKey).encrypt('secret', 'c');
    const rotated = new SecretBox(key(), [oldKey]);
    expect(rotated.needsRotation(ct)).toBe(true);
    expect(rotated.decrypt(ct, 'c')).toBe('secret');
    expect(rotated.needsRotation(rotated.encrypt('secret', 'c'))).toBe(false);
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow();
  });
});

describe('scrypt hashes', () => {
  it('verifies the right secret only', async () => {
    const h = await scryptHash('ABCDEFGHJKMN');
    expect(await scryptVerify('ABCDEFGHJKMN', h)).toBe(true);
    expect(await scryptVerify('ABCDEFGHJKMP', h)).toBe(false);
    expect(await scryptVerify('x', 'garbage')).toBe(false);
  });
});

describe('stableStringify', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
});

describe('TOTP', () => {
  it('accepts the current code and ±1 step for clock drift, not more', () => {
    const secret = newTotpSecret();
    const t = Date.UTC(2026, 0, 1);
    const step = Math.floor(t / 30_000);
    expect(matchTotpStep(secret, totpCodeAt(secret, t), t)).toBe(step);
    expect(matchTotpStep(secret, totpCodeAt(secret, t - 30_000), t)).toBe(step - 1);
    expect(matchTotpStep(secret, totpCodeAt(secret, t + 30_000), t)).toBe(step + 1);
    expect(matchTotpStep(secret, totpCodeAt(secret, t - 90_000), t)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('have 60 bits in an unambiguous alphabet and normalise user input', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(code.replace(/-/g, ''));
    expect(recoveryCodeSchema.parse(` ${code.toLowerCase()} `)).toBe(code.replace(/-/g, ''));
    expect(recoveryCodeSchema.safeParse('ILOU-ILOU-ILOU').success).toBe(false);
  });
});

describe('audit log', () => {
  it('chains hashes and detects edited history', () => {
    const db = openDb(':memory:');
    const log = new AuditLog(db, new TestClock());
    log.record({ actor: 'cli', action: 'setup.link_created' });
    log.record({
      actor: 'device:1',
      action: 'auth.login',
      ip: '1.2.3.4',
      details: { method: 'passkey' },
    });
    log.record({ actor: 'device:1', action: 'auth.logout' });
    expect(log.verify()).toEqual({ ok: true, checked: 3, brokenAt: null });
    const rows = db.$client.prepare('SELECT prev_hash FROM audit_log ORDER BY seq').all() as {
      prev_hash: string;
    }[];
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);

    // The database refuses edits and deletions…
    expect(() =>
      db.$client.prepare("UPDATE audit_log SET ip = '9.9.9.9' WHERE seq = 2").run(),
    ).toThrow(/append-only/);
    expect(() => db.$client.prepare('DELETE FROM audit_log WHERE seq = 2').run()).toThrow(
      /append-only/,
    );

    // …and if someone with file access removes the triggers, the chain exposes it.
    db.$client.exec('DROP TRIGGER audit_log_no_update');
    db.$client.prepare("UPDATE audit_log SET ip = '9.9.9.9' WHERE seq = 2").run();
    expect(log.verify()).toEqual({ ok: false, checked: 1, brokenAt: 2 });
  });

  it('pages newest first with a cursor', () => {
    const db = openDb(':memory:');
    const log = new AuditLog(db, new TestClock());
    for (let i = 0; i < 5; i += 1) log.record({ actor: 'x', action: 'auth.login' });
    const p1 = log.page(2);
    expect(p1.entries.map((e) => e.seq)).toEqual([5, 4]);
    const p2 = log.page(2, p1.nextBefore!);
    expect(p2.entries.map((e) => e.seq)).toEqual([3, 2]);
    const p3 = log.page(2, p2.nextBefore!);
    expect(p3.entries.map((e) => e.seq)).toEqual([1]);
    expect(p3.nextBefore).toBeNull();
  });
});

describe('lockouts', () => {
  const policy: LockoutPolicy = {
    maxFailures: 3,
    windowMs: 60_000,
    baseLockMs: 10_000,
    maxLockMs: 25_000,
    message: 'locked',
  };

  it('locks after N failures, doubles on repeat, caps, and resets on success', () => {
    const clock = new TestClock();
    const l = new Lockouts(openDb(':memory:'), clock);
    const fail3 = () => [1, 2, 3].map(() => l.fail('k', policy)).pop();
    expect(fail3()).toBe(true);
    expect(() => {
      l.assertOpen('k', policy);
    }).toThrow('locked');
    clock.advance(10_001);
    l.assertOpen('k', policy);
    fail3();
    clock.advance(10_001);
    expect(() => {
      l.assertOpen('k', policy);
    }).toThrow(); // 20 s the second time
    clock.advance(10_000);
    fail3();
    clock.advance(25_001);
    l.assertOpen('k', policy); // capped at 25 s
    l.succeed('k');
    l.fail('k', policy);
    l.assertOpen('k', policy);
  });

  it('forgets failures outside the window', () => {
    const clock = new TestClock();
    const l = new Lockouts(openDb(':memory:'), clock);
    l.fail('k', policy);
    l.fail('k', policy);
    clock.advance(61_000);
    expect(l.fail('k', policy)).toBe(false);
  });
});

describe('environment validation', () => {
  const base = {
    AGENTBOX_ORIGIN: 'https://agent.example.com',
    AGENTBOX_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AGENTBOX_SESSION_SECRET: 'x'.repeat(40),
  };

  it('defaults to the Unix socket and the origin hostname as passkey scope', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(c.listen).toEqual({ kind: 'unix', path: '/run/agentbox/web.sock' });
    expect(c.rpId).toBe('agent.example.com');
    expect(c.secureCookies).toBe(true);
  });

  it('refuses unsafe settings with readable messages', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AGENTBOX_ORIGIN: 'http://agent.example.com' }),
    ).toThrow(/https:\/\/ in production/);
    expect(() => loadConfig({ ...base, AGENTBOX_LISTEN: '0.0.0.0:8080' })).toThrow(
      /never a public address/,
    );
    expect(() => loadConfig({ ...base, AGENTBOX_ENCRYPTION_KEY: 'short' })).toThrow(
      /32 random bytes/,
    );
    expect(() => loadConfig({ ...base, AGENTBOX_SESSION_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, AGENTBOX_RP_ID: 'evil.example' })).toThrow(/AGENTBOX_RP_ID/);
    expect(() => loadConfig({})).toThrow(/AGENTBOX_ORIGIN/);
  });

  it('allows a private bridge address behind a trusted reverse proxy, never a public one', () => {
    const c = loadConfig({
      ...base,
      AGENTBOX_LISTEN: '172.18.0.1:8787',
      AGENTBOX_TRUSTED_PROXIES: '172.18.0.0/16, 10.0.0.5',
    });
    expect(c.listen).toEqual({ kind: 'tcp', host: '172.18.0.1', port: 8787 });
    expect(c.trustedProxies).toEqual(['172.18.0.0/16', '10.0.0.5']);
    expect(loadConfig({ ...base, AGENTBOX_LISTEN: '192.168.1.2:8787' }).trustedProxies).toBe(
      undefined,
    );
    for (const host of ['8.8.8.8', '172.32.0.1', '0.0.0.0', '192.169.1.1', '10.0.0']) {
      expect(() => loadConfig({ ...base, AGENTBOX_LISTEN: `${host}:8787` })).toThrow(
        /never a public address/,
      );
    }
    expect(() =>
      loadConfig({ ...base, AGENTBOX_LISTEN: '127.0.0.1:8787', AGENTBOX_TRUSTED_PROXIES: 'nope' }),
    ).toThrow();
    expect(() => loadConfig({ ...base, AGENTBOX_TRUSTED_PROXIES: '127.0.0.1' })).toThrow();
  });
});
