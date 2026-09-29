/**
 * Reads token counts from provider responses as they stream past, without
 * keeping the content. Understands Anthropic Messages, OpenAI Chat
 * Completions and Responses, and Gemini, both as JSON and as SSE streams.
 */

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;

export class UsageMeter {
  readonly #sse: boolean;
  #input: number | null = null;
  #output: number | null = null;
  #line = '';
  #json: Buffer[] = [];
  #jsonBytes = 0;
  #overflow = false;
  readonly #decoder = new TextDecoder();

  constructor(contentType: string | undefined) {
    this.#sse = (contentType ?? '').includes('text/event-stream');
    const isJson = (contentType ?? '').includes('json');
    if (!this.#sse && !isJson) this.#overflow = true;
  }

  push(chunk: Buffer): void {
    if (this.#overflow) return;
    if (!this.#sse) {
      this.#jsonBytes += chunk.length;
      if (this.#jsonBytes > MAX_JSON_BYTES) {
        this.#overflow = true;
        this.#json = [];
        return;
      }
      this.#json.push(chunk);
      return;
    }
    this.#line += this.#decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.#line.indexOf('\n')) >= 0) {
      this.#sseLine(this.#line.slice(0, nl));
      this.#line = this.#line.slice(nl + 1);
    }
    if (this.#line.length > MAX_LINE_BYTES) this.#line = '';
  }

  finish(): Usage {
    if (this.#sse) {
      if (this.#line) this.#sseLine(this.#line);
    } else if (!this.#overflow && this.#json.length) {
      try {
        this.#read(JSON.parse(Buffer.concat(this.#json).toString('utf8')) as unknown);
      } catch {
        // Not JSON after all; usage stays unknown.
      }
    }
    return { inputTokens: this.#input, outputTokens: this.#output };
  }

  #sseLine(raw: string): void {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]' || data[0] !== '{') return;
    try {
      this.#read(JSON.parse(data) as unknown);
    } catch {
      // Ignore a malformed event.
    }
  }

  #read(value: unknown): void {
    const v = obj(value);
    if (!v) return;
    const type = typeof v['type'] === 'string' ? v['type'] : '';
    const response = obj(v['response']);
    if (type === 'message_start') {
      // Anthropic stream: input on message_start, running output on message_delta.
      this.#anthropic(obj(obj(v['message'])?.['usage']));
    } else if (type === 'message_delta' || type === 'message') {
      this.#anthropic(obj(v['usage']));
    } else if (type.startsWith('response.') && response) {
      // OpenAI Responses stream: response.completed carries the final usage.
      this.#openai(obj(response['usage']));
    } else {
      // OpenAI JSON bodies and chat stream chunks.
      this.#openai(obj(v['usage']));
    }
    const meta = obj(v['usageMetadata']);
    if (meta) {
      // Gemini.
      const input = num(meta['promptTokenCount']);
      const out = (num(meta['candidatesTokenCount']) ?? 0) + (num(meta['thoughtsTokenCount']) ?? 0);
      if (input !== null) this.#input = input;
      if (out > 0 || this.#output === null) this.#output = out;
    }
  }

  #anthropic(u: Json | null): void {
    if (!u) return;
    const input = num(u['input_tokens']);
    if (input !== null) {
      this.#input =
        input +
        (num(u['cache_creation_input_tokens']) ?? 0) +
        (num(u['cache_read_input_tokens']) ?? 0);
    }
    const out = num(u['output_tokens']);
    if (out !== null) this.#output = out;
  }

  #openai(u: Json | null): void {
    if (!u) return;
    const input = num(u['prompt_tokens']) ?? num(u['input_tokens']);
    const out = num(u['completion_tokens']) ?? num(u['output_tokens']);
    if (input !== null) this.#input = input;
    if (out !== null) this.#output = out;
  }
}

/** The `model` field of a JSON request body, or the model in a Gemini path. */
export function requestModel(body: Buffer | undefined, path: string): string | null {
  const gemini = /\/models\/([A-Za-z0-9._-]{1,100}):/.exec(path);
  if (gemini?.[1]) return gemini[1];
  if (!body || body.length === 0 || body.length > MAX_JSON_BYTES || body[0] !== 0x7b) return null;
  try {
    const model = (JSON.parse(body.toString('utf8')) as Json)['model'];
    return typeof model === 'string' ? model.slice(0, 100) : null;
  } catch {
    return null;
  }
}
