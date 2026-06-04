import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { listProjects } from './projects.ts';

async function mkUser(db: any, email: string, role: 'owner' | 'admin' | 'member') {
  const id = nanoid();
  await db.insert(schema.users).values({ id, email, name: email, role });
  return id;
}

describe('listProjects (post-tenancy access model)', () => {
  test('owner sees all projects in the workspace', async () => {
    const { db } = await makeBareTestDb();
    const owner = await mkUser(db, 'o@t', 'owner');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid();
    const p2 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });
    await db.insert(schema.projects).values({ id: p2, workspaceId: wsA, slug: 'p2', name: 'P2' });

    const rows = await listProjects(wsA, owner);
    expect(rows.map((p) => p.slug).sort()).toEqual(['p1', 'p2']);
  });

  test('ws-grant holder sees all projects in the workspace', async () => {
    const { db } = await makeBareTestDb();
    const wsUser = await mkUser(db, 'w@t', 'member');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid();
    const p2 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });
    await db.insert(schema.projects).values({ id: p2, workspaceId: wsA, slug: 'p2', name: 'P2' });
    await db.insert(schema.workspaceAccess).values({ userId: wsUser, workspaceId: wsA });

    const rows = await listProjects(wsA, wsUser);
    expect(rows.map((p) => p.slug).sort()).toEqual(['p1', 'p2']);
  });

  test('project-only caller (traverse) sees ONLY their granted project, not siblings', async () => {
    const { db } = await makeBareTestDb();
    const projUser = await mkUser(db, 'p@t', 'member');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid();
    const p2 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });
    await db.insert(schema.projects).values({ id: p2, workspaceId: wsA, slug: 'p2', name: 'P2' });
    // grant ONLY to p1
    await db.insert(schema.projectAccess).values({ userId: projUser, projectId: p1 });

    const rows = await listProjects(wsA, projUser);
    expect(rows.map((p) => p.slug)).toEqual(['p1']); // NOT p2 — the leak this prevents
  });

  test('caller with no grants in the workspace sees no projects', async () => {
    const { db } = await makeBareTestDb();
    const stranger = await mkUser(db, 's@t', 'member');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });

    const rows = await listProjects(wsA, stranger);
    expect(rows).toEqual([]);
  });
});
