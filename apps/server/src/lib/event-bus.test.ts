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

// ── parentId filter ────────────────────────────────────────────────────────

test('parentId filter passes when payload.parent_id matches', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-p', { parentId: 'doc-1' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-p', kind: 'comment.created', payload: { parent_id: 'doc-1' } });
  expect(received.length).toBe(1);
  unsub();
});

test('parentId filter excludes when payload.parent_id does not match', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-p', { parentId: 'doc-1' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-p', kind: 'comment.created', payload: { parent_id: 'doc-2' } });
  expect(received.length).toBe(0);
  unsub();
});

test('parentId filter excludes events whose payload has no parent_id key', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-p', { parentId: 'doc-1' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-p', kind: 'workspace.updated', payload: {} });
  expect(received.length).toBe(0);
  unsub();
});

// ── runId filter ───────────────────────────────────────────────────────────

test('runId filter passes when payload.run_id matches', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-r', { runId: 'run-abc' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-r', kind: 'document.created', payload: { run_id: 'run-abc' } });
  expect(received.length).toBe(1);
  unsub();
});

test('runId filter excludes when payload.run_id does not match', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-r', { runId: 'run-abc' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-r', kind: 'document.created', payload: { run_id: 'run-xyz' } });
  expect(received.length).toBe(0);
  unsub();
});

test('runId filter excludes events whose payload has no run_id key', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-r', { runId: 'run-abc' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-r', kind: 'workspace.updated', payload: {} });
  expect(received.length).toBe(0);
  unsub();
});

// ── AND-combination ────────────────────────────────────────────────────────

test('AND-combination: kinds + parentId + projectId all must match', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-and', {
    kinds: ['comment.created'],
    projectId: 'p1',
    parentId: 'doc-1',
  }, (e) => received.push(e));

  // Fails kind filter
  eventBus.publish({ workspaceId: 'ws-and', projectId: 'p1', kind: 'document.updated', payload: { parent_id: 'doc-1' } });
  // Fails projectId filter
  eventBus.publish({ workspaceId: 'ws-and', projectId: 'p2', kind: 'comment.created', payload: { parent_id: 'doc-1' } });
  // Fails parentId filter
  eventBus.publish({ workspaceId: 'ws-and', projectId: 'p1', kind: 'comment.created', payload: { parent_id: 'doc-99' } });
  // Passes all filters
  eventBus.publish({ workspaceId: 'ws-and', projectId: 'p1', kind: 'comment.created', payload: { parent_id: 'doc-1' } });

  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe('comment.created');
  unsub();
});
