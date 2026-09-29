import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  LIMITS,
  displayNameSchema,
  registrationResponseSchema,
  setSignInPasswordSchema,
  type PasskeySummary,
  type SecurityOverview,
} from '@agentbox/shared';
import { owner, passkey } from '../db/schema.ts';
import { iso } from '../lib/clock.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { authOf, guards } from '../http/guards.ts';
import type { Services } from '../services.ts';

export function securityRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession, requireFreshAuth } = guards(s);

    app.get(
      '/api/security',
      { preHandler: requireSession({ passive: true }) },
      async (): Promise<SecurityOverview> => {
        const keys = s.db.select().from(passkey).where(isNull(passkey.revokedAt)).all();
        return {
          passkeys: keys.map((k): PasskeySummary => ({
            id: k.id,
            name: k.name,
            deviceType: k.deviceType,
            backedUp: k.backedUp,
            createdAt: iso(k.createdAt),
            lastUsedAt: k.lastUsedAt === null ? null : iso(k.lastUsedAt),
          })),
          totpEnabled: s.owner.exists(),
          passwordEnabled: s.owner.hasPassword(),
          recoveryCodesRemaining: s.owner.recoveryCodesRemaining(),
        };
      },
    );

    app.post(
      '/api/security/passkeys/options',
      { preHandler: requireFreshAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (request) => {
        const row = s.db.select().from(owner).get();
        if (!row) throw new AppError('not_found', 'Setup is not complete.');
        return s.webauthn.registrationOptions({
          purpose: 'add_passkey',
          boundTo: authOf(request).sessionId,
          userId: row.webauthnUserId,
          userName: `agentbox (${new URL(s.config.origin).hostname})`,
        });
      },
    );

    app.post(
      '/api/security/passkeys',
      {
        schema: {
          body: z.object({
            response: registrationResponseSchema,
            name: displayNameSchema(LIMITS.passkeyNameMax),
          }),
        },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request) => {
        const auth = authOf(request);
        const cred = await s.webauthn.verifyRegistration(
          request.body.response,
          'add_passkey',
          auth.sessionId,
        );
        const now = s.clock.now();
        const id = newId();
        s.db
          .insert(passkey)
          .values({
            id,
            credentialId: cred.credentialId,
            publicKey: Buffer.from(cred.publicKey),
            counter: cred.counter,
            transports: cred.transports,
            deviceType: cred.deviceType,
            backedUp: cred.backedUp,
            aaguid: cred.aaguid,
            name: request.body.name,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        s.audit.record({
          actor: `device:${auth.deviceId}`,
          action: 'passkey.added',
          targetType: 'passkey',
          targetId: id,
          ip: request.ip,
          details: { name: request.body.name, synced: cred.deviceType === 'multiDevice' },
        });
        return { id };
      },
    );

    app.delete(
      '/api/security/passkeys/:id',
      { schema: { params: z.object({ id: z.uuid() }) }, preHandler: requireFreshAuth },
      async (request) => {
        const auth = authOf(request);
        const now = s.clock.now();
        const removed = s.db.transaction((tx) => {
          const active = tx
            .select({ id: passkey.id })
            .from(passkey)
            .where(isNull(passkey.revokedAt))
            .all();
          if (!active.some((k) => k.id === request.params.id)) return 'missing' as const;
          if (active.length <= 1) return 'last' as const;
          tx.update(passkey)
            .set({ revokedAt: now, updatedAt: now })
            .where(and(eq(passkey.id, request.params.id), isNull(passkey.revokedAt)))
            .run();
          return 'ok' as const;
        });
        if (removed === 'missing') throw new AppError('not_found', 'That passkey was not found.');
        if (removed === 'last') {
          throw new AppError('conflict', 'Add another passkey before removing your last one.');
        }
        s.audit.record({
          actor: `device:${auth.deviceId}`,
          action: 'passkey.removed',
          targetType: 'passkey',
          targetId: request.params.id,
          ip: request.ip,
        });
        return { ok: true };
      },
    );

    /** Sets or changes the sign-in password (used with an authenticator code). */
    app.put(
      '/api/security/password',
      {
        schema: { body: setSignInPasswordSchema },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request) => {
        const auth = authOf(request);
        if (!s.owner.exists()) throw new AppError('not_found', 'Setup is not complete.');
        const changed = s.owner.hasPassword();
        await s.owner.setPassword(request.body.password);
        s.audit.record({
          actor: `device:${auth.deviceId}`,
          action: 'password.set',
          ip: request.ip,
          details: { changed },
        });
        return { ok: true };
      },
    );

    app.delete('/api/security/password', { preHandler: requireFreshAuth }, async (request) => {
      const auth = authOf(request);
      if (!s.owner.removePassword()) {
        throw new AppError('not_found', 'No sign-in password is set.');
      }
      s.audit.record({
        actor: `device:${auth.deviceId}`,
        action: 'password.removed',
        ip: request.ip,
      });
      return { ok: true };
    });
  };
}
