import { describe, expect, it, test, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  conversationsKeys,
  mergeMessages,
  useConversation,
  usePostMessage,
  useButtonClick,
  useCreateConversation,
  type ConversationMessage,
} from './conversations.ts';

/**
 * TIER A for the live-tail merge logic (id-keyed, live-wins, seq-ordered) and
 * the M8 send-id-not-label assertion. The key factory + mutation wiring are
 * smoke-checked. EventSource isn't in jsdom — we stub a tiny fake (the same
 * shape activity-feed.test.tsx uses) so the live-tail integration is driven
 * deterministically; the pure mergeMessages helper is also tested in isolation.
 */

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    conversationId: 'c1',
    seq: 1,
    role: 'operator',
    kind: 'text',
    body: '',
    payload: null,
    runId: null,
    createdAt: Date.now(),
    ...overrides,
  };
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
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Key factory (invariant 6)
// ---------------------------------------------------------------------------
describe('conversationsKeys', () => {
  it('detail key includes the conversation id under the all prefix', () => {
    expect(conversationsKeys.all).toEqual(['conversations']);
    expect(conversationsKeys.detail('abc')).toEqual(['conversations', 'abc']);
  });
});

// ---------------------------------------------------------------------------
// mergeMessages — pure live-tail merge (id-keyed, live-wins, seq-ordered)
// ---------------------------------------------------------------------------
describe('mergeMessages', () => {
  it('orders by seq and appends a new live row', () => {
    const seed = [msg({ id: 'm1', seq: 1, body: 'hi' })];
    const live = new Map([['m2', msg({ id: 'm2', seq: 2, body: 'reply' })]]);
    const merged = mergeMessages(seed, live);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('a live row supersedes the same id from the seed (live wins)', () => {
    const seed = [msg({ id: 'm1', seq: 1, body: 'optimistic' })];
    const live = new Map([['m1', msg({ id: 'm1', seq: 1, body: 'persisted' })]]);
    const merged = mergeMessages(seed, live);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toBe('persisted');
  });

  it('slots a late-arriving lower-seq row into order, not at the tail', () => {
    const seed = [msg({ id: 'm3', seq: 3 })];
    const live = new Map([['m2', msg({ id: 'm2', seq: 2 })]]);
    const merged = mergeMessages(seed, live);
    expect(merged.map((m) => m.seq)).toEqual([2, 3]);
  });
});

// ---------------------------------------------------------------------------
// useConversation — seed from GET then live-tail merges (live wins)
// ---------------------------------------------------------------------------
describe('useConversation', () => {
  it('seeds from GET then layers a live row on top, deduped by id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'c1',
              title: 'Untitled',
              activeRunId: null,
              messages: [{ id: 'm1', conversationId: 'c1', seq: 1, role: 'user', kind: 'text', body: 'hi', payload: null, runId: null, createdAt: 1 }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { result } = renderHook(() => useConversation('c1'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]?.body).toBe('hi');

    // A live operator row arrives on the dedicated stream → layered over the seed.
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'message',
        JSON.stringify({ id: 'm2', conversationId: 'c1', seq: 2, role: 'operator', kind: 'text', body: 'done', payload: null, runId: 'r1', createdAt: 2 }),
      ),
    );
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]?.body).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Mutations through the one client — assert path + body
// ---------------------------------------------------------------------------
function captureFetch(): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ data: { runId: 'run-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

describe('mutations go through the client', () => {
  test('usePostMessage POSTs {text} to the messages route', async () => {
    const qc = new QueryClient();
    const { calls } = captureFetch();
    const { result } = renderHook(() => usePostMessage('c1'), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ text: 'set up a project' });
    });
    expect(calls[0]?.url).toContain('/api/v1/conversations/c1/messages');
    expect(calls[0]?.body).toEqual({ text: 'set up a project' });
  });

  test('useCreateConversation POSTs to /conversations', async () => {
    const qc = new QueryClient();
    const { calls } = captureFetch();
    const { result } = renderHook(() => useCreateConversation(), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ title: 'My chat' });
    });
    expect(calls[0]?.url).toContain('/api/v1/conversations');
    expect(calls[0]?.body).toEqual({ title: 'My chat' });
  });

  test('M8 — useButtonClick sends the option ID (not the label) to the click route', async () => {
    const qc = new QueryClient();
    const { calls } = captureFetch();
    const { result } = renderHook(() => useButtonClick('c1'), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ messageId: 'msg-9', optionId: 'leads' });
    });
    expect(calls[0]?.url).toContain('/api/v1/conversations/c1/messages/msg-9/click');
    // The wire body carries optionId — the ID, never the human label.
    expect(calls[0]?.body).toEqual({ optionId: 'leads' });
  });
});
