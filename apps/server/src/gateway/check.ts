/**
 * "Test" for an AI key: agentbox asks the provider one small question with the
 * real key, exactly as the gateway would, and says whether it answered. It
 * proves the key, the login in the vault and the address are right, without
 * waiting for a machine to try it.
 */
import { request as upstreamRequest } from 'undici';
import type { KeyCheckResult } from '@agentbox/shared';
import type {
  TermdCodexToken,
  TermdGrokToken,
  TermdOpencodeKey,
  TermdOpencodeSetup,
} from '@agentbox/shared/termd';
import { TermdRefused } from '../terminals/client.ts';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../services.ts';
import { GROK_CHAT_PROXY, upstreamHeaders } from './relay.ts';
import type { AiKeyRow } from './store.ts';

export type { KeyCheckResult };

const TIMEOUT_MS = 20_000;
/** Codex sends its version when it asks ChatGPT which models a plan has. */
const CODEX_VERSION = '0.160.0';

/** Anthropic answers 400 to any request without an API version. Claude Code sends this one. */
const ANTHROPIC_VERSION = '2023-06-01';

/** The smallest sensible question for this kind of key: "which models do I have?". */
function probePath(key: AiKeyRow): string {
  // Its address is the base URL as OpenCode uses it, /v1 included.
  if (key.preset === 'openai-compatible') return '/models';
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

/** The model ids in an OpenAI-style list of models, or null when it isn't one. */
function listedModels(body: string): string[] | null {
  try {
    const data = (JSON.parse(body) as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    return data
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  }
}

/**
 * Asks the provider one small question with this key. `secret` tests a key
 * that isn't saved yet (or a new key for a saved one).
 */
export async function checkKey(
  s: Services,
  key: AiKeyRow,
  secretOverride?: string,
): Promise<KeyCheckResult> {
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
  } else if (key.auth === 'opencode-login') {
    let setup: TermdOpencodeSetup;
    try {
      setup = await s.terminals.client.request<TermdOpencodeSetup>({ op: 'opencode.setup' });
    } catch (err) {
      return { ok: false, status: null, message: vaultProblem(err, 'your OpenCode setup') };
    }
    const skipped = setup.skipped.length
      ? ` Left out, because ${setup.skipped.length === 1 ? 'it has' : 'they have'} no https address (baseURL) in OpenCode's settings: ${setup.skipped.join(', ')}.`
      : '';
    if (!setup.zen) {
      const names = setup.providers.map((p) => p.name);
      return names.length > 0
        ? {
            ok: true,
            status: null,
            message: `OpenCode on agentbox has ${names.join(', ')}. OpenCode on your computers gets ${names.length === 1 ? 'it' : 'them'} the next time it starts, plus OpenCode's free models.${skipped}`,
          }
        : {
            ok: true,
            status: null,
            message: `OpenCode on agentbox has no models of your own yet, so your computers get OpenCode's free models. Add a provider in OpenCode's settings in a terminal here.${skipped}`,
          };
    }
    try {
      secret = (await s.terminals.client.request<TermdOpencodeKey>({ op: 'opencode.key' })).key;
    } catch (err) {
      return { ok: false, status: null, message: vaultProblem(err, 'your OpenCode login') };
    }
  } else {
    secret = secretOverride ?? s.gateway.revealSecret(key);
  }

  const path = probePath(key);
  const asked: Record<string, string> = { accept: 'application/json' };
  if (key.auth === 'x-api-key' || key.auth === 'anthropic-oauth') {
    asked['anthropic-version'] = ANTHROPIC_VERSION;
  }
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
      headers: upstreamHeaders(asked, key, secret, accountId),
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    status = res.statusCode;
    body = (await res.body.text()).slice(0, 2_000_000);
  } catch {
    return { ok: false, status: null, message: `Could not reach ${host}.` };
  }

  const detail = providerMessage(body.slice(0, 4000));
  if (status >= 200 && status < 300) {
    const models = key.preset === 'openai-compatible' && key.model ? listedModels(body) : null;
    if (models && key.model) {
      return models.includes(key.model)
        ? {
            ok: true,
            status,
            message: `${host} answered. This key works, and it has ${key.model}.`,
          }
        : {
            ok: false,
            status,
            message:
              `${host} accepted the key, but it has no model called ${key.model}. ${models.length ? `It has: ${models.slice(0, 8).join(', ')}${models.length > 8 ? ', …' : ''}.` : ''}`.trim(),
          };
    }
    return { ok: true, status, message: `${host} answered. This key works.` };
  }
  if (status === 404 && key.preset === 'openai-compatible') {
    return {
      ok: false,
      status,
      message: `${host} has no ${new URL(`${upstream}${path}`).pathname}. Check the base URL: it usually ends in /v1.`,
    };
  }
  if (status === 401 || status === 403) {
    const what =
      key.auth === 'grok-login' || key.auth === 'codex-login' || key.auth === 'opencode-login'
        ? 'login'
        : 'key';
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
