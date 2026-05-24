import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { statuses, views, projects, tables } from '../db/schema.ts';
import { seedProjectDefaults } from './seed-project-defaults.ts';

test('seedProjectDefaults inserts 1 table, 4 statuses, and 2 views all linked to the table', async () => {
  const { db, seed } = await makeTestApp();
  const newProjectId = nanoid();
  await db.insert(projects).values({
    id: newProjectId, workspaceId: seed.workspace.id, slug: 'fresh', name: 'Fresh',
  });
  await db.transaction(async (tx) => {
    await seedProjectDefaults(tx, newProjectId);
  });

  const t = await db.select().from(tables).where(eq(tables.projectId, newProjectId));
  expect(t).toHaveLength(1);
  expect(t[0]!.slug).toBe('work-items');
  expect(t[0]!.name).toBe('Work Items');
  const defaultTableId = t[0]!.id;

  const s = await db.select().from(statuses).where(eq(statuses.projectId, newProjectId));
  const v = await db.select().from(views).where(eq(views.projectId, newProjectId));
  expect(s.map((r) => r.key).sort()).toEqual(['backlog', 'done', 'in_progress', 'todo']);
  expect(s.every((r) => r.tableId === defaultTableId)).toBe(true);
  expect(v).toHaveLength(2);
  expect(v.find((r) => r.name === 'All work items')!.isDefault).toBe(true);
  expect(v.every((r) => r.tableId === defaultTableId)).toBe(true);
});

test('seedProjectDefaults returns the default tableId', async () => {
  const { db, seed } = await makeTestApp();
  const newProjectId = nanoid();
  await db.insert(projects).values({
    id: newProjectId, workspaceId: seed.workspace.id, slug: 'returns', name: 'Returns',
  });
  const result = await db.transaction(async (tx) => {
    return seedProjectDefaults(tx, newProjectId);
  });

  expect(result).toBeDefined();
  expect(typeof result.tableId).toBe('string');
  expect(result.tableId.length).toBeGreaterThan(0);

  const t = await db.select().from(tables).where(eq(tables.projectId, newProjectId));
  expect(t).toHaveLength(1);
  expect(result.tableId).toBe(t[0]!.id);
});
