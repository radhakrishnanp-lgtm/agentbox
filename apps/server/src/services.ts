import type { FastifyBaseLogger } from 'fastify';
import { AuditLog } from './audit/audit.ts';
import { Devices } from './auth/devices.ts';
import { OwnerFactors } from './auth/owner.ts';
import { Sessions, SqliteSessionStore } from './auth/sessions.ts';
import { SetupService } from './auth/setup.ts';
import { WebAuthnService } from './auth/webauthn.ts';
import { RelayState } from './gateway/relay.ts';
import { GatewayStore } from './gateway/store.ts';
import { Tracker } from './gateway/tracker.ts';
import type { Config } from './config/env.ts';
import { SettingsStore } from './config/settings.ts';
import type { Db } from './db/client.ts';
import type { Clock } from './lib/clock.ts';
import { SecretBox } from './lib/crypto.ts';
import { Lockouts } from './security/lockout.ts';
import { TermdClient } from './terminals/client.ts';
import { Terminals } from './terminals/service.ts';

export interface Services {
  config: Config;
  db: Db;
  clock: Clock;
  box: SecretBox;
  audit: AuditLog;
  settings: SettingsStore;
  lockouts: Lockouts;
  devices: Devices;
  sessionStore: SqliteSessionStore;
  sessions: Sessions;
  webauthn: WebAuthnService;
  owner: OwnerFactors;
  setup: SetupService;
  gateway: GatewayStore;
  relay: RelayState;
  tracker: Tracker;
  terminals: Terminals;
}

export function createServices(
  config: Config,
  db: Db,
  clock: Clock,
  log?: FastifyBaseLogger,
): Services {
  const box = new SecretBox(
    config.encryptionKey,
    config.encryptionKeyPrevious ? [config.encryptionKeyPrevious] : [],
  );
  const audit = new AuditLog(db, clock, log);
  const settings = new SettingsStore(db, clock);
  const devices = new Devices(db, clock, config);
  return {
    config,
    db,
    clock,
    box,
    audit,
    settings,
    lockouts: new Lockouts(db, clock),
    devices,
    sessionStore: new SqliteSessionStore(db, clock),
    sessions: new Sessions(db, clock, settings, devices, audit),
    webauthn: new WebAuthnService(db, clock, config),
    owner: new OwnerFactors(db, clock, box),
    setup: new SetupService(db, clock, config, box, audit),
    gateway: new GatewayStore(db, clock, box, audit, config),
    relay: new RelayState(),
    tracker: new Tracker(db, clock, box, audit),
    terminals: new Terminals(new TermdClient(config.termdSocket), db, clock, box, audit, log),
  };
}
