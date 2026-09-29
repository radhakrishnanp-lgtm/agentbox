/**
 * AI keys and machine passes.
 *
 * - AI keys are encrypted with the server's SecretBox; the API only ever
 *   returns the last 4 characters.
 * - A machine pass is a 256-bit random token, shown once. agentbox keeps its
 *   SHA-256 hash, so a copy of the database can't be turned back into passes.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  GATEWAY_LIMITS,
  PASS_PREFIX,
  PROVIDER_PRESETS,
  type AiKeyCreate,
  type AiKeySummary,
  type KeyAuthStyle,
  type MachineSummary,
  type GatewayCli,
} from '@agentbox/shared';
import type { AuditLog } from '../audit/audit.ts';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { aiKey, gatewayUsage, machine } from '../db/schema.ts';
import { DAY, iso, type Clock } from '../lib/clock.ts';
import { hashToken, randomToken, type SecretBox } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';

export type AiKeyRow = typeof aiKey.$inferSelect;
export type MachineRow = typeof machine.$inferSelect;

export function dayOf(ms: number): number {
  return Math.floor(ms / DAY);
}

/** HTTPS only. Plain HTTP is allowed for loopback test servers outside production. */
export function checkUpstream(raw: string, config: Config): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('bad_request', 'The provider address is not a valid URL.');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  const httpOk = url.protocol === 'http:' && loopback && config.env !== 'production';
  if (url.protocol !== 'https:' && !httpOk) {
    throw new AppError('bad_request', 'The provider address must start with https://.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      'bad_request',
      'Put the key in the key field, not in the address. The address has no ?query or #part.',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

export class GatewayStore {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #box: SecretBox;
  readonly #audit: AuditLog;
  readonly #config: Config;

  constructor(db: Db, clock: Clock, box: SecretBox, audit: AuditLog, config: Config) {
    this.#db = db;
    this.#clock = clock;
    this.#box = box;
    this.#audit = audit;
    this.#config = config;
  }

  // ── AI keys ────────────────────────────────────────────────────────────

  gatewayUrl(slug: string): string {
    return `${this.#config.origin}/gw/${slug}`;
  }

  keySummary(k: AiKeyRow): AiKeySummary {
    return {
      id: k.id,
      name: k.name,
      slug: k.slug,
      preset: k.preset,
      upstream: k.upstream,
      auth: k.auth,
      cli: k.cli,
      model: k.model,
      hint: k.hint,
      gatewayUrl: this.gatewayUrl(k.slug),
      createdAt: iso(k.createdAt),
      lastUsedAt: k.lastUsedAt === null ? null : iso(k.lastUsedAt),
    };
  }

  activeKeys(): AiKeyRow[] {
    return this.#db.select().from(aiKey).where(isNull(aiKey.revokedAt)).all();
  }

  keyBySlug(slug: string): AiKeyRow | undefined {
    return this.#db
      .select()
      .from(aiKey)
      .where(and(eq(aiKey.slug, slug), isNull(aiKey.revokedAt)))
      .get();
  }

  addKey(input: AiKeyCreate, actor: string, ip: string): AiKeySummary {
    const preset = PROVIDER_PRESETS.find((p) => p.id === input.preset);
    if (!preset) throw new AppError('bad_request', 'Pick a provider from the list.');
    const upstream = checkUpstream(input.upstream || preset.upstream, this.#config);
    const auth: KeyAuthStyle = input.auth ?? preset.auth;
    const cli: GatewayCli | null = input.cli === undefined ? preset.cli : input.cli;
    const model = input.model ?? null;
    if (preset.needsModel && !model) {
      throw new AppError(
        'bad_request',
        'This provider needs a model name. Copy it from their docs.',
      );
    }
    // A Grok login key has nothing to store: tokens come from the vault's login.
    const secret = preset.noSecret ? '' : input.secret;
    if (!preset.noSecret && secret.length < 8) {
      throw new AppError('bad_request', 'Paste the whole key.');
    }
    if (preset.noSecret && auth !== preset.auth) {
      throw new AppError('bad_request', 'This one can only be used as a login.');
    }
    if (!preset.noSecret && auth === 'grok-login') {
      throw new AppError('bad_request', 'Pick “SuperGrok login” for that.');
    }
    if (/\s/.test(secret)) {
      throw new AppError('bad_request', 'The key has a space or line break in it. Paste it again.');
    }
    if (this.keyBySlug(input.slug)) {
      throw new AppError('conflict', `A key already uses the address name “${input.slug}”.`);
    }
    const now = this.#clock.now();
    const id = newId();
    const row: AiKeyRow = {
      id,
      name: input.name,
      slug: input.slug,
      preset: preset.id,
      upstream,
      auth,
      cli,
      model,
      secretEnc: this.#box.encrypt(secret, `ai_key:${id}`),
      hint: preset.noSecret ? 'VPS login' : secret.slice(-4),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insert(aiKey).values(row).run();
    this.#audit.record({
      actor,
      action: 'ai_key.added',
      targetType: 'ai_key',
      targetId: id,
      ip,
      details: { name: row.name, slug: row.slug, preset: row.preset, upstream },
    });
    return this.keySummary(row);
  }

  removeKey(id: string, actor: string, ip: string): void {
    const now = this.#clock.now();
    const res = this.#db
      .update(aiKey)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(aiKey.id, id), isNull(aiKey.revokedAt)))
      .run();
    if (res.changes === 0) throw new AppError('not_found', 'That key was not found.');
    this.#audit.record({ actor, action: 'ai_key.removed', targetType: 'ai_key', targetId: id, ip });
  }

  /** The real key, only for building the upstream request. Never returned by the API. */
  revealSecret(k: AiKeyRow): string {
    return this.#box.decrypt(k.secretEnc, `ai_key:${k.id}`);
  }

  touchKey(id: string): void {
    this.#db.update(aiKey).set({ lastUsedAt: this.#clock.now() }).where(eq(aiKey.id, id)).run();
  }

  // ── Machines ───────────────────────────────────────────────────────────

  #checkKeys(keyIds: string[]): void {
    const active = new Map(this.activeKeys().map((k) => [k.id, k]));
    const clis = new Set<string>();
    for (const id of keyIds) {
      const k = active.get(id);
      if (!k) throw new AppError('bad_request', 'One of the chosen keys no longer exists.');
      if (k.cli) {
        if (clis.has(k.cli)) {
          throw new AppError(
            'bad_request',
            `Two of the chosen keys are both for ${k.cli}. Pick one of them for this machine.`,
          );
        }
        clis.add(k.cli);
      }
    }
  }

  machineSummary(m: MachineRow): MachineSummary {
    const today = this.usageToday(m.id);
    return {
      id: m.id,
      name: m.name,
      passPrefix: m.passPrefix,
      keyIds: m.keyIds,
      ipRules: m.ipRules,
      rpm: m.rpm,
      dailyTokenLimit: m.dailyTokenLimit,
      createdAt: iso(m.createdAt),
      expiresAt: m.expiresAt === null ? null : iso(m.expiresAt),
      lastSeenAt: m.lastSeenAt === null ? null : iso(m.lastSeenAt),
      lastIp: m.lastIp,
      revokedAt: m.revokedAt === null ? null : iso(m.revokedAt),
      today,
    };
  }

  listMachines(): MachineRow[] {
    // Revoked machines stay listed for a week so you can see what happened.
    const since = this.#clock.now() - 7 * DAY;
    return this.#db
      .select()
      .from(machine)
      .where(sql`${machine.revokedAt} IS NULL OR ${machine.revokedAt} >= ${since}`)
      .orderBy(machine.createdAt)
      .all();
  }

  getMachine(id: string): MachineRow | undefined {
    return this.#db.select().from(machine).where(eq(machine.id, id)).get();
  }

  createMachine(
    input: {
      name: string;
      keyIds: string[];
      ipRules: string[];
      rpm: number;
      dailyTokenLimit: number | null;
      lifetimeDays: number | null;
    },
    actor: string,
    ip: string,
  ): { row: MachineRow; pass: string } {
    this.#checkKeys(input.keyIds);
    const pass = `${PASS_PREFIX}${randomToken()}`;
    const now = this.#clock.now();
    const row: MachineRow = {
      id: newId(),
      name: input.name,
      passHash: hashToken(pass),
      passPrefix: pass.slice(0, PASS_PREFIX.length + 6),
      keyIds: [...new Set(input.keyIds)],
      ipRules: normaliseIpRules(input.ipRules),
      rpm: input.rpm,
      dailyTokenLimit: input.dailyTokenLimit,
      expiresAt: input.lifetimeDays === null ? null : now + input.lifetimeDays * DAY,
      lastSeenAt: null,
      lastIp: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insert(machine).values(row).run();
    this.#audit.record({
      actor,
      action: 'machine.added',
      targetType: 'machine',
      targetId: row.id,
      ip,
      details: {
        name: row.name,
        keys: row.keyIds.length,
        ipLocked: row.ipRules.length > 0,
        rpm: row.rpm,
        dailyTokenLimit: row.dailyTokenLimit,
        expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
      },
    });
    return { row, pass };
  }

  updateMachine(
    id: string,
    patch: {
      name?: string | undefined;
      keyIds?: string[] | undefined;
      ipRules?: string[] | undefined;
      rpm?: number | undefined;
      dailyTokenLimit?: number | null | undefined;
      renewDays?: number | null | undefined;
    },
    actor: string,
    ip: string,
  ): MachineRow {
    const m = this.getMachine(id);
    if (!m || m.revokedAt !== null) throw new AppError('not_found', 'That machine was not found.');
    if (patch.keyIds) this.#checkKeys(patch.keyIds);
    const now = this.#clock.now();
    const set: Partial<MachineRow> = { updatedAt: now };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.keyIds !== undefined) set.keyIds = [...new Set(patch.keyIds)];
    if (patch.ipRules !== undefined) set.ipRules = normaliseIpRules(patch.ipRules);
    if (patch.rpm !== undefined) set.rpm = patch.rpm;
    if (patch.dailyTokenLimit !== undefined) set.dailyTokenLimit = patch.dailyTokenLimit;
    if (patch.renewDays !== undefined) {
      set.expiresAt = patch.renewDays === null ? null : now + patch.renewDays * DAY;
    }
    this.#db.update(machine).set(set).where(eq(machine.id, id)).run();
    this.#audit.record({
      actor,
      action: 'machine.updated',
      targetType: 'machine',
      targetId: id,
      ip,
      details: {
        changed: Object.keys(set).filter((k) => k !== 'updatedAt'),
        ...(set.expiresAt !== undefined
          ? { expiresAt: set.expiresAt === null ? null : iso(set.expiresAt) }
          : {}),
      },
    });
    return { ...m, ...set };
  }

  revokeMachine(id: string, actor: string, ip?: string): void {
    const now = this.#clock.now();
    const res = this.#db
      .update(machine)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(machine.id, id), isNull(machine.revokedAt)))
      .run();
    if (res.changes === 0) throw new AppError('not_found', 'That machine was not found.');
    this.#audit.record({
      actor,
      action: 'machine.revoked',
      targetType: 'machine',
      targetId: id,
      ...(ip ? { ip } : {}),
    });
  }

  /** Stops every machine at once (also available over SSH). Returns how many were active. */
  revokeAllMachines(actor: string, ip?: string): number {
    const now = this.#clock.now();
    const res = this.#db
      .update(machine)
      .set({ revokedAt: now, updatedAt: now })
      .where(isNull(machine.revokedAt))
      .run();
    this.#audit.record({
      actor,
      action: 'machine.revoked_all',
      targetType: 'machine',
      ...(ip ? { ip } : {}),
      details: { count: res.changes },
    });
    return res.changes;
  }

  /** Looks up a pass. Returns undefined for unknown passes; the caller decides the reply. */
  machineByPass(pass: string): MachineRow | undefined {
    return this.#db
      .select()
      .from(machine)
      .where(eq(machine.passHash, hashToken(pass)))
      .get();
  }

  isRevoked(id: string): boolean {
    const m = this.#db
      .select({ revokedAt: machine.revokedAt, expiresAt: machine.expiresAt })
      .from(machine)
      .where(eq(machine.id, id))
      .get();
    return !m || m.revokedAt !== null || (m.expiresAt !== null && m.expiresAt <= this.#clock.now());
  }

  markSeen(id: string, ip: string): void {
    this.#db
      .update(machine)
      .set({ lastSeenAt: this.#clock.now(), lastIp: ip })
      .where(eq(machine.id, id))
      .run();
  }

  // ── Usage ──────────────────────────────────────────────────────────────

  usageToday(machineId: string): { requests: number; inputTokens: number; outputTokens: number } {
    const r = this.#db
      .select({
        requests: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${gatewayUsage.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${gatewayUsage.outputTokens}), 0)`,
      })
      .from(gatewayUsage)
      .where(
        and(eq(gatewayUsage.machineId, machineId), eq(gatewayUsage.day, dayOf(this.#clock.now()))),
      )
      .get();
    return {
      requests: r?.requests ?? 0,
      inputTokens: r?.inputTokens ?? 0,
      outputTokens: r?.outputTokens ?? 0,
    };
  }

  recordUsage(row: Omit<typeof gatewayUsage.$inferInsert, 'id' | 'day'>): void {
    this.#db
      .insert(gatewayUsage)
      .values({ ...row, id: newId(), day: dayOf(row.ts) })
      .run();
  }

  recentUsage(limit: number, machineId?: string) {
    const since = this.#clock.now() - 30 * DAY;
    const where = machineId
      ? and(gte(gatewayUsage.ts, since), eq(gatewayUsage.machineId, machineId))
      : gte(gatewayUsage.ts, since);
    return this.#db
      .select()
      .from(gatewayUsage)
      .where(where)
      .orderBy(sql`${gatewayUsage.ts} DESC`)
      .limit(limit)
      .all();
  }

  /** Keeps 90 days of usage rows. */
  pruneUsage(): void {
    this.#db
      .delete(gatewayUsage)
      .where(sql`${gatewayUsage.ts} < ${this.#clock.now() - 90 * DAY}`)
      .run();
  }
}

export function normaliseIpRules(rules: string[]): string[] {
  const out = [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
  if (out.length > GATEWAY_LIMITS.ipRulesMax) {
    throw new AppError('bad_request', `Use at most ${GATEWAY_LIMITS.ipRulesMax} addresses.`);
  }
  for (const r of out) {
    const [addr = '', bits] = r.split('/');
    const ok =
      (isIPv4(addr) && (bits === undefined || (Number(bits) >= 0 && Number(bits) <= 32))) ||
      (isIPv6(addr) && (bits === undefined || (Number(bits) >= 0 && Number(bits) <= 128)));
    if (!ok) throw new AppError('bad_request', `“${r}” is not an IP address or range.`);
  }
  return out;
}

/** True when `ip` is allowed by `rules` (an empty list allows every address). */
export function ipAllowed(ip: string, rules: string[]): boolean {
  if (rules.length === 0) return true;
  const list = new BlockList();
  for (const r of rules) {
    const [addr = '', bits] = r.split('/');
    const type = isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  const bare = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  return list.check(bare, isIPv6(bare) ? 'ipv6' : 'ipv4');
}
