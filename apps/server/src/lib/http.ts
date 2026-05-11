import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class HTTPError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: ContentfulStatusCode,
  ) {
    super(message);
    this.name = 'HTTPError';
  }
}

export function jsonOk<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ data }, status);
}

export function jsonError(
  c: Context,
  code: string,
  message: string,
  status: ContentfulStatusCode,
) {
  return c.json({ error: { code, message } }, status);
}

export function registerErrorHandler(app: Hono) {
  app.onError((err, c) => {
    if (err instanceof HTTPError) {
      return jsonError(c, err.code, err.message, err.status);
    }
    console.error('[unhandled]', err);
    return jsonError(c, 'INTERNAL', 'internal error', 500);
  });
}
