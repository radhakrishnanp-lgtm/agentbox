import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auditQuerySchema, type AuditPage, type AuditVerifyResult } from '@agentbox/shared';
import { guards } from '../http/guards.ts';
import type { Services } from '../services.ts';

export function auditRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession } = guards(s);

    app.get(
      '/api/audit',
      { schema: { querystring: auditQuerySchema }, preHandler: requireSession({ passive: true }) },
      async (request): Promise<AuditPage> =>
        s.audit.page(request.query.limit, request.query.before),
    );

    app.get(
      '/api/audit/verify',
      { preHandler: requireSession(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (): Promise<AuditVerifyResult> => s.audit.verify(),
    );
  };
}
