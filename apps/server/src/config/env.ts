/**
 * Environment validation. The app refuses to start with a clear message when a
 * value is missing or unsafe, instead of failing later in a confusing way.
 */
import { z } from 'zod';

const base64Key = z
  .string()
  .trim()
  .refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)',
  })
  .transform((v) => Buffer.from(v, 'base64'));

const listenSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v.startsWith('unix:')) {
      const path = v.slice('unix:'.length);
      if (!path.startsWith('/')) {
        ctx.addIssue({ code: 'custom', message: 'unix socket path must be absolute' });
        return z.NEVER;
      }
      return { kind: 'unix' as const, path };
    }
    const m = /^(127\.0\.0\.1|\[::1\]|localhost|[\d.]+):(\d{2,5})$/.exec(v);
    const [, host, port] = m ?? [];
    if (!host || !port || !isLoopbackOrPrivate(host)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'use unix:/path/to.sock, 127.0.0.1:<port>, or a private bridge address like ' +
          '172.18.0.1:<port> for a reverse proxy in Docker (never a public address)',
      });
      return z.NEVER;
    }
    return { kind: 'tcp' as const, host: host.replace(/[[\]]/g, ''), port: Number(port) };
  });

/** Loopback, or an RFC 1918 address such as a Docker bridge gateway. Never 0.0.0.0 or public. */
function isLoopbackOrPrivate(host: string): boolean {
  if (host === '127.0.0.1' || host === '[::1]' || host === 'localhost') return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Comma-separated IPs or CIDRs of the reverse proxy allowed to set X-Forwarded-* headers. */
const trustedProxiesSchema = z
  .string()
  .trim()
  .transform((v) =>
    v
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]))
      .min(1)
      .max(16),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
    AGENTBOX_ORIGIN: z.url({ protocol: /^https?$/ }).transform((v) => new URL(v).origin),
    AGENTBOX_RP_ID: z.string().trim().min(1).optional(),
    AGENTBOX_RP_NAME: z.string().trim().min(1).max(64).default('agentbox'),
    AGENTBOX_DATA_DIR: z.string().trim().min(1).default('/var/lib/agentbox'),
    AGENTBOX_LISTEN: listenSchema.prefault('unix:/run/agentbox/web.sock'),
    AGENTBOX_TRUSTED_PROXIES: trustedProxiesSchema.optional(),
    AGENTBOX_WEB_DIST: z.string().trim().optional(),
    AGENTBOX_ENCRYPTION_KEY: base64Key,
    AGENTBOX_ENCRYPTION_KEY_PREVIOUS: base64Key.optional(),
    AGENTBOX_SESSION_SECRET: z
      .string()
      .min(32, 'must be at least 32 characters (openssl rand -base64 48)'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.AGENTBOX_LISTEN.kind === 'unix' && env.AGENTBOX_TRUSTED_PROXIES) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENTBOX_TRUSTED_PROXIES'],
        message: 'only applies to TCP listening; the Unix socket already trusts its proxy',
      });
    }
    const origin = new URL(env.AGENTBOX_ORIGIN);
    if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENTBOX_ORIGIN'],
        message: 'must use https:// in production',
      });
    }
    const rpId = env.AGENTBOX_RP_ID ?? origin.hostname;
    if (origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENTBOX_RP_ID'],
        message: 'must be the origin hostname (recommended) or a parent domain of it',
      });
    }
  });

export interface Config {
  env: 'production' | 'development' | 'test';
  origin: string;
  secureCookies: boolean;
  rpId: string;
  rpName: string;
  dataDir: string;
  listen: { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number };
  /** Proxies whose X-Forwarded-* headers are believed when listening on TCP. */
  trustedProxies: string[] | undefined;
  webDist: string | undefined;
  encryptionKey: Buffer;
  encryptionKeyPrevious: Buffer | undefined;
  sessionSecret: string;
  logLevel: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`agentbox cannot start, fix these settings:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const origin = new URL(e.AGENTBOX_ORIGIN);
  return {
    env: e.NODE_ENV,
    origin: e.AGENTBOX_ORIGIN,
    secureCookies: origin.protocol === 'https:',
    rpId: e.AGENTBOX_RP_ID ?? origin.hostname,
    rpName: e.AGENTBOX_RP_NAME,
    dataDir: e.AGENTBOX_DATA_DIR,
    listen: e.AGENTBOX_LISTEN,
    trustedProxies: e.AGENTBOX_TRUSTED_PROXIES,
    webDist: e.AGENTBOX_WEB_DIST,
    encryptionKey: e.AGENTBOX_ENCRYPTION_KEY,
    encryptionKeyPrevious: e.AGENTBOX_ENCRYPTION_KEY_PREVIOUS,
    sessionSecret: e.AGENTBOX_SESSION_SECRET,
    logLevel: e.LOG_LEVEL,
  };
}
