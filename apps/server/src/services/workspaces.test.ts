import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeBareTestDb } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';
import { listWorkspaces } from './workspaces.ts';

async function mkUser(db: any, email: string, role: 'owner' | 'admin' | 'member') {
  const id = nanoid();
  await db.insert(schema.users).values({ id, email, name: email, role });
  return id;
}

describe('listWorkspaces (post-tenancy access model)', () => {
  test('owner sees ALL workspaces minus __system; role is the instance role on every row', async () => {
    const { db } = await makeBareTestDb();
    const owner = await mkUser(db, 'o@t', 'owner');

    const wsA = nanoid();
    const wsB = nanoid();
    const sys = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    await db.insert(schema.workspaces).values({ id: wsB, slug: 'b', name: 'B' });
    await db
      .insert(schema.workspaces)
      .values({ id: sys, slug: SYSTEM_WORKSPACE_SLUG, name: 'System' });

    const rows = await listWorkspaces(owner);
    const slugs = rows.map((r) => r.workspace.slug).sort();
    expect(slugs).toEqual(['a', 'b']); // both real ones, __system excluded
    // role is the INSTANCE role, identical on every row
    expect(rows.every((r) => r.role === 'owner')).toBe(true);
  });

  test('member with a ws grant to A but not B sees only A', async () => {
    const { db } = await makeBareTestDb();
    const member = await mkUser(db, 'm@t', 'member');

    const wsA = nanoid();
    const wsB = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    await db.insert(schema.workspaces).values({ id: wsB, slug: 'b', name: 'B' });

    await db.insert(schema.workspaceAccess).values({ userId: member, workspaceId: wsA });

    const rows = await listWorkspaces(member);
    expect(rows.map((r) => r.workspace.slug)).toEqual(['a']);
    expect(rows[0]?.role).toBe('member'); // instance role
  });

  test('project-only member (grant to a project in C, no ws grant) sees C via traverse', async () => {
    const { db } = await makeBareTestDb();
    const projUser = await mkUser(db, 'p@t', 'member');

    const wsC = nanoid();
    await db.insert(schema.workspaces).values({ id: wsC, slug: 'c', name: 'C' });
    const p1 = nanoid();
    await db.insert(schema.projects).values({ id: p1, workspaceId: wsC, slug: 'p1', name: 'P1' });

    // grant ONLY to the project — no workspace_access row
    await db.insert(schema.projectAccess).values({ userId: projUser, projectId: p1 });

    const rows = await listWorkspaces(projUser);
    expect(rows.map((r) => r.workspace.slug)).toEqual(['c']);
  });

  test('__system never appears even when the member has a __system grant', async () => {
    const { db } = await makeBareTestDb();
    const member = await mkUser(db, 'm@t', 'member');

    const sys = nanoid();
    const wsA = nanoid();
    await db
      .insert(schema.workspaces)
      .values({ id: sys, slug: SYSTEM_WORKSPACE_SLUG, name: 'System' });
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    // grant to BOTH __system and A
    await db.insert(schema.workspaceAccess).values({ userId: member, workspaceId: sys });
    await db.insert(schema.workspaceAccess).values({ userId: member, workspaceId: wsA });

    const rows = await listWorkspaces(member);
    expect(rows.some((r) => r.workspace.slug === SYSTEM_WORKSPACE_SLUG)).toBe(false);
    expect(rows.map((r) => r.workspace.slug)).toEqual(['a']);
  });

  test('owner also never sees __system (owner-branch exclusion)', async () => {
    const { db } = await makeBareTestDb();
    const owner = await mkUser(db, 'o@t', 'owner');
    const sys = nanoid();
    await db
      .insert(schema.workspaces)
      .values({ id: sys, slug: SYSTEM_WORKSPACE_SLUG, name: 'System' });
    const rows = await listWorkspaces(owner);
    expect(rows.some((r) => r.workspace.slug === SYSTEM_WORKSPACE_SLUG)).toBe(false);
  });

  test('member with no grants at all sees nothing', async () => {
    const { db } = await makeBareTestDb();
    const stranger = await mkUser(db, 's@t', 'member');
    const wsA = nanoid();
    await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const rows = await listWorkspaces(stranger);
    expect(rows).toEqual([]);
  });
});
