/**
 * Failure counting and lockouts, persisted so a restart doesn't reset them.
 * Keys are per factor ("totp", "recovery") or per IP ("passkey:ip:1.2.3.4").
 * Each repeated lockout doubles the lock time, up to a ceiling.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { lockout } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError } from '../lib/errors.ts';

export interface LockoutPolicy {
  /** Failures allowed inside the window before locking. */
  maxFailures: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
  /** Shown to the user when locked. */
  message: string;
}

export class Lockouts {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Throws `locked` (HTTP 423) with retryAfter when the key is locked. */
  assertOpen(key: string, policy: LockoutPolicy): void {
    const row = this.#db.select().from(lockout).where(eq(lockout.key, key)).get();
    const now = this.#clock.now();
    if (row?.lockedUntil && row.lockedUntil > now) {
      throw new AppError('locked', policy.message, {
        retryAfter: Math.ceil((row.lockedUntil - now) / 1000),
      });
    }
  }

  /** Records a failure. Returns true when this failure triggered a new lock. */
  fail(key: string, policy: LockoutPolicy): boolean {
    const now = this.#clock.now();
    return this.#db.transaction((tx) => {
      const row = tx.select().from(lockout).where(eq(lockout.key, key)).get();
      const inWindow = row && now - row.windowStart < policy.windowMs;
      const failures = inWindow ? row.failures + 1 : 1;
      const windowStart = inWindow ? row.windowStart : now;
      let strikes = row?.strikes ?? 0;
      let lockedUntil = row?.lockedUntil ?? null;
      let newlyLocked = false;
      if (failures >= policy.maxFailures) {
        const lockMs = Math.min(policy.baseLockMs * 2 ** strikes, policy.maxLockMs);
        lockedUntil = now + lockMs;
        strikes += 1;
        newlyLocked = true;
      }
      const values = {
        key,
        failures: newlyLocked ? 0 : failures,
        windowStart: newlyLocked ? now : windowStart,
        lockedUntil,
        strikes,
        updatedAt: now,
      };
      tx.insert(lockout)
        .values(values)
        .onConflictDoUpdate({ target: lockout.key, set: values })
        .run();
      return newlyLocked;
    });
  }

  /** A success clears the failure count (but keeps strikes, so repeat offenders stay slow). */
  succeed(key: string): void {
    this.#db
      .update(lockout)
      .set({ failures: 0, lockedUntil: null, updatedAt: this.#clock.now() })
      .where(eq(lockout.key, key))
      .run();
  }
}

const MIN = 60_000;

export const POLICIES = {
  /** 5 wrong TOTP codes → 15 min, doubling to 24 h. Passkeys keep working meanwhile. */
  totp: {
    maxFailures: 5,
    windowMs: 15 * MIN,
    baseLockMs: 15 * MIN,
    maxLockMs: 24 * 60 * MIN,
    message: 'Too many wrong codes. Authenticator sign-in is paused; use your passkey or wait.',
  },
  /** 3 wrong recovery attempts in an hour → 1 h, doubling to 24 h. */
  recovery: {
    maxFailures: 3,
    windowMs: 60 * MIN,
    baseLockMs: 60 * MIN,
    maxLockMs: 24 * 60 * MIN,
    message: 'Too many wrong recovery attempts. Recovery sign-in is paused.',
  },
  /** 20 failed passkey attempts per IP per hour → that IP waits 1 h. */
  passkeyIp: {
    maxFailures: 20,
    windowMs: 60 * MIN,
    baseLockMs: 60 * MIN,
    maxLockMs: 24 * 60 * MIN,
    message: 'Too many failed sign-in attempts from this network. Try again later.',
  },
} satisfies Record<string, LockoutPolicy>;
