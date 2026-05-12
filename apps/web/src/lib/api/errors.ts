import { ApiError } from './client.ts';
import type { ErrorCodeType } from '@folio/shared';

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function envelope(body: unknown): ErrorEnvelope | null {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null &&
    'code' in (body as ErrorEnvelope).error &&
    'message' in (body as ErrorEnvelope).error
  ) {
    return body as ErrorEnvelope;
  }
  return null;
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const env = envelope(err.body);
    if (env) return env.error.message;
    return 'Something went wrong';
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export function apiErrorCode(err: unknown): ErrorCodeType | null {
  if (err instanceof ApiError) {
    const env = envelope(err.body);
    if (env) return env.error.code as ErrorCodeType;
  }
  return null;
}
