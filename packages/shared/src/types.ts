/** Every error response has this shape; `requestId` matches the server log line. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    /** Seconds until a rate limit or lockout ends, when relevant. */
    retryAfter?: number;
  };
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'session_expired'
  | 'fresh_auth_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'locked'
  | 'setup_complete'
  | 'invalid_credential'
  | 'unavailable'
  | 'internal';

export interface SessionInfo {
  id: string;
  deviceId: string;
  deviceName: string;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  idleExpiresAt: string;
  idleTimeoutSeconds: number;
  freshAuthUntil: string | null;
}

export interface AuthState {
  setupRequired: boolean;
  session: SessionInfo | null;
}

export type SignInResult =
  | { status: 'signed_in'; session: SessionInfo }
  /** Passkey was valid but this browser is not an approved device yet. */
  | { status: 'device_approval_required'; ticket: string; expiresAt: string };

export interface PasskeySummary {
  id: string;
  name: string;
  /** "multiDevice" means synced (iCloud Keychain, Google Password Manager…). */
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SecurityOverview {
  passkeys: PasskeySummary[];
  totpEnabled: boolean;
  /** Password + authenticator code sign-in is set up. */
  passwordEnabled: boolean;
  recoveryCodesRemaining: number;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextBefore: number | null;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  /** First sequence number whose hash does not match, if any. */
  brokenAt: number | null;
}

export interface SetupTotpInit {
  otpauthUri: string;
  /** The same secret in base32, for typing in by hand. */
  secret: string;
}

export interface SetupCompleteResult {
  recoveryCodes: string[];
  session: SessionInfo;
}
