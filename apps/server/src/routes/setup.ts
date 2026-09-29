import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  setupCompleteSchema,
  setupPasskeyRequestSchema,
  setupTokenRequestSchema,
  setupTotpConfirmSchema,
  type SetupCompleteResult,
  type SetupTotpInit,
} from '@agentbox/shared';
import { createRecoveryCodes } from '../auth/recovery-codes.ts';
import { matchTotpStep, newTotpSecret, totpUri } from '../auth/totp.ts';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../services.ts';

const setupRateLimit = { rateLimit: { max: 30, timeWindow: '1 hour' } };

export function setupRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/api/setup/status',
      { schema: { body: setupTokenRequestSchema }, config: setupRateLimit },
      async (request) => {
        const row = s.setup.resolve(request.body.token);
        return { step: s.setup.step(row), expiresAt: new Date(row.expiresAt).toISOString() };
      },
    );

    app.post(
      '/api/setup/passkey/options',
      { schema: { body: setupTokenRequestSchema }, config: setupRateLimit },
      async (request) => {
        const row = s.setup.resolve(request.body.token);
        return s.webauthn.registrationOptions({
          purpose: 'setup',
          boundTo: row.id,
          userId: s.setup.webauthnUserId(row),
          userName: `agentbox (${new URL(s.config.origin).hostname})`,
        });
      },
    );

    app.post(
      '/api/setup/passkey',
      { schema: { body: setupPasskeyRequestSchema }, config: setupRateLimit },
      async (request) => {
        const row = s.setup.resolve(request.body.token);
        const cred = await s.webauthn.verifyRegistration(request.body.response, 'setup', row.id);
        s.setup.savePasskey(row, {
          credentialId: cred.credentialId,
          publicKey: Buffer.from(cred.publicKey).toString('base64url'),
          counter: cred.counter,
          transports: cred.transports,
          deviceType: cred.deviceType,
          backedUp: cred.backedUp,
          aaguid: cred.aaguid,
        });
        return { step: 'totp' as const };
      },
    );

    app.post(
      '/api/setup/totp/init',
      { schema: { body: setupTokenRequestSchema }, config: setupRateLimit },
      async (request): Promise<SetupTotpInit> => {
        const row = s.setup.resolve(request.body.token);
        if (s.setup.step(row) === 'passkey') {
          throw new AppError('bad_request', 'Create your passkey first.');
        }
        const secret = newTotpSecret();
        s.setup.saveTotpSecret(row, secret);
        const host = new URL(s.config.origin).hostname;
        return { otpauthUri: totpUri(secret, 'agentbox', host), secret };
      },
    );

    app.post(
      '/api/setup/totp/confirm',
      { schema: { body: setupTotpConfirmSchema }, config: setupRateLimit },
      async (request) => {
        const row = s.setup.resolve(request.body.token);
        const secret = s.setup.pendingTotpSecret(row);
        if (!secret) throw new AppError('bad_request', 'Scan the QR code first.');
        const step = matchTotpStep(secret, request.body.code, s.clock.now());
        if (step === null) {
          throw new AppError(
            'invalid_credential',
            "That code didn't match. Check your phone's clock and try the newest code.",
          );
        }
        s.setup.confirmTotp(row, step);
        return { step: 'finish' as const };
      },
    );

    app.post(
      '/api/setup/complete',
      { schema: { body: setupCompleteSchema }, config: setupRateLimit },
      async (request, reply): Promise<SetupCompleteResult> => {
        const row = s.setup.resolve(request.body.token);
        if (s.setup.step(row) !== 'finish') {
          throw new AppError('bad_request', 'Finish the passkey and authenticator steps first.');
        }
        const { codes, hashes } = await createRecoveryCodes();
        const dev = s.devices.ensure(request, reply);
        s.setup.complete(row, {
          deviceId: dev.id,
          deviceName: request.body.deviceName,
          recoveryHashes: hashes,
        });
        s.audit.record({
          actor: `device:${dev.id}`,
          action: 'setup.completed',
          targetType: 'device',
          targetId: dev.id,
          ip: request.ip,
          details: { deviceName: request.body.deviceName },
        });
        const session = await s.sessions.start(request, dev.id);
        return { recoveryCodes: codes, session };
      },
    );
  };
}
