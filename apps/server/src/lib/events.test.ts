import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events } from '../db/schema.ts';
import { emitEvent, txWithEvents } from './events.ts';
import { eventBus, type BusEvent } from './event-bus.ts';

test('emitEvent inserts row with correct fields', async () => {
  const { db, seed } = await makeTestApp();
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    kind: 'document.created',
    actor: seed.user.id,
    payload: { slug: 'abc' },
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('document.created');
  expect(rows[0]!.actor).toBe(seed.user.id);
  expect(rows[0]!.payload).toEqual({ slug: 'abc' });
});

test('emitEvent works inside a transaction', async () => {
  const { db, seed } = await makeTestApp();
  await db.transaction(async (tx) => {
    await emitEvent(tx, {
      workspaceId: seed.workspace.id,
      kind: 'workspace.updated',
      actor: seed.user.id,
    });
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
});

test('emitEvent accepts comment.created kind', async () => {
  const { db, seed } = await makeTestApp();
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    kind: 'comment.created',
    actor: seed.user.id,
    payload: { document_id: 'doc-1', parent_id: 'doc-1', author: seed.user.id, kind: 'comment' },
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('comment.created');
});

test('emitEvent accepts comment.mentioned kind', async () => {
  const { db, seed } = await makeTestApp();
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    kind: 'comment.mentioned',
    actor: seed.user.id,
    payload: { comment_id: 'c-1', parent_id: 'doc-1', agent_slug: 'triage-bot' },
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('comment.mentioned');
});

test('emitEvent accepts comment.deleted kind', async () => {
  const { db, seed } = await makeTestApp();
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    kind: 'comment.deleted',
    actor: seed.user.id,
    payload: { document_id: 'doc-1', parent_id: 'doc-1', author: seed.user.id },
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('comment.deleted');
});

test('emitEvent accepts agent.allow_list.reconciled kind', async () => {
  const { db, seed } = await makeTestApp();
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    kind: 'agent.allow_list.reconciled',
    actor: 'system',
    payload: { agent_id: 'agent-1', removed_project_ids: ['p-old'] },
  });
  const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('agent.allow_list.reconciled');
});

// ---------------------------------------------------------------------------
// F6 — txWithEvents defers bus publish until the tx commits.
// On rollback, the row is gone AND the bus publish must not fire.
// ---------------------------------------------------------------------------

/** Spy on eventBus.publish, capture published events into the returned array. */
function spyPublish(): { events: BusEvent[]; restore: () => void } {
  const captured: BusEvent[] = [];
  const orig = eventBus.publish.bind(eventBus);
  eventBus.publish = (e: BusEvent) => {
    captured.push(e);
    return orig(e);
  };
  return { events: captured, restore: () => { eventBus.publish = orig; } };
}

test('F6: txWithEvents publishes only AFTER the tx commits', async () => {
  const { db, seed } = await makeTestApp();
  const spy = spyPublish();
  try {
    await txWithEvents(db, async (tx) => {
      await emitEvent(tx, {
        workspaceId: seed.workspace.id,
        kind: 'workspace.updated',
        actor: seed.user.id,
      });
      // Inside the tx, the bus has NOT been published yet.
      expect(spy.events).toHaveLength(0);
    });
    // After commit, the publish fires.
    expect(spy.events).toHaveLength(1);
    expect(spy.events[0]!.kind).toBe('workspace.updated');
  } finally {
    spy.restore();
  }
});

test('F6: txWithEvents discards pending publishes when the tx body throws', async () => {
  // F6 closed the phantom-event hole. G10 additionally scrubs any rows that
  // bun-sqlite's no-rollback-on-async-throw quirk left behind, so the
  // durable events log and the live bus AGREE that nothing happened.
  const { db, seed } = await makeTestApp();
  const spy = spyPublish();
  try {
    let thrown: Error | null = null;
    try {
      await txWithEvents(db, async (tx) => {
        await emitEvent(tx, {
          workspaceId: seed.workspace.id,
          kind: 'workspace.updated',
          actor: seed.user.id,
        });
        throw new Error('forced rollback');
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toBe('forced rollback');
    // The bus event MUST NOT fire — F6.
    expect(spy.events).toHaveLength(0);
    // G10: the durable events row MUST be scrubbed too, so Last-Event-Id
    // replay can't redeliver it later (it'd diverge from live subscribers
    // that already missed it).
    const rows = await db.select().from(events).where(eq(events.workspaceId, seed.workspace.id));
    expect(rows).toHaveLength(0);
  } finally {
    spy.restore();
  }
});

test('H10: rollback-scrub chunks at 500 ids per DELETE (safe vs SQLite variable-cap)', async () => {
  // Confirm the chunking logic doesn't break for a small batch. A
  // 1000+ event tx is impractical to seed in a unit test, but the
  // batch-loop is exercised in any path that emits ≥1 event and
  // throws — this test just verifies the path runs cleanly.
  const { db, seed } = await makeTestApp();
  const spy = spyPublish();
  try {
    let thrown: Error | null = null;
    try {
      await txWithEvents(db, async (tx) => {
        // Emit a few events, then throw.
        for (let i = 0; i < 5; i++) {
          await emitEvent(tx, {
            workspaceId: seed.workspace.id,
            kind: 'workspace.updated',
            actor: seed.user.id,
            payload: { i },
          });
        }
        throw new Error('forced rollback for H10');
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toBe('forced rollback for H10');
    // No publishes leaked.
    expect(spy.events).toHaveLength(0);
    // No orphan rows.
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.workspaceId, seed.workspace.id));
    expect(rows).toHaveLength(0);
  } finally {
    spy.restore();
  }
});

test('F6: emitEvent(db, ...) outside a transaction still publishes inline (legacy)', async () => {
  // Used by events.test.ts itself + any one-shot emit without a tx.
  const { db, seed } = await makeTestApp();
  const spy = spyPublish();
  try {
    await emitEvent(db, {
      workspaceId: seed.workspace.id,
      kind: 'workspace.updated',
      actor: seed.user.id,
    });
    expect(spy.events).toHaveLength(1);
  } finally {
    spy.restore();
  }
});
