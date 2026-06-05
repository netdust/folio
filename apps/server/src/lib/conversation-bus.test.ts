import { afterEach, describe, expect, test } from 'bun:test';
import type { Message } from '../db/schema.ts';
import { conversationBus } from './conversation-bus.ts';

function fakeRow(conversationId: string, body: string): Message {
  return {
    id: crypto.randomUUID(),
    conversationId,
    seq: 1,
    role: 'operator',
    kind: 'text',
    body,
    payload: null,
    runId: null,
    createdAt: new Date(),
  } as Message;
}

describe('conversation bus', () => {
  afterEach(() => {
    conversationBus.__clear();
  });

  test('subscribe → publish delivers the row to the subscriber', () => {
    const received: Message[] = [];
    conversationBus.subscribe('c1', (row) => received.push(row));
    const row = fakeRow('c1', 'hello');
    conversationBus.publish('c1', row);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('hello');
  });

  test('publish is scoped by conversationId (no cross-delivery)', () => {
    const a: Message[] = [];
    const b: Message[] = [];
    conversationBus.subscribe('cA', (row) => a.push(row));
    conversationBus.subscribe('cB', (row) => b.push(row));
    conversationBus.publish('cA', fakeRow('cA', 'for-a'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  test('unsubscribe stops further delivery', () => {
    const received: Message[] = [];
    const unsub = conversationBus.subscribe('c1', (row) => received.push(row));
    conversationBus.publish('c1', fakeRow('c1', 'first'));
    unsub();
    conversationBus.publish('c1', fakeRow('c1', 'second'));
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('first');
  });

  test('a throwing subscriber does not break delivery to siblings', () => {
    const good: Message[] = [];
    conversationBus.subscribe('c1', () => {
      throw new Error('bad handler');
    });
    conversationBus.subscribe('c1', (row) => good.push(row));
    conversationBus.publish('c1', fakeRow('c1', 'x'));
    expect(good).toHaveLength(1);
  });
});
