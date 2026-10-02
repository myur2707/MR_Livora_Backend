import type { ErrorRequestHandler } from 'express';
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type SafeLogger = (code: string, requestId: string) => void;
export function errorHandler(log: SafeLogger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    void next;
    const requestId: unknown = response.locals['requestId'];
    const id = typeof requestId === 'string' ? requestId : 'unavailable';
    const expected = error instanceof ApiError;
    const conflict =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_SIGNAL_EXCEPTION'].includes(
        String(error.code),
      );
    if (!expected && !conflict) log('REQUEST_FAILED', id);
    const malformed = error instanceof SyntaxError;
    const oversized =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large';
    if (expected && error.status === 429) response.set('Retry-After', '900');
    response
      .status(expected ? error.status : conflict ? 409 : oversized ? 413 : malformed ? 400 : 500)
      .json({
        error: {
          code: expected
            ? error.code
            : conflict
              ? 'CONFLICT'
              : oversized
                ? 'PAYLOAD_TOO_LARGE'
                : malformed
                  ? 'INVALID_REQUEST'
                  : 'INTERNAL_ERROR',
          message: expected
            ? error.message
            : conflict
              ? 'This change conflicts with the current setup. Refresh and try again.'
              : oversized
                ? 'Request is too large.'
                : malformed
                  ? 'Invalid request.'
                  : 'Unable to complete this request.',
          requestId: id,
        },
      });
  };
}
