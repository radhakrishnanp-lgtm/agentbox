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
import { join } from 'node:path';
import type { TermdOpencodeKey } from '@agentbox/shared/termd';
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
