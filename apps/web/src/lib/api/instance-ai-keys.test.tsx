import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useDeleteInstanceAiKey,
  useInstanceAiKeys,
  useUpsertInstanceAiKey,
} from './instance-ai-keys.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useInstanceAiKeys', () => {
  it('GETs /api/v1/instance/ai-keys (no workspaceId)', async () => {
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
    const { result } = renderHook(() => useInstanceAiKeys(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toContain('/api/v1/instance/ai-keys');
    expect(calls[0]).not.toContain('/w/');
    expect(calls[0]).not.toContain('settings');
  });

  it('is disabled when enabled:false (non-admin must not fetch)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useInstanceAiKeys({ enabled: false }), { wrapper: wrap(qc) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useUpsertInstanceAiKey', () => {
  it('POSTs /api/v1/instance/ai-keys with the body (no workspaceId)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify({
            data: { id: 'k1', provider: 'anthropic', label: 'default', paid_residual_live: true },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { result } = renderHook(() => useUpsertInstanceAiKey(), { wrapper: wrap(qc) });
    const out = await result.current.mutateAsync({ provider: 'anthropic', apiKey: 'sk-x' });
    expect(calls[0]!.url).toContain('/api/v1/instance/ai-keys');
    expect(calls[0]!.url).not.toContain('/w/');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({ provider: 'anthropic', apiKey: 'sk-x' });
    expect(out.paid_residual_live).toBe(true);
  });
});

describe('useDeleteInstanceAiKey', () => {
  it('DELETEs /api/v1/instance/ai-keys/:keyId', async () => {
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
    const { result } = renderHook(() => useDeleteInstanceAiKey(), { wrapper: wrap(qc) });
    await result.current.mutateAsync('key_1');
    expect(calls[0]!.url).toContain('/api/v1/instance/ai-keys/key_1');
    expect(calls[0]!.method).toBe('DELETE');
  });
});
