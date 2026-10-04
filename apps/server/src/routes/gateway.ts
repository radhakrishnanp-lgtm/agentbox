/**
 * Owner API for the key gateway: AI keys and machines.
 * Adding keys, adding machines and widening what a machine may do need a
 * fresh check (passkey or authenticator code). Stopping or deleting a machine
 * never does: making things safer should always be one tap.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  PROVIDER_PRESETS,
  aiKeyCreateSchema,
  machineCreateSchema,
  machineUpdateSchema,
  type GatewayOverview,
  type GatewayUsageRow,
  type MachineCreated,
} from '@agentbox/shared';
import { installCommands } from '../gateway/script.ts';
import { authOf, guards } from '../http/guards.ts';
import { iso } from '../lib/clock.ts';
import type { Services } from '../services.ts';

export function gatewayAdminRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession, requireFreshAuth } = guards(s);
    const actor = (request: Parameters<typeof authOf>[0]) => `device:${authOf(request).deviceId}`;

    app.get(
      '/api/gateway',
      { preHandler: requireSession({ passive: true }) },
      async (): Promise<GatewayOverview> => ({
        keys: s.gateway.activeKeys().map((k) => s.gateway.keySummary(k)),
        machines: s.gateway.listMachines().map((m) => s.gateway.machineSummary(m)),
        presets: PROVIDER_PRESETS,
      }),
    );

    app.post(
      '/api/gateway/keys',
      {
        schema: { body: aiKeyCreateSchema },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      },
      async (request) => s.gateway.addKey(request.body, actor(request), request.ip),
    );

    app.delete(
      '/api/gateway/keys/:id',
      { schema: { params: z.object({ id: z.uuid() }) }, preHandler: requireFreshAuth },
      async (request) => {
        s.gateway.removeKey(request.params.id, actor(request), request.ip);
        return { ok: true };
      },
    );

    app.post(
      '/api/gateway/machines',
      {
        schema: { body: machineCreateSchema },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      },
      async (request): Promise<MachineCreated> => {
        const { row, pass } = s.gateway.createMachine(request.body, actor(request), request.ip);
        return {
          machine: s.gateway.machineSummary(row),
          pass,
          ...installCommands(s.config.origin),
        };
      },
    );

    app.patch(
      '/api/gateway/machines/:id',
      {
        schema: { params: z.object({ id: z.uuid() }), body: machineUpdateSchema },
        preHandler: requireFreshAuth,
      },
      async (request) => {
        const row = s.gateway.updateMachine(
          request.params.id,
          request.body,
          actor(request),
          request.ip,
        );
        return s.gateway.machineSummary(row);
      },
    );

    /** Allowing a new address widens what the pass can do, so it needs a fresh check. */
    app.post(
      '/api/gateway/machines/:id/pending-ip',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: z.object({ ip: z.union([z.ipv4(), z.ipv6()]), allow: z.boolean() }),
        },
        preHandler: requireFreshAuth,
      },
      async (request) => {
        const row = s.gateway.decidePendingIp(
          request.params.id,
          request.body.ip,
          request.body.allow,
          actor(request),
          request.ip,
        );
        return s.gateway.machineSummary(row);
      },
    );

    app.post(
      '/api/gateway/machines/:id/revoke',
      { schema: { params: z.object({ id: z.uuid() }) }, preHandler: requireSession() },
      async (request) => {
        s.gateway.revokeMachine(request.params.id, actor(request), request.ip);
        s.relay.cut(request.params.id);
        return { ok: true };
      },
    );

    /** Starting a stopped machine gives its pass back its power, so it needs a fresh check. */
    app.post(
      '/api/gateway/machines/:id/start',
      { schema: { params: z.object({ id: z.uuid() }) }, preHandler: requireFreshAuth },
      async (request) => {
        const row = s.gateway.startMachine(request.params.id, actor(request), request.ip);
        return s.gateway.machineSummary(row);
      },
    );

    /** Deleting only takes access away, so like Stop it needs no extra check. */
    app.delete(
      '/api/gateway/machines/:id',
      { schema: { params: z.object({ id: z.uuid() }) }, preHandler: requireSession() },
      async (request) => {
        s.gateway.deleteMachine(request.params.id, actor(request), request.ip);
        s.relay.cut(request.params.id);
        return { ok: true };
      },
    );

    app.post(
      '/api/gateway/machines/revoke-all',
      { preHandler: requireSession() },
      async (request) => {
        const ids = s.gateway.listMachines().map((m) => m.id);
        const count = s.gateway.revokeAllMachines(actor(request), request.ip);
        for (const id of ids) s.relay.cut(id);
        return { count };
      },
    );

    app.get(
      '/api/gateway/usage',
      {
        schema: {
          querystring: z.object({
            machineId: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
        },
        preHandler: requireSession({ passive: true }),
      },
      async (request): Promise<{ rows: GatewayUsageRow[] }> => ({
        rows: s.gateway.recentUsage(request.query.limit, request.query.machineId).map((r) => ({
          id: r.id,
          ts: iso(r.ts),
          machineId: r.machineId,
          keySlug: r.keySlug,
          method: r.method,
          path: r.path,
          model: r.model,
          status: r.status,
          durationMs: r.durationMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
        })),
      }),
    );
  };
}
