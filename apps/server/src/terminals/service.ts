/**
 * Terminals and the vault, as the web app sees them. termd does the work; this
 * adds the audit trail, the owner's auto-unlock choice and friendly errors.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { TerminalOverview, TerminalPresetId } from '@agentbox/shared';
import type { TermdOverview } from '@agentbox/shared/termd';
import type { AuditLog } from '../audit/audit.ts';
import type { Db } from '../db/client.ts';
import { vaultKey } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import { TermdClient, TermdRefused } from './client.ts';

const KEY_CONTEXT = 'vault-password';

export interface Actor {
  actor: string;
  ip: string;
}

export class Terminals {
  readonly client: TermdClient;
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #box: SecretBox;
  readonly #audit: AuditLog;
  #log: FastifyBaseLogger | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    client: TermdClient,
    db: Db,
    clock: Clock,
    box: SecretBox,
    audit: AuditLog,
    log?: FastifyBaseLogger,
  ) {
    this.client = client;
    this.#db = db;
    this.#clock = clock;
    this.#box = box;
    this.#audit = audit;
    this.#log = log;
  }

  get enabled(): boolean {
    return this.client.socketPath !== null;
  }

  /** Runs a termd request and turns termd's refusals into API errors. */
  async #call<T extends object>(req: Parameters<TermdClient['request']>[0]): Promise<T> {
    try {
      return await this.client.request<T>(req);
    } catch (err) {
      if (err instanceof TermdRefused) throw err.toAppError();
      throw err;
    }
  }

  autoUnlock(): boolean {
    return this.#storedPassword() !== null;
  }

  #storedPassword(): string | null {
    const row = this.#db.select().from(vaultKey).where(eq(vaultKey.id, 1)).get();
    if (!row) return null;
    try {
      return this.#box.decrypt(row.secretEnc, KEY_CONTEXT);
    } catch {
      return null;
    }
  }

  #storePassword(password: string): void {
    const now = this.#clock.now();
    const secretEnc = this.#box.encrypt(password, KEY_CONTEXT);
    this.#db
      .insert(vaultKey)
      .values({ id: 1, secretEnc, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: vaultKey.id, set: { secretEnc, updatedAt: now } })
      .run();
  }

  #forgetPassword(): boolean {
    return this.#db.delete(vaultKey).where(eq(vaultKey.id, 1)).run().changes > 0;
  }

  async overview(): Promise<TerminalOverview> {
    const autoUnlock = this.autoUnlock();
    try {
      const o = await this.#call<TermdOverview>({ op: 'overview' });
      return {
        available: true,
        vault: o.vault,
        autoUnlock,
        terminals: o.terminals,
        installed: o.installed,
      };
    } catch (err) {
      if (err instanceof AppError && err.code === 'unavailable') {
        return { available: false, vault: 'locked', autoUnlock, terminals: [], installed: [] };
      }
      throw err;
    }
  }

  async create(name: string, preset: TerminalPresetId, by: Actor): Promise<void> {
    await this.#call({ op: 'create', name, preset, cols: 120, rows: 32 });
    this.#record(by, 'terminal.created', name, { preset });
  }

  async rename(name: string, to: string, by: Actor): Promise<void> {
    await this.#call({ op: 'rename', name, to });
    this.#record(by, 'terminal.renamed', to, { from: name });
  }

  async kill(name: string, by: Actor): Promise<void> {
    await this.#call({ op: 'kill', name });
    this.#record(by, 'terminal.killed', name);
  }

  opened(name: string, by: Actor): void {
    this.#record(by, 'terminal.opened', name);
  }

  async vaultInit(password: string, autoUnlock: boolean, by: Actor): Promise<void> {
    await this.#call({ op: 'vault.init', password });
    this.#forgetPassword();
    if (autoUnlock) this.#storePassword(password);
    this.#record(by, 'vault.created', undefined, { autoUnlock });
  }

  /** Unlocks with the given password. Throws 'wrong_password' as a TermdRefused. */
  async vaultUnlock(password: string, by: Actor): Promise<void> {
    try {
      await this.client.request({ op: 'vault.unlock', password });
    } catch (err) {
      if (err instanceof TermdRefused) {
        if (err.code === 'wrong_password') this.#record(by, 'vault.unlock_failed');
        throw err;
      }
      throw err;
    }
    this.#record(by, 'vault.unlocked');
  }

  async vaultLock(by: Actor): Promise<void> {
    await this.#call({ op: 'vault.lock' });
    this.#record(by, 'vault.locked');
  }

  async vaultReset(by: Actor): Promise<void> {
    await this.#call({ op: 'vault.reset' });
    this.#forgetPassword();
    this.#record(by, 'vault.reset');
  }

  /** Turning auto-unlock on stores the (checked) password; turning it off deletes it. */
  async setAutoUnlock(on: boolean, password: string | undefined, by: Actor): Promise<void> {
    if (!on) {
      if (this.#forgetPassword()) this.#record(by, 'vault.auto_unlock_off');
      return;
    }
    if (!password) throw new AppError('bad_request', 'Enter the vault password to turn this on.');
    await this.#call({ op: 'vault.verify', password });
    this.#storePassword(password);
    this.#record(by, 'vault.auto_unlock_on');
  }

  /**
   * With auto-unlock on, unlocks the vault after a restart. A stored password
   * that stopped working is deleted, so it is never retried.
   */
  async autoUnlockTick(): Promise<void> {
    const password = this.#storedPassword();
    if (!password) return;
    let state: TermdOverview['vault'];
    try {
      state = (await this.client.request<TermdOverview>({ op: 'overview' })).vault;
    } catch {
      return; // termd isn't up yet; try again next time.
    }
    if (state !== 'locked') return;
    try {
      await this.client.request({ op: 'vault.unlock', password });
      this.#record({ actor: 'system', ip: '' }, 'vault.unlocked', undefined, { auto: true });
    } catch (err) {
      if (err instanceof TermdRefused && err.code === 'wrong_password') {
        this.#forgetPassword();
        this.#record({ actor: 'system', ip: '' }, 'vault.auto_unlock_failed');
      } else {
        this.#log?.warn({ err }, 'vault auto-unlock failed');
      }
    }
  }

  start(log: FastifyBaseLogger, everyMs = 30_000): void {
    this.#log = log;
    if (!this.enabled || this.#timer) return;
    void this.autoUnlockTick();
    this.#timer = setInterval(() => void this.autoUnlockTick(), everyMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #record(
    by: Actor,
    action: Parameters<AuditLog['record']>[0]['action'],
    target?: string,
    details?: Record<string, unknown>,
  ): void {
    this.#audit.record({
      actor: by.actor,
      action,
      ...(target ? { targetType: 'terminal', targetId: target } : {}),
      ...(by.ip ? { ip: by.ip } : {}),
      ...(details ? { details } : {}),
    });
  }
}
