/**
 * tmux sessions for agentbox. Every name is passed to tmux as a single argument
 * with an exact-match target (=name), never through a shell.
 */
import {
  TERMINAL_LIMITS,
  TERMINAL_PRESETS,
  terminalNameSchema,
  type TerminalPresetId,
  type TerminalSummary,
} from '@agentbox/shared';
import type { TermdConfig } from './config.ts';
import { run } from './run.ts';

export class TermdError extends Error {
  readonly code: 'bad_request' | 'not_found' | 'conflict' | 'limit' | 'internal';
  constructor(code: TermdError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const PRESET_OPTION = '@agentbox_preset';
// tmux escapes control characters in -F output, so use a printable separator.
// Session names and presets can't contain it; the command comes last.
const SEP = '|';

export function checkName(name: unknown): string {
  const parsed = terminalNameSchema.safeParse(name);
  if (!parsed.success) throw new TermdError('bad_request', 'That session name is not allowed.');
  return parsed.data;
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const n = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  return { cols: n(cols, 10, 500, 80), rows: n(rows, 4, 200, 24) };
}

export class Tmux {
  readonly #config: TermdConfig;
  readonly #env: NodeJS.ProcessEnv;

  constructor(config: TermdConfig, env: NodeJS.ProcessEnv) {
    this.#config = config;
    this.#env = env;
  }

  /** Arguments that select agentbox's own tmux server and settings. */
  baseArgs(): string[] {
    return ['-L', this.#config.tmuxSocketName, '-f', this.#config.tmuxConf];
  }

  async #tmux(args: string[], timeoutMs = 10_000) {
    return run('tmux', [...this.baseArgs(), ...args], {
      env: this.#env,
      cwd: this.#config.home,
      timeoutMs,
    });
  }

  async list(): Promise<TerminalSummary[]> {
    const format = [
      '#{session_name}',
      '#{session_created}',
      '#{session_activity}',
      '#{session_attached}',
      `#{${PRESET_OPTION}}`,
      '#{pane_current_command}',
    ].join(SEP);
    const res = await this.#tmux(['list-sessions', '-F', format]);
    // No server yet (or it just exited) means no sessions.
    if (res.code !== 0) return [];
    const presets = new Set<string>(TERMINAL_PRESETS.map((p) => p.id));
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', created = '0', activity = '0', attached = '0', preset = '', ...rest] =
          line.split(SEP);
        const command = rest.join(SEP);
        return {
          name,
          preset: (presets.has(preset) ? preset : 'shell') as TerminalPresetId,
          createdAt: new Date(Number(created) * 1000).toISOString(),
          lastActivityAt: new Date(Number(activity) * 1000).toISOString(),
          attached: Number(attached) || 0,
          command,
        };
      })
      .filter((t) => terminalNameSchema.safeParse(t.name).success)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async exists(name: string): Promise<boolean> {
    return (await this.#tmux(['has-session', '-t', `=${name}`])).code === 0;
  }

  async create(name: string, preset: TerminalPresetId, cols: number, rows: number): Promise<void> {
    const existing = await this.list();
    if (existing.some((t) => t.name === name)) {
      throw new TermdError('conflict', `A session called "${name}" already exists.`);
    }
    if (existing.length >= TERMINAL_LIMITS.maxTerminals) {
      throw new TermdError(
        'limit',
        `You can have up to ${TERMINAL_LIMITS.maxTerminals} sessions. Close one first.`,
      );
    }
    const spec = TERMINAL_PRESETS.find((p) => p.id === preset);
    if (!spec) throw new TermdError('bad_request', 'Unknown preset.');
    const shell = this.#config.shell;
    // The preset command is a fixed word from the allowlist, never user input.
    // When the CLI exits, a normal shell stays open in the session.
    // Not login shells: /etc/profile can reset PATH and drop ~/.local/bin.
    const program = spec.command ? [shell, '-c', `${spec.command}; exec ${shell}`] : [shell];
    const res = await this.#tmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-x',
      String(cols),
      '-y',
      String(rows),
      '-c',
      this.#config.home,
      '--',
      ...program,
    ]);
    if (res.code !== 0) {
      throw new TermdError('internal', `tmux could not start the session: ${res.stderr.trim()}`);
    }
    // set-option takes a pane target, so the exact-match session needs a trailing colon.
    await this.#tmux(['set-option', '-t', `=${name}:`, PRESET_OPTION, preset]);
  }

  async rename(name: string, to: string): Promise<void> {
    if (!(await this.exists(name))) throw new TermdError('not_found', 'No such session.');
    if (await this.exists(to)) {
      throw new TermdError('conflict', `A session called "${to}" already exists.`);
    }
    const res = await this.#tmux(['rename-session', '-t', `=${name}`, to]);
    if (res.code !== 0) throw new TermdError('internal', 'tmux could not rename the session.');
  }

  async kill(name: string): Promise<void> {
    if (!(await this.exists(name))) throw new TermdError('not_found', 'No such session.');
    await this.#tmux(['kill-session', '-t', `=${name}`]);
  }

  /** Stops every session (used before locking the vault). */
  async killServer(): Promise<void> {
    await this.#tmux(['kill-server']);
  }

  /** Which preset CLIs the dev user can run, using the terminals' PATH. */
  async installed(): Promise<TerminalPresetId[]> {
    const names = TERMINAL_PRESETS.flatMap((p) => (p.command ? [p.command] : []));
    const res = await run(
      this.#config.shell,
      [
        '-c',
        'for c in "$@"; do command -v -- "$c" >/dev/null 2>&1 && echo "$c"; done',
        'sh',
        ...names,
      ],
      { env: this.#env, cwd: this.#config.home, timeoutMs: 8000 },
    );
    const found = new Set(res.stdout.split('\n').map((l) => l.trim()));
    return TERMINAL_PRESETS.filter((p) => p.command && found.has(p.command)).map((p) => p.id);
  }
}
