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
  const ast = filterCompile({ status: { $contains: 'todo' } });
  expect(() => compileFilterToWhere(ast, documents)).toThrow();
});

test('empty AST returns no-op (selects all)', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({}), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows).toHaveLength(3);
});
