import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Services } from '../services.ts';

/** Public health check. Reveals nothing beyond "up" or "down". */
export function healthRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/healthz',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (_request, reply) => {
        try {
          s.db.$client.prepare('SELECT 1').get();
          // LATER (Milestone 2): also check the terminal daemon socket.
          return { ok: true };
        } catch {
          return reply.code(503).send({ ok: false });
        }
      },
    );
  };
}
