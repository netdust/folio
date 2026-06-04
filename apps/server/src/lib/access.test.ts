import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import {
  canSeeWorkspace,
  canSeeProject,
  userRole,
  hasWorkspaceAccess,
  hasProjectAccess,
  visibleProjectIds,
} from './access.ts';

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

describe('visibleProjectIds (CR-10 — the batched visible-set convergence helper)', () => {
  // Contract: the set of project ids IN this workspace the user holds a DIRECT
  // project_access grant to — exactly what the per-item canSeeProject loop
  // computed for a non-whole-ws caller, in ONE query. It deliberately does NOT
  // short-circuit owner / ws-grant (whole-ws callers): each caller handles the
  // whole-ws branch differently (events → null/unrestricted, listProjects →
  // all rows, agent-runs → null reach), so the whole-ws decision stays with the
  // caller via canManageWorkspace. This helper answers only "which projects in
  // this ws does this user have a direct grant to".
  test('returns exactly the user\'s directly-granted project ids in the workspace', async () => {
    const { db } = await makeBareTestDb();
    const projUser = await mkUser(db, 'p@t', 'member');
    const stranger = await mkUser(db, 's@t', 'member');

    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const wsB = nanoid();
    await db.insert(schema.workspaces).values({ id: wsB, slug: 'b', name: 'B' });
    const a1 = nanoid();
    await db.insert(schema.projects).values({ id: a1, workspaceId: wsA, slug: 'a1', name: 'A1' });
    const a2 = nanoid();
    await db.insert(schema.projects).values({ id: a2, workspaceId: wsA, slug: 'a2', name: 'A2' });
    const b1 = nanoid();
    await db.insert(schema.projects).values({ id: b1, workspaceId: wsB, slug: 'b1', name: 'B1' });

    // projUser: direct grant to a1 (in wsA) and b1 (in wsB).
    await db.insert(schema.projectAccess).values({ userId: projUser, projectId: a1 });
    await db.insert(schema.projectAccess).values({ userId: projUser, projectId: b1 });

    const visA = await visibleProjectIds(db, projUser, wsA);
    expect([...visA].sort()).toEqual([a1]); // only a1 — NOT a2 (no grant), NOT b1 (other ws)
    const visB = await visibleProjectIds(db, projUser, wsB);
    expect([...visB].sort()).toEqual([b1]); // scoped per workspace

    // stranger: no grants → empty set
    expect((await visibleProjectIds(db, stranger, wsA)).size).toBe(0);
  });

  test('result matches the per-item canSeeProject loop it replaces (non-whole-ws caller)', async () => {
    const { db } = await makeBareTestDb();
    const u = await mkUser(db, 'u@t', 'member');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const granted: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = nanoid();
      await db.insert(schema.projects).values({ id, workspaceId: wsA, slug: `p${i}`, name: `P${i}` });
      // grant 2 of the 4 (the odd indices)
      if (i % 2 === 1) {
        await db.insert(schema.projectAccess).values({ userId: u, projectId: id });
        granted.push(id);
      }
    }

    // The old loop: filter all ws projects through canSeeProject.
    const all = await db.query.projects.findMany({ where: eq(schema.projects.workspaceId, wsA) });
    const loopResult = new Set<string>();
    for (const p of all) {
      if (await canSeeProject(db, u, p.id)) loopResult.add(p.id);
    }
    const helperResult = await visibleProjectIds(db, u, wsA);
    expect([...helperResult].sort()).toEqual([...loopResult].sort());
  });
});
