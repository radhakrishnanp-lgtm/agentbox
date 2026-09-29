/**
 * agentbox-termd: runs the browser terminals (tmux sessions) as the `dev` user
 * and keeps that user's home in the encrypted vault. Only agentbox-web talks
 * to it, over a Unix socket.
 */
import { loadTermdConfig, terminalEnv } from './config.ts';
import { Termd, type Log } from './server.ts';

const log: Log = (level, msg, extra) => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
};

const config = loadTermdConfig(process.env);
const termd = new Termd(config, terminalEnv(config, process.env), log);
await termd.listen();
log('info', 'agentbox-termd listening', {
  socket: config.socket,
  vault: termd.vault.state(),
});

// Stopping termd leaves tmux and the vault running: terminals survive a restart.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void termd.close().then(() => process.exit(0));
  });
}
