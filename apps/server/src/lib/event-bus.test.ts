import { test, expect } from 'bun:test';
import { eventBus, type BusEvent } from './event-bus.ts';

test('subscribe receives published events for matching workspace', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: { id: 'd1' } });
  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe('document.created');
  unsub();
});

test('subscribe does not receive events from other workspaces', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-2', kind: 'document.created', payload: {} });
  expect(received.length).toBe(0);
  unsub();
});

test('subscribe with a kinds filter only receives matching events', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', { kinds: ['document.created'] }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.updated', payload: {} });
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe('document.created');
  unsub();
});

test('subscribe with a projectId filter only receives events for that project', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', { projectId: 'p1' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', projectId: 'p2', kind: 'document.created', payload: {} });
  eventBus.publish({ workspaceId: 'ws-1', projectId: 'p1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  expect(received[0]!.projectId).toBe('p1');
  unsub();
});

test('unsubscribe stops receiving events', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  unsub();
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(0);
});

test('handler errors do not break other subscribers', () => {
  const received: BusEvent[] = [];
  const unsub1 = eventBus.subscribe('ws-1', undefined, () => { throw new Error('boom'); });
  const unsub2 = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  unsub1();
  unsub2();
});
