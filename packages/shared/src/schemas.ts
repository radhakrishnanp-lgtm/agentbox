import { z } from 'zod';
import { LIMITS } from './limits.ts';

const base64url = (max: number = LIMITS.webauthnFieldMax) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/** A 256-bit random token encoded as base64url (setup links, login tickets). */
export const tokenSchema = z
  .string()
  .length(LIMITS.tokenLength)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Human-chosen names: printable text, no control characters, trimmed. */
export const displayNameSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Enter a name')
    .max(max, `Use at most ${max} characters`)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Use visible characters only');

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

/** Recovery codes look like ABCD-EFGH-JKLM (Crockford base32, dashes optional). */
export const recoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{12}$/, 'Check the recovery code and try again'));

const transports = z
  .array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']))
  .max(8);

const clientExtensionResults = z.record(z.string(), z.unknown()).default({});

/** Shape of navigator.credentials.create() output as JSON (validated again by SimpleWebAuthn). */
export const registrationResponseSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults,
  response: z.object({
    clientDataJSON: base64url(),
    attestationObject: base64url(),
    transports: transports.optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url().optional(),
    authenticatorData: base64url().optional(),
  }),
});

/** Shape of navigator.credentials.get() output as JSON. */
export const authenticationResponseSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults,
  response: z.object({
    clientDataJSON: base64url(),
    authenticatorData: base64url(),
    signature: base64url(),
    userHandle: base64url(1024).optional(),
  }),
});

export const setupTokenRequestSchema = z.object({ token: tokenSchema });

export const setupPasskeyRequestSchema = z.object({
  token: tokenSchema,
  response: registrationResponseSchema,
});

export const setupTotpConfirmSchema = z.object({ token: tokenSchema, code: totpCodeSchema });

export const setupCompleteSchema = z.object({
  token: tokenSchema,
  deviceName: displayNameSchema(LIMITS.deviceNameMax),
});

export const passkeyVerifySchema = z.object({ response: authenticationResponseSchema });

export const newDeviceTotpSchema = z.object({
  ticket: tokenSchema,
  code: totpCodeSchema,
  deviceName: displayNameSchema(LIMITS.deviceNameMax),
});

export const recoverySignInSchema = z.object({
  code: totpCodeSchema,
  recoveryCode: recoveryCodeSchema,
  deviceName: displayNameSchema(LIMITS.deviceNameMax),
});

/**
 * The optional sign-in password, used together with an authenticator code on
 * computers that have no passkey. Long enough that guessing online is hopeless.
 */
export const SIGNIN_PASSWORD_MIN = 12;
export const signInPasswordSchema = z
  .string()
  .min(SIGNIN_PASSWORD_MIN, `Use at least ${SIGNIN_PASSWORD_MIN} characters`)
  .max(256, 'Use at most 256 characters');

export const setSignInPasswordSchema = z.object({ password: signInPasswordSchema });

export const passwordSignInSchema = z.object({
  // Not the full rules: a wrong password must fail like any other, not as a 400.
  password: z.string().min(1).max(256),
  code: totpCodeSchema,
  deviceName: displayNameSchema(LIMITS.deviceNameMax),
});

export const auditQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.auditPageMax).default(50),
});

export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;
export type AuthenticationResponse = z.infer<typeof authenticationResponseSchema>;
