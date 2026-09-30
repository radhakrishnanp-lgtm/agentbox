/**
 * termd's socket server. One request per connection: a JSON line in, a JSON
 * line out, except `attach`, which then streams terminal frames both ways.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import * as pty from 'node-pty';
import { terminalPresetSchema } from '@agentbox/shared';
import {
  FrameDecoder,
  TERMD_FRAME,
  TERMD_MAX_FRAME,
  TERMD_MAX_REQUEST_BYTES,
  encodeFrame,
  type TermdErrorCode,
  type TermdOverview,
  type TermdRequest,
} from '@agentbox/shared/termd';
import type { TermdConfig } from './config.ts';
import { TermdError, Tmux, checkName, clampSize } from './tmux.ts';
import { GrokLogin } from './grok.ts';
import { Vault, VaultError } from './vault.ts';

/** Requests come from agentbox-web, but are still checked like any input. */
function passwordOf(req: TermdRequest): string {
  const value: unknown = (req as { password?: unknown }).password;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TermdError('bad_request', 'A vault password is needed.');
  }
  return value;
}

export type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: object) => void;

/** Socket write buffer above which the terminal stops reading (flow control). */
const PAUSE_AT = 512 * 1024;
/** How long a new tmux client needs before it follows resizes reliably. */
const SETTLE_MS = 400;

export class Termd {
  readonly config: TermdConfig;
  readonly tmux: Tmux;
  readonly vault: Vault;
  readonly grok: GrokLogin;
  readonly #env: NodeJS.ProcessEnv;
  readonly #log: Log;
  readonly #attached = new Set<pty.IPty>();
  #server: Server | undefined;
  #installed: { at: number; value: TermdOverview['installed'] } | undefined;

  constructor(config: TermdConfig, env: NodeJS.ProcessEnv, log: Log, vault?: Vault) {
    this.config = config;
    this.#env = env;
    this.#log = log;
    this.tmux = new Tmux(config, env);
    this.vault = vault ?? new Vault(config, env);
    this.grok = new GrokLogin(config.home, env);
  }

  async listen(): Promise<void> {
    const path = this.config.socket;
    if (existsSync(path)) rmSync(path);
    const server = createServer((socket) => {
      this.#handle(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        resolve();
      });
    });
    // agentbox-web connects through the socket's group; nobody else can.
    chmodSync(path, 0o660);
    this.#server = server;
  }

  async close(): Promise<void> {
    for (const p of this.#attached) p.kill();
    await new Promise<void>((resolve) => {
      if (!this.#server) {
        resolve();
        return;
      }
      this.#server.close(() => {
        resolve();
      });
    });
  }

  async overview(): Promise<TermdOverview> {
    const vault = this.vault.state();
    const usable = vault === 'disabled' || vault === 'unlocked';
    if (!usable) return { vault, terminals: [], installed: [] };
    const now = Date.now();
    if (!this.#installed || now - this.#installed.at > 10_000) {
      this.#installed = { at: now, value: await this.tmux.installed() };
    }
    return { vault, terminals: await this.tmux.list(), installed: this.#installed.value };
  }

  #handle(socket: Socket): void {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 5000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > TERMD_MAX_REQUEST_BYTES) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      const line = buf.subarray(0, nl).toString('utf8');
      const rest = buf.subarray(nl + 1);
      let req: TermdRequest;
      try {
        req = JSON.parse(line) as TermdRequest;
      } catch {
        this.#reply(socket, { ok: false, error: { code: 'bad_request', message: 'Bad request.' } });
        return;
      }
      if (req.op === 'attach') {
        void this.#attach(socket, req, rest);
        return;
      }
      void this.#control(req).then((res) => {
        this.#reply(socket, res);
      });
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  }

  #reply(socket: Socket, res: object): void {
    socket.end(`${JSON.stringify(res)}\n`);
  }

  #fail(err: unknown): { ok: false; error: { code: TermdErrorCode; message: string } } {
    if (err instanceof TermdError || err instanceof VaultError) {
      if (err.code === 'internal') this.#log('error', 'request failed', { err: err.message });
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    this.#log('error', 'request failed', { err: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: { code: 'internal', message: 'termd hit an unexpected error.' } };
  }

  async #control(req: TermdRequest): Promise<object> {
    try {
      switch (req.op) {
        case 'overview':
          return { ok: true, ...(await this.overview()) };
        case 'create': {
          this.vault.assertUsable();
          const name = checkName(req.name);
          const preset = terminalPresetSchema.safeParse(req.preset);
          if (!preset.success) throw new TermdError('bad_request', 'Unknown preset.');
          const { cols, rows } = clampSize(req.cols, req.rows);
          await this.tmux.create(name, preset.data, cols, rows);
          this.#log('info', 'terminal created', { name, preset: preset.data });
          return { ok: true };
        }
        case 'rename':
          this.vault.assertUsable();
          await this.tmux.rename(checkName(req.name), checkName(req.to));
          return { ok: true };
        case 'kill':
          this.vault.assertUsable();
          await this.tmux.kill(checkName(req.name));
          return { ok: true };
        case 'vault.init':
          await this.vault.init(passwordOf(req));
          this.#installed = undefined;
          this.#log('info', 'vault created');
          return { ok: true };
        case 'vault.unlock':
          await this.vault.unlock(passwordOf(req));
          this.#installed = undefined;
          this.#log('info', 'vault unlocked');
          return { ok: true };
        case 'vault.verify':
          await this.vault.verify(passwordOf(req));
          return { ok: true };
        case 'vault.lock':
          await this.lock();
          return { ok: true };
        case 'grok.token': {
          this.vault.assertUsable();
          return { ok: true, ...(await this.grok.token()) };
        }
        case 'vault.reset':
          this.vault.reset();
          this.#log('warn', 'vault reset');
          return { ok: true };
        default:
          throw new TermdError('bad_request', 'Unknown request.');
      }
    } catch (err) {
      return this.#fail(err);
    }
  }

  /** Stops every terminal, then unmounts the vault. */
  async lock(): Promise<void> {
    for (const p of this.#attached) p.kill();
    await this.tmux.killServer();
    await this.vault.lock(() => this.#stopOtherProcesses());
    this.#log('info', 'vault locked');
  }

  /**
   * Stops the dev user's other programs that still hold vault files open
   * (for example a background job a CLI started), but not termd or gocryptfs.
   * termd runs as its own dedicated user, so these are all terminal programs.
   */
  #stopOtherProcesses(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0) return Promise.resolve();
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        if (statSync(`/proc/${entry}`).uid !== uid) continue;
        const comm = readFileSync(`/proc/${entry}/comm`, 'utf8').trim();
        if (comm === 'gocryptfs') continue;
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process already exited.
      }
    }
    return Promise.resolve();
  }

  async #attach(
    socket: Socket,
    req: Extract<TermdRequest, { op: 'attach' }>,
    rest: Buffer,
  ): Promise<void> {
    let name: string;
    try {
      this.vault.assertUsable();
      name = checkName(req.name);
      if (!(await this.tmux.exists(name))) throw new TermdError('not_found', 'No such session.');
    } catch (err) {
      this.#reply(socket, this.#fail(err));
      return;
    }
    const { cols, rows } = clampSize(req.cols, req.rows);
    const term = pty.spawn('tmux', [...this.tmux.baseArgs(), 'attach-session', '-t', `=${name}`], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.config.home,
      env: this.#env,
    });
    this.#attached.add(term);
    socket.write(`${JSON.stringify({ ok: true })}\n`);

    let closed = false;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      this.#attached.delete(term);
      try {
        term.kill();
      } catch {
        // Already gone.
      }
      if (!socket.destroyed) socket.end(encodeFrame(TERMD_FRAME.exit, JSON.stringify({ reason })));
    };

    term.onData((data) => {
      if (closed) return;
      const bytes = Buffer.from(data, 'utf8');
      for (let i = 0; i < bytes.length; i += TERMD_MAX_FRAME) {
        socket.write(encodeFrame(TERMD_FRAME.data, bytes.subarray(i, i + TERMD_MAX_FRAME)));
      }
      // Flow control: stop reading the terminal until agentbox-web catches up.
      if (socket.writableLength > PAUSE_AT) term.pause();
    });
    socket.on('drain', () => {
      term.resume();
    });
    term.onExit(() => {
      close('ended');
    });

    // A tmux client that is still starting up misses size changes, and the
    // browser sends its real size right away. So early resizes wait a moment.
    let settled = false;
    let pending: { cols: number; rows: number } | null = null;
    const resize = (size: { cols: number; rows: number }) => {
      if (!settled) {
        pending = size;
        return;
      }
      try {
        term.resize(size.cols, size.rows);
      } catch {
        // The terminal already ended.
      }
    };
    setTimeout(() => {
      settled = true;
      if (pending && !closed) resize(pending);
    }, SETTLE_MS).unref();

    const decoder = new FrameDecoder();
    const onFrames = (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        close('protocol');
        return;
      }
      for (const f of frames) {
        if (f.type === TERMD_FRAME.data) term.write(f.payload.toString('utf8'));
        else if (f.type === TERMD_FRAME.resize) {
          try {
            const size = JSON.parse(f.payload.toString('utf8')) as {
              cols?: unknown;
              rows?: unknown;
            };
            resize(clampSize(size.cols, size.rows));
          } catch {
            // Ignore a bad resize.
          }
        }
      }
    };
    if (rest.length) onFrames(rest);
    socket.on('data', onFrames);
    socket.on('close', () => {
      close('detached');
    });
  }
}
