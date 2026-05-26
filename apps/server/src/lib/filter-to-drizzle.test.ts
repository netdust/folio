import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { filterCompile } from '@folio/shared';
import { makeTestApp } from '../test/harness.ts';
import { documents } from '../db/schema.ts';
import { compileFilterToWhere } from './filter-to-drizzle.ts';

async function seedDocs(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  workspaceId: string,
) {
  for (const d of [
    { type: 'work_item' as const, slug: 'a', title: 'A', status: 'todo', frontmatter: { priority: 'high' } },
    { type: 'work_item' as const, slug: 'b', title: 'B', status: 'done', frontmatter: { priority: 'low' } },
    { type: 'page' as const, slug: 'c', title: 'C', status: null, frontmatter: {} },
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
  const where = compileFilterToWhere(filterCompile({ status: { $in: ['todo', 'done'] } }), documents);
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

test('empty AST returns no-op (selects all)', async () => {
  const { db, seed } = await makeTestApp();
  await seedDocs(db, seed.project.id, seed.workspace.id);
  const where = compileFilterToWhere(filterCompile({}), documents);
  const rows = await db.select().from(documents).where(where);
  expect(rows).toHaveLength(3);
});
