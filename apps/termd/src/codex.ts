/**
 * The Codex (ChatGPT) login in the vault, for machines.
 *
 * `codex login` keeps a ChatGPT sign-in in ~/.codex/auth.json: an access
 * token (a JWT), a refresh token and the ChatGPT account id. Machines never
 * get any of it: agentbox adds the access token to their requests on the way
 * to ChatGPT. The refresh token never leaves this file.
 *
 * When the access token is close to expiring, termd refreshes it the way Codex
 * does (same endpoint and client id) and writes the new tokens back. Codex
 * reloads auth.json before it refreshes, and skips its own refresh when the
 * file changed, so this never competes with a Codex session in a terminal.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jwtExpiry, MIN_TOKEN_LIFE_MS } from './grok.ts';
import { TermdError } from './tmux.ts';

/** Codex's own sign-in client and token endpoint (codex-rs/login/src/auth/manager.rs). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_TIMEOUT_MS = 30_000;
const TOKEN = /^[A-Za-z0-9._~+/=-]{20,16384}$/;

export interface CodexToken {
  token: string;
  accountId: string;
  expiresAt: number;
}

interface CodexTokens {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

function claims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The ChatGPT account id: stored next to the tokens, or inside the id token. */
function accountIdOf(tokens: CodexTokens): string | null {
  if (typeof tokens.account_id === 'string' && tokens.account_id) return tokens.account_id;
  if (typeof tokens.id_token !== 'string') return null;
  const auth = claims(tokens.id_token)?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return null;
  const id = (auth as Record<string, unknown>)['chatgpt_account_id'];
  return typeof id === 'string' && id ? id : null;
}

/** The ChatGPT sign-in in an auth.json, or null (an API key or anything else is ignored). */
export function readCodexLogin(text: string): (CodexToken & { refreshToken: string }) | null {
  let store: unknown;
  try {
    store = JSON.parse(text);
  } catch {
    return null;
  }
  if (!store || typeof store !== 'object') return null;
  const tokens = (store as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as CodexTokens;
  if (typeof t.access_token !== 'string' || !TOKEN.test(t.access_token)) return null;
  if (typeof t.refresh_token !== 'string' || !t.refresh_token) return null;
  const accountId = accountIdOf(t);
  const expiresAt = jwtExpiry(t.access_token);
  if (!accountId || !/^[A-Za-z0-9_-]{1,200}$/.test(accountId) || expiresAt === null) return null;
  return { token: t.access_token, accountId, expiresAt, refreshToken: t.refresh_token };
}

export class CodexLogin {
  readonly #home: string;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  #refreshing: Promise<void> | undefined;

  constructor(home: string, now: () => number = Date.now, fetchImpl: typeof fetch = fetch) {
    this.#home = home;
    this.#now = now;
    this.#fetch = fetchImpl;
  }

  get #path(): string {
    return join(this.#home, '.codex', 'auth.json');
  }

  #read() {
    if (!existsSync(this.#path)) return null;
    return readCodexLogin(readFileSync(this.#path, 'utf8'));
  }

  async token(): Promise<CodexToken> {
    const first = this.#read();
    if (!first) {
      throw new TermdError(
        'not_found',
        'Codex is not signed in with ChatGPT on agentbox. Open a terminal in agentbox and run codex login --device-auth.',
      );
    }
    if (first.expiresAt - this.#now() > MIN_TOKEN_LIFE_MS) return pick(first);
    // One refresh at a time, however many machines ask.
    this.#refreshing ??= this.#refresh(first.refreshToken).finally(() => {
      this.#refreshing = undefined;
    });
    await this.#refreshing;
    const after = this.#read();
    if (after && after.expiresAt - this.#now() > MIN_TOKEN_LIFE_MS) return pick(after);
    throw new TermdError(
      'conflict',
      "Codex's ChatGPT login on agentbox has expired. Open a terminal in agentbox and run codex login --device-auth.",
    );
  }

  async #refresh(refreshToken: string): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch {
      return;
    }
    if (!res.ok) return;
    const fresh = (await res.json().catch(() => null)) as CodexTokens | null;
    if (!fresh || typeof fresh.access_token !== 'string' || !TOKEN.test(fresh.access_token)) return;
    // Change only the tokens and last_refresh; Codex owns everything else in the file.
    const text = existsSync(this.#path) ? readFileSync(this.#path, 'utf8') : null;
    if (text === null) return;
    const store = JSON.parse(text) as { tokens?: Record<string, unknown>; last_refresh?: string };
    // Codex refreshed it meanwhile: keep its newer tokens.
    if (store.tokens?.['refresh_token'] !== refreshToken) return;
    store.tokens = {
      ...store.tokens,
      access_token: fresh.access_token,
      ...(typeof fresh.id_token === 'string' ? { id_token: fresh.id_token } : {}),
      ...(typeof fresh.refresh_token === 'string' ? { refresh_token: fresh.refresh_token } : {}),
    };
    store.last_refresh = new Date(this.#now()).toISOString();
    const tmp = `${this.#path}.agentbox.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

function pick(t: CodexToken): CodexToken {
  return { token: t.token, accountId: t.accountId, expiresAt: t.expiresAt };
}
