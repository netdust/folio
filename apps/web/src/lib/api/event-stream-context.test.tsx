import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStreamProvider } from './event-stream-context.tsx';
import { type EventStreamFilters, type StreamedEvent, useEventStream } from './event-stream.ts';

// Capture EventSource instances opened by the provider so tests can assert
// connection count (the H8 fix: one socket per workspace) and emit frames
// through the real listener path the provider attaches.
class FakeES {
  static instances: FakeES[] = [];
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeES.instances.push(this);
  }
  addEventListener(k: string, fn: (e: MessageEvent) => void) {
    const arr = this.listeners.get(k) ?? [];
    arr.push(fn);
    this.listeners.set(k, arr);
  }
  removeEventListener(k: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(
      k,
      (this.listeners.get(k) ?? []).filter((f) => f !== fn),
    );
  }
  close() {
    this.closed = true;
  }
  emit(kind: string, data: StreamedEvent) {
    for (const fn of this.listeners.get(kind) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function Consumer({
  filters,
  onEvent,
}: {
  filters: EventStreamFilters;
  onEvent: (e: StreamedEvent) => void;
}) {
  useEventStream('ws1', filters, onEvent);
  return null;
}

describe('EventStreamProvider mux', () => {
  beforeEach(() => {
    FakeES.instances = [];
    (globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;
  });

  it('opens ONE EventSource for two consumers with different kinds', () => {
    render(
      <EventStreamProvider wslug="ws1">
        <Consumer filters={{ kinds: ['document.updated'] }} onEvent={() => {}} />
        <Consumer filters={{ kinds: ['comment.created'] }} onEvent={() => {}} />
      </EventStreamProvider>,
    );
    const live = FakeES.instances.filter((es) => !es.closed);
    expect(live.length).toBe(1);
    // the live socket's query carries the UNION of both kinds
    expect(live[0]?.url).toContain('document.updated');
    expect(live[0]?.url).toContain('comment.created');
  });

  it('demuxes: a comment frame reaches only the comment consumer', () => {
    const docCb = vi.fn();
    const commentCb = vi.fn();
    render(
      <EventStreamProvider wslug="ws1">
        <Consumer filters={{ kinds: ['document.updated'] }} onEvent={docCb} />
        <Consumer filters={{ parent: 'p1', kinds: ['comment.created'] }} onEvent={commentCb} />
      </EventStreamProvider>,
    );
    const es = FakeES.instances.find((e) => !e.closed);
    if (!es) throw new Error('no live EventSource');
    act(() => {
      es.emit('comment.created', {
        id: 'e1',
        kind: 'comment.created',
        payload: { parent_id: 'p1' },
      });
    });
    expect(commentCb).toHaveBeenCalledTimes(1);
    expect(docCb).not.toHaveBeenCalled();
  });

  it('applies the project filter client-side (drops non-matching project)', () => {
    const cb = vi.fn();
    render(
      <EventStreamProvider wslug="ws1">
        <Consumer filters={{ project: 'proj-A', kinds: ['document.updated'] }} onEvent={cb} />
      </EventStreamProvider>,
    );
    const es = FakeES.instances.find((e) => !e.closed);
    if (!es) throw new Error('no live EventSource');
    act(() => {
      es.emit('document.updated', { id: 'e2', kind: 'document.updated', projectId: 'proj-B' });
    });
    expect(cb).not.toHaveBeenCalled();
    act(() => {
      es.emit('document.updated', { id: 'e3', kind: 'document.updated', projectId: 'proj-A' });
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('forwards null-project (workspace-level) frames to a project-filtered consumer', () => {
    // BUG-021 exemption: the server intentionally delivers workspace-level
    // frames (projectId=null) to a ?project=-scoped consumer (events.ts:181 +
    // event-bus.ts:55-60). matchesFilter must mirror that, not drop them.
    const cb = vi.fn();
    render(
      <EventStreamProvider wslug="ws1">
        <Consumer filters={{ project: 'proj-A', kinds: ['document.updated'] }} onEvent={cb} />
      </EventStreamProvider>,
    );
    const es = FakeES.instances.find((e) => !e.closed);
    if (!es) throw new Error('no live EventSource');
    act(() => {
      es.emit('document.updated', { id: 'e4', kind: 'document.updated', projectId: null });
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('demuxes run/agent/table frames to ONLY the matching consumer (no cross-consumer leak)', () => {
    // matchesFilter mirrors the server's per-clause AND-narrowing for run_id /
    // agent / table_id too (event-stream-context.tsx:54-57). A frame whose
    // payload key mismatches the consumer's filter must be DROPPED, not fanned
    // out — a leak here would surface another run's / agent's / table's events in
    // the wrong cockpit pane. Each clause gets a hit + a miss.
    const runCb = vi.fn();
    const agentCb = vi.fn();
    const tableCb = vi.fn();
    render(
      <EventStreamProvider wslug="ws1">
        <Consumer filters={{ run: 'run-A', kinds: ['agent.run.running'] }} onEvent={runCb} />
        <Consumer
          filters={{ agent: 'reply-bot', kinds: ['agent.run.running'] }}
          onEvent={agentCb}
        />
        <Consumer filters={{ table: 'tbl-A', kinds: ['agent.run.running'] }} onEvent={tableCb} />
      </EventStreamProvider>,
    );
    const es = FakeES.instances.find((e) => !e.closed);
    if (!es) throw new Error('no live EventSource');

    // A frame matching run-A + reply-bot + tbl-A reaches all three.
    act(() => {
      es.emit('agent.run.running', {
        id: 'e1',
        kind: 'agent.run.running',
        payload: { run_id: 'run-A', agent: 'reply-bot', table_id: 'tbl-A' },
      });
    });
    expect(runCb).toHaveBeenCalledTimes(1);
    expect(agentCb).toHaveBeenCalledTimes(1);
    expect(tableCb).toHaveBeenCalledTimes(1);

    // A frame for a DIFFERENT run/agent/table reaches NONE of them — each clause
    // narrows independently, so no consumer sees a frame outside its scope.
    act(() => {
      es.emit('agent.run.running', {
        id: 'e2',
        kind: 'agent.run.running',
        payload: { run_id: 'run-B', agent: 'other-bot', table_id: 'tbl-B' },
      });
    });
    expect(runCb).toHaveBeenCalledTimes(1);
    expect(agentCb).toHaveBeenCalledTimes(1);
    expect(tableCb).toHaveBeenCalledTimes(1);
  });

  it('re-opens the socket against the WIDENED union when a new-kind subscriber mounts', () => {
    // The provider opens ONE socket against the UNION of every subscriber's
    // kinds; when a subscriber declaring a NEW kind mounts, recomputeUnion must
    // change → forceReconnect bumps unionKey → the [wslug, unionKey] effect
    // re-opens the socket carrying the widened kinds. Without the reconnect the
    // new consumer's kind never reaches the wire and it silently receives nothing.
    function Toggle({ withSecond }: { withSecond: boolean }) {
      return (
        <EventStreamProvider wslug="ws1">
          <Consumer filters={{ kinds: ['document.updated'] }} onEvent={() => {}} />
          {withSecond ? (
            <Consumer filters={{ kinds: ['comment.created'] }} onEvent={() => {}} />
          ) : null}
        </EventStreamProvider>
      );
    }
    const { rerender } = render(<Toggle withSecond={false} />);
    // Only one kind on the wire initially.
    let live = FakeES.instances.filter((es) => !es.closed);
    expect(live).toHaveLength(1);
    expect(live[0]!.url).toContain('document.updated');
    expect(live[0]!.url).not.toContain('comment.created');
    const firstSocket = live[0]!;

    // Mount the second subscriber → the union gains comment.created.
    act(() => rerender(<Toggle withSecond={true} />));

    // The original socket was torn down and ONE new socket carries the widened union.
    expect(firstSocket.closed).toBe(true);
    live = FakeES.instances.filter((es) => !es.closed);
    expect(live).toHaveLength(1);
    expect(live[0]!.url).toContain('document.updated');
    expect(live[0]!.url).toContain('comment.created');
  });
});
