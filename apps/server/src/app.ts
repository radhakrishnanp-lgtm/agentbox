import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import session from '@fastify/session';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { ApiErrorBody } from '@agentbox/shared';
import { baseCookieOptions, cookieNames } from './auth/cookies.ts';
import { registerSecurity } from './http/security.ts';
import { AppError } from './lib/errors.ts';
import { newId } from './lib/ids.ts';
import { gatewayRoutes } from './gateway/relay.ts';
import { trackerRoutes } from './routes/tracker.ts';
import { machineScriptRoutes } from './gateway/script.ts';
import { auditRoutes } from './routes/audit.ts';
import { authRoutes } from './routes/auth.ts';
import { gatewayAdminRoutes } from './routes/gateway.ts';
import { healthRoutes } from './routes/health.ts';
import { securityRoutes } from './routes/security.ts';
import { setupRoutes } from './routes/setup.ts';
import { terminalRoutes } from './routes/terminals.ts';
import { terminalSocketRoutes } from './terminals/ws.ts';
import type { Services } from './services.ts';

export interface BuildOptions {
  logger?: FastifyServerOptions['logger'];
  /** Tests: capture the real production log output. */
  logStream?: { write(line: string): void };
}

export async function buildApp(s: Services, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const { config } = s;
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers["x-goog-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      // Never log query strings: a Gemini client may put its key (our pass) in ?key=.
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url.split('?')[0] ?? '',
          ip: req.ip,
        }),
      },
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    // Only Caddy can reach the Unix socket, so its X-Forwarded-For is trustworthy.
    // Over TCP, forwarded headers are believed only from the configured proxy
    // (for example Traefik in Docker); otherwise they are ignored.
    trustProxy: config.listen.kind === 'unix' ? true : (config.trustedProxies ?? false),
    genReqId: () => newId(),
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 200 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    const body = (
      code: ApiErrorBody['error']['code'],
      message: string,
      retryAfter?: number,
    ): ApiErrorBody => ({
      error: { code, message, requestId: request.id, ...(retryAfter ? { retryAfter } : {}) },
    });
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
      if (err.status >= 500) request.log.error({ err }, 'app error');
      return reply.code(err.status).send(body(err.code, err.message, err.retryAfter));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const first = err.validation[0];
      const field = first?.instancePath.replace(/^\//, '').replace(/\//g, '.');
      const message = first?.message ?? 'Some fields are not valid.';
      return reply.code(400).send(body('bad_request', field ? `${field}: ${message}` : message));
    }
    const status = err.statusCode ?? 500;
    if (status === 429)
      return reply.code(429).send(body('rate_limited', 'Too many requests. Please wait a moment.'));
    if (status >= 400 && status < 500) {
      return reply.code(status).send(body('bad_request', 'The request could not be processed.'));
    }
    request.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send(body('internal', 'Something went wrong on our side. Please try again.'));
  });

  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookieName: cookieNames(config).session,
    cookie: baseCookieOptions(config),
    store: s.sessionStore,
    saveUninitialized: false,
    rolling: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new AppError(
        'rate_limited',
        `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} s.`,
        {
          retryAfter: Math.ceil(context.ttl / 1000),
        },
      ),
  });
  await registerSecurity(app, config);

  await app.register(healthRoutes(s));
  await app.register(setupRoutes(s));
  await app.register(authRoutes(s));
  await app.register(securityRoutes(s));
  await app.register(auditRoutes(s));
  await app.register(gatewayAdminRoutes(s));
  await app.register(trackerRoutes(s));
  await app.register(gatewayRoutes(s));
  await app.register(machineScriptRoutes(s));
  await app.register(terminalRoutes(s));
  await app.register(terminalSocketRoutes(s));

  const webDist = config.webDist ? resolve(config.webDist) : undefined;
  const hasWeb = webDist !== undefined && existsSync(join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      setHeaders: (res, path) => {
        res.header(
          'Cache-Control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isPage =
      (request.method === 'GET' || request.method === 'HEAD') && !request.url.startsWith('/api/');
    if (isPage && hasWeb) {
      // Single-page app: the UI router renders the right screen (or its own 404).
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'not_found', message: 'Not found.', requestId: request.id },
    } satisfies ApiErrorBody);
  });

  return app;
}
