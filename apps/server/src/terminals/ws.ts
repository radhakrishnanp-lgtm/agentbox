/**
 * The browser side of a terminal: /ws/terminal/:name.
 *
 * - Same origin only, a valid session on an approved device, and at most
 *   10 connects a minute.
 * - The session is re-checked every 30 s, and the connection is cut the moment
 *   the session ends (sign-out, revoke, timeout).
 * - Keystrokes count as activity; input is capped at 256 KB/s.
 * - Output is paused while the browser has too much unconfirmed data (acks).
 */
import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  TERMINAL_LIMITS,
  terminalNameSchema,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@agentbox/shared';
import { FrameDecoder, TERMD_FRAME, encodeFrame } from '@agentbox/shared/termd';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../services.ts';
import { TermdRefused } from './client.ts';

/** Close codes the UI understands (4000–4999 are free for applications). */
export const WS_CLOSE = {
  ended: 1000,
  signedOut: 4401,
  forbidden: 4403,
  notFound: 4404,
  locked: 4409,
  tooFast: 4429,
  unavailable: 4503,
} as const;

const RECHECK_MS = 30_000;

const clientMessage: z.ZodType<TerminalClientMessage> = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({ t: z.literal('ack'), bytes: z.number().int().min(0).max(1e9) }),
]);
const TOUCH_EVERY_MS = 15_000;

export function terminalSocketRoutes(s: Services): FastifyPluginAsync {
  return async (app) => {
    await app.register(websocket, {
      options: { maxPayload: TERMINAL_LIMITS.maxFrameBytes, perMessageDeflate: false },
    });

    app.get(
      '/ws/terminal/:name',
      {
        websocket: true,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        preValidation: async (request) => {
          // Cross-site WebSocket hijacking: the browser always sends Origin.
          if (request.headers.origin !== s.config.origin) {
            throw new AppError('forbidden', 'Wrong origin.');
          }
          request.auth = s.sessions.authenticate(request, true);
        },
      },
      (ws, request) => {
        const auth = request.auth;
        const params = request.params as { name?: unknown };
        const query = request.query as { cols?: unknown; rows?: unknown };
        const name = terminalNameSchema.safeParse(params.name);
        if (!auth || !name.success) {
          ws.close(WS_CLOSE.notFound, 'No such session.');
          return;
        }
        void bridge(s, ws, {
          sessionId: auth.sessionId,
          name: name.data,
          cols: Number(query.cols) || 80,
          rows: Number(query.rows) || 24,
          actor: `device:${auth.deviceId}`,
          ip: request.ip,
        });
      },
    );
  };
}

interface BridgeOptions {
  sessionId: string;
  name: string;
  cols: number;
  rows: number;
  actor: string;
  ip: string;
}

async function bridge(s: Services, ws: WebSocket, o: BridgeOptions): Promise<void> {
  const send = (msg: TerminalServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const closeWith = (code: number, reason: string) => {
    send({ t: 'exit', reason });
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
  };

  let attached;
  try {
    attached = await s.terminals.client.attach(o.name, o.cols, o.rows);
  } catch (err) {
    if (err instanceof TermdRefused) {
      const code =
        err.code === 'not_found'
          ? WS_CLOSE.notFound
          : err.code === 'vault_locked'
            ? WS_CLOSE.locked
            : WS_CLOSE.unavailable;
      closeWith(code, err.message);
    } else {
      closeWith(WS_CLOSE.unavailable, 'The terminal service is not running on this server.');
    }
    return;
  }
  const { socket: term, rest } = attached;
  if (ws.readyState !== ws.OPEN) {
    term.destroy();
    return;
  }
  s.terminals.opened(o.name, { actor: o.actor, ip: o.ip });
  send({ t: 'ready' });

  let unacked = 0;
  let paused = false;
  let lastTouch = s.clock.now();
  let bucket = TERMINAL_LIMITS.inputBytesPerSecond;
  let bucketAt = Date.now();
  let done = false;

  const finish = (code: number, reason: string) => {
    if (done) return;
    done = true;
    clearInterval(recheck);
    stopListening();
    term.destroy();
    closeWith(code, reason);
  };

  const recheck = setInterval(() => {
    if (!s.sessions.check(o.sessionId)) finish(WS_CLOSE.signedOut, 'Your session ended.');
  }, RECHECK_MS);
  const stopListening = s.sessions.onEnd((ended) => {
    if (ended === o.sessionId) finish(WS_CLOSE.signedOut, 'Your session ended.');
  });

  const decoder = new FrameDecoder();
  const onTermData = (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      finish(WS_CLOSE.unavailable, 'The terminal service sent something unexpected.');
      return;
    }
    for (const f of frames) {
      if (f.type === TERMD_FRAME.data) {
        ws.send(f.payload);
        unacked += f.payload.length;
      } else if (f.type === TERMD_FRAME.exit) {
        finish(WS_CLOSE.ended, 'The session ended.');
        return;
      }
    }
    if (!paused && unacked > TERMINAL_LIMITS.unackedHighBytes) {
      paused = true;
      term.pause();
    }
  };
  if (rest.length) onTermData(rest);
  term.on('data', onTermData);
  term.on('close', () => {
    finish(WS_CLOSE.ended, 'The session ended.');
  });
  term.on('error', () => {
    finish(WS_CLOSE.unavailable, 'Lost the connection to the terminal service.');
  });

  ws.on('message', (data, isBinary) => {
    if (done) return;
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (isBinary) {
      // Keystrokes and pastes.
      const now = Date.now();
      bucket = Math.min(
        TERMINAL_LIMITS.inputBytesPerSecond,
        bucket + ((now - bucketAt) / 1000) * TERMINAL_LIMITS.inputBytesPerSecond,
      );
      bucketAt = now;
      bucket -= buf.length;
      if (bucket < -TERMINAL_LIMITS.inputBytesPerSecond) {
        finish(WS_CLOSE.tooFast, 'Too much input at once.');
        return;
      }
      term.write(encodeFrame(TERMD_FRAME.data, buf));
      if (s.clock.now() - lastTouch > TOUCH_EVERY_MS) {
        lastTouch = s.clock.now();
        s.sessions.touch(o.sessionId);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    const msg = clientMessage.safeParse(parsed);
    if (!msg.success) return;
    if (msg.data.t === 'resize') {
      const { cols, rows } = msg.data;
      term.write(encodeFrame(TERMD_FRAME.resize, JSON.stringify({ cols, rows })));
    } else {
      unacked = Math.max(0, unacked - msg.data.bytes);
      if (paused && unacked < TERMINAL_LIMITS.unackedLowBytes) {
        paused = false;
        term.resume();
      }
    }
  });
  ws.on('close', () => {
    finish(WS_CLOSE.ended, 'Closed.');
  });
  ws.on('error', () => {
    finish(WS_CLOSE.ended, 'Closed.');
  });
}
