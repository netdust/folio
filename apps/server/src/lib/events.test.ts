import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events } from '../db/schema.ts';
import { emitEvent } from './events.ts';

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
