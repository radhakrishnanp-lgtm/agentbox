/**
 * Admin commands, run on the VPS over SSH (via the root-only `agentbox`
 * wrapper, which drops to the agentbox service user):
 *
 *   agentbox setup-link            one-time link for first setup (30 min)
 *   agentbox setup-link --reset    wipe all sign-in methods and devices, then link
 *   agentbox audit-verify          check the audit log's hash chain
 *   agentbox machines              list machines that use the key gateway
 *   agentbox machines stop <name>  stop one machine's pass (also cuts live streams)
 *   agentbox machines stop-all     stop every machine's pass
 */
import { loadConfig } from './config/env.ts';
import { databasePath, openDb } from './db/client.ts';
import { systemClock } from './lib/clock.ts';
import { AppError } from './lib/errors.ts';
import { createServices } from './services.ts';

function usage(): never {
  process.stderr.write(
    'Usage: agentbox <setup-link [--reset] | audit-verify | machines [stop <name> | stop-all]>\n',
  );
  process.exit(2);
}

function run(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  const config = loadConfig();
  const db = openDb(databasePath(config.dataDir), process.env['AGENTBOX_MIGRATIONS_DIR']);
  const s = createServices(config, db, systemClock);
  try {
    switch (command) {
      case 'setup-link': {
        const reset = args.includes('--reset');
        if (args.some((a) => a !== '--reset')) usage();
        const { url, expiresAt } = s.setup.createLink({ reset, actor: 'cli' });
        process.stdout.write(
          (reset ? 'All passkeys, devices and sessions were removed.\n' : '') +
            `Open this link within 30 minutes (until ${new Date(expiresAt).toISOString()}):\n\n  ${url}\n\n` +
            'Anyone with this link can set up agentbox, so do not share it.\n',
        );
        break;
      }
      case 'audit-verify': {
        const r = s.audit.verify();
        process.stdout.write(
          r.ok
            ? `Audit log OK: ${r.checked} entries, hash chain intact.\n`
            : `AUDIT LOG TAMPERED: chain breaks at entry ${r.brokenAt} (${r.checked} entries were fine).\n`,
        );
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      case 'machines': {
        const [sub, ...rest] = args;
        const all = s.gateway.listMachines();
        if (sub === undefined) {
          const active = all.filter((m) => m.revokedAt === null);
          if (active.length === 0) process.stdout.write('No machines.\n');
          for (const m of active) {
            const seen = m.lastSeenAt ? new Date(m.lastSeenAt).toISOString() : 'never';
            process.stdout.write(
              `${m.name}\t${m.passPrefix}…\tlast seen ${seen}\t${m.lastIp ?? ''}\n`,
            );
          }
        } else if (sub === 'stop-all' && rest.length === 0) {
          const n = s.gateway.revokeAllMachines('cli');
          process.stdout.write(
            `Stopped ${n} machine${n === 1 ? '' : 's'}. Live requests end within 2 seconds.\n`,
          );
        } else if (sub === 'stop' && rest.length > 0) {
          const name = rest.join(' ');
          const matches = all.filter(
            (m) => m.revokedAt === null && (m.name === name || m.id === name),
          );
          const [match] = matches;
          if (!match || matches.length !== 1) {
            throw new AppError(
              'not_found',
              matches.length === 0
                ? `No active machine called "${name}".`
                : `Several machines are called "${name}"; use its id instead.`,
            );
          }
          s.gateway.revokeMachine(match.id, 'cli');
          process.stdout.write(`Stopped "${name}". Live requests end within 2 seconds.\n`);
        } else {
          usage();
        }
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    process.stderr.write(`${err instanceof AppError ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    db.$client.close();
  }
}

run();
