import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useDeleteInstanceAiKey,
  useInstanceAiKeys,
  useOperatorModel,
  useSetOperatorModel,
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
  it('GETs /api/v1/instance/ai-keys (no workspaceId) and projects .data to the keys ARRAY', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        calls.push(String(input));
        // The new wire shape is {keys, operator_model}; the hook's `select` must
        // project .data back to the bare keys ARRAY so existing consumers (ai-tab,
        // provider-model-field) are unchanged (test-effectiveness: was blind — the
        // old test used an empty payload and never asserted the projected shape).
        return new Response(
          JSON.stringify({
            data: {
              keys: [{ id: 'k1', provider: 'anthropic', label: 'default', baseUrl: null, createdAt: '2026-01-01T00:00:00Z' }],
              operator_model: { provider: 'anthropic', model: 'claude-sonnet-4-6', aiKeyLabel: 'default' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { result } = renderHook(() => useInstanceAiKeys(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // .data is the ARRAY (not the {keys, operator_model} envelope).
    expect(Array.isArray(result.current.data)).toBe(true);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.provider).toBe('anthropic');
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

describe('useOperatorModel', () => {
  it('projects operator_model from the same GET (no extra fetch)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              keys: [],
              operator_model: { provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'local' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const { result } = renderHook(() => useOperatorModel(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'local' });
  });

  it('is null when no operator model is set', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { keys: [], operator_model: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const { result } = renderHook(() => useOperatorModel(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('useSetOperatorModel', () => {
  it('PUTs /api/v1/instance/ai-keys/operator-model with {provider, model, aiKeyLabel}', async () => {
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
            data: { ok: true, operator_model: { provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'local' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { result } = renderHook(() => useSetOperatorModel(), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'local' });
    expect(calls[0]!.url).toContain('/api/v1/instance/ai-keys/operator-model');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toEqual({ provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'local' });
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
