import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../services.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The setup script for machines, with this agentbox's address filled in:
 * machine.sh for Linux and macOS, machine.ps1 for Windows.
 */
export function renderMachineScript(
  origin: string,
  file: 'machine.sh' | 'machine.ps1' = 'machine.sh',
): string {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
    throw new Error('AGENTBOX_ORIGIN must be a plain scheme://host[:port] for the machine script');
  }
  // Bundled build: dist/machine.sh. Source: src/gateway/machine.sh.
  const template = readFileSync(join(here, file), 'utf8');
  return template.replaceAll('@@AGENTBOX_URL@@', origin);
}

/** The commands the Machines page shows for setting up a computer. */
export function installCommands(origin: string): {
  installCommand: string;
  installCommandWindows: string;
} {
  return {
    installCommand: `curl -fsSL ${origin}/machine.sh | sh`,
    installCommandWindows: `irm ${origin}/machine.ps1 | iex`,
  };
}

export function machineScriptRoutes(s: Services): FastifyPluginAsync {
  return async (app) => {
    const script = renderMachineScript(s.config.origin);
    const windows = renderMachineScript(s.config.origin, 'machine.ps1');
    app.get('/machine.sh', async (_request, reply) =>
      reply
        .type('text/x-shellscript; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('content-disposition', 'inline; filename="machine.sh"')
        .send(script),
    );
    // Plain text, so "irm ... | iex" in PowerShell gets it as a string.
    app.get('/machine.ps1', async (_request, reply) =>
      reply
        .type('text/plain; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('content-disposition', 'inline; filename="machine.ps1"')
        .send(windows),
    );
  };
}
