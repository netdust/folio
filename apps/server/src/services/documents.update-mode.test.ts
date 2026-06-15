/**
 * Task 4 (audit 2.4 / M3) — updateDocument gains `mode: 'merge' | 'replace'`.
 *
 * Invariants 5 + 15: there must be ONE emission site for document.updated +
 * agent.task.assigned. The markdown-PATCH route used to wholesale-replace
 * frontmatter and emit its own events inline; it now delegates to the service
 * with mode:'replace'. These tests pin the replace-vs-merge frontmatter
 * contract and the single-emit guarantee at the SERVICE layer (Tier A — this
 * is the write/event-emission plane).
 */

import { expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { events, tables } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { createDocument, updateDocument } from './documents.ts';

async function getWorkItemsTable(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
) {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

async function seedItem(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  seed: Awaited<ReturnType<typeof makeTestApp>>['seed'],
  frontmatter: Record<string, unknown>,
) {
  const table = await getWorkItemsTable(db, seed.project.id);
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: { type: 'work_item', title: 'Seed', body: '', frontmatter, status: null },
  });
  return { table, document };
}

test('merge mode keeps existing frontmatter keys not in the patch', async () => {
  const { db, seed } = await makeTestApp();
  const { table, document } = await seedItem(db, seed, { a: 1, b: 2 });

  const updated = await updateDocument({
    workspace: seed.workspace,
    project: seed.project,
    fallbackTable: table,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    patch: { frontmatter: { a: 9 } },
    // mode omitted → defaults to 'merge'
  });

  const fm = updated.frontmatter as Record<string, unknown>;
  expect(fm.a).toBe(9);
  expect(fm.b).toBe(2); // untouched key survives the merge
});

test('replace mode overwrites frontmatter wholesale (keys not in the patch are dropped)', async () => {
  const { db, seed } = await makeTestApp();
  const { table, document } = await seedItem(db, seed, { a: 1, b: 2 });

  const updated = await updateDocument({
    workspace: seed.workspace,
    project: seed.project,
    fallbackTable: table,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    patch: { frontmatter: { a: 9 } },
    mode: 'replace',
  });

  const fm = updated.frontmatter as Record<string, unknown>;
  expect(fm.a).toBe(9);
  expect(fm.b).toBeUndefined(); // wholesale replace — old key is gone
});

test('replace mode still strips RESERVED_FRONTMATTER_KEYS (a reserved key is not written)', async () => {
  const { db, seed } = await makeTestApp();
  const { table, document } = await seedItem(db, seed, { a: 1 });

  const updated = await updateDocument({
    workspace: seed.workspace,
    project: seed.project,
    fallbackTable: table,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    // last_touched_at is a RESERVED_FRONTMATTER_KEY — a replace must NOT let it
    // through into the stored frontmatter, same as merge mode.
    patch: { frontmatter: { a: 9, last_touched_at: 'attacker-controlled' } },
    mode: 'replace',
  });

  const fm = updated.frontmatter as Record<string, unknown>;
  expect(fm.a).toBe(9);
  expect(fm.last_touched_at).toBeUndefined(); // reserved key stripped even in replace
});

test('replace mode emits EXACTLY ONE document.updated event for the doc', async () => {
  const { db, seed } = await makeTestApp();
  const { table, document } = await seedItem(db, seed, { a: 1, b: 2 });

  await updateDocument({
    workspace: seed.workspace,
    project: seed.project,
    fallbackTable: table,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    patch: { title: 'Replaced', body: 'new', status: null, frontmatter: { a: 9 } },
    mode: 'replace',
  });

  const updates = await db.query.events.findMany({
    where: and(eq(events.documentId, document.id), eq(events.kind, 'document.updated')),
    orderBy: [desc(events.seq)],
  });
  // ONE emission site (invariant 5) — not the create's document.created, and
  // not a duplicate from a second inline emit.
  expect(updates).toHaveLength(1);
  expect(updates[0]!.actor).toBe(seed.user.id); // eventActor preserved (invariant 15)
});
