/** Agent tracker: the on/off switch and the saved entries. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  TRACE_LIMITS,
  type TraceEntry,
  type TraceFilterOptions,
  type TracePage,
  type TrackerStatus,
} from '@agentbox/shared';
import { authOf, guards } from '../http/guards.ts';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../services.ts';

const idsSchema = z.union([z.literal('all'), z.array(z.uuid()).max(TRACE_LIMITS.maxEntries)]);
const filterSchema = z.object({
  machineId: z.uuid().optional(),
  ip: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
});
/** Which entries: a list of ids, or "all" (narrowed by the filter, if one is given). */
const pickSchema = z.object({ ids: idsSchema, filter: filterSchema.optional() });

export function trackerRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession, requireFreshAuth } = guards(s);
    const actor = (request: Parameters<typeof authOf>[0]) => `device:${authOf(request).deviceId}`;

    app.get(
      '/api/tracker',
      { preHandler: requireSession({ passive: true }) },
      async (): Promise<TrackerStatus> => s.tracker.status(),
    );

    // Turning anything on starts saving more, so it needs a fresh check; turning off doesn't.
    app.put(
      '/api/tracker',
      {
        schema: {
          body: z
            .object({
              enabled: z.boolean().optional(),
              system: z.boolean().optional(),
              tools: z.boolean().optional(),
            })
            .refine((b) => Object.keys(b).length > 0, 'Nothing to change.'),
        },
        preHandler: async (request, reply) => {
          const body = request.body as Record<string, unknown>;
          return Object.values(body).includes(true)
            ? requireFreshAuth.call(app, request, reply)
            : requireSession().call(app, request, reply);
        },
      },
      async (request): Promise<TrackerStatus> => {
        const { enabled, system, tools } = request.body;
        let status = s.tracker.status();
        if (system !== undefined || tools !== undefined) {
          status = s.tracker.setOptions(
            {
              ...(system === undefined ? {} : { system }),
              ...(tools === undefined ? {} : { tools }),
            },
            actor(request),
            request.ip,
          );
        }
        if (enabled !== undefined)
          status = s.tracker.setEnabled(enabled, actor(request), request.ip);
        return status;
      },
    );

    app.get(
      '/api/tracker/filters',
      { preHandler: requireSession({ passive: true }) },
      async (): Promise<TraceFilterOptions> => s.tracker.filterOptions(),
    );

    app.get(
      '/api/tracker/entries',
      {
        schema: {
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            before: z.string().max(100).optional(),
            machineId: z.uuid().optional(),
            ip: z.string().min(1).max(64).optional(),
            model: z.string().min(1).max(200).optional(),
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
      { schema: { body: pickSchema }, preHandler: requireSession() },
      async (request): Promise<{ deleted: number }> => ({
        deleted: s.tracker.delete(
          request.body.ids,
          actor(request),
          request.ip,
          request.body.filter,
        ),
      }),
    );

    // An export holds prompts and answers in plain text, so it needs a fresh check.
    app.post(
      '/api/tracker/export',
      {
        schema: { body: pickSchema },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request): Promise<{ csv: string; entries: number }> =>
        s.tracker.exportCsv(request.body.ids, actor(request), request.ip, request.body.filter),
    );
  };
}
