/** TOTP (RFC 6238) using the otpauth library, with replay protection. */
import { Secret, TOTP } from 'otpauth';

export const TOTP_PERIOD = 30;
const DIGITS = 6;
const ALGORITHM = 'SHA1'; // What every authenticator app supports.

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, issuer: string, label: string): string {
  return new TOTP({
    issuer,
    label,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secretBase32),
  }).toString();
}

/**
 * Checks a code against the current time step ±1 (clock drift tolerance).
 * Returns the matched time step, or null. The caller must reject a step that
 * is not newer than the last accepted one, so a code can't be used twice.
 */
export function matchTotpStep(secretBase32: string, code: string, nowMs: number): number | null {
  const delta = TOTP.validate({
    token: code,
    secret: Secret.fromBase32(secretBase32),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: TOTP_PERIOD,
    timestamp: nowMs,
    window: 1,
  });
  if (delta === null) return null;
  return TOTP.counter({ period: TOTP_PERIOD, timestamp: nowMs }) + delta;
}

/** Used by tests and the setup wizard's self-check. */
export function totpCodeAt(secretBase32: string, nowMs: number): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secretBase32),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: TOTP_PERIOD,
    timestamp: nowMs,
  });
}
