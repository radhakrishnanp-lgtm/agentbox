/**
 * Browser-facing protections applied to every request:
 * - CSRF: unsafe methods must come from our own origin (Origin + Fetch
 *   Metadata), carry JSON, and send the X-Agentbox header, which a cross-site
 *   page cannot add without a CORS preflight that we never approve. Together
 *   with SameSite=Strict cookies this follows OWASP's token-less defences.
 * - Strict security headers and CSP via helmet.
 * - API responses are never cached.
 */
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  const wsOrigin = config.origin.replace(/^http/, 'ws');
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        // xterm.js and Radix set inline style attributes at runtime; scripts stay strict.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", wsOrigin],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: config.secureCookies
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: false }
      : false,
    xFrameOptions: { action: 'deny' },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(
      'Permissions-Policy',
      'publickey-credentials-get=(self), publickey-credentials-create=(self), clipboard-write=(self), ' +
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (request.url.startsWith('/api/') || request.url === '/healthz') {
      reply.header('Cache-Control', 'no-store');
    }
    if (SAFE_METHODS.has(request.method)) return;
    // The key gateway is called by CLIs, not browsers. It takes no cookies and
    // authenticates every request with a machine pass instead.
    if (request.url.startsWith('/gw/')) return;

    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (origin !== config.origin || (fetchSite !== undefined && fetchSite !== 'same-origin')) {
      throw new AppError('forbidden', 'Request blocked: it did not come from agentbox itself.');
    }
    if (request.headers['x-agentbox'] !== '1') {
      throw new AppError('forbidden', 'Request blocked: missing agentbox header.');
    }
    const type = request.headers['content-type'];
    const hasBody =
      request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0';
    if (hasBody && !type?.startsWith('application/json')) {
      throw new AppError('bad_request', 'Send JSON.');
    }
  });
}
