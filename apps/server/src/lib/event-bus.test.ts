import { expect, test } from 'bun:test';
import { type BusEvent, eventBus } from './event-bus.ts';

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
  const unsub = eventBus.subscribe('ws-1', { kinds: ['document.created'] }, (e) =>
    received.push(e),
  );
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

// BUG-021 — `?project=X` subscribers must ALSO see workspace-level events
// (projectId=null). The previous filter dropped them: an agent SSEing to
// `/events?project=proj-1` for sensible defaults missed
// agent.allow_list.reconciled (workspace-level, projectId=null), so the
// agent never learned its allow-list was scrubbed.
test('BUG-021: projectId filter still admits workspace-level events (projectId=null)', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', { projectId: 'p1' }, (e) => received.push(e));

  // Workspace-level event (no project scope). Should pass.
  eventBus.publish({
    workspaceId: 'ws-1',
    projectId: null,
    kind: 'agent.allow_list.reconciled',
    payload: { agent_slug: 'drafter' },
  });
  // Other-project event. Should NOT pass.
  eventBus.publish({
    workspaceId: 'ws-1',
    projectId: 'p2',
    kind: 'document.created',
    payload: {},
  });

  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe('agent.allow_list.reconciled');
  expect(received[0]!.projectId).toBeNull();
  unsub();
});

// Blind-spot close (hardening): projects.ts emits `project.deleted` with
// projectId:null (a workspace-level TOMBSTONE — the project row is gone, so the
// event can't carry its id). projects.test.ts asserts the emission shape and the
// BUG-021 test above proves the filter admits projectId:null generically, but NO
// test wired a `project.deleted` tombstone THROUGH the ?project=X filter to a
// subscriber. A `?project=X` SSE client (e.g. a Kanban board scoped to project X)
// MUST receive its own deletion notice — if the filter dropped projectId:null
// tombstones, the board would never learn it was deleted and would hang on a
// dead project. This pins that delivery, keyed to the real event kind.
test('project.deleted tombstone (projectId:null) reaches a ?project=X subscriber', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', { projectId: 'proj-X' }, (e) => received.push(e));

  // The tombstone for the very project this subscriber is filtered to. The row
  // is gone, so projectId is null (workspace-level), not 'proj-X'.
  eventBus.publish({
    workspaceId: 'ws-1',
    projectId: null,
    kind: 'project.deleted',
    payload: { slug: 'proj-x', name: 'Project X' },
  });
  // A DIFFERENT project's document event must still be filtered OUT — proves the
  // null short-circuit didn't accidentally open the gate to all events.
  eventBus.publish({
    workspaceId: 'ws-1',
    projectId: 'proj-Y',
    kind: 'document.created',
    payload: {},
  });

  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe('project.deleted');
  expect(received[0]!.projectId).toBeNull();
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
  const unsub1 = eventBus.subscribe('ws-1', undefined, () => {
    throw new Error('boom');
  });
  const unsub2 = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  unsub1();
  unsub2();
});

// ── system events (workspaceId: null) ───────────────────────────────────────

test('system event (workspaceId: null) is delivered to a subscriber whose workspace does not match', () => {
  const seen: string[] = [];
  const unsub = eventBus.subscribe('ws-A', undefined, (e) => seen.push(e.kind));
  eventBus.publish({
    workspaceId: null,
    kind: 'reactor.halted',
    payload: { reactor_id: 'x', stuck_at_seq: 1 },
  });
  unsub();
  expect(seen).toEqual(['reactor.halted']);
});

test('a normal workspace-scoped event still does NOT cross workspaces', () => {
  const seen: string[] = [];
  const unsub = eventBus.subscribe('ws-A', undefined, (e) => seen.push(e.kind));
  eventBus.publish({ workspaceId: 'ws-B', kind: 'document.created' });
  unsub();
  expect(seen).toEqual([]); // ws-A subscriber must not see ws-B's event
});

// A system event (workspaceId: null) must reach a PROJECT-scoped subscriber.
// Regression: emitReactorHealth omitted projectId, leaving e.projectId
// undefined. The projectId filter only short-circuits on `e.projectId === null`
// (the BUG-021 precedent); with `undefined`, the guard `e.projectId !== null` is
// true and the system event was DROPPED for any `?project=X` SSE client —
// reactor-health alerts invisible to project-scoped operators. The fix: system
// events publish projectId:null (and documentId:null) explicitly.
test('system event (workspaceId: null) IS delivered to a subscriber with a projectId filter', () => {
  const seen: string[] = [];
  const unsub = eventBus.subscribe('ws-A', { projectId: 'p1' }, (e) => seen.push(e.kind));
  eventBus.publish({
    workspaceId: null,
    projectId: null,
    documentId: null,
    kind: 'reactor.halted',
    payload: { reactor_id: 'x', stuck_at_seq: 1 },
  });
  unsub();
  expect(seen).toEqual(['reactor.halted']);
});

// Proves the ROOT CAUSE: a system event with projectId UNDEFINED (the pre-fix
// emitReactorHealth shape) is wrongly dropped by a projectId-filtered
// subscriber. Pins the contract that callers must pass projectId:null, not omit
// it. (emitReactorHealth's own test in event-dispatcher.test.ts proves it now
// passes projectId:null.)
test('system event with projectId UNDEFINED is dropped by a projectId filter (why callers must pass null)', () => {
  const seen: string[] = [];
  const unsub = eventBus.subscribe('ws-A', { projectId: 'p1' }, (e) => seen.push(e.kind));
  eventBus.publish({
    workspaceId: null,
    projectId: undefined,
    kind: 'reactor.halted',
    payload: { reactor_id: 'x', stuck_at_seq: 1 },
  });
  unsub();
  expect(seen).toEqual([]); // undefined projectId fails the project gate — documents the trap
});

// ── parentId filter ────────────────────────────────────────────────────────

test('parentId filter passes when payload.parent_id matches', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-p', { parentId: 'doc-1' }, (e) => received.push(e));
  eventBus.publish({
    workspaceId: 'ws-p',
    kind: 'comment.created',
    payload: { parent_id: 'doc-1' },
  });
  expect(received.length).toBe(1);
  unsub();
});

test('parentId filter excludes when payload.parent_id does not match', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-p', { parentId: 'doc-1' }, (e) => received.push(e));
  eventBus.publish({
    workspaceId: 'ws-p',
    kind: 'comment.created',
    payload: { parent_id: 'doc-2' },
  });
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
  eventBus.publish({
    workspaceId: 'ws-r',
    kind: 'document.created',
    payload: { run_id: 'run-abc' },
  });
  expect(received.length).toBe(1);
  unsub();
});

test('runId filter excludes when payload.run_id does not match', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-r', { runId: 'run-abc' }, (e) => received.push(e));
  eventBus.publish({
    workspaceId: 'ws-r',
    kind: 'document.created',
    payload: { run_id: 'run-xyz' },
  });
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
  const unsub = eventBus.subscribe(
    'ws-and',
    {
      kinds: ['comment.created'],
      projectId: 'p1',
      parentId: 'doc-1',
    },
    (e) => received.push(e),
  );

  // Fails kind filter
  eventBus.publish({
    workspaceId: 'ws-and',
    projectId: 'p1',
    kind: 'document.updated',
    payload: { parent_id: 'doc-1' },
  });
  // Fails projectId filter
  eventBus.publish({
    workspaceId: 'ws-and',
    projectId: 'p2',
    kind: 'comment.created',
    payload: { parent_id: 'doc-1' },
  });
  // Fails parentId filter
  eventBus.publish({
    workspaceId: 'ws-and',
    projectId: 'p1',
    kind: 'comment.created',
    payload: { parent_id: 'doc-99' },
  });
  // Passes all filters
  eventBus.publish({
    workspaceId: 'ws-and',
    projectId: 'p1',
    kind: 'comment.created',
    payload: { parent_id: 'doc-1' },
  });

  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe('comment.created');
  unsub();
});
