import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivityFeed } from './activity-feed.ts';

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
  test('ignores events without a documentId', () => {
    const { result } = renderHook(() => useActivityFeed('acme'));
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit('agent.run.running', JSON.stringify({ id: 'e1', kind: 'agent.run.running', payload: { agent: 'bot' } })),
    );
    expect(result.current.items).toHaveLength(0);
  });
});
