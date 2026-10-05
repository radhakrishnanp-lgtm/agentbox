/**
 * The agent tracker's switch and its saved entries. Off unless you turn it on;
 * entries stay until you delete them (the oldest go beyond TRACE_LIMITS.maxEntries).
 */
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  TRACE_LIMITS,
  type TraceEntry,
  type TracePage,
  type TraceStep,
  type TraceSummary,
  type TrackerStatus,
} from '@agentbox/shared';
import type { AuditLog } from '../audit/audit.ts';
import type { Db } from '../db/client.ts';
import { agentTrace, setting } from '../db/schema.ts';
import { iso, type Clock } from '../lib/clock.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';

const SETTING_KEY = 'agentTracker';
const CONTEXT = 'agent_trace.events';

type Row = typeof agentTrace.$inferSelect;

export interface TraceInput {
  ts: number;
  machineId: string;
  machineName: string;
  keySlug: string;
  cli: string | null;
  model: string | null;
  status: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  steps: TraceStep[];
}

export class Tracker {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #box: SecretBox;
  readonly #audit: AuditLog;
  #enabled: boolean | undefined;
  #saved = 0;

  constructor(db: Db, clock: Clock, box: SecretBox, audit: AuditLog) {
    this.#db = db;
    this.#clock = clock;
    this.#box = box;
    this.#audit = audit;
  }

  /** Read on every relayed request, so it is cached in memory. */
  enabled(): boolean {
    if (this.#enabled === undefined) {
      const row = this.#db.select().from(setting).where(eq(setting.key, SETTING_KEY)).get();
      this.#enabled = row?.value === true;
    }
    return this.#enabled;
  }

  setEnabled(on: boolean, actor: string, ip: string): TrackerStatus {
    const now = this.#clock.now();
    this.#db
      .insert(setting)
      .values({ key: SETTING_KEY, value: on, updatedAt: now })
      .onConflictDoUpdate({ target: setting.key, set: { value: on, updatedAt: now } })
      .run();
    this.#enabled = on;
    this.#audit.record({ actor, action: on ? 'tracker.enabled' : 'tracker.disabled', ip });
    return this.status();
  }

  status(): TrackerStatus {
    const r = this.#db
      .select({ n: sql<number>`count(*)` })
      .from(agentTrace)
      .get();
    return { enabled: this.enabled(), entries: r?.n ?? 0, maxEntries: TRACE_LIMITS.maxEntries };
  }

  save(input: TraceInput): void {
    const steps = input.steps.slice(0, TRACE_LIMITS.stepsMax);
    if (steps.length === 0) return;
    const counts: Record<string, number> = {};
    for (const s of steps) counts[s.type] = (counts[s.type] ?? 0) + 1;
    const id = newId();
    this.#db
      .insert(agentTrace)
      .values({
        id,
        ts: input.ts,
        machineId: input.machineId,
        machineName: input.machineName,
        keySlug: input.keySlug,
        cli: input.cli,
        model: input.model,
        status: input.status,
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        counts,
        eventsEnc: this.#box.encrypt(JSON.stringify(steps), `${CONTEXT}:${id}`),
      })
      .run();
    // Trim now and then rather than on every save.
    if (++this.#saved % 100 === 1) this.trim();
  }

  /** Keeps at most TRACE_LIMITS.maxEntries, dropping the oldest. */
  trim(): number {
    const cutoff = this.#db
      .select({ ts: agentTrace.ts })
      .from(agentTrace)
      .orderBy(desc(agentTrace.ts))
      .limit(1)
      .offset(TRACE_LIMITS.maxEntries)
      .get();
    if (!cutoff) return 0;
    return this.#db
      .delete(agentTrace)
      .where(sql`${agentTrace.ts} <= ${cutoff.ts}`)
      .run().changes;
  }

  #steps(r: Row): TraceStep[] {
    try {
      return JSON.parse(this.#box.decrypt(r.eventsEnc, `${CONTEXT}:${r.id}`)) as TraceStep[];
    } catch {
      return [{ type: 'answer', text: '[this entry can no longer be read]' }];
    }
  }

  #summary(r: Row, steps: TraceStep[]): TraceSummary {
    const first = steps.find((s) => s.type === 'prompt') ?? steps[0];
    const preview = first
      ? `${first.name ? `${first.name}: ` : ''}${first.text}`.replace(/\s+/g, ' ').slice(0, 200)
      : '';
    return {
      id: r.id,
      ts: iso(r.ts),
      machineId: r.machineId,
      machineName: r.machineName,
      keySlug: r.keySlug,
      cli: r.cli,
      model: r.model,
      status: r.status,
      durationMs: r.durationMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      counts: r.counts,
      preview,
      note: r.note,
    };
  }

  list(opts: {
    limit: number;
    before?: string | undefined;
    machineId?: string | undefined;
  }): TracePage {
    const filters = [];
    if (opts.machineId) filters.push(eq(agentTrace.machineId, opts.machineId));
    const cursor = /^(\d{1,15})\.([A-Za-z0-9-]{1,64})$/.exec(opts.before ?? '');
    if (cursor) {
      const ts = Number(cursor[1]);
      filters.push(
        or(lt(agentTrace.ts, ts), and(eq(agentTrace.ts, ts), lt(agentTrace.id, cursor[2] ?? ''))),
      );
    }
    const rows = this.#db
      .select()
      .from(agentTrace)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(agentTrace.ts), desc(agentTrace.id))
      .limit(opts.limit + 1)
      .all();
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      entries: page.map((r) => this.#summary(r, this.#steps(r))),
      nextBefore: rows.length > opts.limit && last ? `${String(last.ts)}.${last.id}` : null,
    };
  }

  get(id: string): TraceEntry | null {
    const r = this.#db.select().from(agentTrace).where(eq(agentTrace.id, id)).get();
    if (!r) return null;
    const steps = this.#steps(r);
    return { ...this.#summary(r, steps), steps };
  }

  setNote(id: string, note: string): TraceEntry | null {
    this.#db
      .update(agentTrace)
      .set({ note: note.trim().slice(0, TRACE_LIMITS.noteMax) })
      .where(eq(agentTrace.id, id))
      .run();
    return this.get(id);
  }

  /** Deletes the given entries, or every entry when `ids` is "all". */
  delete(ids: string[] | 'all', actor: string, ip: string): number {
    const n =
      ids === 'all'
        ? this.#db.delete(agentTrace).run().changes
        : ids.length === 0
          ? 0
          : this.#db.delete(agentTrace).where(inArray(agentTrace.id, ids)).run().changes;
    if (n > 0)
      this.#audit.record({
        actor,
        action: 'tracker.deleted',
        ip,
        details: { count: n, all: ids === 'all' },
      });
    return n;
  }

  /** CSV with one row per step, oldest entry first. */
  exportCsv(ids: string[] | 'all', actor: string, ip: string): { csv: string; entries: number } {
    const rows =
      ids === 'all'
        ? this.#db.select().from(agentTrace).orderBy(agentTrace.ts, agentTrace.id).all()
        : ids.length === 0
          ? []
          : this.#db
              .select()
              .from(agentTrace)
              .where(inArray(agentTrace.id, ids))
              .orderBy(agentTrace.ts, agentTrace.id)
              .all();
    const head = [
      'time',
      'entry',
      'computer',
      'key',
      'cli',
      'model',
      'status',
      'input_tokens',
      'output_tokens',
      'note',
      'step',
      'type',
      'name',
      'content',
    ];
    const lines = [head.join(',')];
    for (const r of rows) {
      this.#steps(r).forEach((s, i) => {
        lines.push(
          [
            iso(r.ts),
            r.id,
            r.machineName,
            r.keySlug,
            r.cli,
            r.model,
            r.status,
            r.inputTokens,
            r.outputTokens,
            r.note,
            i + 1,
            s.type,
            s.name ?? '',
            s.text,
          ]
            .map(csvCell)
            .join(','),
        );
      });
    }
    this.#audit.record({
      actor,
      action: 'tracker.exported',
      ip,
      details: { count: rows.length, all: ids === 'all' },
    });
    // A byte order mark, so Excel reads it as UTF-8.
    return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, entries: rows.length };
  }
}

/** A CSV cell. Cells a spreadsheet would run as a formula start with a quote mark. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
