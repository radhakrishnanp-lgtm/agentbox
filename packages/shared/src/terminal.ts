/**
 * Terminals: tmux sessions run by agentbox-termd as the `dev` user. The web
 * app is the only thing that talks to termd, over a Unix socket.
 */
import { z } from 'zod';

/** Session names are always passed to tmux as one argument, never through a shell. */
export const terminalNameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{1,32}$/, 'Use 1–32 letters, digits, - or _');

/** What a new session starts with. The command for each is fixed; nothing is typed in. */
export const TERMINAL_PRESETS = [
  { id: 'shell', label: 'Shell', command: null },
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'grok', label: 'Grok', command: 'grok' },
  { id: 'kimi', label: 'Kimi', command: 'kimi' },
  { id: 'gemini', label: 'Gemini', command: 'gemini' },
] as const;
export type TerminalPresetId = (typeof TERMINAL_PRESETS)[number]['id'];
export const terminalPresetSchema = z.enum(
  TERMINAL_PRESETS.map((p) => p.id) as [TerminalPresetId, ...TerminalPresetId[]],
);

export const terminalCreateSchema = z.object({
  name: terminalNameSchema,
  preset: terminalPresetSchema.default('shell'),
});
export type TerminalCreate = z.input<typeof terminalCreateSchema>;

export const terminalRenameSchema = z.object({ name: terminalNameSchema });

export interface TerminalSummary {
  name: string;
  preset: TerminalPresetId;
  createdAt: string;
  lastActivityAt: string;
  /** How many browsers (and other tmux clients) are attached right now. */
  attached: number;
  /** The program running in the session's active pane, e.g. "claude" or "bash". */
  command: string;
}

/**
 * The vault is an encrypted folder that holds the dev user's home: CLI logins,
 * settings and installed tools. It is locked after a restart unless auto-unlock is on.
 */
export type VaultState = 'disabled' | 'uninitialized' | 'locked' | 'unlocked';

export interface TerminalOverview {
  /** False when agentbox-termd isn't running or can't be reached. */
  available: boolean;
  vault: VaultState;
  autoUnlock: boolean;
  terminals: TerminalSummary[];
  /** Preset CLIs found on this server's dev user. */
  installed: TerminalPresetId[];
}

export const VAULT_PASSWORD_MIN = 12;
export const vaultPasswordSchema = z
  .string()
  .min(VAULT_PASSWORD_MIN, `Use at least ${VAULT_PASSWORD_MIN} characters`)
  .max(256)
  .refine((v) => !/[\r\n\0]/.test(v), 'The password cannot contain line breaks');

export const vaultInitSchema = z.object({
  password: vaultPasswordSchema,
  autoUnlock: z.boolean().default(false),
});
export const vaultUnlockSchema = z.object({
  password: z.string().min(1).max(256).optional(),
});
export const vaultSettingsSchema = z.object({
  autoUnlock: z.boolean(),
  /** Needed to turn auto-unlock on, because agentbox has to keep a copy. */
  password: z.string().min(1).max(256).optional(),
});
export const vaultResetSchema = z.object({ confirm: z.literal('RESET') });

/** WebSocket limits for /ws/terminal/:name. */
export const TERMINAL_LIMITS = {
  maxFrameBytes: 64 * 1024,
  inputBytesPerSecond: 256 * 1024,
  /**
   * Output the browser has not drawn yet; above this, reading from the terminal pauses.
   * Kept small so a busy screen can't queue seconds of stale output ahead of the echo
   * of what you type: tmux skips the frames instead.
   */
  unackedHighBytes: 128 * 1024,
  unackedLowBytes: 32 * 1024,
  maxTerminals: 20,
} as const;

/** Browser → server control messages (text frames). Keystrokes go as binary frames. */
export type TerminalClientMessage =
  { t: 'resize'; cols: number; rows: number } | { t: 'ack'; bytes: number };

/** Server → browser control messages (text frames). Output goes as binary frames. */
export type TerminalServerMessage = { t: 'exit'; reason: string } | { t: 'ready' };
