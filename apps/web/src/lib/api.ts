import type { ApiErrorBody, ApiErrorCode } from '@agentbox/shared';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;

  constructor(status: number, body: Partial<ApiErrorBody> | null) {
    super(body?.error?.message ?? 'Something went wrong. Please try again.');
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? (status >= 500 ? 'internal' : 'bad_request');
    this.requestId = body?.error?.requestId;
    this.retryAfter = body?.error?.retryAfter;
  }
}

type Listener = (err: ApiError) => void;
const signedOutListeners = new Set<Listener>();

/** Notified when any request finds the session gone (expired or revoked). */
export function onSignedOut(listener: Listener): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

const TIMEOUT_MS = 20_000;

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // Server-side CSRF check: a cross-site page can't add this header.
        ...(method === 'GET' ? {} : { 'X-Agentbox': '1' }),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiError(0, {
      error: {
        code: 'internal',
        message: "Can't reach agentbox. Check your connection and try again.",
        requestId: '',
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data as Partial<ApiErrorBody> | null);
    if (err.code === 'unauthorized' || err.code === 'session_expired') {
      for (const l of signedOutListeners) l(err);
    }
    throw err;
  }
  return data as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body }) });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'FreshAuthCancelled') return err.message;
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'The passkey request was cancelled or timed out.';
  }
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return 'The passkey request was cancelled or timed out.';
  }
  return 'Something went wrong. Please try again.';
}
