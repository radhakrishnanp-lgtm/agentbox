/**
 * Sessions: @fastify/session manages the cookie and session id; this module
 * stores sessions in SQLite (by SHA-256 of the id) and enforces the policy:
 * idle timeout, absolute lifetime, approved-device binding, instant revocation.
 */
import type { SessionStore } from '@fastify/session';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, Session } from 'fastify';
import type { SessionInfo } from '@agentbox/shared';
import type { SettingsStore } from '../config/settings.ts';
import type { Db } from '../db/client.ts';
import { device, session as sessionTable } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import { HOUR, MINUTE, iso } from '../lib/clock.ts';
import { hashToken, randomToken } from '../lib/crypto.ts';
import { AppError, unauthorized } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { AuditLog } from '../audit/audit.ts';
import type { Devices } from './devices.ts';

declare module 'fastify' {
  interface Session {
    rowId?: string;
    deviceId?: string;
    createdAtMs?: number;
    lastActiveAtMs?: number;
    expiresAtMs?: number;
    freshAuthAtMs?: number | null;
    ip?: string;
    userAgent?: string;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AuthContext {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  freshAuthAtMs: number | null;
}

export const FRESH_AUTH_MS = 5 * MINUTE;

/** @fastify/session types the session as always present, but it is null after destroy(). */
export function sessionOf(request: FastifyRequest): Session | null {
  const value: unknown = request.session;
  return value ? (value as Session) : null;
}
const UA_MAX = 300;

type SessionRow = typeof sessionTable.$inferSelect;

/** SQLite-backed store for @fastify/session. Anonymous sessions are never stored. */
export class SqliteSessionStore implements SessionStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  get(sessionId: string, callback: (err: unknown, result?: Session | null) => void): void {
    try {
      const row = this.#db
        .select()
        .from(sessionTable)
        .where(and(eq(sessionTable.sidHash, hashToken(sessionId)), isNull(sessionTable.revokedAt)))
        .get();
      callback(null, row ? toSession(row) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    try {
      if (!session.rowId || !session.deviceId || !session.createdAtMs || !session.expiresAtMs) {
        callback(); // not signed in: nothing to persist
        return;
      }
      const now = this.#clock.now();
      // A revoked row is never brought back by a late save from an in-flight request.
      this.#db.$client
        .prepare(
          `INSERT INTO session (id, sid_hash, device_id, ip, user_agent, cookie_json,
             last_active_at, expires_at, fresh_auth_at, revoked_at, created_at, updated_at)
           VALUES (@id, @sidHash, @deviceId, @ip, @userAgent, @cookieJson,
             @lastActiveAt, @expiresAt, @freshAuthAt, NULL, @createdAt, @updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             sid_hash = excluded.sid_hash,
             cookie_json = excluded.cookie_json,
             fresh_auth_at = excluded.fresh_auth_at,
             updated_at = excluded.updated_at
           WHERE session.revoked_at IS NULL`,
        )
        .run({
          id: session.rowId,
          sidHash: hashToken(sessionId),
          deviceId: session.deviceId,
          ip: session.ip ?? '',
          userAgent: session.userAgent ?? '',
          cookieJson: JSON.stringify(session.cookie),
          lastActiveAt: session.lastActiveAtMs ?? now,
          expiresAt: session.expiresAtMs,
          freshAuthAt: session.freshAuthAtMs ?? null,
          createdAt: session.createdAtMs,
          updatedAt: now,
        });
      callback();
    } catch (err) {
      callback(err);
    }
  }

  /** Forgets a session id (logout or id rotation). The row itself is ended by `Sessions.end`. */
  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    try {
      this.#db
        .update(sessionTable)
        .set({ sidHash: `retired:${randomToken(16)}`, updatedAt: this.#clock.now() })
        .where(eq(sessionTable.sidHash, hashToken(sessionId)))
        .run();
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

function toSession(row: SessionRow): Session {
  return {
    cookie: JSON.parse(row.cookieJson) as Session['cookie'],
    rowId: row.id,
    deviceId: row.deviceId,
    createdAtMs: row.createdAt,
    lastActiveAtMs: row.lastActiveAt,
    expiresAtMs: row.expiresAt,
    freshAuthAtMs: row.freshAuthAt,
    ip: row.ip,
    userAgent: row.userAgent,
  };
}

export type EndReason = 'logout' | 'idle' | 'lifetime' | 'device' | 'revoked' | 'replaced';

export class Sessions {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #settings: SettingsStore;
  readonly #devices: Devices;
  readonly #audit: AuditLog;
  /** Called when a session ends, so live terminals for it can be closed at once. */
  readonly #onEnd = new Set<(sessionId: string) => void>();

  constructor(db: Db, clock: Clock, settings: SettingsStore, devices: Devices, audit: AuditLog) {
    this.#db = db;
    this.#clock = clock;
    this.#settings = settings;
    this.#devices = devices;
    this.#audit = audit;
  }

  onEnd(listener: (sessionId: string) => void): () => void {
    this.#onEnd.add(listener);
    return () => this.#onEnd.delete(listener);
  }

  /** Starts a fresh session for an approved device, rotating the session id. */
  async start(request: FastifyRequest, deviceId: string): Promise<SessionInfo> {
    const previous = sessionOf(request)?.rowId;
    if (previous) this.end(previous, 'replaced', request.ip);
    await request.session.regenerate();
    const now = this.#clock.now();
    const { maxLifetimeHours } = this.#settings.get();
    const lifetime = maxLifetimeHours * HOUR;
    const s = request.session;
    s.options({ maxAge: lifetime });
    s.set('rowId', newId());
    s.set('deviceId', deviceId);
    s.set('createdAtMs', now);
    s.set('lastActiveAtMs', now);
    s.set('expiresAtMs', now + lifetime);
    s.set('freshAuthAtMs', now); // signing in with a passkey counts as a fresh check
    s.set('ip', request.ip);
    s.set('userAgent', (request.headers['user-agent'] ?? 'unknown').slice(0, UA_MAX));
    await s.save();
    this.#devices.touch(deviceId, request.ip);
    const info = s.rowId ? this.info(s.rowId) : null;
    if (!info) throw new AppError('internal', 'Session could not be created.');
    return info;
  }

  /** Marks a successful passkey re-check and rotates the session id. */
  async markFresh(request: FastifyRequest): Promise<SessionInfo> {
    const keep = [
      'rowId',
      'deviceId',
      'createdAtMs',
      'lastActiveAtMs',
      'expiresAtMs',
      'ip',
      'userAgent',
    ];
    await request.session.regenerate(keep);
    request.session.set('freshAuthAtMs', this.#clock.now());
    await request.session.save();
    const rowId = request.session.rowId;
    const info = rowId ? this.info(rowId) : null;
    if (!info) throw unauthorized();
    return info;
  }

  /**
   * Validates the session for a protected route. Expired sessions are ended.
   * `activity` = the request came from the owner acting (resets the idle timer).
   */
  authenticate(request: FastifyRequest, activity: boolean): AuthContext {
    const rowId = sessionOf(request)?.rowId;
    if (!rowId) throw unauthorized();
    const row = this.#db.select().from(sessionTable).where(eq(sessionTable.id, rowId)).get();
    if (!row || row.revokedAt !== null) throw unauthorized();
    const now = this.#clock.now();
    const { idleTimeoutMinutes } = this.#settings.get();
    if (now >= row.expiresAt) {
      this.end(rowId, 'lifetime', request.ip);
      throw new AppError(
        'session_expired',
        'Your session reached its time limit. Please sign in again.',
      );
    }
    if (now - row.lastActiveAt >= idleTimeoutMinutes * MINUTE) {
      this.end(rowId, 'idle', request.ip);
      throw new AppError('session_expired', 'You were signed out after a period of inactivity.');
    }
    // The session must belong to this browser's approved device.
    const dev = this.#devices.current(request);
    if (!dev || dev.id !== row.deviceId || !this.#devices.isApproved(dev)) {
      this.end(rowId, 'device', request.ip);
      throw unauthorized();
    }
    if (activity) {
      this.#db
        .update(sessionTable)
        .set({ lastActiveAt: now, ip: request.ip })
        .where(eq(sessionTable.id, rowId))
        .run();
      this.#devices.touch(dev.id, request.ip);
    }
    return {
      sessionId: rowId,
      deviceId: dev.id,
      deviceName: dev.name ?? 'This device',
      freshAuthAtMs: row.freshAuthAt,
    };
  }

  /**
   * For long-lived connections (terminals): is the session still good? Ends it
   * if it ran out, exactly like `authenticate` would on the next request.
   */
  check(sessionId: string): boolean {
    const row = this.#db
      .select({ s: sessionTable, approvedAt: device.approvedAt, deviceRevokedAt: device.revokedAt })
      .from(sessionTable)
      .innerJoin(device, eq(device.id, sessionTable.deviceId))
      .where(eq(sessionTable.id, sessionId))
      .get();
    if (!row || row.s.revokedAt !== null) return false;
    const now = this.#clock.now();
    if (now >= row.s.expiresAt) {
      this.end(sessionId, 'lifetime');
      return false;
    }
    if (now - row.s.lastActiveAt >= this.#settings.get().idleTimeoutMinutes * MINUTE) {
      this.end(sessionId, 'idle');
      return false;
    }
    if (row.approvedAt === null || row.deviceRevokedAt !== null) {
      this.end(sessionId, 'device');
      return false;
    }
    return true;
  }

  /** Typing in a terminal counts as activity for the idle timeout. */
  touch(sessionId: string): void {
    this.#db
      .update(sessionTable)
      .set({ lastActiveAt: this.#clock.now() })
      .where(and(eq(sessionTable.id, sessionId), isNull(sessionTable.revokedAt)))
      .run();
  }

  /** Ends a session immediately. Safe to call more than once. */
  end(sessionId: string, reason: EndReason, ip?: string): void {
    const now = this.#clock.now();
    const res = this.#db
      .update(sessionTable)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(sessionTable.id, sessionId), isNull(sessionTable.revokedAt)))
      .run();
    if (res.changes === 0) return;
    if (reason === 'idle' || reason === 'lifetime') {
      this.#audit.record({
        actor: 'system',
        action: 'session.expired',
        targetType: 'session',
        targetId: sessionId,
        details: { reason },
        ...(ip ? { ip } : {}),
      });
    }
    for (const listener of this.#onEnd) listener(sessionId);
  }

  async logout(request: FastifyRequest, reply: FastifyReply, cookieName: string): Promise<void> {
    const current = sessionOf(request);
    if (current?.rowId) this.end(current.rowId, 'logout', request.ip);
    if (current) await request.session.destroy();
    reply.clearCookie(cookieName, { path: '/' });
  }

  isFresh(auth: AuthContext): boolean {
    return auth.freshAuthAtMs !== null && this.#clock.now() - auth.freshAuthAtMs < FRESH_AUTH_MS;
  }

  info(sessionId: string): SessionInfo | null {
    const row = this.#db
      .select({ s: sessionTable, deviceName: device.name })
      .from(sessionTable)
      .innerJoin(device, eq(device.id, sessionTable.deviceId))
      .where(eq(sessionTable.id, sessionId))
      .get();
    if (!row || row.s.revokedAt !== null) return null;
    const idleMs = this.#settings.get().idleTimeoutMinutes * MINUTE;
    const fresh = row.s.freshAuthAt;
    return {
      id: row.s.id,
      deviceId: row.s.deviceId,
      deviceName: row.deviceName ?? 'This device',
      createdAt: iso(row.s.createdAt),
      expiresAt: iso(row.s.expiresAt),
      idleExpiresAt: iso(Math.min(row.s.lastActiveAt + idleMs, row.s.expiresAt)),
      idleTimeoutSeconds: idleMs / 1000,
      freshAuthUntil: fresh !== null ? iso(fresh + FRESH_AUTH_MS) : null,
    };
  }
}
