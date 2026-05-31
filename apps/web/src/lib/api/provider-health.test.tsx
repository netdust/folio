import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useProviderHealth, useReactorHealth, providerHealthKeys } from './provider-health.ts';

// MockEventSource: lets a test emit reactor events. Copy the pattern from event-stream.test.tsx.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    const a = this.listeners.get(t) ?? [];
    a.push(fn);
    this.listeners.set(t, a);
  }
  removeEventListener(t: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  }
  emit(t: string, data: string) {
    const ev = { data } as MessageEvent;
    for (const fn of this.listeners.get(t) ?? []) fn(ev);
  }
  close() {}
}

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: {
            anthropic: { status: 'degraded', consecutiveFailures: 3 },
            openai: { status: 'healthy', consecutiveFailures: 0 },
            openrouter: { status: 'healthy', consecutiveFailures: 0 },
            ollama: { status: 'healthy', consecutiveFailures: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('useProviderHealth', () => {
  test('fetches provider health and exposes per-provider status (camelCase)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProviderHealth('acme'), { wrapper: wrapperOf(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.anthropic.status).toBe('degraded');
    expect(result.current.data!.anthropic.consecutiveFailures).toBe(3);
  });
  test('key factory is workspace-scoped', () => {
    expect(providerHealthKeys.detail('acme')).toEqual(['provider-health', 'acme']);
  });
  test('refetches on workspace.provider.degraded SSE event (invalidation)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProviderHealth('acme'), { wrapper: wrapperOf(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const callsBefore = fetchMock.mock.calls.length;
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'workspace.provider.degraded',
        JSON.stringify({ kind: 'workspace.provider.degraded', payload: {} }),
      ),
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});

describe('useReactorHealth', () => {
  test('starts not-halted, flips to halted with errorClass from error_summary on reactor.halted', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useReactorHealth('acme'), { wrapper: wrapperOf(qc) });
    await waitFor(() => expect(result.current.halted).toBe(false));
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'reactor.halted',
        JSON.stringify({
          kind: 'reactor.halted',
          payload: { reactor_id: 'matcher', error_summary: 'TypeError' },
        }),
      ),
    );
    await waitFor(() => expect(result.current.halted).toBe(true));
    expect(result.current.errorClass).toBe('TypeError');
    act(() =>
      es.emit(
        'reactor.recovered',
        JSON.stringify({ kind: 'reactor.recovered', payload: { reactor_id: 'matcher' } }),
      ),
    );
    await waitFor(() => expect(result.current.halted).toBe(false));
    expect(result.current.errorClass).toBe(null);
  });
});
