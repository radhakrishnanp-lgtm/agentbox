/**
 * The owner's other factors: TOTP (with replay protection), recovery codes and
 * the optional sign-in password (only ever accepted together with a TOTP code).
 */
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { owner, recoveryCode } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import { scryptHash, scryptVerify, type SecretBox } from '../lib/crypto.ts';
import { findRecoveryCode } from './recovery-codes.ts';
import { matchTotpStep } from './totp.ts';

export const OWNER_TOTP_CONTEXT = 'owner.totp_secret';

/** Compared against when no password is set, so timing doesn't reveal whether one is. */
let dummyHash: Promise<string> | null = null;

export class OwnerFactors {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #box: SecretBox;

  constructor(db: Db, clock: Clock, box: SecretBox) {
    this.#db = db;
    this.#clock = clock;
    this.#box = box;
  }

  exists(): boolean {
    return !!this.#db.select({ id: owner.id }).from(owner).get();
  }

  /**
   * Accepts a TOTP code once. The accepted time step is stored with a
   * compare-and-set, so two requests racing with the same code can't both win.
   */
  consumeTotp(code: string): boolean {
    const row = this.#db.select().from(owner).get();
    if (!row) return false;
    const secret = this.#box.decrypt(row.totpSecretEnc, OWNER_TOTP_CONTEXT);
    const step = matchTotpStep(secret, code, this.#clock.now());
    if (step === null || step <= row.totpLastStep) return false;
    const res = this.#db
      .update(owner)
      .set({ totpLastStep: step, updatedAt: this.#clock.now() })
      .where(and(eq(owner.id, row.id), lt(owner.totpLastStep, step)))
      .run();
    return res.changes === 1;
  }

  hasPassword(): boolean {
    return !!this.#db.select({ h: owner.passwordHash }).from(owner).get()?.h;
  }

  async setPassword(password: string): Promise<void> {
    const hash = await scryptHash(password);
    this.#db
      .update(owner)
      .set({ passwordHash: hash, updatedAt: this.#clock.now() })
      .where(eq(owner.id, 1))
      .run();
  }

  /** True if a password was set and is now removed. */
  removePassword(): boolean {
    const res = this.#db
      .update(owner)
      .set({ passwordHash: null, updatedAt: this.#clock.now() })
      .where(and(eq(owner.id, 1), isNotNull(owner.passwordHash)))
      .run();
    return res.changes === 1;
  }

  /** Checks the sign-in password. Always does the full scrypt work, set or not. */
  async verifyPassword(password: string): Promise<boolean> {
    const stored = this.#db.select({ h: owner.passwordHash }).from(owner).get()?.h ?? null;
    if (stored === null) {
      dummyHash ??= scryptHash('agentbox: no password is set');
      await scryptVerify(password, await dummyHash);
      return false;
    }
    return scryptVerify(password, stored);
  }

  /** Finds a matching unused recovery code without using it up. */
  async matchRecoveryCode(code: string): Promise<string | null> {
    return findRecoveryCode(this.#db, code);
  }

  /** Marks a recovery code as used. False if it was used concurrently. */
  useRecoveryCode(id: string): boolean {
    const now = this.#clock.now();
    const res = this.#db
      .update(recoveryCode)
      .set({ usedAt: now, updatedAt: now })
      .where(and(eq(recoveryCode.id, id), isNull(recoveryCode.usedAt)))
      .run();
    return res.changes === 1;
  }

  recoveryCodesRemaining(): number {
    return this.#db.select().from(recoveryCode).where(isNull(recoveryCode.usedAt)).all().length;
  }

  /** Re-encrypts the TOTP seed with the current key after a key rotation. */
  rotateEncryption(): boolean {
    const row = this.#db.select().from(owner).get();
    if (!row || !this.#box.needsRotation(row.totpSecretEnc)) return false;
    const secret = this.#box.decrypt(row.totpSecretEnc, OWNER_TOTP_CONTEXT);
    this.#db
      .update(owner)
      .set({
        totpSecretEnc: this.#box.encrypt(secret, OWNER_TOTP_CONTEXT),
        updatedAt: this.#clock.now(),
      })
      .where(eq(owner.id, row.id))
      .run();
    return true;
  }
}
