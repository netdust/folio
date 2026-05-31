/**
 * Sort-aware tests for listDocuments.
 *
 * listDocuments must honor the built-in sort columns (title, status,
 * updated_at) with a sort-aware keyset cursor so pagination stays correct.
 * These call the service directly (no HTTP), mirroring documents.test.ts.
 */

import { test, expect } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents, tables } from '../db/schema.ts';
import { listDocuments } from './documents.ts';

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

const T = 1_700_000_000_000;

interface Seeded {
  db: Awaited<ReturnType<typeof makeTestApp>>['db'];
  projectId: string;
  tableId: string;
  workspaceId: string;
}

/**
 * Seed 5 work items with distinct titles, statuses, and updatedAt values.
 * Statuses use the seeded project's registry (backlog/todo/in_progress/done)
 * so validateStatus would pass; two rows share 'todo' to exercise the
 * stable secondary sort by id within equal status values.
 */
async function seedFive(): Promise<Seeded> {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const rows = [
    { title: 'Apple',  status: 'todo',        updatedAt: T + 10 },
    { title: 'Cherry', status: 'in_progress', updatedAt: T + 40 },
    { title: 'Banana', status: 'done',        updatedAt: T + 20 },
    { title: 'Date',   status: 'backlog',     updatedAt: T + 50 },
    { title: 'Elder',  status: 'todo',        updatedAt: T + 30 },
  ];
  for (const r of rows) {
    await db.insert(documents).values({
      id: nanoid(),
      projectId: seed.project.id,
      workspaceId: seed.workspace.id,
      tableId: table.id,
      type: 'work_item',
      slug: r.title.toLowerCase(),
      title: r.title,
      status: r.status,
      body: '',
      frontmatter: {},
      createdAt: new Date(r.updatedAt),
      updatedAt: new Date(r.updatedAt),
    });
  }
  return {
    db,
    projectId: seed.project.id,
    tableId: table.id,
    workspaceId: seed.workspace.id,
  };
}

function titles(rows: { title: string }[]): string[] {
  return rows.map((r) => r.title);
}

test('default sort is updated_at desc', async () => {
  const { projectId, tableId } = await seedFive();
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
  });
  expect(titles(data)).toEqual(['Date', 'Cherry', 'Elder', 'Banana', 'Apple']);
});

test('sort by title asc', async () => {
  const { projectId, tableId } = await seedFive();
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'title',
    dir: 'asc',
  });
  expect(titles(data)).toEqual(['Apple', 'Banana', 'Cherry', 'Date', 'Elder']);
});

test('sort by title desc', async () => {
  const { projectId, tableId } = await seedFive();
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'title',
    dir: 'desc',
  });
  expect(titles(data)).toEqual(['Elder', 'Date', 'Cherry', 'Banana', 'Apple']);
});

test('sort by status asc', async () => {
  const { projectId, tableId } = await seedFive();
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'status',
    dir: 'asc',
  });
  // Ascending stored-string order of backlog/done/in_progress/todo/todo.
  // The two 'todo' rows (Apple, Elder) come last, ordered by id secondary.
  expect(data.map((r) => r.status)).toEqual([
    'backlog',
    'done',
    'in_progress',
    'todo',
    'todo',
  ]);
});

test('invalid sort key falls back to updated_at desc', async () => {
  const { projectId, tableId } = await seedFive();
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'nonsense' as never,
  });
  expect(titles(data)).toEqual(['Date', 'Cherry', 'Elder', 'Banana', 'Apple']);
});

test('keyset pagination under title asc drops/dupes nothing', async () => {
  const { projectId, tableId } = await seedFive();

  const p1 = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'title',
    dir: 'asc',
    limit: 2,
  });
  expect(titles(p1.data)).toEqual(['Apple', 'Banana']);
  expect(p1.nextCursor).toBeString();

  const p2 = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'title',
    dir: 'asc',
    limit: 2,
    cursor: p1.nextCursor!,
  });
  expect(titles(p2.data)).toEqual(['Cherry', 'Date']);
  expect(p2.nextCursor).toBeString();

  const p3 = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'title',
    dir: 'asc',
    limit: 2,
    cursor: p2.nextCursor!,
  });
  expect(titles(p3.data)).toEqual(['Elder']);
  expect(p3.nextCursor).toBeNull();

  const union = new Set([...titles(p1.data), ...titles(p2.data), ...titles(p3.data)]);
  expect(union.size).toBe(5);
});

test('a cursor minted under one sort is ignored under a different sort', async () => {
  const { projectId, tableId } = await seedFive();

  const p1 = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'title',
    dir: 'asc',
    limit: 2,
  });
  expect(titles(p1.data)).toEqual(['Apple', 'Banana']);
  expect(p1.nextCursor).toBeString();

  // Reuse the title-asc cursor under updated_at desc: it must be ignored,
  // so we get page 1 of updated_at desc, not a mid-stream slice.
  const mixed = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'updated_at',
    dir: 'desc',
    limit: 2,
    cursor: p1.nextCursor!,
  });
  expect(titles(mixed.data)).toEqual(['Date', 'Cherry']);
});
