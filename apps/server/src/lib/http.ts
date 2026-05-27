import type { Context, Env, Hono } from 'hono';
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

// T1: generic over the Hono Env so apps typed with AuthContext / ScopeContext
// can be passed without the assignability error (`Hono<AuthContext & ScopeContext>`
// is NOT assignable to the unparameterized `Hono` because Hono defaults the
// type param to `BlankEnv`, not `any`). 9 call sites across app.ts, bearer.test,
// scope.test were tripping tsc on this for no good reason.
export function registerErrorHandler<E extends Env>(app: Hono<E>) {
  app.onError((err, c) => {
    if (err instanceof HTTPError) {
      return jsonError(c, err.code, err.message, err.status);
    }
    console.error('[unhandled]', err);
    return jsonError(c, 'INTERNAL', 'internal error', 500);
  });
}
