/** Owner-adjustable settings, stored in the database with safe defaults. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { SESSION_DEFAULTS } from '@agentbox/shared';
import type { Db } from '../db/client.ts';
import { setting } from '../db/schema.ts';
import type { Clock } from '../lib/clock.ts';

export const settingsSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(5).max(120),
  maxLifetimeHours: z.number().int().min(1).max(24),
});

export type Settings = z.infer<typeof settingsSchema>;

const DEFAULTS: Settings = {
  idleTimeoutMinutes: SESSION_DEFAULTS.idleTimeoutMinutes,
  maxLifetimeHours: SESSION_DEFAULTS.maxLifetimeHours,
};

export class SettingsStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  get(): Settings {
    const rows = this.#db.select().from(setting).all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Ignore any stored value that no longer validates (e.g. after a limit change).
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const field = settingsSchema.shape[key].safeParse(stored[key]);
      if (field.success) merged[key] = field.data;
    }
    return merged;
  }

  update(patch: Partial<Settings>): Settings {
    const valid = settingsSchema.partial().parse(patch);
    const now = this.#clock.now();
    this.#db.transaction((tx) => {
      for (const [key, value] of Object.entries(valid)) {
        tx.insert(setting)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
          .run();
      }
    });
    return this.get();
  }

  remove(key: keyof Settings): void {
    this.#db.delete(setting).where(eq(setting.key, key)).run();
  }
}
