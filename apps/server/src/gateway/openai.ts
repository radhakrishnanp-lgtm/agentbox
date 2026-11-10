/**
 * One OpenAI-compatible API for all your AI keys: `<origin>/v1/…`.
 *
 * Any program that speaks the OpenAI API (an SDK, a chat app, an agent
 * framework) uses agentbox as its base URL and a machine pass as its API key.
 * The model says which key to use: `<key address name>/<model>`, for example
 * `anthropic/claude-sonnet-4-5`, `openrouter/meta-llama/llama-4` or just
 * `kimi-code` for a key that names its own model. agentbox sends the request
 * to that provider's own OpenAI-compatible address with the real key, so the
 * request and the answer stay in OpenAI's format.
 *
 * Subscription logins (Claude Pro/Max, ChatGPT, SuperGrok, OpenCode's setup)
 * are left out on purpose: their providers allow them only in their own apps,
 * so agentbox does not offer them to any program as an API.
 */
import { NOT_OPENAI_API, PROVIDER_PRESETS } from '@agentbox/shared';
import type { AiKeyRow } from './store.ts';

/** Where a key's OpenAI-compatible API is: `<base>/chat/completions`, `<base>/models` … */
export type OpenaiRoute = { base: string } | { refused: string };

/** Why each subscription login is not offered as an API. */
const NOT_AN_API: Partial<Record<AiKeyRow['auth'], string>> = {
  'anthropic-oauth':
    'a Claude Pro/Max subscription token may only be used in Claude Code and Anthropic’s own apps, not as an API for other programs. Use an Anthropic API key instead.',
  'codex-login':
    'a ChatGPT login is for Codex only, not an API for other programs. Use an OpenAI API key instead.',
  'grok-login':
    'a SuperGrok login is for the Grok CLI only, not an API for other programs. Use an xAI API key instead.',
  'opencode-login':
    'your OpenCode setup is for OpenCode only. Add the provider you want as an OpenAI Compatible key instead.',
};

function presetLabel(preset: string): string {
  return PROVIDER_PRESETS.find((p) => p.id === preset)?.label.split(' (')[0] ?? preset;
}

export function openaiRoute(key: AiKeyRow): OpenaiRoute {
  const why = NOT_OPENAI_API.includes(key.auth)
    ? (NOT_AN_API[key.auth] ?? 'not offered as an API.')
    : null;
  if (why) return { refused: `“${key.slug}” (${presetLabel(key.preset)}): ${why}` };
  const up = key.upstream.replace(/\/+$/, '');
  switch (key.auth) {
    // Anthropic's own OpenAI-compatible address.
    case 'x-api-key':
      return { base: `${up}/v1` };
    // Google's OpenAI-compatible address for Gemini.
    case 'x-goog-api-key':
      return { base: `${up}/v1beta/openai` };
    default:
      break;
  }
  // The address is already the OpenAI base URL, as OpenCode uses it.
  if (key.preset === 'openai-compatible' || key.preset === 'custom') return { base: up };
  // A Moonshot key saved for Claude Code: the same key works at Moonshot's /v1.
  if (/\/anthropic$/.test(up)) return { base: up.replace(/\/anthropic$/, '/v1') };
  return { base: `${up}/v1` };
}

/** OpenAI's API paths that agentbox passes on (all JSON, all name a model). */
export const OPENAI_PATHS = new Set([
  '/chat/completions',
  '/completions',
  '/embeddings',
  '/responses',
  '/moderations',
  '/images/generations',
  '/audio/speech',
]);

export type ModelChoice =
  { key: AiKeyRow; model: string } | { error: string; status: 400 | 403 | 404 };

/**
 * Which of the machine's keys a model name points at. `slug/model` uses that
 * key with that model; `slug` alone uses the model saved on the key. A model
 * without a key in front works when the machine has only one key that fits.
 */
export function chooseKey(
  requested: unknown,
  keys: readonly AiKeyRow[],
  /** Every saved key's address name, so a key that isn't on this pass is named as such. */
  allSlugs: ReadonlySet<string> = new Set(),
): ModelChoice {
  if (typeof requested !== 'string' || !requested.trim()) {
    return {
      status: 400,
      error:
        'say which model to use, as <key address name>/<model>, e.g. anthropic/claude-sonnet-4-5. GET /v1/models lists them.',
    };
  }
  const name = requested.trim();
  const cut = name.indexOf('/');
  const slug = (cut < 0 ? name : name.slice(0, cut)).toLowerCase();
  const rest = cut < 0 ? '' : name.slice(cut + 1);
  const key = keys.find((k) => k.slug === slug);
  if (key) {
    const model = rest || key.model;
    if (!model) {
      return {
        status: 400,
        error: `the “${slug}” key has no model saved. Ask for ${slug}/<model>, or save a model on the key in agentbox → Machines → AI keys.`,
      };
    }
    return { key, model };
  }
  if (allSlugs.has(slug)) {
    return {
      status: 403,
      error: `this machine may not use the “${slug}” key. Allow it in agentbox → Machines.`,
    };
  }
  const usable = keys.filter((k) => 'base' in openaiRoute(k));
  if (usable.length === 1 && usable[0]) return { key: usable[0], model: name };
  return {
    status: 404,
    error: `no key called “${slug}” on this pass. Ask for <key address name>/<model>; GET /v1/models lists the ones this pass may use.`,
  };
}

type Json = Record<string, unknown>;

/**
 * The request as the provider should get it: its own model name, and for a
 * streamed chat, the token counts at the end (so Logs and the daily limit see
 * them). `plain` is the same without that extra, for providers that refuse it.
 */
export function providerBody(
  parsed: Json,
  model: string,
  path: string,
): { body: Buffer; plain: Buffer | null } {
  const out: Json = { ...parsed, model };
  const plain = Buffer.from(JSON.stringify(out));
  const so = parsed['stream_options'];
  const askUsage =
    parsed['stream'] === true &&
    (path === '/chat/completions' || path === '/completions') &&
    !(so && typeof so === 'object' && (so as Json)['include_usage'] === true);
  if (!askUsage) return { body: plain, plain: null };
  out['stream_options'] = {
    ...(so && typeof so === 'object' ? so : {}),
    include_usage: true,
  };
  return { body: Buffer.from(JSON.stringify(out)), plain };
}

export interface OpenaiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/** Model IDs from a provider's models list, in OpenAI's or Anthropic's shape. */
export function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown; models?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
    .map((id) => id.replace(/^models\//, ''));
}
