/**
 * First-run setup. `agentbox setup-link` (run over SSH on the VPS) creates a
 * one-time link valid for 30 minutes. The wizard registers a passkey, confirms
 * an authenticator app, and shows recovery codes. Nothing is committed until
 * the last step, which writes everything in one transaction.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import {
  device,
  loginTicket,
  owner,
  passkey,
  recoveryCode,
  session,
  setupToken,
  webauthnChallenge,
} from '../db/schema.ts';
import type { AuditLog } from '../audit/audit.ts';
import type { Clock } from '../lib/clock.ts';
import { MINUTE } from '../lib/clock.ts';
import { hashToken, randomToken, type SecretBox } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { OWNER_TOTP_CONTEXT } from './owner.ts';
import { recoveryCodeRows } from './recovery-codes.ts';

export const SETUP_LINK_TTL = 30 * MINUTE;

export type SetupRow = typeof setupToken.$inferSelect;
export type SetupStep = 'passkey' | 'totp' | 'finish';

export class SetupService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #config: Config;
  readonly #box: SecretBox;
  readonly #audit: AuditLog;

  constructor(db: Db, clock: Clock, config: Config, box: SecretBox, audit: AuditLog) {
    this.#db = db;
    this.#clock = clock;
    this.#config = config;
    this.#box = box;
    this.#audit = audit;
  }

  isComplete(): boolean {
    return !!this.#db.select({ id: owner.id }).from(owner).get();
  }

  /**
   * Creates a setup link. With `reset`, first removes every sign-in factor,
   * device and session (the audit log is kept), for when you are locked out.
   */
  createLink(opts: { reset: boolean; actor: string }): { url: string; expiresAt: number } {
    const now = this.#clock.now();
    if (this.isComplete() && !opts.reset) {
      throw new AppError(
        'setup_complete',
        'Setup is already complete. Use --reset to wipe all sign-in methods and start again.',
      );
    }
    const token = randomToken();
    this.#db.transaction((tx) => {
      if (opts.reset) {
        tx.delete(loginTicket).run();
        tx.delete(session).run();
        tx.delete(device).run();
        tx.delete(recoveryCode).run();
        tx.delete(passkey).run();
        tx.delete(owner).run();
        tx.delete(webauthnChallenge).run();
      }
      tx.delete(setupToken).run(); // only the newest link works
      tx.insert(setupToken)
        .values({
          id: newId(),
          tokenHash: hashToken(token),
          expiresAt: now + SETUP_LINK_TTL,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    if (opts.reset) this.#audit.record({ actor: opts.actor, action: 'setup.reset' });
    this.#audit.record({ actor: opts.actor, action: 'setup.link_created' });
    // The token goes in the #fragment: browsers never send it to the server in
    // the URL, so it can't leak into proxy logs or Referer headers.
    return { url: `${this.#config.origin}/setup#${token}`, expiresAt: now + SETUP_LINK_TTL };
  }

  /** Looks up a valid, unused, unexpired setup token. */
  resolve(token: string): SetupRow {
    if (this.isComplete()) {
      throw new AppError('setup_complete', 'Setup is already complete. Sign in instead.');
    }
    const row = this.#db
      .select()
      .from(setupToken)
      .where(
        and(
          eq(setupToken.tokenHash, hashToken(token)),
          isNull(setupToken.usedAt),
          gt(setupToken.expiresAt, this.#clock.now()),
        ),
      )
      .get();
    if (!row) {
      throw new AppError(
        'unauthorized',
        'This setup link is invalid or has expired. Run "sudo agentbox setup-link" again.',
      );
    }
    return row;
  }

  step(row: SetupRow): SetupStep {
    if (!row.pendingPasskey?.credential) return 'passkey';
    if (row.totpConfirmedStep === null) return 'totp';
    return 'finish';
  }

  /** The WebAuthn user handle for the owner, created on first use. */
  webauthnUserId(row: SetupRow): Buffer {
    if (row.pendingPasskey) return Buffer.from(row.pendingPasskey.webauthnUserId, 'base64url');
    const id = randomBytes(32);
    this.#db
      .update(setupToken)
      .set({
        pendingPasskey: { webauthnUserId: id.toString('base64url') },
        updatedAt: this.#clock.now(),
      })
      .where(eq(setupToken.id, row.id))
      .run();
    return id;
  }

  savePasskey(
    row: SetupRow,
    credential: NonNullable<NonNullable<SetupRow['pendingPasskey']>['credential']>,
  ): void {
    if (!row.pendingPasskey) throw new AppError('bad_request', 'Start the passkey step again.');
    this.#db
      .update(setupToken)
      .set({
        pendingPasskey: { ...row.pendingPasskey, credential },
        // A new passkey restarts the authenticator step, so both belong together.
        pendingTotpEnc: null,
        totpConfirmedStep: null,
        updatedAt: this.#clock.now(),
      })
      .where(eq(setupToken.id, row.id))
      .run();
  }

  saveTotpSecret(row: SetupRow, secret: string): void {
    this.#db
      .update(setupToken)
      .set({
        pendingTotpEnc: this.#box.encrypt(secret, pendingContext(row.id)),
        totpConfirmedStep: null,
        updatedAt: this.#clock.now(),
      })
      .where(eq(setupToken.id, row.id))
      .run();
  }

  pendingTotpSecret(row: SetupRow): string | null {
    return row.pendingTotpEnc
      ? this.#box.decrypt(row.pendingTotpEnc, pendingContext(row.id))
      : null;
  }

  confirmTotp(row: SetupRow, step: number): void {
    this.#db
      .update(setupToken)
      .set({ totpConfirmedStep: step, updatedAt: this.#clock.now() })
      .where(eq(setupToken.id, row.id))
      .run();
  }

  /**
   * Commits the owner, passkey, TOTP seed, recovery codes and this device in one
   * transaction, and burns the setup token. Returns the approved device id.
   */
  complete(
    row: SetupRow,
    opts: { deviceId: string; deviceName: string; recoveryHashes: string[] },
  ): void {
    const pending = row.pendingPasskey;
    const cred = pending?.credential;
    const secret = this.pendingTotpSecret(row);
    const confirmedStep = row.totpConfirmedStep;
    if (!pending || !cred || !secret || confirmedStep === null) {
      throw new AppError('bad_request', 'Finish the passkey and authenticator steps first.');
    }
    const now = this.#clock.now();
    this.#db.transaction((tx) => {
      const burned = tx
        .update(setupToken)
        .set({ usedAt: now, pendingTotpEnc: null, updatedAt: now })
        .where(and(eq(setupToken.id, row.id), isNull(setupToken.usedAt)))
        .run();
      if (burned.changes !== 1) throw new AppError('conflict', 'This setup link was already used.');
      tx.insert(owner)
        .values({
          id: 1,
          displayName: 'Owner',
          webauthnUserId: Buffer.from(pending.webauthnUserId, 'base64url'),
          totpSecretEnc: this.#box.encrypt(secret, OWNER_TOTP_CONTEXT),
          totpLastStep: confirmedStep,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(passkey)
        .values({
          id: newId(),
          credentialId: cred.credentialId,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter: cred.counter,
          transports: cred.transports,
          deviceType: cred.deviceType,
          backedUp: cred.backedUp,
          aaguid: cred.aaguid,
          name: `Passkey from ${opts.deviceName}`.slice(0, 40),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.delete(recoveryCode).run();
      tx.insert(recoveryCode).values(recoveryCodeRows(opts.recoveryHashes, now)).run();
      tx.update(device)
        .set({ approvedAt: now, approvedBy: 'setup', name: opts.deviceName, updatedAt: now })
        .where(eq(device.id, opts.deviceId))
        .run();
    });
  }
}

function pendingContext(setupId: string): string {
  return `setup_token.${setupId}.totp`;
}
