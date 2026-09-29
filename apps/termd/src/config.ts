import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TermdConfig {
  /** termd's Unix socket; agentbox-web connects here. */
  socket: string;
  /** HOME for every terminal. With the vault on, the vault is mounted here. */
  home: string;
  /** Encrypted vault folder, or null when the vault is disabled (tests, development). */
  vaultCipher: string | null;
  /** tmux server name (tmux -L). */
  tmuxSocketName: string;
  tmuxConf: string;
  /** Extra PATH entries after ~/.local/bin, e.g. agentbox's Node.js. */
  pathExtra: string[];
  shell: string;
  /** Environment variables passed through to terminals as they are (e.g. proxy settings). */
  passEnv: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadTermdConfig(env: NodeJS.ProcessEnv = process.env): TermdConfig {
  const vault = env['AGENTBOX_TERMD_VAULT'] ?? '/var/lib/agentbox-vault/cipher';
  const home = env['AGENTBOX_TERMD_HOME'] ?? env['HOME'] ?? '/home/dev';
  for (const [name, value] of [
    ['AGENTBOX_TERMD_HOME', home],
    ['AGENTBOX_TERMD_VAULT', vault],
  ] as const) {
    if (value !== 'none' && !value.startsWith('/')) {
      throw new Error(`agentbox-termd: ${name} must be an absolute path.`);
    }
  }
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(/[:,\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
  return {
    socket: env['AGENTBOX_TERMD_SOCKET'] ?? '/run/agentbox-termd/termd.sock',
    home,
    vaultCipher: vault === 'none' ? null : vault,
    tmuxSocketName: env['AGENTBOX_TERMD_TMUX'] ?? 'agentbox',
    tmuxConf: env['AGENTBOX_TERMD_TMUX_CONF'] ?? join(here, 'tmux.conf'),
    pathExtra: list(env['AGENTBOX_TERMD_PATH_EXTRA']),
    shell: env['AGENTBOX_TERMD_SHELL'] ?? '/bin/bash',
    passEnv: list(env['AGENTBOX_TERMD_PASS_ENV']).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)),
  };
}

/**
 * The environment every terminal starts with. It is built from scratch, so
 * nothing from termd's own environment leaks into the CLIs.
 */
export function terminalEnv(config: TermdConfig, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const user = source['USER'] ?? source['LOGNAME'] ?? 'dev';
  const env: NodeJS.ProcessEnv = {
    HOME: config.home,
    USER: user,
    LOGNAME: user,
    SHELL: config.shell,
    PATH: [
      join(config.home, '.local/bin'),
      ...config.pathExtra,
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'),
    LANG: source['LANG'] ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const name of config.passEnv) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
