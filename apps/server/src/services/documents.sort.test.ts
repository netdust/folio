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
import { documents, fields, tables } from '../db/schema.ts';
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

/**
 * Seed 5 work items where 3 have a NULL status and 2 have real statuses.
 * status is a NULLABLE column (schema.ts: text('status')), so a page
 * boundary can land inside the NULL-status group. The keyset cursor must
 * still address those rows or they silently vanish from later pages.
 */
async function seedNullStatuses(): Promise<Seeded> {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const rows = [
    { title: 'n1', status: null, updatedAt: T + 10 },
    { title: 'n2', status: null, updatedAt: T + 20 },
    { title: 'n3', status: null, updatedAt: T + 30 },
    { title: 'aaa', status: 'backlog', updatedAt: T + 40 },
    { title: 'zzz', status: 'todo', updatedAt: T + 50 },
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

test('sort by status with NULL statuses spanning a page boundary drops no rows (regression)', async () => {
  const { projectId, tableId } = await seedNullStatuses();
  const opts = {
    projectId,
    activeTableId: tableId,
    type: 'work_item' as const,
    sort: 'status' as const,
    dir: 'asc' as const,
  };
  const p1 = await listDocuments({ ...opts, limit: 2 });
  const p2 = p1.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p1.nextCursor })
    : { data: [], nextCursor: null };
  const p3 = p2.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p2.nextCursor })
    : { data: [], nextCursor: null };
  const all = [...p1.data, ...p2.data, ...p3.data].map((d) => d.id);
  // ALL 5 rows must appear across pages, none dropped (pre-fix the NULL-status
  // group is excluded from later pages → set size < 5).
  expect(new Set(all).size).toBe(5);
});

// ----- FS-1: sort by validated, type-aware frontmatter fields -----

/**
 * Seed work items with numeric `priority` and ISO `due_date` in frontmatter,
 * AND register `fields` rows (priority: number, due_date: date) on the seeded
 * table so the custom-sort validation accepts the keys.
 */
async function seedFields(
  rows: { title: string; priority?: number; due_date?: string }[],
): Promise<Seeded> {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await db.insert(fields).values([
    {
      id: nanoid(),
      projectId: seed.project.id,
      tableId: table.id,
      key: 'priority',
      type: 'number',
    },
    {
      id: nanoid(),
      projectId: seed.project.id,
      tableId: table.id,
      key: 'due_date',
      type: 'date',
    },
  ]);
  let t = T;
  for (const r of rows) {
    t += 10;
    const fm: Record<string, unknown> = {};
    if (r.priority !== undefined) fm.priority = r.priority;
    if (r.due_date !== undefined) fm.due_date = r.due_date;
    await db.insert(documents).values({
      id: nanoid(),
      projectId: seed.project.id,
      workspaceId: seed.workspace.id,
      tableId: table.id,
      type: 'work_item',
      slug: r.title.toLowerCase(),
      title: r.title,
      status: 'todo',
      body: '',
      frontmatter: fm,
      createdAt: new Date(t),
      updatedAt: new Date(t),
    });
  }
  return {
    db,
    projectId: seed.project.id,
    tableId: table.id,
    workspaceId: seed.workspace.id,
  };
}

test('sort by priority asc orders numerically (1,2,10 not 1,10,2)', async () => {
  const { projectId, tableId } = await seedFields([
    { title: 'p2', priority: 2 },
    { title: 'p10', priority: 10 },
    { title: 'p1', priority: 1 },
  ]);
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'priority',
    dir: 'asc',
  });
  expect(
    data.map((d) => (d.frontmatter as Record<string, unknown>).priority),
  ).toEqual([1, 2, 10]);
});

test('sort by due_date asc orders chronologically', async () => {
  const { projectId, tableId } = await seedFields([
    { title: 'd2', due_date: '2026-03-15' },
    { title: 'd3', due_date: '2026-11-01' },
    { title: 'd1', due_date: '2026-01-02' },
  ]);
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'due_date',
    dir: 'asc',
  });
  expect(
    data.map((d) => (d.frontmatter as Record<string, unknown>).due_date),
  ).toEqual(['2026-01-02', '2026-03-15', '2026-11-01']);
});

test('sort by priority with missing values keeps them last (asc) and drops none across a page boundary', async () => {
  const { projectId, tableId } = await seedFields([
    { title: 'a', priority: 1 },
    { title: 'b', priority: 2 },
    { title: 'c' }, // missing
    { title: 'd' }, // missing
    { title: 'e', priority: 3 },
  ]);
  const opts = {
    projectId,
    activeTableId: tableId,
    type: 'work_item' as const,
    sort: 'priority',
    dir: 'asc' as const,
  };
  const p1 = await listDocuments({ ...opts, limit: 2 });
  const p2 = p1.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p1.nextCursor })
    : { data: [], nextCursor: null };
  const p3 = p2.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p2.nextCursor })
    : { data: [], nextCursor: null };
  const all = [...p1.data, ...p2.data, ...p3.data];
  expect(new Set(all.map((d) => d.id)).size).toBe(5);
  // The two missing-priority rows must land last under asc.
  expect(all.slice(-2).map((d) => d.title).sort()).toEqual(['c', 'd']);
});

test('sort by priority pages numerically across a boundary without drops (cast guard)', async () => {
  const { projectId, tableId } = await seedFields([
    { title: 'a', priority: 10 },
    { title: 'b', priority: 2 },
    { title: 'c', priority: 1 },
    { title: 'd', priority: 3 },
  ]);
  const opts = {
    projectId,
    activeTableId: tableId,
    type: 'work_item' as const,
    sort: 'priority',
    dir: 'asc' as const,
  };
  const p1 = await listDocuments({ ...opts, limit: 2 });
  const p2 = p1.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p1.nextCursor })
    : { data: [], nextCursor: null };
  const ordered = [...p1.data, ...p2.data].map(
    (d) => (d.frontmatter as Record<string, unknown>).priority,
  );
  expect(ordered).toEqual([1, 2, 3, 10]);
  expect(new Set([...p1.data, ...p2.data].map((d) => d.id)).size).toBe(4);
});

test('sort by an unregistered key falls back to updated_at desc', async () => {
  const { projectId, tableId } = await seedFields([
    { title: 'a', priority: 1 },
    { title: 'b', priority: 2 },
    { title: 'c', priority: 3 },
  ]);
  const { data } = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'not_a_field',
  });
  // updated_at desc: last-seeded ('c') first.
  expect(titles(data)).toEqual(['c', 'b', 'a']);
});

// ----- FS-2: non-numeric field holding JSON numbers must not drop rows -----

/**
 * Seed work items under a `select`-typed field `bucket` whose frontmatter
 * values are JSON NUMBERS (2, 10, 3) plus one row MISSING the field. A
 * non-numeric field sorts on the raw json_extract: pre-fix the value keeps its
 * NUMERIC storage class in ORDER BY, but the keyset cursor is text → a page
 * boundary between numeric rows drops the row whose value sorts after the
 * cursor under numeric-vs-text affinity (e.g. 10 vs '3'). Casting json_extract
 * to text in fieldSortExpr makes ORDER BY, the keyset predicate, and the text
 * cursor all compare with consistent TEXT affinity — no drops.
 */
async function seedSelectNumbers(): Promise<Seeded> {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await db.insert(fields).values({
    id: nanoid(),
    projectId: seed.project.id,
    tableId: table.id,
    key: 'bucket',
    type: 'select',
  });
  const rows: { title: string; bucket?: number }[] = [
    { title: 'b2', bucket: 2 },
    { title: 'b10', bucket: 10 },
    { title: 'b3', bucket: 3 },
    { title: 'bmiss' }, // missing bucket
  ];
  let t = T;
  for (const r of rows) {
    t += 10;
    const fm: Record<string, unknown> = {};
    if (r.bucket !== undefined) fm.bucket = r.bucket;
    await db.insert(documents).values({
      id: nanoid(),
      projectId: seed.project.id,
      workspaceId: seed.workspace.id,
      tableId: table.id,
      type: 'work_item',
      slug: r.title.toLowerCase(),
      title: r.title,
      status: 'todo',
      body: '',
      frontmatter: fm,
      createdAt: new Date(t),
      updatedAt: new Date(t),
    });
  }
  return {
    db,
    projectId: seed.project.id,
    tableId: table.id,
    workspaceId: seed.workspace.id,
  };
}

test('sort by a non-numeric field holding numeric JSON values drops no rows across a page boundary (regression)', async () => {
  const { projectId, tableId } = await seedSelectNumbers();
  const opts = {
    projectId,
    activeTableId: tableId,
    type: 'work_item' as const,
    sort: 'bucket',
    dir: 'asc' as const,
  };
  const p1 = await listDocuments({ ...opts, limit: 2 });
  const p2 = p1.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p1.nextCursor })
    : { data: [], nextCursor: null };
  const p3 = p2.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p2.nextCursor })
    : { data: [], nextCursor: null };
  const all = [...p1.data, ...p2.data, ...p3.data].map((d) => d.id);
  // ALL rows must survive paging. Pre-fix, numeric '10' compares against text
  // cursor '3' as 10 > '3' → FALSE under SQLite affinity → '10' is dropped.
  expect(new Set(all).size).toBe(4);
});

// ----- B3: manual-order sort key (board_position), nulls last + keyset -----

/**
 * Seed 4 work items, then set board_position directly on three ('b','a','c')
 * and leave one NULL. board_position is a NULLABLE text column, so it must
 * follow the same coalesce-to-sentinel discipline as `status`: NULLs sort
 * LAST under asc and the keyset cursor must address them or they vanish.
 */
async function seedBoardPositions(): Promise<Seeded & { ids: Record<string, string> }> {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const ids: Record<string, string> = {};
  const rows: { title: string; pos: string | null }[] = [
    { title: 'wb', pos: 'b' },
    { title: 'wa', pos: 'a' },
    { title: 'wc', pos: 'c' },
    { title: 'wnull', pos: null },
  ];
  let t = T;
  for (const r of rows) {
    t += 10;
    const id = nanoid();
    ids[r.title] = id;
    await db.insert(documents).values({
      id,
      projectId: seed.project.id,
      workspaceId: seed.workspace.id,
      tableId: table.id,
      type: 'work_item',
      slug: r.title.toLowerCase(),
      title: r.title,
      status: 'todo',
      body: '',
      frontmatter: {},
      createdAt: new Date(t),
      updatedAt: new Date(t),
    });
    if (r.pos !== null) {
      await db
        .update(documents)
        .set({ boardPosition: r.pos })
        .where(eq(documents.id, id));
    }
  }
  return {
    db,
    projectId: seed.project.id,
    tableId: table.id,
    workspaceId: seed.workspace.id,
    ids,
  };
}

test('sort by board_position orders ranked rows asc, nulls last', async () => {
  const { projectId, tableId } = await seedBoardPositions();
  const r = await listDocuments({
    projectId,
    activeTableId: tableId,
    type: 'work_item',
    sort: 'board_position',
    dir: 'asc',
  });
  const pos = r.data.map((d) => d.boardPosition ?? null);
  expect(pos.slice(0, 3)).toEqual(['a', 'b', 'c']);
  expect(pos[3]).toBeNull();
});

test('board_position keyset pagination with a null row across a boundary drops nothing', async () => {
  const { projectId, tableId } = await seedBoardPositions();
  const opts = {
    projectId,
    activeTableId: tableId,
    type: 'work_item' as const,
    sort: 'board_position' as const,
    dir: 'asc' as const,
  };
  const p1 = await listDocuments({ ...opts, limit: 2 });
  const p2 = p1.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p1.nextCursor })
    : { data: [], nextCursor: null };
  const p3 = p2.nextCursor
    ? await listDocuments({ ...opts, limit: 2, cursor: p2.nextCursor })
    : { data: [], nextCursor: null };
  const all = [...p1.data, ...p2.data, ...p3.data].map((d) => d.id);
  expect(new Set(all).size).toBe(4); // ALL rows survive (3 ranked + 1 null)
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
