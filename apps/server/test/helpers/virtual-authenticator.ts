/**
 * A software passkey for tests: produces real, signed WebAuthn responses
 * (ES256, "none" attestation, user verified) that SimpleWebAuthn verifies
 * exactly like a phone or security key's.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}

export interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export class VirtualAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #counter = 0;
  #userHandle: string | undefined;
  /** Set false to simulate an authenticator that skipped the biometric/PIN check. */
  userVerified = true;
  synced = true;

  readonly origin: string;
  readonly rpId: string;

  constructor(origin: string, rpId: string) {
    this.origin = origin;
    this.rpId = rpId;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  #flags(extra = 0): number {
    let f = FLAG_UP | extra;
    if (this.userVerified) f |= FLAG_UV;
    if (this.synced) f |= FLAG_BE | FLAG_BS;
    return f;
  }

  #coseKey(): Uint8Array {
    const jwk = this.#publicKey.export({ format: 'jwk' });
    return encodeCBOR(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  #counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.#counter);
    return b;
  }

  create(options: CreationOptions, overrides: { origin?: string } = {}) {
    this.#userHandle = options.user.id;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(options.rp.id ?? this.rpId),
      Buffer.from([this.#flags(FLAG_AT)]),
      this.#counterBytes(),
      Buffer.alloc(16), // AAGUID (none)
      credIdLen,
      this.credentialId,
      Buffer.from(this.#coseKey()),
    ]);
    const attestationObject = encodeCBOR(
      new Map<string, string | Map<string, never> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, never>()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(attestationObject),
        transports: ['internal' as const, 'hybrid' as const],
      },
    };
  }

  get(options: RequestOptions, overrides: { origin?: string; rpId?: string } = {}) {
    this.#counter += 1;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const authData = Buffer.concat([
      sha256(overrides.rpId ?? options.rpId ?? this.rpId),
      Buffer.from([this.#flags()]),
      this.#counterBytes(),
    ]);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.#privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.#userHandle ? { userHandle: this.#userHandle } : {}),
      },
    };
  }
}
