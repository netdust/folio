import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivityFeed } from './activity-feed.ts';
import * as runsApi from './runs.ts';

// Default: no history (live-tail-only tests). Backfill tests override per-case.
function stubNoHistory() {
  vi.spyOn(runsApi, 'useWorkspaceRuns').mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof runsApi.useWorkspaceRuns>);
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    const a = this.listeners.get(t) ?? [];
    a.push(fn);
    this.listeners.set(t, a);
  }
  removeEventListener() {}
  close() {}
  emit(t: string, data: string) {
    for (const fn of this.listeners.get(t) ?? []) fn({ data } as MessageEvent);
  }
}
beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  stubNoHistory();
});
afterEach(() => vi.unstubAllGlobals());

describe('useActivityFeed', () => {
  test('appends a feed item on an agent.run event, deduped by run id, newest first', () => {
    const { result } = renderHook(() => useActivityFeed('acme'));
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'agent.run.running',
        JSON.stringify({ id: 'e1', kind: 'agent.run.running', documentId: 'run-1', payload: { agent: 'bot', to: 'running', fired_by: 'assignment' } }),
      ),
    );
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].agent).toBe('bot');
    expect(result.current.items[0].status).toBe('running');
    // same run, later event → updates status in place (no new row)
    act(() =>
      es.emit(
        'agent.run.completed',
        JSON.stringify({ id: 'e2', kind: 'agent.run.completed', documentId: 'run-1', payload: { agent: 'bot', to: 'completed' } }),
      ),
    );
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('completed');
    // a different run → new row, prepended
    act(() =>
      es.emit(
        'agent.run.started',
        JSON.stringify({ id: 'e3', kind: 'agent.run.started', documentId: 'run-2', payload: { agent: 'seo', fired_by: 'cron' } }),
      ),
    );
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0].runDocId).toBe('run-2');
  });
  test('carries forward firedBy when a transition event omits it', () => {
    const { result } = renderHook(() => useActivityFeed('acme'));
    const es = MockEventSource.instances[0]!;
    // started carries fired_by
    act(() =>
      es.emit(
        'agent.run.started',
        JSON.stringify({ id: 'e1', kind: 'agent.run.started', documentId: 'run-1', payload: { agent: 'bot', fired_by: 'trigger' } }),
      ),
    );
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].firedBy).toBe('trigger');
    // running does NOT carry fired_by — must be carried forward
    act(() =>
      es.emit(
        'agent.run.running',
        JSON.stringify({ id: 'e2', kind: 'agent.run.running', documentId: 'run-1', payload: { agent: 'bot', to: 'running' } }),
      ),
    );
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('running');
    expect(result.current.items[0].firedBy).toBe('trigger');
  });

  test('seeds items from workspace run history with no SSE events fired', () => {
    vi.spyOn(runsApi, 'useWorkspaceRuns').mockReturnValueOnce({
      data: [
        {
          id: 'run-h1',
          status: 'completed',
          frontmatter: { agent_slug: 'bot', fired_by: 'manual' },
          updatedAt: '2026-05-31T10:00:00.000Z',
        },
        {
          id: 'run-h2',
          status: 'failed',
          frontmatter: { agent_slug: 'seo', fired_by: 'cron' },
          updatedAt: '2026-05-31T11:00:00.000Z',
        },
      ],
    } as unknown as ReturnType<typeof runsApi.useWorkspaceRuns>);

    const { result } = renderHook(() => useActivityFeed('acme'));
    expect(result.current.items).toHaveLength(2);
    // newest-first by `at` (run-h2 is later)
    expect(result.current.items[0].runDocId).toBe('run-h2');
    expect(result.current.items[0].agent).toBe('seo');
    expect(result.current.items[0].status).toBe('failed');
    expect(result.current.items[0].firedBy).toBe('cron');
    expect(result.current.items[1].runDocId).toBe('run-h1');
  });

  test('a live event supersedes the same run from history (live wins)', () => {
    vi.spyOn(runsApi, 'useWorkspaceRuns').mockReturnValue({
      data: [
        {
          id: 'run-1',
          status: 'running',
          frontmatter: { agent_slug: 'bot', fired_by: 'manual' },
          updatedAt: '2026-05-31T10:00:00.000Z',
        },
      ],
    } as unknown as ReturnType<typeof runsApi.useWorkspaceRuns>);

    const { result } = renderHook(() => useActivityFeed('acme'));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('running');
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'agent.run.completed',
        JSON.stringify({ id: 'e1', kind: 'agent.run.completed', documentId: 'run-1', payload: { agent: 'bot', to: 'completed' } }),
      ),
    );
    // still one row, live status wins
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('completed');
  });

  test('ignores events without a documentId', () => {
    const { result } = renderHook(() => useActivityFeed('acme'));
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit('agent.run.running', JSON.stringify({ id: 'e1', kind: 'agent.run.running', payload: { agent: 'bot' } })),
    );
    expect(result.current.items).toHaveLength(0);
  });
});
