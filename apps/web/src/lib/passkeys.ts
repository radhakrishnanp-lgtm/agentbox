import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { SessionInfo, SignInResult } from '@agentbox/shared';
import { post } from './api.ts';

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

export async function signInWithPasskey(): Promise<SignInResult> {
  const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>(
    '/api/auth/passkey/options',
  );
  const response = await startAuthentication({ optionsJSON });
  return post<SignInResult>('/api/auth/passkey/verify', { response });
}

/** Re-checks the passkey before a sensitive action (valid 5 minutes). */
export async function confirmWithPasskey(): Promise<SessionInfo> {
  const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/reauth/options');
  const response = await startAuthentication({ optionsJSON });
  return post<SessionInfo>('/api/auth/reauth/verify', { response });
}

export async function createPasskey(
  optionsPath: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof startRegistration>>> {
  const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>(optionsPath, body);
  return startRegistration({ optionsJSON });
}
