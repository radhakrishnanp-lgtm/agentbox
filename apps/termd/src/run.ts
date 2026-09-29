import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with arguments (never through a shell), optional stdin and a
 * timeout. Used for tmux, gocryptfs and fusermount.
 */
export function run(
  cmd: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd ?? '/',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < limit) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < limit) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 15_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {
      // The program may exit before reading stdin; that is reported by its exit code.
    });
    child.stdin.end(opts.input ?? '');
  });
}
