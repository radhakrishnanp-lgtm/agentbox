/**
 * OpenCode settings for a machine. OpenCode talks to many providers, so one
 * config file wires all of the machine's keys at once: each provider points at
 * this agentbox's gateway and signs in with the machine's pass, which OpenCode
 * reads from a file next to the config (`{file:pass}`), never from the config.
 *
 * Subscription logins (Claude Pro/Max, ChatGPT, SuperGrok) are left out on
 * purpose: their providers allow them only in their own apps. OpenCode's own
 * Zen/Go key (the "OpenCode from your Terminals" key) is the exception: it is
 * OpenCode's own service, and it is wired into OpenCode only. The same key also
 * brings the providers you set up in OpenCode on agentbox itself: machines get
 * their models, and their requests go through the gateway, which adds the key.
 */
import type { TermdOpencodeSetup } from '@agentbox/shared/termd';
import type { AiKeyRow } from './store.ts';

/** OpenCode replaces this with the pass file's contents. The setup script puts the file there. */
export const OPENCODE_PASS = '{file:pass}';

interface Provider {
  name?: string;
  npm?: string;
  options: { baseURL: string; apiKey: string; headers: Record<string, string> };
  models?: Record<string, unknown>;
}

export interface OpencodeConfig {
  $schema: string;
  provider: Record<string, Provider>;
  enabled_providers: string[];
  model?: string;
  autoupdate: false;
  share: 'disabled';
}

/** How each preset reaches OpenCode: one of its own providers, or a generic one that needs a model. */
const ROUTES: Record<
  string,
  { builtIn?: string; npm: string; path: string; needsModel?: boolean } | undefined
> = {
  anthropic: { builtIn: 'anthropic', npm: '@ai-sdk/anthropic', path: '/v1' },
  openai: { builtIn: 'openai', npm: '@ai-sdk/openai', path: '/v1' },
  xai: { builtIn: 'xai', npm: '@ai-sdk/xai', path: '/v1' },
  gemini: { builtIn: 'google', npm: '@ai-sdk/google', path: '/v1beta' },
  openrouter: { builtIn: 'openrouter', npm: '@openrouter/ai-sdk-provider', path: '/v1' },
  moonshot: { npm: '@ai-sdk/openai-compatible', path: '/v1', needsModel: true },
  'kimi-code': { npm: '@ai-sdk/openai-compatible', path: '/v1', needsModel: true },
  'moonshot-anthropic': { npm: '@ai-sdk/anthropic', path: '/v1', needsModel: true },
  // "Other provider": any OpenAI-compatible API. Its address is used as the
  // base URL as typed (usually ending in /v1), so the model must be named.
  custom: { npm: '@ai-sdk/openai-compatible', path: '', needsModel: true },
};

/**
 * OpenCode's own free models need no key and no login. Without a Zen/Go key on
 * the machine they stay on, and OpenCode reaches opencode.ai for them directly:
 * there is no key of yours to protect, so they don't go through agentbox.
 */
const FREE_MODELS = 'opencode';

/** Only these key kinds. Subscription logins never go to OpenCode. */
const API_KEY_AUTH = new Set<AiKeyRow['auth']>(['x-api-key', 'bearer', 'x-goog-api-key']);

/**
 * OpenCode's own services, as OpenCode knows them (Zen and Go), and where each
 * lives under the key's upstream (https://opencode.ai/inference).
 */
const OPENCODE_SERVICES = [
  { id: 'opencode', path: '/v1' },
  { id: 'opencode-go', path: '/go/v1' },
] as const;

/** Where a provider set up in OpenCode on agentbox is, under the key's gateway address. */
export const OPENCODE_PROVIDER_PATH = '/p/';

/**
 * The machine's OpenCode settings: its keys that work with OpenCode, and OpenCode's
 * free models. `setup` is what OpenCode on agentbox has (null when the vault is
 * locked: then Zen and Go go through the gateway, which explains the lock).
 */
export function opencodeConfig(
  keys: readonly AiKeyRow[],
  gatewayUrl: (slug: string) => string,
  setup: TermdOpencodeSetup | null = null,
): OpencodeConfig {
  const provider: Record<string, Provider> = {};
  let model: string | undefined;
  for (const k of keys) {
    if (k.auth === 'opencode-login') {
      const headers = { 'X-Agentbox-Computer': '{env:AGENTBOX_COMPUTER}' };
      // OpenCode's built-in providers: their model lists come with OpenCode.
      // Without a Zen/Go login on agentbox, the free models go direct instead.
      if (!setup || setup.zen) {
        for (const service of OPENCODE_SERVICES) {
          if (service.id in provider) continue;
          provider[service.id] = {
            options: {
              baseURL: `${gatewayUrl(k.slug)}${service.path}`,
              apiKey: OPENCODE_PASS,
              headers,
            },
          };
        }
      }
      for (const p of setup?.providers ?? []) {
        if (p.id in provider) continue;
        provider[p.id] = {
          name: p.name,
          ...(p.npm ? { npm: p.npm } : {}),
          options: {
            baseURL: `${gatewayUrl(k.slug)}${OPENCODE_PROVIDER_PATH}${p.id}`,
            apiKey: OPENCODE_PASS,
            headers,
          },
          models: p.models,
        };
      }
      if (model === undefined && setup?.model) model = setup.model;
      continue;
    }
    const route = ROUTES[k.preset];
    if (!route || !API_KEY_AUTH.has(k.auth)) continue;
    const id = route.builtIn && !(route.builtIn in provider) ? route.builtIn : `agentbox-${k.slug}`;
    const custom = id !== route.builtIn;
    // A generic provider knows no models, so it needs the key's.
    if ((custom || route.needsModel) && !k.model) continue;
    provider[id] = {
      name: `${k.name} (agentbox)`,
      ...(custom ? { npm: route.npm } : {}),
      options: {
        baseURL: `${gatewayUrl(k.slug)}${route.path}`,
        apiKey: OPENCODE_PASS,
        // The wrapper reads this computer's ID each time OpenCode starts.
        headers: { 'X-Agentbox-Computer': '{env:AGENTBOX_COMPUTER}' },
      },
      ...(k.model ? { models: { [k.model]: { name: k.model } } } : {}),
    };
    if (model === undefined && k.model) model = `${id}/${k.model}`;
  }
  const ids = Object.keys(provider);
  if (!ids.includes(FREE_MODELS)) ids.push(FREE_MODELS);
  return {
    $schema: 'https://opencode.ai/config.json',
    provider,
    enabled_providers: ids,
    ...(model ? { model } : {}),
    autoupdate: false,
    share: 'disabled',
  };
}
