import type { SessionInfo } from '@agentbox/shared';
import { ApiError } from './api.ts';
import { confirmWithPasskey, passkeysSupported } from './passkeys.ts';

/** Thrown when you close the "Confirm it's you" dialog. */
export class FreshAuthCancelled extends Error {
  constructor() {
    super('Cancelled. Nothing was changed.');
    this.name = 'FreshAuthCancelled';
  }
}

type CodePrompt = (reason: string | null) => Promise<SessionInfo>;
let codePrompt: CodePrompt | null = null;

/** Called by <FreshAuthPrompt>, which draws the authenticator-code dialog. */
export function registerCodePrompt(prompt: CodePrompt): () => void {
  codePrompt = prompt;
  return () => {
    if (codePrompt === prompt) codePrompt = null;
  };
}

/** Passkey first; the authenticator code when the passkey can't be used here. */
async function confirmItsYou(): Promise<SessionInfo> {
  let reason: string | null = null;
  if (passkeysSupported()) {
    try {
      return await confirmWithPasskey();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      reason = 'The passkey check was cancelled or has no passkey on this computer.';
    }
  }
  if (!codePrompt) throw new Error('Reload the page and try again.');
  return codePrompt(reason);
}

/**
 * Runs a sensitive action. If the server says the last check is older than
 * five minutes, asks for the passkey (or an authenticator code) once and retries.
 */
export async function withFreshAuth<T>(
  action: () => Promise<T>,
  onSession: (s: SessionInfo) => void,
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'fresh_auth_required') throw err;
    onSession(await confirmItsYou());
    return action();
  }
}
