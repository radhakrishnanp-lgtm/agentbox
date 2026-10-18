/// <reference types="node" />
/**
 * The private protocol between agentbox-web and agentbox-termd over termd's
 * Unix socket. Browsers never speak it.
 *
 * Every connection starts with one JSON request line. Control requests get one
 * JSON response line and the connection closes. `attach` gets `{"ok":true}` and
 * then switches to frames: 1 byte type + 4 byte big-endian length + payload.
 */
import type { TerminalPresetId, TerminalSummary, VaultState } from './terminal.ts';

export type TermdRequest =
  | { op: 'overview' }
  | { op: 'create'; name: string; preset: TerminalPresetId; cols: number; rows: number }
  | { op: 'rename'; name: string; to: string }
  | { op: 'kill'; name: string }
  /** The session's text: the screen and its recent history, for copying. */
  | { op: 'capture'; name: string }
  | { op: 'attach'; name: string; cols: number; rows: number }
  | { op: 'vault.init'; password: string }
  | { op: 'vault.unlock'; password: string }
  /** Checks a password without changing anything (before auto-unlock stores it). */
  | { op: 'vault.verify'; password: string }
  | { op: 'vault.lock' }
  | { op: 'vault.reset' }
  /** A short-lived access token from the Grok login in the vault (for machines). */
  | { op: 'grok.token' }
  /** The Codex (ChatGPT) login in the vault: access token and account (for machines). */
  | { op: 'codex.token' }
  /** OpenCode's own Zen/Go key from its login in the vault (for OpenCode on machines). */
  | { op: 'opencode.key' }
  /** The providers set up in OpenCode's own settings in the vault, without their keys. */
  | { op: 'opencode.setup' }
  /** Where one of those providers lives and its key (for the gateway only). */
  | { op: 'opencode.provider'; id: string };

export interface TermdGrokToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface TermdCodexToken {
  token: string;
  /** Sent to ChatGPT as ChatGPT-Account-ID. */
  accountId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface TermdCapture {
  text: string;
}

export interface TermdOpencodeKey {
  key: string;
  /** Which of OpenCode's logins it came from: Zen or Go. */
  provider: 'opencode' | 'opencode-go';
}

/** A provider you set up in OpenCode on agentbox, as machines' OpenCode gets it. */
export interface TermdOpencodeProvider {
  id: string;
  name: string;
  /** The AI SDK package OpenCode uses for it, e.g. @ai-sdk/openai-compatible. */
  npm: string | null;
  /** OpenCode's model settings, by model id, with anything secret left out. */
  models: Record<string, unknown>;
}

export interface TermdOpencodeSetup {
  /** Which Zen/Go login OpenCode has, if any. */
  zen: 'opencode' | 'opencode-go' | null;
  providers: TermdOpencodeProvider[];
  /** OpenCode's chosen model on agentbox, when machines have it too. */
  model: string | null;
  /** Providers in OpenCode's settings that machines can't get: they have no address (baseURL) of their own, or it isn't https. */
  skipped: string[];
}

export interface TermdOpencodeUpstream {
  baseURL: string;
  /** Null for a provider that needs no key (e.g. a model running on this server). */
  key: string | null;
  headers: Record<string, string>;
}

export interface TermdOverview {
  vault: VaultState;
  terminals: TerminalSummary[];
  installed: TerminalPresetId[];
}

export type TermdErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'vault_locked'
  | 'wrong_password'
  | 'busy'
  | 'limit'
  | 'internal';

export type TermdResponse<T = unknown> =
  ({ ok: true } & T) | { ok: false; error: { code: TermdErrorCode; message: string } };

/**
 * Frame types. `pause` / `resume` come from agentbox-web when the browser falls
 * behind, so termd stops reading the terminal at once (tmux then skips frames).
 */
export const TERMD_FRAME = { data: 1, resize: 2, exit: 3, pause: 4, resume: 5 } as const;
export const TERMD_MAX_REQUEST_BYTES = 16 * 1024;
export const TERMD_FRAME_HEADER = 5;
/** A single frame never carries more than this; bigger output is split. */
export const TERMD_MAX_FRAME = 64 * 1024;

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(TERMD_FRAME_HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream back into frames. Throws on a frame that is too big. */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): { type: number; payload: Buffer }[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: { type: number; payload: Buffer }[] = [];
    while (this.#buf.length >= TERMD_FRAME_HEADER) {
      const len = this.#buf.readUInt32BE(1);
      if (len > TERMD_MAX_FRAME) throw new Error('frame too large');
      if (this.#buf.length < TERMD_FRAME_HEADER + len) break;
      out.push({
        type: this.#buf.readUInt8(0),
        payload: this.#buf.subarray(TERMD_FRAME_HEADER, TERMD_FRAME_HEADER + len),
      });
      this.#buf = this.#buf.subarray(TERMD_FRAME_HEADER + len);
    }
    return out;
  }
}
