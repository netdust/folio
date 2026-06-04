import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { canSeeWorkspace, canSeeProject, userRole, hasWorkspaceAccess, hasProjectAccess } from './access.ts';

async function mkUser(db: any, email: string, role: 'owner' | 'admin' | 'member') {
  const id = nanoid();
  await db.insert(schema.users).values({ id, email, name: email, role });
  return id;
}

describe('access rules (the visibility convergence point)', () => {
  test('owner sees all; ws-grant sees ws+all its projects; project-grant traverses ws but sees only that project', async () => {
    const { db } = await makeBareTestDb();
    const owner = await mkUser(db, 'o@t', 'owner');
    const wsUser = await mkUser(db, 'w@t', 'member');
    const projUser = await mkUser(db, 'p@t', 'member');
    const stranger = await mkUser(db, 's@t', 'member');

    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });
    const p2 = nanoid();
    await db.insert(schema.projects).values({ id: p2, workspaceId: wsA, slug: 'p2', name: 'P2' });

    await db.insert(schema.workspaceAccess).values({ userId: wsUser, workspaceId: wsA });
    await db.insert(schema.projectAccess).values({ userId: projUser, projectId: p1 });

    // userRole
    expect(await userRole(db, owner)).toBe('owner');
    expect(await userRole(db, wsUser)).toBe('member');

    // owner: everything
    expect(await canSeeWorkspace(db, owner, wsA)).toBe(true);
    expect(await canSeeProject(db, owner, p2)).toBe(true);

    // ws-grant: ws + BOTH projects
    expect(await canSeeWorkspace(db, wsUser, wsA)).toBe(true);
    expect(await canSeeProject(db, wsUser, p1)).toBe(true);
    expect(await canSeeProject(db, wsUser, p2)).toBe(true);

    // project-only: traverses the ws (canSeeWorkspace true) but sees ONLY p1
    expect(await canSeeWorkspace(db, projUser, wsA)).toBe(true);   // traverse clause
    expect(await canSeeProject(db, projUser, p1)).toBe(true);
    expect(await canSeeProject(db, projUser, p2)).toBe(false);     // NOT the other project

    // stranger (member, no grants): sees nothing
    expect(await canSeeWorkspace(db, stranger, wsA)).toBe(false);
    expect(await canSeeProject(db, stranger, p1)).toBe(false);

    // low-level helpers
    expect(await hasWorkspaceAccess(db, wsUser, wsA)).toBe(true);
    expect(await hasWorkspaceAccess(db, projUser, wsA)).toBe(false);
    expect(await hasProjectAccess(db, projUser, p1)).toBe(true);
    expect(await hasProjectAccess(db, projUser, p2)).toBe(false);
  });

  test('admin does NOT bypass grants for visibility (only owner does)', async () => {
    const { db } = await makeBareTestDb();
    const admin = await mkUser(db, 'a@t', 'admin');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });
    // admin has NO grant
    expect(await canSeeWorkspace(db, admin, wsA)).toBe(false);
    expect(await canSeeProject(db, admin, p1)).toBe(false);
  });
});
