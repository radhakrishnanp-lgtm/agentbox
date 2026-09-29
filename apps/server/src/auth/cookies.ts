import type { Config } from '../config/env.ts';

/**
 * Cookie names. Over HTTPS the `__Host-` prefix makes browsers refuse any
 * version of the cookie set by another subdomain or without Secure/Path=/,
 * which blocks cookie-planting from sites on your other subdomains.
 * Plain names are only used for local http://localhost development.
 */
export function cookieNames(config: Config) {
  const prefix = config.secureCookies ? '__Host-' : '';
  return {
    session: `${prefix}agentbox_sid`,
    device: `${prefix}agentbox_dev`,
  };
}

export function baseCookieOptions(config: Config) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict' as const,
  };
}
