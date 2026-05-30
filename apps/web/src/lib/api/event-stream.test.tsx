import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEventStream, type StreamedEvent } from './event-stream.ts';

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

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('useEventStream', () => {
  test('opens an EventSource to the workspace events path with cookie credentials + filters', () => {
    renderHook(() => useEventStream('acme', { agent: 'reply-bot', kinds: ['agent.run.running'] }, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0]!;
    expect(es.url).toBe('/api/v1/w/acme/events?agent=reply-bot&kinds=agent.run.running');
    expect(es.withCredentials).toBe(true);
  });

  test('delivers a NAMED event to onEvent when its kind was requested', () => {
    const onEvent = vi.fn<(e: StreamedEvent) => void>();
    renderHook(() => useEventStream('acme', { kinds: ['agent.run.running'] }, onEvent));
    const es = MockEventSource.instances[0]!;
    act(() => es.emit('agent.run.running', JSON.stringify({ id: 'e1', kind: 'agent.run.running', payload: { agent: 'reply-bot' } })));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', kind: 'agent.run.running' }));
  });

  test('does NOT deliver a named event whose kind was not requested', () => {
    const onEvent = vi.fn<(e: StreamedEvent) => void>();
    renderHook(() => useEventStream('acme', { kinds: ['agent.run.completed'] }, onEvent));
    const es = MockEventSource.instances[0]!;
    act(() => es.emit('agent.run.running', JSON.stringify({ id: 'e2', kind: 'agent.run.running' })));
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('skips ping heartbeats (empty data, never JSON.parse "")', () => {
    const onEvent = vi.fn<(e: StreamedEvent) => void>();
    renderHook(() => useEventStream('acme', { kinds: ['ping'] }, onEvent));
    const es = MockEventSource.instances[0]!;
    act(() => es.emit('ping', ''));
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('closes the EventSource on unmount', () => {
    const { unmount } = renderHook(() => useEventStream('acme', { kinds: ['agent.run.running'] }, vi.fn()));
    const es = MockEventSource.instances[0]!;
    unmount();
    expect(es.closed).toBe(true);
  });

  test('does not open a stream when wslug is empty', () => {
    renderHook(() => useEventStream('', { kinds: ['agent.run.running'] }, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
