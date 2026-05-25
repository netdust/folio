import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  tokensKeys,
  useCreateToken,
  useDeleteToken,
  useTokens,
} from './tokens.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('tokensKeys', () => {
  it('list key includes wslug + workspaceId', () => {
    expect(tokensKeys.list('acme', 'ws-1')).toEqual(['tokens', 'acme', 'ws-1']);
  });
});

describe('useTokens', () => {
  it('GETs /api/v1/w/:wslug/tokens/:workspaceId and unwraps the tokens array', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({
            data: {
              tokens: [
                {
                  id: 'tok_1',
                  name: 'CI',
                  scopes: ['documents:read'],
                  createdAt: '2026-05-25T00:00:00.000Z',
                  lastUsedAt: null,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const { result } = renderHook(() => useTokens('acme', 'ws-1'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0]).toContain('/api/v1/w/acme/tokens/ws-1');
    expect(Array.isArray(result.current.data)).toBe(true);
    expect(result.current.data?.[0]?.id).toBe('tok_1');
  });

  it('is disabled when wslug or workspaceId is empty', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useTokens('', ''), { wrapper: wrap(qc) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useCreateToken', () => {
  it('POSTs to /api/v1/w/:wslug/tokens/:workspaceId and returns the plaintext token once', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(
          JSON.stringify({
            data: {
              id: 'tok_1',
              name: 'CI',
              token: 'folio_pat_abc',
              scopes: ['documents:read'],
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const { result } = renderHook(() => useCreateToken('acme', 'ws-1'), { wrapper: wrap(qc) });
    const created = await result.current.mutateAsync({
      name: 'CI',
      scopes: ['documents:read'],
    });

    expect(calls[0]!.url).toContain('/api/v1/w/acme/tokens/ws-1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ name: 'CI', scopes: ['documents:read'] });
    expect(created.token).toBe('folio_pat_abc');
    expect(created.id).toBe('tok_1');
  });

  it('invalidates the tokens list query on success', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { id: 'tok_1', name: 'CI', token: 'folio_pat_xyz', scopes: [] },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const { result } = renderHook(() => useCreateToken('acme', 'ws-1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ name: 'CI', scopes: [] });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: tokensKeys.list('acme', 'ws-1') });
  });
});

describe('useDeleteToken', () => {
  it('DELETEs /api/v1/w/:wslug/tokens/:workspaceId/:tokenId', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { result } = renderHook(() => useDeleteToken('acme', 'ws-1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync('tok_1');

    expect(calls[0]!.url).toContain('/api/v1/w/acme/tokens/ws-1/tok_1');
    expect(calls[0]!.method).toBe('DELETE');
  });

  it('invalidates the tokens list query on success', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const { result } = renderHook(() => useDeleteToken('acme', 'ws-1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync('tok_1');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: tokensKeys.list('acme', 'ws-1') });
  });
});
