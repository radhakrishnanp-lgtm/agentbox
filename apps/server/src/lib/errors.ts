import type { ApiErrorCode } from '@agentbox/shared';

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  session_expired: 401,
  invalid_credential: 401,
  fresh_auth_required: 403,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  setup_complete: 409,
  locked: 423,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** An expected failure with a safe, user-facing message. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfter: number | undefined;

  constructor(code: ApiErrorCode, message: string, opts: { retryAfter?: number } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.retryAfter = opts.retryAfter;
  }
}

export const unauthorized = () => new AppError('unauthorized', 'Please sign in.');
export const invalidCredential = () =>
  new AppError('invalid_credential', 'That sign-in did not work. Please try again.');
