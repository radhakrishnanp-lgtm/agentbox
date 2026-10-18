/**
 * OpenCode's own key in the vault, for OpenCode on machines.
 *
 * `opencode auth login` keeps its logins in ~/.local/share/opencode/auth.json,
 * one entry per provider. Only an API key for OpenCode's own services, Zen
 * (`opencode`) or Go (`opencode-go`), is ever handed out. Sign-ins to other
 * providers (Claude, ChatGPT, Copilot and the like) are never read: their
 * providers allow them only in their own apps.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  TermdOpencodeKey,
  TermdOpencodeProvider,
  TermdOpencodeSetup,
  TermdOpencodeUpstream,
} from '@agentbox/shared/termd';
import { TermdError } from './tmux.ts';

/** In order of preference. */
const PROVIDERS = ['opencode', 'opencode-go'] as const;
const KEY = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

/** OpenCode's Zen or Go key in an auth.json, or the providers it is signed in to instead. */
export function readOpencodeKey(text: string): TermdOpencodeKey | { others: string[] } {
  let store: unknown;
  try {
    store = JSON.parse(text);
  } catch {
    return { others: [] };
  }
  if (!store || typeof store !== 'object' || Array.isArray(store)) return { others: [] };
  const entries = store as Record<string, unknown>;
  for (const provider of PROVIDERS) {
    const entry = entries[provider];
    if (!entry || typeof entry !== 'object') continue;
    const { type, key } = entry as { type?: unknown; key?: unknown };
    if (type === 'api' && typeof key === 'string' && KEY.test(key)) return { key, provider };
  }
  const others = Object.keys(entries)
    .filter((name) => /^[A-Za-z0-9._-]{1,60}$/.test(name))
    .slice(0, 10);
  return { others };
}

export class OpencodeLogin {
  readonly #path: string;

  constructor(home: string, env: NodeJS.ProcessEnv = {}) {
    const data = env['XDG_DATA_HOME'] || join(home, '.local', 'share');
    this.#path = join(data, 'opencode', 'auth.json');
  }

  key(): TermdOpencodeKey {
    const found = existsSync(this.#path)
      ? readOpencodeKey(readFileSync(this.#path, 'utf8'))
      : { others: [] };
    if ('key' in found) return { key: found.key, provider: found.provider };
    if (found.others.length > 0) {
      throw new TermdError(
        'not_found',
        `OpenCode on agentbox is signed in only with ${found.others.join(', ')}. agentbox can pass on only an OpenCode Zen or Go key: open a terminal in agentbox, run opencode auth login and pick OpenCode Zen.`,
      );
    }
    throw new TermdError(
      'not_found',
      'OpenCode is not signed in on agentbox. Open a terminal in agentbox, run opencode auth login and pick OpenCode Zen.',
    );
  }
}

/** Providers machines' OpenCode already knows, or gets from agentbox some other way. */
const BUILT_IN = new Set<string>(PROVIDERS);
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
/** Fields of a model's settings that are never sent to machines. */
const SECRET_FIELD = /key|secret|token|password|auth|header|cookie/i;
/** OpenCode fills these in from this server's files or environment; machines can't. */
const SUBSTITUTION = /\{(?:env|file):/;

/** JSON with comments and trailing commas, as OpenCode reads its settings. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else {
      out += c ?? '';
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const old = out[k];
    out[k] = isObject(old) && isObject(v) ? merge(old, v) : v;
  }
  return out;
}

/** A model's settings without anything secret or anything only this server can fill in. */
function clean(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return SUBSTITUTION.test(value) ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => clean(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (!isObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELD.test(k)) continue;
    const c = clean(v, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** An address the gateway may send your requests to: https, or http on this server itself. */
export function allowedBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.href.replace(/\/+$/, '');
}

/**
 * The providers you set up in OpenCode on agentbox (its settings files and its
 * logins), as machines' OpenCode gets them through the gateway.
 */
export class OpencodeSetup {
  readonly #home: string;
  readonly #configDir: string;
  readonly #login: OpencodeLogin;
  readonly #authPath: string;

  constructor(home: string, env: NodeJS.ProcessEnv = {}) {
    this.#home = home;
    this.#configDir = join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'opencode');
    this.#login = new OpencodeLogin(home, env);
    const data = env['XDG_DATA_HOME'] || join(home, '.local', 'share');
    this.#authPath = join(data, 'opencode', 'auth.json');
  }

  /** OpenCode's settings, merged in the order OpenCode reads them. */
  #config(): Record<string, unknown> {
    let config: Record<string, unknown> = {};
    for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
      const path = join(this.#configDir, name);
      if (!existsSync(path)) continue;
      try {
        const parsed = parseJsonc(readFileSync(path, 'utf8'));
        if (isObject(parsed)) config = merge(config, parsed);
      } catch {
        // OpenCode itself complains about a broken file; skip it here.
      }
    }
    return config;
  }

  #auth(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#authPath, 'utf8'));
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** The providers that have their own address, so the gateway can reach them. */
  #providers(skipped: string[] = []): Map<string, Record<string, unknown>> {
    const found = new Map<string, Record<string, unknown>>();
    const providers = this.#config()['provider'];
    if (!isObject(providers)) return found;
    for (const [id, p] of Object.entries(providers)) {
      if (!PROVIDER_ID.test(id) || BUILT_IN.has(id) || !isObject(p)) continue;
      const options = isObject(p['options']) ? p['options'] : {};
      if (!allowedBaseUrl(options['baseURL'] ?? p['api']) || found.size >= 20) {
        if (skipped.length < 10) skipped.push(id);
        continue;
      }
      found.set(id, p);
    }
    return found;
  }

  setup(): TermdOpencodeSetup {
    let zen: TermdOpencodeSetup['zen'];
    try {
      zen = this.#login.key().provider;
    } catch {
      zen = null;
    }
    const providers: TermdOpencodeProvider[] = [];
    const skipped: string[] = [];
    for (const [id, p] of this.#providers(skipped)) {
      const models = clean(isObject(p['models']) ? p['models'] : {});
      providers.push({
        id,
        name: typeof p['name'] === 'string' ? p['name'].slice(0, 80) : id,
        npm:
          typeof p['npm'] === 'string' && /^[@a-z0-9/._-]{1,100}$/.test(p['npm']) ? p['npm'] : null,
        models: isObject(models) ? models : {},
      });
    }
    const model = this.#config()['model'];
    const shared = new Set(['opencode', ...providers.map((p) => p.id)]);
    if (zen) shared.add(zen);
    return {
      zen,
      providers,
      model:
        typeof model === 'string' && shared.has(model.split('/')[0] ?? '') && model.length <= 200
          ? model
          : null,
      skipped,
    };
  }

  /** Where one shared provider lives, and its key. */
  provider(id: string): TermdOpencodeUpstream {
    const p = this.#providers().get(id);
    if (!p) {
      throw new TermdError(
        'not_found',
        `OpenCode on agentbox has no provider called ${PROVIDER_ID.test(id) ? id : 'that'} with its own address.`,
      );
    }
    const options = isObject(p['options']) ? p['options'] : {};
    const baseURL = allowedBaseUrl(options['baseURL'] ?? p['api']) as string;
    const headers: Record<string, string> = {};
    if (isObject(options['headers'])) {
      for (const [k, v] of Object.entries(options['headers'])) {
        if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string') {
          const value = this.#resolve(v);
          if (value !== null && !/[\r\n]/.test(value)) headers[k] = value;
        }
      }
    }
    let key = typeof options['apiKey'] === 'string' ? this.#resolve(options['apiKey']) : null;
    if (key === null) {
      const entry = this.#auth()[id];
      if (isObject(entry) && entry['type'] === 'api' && typeof entry['key'] === 'string') {
        key = entry['key'];
      }
    }
    if (key !== null && (key.length > 4096 || /[\r\n]/.test(key))) key = null;
    return { baseURL, key: key || null, headers };
  }

  /** A setting as OpenCode would read it: as written, or from a file in your home folder. */
  #resolve(value: string): string | null {
    const file = /^\{file:(.+)\}$/.exec(value.trim());
    if (file?.[1]) {
      const raw = file[1].trim();
      const path = raw.startsWith('~/')
        ? join(this.#home, raw.slice(2))
        : isAbsolute(raw)
          ? raw
          : resolve(this.#configDir, raw);
      const real = resolve(path);
      if (!real.startsWith(`${resolve(this.#home)}/`) || !existsSync(real)) return null;
      try {
        return readFileSync(real, 'utf8').trim();
      } catch {
        return null;
      }
    }
    // A key from this server's environment: machines' requests can't use it.
    if (SUBSTITUTION.test(value)) return null;
    return value;
  }
}
