/**
 * Body-less list projection (M2 / audit M4).
 *
 * listDocuments serves the list/table/board views, which never render the
 * markdown `body` (the detail / `.md` route serves that). The list select must
 * therefore project an EXPLICIT column list that OMITS `body`, so an agent
 * write-burst of large-bodied docs does not re-ship every body on every list.
 *
 * Tier A: a data-layer projection regression silently re-ships full bodies (a
 * payload + leak-surface regression), so this asserts the contract directly:
 * every returned row has `body === undefined` while non-body fields stay intact.
 */

import { expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { documents, tables } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { listDocuments } from './documents.ts';

const BIG_BODY = '# Heading\n\n'.concat('lorem ipsum dolor sit amet '.repeat(200));

async function seedOneWorkItem() {
  const { db, seed } = await makeTestApp();
  const table = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, seed.project.id), eq(tables.slug, 'work-items')),
  });
  if (!table) throw new Error('test setup: work-items table missing');
  await db.insert(documents).values({
    id: nanoid(),
    projectId: seed.project.id,
    workspaceId: seed.workspace.id,
    tableId: table.id,
    type: 'work_item',
    slug: 'heavy',
    title: 'Heavy Doc',
    status: 'todo',
    body: BIG_BODY,
    frontmatter: { priority: 'high' },
  });
  return { projectId: seed.project.id, tableId: table.id };
}

test('list projection omits body but keeps non-body fields', async () => {
  const { projectId, tableId } = await seedOneWorkItem();

  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
  });

  // Projection didn't drop everything: at least the seeded row comes back.
  expect(data.length).toBeGreaterThanOrEqual(1);

  for (const row of data) {
    // The body column is NOT selected -> the key is absent on every row. The
    // return type is now Omit<Document,'body'> (compile-time proof body is gone),
    // so reach the runtime value through a record cast to assert it's undefined.
    expect((row as Record<string, unknown>).body).toBeUndefined();
    // Non-body fields the list/cursor logic relies on are intact.
    expect(typeof row.title).toBe('string');
    expect(row.id).toBeTruthy();
    expect(row.status).toBe('todo');
    expect(row.frontmatter).toEqual({ priority: 'high' });
  }
});

test('includeBody:true opts the body column back in (wiki excerpt path)', async () => {
  // CR-A regression fix: the wiki view feeds list rows into bodyExcerpt(), so it
  // explicitly opts into bodies via ?include=body. The default stays body-less
  // (table/board hot path); this opt-in must carry the body through.
  const { projectId, tableId } = await seedOneWorkItem();

  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    includeBody: true,
  });

  expect(data.length).toBeGreaterThanOrEqual(1);
  const seeded = data.find((r) => r.slug === 'heavy');
  if (!seeded) throw new Error('seeded row missing from list');
  // body present and non-empty when opted in.
  expect((seeded as Record<string, unknown>).body).toBe(BIG_BODY);

  // And the default call (no includeBody) still omits it — the two paths diverge.
  const { data: lean } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
  });
  const leanRow = lean.find((r) => r.slug === 'heavy');
  expect((leanRow as Record<string, unknown>).body).toBeUndefined();
});
