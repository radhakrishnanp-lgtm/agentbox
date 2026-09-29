/**
 * A stand-in AI provider on 127.0.0.1 that records every request and answers
 * in Anthropic, OpenAI or Gemini format. Used to prove what the gateway sends
 * upstream without any real key.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export class FakeProvider {
  readonly seen: SeenRequest[] = [];
  /** Set when a slow stream's request was closed by the gateway. */
  slowClosed = false;
  /** Set when a request that never got an answer was closed by the gateway. */
  hangClosed = false;
  #server: Server;
  url = '';

  constructor() {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        const path = (req.url ?? '').split('?')[0] ?? '';
        const json = (status: number, value: unknown, extra: Record<string, string> = {}) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            'set-cookie': 'tracker=1',
            'request-id': 'req_fake',
            ...extra,
          });
          res.end(JSON.stringify(value));
        };
        if (path === '/v1/messages') {
          const parsed = JSON.parse(body || '{}') as { stream?: boolean; model?: string };
          if (parsed.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const events: [string, unknown][] = [
              [
                'message_start',
                {
                  type: 'message_start',
                  message: {
                    id: 'msg_1',
                    type: 'message',
                    role: 'assistant',
                    model: parsed.model,
                    content: [],
                    usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 1 },
                  },
                },
              ],
              [
                'content_block_start',
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                },
              ],
              [
                'content_block_delta',
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'Hello from the fake provider' },
                },
              ],
              ['content_block_stop', { type: 'content_block_stop', index: 0 }],
              [
                'message_delta',
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: 7 },
                },
              ],
              ['message_stop', { type: 'message_stop' }],
            ];
            for (const [event, data] of events)
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            res.end();
            return;
          }
          json(200, {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [{ type: 'text', text: 'Hello from the fake provider' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          });
          return;
        }
        if (path === '/v1/chat/completions') {
          json(200, {
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          });
          return;
        }
        if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(path)) {
          json(200, {
            candidates: [{ content: { parts: [{ text: 'hi' }], role: 'model' } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
          });
          return;
        }
        if (path === '/slow') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const timer = setInterval(() => res.write('data: {"type":"ping"}\n\n'), 50);
          res.on('close', () => {
            clearInterval(timer);
            this.slowClosed = true;
          });
          return;
        }
        if (path === '/hang') {
          // Never answers; the gateway should give up when the machine does.
          res.on('close', () => {
            this.hangClosed = true;
          });
          return;
        }
        if (path === '/big') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.alloc(3 * 1024 * 1024, 7));
          return;
        }
        json(404, {
          type: 'error',
          error: { type: 'not_found_error', message: 'no such path' },
        });
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  last(): SeenRequest {
    const r = this.seen.at(-1);
    if (!r) throw new Error('the fake provider saw no request');
    return r;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.#server.close(() => {
        resolve();
      }),
    );
  }
}
