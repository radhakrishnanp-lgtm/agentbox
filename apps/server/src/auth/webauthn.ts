/**
 * Passkeys via @simplewebauthn/server. Policy: user verification (Face ID,
 * fingerprint or PIN) is always required, so one passkey tap = two factors.
 * Challenges are stored server-side and can each be consumed exactly once.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { AuthenticationResponse, RegistrationResponse } from '@agentbox/shared';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { passkey, webauthnChallenge } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import { MINUTE } from '../lib/clock.ts';
import { invalidCredential } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';

type Purpose = 'setup' | 'login' | 'reauth' | 'add_passkey';

const CHALLENGE_TTL = 5 * MINUTE;
const CEREMONY_TIMEOUT_MS = 2 * 60_000;
// Ed25519, ES256, RS256: covers every current platform and security key.
const ALGORITHMS = [-8, -7, -257];

export interface VerifiedPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  aaguid: string;
}

export class WebAuthnService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #config: Config;

  constructor(db: Db, clock: Clock, config: Config) {
    this.#db = db;
    this.#clock = clock;
    this.#config = config;
  }

  #storeChallenge(challenge: string, purpose: Purpose, boundTo: string | null): void {
    const now = this.#clock.now();
    // Opportunistic cleanup keeps the table tiny.
    this.#db.delete(webauthnChallenge).where(lt(webauthnChallenge.expiresAt, now)).run();
    this.#db
      .insert(webauthnChallenge)
      .values({
        id: newId(),
        challenge,
        purpose,
        boundTo,
        expiresAt: now + CHALLENGE_TTL,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  /** Atomically marks the challenge used; false if unknown, expired, reused or mis-bound. */
  #consumeChallenge(challenge: string, purpose: Purpose, boundTo: string | null): boolean {
    const now = this.#clock.now();
    const result = this.#db
      .update(webauthnChallenge)
      .set({ usedAt: now, updatedAt: now })
      .where(
        and(
          eq(webauthnChallenge.challenge, challenge),
          eq(webauthnChallenge.purpose, purpose),
          boundTo === null
            ? isNull(webauthnChallenge.boundTo)
            : eq(webauthnChallenge.boundTo, boundTo),
          isNull(webauthnChallenge.usedAt),
          gt(webauthnChallenge.expiresAt, now),
        ),
      )
      .run();
    return result.changes === 1;
  }

  async registrationOptions(opts: {
    purpose: 'setup' | 'add_passkey';
    boundTo: string;
    userId: Uint8Array;
    userName: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = this.#db
      .select({ id: passkey.credentialId, transports: passkey.transports })
      .from(passkey)
      .where(isNull(passkey.revokedAt))
      .all();
    const options = await generateRegistrationOptions({
      rpName: this.#config.rpName,
      rpID: this.#config.rpId,
      userName: opts.userName,
      userDisplayName: opts.userName,
      userID: new Uint8Array(opts.userId),
      timeout: CEREMONY_TIMEOUT_MS,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    this.#storeChallenge(options.challenge, opts.purpose, opts.boundTo);
    return options;
  }

  async verifyRegistration(
    response: RegistrationResponse,
    purpose: 'setup' | 'add_passkey',
    boundTo: string,
  ): Promise<VerifiedPasskey> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: (c) => this.#consumeChallenge(c, purpose, boundTo),
        expectedOrigin: this.#config.origin,
        expectedRPID: this.#config.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch {
      throw invalidCredential();
    }
    if (!result.verified) throw invalidCredential();
    const info = result.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
    };
  }

  async authenticationOptions(
    purpose: 'login' | 'reauth',
    boundTo: string | null,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const allow =
      purpose === 'reauth'
        ? this.#db
            .select({ id: passkey.credentialId, transports: passkey.transports })
            .from(passkey)
            .where(isNull(passkey.revokedAt))
            .all()
        : [];
    const options = await generateAuthenticationOptions({
      rpID: this.#config.rpId,
      timeout: CEREMONY_TIMEOUT_MS,
      userVerification: 'required',
      // Login uses discoverable credentials (no username); re-auth lists ours.
      allowCredentials: allow.map((c) => ({ id: c.id, transports: c.transports })),
    });
    this.#storeChallenge(options.challenge, purpose, boundTo);
    return options;
  }

  /** Verifies an assertion and updates the stored counter. Returns the passkey row id. */
  async verifyAuthentication(
    response: AuthenticationResponse,
    purpose: 'login' | 'reauth',
    boundTo: string | null,
  ): Promise<string> {
    const stored = this.#db
      .select()
      .from(passkey)
      .where(and(eq(passkey.credentialId, response.id), isNull(passkey.revokedAt)))
      .get();
    if (!stored) throw invalidCredential();
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: (c) => this.#consumeChallenge(c, purpose, boundTo),
        expectedOrigin: this.#config.origin,
        expectedRPID: this.#config.rpId,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      throw invalidCredential();
    }
    if (!result.verified) throw invalidCredential();
    const now = this.#clock.now();
    this.#db
      .update(passkey)
      .set({
        counter: result.authenticationInfo.newCounter,
        backedUp: result.authenticationInfo.credentialBackedUp,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(passkey.id, stored.id))
      .run();
    return stored.id;
  }
}
