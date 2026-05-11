import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { statuses, views, projects } from '../db/schema.ts';
import { seedProjectDefaults } from './seed-project-defaults.ts';

test('seedProjectDefaults inserts 4 statuses and 2 views', async () => {
  const { db, seed } = await makeTestApp();
  const newProjectId = nanoid();
  await db.insert(projects).values({
    id: newProjectId, workspaceId: seed.workspace.id, slug: 'fresh', name: 'Fresh',
  });
  await db.transaction(async (tx) => {
    await seedProjectDefaults(tx, newProjectId);
  });
  const s = await db.select().from(statuses).where(eq(statuses.projectId, newProjectId));
  const v = await db.select().from(views).where(eq(views.projectId, newProjectId));
  expect(s.map((r) => r.key).sort()).toEqual(['backlog', 'done', 'in_progress', 'todo']);
  expect(v).toHaveLength(2);
  expect(v.find((r) => r.name === 'All work items')!.isDefault).toBe(true);
});
