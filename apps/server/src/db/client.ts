import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Opens (and migrates) the database. `path` ':memory:' is used by tests.
 * The data directory is 0700 and the file 0600, so only the service user can read it.
 */
export function openDb(path: string, migrationsDir = MIGRATIONS_DIR): Db {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const sqlite = new Database(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // Overwrite deleted content so old secrets don't linger in free pages.
  sqlite.pragma('secure_delete = ON');
  sqlite.pragma('trusted_schema = OFF');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  return db;
}

export function databasePath(dataDir: string): string {
  return join(dataDir, 'agentbox.db');
}
