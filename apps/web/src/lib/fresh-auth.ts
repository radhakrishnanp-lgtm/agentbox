import type { SessionInfo } from '@agentbox/shared';
import { ApiError } from './api.ts';
import { confirmWithPasskey } from './passkeys.ts';

/**
 * Runs a sensitive action. If the server says the last passkey check is older
 * than five minutes, asks for the passkey once and retries.
 */
export async function withFreshAuth<T>(
  action: () => Promise<T>,
  onSession: (s: SessionInfo) => void,
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'fresh_auth_required') throw err;
    onSession(await confirmWithPasskey());
    return action();
  }
}
