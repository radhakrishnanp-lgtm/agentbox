/** Limits shared by the server (enforcement) and the UI (instant feedback). */
export const LIMITS = {
  deviceNameMax: 40,
  passkeyNameMax: 40,
  recoveryCodeCount: 10,
  /** Base64url of 32 random bytes. */
  tokenLength: 43,
  auditPageMax: 100,
  /** WebAuthn JSON payloads are small; anything larger is rejected before parsing. */
  webauthnFieldMax: 16_384,
} as const;

/** Session policy defaults; the server reads the effective values from settings. */
export const SESSION_DEFAULTS = {
  idleTimeoutMinutes: 30,
  maxLifetimeHours: 12,
  freshAuthMinutes: 5,
  idleWarningSeconds: 120,
} as const;
