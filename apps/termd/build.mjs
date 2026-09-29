/**
 * Production build: bundles termd (plus @agentbox/shared) into dist/main.mjs.
 * node-pty stays external and is installed on the server, so it matches the host.
 */
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@agentbox/'));

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: { main: 'src/main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  legalComments: 'none',
  external: external.flatMap((d) => [d, `${d}/*`]),
  logLevel: process.env.CI ? 'warning' : 'info',
});
cpSync('src/tmux.conf', 'dist/tmux.conf');
