import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  newDeviceTotpSchema,
  passkeyVerifySchema,
  passwordSignInSchema,
  recoverySignInSchema,
  type AuthState,
  type SignInResult,
} from '@agentbox/shared';
import { cookieNames } from '../auth/cookies.ts';
import { sessionOf } from '../auth/sessions.ts';
import { loginTicket } from '../db/schema.ts';
import { MINUTE, iso } from '../lib/clock.ts';
import { hashToken, randomToken } from '../lib/crypto.ts';
import { AppError, invalidCredential } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { guards, authOf } from '../http/guards.ts';
import { POLICIES } from '../security/lockout.ts';
import type { Services } from '../services.ts';

const LOGIN_TICKET_TTL = 5 * MINUTE;

export function authRoutes(s: Services): FastifyPluginAsyncZod {
  return async (app) => {
    const { requireSession } = guards(s);

    /** Public: what the UI should show (setup, sign-in, or the app). */
    app.get(
      '/api/auth/state',
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (request): Promise<AuthState> => {
        const setupRequired = !s.setup.isComplete();
        let session = null;
        if (!setupRequired && sessionOf(request)?.rowId) {
          try {
            const auth = s.sessions.authenticate(request, false);
            session = s.sessions.info(auth.sessionId);
          } catch {
            session = null; // expired or revoked: the UI shows sign-in
          }
        }
        return { setupRequired, session };
      },
    );

    app.post(
      '/api/auth/passkey/options',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request) => {
        s.lockouts.assertOpen(ipKey(request), POLICIES.passkeyIp);
        return s.webauthn.authenticationOptions('login', null);
      },
    );

    app.post(
      '/api/auth/passkey/verify',
      {
        schema: { body: passkeyVerifySchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request, reply): Promise<SignInResult> => {
        s.lockouts.assertOpen(ipKey(request), POLICIES.passkeyIp);
        let passkeyId: string;
        try {
          passkeyId = await s.webauthn.verifyAuthentication(request.body.response, 'login', null);
        } catch (err) {
          failedLogin(request, 'passkey');
          throw err;
        }
        s.lockouts.succeed(ipKey(request));
        const dev = s.devices.ensure(request, reply);
        if (s.devices.isApproved(dev)) {
          const session = await s.sessions.start(request, dev.id);
          s.audit.record({
            actor: `device:${dev.id}`,
            action: 'auth.login',
            targetType: 'session',
            targetId: session.id,
            ip: request.ip,
            details: { method: 'passkey', passkeyId },
          });
          return { status: 'signed_in', session };
        }
        // Valid passkey, unknown browser: a second check is needed.
        const ticket = randomToken();
        const now = s.clock.now();
        s.db
          .insert(loginTicket)
          .values({
            id: newId(),
            ticketHash: hashToken(ticket),
            deviceId: dev.id,
            passkeyId,
            expiresAt: now + LOGIN_TICKET_TTL,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        s.audit.record({
          actor: `device:${dev.id}`,
          action: 'auth.device_approval_required',
          targetType: 'device',
          targetId: dev.id,
          ip: request.ip,
          details: { userAgent: dev.userAgent },
        });
        // LATER (Milestone 3): approval from an already-approved device, with number matching.
        return {
          status: 'device_approval_required',
          ticket,
          expiresAt: iso(now + LOGIN_TICKET_TTL),
        };
      },
    );

    /** Second step for a new device: passkey (ticket) + authenticator code. */
    app.post(
      '/api/auth/new-device/totp',
      {
        schema: { body: newDeviceTotpSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request, reply): Promise<SignInResult> => {
        s.lockouts.assertOpen('totp', POLICIES.totp);
        const dev = s.devices.current(request);
        const now = s.clock.now();
        const ticket = s.db
          .select()
          .from(loginTicket)
          .where(
            and(
              eq(loginTicket.ticketHash, hashToken(request.body.ticket)),
              isNull(loginTicket.usedAt),
              gt(loginTicket.expiresAt, now),
            ),
          )
          .get();
        if (!ticket || !dev || ticket.deviceId !== dev.id) {
          throw new AppError(
            'unauthorized',
            'This sign-in expired. Start again with your passkey.',
          );
        }
        if (!s.owner.consumeTotp(request.body.code)) {
          failedLogin(request, 'totp');
          throw invalidCredential();
        }
        s.lockouts.succeed('totp');
        const used = s.db
          .update(loginTicket)
          .set({ usedAt: now, updatedAt: now })
          .where(and(eq(loginTicket.id, ticket.id), isNull(loginTicket.usedAt)))
          .run();
        if (used.changes !== 1) throw new AppError('conflict', 'This sign-in was already used.');
        return approveAndStart(request, reply, dev.id, 'totp', request.body.deviceName);
      },
    );

    /** Last resort when every passkey is lost: authenticator code + recovery code. */
    app.post(
      '/api/auth/recovery',
      {
        schema: { body: recoverySignInSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (request, reply): Promise<SignInResult> => {
        s.lockouts.assertOpen('recovery', POLICIES.recovery);
        s.lockouts.assertOpen('totp', POLICIES.totp);
        const totpOk = s.owner.consumeTotp(request.body.code);
        // Always check the recovery code too, so timing doesn't reveal which part failed.
        // It is only used up when both parts are right, so a typo doesn't waste it.
        const recoveryId = await s.owner.matchRecoveryCode(request.body.recoveryCode);
        const recoveryOk = totpOk && recoveryId !== null && s.owner.useRecoveryCode(recoveryId);
        if (!recoveryOk) {
          failedLogin(request, 'recovery');
          throw invalidCredential();
        }
        s.lockouts.succeed('recovery');
        s.lockouts.succeed('totp');
        const dev = s.devices.ensure(request, reply);
        s.audit.record({
          actor: `device:${dev.id}`,
          action: 'auth.recovery_used',
          targetType: 'device',
          targetId: dev.id,
          ip: request.ip,
          details: { remaining: s.owner.recoveryCodesRemaining() },
        });
        return approveAndStart(request, reply, dev.id, 'recovery', request.body.deviceName);
      },
    );

    /**
     * For computers without a passkey: the sign-in password (set in Security)
     * plus an authenticator code. Both are always checked, and a failure never
     * says which part was wrong.
     */
    app.post(
      '/api/auth/password',
      {
        schema: { body: passwordSignInSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (request, reply): Promise<SignInResult> => {
        s.lockouts.assertOpen('password', POLICIES.password);
        s.lockouts.assertOpen('totp', POLICIES.totp);
        const passwordOk = await s.owner.verifyPassword(request.body.password);
        // Only a right password can use up the code, so guesses can't block your next one.
        const totpOk = passwordOk && s.owner.consumeTotp(request.body.code);
        if (!totpOk) {
          // A right password with a wrong code counts against the code, like new-device approval.
          failedLogin(request, passwordOk ? 'totp' : 'password');
          throw invalidCredential();
        }
        s.lockouts.succeed('password');
        s.lockouts.succeed('totp');
        const dev = s.devices.ensure(request, reply);
        if (!s.devices.isApproved(dev)) {
          return approveAndStart(request, reply, dev.id, 'password', request.body.deviceName);
        }
        const session = await s.sessions.start(request, dev.id);
        s.audit.record({
          actor: `device:${dev.id}`,
          action: 'auth.login',
          targetType: 'session',
          targetId: session.id,
          ip: request.ip,
          details: { method: 'password' },
        });
        return { status: 'signed_in', session };
      },
    );

    app.post('/api/auth/logout', async (request, reply) => {
      const rowId = sessionOf(request)?.rowId;
      await s.sessions.logout(request, reply, cookieNames(s.config).session);
      if (rowId) {
        s.audit.record({
          actor: 'owner',
          action: 'auth.logout',
          targetType: 'session',
          targetId: rowId,
          ip: request.ip,
        });
      }
      return { ok: true };
    });

    /** Called (throttled) by the UI when you type or click, to keep the idle timer alive. */
    app.post('/api/auth/activity', { preHandler: requireSession() }, async (request) => {
      return s.sessions.info(authOf(request).sessionId);
    });

    app.post(
      '/api/auth/reauth/options',
      { preHandler: requireSession(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (request) => s.webauthn.authenticationOptions('reauth', authOf(request).sessionId),
    );

    app.post(
      '/api/auth/reauth/verify',
      {
        schema: { body: passkeyVerifySchema },
        preHandler: requireSession(),
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (request) => {
        const auth = authOf(request);
        const passkeyId = await s.webauthn.verifyAuthentication(
          request.body.response,
          'reauth',
          auth.sessionId,
        );
        const session = await s.sessions.markFresh(request);
        s.audit.record({
          actor: `device:${auth.deviceId}`,
          action: 'auth.reauth',
          targetType: 'session',
          targetId: auth.sessionId,
          ip: request.ip,
          details: { passkeyId },
        });
        return session;
      },
    );

    async function approveAndStart(
      request: FastifyRequest,
      _reply: FastifyReply,
      deviceId: string,
      by: 'totp' | 'recovery' | 'password',
      name: string,
    ): Promise<SignInResult> {
      s.devices.approve(deviceId, by, name);
      s.audit.record({
        actor: `device:${deviceId}`,
        action: 'auth.device_approved',
        targetType: 'device',
        targetId: deviceId,
        ip: request.ip,
        details: { method: by, name },
      });
      // LATER (Milestone 5): Telegram alert "new device signed in".
      const session = await s.sessions.start(request, deviceId);
      s.audit.record({
        actor: `device:${deviceId}`,
        action: 'auth.login',
        targetType: 'session',
        targetId: session.id,
        ip: request.ip,
        details: { method: by },
      });
      return { status: 'signed_in', session };
    }

    function failedLogin(
      request: FastifyRequest,
      method: 'passkey' | 'totp' | 'recovery' | 'password',
    ): void {
      const key = method === 'passkey' ? ipKey(request) : method;
      const policy = method === 'passkey' ? POLICIES.passkeyIp : POLICIES[method];
      const locked = s.lockouts.fail(key, policy);
      s.audit.record({
        actor: 'anonymous',
        action: 'auth.login_failed',
        ip: request.ip,
        details: { method },
      });
      // A distinctive log line for the fail2ban jail (see deploy/fail2ban).
      request.log.warn(
        { event: 'auth_failed', method, ip: request.ip },
        `agentbox auth failure from ${request.ip}`,
      );
      if (locked) {
        s.audit.record({
          actor: 'system',
          action: 'auth.lockout',
          ip: request.ip,
          details: { key },
        });
      }
    }
  };
}

function ipKey(request: FastifyRequest): string {
  return `passkey:ip:${request.ip}`;
}
