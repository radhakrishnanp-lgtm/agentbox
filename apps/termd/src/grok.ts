/**
 * Short-lived Grok tokens from the Grok login in the vault, for machines.
 *
 * The official Grok CLI keeps its SuperGrok login in ~/.grok/auth.json: an
 * access token (a JWT, valid for a short time) and a refresh token. Machines
 * only ever get the access token. The refresh token stays here, and only the
 * Grok CLI itself uses it: when the token is close to expiring, termd runs
 * `grok models`, which refreshes the login the CLI's own way (with its file
 * lock), so it never competes with a Grok session running in a terminal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TermdError } from './tmux.ts';
import { run } from './run.ts';

export const XAI_ISSUER = 'https://auth.x.ai';
/** Tokens are handed out only with at least this much time left. */
export const MIN_TOKEN_LIFE_MS = 10 * 60_000;
const REFRESH_TIMEOUT_MS = 90_000;

export interface GrokToken {
  token: string;
  expiresAt: number;
}

interface AuthRecord {
  key?: unknown;
  auth_mode?: unknown;
  expires_at?: unknown;
  oidc_issuer?: unknown;
}

/** When a JWT expires, from its `exp` claim, or null if it isn't a JWT. */
export function jwtExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The xAI login in an auth.json, or null. Records from other issuers are ignored. */
export function readGrokLogin(text: string): GrokToken | null {
  let store: unknown;
  try {
    store = JSON.parse(text);
  } catch {
    return null;
  }
  if (!store || typeof store !== 'object') return null;
  let best: GrokToken | null = null;
  for (const [scope, raw] of Object.entries(store as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as AuthRecord;
    const issuer = typeof value.oidc_issuer === 'string' ? value.oidc_issuer : scope.split('::')[0];
    if (issuer !== XAI_ISSUER || value.auth_mode !== 'oidc') continue;
    const token = value.key;
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{20,8192}$/.test(token)) continue;
    const stated = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN;
    const fromJwt = jwtExpiry(token);
    const candidates = [stated, fromJwt ?? NaN].filter((n) => Number.isFinite(n));
    if (candidates.length === 0) continue;
    const expiresAt = Math.min(...candidates);
    if (!best || expiresAt > best.expiresAt) best = { token, expiresAt };
  }
  return best;
}

export class GrokLogin {
  readonly #home: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  #refreshing: Promise<void> | undefined;

  constructor(home: string, env: NodeJS.ProcessEnv, now: () => number = Date.now) {
    this.#home = home;
    this.#env = env;
    this.#now = now;
  }

  #read(): GrokToken | null {
    const path = join(this.#home, '.grok', 'auth.json');
    if (!existsSync(path)) return null;
    return readGrokLogin(readFileSync(path, 'utf8'));
  }

  async token(): Promise<GrokToken> {
    const first = this.#read();
    if (!first) {
      throw new TermdError(
        'not_found',
        'Grok is not signed in on agentbox. Open a terminal in agentbox, run grok and sign in with your SuperGrok account.',
      );
    }
    if (first.expiresAt - this.#now() > MIN_TOKEN_LIFE_MS) return first;
    // One refresh at a time, however many machines ask.
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    await this.#refreshing;
    const after = this.#read();
    if (after && after.expiresAt - this.#now() > MIN_TOKEN_LIFE_MS) return after;
    throw new TermdError(
      'conflict',
      "Grok's login on agentbox has expired. Open a terminal in agentbox and run grok login.",
    );
  }

  async #refresh(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...this.#env,
      PATH: `${join(this.#home, '.grok/bin')}:${this.#env['PATH'] ?? '/usr/bin:/bin'}`,
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_TELEMETRY_ENABLED: 'false',
      NO_COLOR: '1',
    };
    // `grok models` signs in with the stored login, refreshing it if needed.
    await run('sh', ['-c', 'command -v grok >/dev/null || exit 127; exec grok models </dev/null'], {
      env,
      cwd: this.#home,
      timeoutMs: REFRESH_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}
