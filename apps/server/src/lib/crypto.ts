/**
 * Thin, tested wrappers over Node's built-in crypto (OpenSSL). Nothing here
 * invents a primitive: random tokens, SHA-256, scrypt and AES-256-GCM only.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** 256-bit random token as base64url (43 characters). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** For high-entropy secrets (random tokens), a plain SHA-256 is a safe lookup hash. */
export function hashToken(token: string): string {
  return sha256Hex(`agentbox-token:${token}`);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// scrypt parameters: N=2^15, r=8, p=1 (~32 MiB, tens of ms) per OWASP guidance.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const SCRYPT_KEYLEN = 32;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hash for low-entropy secrets that a human types (recovery codes). */
export async function scryptHash(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, SCRYPT_KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function scryptVerify(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(secret, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Authenticated encryption for secrets at rest (the TOTP seed).
 * Format: enc1.<keyId>.<iv>.<ciphertext>.<tag>, all base64url.
 * `context` is bound as AAD, so a ciphertext copied into another column fails to decrypt.
 */
export class SecretBox {
  readonly #keys: Map<string, Buffer>;
  readonly #currentId: string;

  constructor(currentKey: Buffer, previousKeys: Buffer[] = []) {
    for (const key of [currentKey, ...previousKeys]) {
      if (key.length !== 32) throw new Error('Encryption keys must be exactly 32 bytes');
    }
    this.#currentId = SecretBox.keyId(currentKey);
    this.#keys = new Map([currentKey, ...previousKeys].map((k) => [SecretBox.keyId(k), k]));
  }

  static keyId(key: Buffer): string {
    return sha256Hex(Buffer.concat([Buffer.from('agentbox-key-id:'), key])).slice(0, 8);
  }

  encrypt(plaintext: string, context: string): string {
    const key = this.#keys.get(this.#currentId);
    if (!key) throw new Error('Current key missing');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['enc1', this.#currentId, iv, ct, tag]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string, context: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== 'enc1') throw new Error('Unrecognised ciphertext');
    const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
    const key = this.#keys.get(keyId);
    if (!key) throw new Error('Ciphertext was encrypted with an unknown key');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** A keyed hash (HMAC-SHA256) of `data`: equal inputs match, but it reveals nothing without the key. */
  mac(data: string, context: string): string {
    const key = this.#keys.get(this.#currentId);
    if (!key) throw new Error('Current key missing');
    return createHmac('sha256', key)
      .update(`${context}\0`)
      .update(data, 'utf8')
      .digest('base64url');
  }

  /** True when a value was encrypted with an older key and should be re-encrypted. */
  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.#currentId;
  }
}

/** Deterministic JSON with sorted keys, used for audit hashing. */
export function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
