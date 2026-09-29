/**
 * Owner API for terminals and the vault.
 * Creating the vault, resetting it and storing its password for auto-unlock
 * need a fresh passkey check. Locking never does: making things safer is one tap.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  terminalCreateSchema,
  terminalNameSchema,
  terminalRenameSchema,
  vaultInitSchema,
  vaultResetSchema,
  vaultSettingsSchema,
  vaultUnlockSchema,
  type TerminalOverview,
} from '@agentbox/shared';
import { authOf, guards } from '../http/guards.ts';
import { AppError } from '../lib/errors.ts';
import { POLICIES } from '../security/lockout.ts';
import type { Services } from '../services.ts';
import { TermdRefused } from '../terminals/client.ts';

export function terminalRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession, requireFreshAuth } = guards(s);
    const by = (request: Parameters<typeof authOf>[0]) => ({
      actor: `device:${authOf(request).deviceId}`,
      ip: request.ip,
    });
    const nameParams = { params: z.object({ name: terminalNameSchema }) };

    app.get(
      '/api/terminals',
      { preHandler: requireSession({ passive: true }) },
      async (): Promise<TerminalOverview> => s.terminals.overview(),
    );

    app.post(
      '/api/terminals',
      {
        schema: { body: terminalCreateSchema },
        preHandler: requireSession(),
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (request) => {
        await s.terminals.create(request.body.name, request.body.preset, by(request));
        return { ok: true };
      },
    );

    app.patch(
      '/api/terminals/:name',
      { schema: { ...nameParams, body: terminalRenameSchema }, preHandler: requireSession() },
      async (request) => {
        await s.terminals.rename(request.params.name, request.body.name, by(request));
        return { ok: true };
      },
    );

    app.delete(
      '/api/terminals/:name',
      { schema: nameParams, preHandler: requireSession() },
      async (request) => {
        await s.terminals.kill(request.params.name, by(request));
        return { ok: true };
      },
    );

    app.post(
      '/api/terminals/vault/init',
      {
        schema: { body: vaultInitSchema },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (request) => {
        await s.terminals.vaultInit(request.body.password, request.body.autoUnlock, by(request));
        return { ok: true };
      },
    );

    app.post(
      '/api/terminals/vault/unlock',
      {
        schema: { body: vaultUnlockSchema },
        preHandler: requireSession(),
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request) => {
        const password = request.body.password;
        if (!password) throw new AppError('bad_request', 'Enter the vault password.');
        s.lockouts.assertOpen('vault', POLICIES.vault);
        try {
          await s.terminals.vaultUnlock(password, by(request));
        } catch (err) {
          if (err instanceof TermdRefused) {
            if (err.code === 'wrong_password') s.lockouts.fail('vault', POLICIES.vault);
            throw err.toAppError();
          }
          throw err;
        }
        s.lockouts.succeed('vault');
        return { ok: true };
      },
    );

    app.post('/api/terminals/vault/lock', { preHandler: requireSession() }, async (request) => {
      await s.terminals.vaultLock(by(request));
      return { ok: true };
    });

    app.put(
      '/api/terminals/vault/settings',
      {
        schema: { body: vaultSettingsSchema },
        preHandler: requireFreshAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request) => {
        await s.terminals.setAutoUnlock(
          request.body.autoUnlock,
          request.body.password,
          by(request),
        );
        return { ok: true, autoUnlock: s.terminals.autoUnlock() };
      },
    );

    app.post(
      '/api/terminals/vault/reset',
      { schema: { body: vaultResetSchema }, preHandler: requireFreshAuth },
      async (request) => {
        await s.terminals.vaultReset(by(request));
        return { ok: true };
      },
    );
  };
}
