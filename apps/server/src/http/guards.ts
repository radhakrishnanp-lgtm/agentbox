import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Services } from '../services.ts';
import { AppError } from '../lib/errors.ts';

/**
 * Route guards. `requireSession` is the default for every non-public route;
 * `passive` requests (background refreshes) don't reset the idle timer.
 */
export function guards(services: Services) {
  const requireSession =
    (opts: { passive?: boolean } = {}): preHandlerAsyncHookHandler =>
    async (request: FastifyRequest) => {
      request.auth = services.sessions.authenticate(request, !opts.passive);
    };

  /** Sensitive actions need a passkey check from the last 5 minutes. */
  const requireFreshAuth: preHandlerAsyncHookHandler = async (request) => {
    request.auth = services.sessions.authenticate(request, true);
    if (!services.sessions.isFresh(request.auth)) {
      throw new AppError('fresh_auth_required', 'Confirm it is you with your passkey first.');
    }
  };

  return { requireSession, requireFreshAuth };
}

export function authOf(request: FastifyRequest) {
  if (!request.auth) throw new AppError('unauthorized', 'Please sign in.');
  return request.auth;
}
