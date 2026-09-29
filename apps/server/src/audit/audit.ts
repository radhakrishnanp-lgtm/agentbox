/**
 * Append-only, hash-chained audit trail. Each entry's hash covers the previous
 * entry's hash, so editing or deleting any past entry breaks every later hash.
 * The database also blocks UPDATE/DELETE with triggers, and each entry is
 * mirrored to the service log (journald), which the app cannot rewrite.
 */
import { desc, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditEntry, AuditPage, AuditVerifyResult } from '@agentbox/shared';
import type { Db } from '../db/client.ts';
import { auditLog } from '../db/schema.ts';
import { sha256Hex, stableStringify } from '../lib/crypto.ts';
import type { Clock } from '../lib/clock.ts';
import { iso } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';

export const GENESIS_HASH = '0'.repeat(64);

export type AuditAction =
  | 'setup.link_created'
  | 'setup.reset'
  | 'setup.completed'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.device_approval_required'
  | 'auth.device_approved'
  | 'auth.recovery_used'
  | 'auth.logout'
  | 'auth.reauth'
  | 'auth.lockout'
  | 'session.expired'
  | 'passkey.added'
  | 'passkey.removed'
  | 'ai_key.added'
  | 'ai_key.removed'
  | 'machine.added'
  | 'machine.updated'
  | 'machine.revoked'
  | 'machine.revoked_all'
  | 'machine.first_used'
  | 'machine.ip_changed'
  | 'machine.blocked_ip'
  | 'machine.limit_hit'
  | 'machine.bad_pass_lockout';

export interface AuditInput {
  actor: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string;
  /** Never put secrets here: this is shown in the UI and exported. */
  details?: Record<string, unknown>;
}

interface Row {
  seq: number;
  id: string;
  ts: number;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: string;
  prevHash: string;
  hash: string;
}

function entryHash(prevHash: string, r: Omit<Row, 'hash' | 'prevHash'>): string {
  const body = stableStringify([
    r.seq,
    r.id,
    r.ts,
    r.actor,
    r.action,
    r.targetType,
    r.targetId,
    r.ip,
    JSON.parse(r.details) as unknown,
  ]);
  return sha256Hex(`${prevHash}\n${body}`);
}

export class AuditLog {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #log: FastifyBaseLogger | undefined;

  constructor(db: Db, clock: Clock, log?: FastifyBaseLogger) {
    this.#db = db;
    this.#clock = clock;
    this.#log = log;
  }

  record(input: AuditInput): AuditEntry {
    const row = this.#db.transaction((tx) => {
      const last = tx
        .select({ seq: auditLog.seq, hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1)
        .get();
      const base = {
        seq: (last?.seq ?? 0) + 1,
        id: newId(),
        ts: this.#clock.now(),
        actor: input.actor,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        details: stableStringify(input.details ?? {}),
      };
      const prevHash = last?.hash ?? GENESIS_HASH;
      const full: Row = { ...base, prevHash, hash: entryHash(prevHash, base) };
      tx.insert(auditLog).values(full).run();
      return full;
    });
    const entry = toEntry(row);
    this.#log?.info({ audit: entry }, `audit ${entry.action}`);
    return entry;
  }

  page(limit: number, before?: number): AuditPage {
    const q = this.#db.select().from(auditLog);
    const rows = (before ? q.where(lt(auditLog.seq, before)) : q)
      .orderBy(desc(auditLog.seq))
      .limit(limit + 1)
      .all();
    const entries = rows.slice(0, limit).map(toEntry);
    return {
      entries,
      nextBefore: rows.length > limit ? (entries[entries.length - 1]?.seq ?? null) : null,
    };
  }

  /** Re-computes the whole chain. Cheap for years of single-user history. */
  verify(): AuditVerifyResult {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    for (const r of this.#db.select().from(auditLog).orderBy(auditLog.seq).all()) {
      const { hash, prevHash: storedPrev, ...rest } = r;
      if (r.seq !== expectedSeq || storedPrev !== prevHash || entryHash(prevHash, rest) !== hash) {
        return { ok: false, checked, brokenAt: r.seq };
      }
      prevHash = hash;
      expectedSeq += 1;
      checked += 1;
    }
    return { ok: true, checked, brokenAt: null };
  }
}

function toEntry(r: Row): AuditEntry {
  return {
    seq: r.seq,
    ts: iso(r.ts),
    actor: r.actor,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    ip: r.ip,
    details: JSON.parse(r.details) as Record<string, unknown>,
  };
}
