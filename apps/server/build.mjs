/**
 * Production build: bundles the server and admin CLI (plus @agentbox/shared)
 * into dist/*.mjs. npm dependencies stay external and are installed with
 * `pnpm install --prod` on the server, so native modules match the host.
 */
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@agentbox/'));

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: { main: 'src/main.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  legalComments: 'none',
  // Keep dependencies (and their deep imports like drizzle-orm/better-sqlite3) external.
  external: external.flatMap((d) => [d, `${d}/*`]),
  logLevel: process.env.CI ? 'warning' : 'info',
});
cpSync('migrations', 'dist/migrations', { recursive: true });
cpSync('src/gateway/machine.sh', 'dist/machine.sh');
cpSync('src/gateway/machine.ps1', 'dist/machine.ps1');
