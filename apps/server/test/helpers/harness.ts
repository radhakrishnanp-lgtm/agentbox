/**
 * Test harness: a real app on an in-memory database, a controllable clock,
 * a cookie jar per "browser", and helpers for the common flows.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config/env.ts';
import { openDb } from '../../src/db/client.ts';
import type { Clock } from '../../src/lib/clock.ts';
import { createServices, type Services } from '../../src/services.ts';
import { totpCodeAt } from '../../src/auth/totp.ts';
import {
  VirtualAuthenticator,
  type CreationOptions,
  type RequestOptions,
} from './virtual-authenticator.ts';

export const ORIGIN = 'https://agent.example.test';
export const RP_ID = 'agent.example.test';

export class TestClock implements Clock {
  t = Date.UTC(2026, 8, 29, 8, 0, 0);
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    AGENTBOX_ORIGIN: ORIGIN,
    AGENTBOX_DATA_DIR: '/nonexistent',
    // Unix-socket mode = production trust model (forwarded headers from Caddy).
    AGENTBOX_LISTEN: 'unix:/tmp/agentbox-test.sock',
    AGENTBOX_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AGENTBOX_SESSION_SECRET: randomBytes(48).toString('base64'),
    LOG_LEVEL: 'fatal',
    ...overrides,
  });
}

/** One simulated browser: its own cookies and IP. */
export class Browser {
  readonly cookies = new Map<string, string>();
  ip: string;
  userAgent: string;
  readonly h: Harness;

  constructor(h: Harness, ip = '203.0.113.10', userAgent = 'Mozilla/5.0 (Test) Chrome/140') {
    this.h = h;
    this.ip = ip;
    this.userAgent = userAgent;
  }

  async request(opts: InjectOptions & { raw?: boolean }): Promise<LightMyRequestResponse> {
    const method = (opts.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {
      'x-forwarded-proto': 'https',
      'x-forwarded-for': this.ip,
      'user-agent': this.userAgent,
      host: RP_ID,
      ...(this.cookies.size
        ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
        : {}),
      ...(method !== 'GET' && !opts.raw
        ? { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-agentbox': '1' }
        : {}),
      ...(opts.headers as Record<string, string> | undefined),
    };
    const res = await this.h.app.inject({ ...opts, headers });
    for (const c of res.cookies) {
      const expired = c.expires !== undefined && c.expires.getTime() <= Date.now();
      if (c.value === '' || expired || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  post(url: string, payload?: unknown) {
    return this.request({
      method: 'POST',
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
}

export class Harness {
  readonly clock = new TestClock();
  readonly config: Config;
  readonly services: Services;
  app!: FastifyInstance;
  readonly passkey = new VirtualAuthenticator(ORIGIN, RP_ID);
  totpSecret = '';

  constructor(config = testConfig()) {
    this.config = config;
    this.services = createServices(config, openDb(':memory:'), this.clock);
  }

  static async create(): Promise<Harness> {
    const h = new Harness();
    h.app = await buildApp(h.services, { logger: false });
    await h.app.ready();
    return h;
  }

  browser(ip?: string, ua?: string): Browser {
    return new Browser(this, ip, ua);
  }

  totp(offsetMs = 0): string {
    return totpCodeAt(this.totpSecret, this.clock.now() + offsetMs);
  }

  /** Runs the whole first-run wizard in `browser`. Returns the recovery codes. */
  async completeSetup(browser: Browser, deviceName = 'Laptop'): Promise<string[]> {
    const { url } = this.services.setup.createLink({ reset: false, actor: 'test' });
    const token = url.split('#')[1]!;
    const opts = (
      await browser.post('/api/setup/passkey/options', { token })
    ).json<CreationOptions>();
    const reg = await browser.post('/api/setup/passkey', {
      token,
      response: this.passkey.create(opts),
    });
    if (reg.statusCode !== 200) throw new Error(`passkey step failed: ${reg.body}`);
    const init = (await browser.post('/api/setup/totp/init', { token })).json<{ secret: string }>();
    this.totpSecret = init.secret;
    const conf = await browser.post('/api/setup/totp/confirm', { token, code: this.totp() });
    if (conf.statusCode !== 200) throw new Error(`totp step failed: ${conf.body}`);
    // The confirming code's time step is now used; move to the next one.
    this.clock.advance(30_000);
    const done = await browser.post('/api/setup/complete', { token, deviceName });
    if (done.statusCode !== 200) throw new Error(`complete failed: ${done.body}`);
    return done.json<{ recoveryCodes: string[] }>().recoveryCodes;
  }

  async signInWithPasskey(browser: Browser, authenticator = this.passkey) {
    const opts = (await browser.post('/api/auth/passkey/options')).json<RequestOptions>();
    return browser.post('/api/auth/passkey/verify', { response: authenticator.get(opts) });
  }

  async reauth(browser: Browser) {
    const opts = (await browser.post('/api/auth/reauth/options')).json<RequestOptions>();
    return browser.post('/api/auth/reauth/verify', { response: this.passkey.get(opts) });
  }

  async close(): Promise<void> {
    await this.app.close();
    this.services.db.$client.close();
  }
}
