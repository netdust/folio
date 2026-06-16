import { expect, test } from 'bun:test';
import { filterCompile } from '@folio/shared';
import { nanoid } from 'nanoid';
import { documents } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { compileFilterToWhere } from './filter-to-drizzle.ts';

async function seedDocs(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  workspaceId: string,
) {
  for (const d of [
    {
      type: 'work_item' as const,
      slug: 'a',
      title: 'A',
      status: 'todo',
      frontmatter: { priority: 'high', labels: ['bug', 'urgent'] },
    },
    {
      type: 'work_item' as const,
      slug: 'b',
      title: 'B',
      status: 'done',
      frontmatter: { priority: 'low', labels: ['bug'] },
    },
    { type: 'page' as const, slug: 'c', title: 'C', status: null, frontmatter: { labels: [] } },
  ]) {
    await db.insert(documents).values({ id: nanoid(), projectId, workspaceId, ...d });
  }
}

test('column $eq', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({ type: 'work_item' }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('frontmatter $eq via json_extract', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({ priority: 'high' }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug)).toEqual(['a']);
});

test('$in on column', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(
    filterCompile({ status: { $in: ['todo', 'done'] } }),
    documents,
  );
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('$exists on frontmatter', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({ priority: { $exists: true } }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('$contains single value matches docs whose labels array contains it', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({ labels: { $contains: 'bug' } }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('$contains array uses AND semantics (every value must be present)', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(
    filterCompile({ labels: { $contains: ['bug', 'urgent'] } }),
    documents,
  );
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug)).toEqual(['a']);
});

test('$contains excludes docs missing the label entirely', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({ labels: { $contains: 'urgent' } }), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug)).toEqual(['a']);
});

test('$contains treats a SQL-injection payload as a literal label value (zero rows)', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(
    filterCompile({ labels: { $contains: "x' OR '1'='1" } }),
    documents,
  );
  // If the value were interpolated rather than bound, the OR clause would match
  // every row. Bound as a literal, no label equals that string → zero rows.
  const rows = await db.select().from(documents).where(where);
  expect(rows).toHaveLength(0);
});

test('$contains on a built-in column throws (columns are not arrays)', () => {
  // LOW-1: the primary rejection is now in filterCompile (one validation layer);
  // filterCompile throws before an AST is produced.
  expect(() => filterCompile({ status: { $contains: 'todo' } })).toThrow();
  // Defense-in-depth: even if a hand-built AST bypasses filterCompile, the
  // compiler still refuses $contains on a built-in column.
  const handBuilt = {
    kind: 'cmp' as const,
    key: 'status',
    op: '$contains' as const,
    value: 'todo',
  };
  expect(() => compileFilterToWhere(handBuilt, documents)).toThrow();
});

test('HIGH-1: a scalar-string frontmatter value does NOT crash json_each — excluded, not 500', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  // A malformed row: `labels` is a SCALAR STRING, not an array. Frontmatter is
  // schemaless/freely-writable, so one such row must not break the whole listing.
  await db.insert(documents).values({
    id: nanoid(),
    projectId: seed.project.id,
    workspaceId: seed.workspace.id,
    type: 'work_item',
    slug: 'scalar',
    title: 'Scalar',
    status: 'todo',
    frontmatter: { labels: 'bug' },
  });
  const where = compileFilterToWhere(filterCompile({ labels: { $contains: 'bug' } }), documents);
  // Must NOT throw "malformed JSON"; the scalar-string row is excluded, only the
  // genuine-array rows (a, b) match.
  const rows = await db.select().from(documents).where(where);
  expect(rows.map((r) => r.slug).sort()).toEqual(['a', 'b']);
});

test('empty AST returns no-op (selects all)', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({}), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows).toHaveLength(3);
});
