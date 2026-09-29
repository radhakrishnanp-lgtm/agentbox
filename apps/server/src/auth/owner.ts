/** The owner's second factors: TOTP (with replay protection) and recovery codes. */
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { owner, recoveryCode } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { findRecoveryCode } from './recovery-codes.ts';
import { matchTotpStep } from './totp.ts';

export const OWNER_TOTP_CONTEXT = 'owner.totp_secret';

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
