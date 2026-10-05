/** Agent tracker: the on/off switch and the saved entries. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  TRACE_LIMITS,
  type TraceEntry,
  type TracePage,
  type TrackerStatus,
} from '@agentbox/shared';
import { authOf, guards } from '../http/guards.ts';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../services.ts';

const idsSchema = z.union([z.literal('all'), z.array(z.uuid()).max(TRACE_LIMITS.maxEntries)]);

export function trackerRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession, requireFreshAuth } = guards(s);
    const actor = (request: Parameters<typeof authOf>[0]) => `device:${authOf(request).deviceId}`;

    app.get(
      '/api/tracker',
      { preHandler: requireSession({ passive: true }) },
      async (): Promise<TrackerStatus> => s.tracker.status(),
    );

    // Turning it on starts saving prompts and answers, so it needs a fresh check.
    app.put(
      '/api/tracker',
      {
        schema: { body: z.object({ enabled: z.boolean() }) },
        preHandler: async (request, reply) => {
          const body = request.body as { enabled?: unknown } | undefined;
          return body?.enabled === true
            ? requireFreshAuth.call(app, request, reply)
            : requireSession().call(app, request, reply);
        },
      },
      async (request): Promise<TrackerStatus> =>
        s.tracker.setEnabled(request.body.enabled, actor(request), request.ip),
    );

    app.get(
      '/api/tracker/entries',
      {
        schema: {
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            before: z.string().max(100).optional(),
            machineId: z.uuid().optional(),
          }),
        },
        preHandler: requireSession({ passive: true }),
      },
      async (request): Promise<TracePage> => s.tracker.list(request.query),
    );

    app.get(
      '/api/tracker/entries/:id',
      { schema: { params: z.object({ id: z.uuid() }) }, preHandler: requireSession() },
      async (request): Promise<TraceEntry> => {
        const entry = s.tracker.get(request.params.id);
        if (!entry) throw new AppError('not_found', 'That entry was not found.');
        return entry;
      },
    );

    app.patch(
      '/api/tracker/entries/:id',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: z.object({ note: z.string().max(TRACE_LIMITS.noteMax) }),
        },
        preHandler: requireSession(),
      },
      async (request): Promise<TraceEntry> => {
        const entry = s.tracker.setNote(request.params.id, request.body.note);
        if (!entry) throw new AppError('not_found', 'That entry was not found.');
        return entry;
      },
    );

    app.post(
      '/api/tracker/delete',
      { schema: { body: z.object({ ids: idsSchema }) }, preHandler: requireSession() },
      async (request): Promise<{ deleted: number }> => ({
        deleted: s.tracker.delete(request.body.ids, actor(request), request.ip),
      }),
    );

    // An export holds prompts and answers in plain text, so it needs a fresh check.
    app.post(
      '/api/tracker/export',
      {
        schema: { body: z.object({ ids: idsSchema }) },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request): Promise<{ csv: string; entries: number }> =>
        s.tracker.exportCsv(request.body.ids, actor(request), request.ip),
    );
  };
}
