/**
 * "Test" for an AI key: agentbox asks the provider one small question with the
 * real key, exactly as the gateway would, and says whether it answered. It
 * proves the key, the login in the vault and the address are right, without
 * waiting for a machine to try it.
 */
import { request as upstreamRequest } from 'undici';
import type { KeyCheckResult } from '@agentbox/shared';
import type { TermdCodexToken, TermdGrokToken } from '@agentbox/shared/termd';
import { TermdRefused } from '../terminals/client.ts';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../services.ts';
import { GROK_CHAT_PROXY, upstreamHeaders } from './relay.ts';
import type { AiKeyRow } from './store.ts';

export type { KeyCheckResult };

const TIMEOUT_MS = 20_000;
/** Codex sends its version when it asks ChatGPT which models a plan has. */
const CODEX_VERSION = '0.160.0';

/** The smallest sensible question for this kind of key: "which models do I have?". */
function probePath(key: AiKeyRow): string {
  switch (key.auth) {
    case 'x-goog-api-key':
      return '/v1beta/models?pageSize=1';
    case 'codex-login':
      return `/models?client_version=${CODEX_VERSION}`;
    case 'x-api-key':
    case 'anthropic-oauth':
      return '/v1/models?limit=1';
    default:
      return '/v1/models';
  }
}

/** The provider's own message, when it sends one in a shape we know. */
function providerMessage(body: string): string | null {
  try {
    const value = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      detail?: unknown;
    };
    const candidates = [
      typeof value.error === 'string' ? value.error : value.error?.message,
      value.message,
      value.detail,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 300);
    }
  } catch {
    /* not JSON */
  }
  const text = body.trim();
  return text && text.length <= 300 && !text.startsWith('<') ? text : null;
}

function vaultProblem(err: unknown, what: string): string {
  if (err instanceof TermdRefused) {
    return err.code === 'vault_locked'
      ? 'The vault on agentbox is locked. Unlock it in Terminals, then test again.'
      : err.message;
  }
  if (err instanceof AppError) return err.message;
  return `Could not get ${what} from the terminals on this server.`;
}

export async function checkKey(s: Services, key: AiKeyRow): Promise<KeyCheckResult> {
  let secret: string;
  let accountId: string | undefined;
  let upstream = key.upstream;
  if (key.auth === 'grok-login') {
    try {
      secret = (await s.terminals.client.request<TermdGrokToken>({ op: 'grok.token' })).token;
    } catch (err) {
      return { ok: false, status: null, message: vaultProblem(err, 'your SuperGrok login') };
    }
    if (upstream === 'https://auth.x.ai') upstream = GROK_CHAT_PROXY;
  } else if (key.auth === 'codex-login') {
    try {
      const login = await s.terminals.client.request<TermdCodexToken>({ op: 'codex.token' });
      secret = login.token;
      accountId = login.accountId;
    } catch (err) {
      return { ok: false, status: null, message: vaultProblem(err, 'your ChatGPT login') };
    }
  } else {
    secret = s.gateway.revealSecret(key);
  }

  const path = probePath(key);
  let host: string;
  try {
    host = new URL(upstream).host;
  } catch {
    return { ok: false, status: null, message: `“${upstream}” is not a web address.` };
  }
  let status: number;
  let body: string;
  try {
    const res = await upstreamRequest(`${upstream}${path}`, {
      method: 'GET',
      headers: upstreamHeaders({ accept: 'application/json' }, key, secret, accountId),
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    status = res.statusCode;
    body = (await res.body.text()).slice(0, 4000);
  } catch {
    return { ok: false, status: null, message: `Could not reach ${host}.` };
  }

  const detail = providerMessage(body);
  if (status >= 200 && status < 300) {
    return { ok: true, status, message: `${host} answered. This key works.` };
  }
  if (status === 401 || status === 403) {
    const what = key.auth === 'grok-login' || key.auth === 'codex-login' ? 'login' : 'key';
    return {
      ok: false,
      status,
      message: `${host} refused this ${what}${detail ? `: ${detail}` : '.'}`,
    };
  }
  // A login that works but has no list of models: the provider knew who we are.
  if (
    (status === 404 || status === 405) &&
    (key.auth === 'grok-login' || key.auth === 'codex-login')
  ) {
    return {
      ok: true,
      status,
      message: `${host} accepted your login. It has no list of models to show, so this is as far as a test goes.`,
    };
  }
  if (status === 429) {
    return { ok: false, status, message: `${host} is rate limiting this key. Try again shortly.` };
  }
  return {
    ok: false,
    status,
    message: `${host} answered ${status}${detail ? `: ${detail}` : '.'}`,
  };
}
