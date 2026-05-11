import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents } from '../db/schema.ts';
import { slugUniqueInDocuments, slugUniqueInProjects, slugUniqueInWorkspaces } from './slug-unique.ts';

test('returns base when free', async () => {
  const { db, seed } = await makeTestApp();
  expect(await slugUniqueInDocuments(db, seed.project.id, 'hello-world')).toBe('hello-world');
});

test('returns base-2 when base taken', async () => {
  const { db, seed } = await makeTestApp();
  await db.insert(documents).values({
    id: nanoid(),
    projectId: seed.project.id,
    type: 'work_item',
    slug: 'hello-world',
    title: 'Hello',
  });
  expect(await slugUniqueInDocuments(db, seed.project.id, 'hello-world')).toBe('hello-world-2');
});

test('returns base-3 when base and base-2 taken', async () => {
  const { db, seed } = await makeTestApp();
  for (const s of ['hello-world', 'hello-world-2']) {
    await db.insert(documents).values({
      id: nanoid(), projectId: seed.project.id, type: 'work_item', slug: s, title: 'x',
    });
  }
  expect(await slugUniqueInDocuments(db, seed.project.id, 'hello-world')).toBe('hello-world-3');
});

test('scoped to project', async () => {
  const { db, seed } = await makeTestApp();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, type: 'work_item', slug: 'foo', title: 'x',
  });
  // A different project; same slug should still be free if we passed a different projectId.
  expect(await slugUniqueInDocuments(db, 'different-project-id', 'foo')).toBe('foo');
});
