import type { ErrorRequestHandler } from 'express';
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export type SafeLogger = (code: string, requestId: string) => void;
interface ClientError {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number | undefined;
}
const conflicts = new Set([
  'ER_DUP_ENTRY',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_SIGNAL_EXCEPTION',
  'ER_NO_REFERENCED_ROW_2',
  'ER_ROW_IS_REFERENCED_2',
  'ER_CHECK_CONSTRAINT_VIOLATED',
]);
function clientError(error: unknown): ClientError {
  if (error instanceof ApiError) return error;
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string' && conflicts.has(error.code))
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'This change conflicts with the current setup. Refresh and try again.',
      };
    if ('type' in error && error.type === 'entity.too.large')
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request is too large.' };
    if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed')
      return { status: 400, code: 'INVALID_REQUEST', message: 'Invalid request.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete this request.' };
}
export function errorHandler(log: SafeLogger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    void next;
    const requestId: unknown = response.locals['requestId'];
    const id = typeof requestId === 'string' ? requestId : 'unavailable';
    const safe = clientError(error);
    if (safe.status === 500) log('REQUEST_FAILED', id);
    if (safe.status === 429) response.set('Retry-After', String(safe.retryAfterSeconds ?? 900));
    response.status(safe.status).json({
      error: {
        code: safe.code,
        message: safe.message,
        requestId: id,
      },
    });
  };
}
