import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDeleteAiKey, useUpsertAiKey, useWorkspaceAiKeys } from './settings.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useWorkspaceAiKeys', () => {
  it('GETs /api/v1/w/:wslug/settings/:workspaceId/ai-keys', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ data: { keys: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { result } = renderHook(() => useWorkspaceAiKeys('acme', 'ws-1'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toContain('/api/v1/w/acme/settings/ws-1/ai-keys');
  });

  it('is disabled when wslug OR workspaceId is empty', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useWorkspaceAiKeys('', 'ws-1'), { wrapper: wrap(qc) });
    renderHook(() => useWorkspaceAiKeys('acme', ''), { wrapper: wrap(qc) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useUpsertAiKey', () => {
  it('POSTs /api/v1/w/:wslug/settings/:workspaceId/ai-keys', async () => {
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
    const { result } = renderHook(() => useUpsertAiKey('acme', 'ws-1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ provider: 'anthropic', apiKey: 'sk-x' });
    expect(calls[0]!.url).toContain('/api/v1/w/acme/settings/ws-1/ai-keys');
    expect(calls[0]!.method).toBe('POST');
  });
});

describe('useDeleteAiKey', () => {
  it('DELETEs /api/v1/w/:wslug/settings/:workspaceId/ai-keys/:keyId', async () => {
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
    const { result } = renderHook(() => useDeleteAiKey('acme', 'ws-1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync('key_1');
    expect(calls[0]!.url).toContain('/api/v1/w/acme/settings/ws-1/ai-keys/key_1');
    expect(calls[0]!.method).toBe('DELETE');
  });
});
