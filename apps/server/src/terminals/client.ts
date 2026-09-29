/**
 * Client for agentbox-termd's private Unix socket (see packages/shared/src/termd.ts).
 */
import { connect, type Socket } from 'node:net';
import {
  TERMD_MAX_REQUEST_BYTES,
  type TermdErrorCode,
  type TermdRequest,
  type TermdResponse,
} from '@agentbox/shared/termd';
import { AppError } from '../lib/errors.ts';

/** termd said no. `code` is termd's own error code. */
export class TermdRefused extends Error {
  readonly code: TermdErrorCode;
  constructor(code: TermdErrorCode, message: string) {
    super(message);
    this.code = code;
  }

  toAppError(): AppError {
    switch (this.code) {
      case 'bad_request':
      case 'wrong_password':
        return new AppError('bad_request', this.message);
      case 'not_found':
        return new AppError('not_found', this.message);
      case 'conflict':
      case 'vault_locked':
      case 'busy':
      case 'limit':
        return new AppError('conflict', this.message);
      default:
        return new AppError('internal', 'The terminal service hit an unexpected error.');
    }
  }
}

export const termdUnavailable = () =>
  new AppError('unavailable', 'The terminal service is not running on this server.');

export class TermdClient {
  readonly socketPath: string | null;
  readonly #timeoutMs: number;

  constructor(socketPath: string | null, timeoutMs = 90_000) {
    this.socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
  }

  #connect(): Promise<Socket> {
    const path = this.socketPath;
    if (!path) return Promise.reject(termdUnavailable());
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', () => {
        reject(termdUnavailable());
      });
    });
  }

  /** One control request. Throws TermdRefused when termd answers with an error. */
  async request<T extends object = object>(
    req: Exclude<TermdRequest, { op: 'attach' }>,
  ): Promise<T> {
    const socket = await this.#connect();
    const line = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AppError('internal', 'The terminal service did not answer in time.'));
      }, this.#timeoutMs);
      socket.setEncoding('utf8');
      socket.on('data', (d: string) => {
        buf += d;
        if (buf.length > 4 * 1024 * 1024) socket.destroy();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        reject(termdUnavailable());
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(buf);
      });
      // Not end(): termd answers first, then closes the connection.
      socket.write(`${JSON.stringify(req)}\n`);
    });
    return parseResponse(line) as T;
  }

  /**
   * Attaches to a session. Resolves with the socket (now carrying frames) and any
   * frame bytes that arrived together with termd's first answer.
   */
  async attach(
    name: string,
    cols: number,
    rows: number,
  ): Promise<{ socket: Socket; rest: Buffer }> {
    const socket = await this.#connect();
    return new Promise((resolve, reject) => {
      let head = Buffer.alloc(0);
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new AppError('internal', 'The terminal service did not answer in time.'));
      }, 15_000);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const nl = head.indexOf(0x0a);
        if (nl === -1) {
          if (head.length > TERMD_MAX_REQUEST_BYTES) fail(new AppError('internal', 'Bad answer.'));
          return;
        }
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        try {
          parseResponse(head.subarray(0, nl).toString('utf8'));
        } catch (err) {
          fail(err as Error);
          return;
        }
        resolve({ socket, rest: head.subarray(nl + 1) });
      };
      const onError = () => {
        clearTimeout(timer);
        fail(termdUnavailable());
      };
      const onClose = () => {
        clearTimeout(timer);
        reject(termdUnavailable());
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.write(
        `${JSON.stringify({ op: 'attach', name, cols, rows } satisfies TermdRequest)}\n`,
      );
    });
  }
}

function parseResponse(line: string): object {
  let res: TermdResponse;
  try {
    res = JSON.parse(line.trim()) as TermdResponse;
  } catch {
    throw termdUnavailable();
  }
  if (!res.ok) throw new TermdRefused(res.error.code, res.error.message);
  return res;
}
