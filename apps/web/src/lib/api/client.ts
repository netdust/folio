/**
 * Folio API client. Cookies handle auth. Successful responses are unwrapped
 * from the `{ data }` envelope. Failures throw ApiError carrying the parsed
 * body so callers can branch on { error: { code, message } }.
 */

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}

type EnvelopeOk<T> = { data: T };

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  contentType: 'application/json' | 'text/markdown' = 'application/json',
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
  };
  if (body !== undefined) {
    init.headers = { 'Content-Type': contentType };
    init.body = contentType === 'application/json' ? JSON.stringify(body) : (body as string);
  }
  const res = await fetch(path, init);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('text/markdown')) {
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, null);
    return text as T;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json);
  if (json && typeof json === 'object' && 'data' in json) {
    const keys = Object.keys(json);
    if (keys.length === 1) {
      return (json as EnvelopeOk<T>).data;
    }
  }
  return json as T;
}

export const client = {
  get: <T>(path: string) => request<T>('GET', path),
  getRaw: (path: string) => request<string>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postMd: <T>(path: string, md: string) => request<T>('POST', path, md, 'text/markdown'),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  patchMd: <T>(path: string, md: string) => request<T>('PATCH', path, md, 'text/markdown'),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  // DELETE with a JSON body — some routes (e.g. /instance/access revoke) identify
  // the target in the body rather than the path.
  deleteWithBody: <T = void>(path: string, body: unknown) => request<T>('DELETE', path, body),
};
