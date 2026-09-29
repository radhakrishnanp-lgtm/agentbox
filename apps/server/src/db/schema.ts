/**
 * Database schema. Times are UTC epoch milliseconds. Ids are UUIDv7 unless noted.
 * Secrets are never stored in plain text: tokens are stored as SHA-256 hashes,
 * recovery codes as scrypt hashes, and the TOTP seed AES-256-GCM encrypted.
 */
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
};

/** The single human who owns this agentbox. */
export const owner = sqliteTable(
  'owner',
  {
    id: integer('id').primaryKey(),
    displayName: text('display_name').notNull(),
    /** Random 32-byte WebAuthn user handle (never shown). */
    webauthnUserId: blob('webauthn_user_id', { mode: 'buffer' }).notNull(),
    totpSecretEnc: text('totp_secret_enc').notNull(),
    /** Last accepted TOTP time-step; codes at or before it are replays. */
    totpLastStep: integer('totp_last_step').notNull().default(0),
    ...timestamps,
  },
  (t) => [check('owner_single_row', sql`${t.id} = 1`)],
);

export const passkey = sqliteTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id').notNull(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull(),
    deviceType: text('device_type', { enum: ['singleDevice', 'multiDevice'] }).notNull(),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
    aaguid: text('aaguid').notNull(),
    name: text('name').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('passkey_credential_id').on(t.credentialId)],
);

export const recoveryCode = sqliteTable('recovery_code', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull(),
  usedAt: integer('used_at'),
  ...timestamps,
});

/** A browser that has been recognised. Only approved, unrevoked devices may hold sessions. */
export const device = sqliteTable(
  'device',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent').notNull(),
    firstIp: text('first_ip').notNull(),
    lastIp: text('last_ip').notNull(),
    approvedAt: integer('approved_at'),
    /** 'setup', 'totp', 'recovery', or the id of the device that approved it. */
    approvedBy: text('approved_by'),
    lastSeenAt: integer('last_seen_at').notNull(),
    revokedAt: integer('revoked_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('device_token_hash').on(t.tokenHash),
    index('device_revoked').on(t.revokedAt),
  ],
);

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    sidHash: text('sid_hash').notNull(),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    ip: text('ip').notNull(),
    userAgent: text('user_agent').notNull(),
    cookieJson: text('cookie_json').notNull(),
    lastActiveAt: integer('last_active_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    freshAuthAt: integer('fresh_auth_at'),
    revokedAt: integer('revoked_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('session_sid_hash').on(t.sidHash),
    index('session_device').on(t.deviceId),
    index('session_expires').on(t.expiresAt),
  ],
);

/** One-time setup links created over SSH with `agentbox setup-link`. */
export const setupToken = sqliteTable(
  'setup_token',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    /** Verified passkey waiting for the wizard to finish (JSON, public data only). */
    pendingPasskey: text('pending_passkey', { mode: 'json' }).$type<PendingPasskey>(),
    pendingTotpEnc: text('pending_totp_enc'),
    totpConfirmedStep: integer('totp_confirmed_step'),
    ...timestamps,
  },
  (t) => [uniqueIndex('setup_token_hash').on(t.tokenHash)],
);

export interface PendingPasskey {
  /** Chosen when the wizard first asks for passkey options (base64url). */
  webauthnUserId: string;
  /** Set once the browser's new passkey has been verified. */
  credential?: {
    credentialId: string;
    publicKey: string; // base64url
    counter: number;
    transports: string[];
    deviceType: 'singleDevice' | 'multiDevice';
    backedUp: boolean;
    aaguid: string;
  };
}

/** Issued WebAuthn challenges; each can be consumed once, before it expires. */
export const webauthnChallenge = sqliteTable(
  'webauthn_challenge',
  {
    id: text('id').primaryKey(),
    challenge: text('challenge').notNull(),
    purpose: text('purpose', { enum: ['setup', 'login', 'reauth', 'add_passkey'] }).notNull(),
    /** Setup token id or session id the challenge is bound to (null for login). */
    boundTo: text('bound_to'),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('webauthn_challenge_value').on(t.challenge)],
);

/** Short-lived proof that a passkey was valid on a device that still needs approval. */
export const loginTicket = sqliteTable(
  'login_ticket',
  {
    id: text('id').primaryKey(),
    ticketHash: text('ticket_hash').notNull(),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    passkeyId: text('passkey_id')
      .notNull()
      .references(() => passkey.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('login_ticket_hash').on(t.ticketHash)],
);

/** Append-only, hash-chained audit trail. UPDATE and DELETE are blocked by triggers. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    seq: integer('seq').primaryKey(),
    id: text('id').notNull(),
    ts: integer('ts').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    details: text('details').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_action').on(t.action), index('audit_ts').on(t.ts)],
);

/** Failure counters for lockouts (per factor and per IP). */
export const lockout = sqliteTable('lockout', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull(),
  windowStart: integer('window_start').notNull(),
  lockedUntil: integer('locked_until'),
  /** How many times this key has been locked; drives the doubling lock time. */
  strikes: integer('strikes').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});
