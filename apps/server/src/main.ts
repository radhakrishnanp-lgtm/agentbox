import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config/env.ts';
import { databasePath, openDb } from './db/client.ts';
import { systemClock } from './lib/clock.ts';
import { createServices } from './services.ts';

// Files this process creates (database, socket) are private to the service user.
process.umask(0o077);

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(databasePath(config.dataDir), process.env['AGENTBOX_MIGRATIONS_DIR']);
  const services = createServices(config, db, systemClock);
  const app = await buildApp(services);
  services.owner.rotateEncryption();

  if (config.listen.kind === 'unix') {
    const { path } = config.listen;
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    if (existsSync(path)) rmSync(path);
    await app.listen({ path });
    // Caddy (group of the socket) may connect; nobody else, including the dev user.
    chmodSync(path, 0o660);
  } else {
    await app.listen({ host: config.listen.host, port: config.listen.port });
  }

  // With auto-unlock on, the terminal vault is unlocked again after a restart.
  services.terminals.start(app.log);

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => {
        db.$client.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  // Configuration errors are written for humans; print them plainly.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
