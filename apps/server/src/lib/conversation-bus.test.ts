import { afterEach, describe, expect, test } from 'bun:test';
import { conversationBus } from './conversation-bus.ts';
import type { SerializedMessage } from '../services/conversations.ts';

// The bus carries the WIRE shape (createdAt as a unix-ms NUMBER, what the SSE
// route stringifies) — NOT the DB Message (createdAt: Date). Fixture mirrors the
// real publish path (the sink serializes before publishing).
function fakeRow(conversationId: string, body: string): SerializedMessage {
  return {
    id: crypto.randomUUID(),
    conversationId,
    seq: 1,
    role: 'operator',
    kind: 'text',
    body,
    payload: null,
    runId: null,
    createdAt: 1_700_000_000_000,
  };
}

describe('conversation bus', () => {
  afterEach(() => {
    conversationBus.__clear();
  });

  test('subscribe → publish delivers the row to the subscriber', () => {
    const received: SerializedMessage[] = [];
    conversationBus.subscribe('c1', (row) => received.push(row));
    const row = fakeRow('c1', 'hello');
    conversationBus.publish('c1', row);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('hello');
  });

  test('publish is scoped by conversationId (no cross-delivery)', () => {
    const a: SerializedMessage[] = [];
    const b: SerializedMessage[] = [];
    conversationBus.subscribe('cA', (row) => a.push(row));
    conversationBus.subscribe('cB', (row) => b.push(row));
    conversationBus.publish('cA', fakeRow('cA', 'for-a'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  test('unsubscribe stops further delivery', () => {
    const received: SerializedMessage[] = [];
    const unsub = conversationBus.subscribe('c1', (row) => received.push(row));
    conversationBus.publish('c1', fakeRow('c1', 'first'));
    unsub();
    conversationBus.publish('c1', fakeRow('c1', 'second'));
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('first');
  });

  test('a throwing subscriber does not break delivery to siblings', () => {
    const good: SerializedMessage[] = [];
    conversationBus.subscribe('c1', () => {
      throw new Error('bad handler');
    });
    conversationBus.subscribe('c1', (row) => good.push(row));
    conversationBus.publish('c1', fakeRow('c1', 'x'));
    expect(good).toHaveLength(1);
  });
});
