import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useRuns, useCreateRun, useCancelRun, useRunsLiveSync, runsKeys } from './runs.ts';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onmessage: ((e: MessageEvent) => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string, data: string) {
    const ev = { data } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    if (type === 'message') this.onmessage?.(ev);
  }
  close() { this.closed = true; }
}

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/runs')) {
      return new Response(JSON.stringify({ data: { run_id: 'r1', status: 'planning' } }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (init?.method === 'POST' && u.includes('/cancel')) {
      return new Response(JSON.stringify({ data: { run_id: 'r1', status: 'failed' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Real server wraps via jsonOk → { data: [...] }; client.get unwraps the single `data` key to the array.
    return new Response(JSON.stringify({ data: [{ id: 'r1', slug: 'run-1', type: 'agent_run', status: 'running', frontmatter: {} }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('runs hooks', () => {
  test('useRuns fetches the project-scoped list and unwraps to an array', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useRuns('acme', 'web', { status: 'running' }), { wrapper: wrapperOf(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Array.isArray(result.current.data)).toBe(true);
    expect(result.current.data![0].id).toBe('r1');
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => String(c[0]).includes('/runs'));
    expect(String(call![0])).toBe('/api/v1/w/acme/p/web/runs?status=running');
  });

  test('useCreateRun POSTs and returns {run_id,status}', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreateRun('acme'), { wrapper: wrapperOf(qc) });
    let resp: { run_id: string; status: string } | undefined;
    await act(async () => { resp = await result.current.mutateAsync({ agent_slug: 'bot', parent_slug: 'task-1' }); });
    expect(resp).toEqual({ run_id: 'r1', status: 'planning' });
  });

  test('useCancelRun POSTs to the cancel path', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCancelRun('acme'), { wrapper: wrapperOf(qc) });
    await act(async () => { await result.current.mutateAsync({ runId: 'r1' }); });
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => String(c[0]).includes('/cancel'));
    expect(String(call![0])).toBe('/api/v1/w/acme/runs/r1/cancel');
  });

  test('runsKeys.list is project-scoped + filter-keyed', () => {
    expect(runsKeys.list('acme', 'web', { status: 'running' })).toEqual(['runs', 'acme', 'web', 'list', { status: 'running' }]);
  });
});

describe('useRunsLiveSync', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('subscribes to all six run kinds + the agent filter and invalidates on event', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useRunsLiveSync('acme', { agent: 'bot' }), { wrapper: wrapperOf(qc) });

    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0]!;
    for (const kind of [
      'agent.run.started',
      'agent.run.awaiting_approval',
      'agent.run.running',
      'agent.run.completed',
      'agent.run.failed',
      'agent.run.rejected',
    ]) {
      expect(es.url).toContain(kind);
    }
    expect(es.url).toContain('agent=bot');

    invalidate.mockClear();
    act(() => es.emit('agent.run.completed', JSON.stringify({ id: 'e1', kind: 'agent.run.completed' })));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runsKeys.all });
  });
});
