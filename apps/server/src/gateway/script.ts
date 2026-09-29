import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../services.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The setup script for machines, with this agentbox's address filled in. */
export function renderMachineScript(origin: string): string {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
    throw new Error('AGENTBOX_ORIGIN must be a plain scheme://host[:port] for the machine script');
  }
  // Bundled build: dist/machine.sh. Source: src/gateway/machine.sh.
  const template = readFileSync(join(here, 'machine.sh'), 'utf8');
  return template.replaceAll('@@AGENTBOX_URL@@', origin);
}

export function machineScriptRoutes(s: Services): FastifyPluginAsync {
  return async (app) => {
    const script = renderMachineScript(s.config.origin);
    app.get('/machine.sh', async (_request, reply) =>
      reply
        .type('text/x-shellscript; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('content-disposition', 'inline; filename="machine.sh"')
        .send(script),
    );
  };
}
