/**
 * The agent tracker's switch and its saved entries. Off unless you turn it on;
 * entries stay until you delete them (the oldest go beyond TRACE_LIMITS.maxEntries).
 */
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  TRACE_LIMITS,
  type TraceEntry,
  type TraceFilterOptions,
  type TracePage,
  type TraceStep,
  type TraceSummary,
  type TraceTool,
  type TrackerStatus,
} from '@agentbox/shared';
import type { AuditLog } from '../audit/audit.ts';
import type { Db } from '../db/client.ts';
import { agentTrace, agentTraceBlob, setting } from '../db/schema.ts';
import { iso, type Clock } from '../lib/clock.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';

const SETTING_KEY = 'agentTracker';
const OPTIONS_KEY = 'agentTrackerOptions';

/** Narrows the list, and "all" exports and deletes, to one computer, address or model. */
export interface TraceFilter {
  machineId?: string | undefined;
  ip?: string | undefined;
  model?: string | undefined;
}

/** What the tracker saves besides the steps. Both off unless you turn them on. */
export interface TrackerOptions {
  system: boolean;
  tools: boolean;
}
const CONTEXT = 'agent_trace.events';
const BLOB = 'agent_trace.blob';

type Row = typeof agentTrace.$inferSelect;

export interface TraceInput {
  ts: number;
  machineId: string;
  machineName: string;
  ip?: string | null;
  keySlug: string;
  cli: string | null;
  model: string | null;
  status: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  steps: TraceStep[];
  system?: string | null;
  tools?: TraceTool[];
}

export class Tracker {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #box: SecretBox;
  readonly #audit: AuditLog;
  #enabled: boolean | undefined;
  #options: TrackerOptions | undefined;
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

  /** Whether to save system prompts and tool lists too. Read on every saved entry, so cached. */
  options(): TrackerOptions {
    if (this.#options === undefined) {
      const row = this.#db.select().from(setting).where(eq(setting.key, OPTIONS_KEY)).get();
      const v = (row?.value ?? {}) as Partial<TrackerOptions>;
      this.#options = { system: v.system === true, tools: v.tools === true };
    }
    return this.#options;
  }

  #put(key: string, value: unknown): void {
    const now = this.#clock.now();
    this.#db
      .insert(setting)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
      .run();
  }

  setEnabled(on: boolean, actor: string, ip: string): TrackerStatus {
    this.#put(SETTING_KEY, on);
    this.#enabled = on;
    this.#audit.record({ actor, action: on ? 'tracker.enabled' : 'tracker.disabled', ip });
    return this.status();
  }

  setOptions(change: Partial<TrackerOptions>, actor: string, ip: string): TrackerStatus {
    const next = { ...this.options(), ...change };
    this.#put(OPTIONS_KEY, next);
    this.#options = next;
    this.#audit.record({ actor, action: 'tracker.options', ip, details: { ...next } });
    return this.status();
  }

  status(): TrackerStatus {
    const r = this.#db
      .select({ n: sql<number>`count(*)` })
      .from(agentTrace)
      .get();
    return {
      enabled: this.enabled(),
      ...this.options(),
      entries: r?.n ?? 0,
      maxEntries: TRACE_LIMITS.maxEntries,
    };
  }

  save(input: TraceInput): void {
    const steps = input.steps.slice(0, TRACE_LIMITS.stepsMax);
    if (steps.length === 0) return;
    const counts: Record<string, number> = {};
    for (const s of steps) counts[s.type] = (counts[s.type] ?? 0) + 1;
    const id = newId();
    // Saved only while their switches are on.
    const opts = this.options();
    const tools = opts.tools ? (input.tools ?? []) : [];
    const systemHash = opts.system && input.system ? this.#putBlob(input.system) : null;
    const toolsHash = tools.length ? this.#putBlob(JSON.stringify(tools)) : null;
    this.#db
      .insert(agentTrace)
      .values({
        id,
        ts: input.ts,
        machineId: input.machineId,
        machineName: input.machineName,
        ip: input.ip ?? null,
        keySlug: input.keySlug,
        cli: input.cli,
        model: input.model,
        status: input.status,
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens ?? null,
        cacheWriteTokens: input.cacheWriteTokens ?? null,
        systemHash,
        toolsHash,
        toolCount: tools.length,
        mcpToolCount: tools.filter((t) => t.kind === 'mcp').length,
        counts,
        eventsEnc: this.#box.encrypt(JSON.stringify(steps), `${CONTEXT}:${id}`),
      })
      .run();
    // Trim now and then rather than on every save.
    if (++this.#saved % 100 === 1) this.trim();
  }

  /** Saves a system prompt or tool list once; returns its key. */
  #putBlob(text: string): string {
    const hash = this.#box.mac(text, BLOB);
    const known = this.#db
      .select({ hash: agentTraceBlob.hash })
      .from(agentTraceBlob)
      .where(eq(agentTraceBlob.hash, hash))
      .get();
    if (!known) {
      this.#db
        .insert(agentTraceBlob)
        .values({
          hash,
          enc: this.#box.encrypt(text, `${BLOB}:${hash}`),
          createdAt: this.#clock.now(),
        })
        .onConflictDoNothing()
        .run();
    }
    return hash;
  }

  #getBlob(hash: string | null): string | null {
    if (!hash) return null;
    const r = this.#db.select().from(agentTraceBlob).where(eq(agentTraceBlob.hash, hash)).get();
    if (!r) return null;
    try {
      return this.#box.decrypt(r.enc, `${BLOB}:${hash}`);
    } catch {
      return null;
    }
  }

  #tools(hash: string | null): TraceTool[] {
    const text = this.#getBlob(hash);
    if (!text) return [];
    try {
      return JSON.parse(text) as TraceTool[];
    } catch {
      return [];
    }
  }

  /** Deletes system prompts and tool lists no entry uses any more. */
  #dropUnusedBlobs(): void {
    this.#db.run(
      sql`DELETE FROM agent_trace_blob WHERE hash NOT IN (SELECT system_hash FROM agent_trace WHERE system_hash IS NOT NULL) AND hash NOT IN (SELECT tools_hash FROM agent_trace WHERE tools_hash IS NOT NULL)`,
    );
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
    const n = this.#db
      .delete(agentTrace)
      .where(sql`${agentTrace.ts} <= ${cutoff.ts}`)
      .run().changes;
    this.#dropUnusedBlobs();
    return n;
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
      ip: r.ip,
      keySlug: r.keySlug,
      cli: r.cli,
      model: r.model,
      status: r.status,
      durationMs: r.durationMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      toolCount: r.toolCount,
      mcpToolCount: r.mcpToolCount,
      hasSystem: r.systemHash !== null,
      counts: r.counts,
      preview,
      note: r.note,
    };
  }

  #where(f: TraceFilter | undefined) {
    const filters: SQL[] = [];
    if (f?.machineId) filters.push(eq(agentTrace.machineId, f.machineId));
    if (f?.ip) filters.push(eq(agentTrace.ip, f.ip));
    if (f?.model) filters.push(eq(agentTrace.model, f.model));
    return filters;
  }

  /** The computers, addresses and models that appear in the saved entries. */
  filterOptions(): TraceFilterOptions {
    const machines = this.#db
      .select({ id: agentTrace.machineId, name: agentTrace.machineName })
      .from(agentTrace)
      .groupBy(agentTrace.machineId, agentTrace.machineName)
      .orderBy(sql`max(${agentTrace.ts})`)
      .all();
    // A renamed computer keeps one entry: its newest name.
    const byId = new Map<string, string>();
    for (const m of machines) byId.set(m.id, m.name);
    const ips = this.#db
      .selectDistinct({ ip: agentTrace.ip })
      .from(agentTrace)
      .orderBy(agentTrace.ip)
      .all()
      .map((r) => r.ip)
      .filter((v): v is string => !!v);
    const models = this.#db
      .selectDistinct({ model: agentTrace.model })
      .from(agentTrace)
      .orderBy(agentTrace.model)
      .all()
      .map((r) => r.model)
      .filter((v): v is string => !!v);
    return {
      machines: [...byId]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      ips,
      models,
    };
  }

  list(
    opts: {
      limit: number;
      before?: string | undefined;
    } & TraceFilter,
  ): TracePage {
    const filters = this.#where(opts);
    const cursor = /^(\d{1,15})\.([A-Za-z0-9-]{1,64})$/.exec(opts.before ?? '');
    if (cursor) {
      const ts = Number(cursor[1]);
      const older = or(
        lt(agentTrace.ts, ts),
        and(eq(agentTrace.ts, ts), lt(agentTrace.id, cursor[2] ?? '')),
      );
      if (older) filters.push(older);
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
    return {
      ...this.#summary(r, steps),
      steps,
      system: this.#getBlob(r.systemHash),
      tools: this.#tools(r.toolsHash),
    };
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
  delete(ids: string[] | 'all', actor: string, ip: string, filter?: TraceFilter): number {
    const where = this.#where(filter);
    const n =
      ids === 'all'
        ? this.#db
            .delete(agentTrace)
            .where(where.length ? and(...where) : undefined)
            .run().changes
        : ids.length === 0
          ? 0
          : this.#db.delete(agentTrace).where(inArray(agentTrace.id, ids)).run().changes;
    if (n > 0) this.#dropUnusedBlobs();
    if (n > 0)
      this.#audit.record({
        actor,
        action: 'tracker.deleted',
        ip,
        details: {
          count: n,
          all: ids === 'all',
          ...(where.length ? { filter: { ...filter } } : {}),
        },
      });
    return n;
  }

  /** CSV with one row per step, oldest entry first. */
  exportCsv(
    ids: string[] | 'all',
    actor: string,
    ip: string,
    filter?: TraceFilter,
  ): { csv: string; entries: number } {
    const where = this.#where(filter);
    const rows =
      ids === 'all'
        ? this.#db
            .select()
            .from(agentTrace)
            .where(where.length ? and(...where) : undefined)
            .orderBy(agentTrace.ts, agentTrace.id)
            .all()
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
      'address',
      'key',
      'cli',
      'model',
      'status',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'note',
      'step',
      'type',
      'name',
      'content',
    ];
    const lines = [head.join(',')];
    // A system prompt or tool list is written out in full the first time only.
    const firstUse = new Map<string, string>();
    for (const r of rows) {
      const row = (step: number, type: string, name: string, text: string) => {
        lines.push(
          [
            iso(r.ts),
            r.id,
            r.machineName,
            r.ip,
            r.keySlug,
            r.cli,
            r.model,
            r.status,
            r.inputTokens,
            r.outputTokens,
            r.cacheReadTokens,
            r.cacheWriteTokens,
            r.note,
            step,
            type,
            name,
            text,
          ]
            .map(csvCell)
            .join(','),
        );
      };
      const shared = (hash: string | null, type: string, render: (text: string) => string) => {
        if (!hash) return;
        const seen = firstUse.get(hash);
        if (seen) {
          row(0, type, '', `(same as entry ${seen})`);
          return;
        }
        firstUse.set(hash, r.id);
        const text = this.#getBlob(hash);
        if (text !== null) row(0, type, '', render(text));
      };
      shared(r.systemHash, 'system', (t) => t);
      shared(r.toolsHash, 'tools', (t) => toolList(parseTools(t)));
      this.#steps(r).forEach((s, i) => {
        row(i + 1, s.type, s.name ?? '', s.text);
      });
    }
    this.#audit.record({
      actor,
      action: 'tracker.exported',
      ip,
      details: {
        count: rows.length,
        all: ids === 'all',
        ...(where.length ? { filter: { ...filter } } : {}),
      },
    });
    // A byte order mark, so Excel reads it as UTF-8.
    return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, entries: rows.length };
  }
}

function parseTools(text: string): TraceTool[] {
  try {
    return JSON.parse(text) as TraceTool[];
  } catch {
    return [];
  }
}

/** One line per tool: "server · name: what it does". */
export function toolList(tools: TraceTool[]): string {
  return tools
    .map((t) => {
      const name = t.kind === 'mcp' ? `MCP ${t.server ?? ''} · ${t.name}` : t.name;
      const about = t.description.split('\n')[0]?.slice(0, 200) ?? '';
      return about ? `${name}: ${about}` : name;
    })
    .join('\n');
}

/** A CSV cell. Cells a spreadsheet would run as a formula start with a quote mark. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
