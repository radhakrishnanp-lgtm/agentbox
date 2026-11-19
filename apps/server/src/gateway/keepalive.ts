/**
 * Keeps slow AI answers alive through Cloudflare and other proxies.
 *
 * Cloudflare (on every plan below Enterprise) gives up on a request when the
 * origin sends nothing for 100 seconds: before the first byte, and between
 * bytes of a stream. A big prompt, extended thinking or a reasoning model
 * (Codex, Grok, Kimi) can easily stay quiet that long, and the CLI then sees
 * "499 Client Closed Request", a 524, or a stream that just stops.
 *
 * For streaming requests the gateway therefore sends a server-sent-events
 * comment (`: agentbox keepalive`) whenever the provider has been quiet for a
 * while. The SSE standard says clients ignore comment lines, and every CLI's
 * SDK does (Anthropic, OpenAI, the AI SDK in OpenCode, Codex's Rust parser);
 * OpenRouter sends the same kind of comment.
 *
 * If the provider hasn't even sent its headers after `firstByteMs`, the
 * gateway answers 200 with an event stream itself and keeps it alive. A
 * provider error that comes later is then sent as an SSE `error` event, which
 * the Anthropic and OpenAI SDKs both turn into a normal API error.
 *
 * Gemini isn't touched: its SDKs read only `data:` lines and can stall on a comment.
 */
import { Transform, type TransformCallback } from 'node:stream';

/** Mutable so tests can make it quick. */
export const keepAliveTiming = {
  /** No headers from the provider after this long: answer 200 and keep the stream alive. */
  firstByteMs: 30_000,
  /** No bytes for this long: send a keepalive comment. Well under Cloudflare's 100 s. */
  idleMs: 20_000,
};

export const KEEPALIVE_COMMENT = ': agentbox keepalive\n\n';

const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** True when the program asked for a server-sent-events answer the gateway may keep alive. */
export function wantsEventStream(
  method: string,
  path: string,
  accept: string | string[] | undefined,
  body: Buffer | undefined,
): boolean {
  if (method !== 'POST') return false;
  // Gemini (generateContent / streamGenerateContent) is left exactly as it is.
  if (/:(stream)?generatecontent$/i.test(path) || /\/v1beta\//.test(path)) return false;
  const acceptText = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  if (acceptText.includes('text/event-stream')) return true;
  if (!body || body.length === 0 || body.length > MAX_JSON_BYTES || body[0] !== 0x7b) return false;
  try {
    return (JSON.parse(body.toString('utf8')) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/** True when the response is a server-sent-events stream. */
export function isEventStream(contentType: string | string[] | undefined): boolean {
  const t = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof t === 'string' && t.toLowerCase().includes('text/event-stream');
}

/**
 * Passes a provider's event stream through unchanged, and adds a keepalive
 * comment when it has been quiet for `idleMs`. A comment only ever goes
 * between two events, never inside one.
 */
export class SseKeepAlive extends Transform {
  #timer: NodeJS.Timeout;
  #lastAt = Date.now();
  /** The last bytes sent, to know whether we're between two events. */
  #tail = '\n\n';

  constructor(idleMs = keepAliveTiming.idleMs) {
    super();
    const every = Math.max(10, Math.floor(idleMs / 4));
    this.#timer = setInterval(() => {
      if (Date.now() - this.#lastAt < idleMs) return;
      if (!(this.#tail.endsWith('\n\n') || this.#tail.endsWith('\r\n\r\n'))) return;
      this.#lastAt = Date.now();
      this.push(KEEPALIVE_COMMENT);
    }, every);
    this.#timer.unref();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (chunk.length > 0) {
      this.#lastAt = Date.now();
      this.#tail = (this.#tail + chunk.subarray(-4).toString('latin1')).slice(-4);
    }
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    clearInterval(this.#timer);
    cb();
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    clearInterval(this.#timer);
    cb(err);
  }
}

/**
 * A provider's error as an SSE `error` event, for when the gateway already
 * answered 200. Shaped like Anthropic's own mid-stream errors; the OpenAI SDK
 * reads the same `error` object.
 */
export function sseErrorEvent(status: number, body: Buffer | string, host: string): string {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  let error: { type: string; message: string } | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const e = parsed.error;
    if (e && typeof e === 'object') {
      const { type, message, ...rest } = e as Record<string, unknown>;
      error = {
        type: typeof type === 'string' ? type : typeType(status),
        message: typeof message === 'string' ? message : `${host} answered ${String(status)}`,
        ...rest,
      };
    } else if (typeof e === 'string') {
      error = { type: typeType(status), message: e };
    }
  } catch {
    // Not JSON: say what came back.
  }
  error ??= {
    type: typeType(status),
    message: `${host} answered ${String(status)}${text.trim() ? `: ${text.trim().slice(0, 300)}` : ''}`,
  };
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`;
}

function typeType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'api_error';
}
