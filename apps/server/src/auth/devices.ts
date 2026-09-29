/**
 * Device recognition. A device cookie holds a random 256-bit value (stored
 * hashed). By itself it cannot sign anyone in; it only tells agentbox that
 * this browser was approved before, so a new browser needs a second check.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { device } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import { DAY } from '../lib/clock.ts';
import { hashToken, randomToken } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';
import { baseCookieOptions, cookieNames } from './cookies.ts';

export const DEVICE_COOKIE_MAX_AGE_S = (90 * DAY) / 1000;
const UA_MAX = 300;

export type DeviceRow = typeof device.$inferSelect;

export class Devices {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #config: Config;

  constructor(db: Db, clock: Clock, config: Config) {
    this.#db = db;
    this.#clock = clock;
    this.#config = config;
  }

  /** The unrevoked device this browser's cookie points to, if any. */
  current(request: FastifyRequest): DeviceRow | undefined {
    const token = request.cookies[cookieNames(this.#config).device];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.#db
      .select()
      .from(device)
      .where(and(eq(device.tokenHash, hashToken(token)), isNull(device.revokedAt)))
      .get();
  }

  byId(id: string): DeviceRow | undefined {
    return this.#db.select().from(device).where(eq(device.id, id)).get();
  }

  /** Returns this browser's device, creating an unapproved one (and its cookie) if needed. */
  ensure(request: FastifyRequest, reply: FastifyReply): DeviceRow {
    const existing = this.current(request);
    if (existing) return existing;
    const now = this.#clock.now();
    const token = randomToken();
    const row: DeviceRow = {
      id: newId(),
      name: null,
      tokenHash: hashToken(token),
      userAgent: (request.headers['user-agent'] ?? 'unknown').slice(0, UA_MAX),
      firstIp: request.ip,
      lastIp: request.ip,
      approvedAt: null,
      approvedBy: null,
      lastSeenAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insert(device).values(row).run();
    this.setCookie(reply, token);
    return row;
  }

  setCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(cookieNames(this.#config).device, token, {
      ...baseCookieOptions(this.#config),
      maxAge: DEVICE_COOKIE_MAX_AGE_S,
    });
  }

  isApproved(row: DeviceRow | undefined): boolean {
    return !!row && row.approvedAt !== null && row.revokedAt === null;
  }

  approve(id: string, approvedBy: string, name: string): void {
    const now = this.#clock.now();
    this.#db
      .update(device)
      .set({ approvedAt: now, approvedBy, name, updatedAt: now })
      .where(and(eq(device.id, id), isNull(device.revokedAt)))
      .run();
  }

  touch(id: string, ip: string): void {
    const now = this.#clock.now();
    this.#db.update(device).set({ lastSeenAt: now, lastIp: ip }).where(eq(device.id, id)).run();
  }
}
