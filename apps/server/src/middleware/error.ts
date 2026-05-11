import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';

interface FolioError {
  error: { code: string; message: string; details?: unknown };
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    const status = err.status;
    const body: FolioError = {
      error: {
        code: codeFromStatus(status),
        message: err.message || defaultMessage(status),
      },
    };
    return c.json(body, status);
  }
  console.error('[folio] unhandled error:', err);
  const body: FolioError = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
  };
  return c.json(body, 500);
}

function codeFromStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'UNPROCESSABLE';
    default:  return `HTTP_${status}`;
  }
}

function defaultMessage(status: number): string {
  switch (status) {
    case 400: return 'Bad request.';
    case 401: return 'Unauthenticated.';
    case 403: return 'Forbidden.';
    case 404: return 'Not found.';
    case 409: return 'Conflict.';
    case 422: return 'Unprocessable entity.';
    default:  return 'Error.';
  }
}
