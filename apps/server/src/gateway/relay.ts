/**
 * The key gateway relay: `<origin>/gw/<slug>/<provider path>`.
 *
 * A CLI on a machine sends its normal provider request here with the
 * machine's pass where the API key would go. agentbox checks the pass, the
 * machine's IP lock and limits, swaps the pass for the real key and streams
 * the provider's answer back. The real key never leaves this server, and
 * revoking the machine cuts even a response that is still streaming.
 *
 * This route is for programs, not browsers: it takes no cookies and is exempt
 * from the browser CSRF checks, and every request must carry a pass.
 */
import { Transform } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { request as upstreamRequest, Agent } from 'undici';
import { passSchema } from '@agentbox/shared';
import type { TermdGrokToken } from '@agentbox/shared/termd';
import { TermdRefused } from '../terminals/client.ts';
import { MINUTE, iso } from '../lib/clock.ts';
import type { LockoutPolicy } from '../security/lockout.ts';
import type { Services } from '../services.ts';
import { AppError } from '../lib/errors.ts';
import { ipAllowed, type AiKeyRow, type MachineRow } from './store.ts';
import { requestModel, UsageMeter } from './usage.ts';

export const GATEWAY_BODY_LIMIT = 32 * 1024 * 1024;
const MAX_CONCURRENT_PER_MACHINE = 16;
const WATCHDOG_MS = 2000;

/** Anthropic's beta flag that lets a Claude subscription token call the Messages API. */
/** Logged when the machine gave up before the provider answered (nginx's convention). */
const CLIENT_CLOSED = 499;
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

/** Wrong passes from one IP: 20 in 10 min locks it for 10 min, doubling up to a day. */
export const BAD_PASS_POLICY: LockoutPolicy = {
  maxFailures: 20,
  windowMs: 10 * MINUTE,
  baseLockMs: 10 * MINUTE,
  maxLockMs: 24 * 60 * MINUTE,
  message: 'Too many wrong passes from this address. Try again later.',
};

// Never forwarded upstream: hop-by-hop headers, anything that could carry a
// credential or a cookie, and proxy headers that would reveal the machine.
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'cookie',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'forwarded',
  'via',
  'origin',
  'referer',
  'x-real-ip',
  'true-client-ip',
  'x-agentbox',
]);
const DROP_REQUEST_PATTERN = /^(x-forwarded-|cf-|sec-|x-amzn-)|(token|secret|password|cookie)/i;

const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'set-cookie',
  'alt-svc',
  'strict-transport-security',
]);

type ErrorType =
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'invalid_request_error'
  | 'api_error';

/** Errors shaped so Anthropic, OpenAI and Gemini clients all show the message. */
function fail(
  reply: FastifyReply,
  status: number,
  type: ErrorType,
  message: string,
  retryAfter?: number,
) {
  if (retryAfter) reply.header('retry-after', String(retryAfter));
  return reply
    .code(status)
    .header('content-type', 'application/json')
    .header('cache-control', 'no-store')
    .send({ type: 'error', error: { type, code: type, message: `agentbox: ${message}` } });
}

/** A request path under the provider's base address, refusing anything odd. */
export function safePath(rest: string): string | null {
  const path = `/${rest}`;
  if (path.length > 2000) return null;
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path)) return null;
  if (/%(2e|2f|5c|00)/i.test(path)) return null;
  if (/\/\//.test(path) || /(^|\/)\.{1,2}(\/|$)/.test(path)) return null;
  return path;
}

/** The query string without any `key=` parameter (Gemini's way of sending a key). */
export function cleanQuery(rawUrl: string): { query: string; key: string | undefined } {
  const i = rawUrl.indexOf('?');
  if (i < 0) return { query: '', key: undefined };
  const params = new URLSearchParams(rawUrl.slice(i + 1));
  const key = params.get('key') ?? undefined;
  params.delete('key');
  const query = params.toString();
  return { query: query ? `?${query}` : '', key };
}

function presentedPass(request: FastifyRequest, queryKey: string | undefined): string | undefined {
  const h = request.headers;
  const auth = typeof h.authorization === 'string' ? h.authorization : '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  for (const v of [h['x-api-key'], bearer, h['x-goog-api-key'], h['api-key'], queryKey]) {
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export function upstreamHeaders(
  incoming: FastifyRequest['headers'],
  key: AiKeyRow,
  secret: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const n = name.toLowerCase();
    if (value === undefined || DROP_REQUEST.has(n) || DROP_REQUEST_PATTERN.test(n)) continue;
    out[n] = Array.isArray(value) ? value.join(', ') : value;
  }
  out['accept-encoding'] = 'identity';
  switch (key.auth) {
    case 'x-api-key':
      out['x-api-key'] = secret;
      break;
    case 'x-goog-api-key':
      out['x-goog-api-key'] = secret;
      break;
    case 'bearer':
      out['authorization'] = `Bearer ${secret}`;
      break;
    case 'anthropic-oauth': {
      out['authorization'] = `Bearer ${secret}`;
      const betas = (out['anthropic-beta'] ?? '')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
      if (!betas.includes(ANTHROPIC_OAUTH_BETA)) betas.push(ANTHROPIC_OAUTH_BETA);
      out['anthropic-beta'] = betas.join(',');
      break;
    }
  }
  return out;
}

/** In-memory counters for speed limits and live streams (per process). */
export class RelayState {
  readonly #recent = new Map<string, number[]>();
  readonly #live = new Map<string, Set<AbortController>>();
  readonly #auditedAt = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;

  /** Sliding one-minute window. Returns seconds to wait, or 0 if allowed. */
  take(machineId: string, rpm: number, now: number): number {
    const times = (this.#recent.get(machineId) ?? []).filter((t) => now - t < MINUTE);
    if (times.length >= rpm) {
      this.#recent.set(machineId, times);
      return Math.max(1, Math.ceil((MINUTE - (now - (times[0] ?? now))) / 1000));
    }
    times.push(now);
    this.#recent.set(machineId, times);
    return 0;
  }

  liveCount(machineId: string): number {
    return this.#live.get(machineId)?.size ?? 0;
  }

  track(machineId: string, ctrl: AbortController): () => void {
    let set = this.#live.get(machineId);
    if (!set) this.#live.set(machineId, (set = new Set()));
    set.add(ctrl);
    return () => {
      set.delete(ctrl);
      if (set.size === 0) this.#live.delete(machineId);
    };
  }

  /** Cuts every live stream of a machine. */
  cut(machineId: string): void {
    for (const c of this.#live.get(machineId) ?? []) c.abort(new Error('machine revoked'));
  }

  /** Audit a repeated event at most once per hour per machine and reason. */
  shouldAudit(key: string, now: number): boolean {
    const last = this.#auditedAt.get(key);
    if (last !== undefined && now - last < 60 * MINUTE) return false;
    this.#auditedAt.set(key, now);
    return true;
  }

  /** Revocations can also come from the SSH admin command, so poll the database. */
  startWatchdog(isRevoked: (id: string) => boolean): void {
    this.#timer = setInterval(() => {
      for (const id of this.#live.keys()) if (isRevoked(id)) this.cut(id);
    }, WATCHDOG_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    for (const id of this.#live.keys()) this.cut(id);
  }
}

const dispatcher = new Agent({
  // Long answers with extended thinking can take minutes before the first byte.
  headersTimeout: 10 * MINUTE,
  bodyTimeout: 10 * MINUTE,
  connect: { timeout: 15_000 },
});

export function gatewayRoutes(s: Services): FastifyPluginAsync {
  return async (app) => {
    const state = s.relay;
    state.startWatchdog((id) => s.gateway.isRevoked(id));
    app.addHook('onClose', async () => {
      state.stop();
    });

    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    const authenticate = (
      request: FastifyRequest,
      reply: FastifyReply,
      queryKey: string | undefined,
    ): MachineRow | FastifyReply => {
      const ipKey = `gateway:ip:${request.ip}`;
      try {
        s.lockouts.assertOpen(ipKey, BAD_PASS_POLICY);
      } catch (err) {
        const retry = err instanceof AppError ? err.retryAfter : undefined;
        return fail(reply, 429, 'rate_limit_error', BAD_PASS_POLICY.message, retry);
      }
      const pass = presentedPass(request, queryKey);
      const m =
        pass && passSchema.safeParse(pass).success ? s.gateway.machineByPass(pass) : undefined;
      if (!m) {
        if (s.lockouts.fail(ipKey, BAD_PASS_POLICY)) {
          s.audit.record({
            actor: 'gateway',
            action: 'machine.bad_pass_lockout',
            ip: request.ip,
          });
        }
        return fail(
          reply,
          401,
          'authentication_error',
          'this machine has no valid agentbox pass. Run the agentbox machine setup again.',
        );
      }
      const now = s.clock.now();
      // 403, not 401, from here on: the pass is known, so the CLI should stop
      // and show the message instead of retrying a login (Claude Code retries
      // a 401 for minutes).
      if (m.revokedAt !== null) {
        return fail(reply, 403, 'permission_error', 'this machine was stopped in agentbox.');
      }
      if (m.expiresAt !== null && m.expiresAt <= now) {
        return fail(
          reply,
          403,
          'permission_error',
          `this machine's pass expired on ${iso(m.expiresAt)}. Renew it in agentbox → Machines.`,
        );
      }
      if (!ipAllowed(request.ip, m.ipRules)) {
        if (state.shouldAudit(`${m.id}:ip:${request.ip}`, now)) {
          s.audit.record({
            actor: `machine:${m.id}`,
            action: 'machine.blocked_ip',
            targetType: 'machine',
            targetId: m.id,
            ip: request.ip,
            details: { name: m.name },
          });
        }
        return fail(
          reply,
          403,
          'permission_error',
          `this machine's pass is locked to other addresses (this one is ${request.ip}).`,
        );
      }
      return m;
    };

    /** Records use, and writes a security event the first time and whenever the address changes. */
    const seen = (m: MachineRow, ip: string) => {
      if (m.lastIp !== ip) {
        s.audit.record({
          actor: `machine:${m.id}`,
          action: m.lastIp === null ? 'machine.first_used' : 'machine.ip_changed',
          targetType: 'machine',
          targetId: m.id,
          ip,
          details: { name: m.name, ...(m.lastIp ? { previousIp: m.lastIp } : {}) },
        });
      }
      s.gateway.markSeen(m.id, ip);
    };

    /**
     * A Grok login key has no provider to relay to: the machine's grok asks
     * here for a short-lived access token (its auth_provider_command) and then
     * talks to xAI itself. The refresh token never leaves termd.
     */
    const grokToken = async (
      request: FastifyRequest,
      reply: FastifyReply,
      m: MachineRow,
      key: AiKeyRow,
      path: string,
      started: number,
    ) => {
      if (path !== '/_token' || request.method !== 'GET') {
        return fail(
          reply,
          404,
          'not_found_error',
          `“${key.slug}” hands out Grok sign-in tokens only. Run grok through the agentbox command on this machine.`,
        );
      }
      let status = 200;
      try {
        const t = await s.terminals.client.request<TermdGrokToken>({ op: 'grok.token' });
        const now = s.clock.now();
        if (state.shouldAudit(`${m.id}:grok-token`, now)) {
          s.audit.record({
            actor: `machine:${m.id}`,
            action: 'machine.grok_token',
            targetType: 'machine',
            targetId: m.id,
            ip: request.ip,
            details: { name: m.name, key: key.slug, expiresAt: iso(t.expiresAt) },
          });
        }
        reply.header('cache-control', 'no-store');
        return await reply.send({
          access_token: t.token,
          expires_in: Math.max(0, Math.floor((t.expiresAt - now) / 1000)),
          issuer: 'https://auth.x.ai',
        });
      } catch (err) {
        const message =
          err instanceof TermdRefused
            ? err.code === 'vault_locked'
              ? 'the vault on agentbox is locked. Unlock it in agentbox → Terminals.'
              : err.message
            : err instanceof AppError
              ? err.message
              : 'could not get a Grok token.';
        status = err instanceof TermdRefused && err.code !== 'internal' ? 409 : 503;
        return await fail(reply, status, 'api_error', message);
      } finally {
        s.gateway.recordUsage({
          ts: started,
          machineId: m.id,
          keyId: key.id,
          keySlug: key.slug,
          method: request.method,
          path,
          model: null,
          status,
          durationMs: Math.max(0, s.clock.now() - started),
          requestBytes: 0,
          responseBytes: 0,
          inputTokens: null,
          outputTokens: null,
        });
        s.gateway.touchKey(key.id);
      }
    };

    // What the machine setup script needs: which CLIs to wire up, and where.
    app.get('/gw/_machine', { config: { rateLimit: false } }, async (request, reply) => {
      const m = authenticate(request, reply, undefined);
      if (!('id' in m)) return m;
      seen(m, request.ip);
      const keys = s.gateway.activeKeys().filter((k) => m.keyIds.includes(k.id));
      const expires = m.expiresAt === null ? 'until stopped' : iso(m.expiresAt);
      reply.header('cache-control', 'no-store');
      if ((request.headers.accept ?? '').includes('text/plain')) {
        // Tab-separated for the POSIX setup script, which has no JSON parser.
        const lines = [
          ['machine', expires, m.name],
          // A login key's cli column is "grok-login": older scripts don't know it and skip it.
          ...keys.map((k) => [
            'key',
            k.slug,
            k.auth === 'grok-login' ? 'grok-login' : (k.cli ?? '-'),
            k.model ?? '-',
            k.name,
          ]),
        ];
        return reply
          .type('text/plain; charset=utf-8')
          .send(`${lines.map((l) => l.join('\t')).join('\n')}\n`);
      }
      return reply.send({
        machine: { name: m.name, expiresAt: m.expiresAt === null ? null : iso(m.expiresAt) },
        keys: keys.map((k) => ({
          name: k.name,
          slug: k.slug,
          cli: k.cli,
          url: s.gateway.gatewayUrl(k.slug),
        })),
      });
    });

    app.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/gw/:slug/*',
      bodyLimit: GATEWAY_BODY_LIMIT,
      config: { rateLimit: false },
      handler: async (request, reply) => {
        const started = s.clock.now();
        const { slug } = request.params as { slug: string };
        // Use the raw path, not the router's decoded copy, so what we check is
        // exactly what the provider receives.
        const rawPath = (request.raw.url ?? '').split('?')[0] ?? '';
        const prefix = `/gw/${slug}/`;
        const path = rawPath.startsWith(prefix) ? safePath(rawPath.slice(prefix.length)) : null;
        if (!path) return fail(reply, 400, 'invalid_request_error', 'that path is not allowed.');
        const { query, key: queryKey } = cleanQuery(request.raw.url ?? '');

        const m = authenticate(request, reply, queryKey);
        if (!('id' in m)) return m;
        s.lockouts.succeed(`gateway:ip:${request.ip}`);

        const key = s.gateway.keyBySlug(slug);
        if (!key) return fail(reply, 404, 'not_found_error', `there is no key called “${slug}”.`);
        if (!m.keyIds.includes(key.id)) {
          return fail(
            reply,
            403,
            'permission_error',
            `this machine may not use the “${slug}” key. Allow it in agentbox → Machines.`,
          );
        }

        const now = s.clock.now();
        const wait = state.take(m.id, m.rpm, now);
        if (wait > 0) {
          if (state.shouldAudit(`${m.id}:rpm`, now)) {
            s.audit.record({
              actor: `machine:${m.id}`,
              action: 'machine.limit_hit',
              targetType: 'machine',
              targetId: m.id,
              ip: request.ip,
              details: { limit: 'requests_per_minute', value: m.rpm },
            });
          }
          return fail(
            reply,
            429,
            'rate_limit_error',
            `speed limit reached (${m.rpm} requests a minute for this machine).`,
            wait,
          );
        }
        if (state.liveCount(m.id) >= MAX_CONCURRENT_PER_MACHINE) {
          return fail(
            reply,
            429,
            'rate_limit_error',
            'too many requests at once from this machine.',
            2,
          );
        }
        if (m.dailyTokenLimit !== null) {
          const today = s.gateway.usageToday(m.id);
          if (today.inputTokens + today.outputTokens >= m.dailyTokenLimit) {
            if (state.shouldAudit(`${m.id}:daily`, now)) {
              s.audit.record({
                actor: `machine:${m.id}`,
                action: 'machine.limit_hit',
                targetType: 'machine',
                targetId: m.id,
                ip: request.ip,
                details: { limit: 'daily_tokens', value: m.dailyTokenLimit },
              });
            }
            return fail(
              reply,
              429,
              'rate_limit_error',
              `daily token limit reached for this machine (${m.dailyTokenLimit.toLocaleString('en')}). It resets at 00:00 UTC.`,
              3600,
            );
          }
        }

        seen(m, request.ip);

        if (key.auth === 'grok-login') return grokToken(request, reply, m, key, path, started);

        const body = Buffer.isBuffer(request.body) ? request.body : undefined;
        const model = requestModel(body, path);
        const ctrl = new AbortController();
        const untrack = state.track(m.id, ctrl);
        let responseBytes = 0;
        let status = 502;
        const usageRef: { meter: UsageMeter | undefined } = { meter: undefined };
        let recorded = false;
        const record = () => {
          if (recorded) return;
          recorded = true;
          untrack();
          const usage = usageRef.meter?.finish() ?? { inputTokens: null, outputTokens: null };
          s.gateway.recordUsage({
            ts: started,
            machineId: m.id,
            keyId: key.id,
            keySlug: key.slug,
            method: request.method,
            path,
            model,
            status,
            durationMs: Math.max(0, s.clock.now() - started),
            requestBytes: body?.length ?? 0,
            responseBytes,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
          s.gateway.touchKey(key.id);
        };
        let answered = false;
        // The machine hung up: stop paying for an answer nobody will read.
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) {
            if (!answered) status = CLIENT_CLOSED;
            ctrl.abort(new Error('client closed'));
          }
          record();
        });

        let upstream: Awaited<ReturnType<typeof upstreamRequest>>;
        try {
          upstream = await upstreamRequest(`${key.upstream}${path}${query}`, {
            method: request.method as 'GET',
            headers: upstreamHeaders(request.headers, key, s.gateway.revealSecret(key)),
            ...(body && request.method !== 'GET' ? { body } : {}),
            signal: ctrl.signal,
            dispatcher,
          });
        } catch (err) {
          record();
          if (ctrl.signal.aborted) return reply;
          request.log.warn({ err: (err as Error).message, slug }, 'gateway upstream failed');
          return fail(reply, 502, 'api_error', `could not reach ${new URL(key.upstream).host}.`);
        }

        answered = true;
        status = upstream.statusCode;
        reply.code(status);
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value === undefined || DROP_RESPONSE.has(name.toLowerCase())) continue;
          reply.header(name, value);
        }
        reply.header('cache-control', 'no-store');
        const contentType = upstream.headers['content-type'];
        const encoded = upstream.headers['content-encoding'];
        usageRef.meter =
          encoded && encoded !== 'identity'
            ? undefined
            : new UsageMeter(Array.isArray(contentType) ? contentType[0] : contentType);
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            responseBytes += chunk.length;
            usageRef.meter?.push(chunk);
            cb(null, chunk);
          },
        });
        tap.on('end', record);
        tap.on('error', record);
        upstream.body.on('error', (err) => tap.destroy(err));
        return reply.send(upstream.body.pipe(tap));
      },
    });
  };
}
