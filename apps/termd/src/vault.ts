/**
 * The vault: the dev user's home (CLI logins, settings, installed tools) kept
 * in a gocryptfs-encrypted folder and mounted at HOME only while unlocked.
 *
 * - Locked: HOME is an empty folder. The files exist only encrypted.
 * - Unlocked: the FUSE mount is readable by the dev user only. Other users,
 *   including root processes that simply read files, get "permission denied".
 *   (A determined root user can still get in, for example by becoming dev.)
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { VaultState } from '@agentbox/shared';
import type { TermdConfig } from './config.ts';
import { run } from './run.ts';

export class VaultError extends Error {
  readonly code: 'wrong_password' | 'vault_locked' | 'busy' | 'conflict' | 'internal';
  constructor(code: VaultError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const HOME_MARKER = '.agentbox-home';

/** Mount points from /proc/self/mountinfo, with octal escapes decoded. */
export function mountPoints(mountinfo: string): { point: string; fstype: string }[] {
  const unescape = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return mountinfo
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [left = '', right = ''] = line.split(' - ');
      const point = left.split(' ')[4] ?? '';
      const fstype = right.split(' ')[0] ?? '';
      return { point: unescape(point), fstype };
    });
}

/**
 * Turns a failed mount into a message the owner can act on. gocryptfs and
 * fusermount3 output never contains the password.
 */
export function explainMountFailure(what: string, output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // fusermount3's own line says why a mount was refused; otherwise the last line.
  const last = (lines.find((l) => /^fusermount3?:/.test(l)) ?? lines.at(-1))?.slice(0, 300);
  const detail = last ? `${what}: ${last}` : what;
  if (/fusermount3?:.*(permission denied|operation not permitted)/i.test(output)) {
    return (
      `Could not unlock the vault (${detail}). The system blocked the mount, usually ` +
      "Ubuntu's AppArmor profile for fusermount3. Re-run the agentbox installer, which allows " +
      'the vault folder in that profile.'
    );
  }
  if (/\/dev\/fuse/i.test(output)) {
    return `Could not unlock the vault (${detail}). This server can't use FUSE (/dev/fuse).`;
  }
  return `Could not unlock the vault (${detail}).`;
}

export class Vault {
  readonly #config: TermdConfig;
  readonly #env: NodeJS.ProcessEnv;
  readonly #mountinfo: () => string;

  constructor(
    config: TermdConfig,
    env: NodeJS.ProcessEnv,
    mountinfo: () => string = () => readFileSync('/proc/self/mountinfo', 'utf8'),
  ) {
    this.#config = config;
    this.#env = env;
    this.#mountinfo = mountinfo;
  }

  get enabled(): boolean {
    return this.#config.vaultCipher !== null;
  }

  #cipher(): string {
    const c = this.#config.vaultCipher;
    if (!c) throw new VaultError('internal', 'The vault is not enabled on this server.');
    return c;
  }

  isMounted(): boolean {
    const home = this.#config.home.replace(/\/+$/, '');
    return mountPoints(this.#mountinfo()).some(
      (m) => m.point === home && m.fstype.startsWith('fuse'),
    );
  }

  state(): VaultState {
    if (!this.enabled) return 'disabled';
    if (!existsSync(join(this.#cipher(), 'gocryptfs.conf'))) return 'uninitialized';
    return this.isMounted() ? 'unlocked' : 'locked';
  }

  /** Terminals may only run where their files end up encrypted. */
  assertUsable(): void {
    const s = this.state();
    if (s === 'uninitialized') {
      throw new VaultError('vault_locked', 'Create the vault first.');
    }
    if (s === 'locked') throw new VaultError('vault_locked', 'Unlock the vault first.');
  }

  async init(password: string): Promise<void> {
    if (this.state() !== 'uninitialized') {
      throw new VaultError('conflict', 'The vault already exists.');
    }
    const cipher = this.#cipher();
    mkdirSync(cipher, { recursive: true, mode: 0o700 });
    if (readdirSync(cipher).length > 0) {
      throw new VaultError('conflict', 'The vault folder is not empty.');
    }
    const res = await run('gocryptfs', ['-init', '-q', '--', cipher], {
      env: this.#env,
      input: password,
      timeoutMs: 60_000,
    });
    if (res.code !== 0) {
      rmSync(join(cipher, 'gocryptfs.conf'), { force: true });
      throw new VaultError('internal', `Could not create the vault: ${res.stderr.trim()}`);
    }
    await this.unlock(password);
  }

  async unlock(password: string): Promise<void> {
    const s = this.state();
    if (s === 'unlocked') return;
    if (s !== 'locked') throw new VaultError('vault_locked', 'Create the vault first.');
    const home = this.#config.home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (readdirSync(home).length > 0) {
      throw new VaultError(
        'conflict',
        `${home} is not empty, so the vault can't be mounted there. Move its files away first.`,
      );
    }
    const code = await this.#mount(password);
    // gocryptfs exits with 12 for a wrong password.
    if (code === 12) throw new VaultError('wrong_password', 'That vault password is wrong.');
    if (!this.isMounted()) {
      throw new VaultError(
        'internal',
        explainMountFailure(`gocryptfs exit ${String(code ?? 'timeout')}`, this.#logTail()),
      );
    }
    this.#prepareHome();
  }

  /**
   * Checks a password with a short read-only trial mount next to the vault,
   * which is unmounted again at once. Nothing in the vault changes.
   */
  async verify(password: string): Promise<void> {
    if (this.state() === 'uninitialized') {
      throw new VaultError('vault_locked', 'Create the vault first.');
    }
    const probe = mkdtempSync(join(dirname(this.#cipher()), 'verify-'));
    try {
      const res = await run('gocryptfs', ['-ro', '-q', '--', this.#cipher(), probe], {
        env: this.#env,
        cwd: '/',
        input: password,
        timeoutMs: 60_000,
      });
      if (res.code === 12) throw new VaultError('wrong_password', 'That vault password is wrong.');
      if (res.code !== 0) {
        throw new VaultError(
          'internal',
          explainMountFailure(`gocryptfs exit ${String(res.code)}`, res.stderr),
        );
      }
      await run('fusermount3', ['-u', '-z', '--', probe], { env: this.#env, timeoutMs: 15_000 });
    } finally {
      rmdirSync(probe);
    }
  }

  #logPath(): string {
    return join(dirname(this.#cipher()), 'gocryptfs.log');
  }

  /** The last lines gocryptfs wrote. It never logs the password. */
  #logTail(): string {
    try {
      return readFileSync(this.#logPath(), 'utf8').split('\n').slice(-6).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Starts gocryptfs in the foreground as its own detached process, so it keeps
   * running when termd restarts. Its output goes to a private log file: a pipe
   * would break (and kill it) the moment termd exits.
   * Resolves with gocryptfs's exit code if it stopped, or null once mounted.
   */
  #mount(password: string): Promise<number | null> {
    const log = openSync(this.#logPath(), 'a', 0o600);
    return new Promise((resolve) => {
      const child = spawn('gocryptfs', ['-fg', '-q', '--', this.#cipher(), this.#config.home], {
        env: this.#env,
        cwd: '/',
        detached: true,
        stdio: ['pipe', log, log],
      });
      closeSync(log);
      let done = false;
      const finish = (value: number | null) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(value);
      };
      child.on('exit', (code) => {
        finish(code ?? -1);
      });
      child.on('error', () => {
        finish(-1);
      });
      child.stdin?.on('error', () => {
        // gocryptfs may exit before reading the password; its exit code says why.
      });
      child.stdin?.end(`${password}\n`);
      const poll = setInterval(() => {
        if (this.isMounted()) {
          child.unref();
          finish(null);
        }
      }, 100);
      const timer = setTimeout(() => {
        finish(this.isMounted() ? null : -1);
      }, 60_000);
    });
  }

  /** The first unlock sets up a normal home: shell files and a user-level npm prefix. */
  #prepareHome(): void {
    const home = this.#config.home;
    if (existsSync(join(home, HOME_MARKER))) return;
    for (const f of ['.bashrc', '.profile', '.bash_logout']) {
      const skel = join('/etc/skel', f);
      if (existsSync(skel) && !existsSync(join(home, f))) {
        writeFileSync(join(home, f), readFileSync(skel), { mode: 0o644 });
      }
    }
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    // `npm install -g` then installs CLIs into ~/.local, inside the vault.
    if (!existsSync(join(home, '.npmrc'))) {
      writeFileSync(join(home, '.npmrc'), `prefix=${join(home, '.local')}\n`, { mode: 0o600 });
    }
    const block = [
      '',
      '# >>> agentbox >>>',
      '# CLIs you install (npm install -g, pip install --user, curl installers) go in ~/.local/bin.',
      'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac',
      '# <<< agentbox <<<',
      '',
    ].join('\n');
    for (const f of ['.bashrc', '.profile']) {
      const p = join(home, f);
      const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
      if (!text.includes('# >>> agentbox >>>')) writeFileSync(p, text + block, { mode: 0o644 });
    }
    writeFileSync(
      join(home, HOME_MARKER),
      'This folder is the agentbox vault. It is encrypted on disk and mounted only while unlocked.\n',
      { mode: 0o600 },
    );
  }

  /**
   * Unmounts HOME. Callers stop tmux first. If programs still hold files open,
   * the other processes of this user are stopped, then the mount is detached.
   */
  async lock(stopOthers: () => Promise<void>): Promise<void> {
    if (this.state() !== 'unlocked') return;
    const home = this.#config.home;
    const unmount = (lazy: boolean) =>
      run('fusermount3', lazy ? ['-u', '-z', '--', home] : ['-u', '--', home], {
        env: this.#env,
        timeoutMs: 15_000,
      });
    if ((await unmount(false)).code === 0 && !this.isMounted()) return;
    await stopOthers();
    await new Promise((r) => setTimeout(r, 300));
    if ((await unmount(false)).code === 0 && !this.isMounted()) return;
    await unmount(true);
    if (this.isMounted())
      throw new VaultError('busy', 'The vault is busy and could not be locked.');
  }

  /** Deletes the encrypted vault. Only while locked. Everything in it is gone for good. */
  reset(): void {
    if (this.state() === 'unlocked') throw new VaultError('conflict', 'Lock the vault first.');
    const cipher = this.#cipher();
    if (existsSync(cipher)) {
      for (const entry of readdirSync(cipher)) {
        rmSync(join(cipher, entry), { recursive: true, force: true });
      }
    }
  }
}
