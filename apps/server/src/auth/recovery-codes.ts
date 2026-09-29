/**
 * One-time recovery codes: 12 Crockford base32 characters (60 bits), shown
 * once as XXXX-XXXX-XXXX and stored only as scrypt hashes.
 */
import { randomInt } from 'node:crypto';
import { isNull } from 'drizzle-orm';
import { LIMITS } from '@agentbox/shared';
import type { Db } from '../db/client.ts';
import { recoveryCode } from '../db/schema.ts';
import { scryptHash, scryptVerify } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 12; i += 1) raw += ALPHABET.charAt(randomInt(ALPHABET.length));
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Canonical form used for hashing: upper case, no dashes or spaces. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

export async function createRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: LIMITS.recoveryCodeCount }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => scryptHash(normaliseRecoveryCode(c))));
  return { codes, hashes };
}

export function recoveryCodeRows(hashes: string[], now: number) {
  return hashes.map((codeHash) => ({ id: newId(), codeHash, createdAt: now, updatedAt: now }));
}

/** Returns the id of the matching unused code, checking every code (no early exit). */
export async function findRecoveryCode(db: Db, input: string): Promise<string | null> {
  const candidates = db.select().from(recoveryCode).where(isNull(recoveryCode.usedAt)).all();
  const normalised = normaliseRecoveryCode(input);
  const results = await Promise.all(candidates.map((c) => scryptVerify(normalised, c.codeHash)));
  const index = results.findIndex(Boolean);
  return index === -1 ? null : (candidates[index]?.id ?? null);
}
