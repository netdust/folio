import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { documents, memberships, projects, workspaces } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  bootstrapSystemWorkspace,
  isReservedSlug,
} from './system-workspace.ts';

describe('reserved slug (M2/M3)', () => {
  test('the system workspace slug is the reserved underscore-prefixed constant', () => {
    expect(SYSTEM_WORKSPACE_SLUG).toBe('__system');
    expect(isReservedSlug(SYSTEM_WORKSPACE_SLUG)).toBe(true);
  });
  test('any underscore-prefixed slug is reserved', () => {
    expect(isReservedSlug('__anything')).toBe(true);
    expect(isReservedSlug('_x')).toBe(true);
  });
  test('normal slugs are not reserved', () => {
    expect(isReservedSlug('acme')).toBe(false);
    expect(isReservedSlug('web-2')).toBe(false);
    expect(isReservedSlug('')).toBe(false);
  });
});

describe('bootstrapSystemWorkspace (M4/M8)', () => {
  test('bootstrap creates __system + Skills/Reference projects + skill/ref content (M8)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    expect(sys).toBeDefined();
    const projs = await db.query.projects.findMany({
      where: eq(projects.workspaceId, sys!.id),
    });
    expect(projs.map((p) => p.slug).sort()).toEqual(['reference', 'skills']);
    const skill = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, sys!.id),
        eq(documents.type, 'page'),
        eq(documents.title, 'folio'),
      ),
    });
    expect(skill).toBeDefined();
    // the OPERATOR AGENT is NOT seeded by bootstrap (needs a user actor) — seeded by ensureOperatorAgent (Task 5)
    const operator = await db.query.documents.findFirst({
      where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')),
    });
    expect(operator).toBeUndefined();
  });

  test('bootstrap is idempotent — running twice yields one of each (M8)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    await bootstrapSystemWorkspace(db);
    const sys = await db.query.workspaces.findMany({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    expect(sys.length).toBe(1);
    const projs = await db.query.projects.findMany({
      where: eq(projects.workspaceId, sys[0]!.id),
    });
    expect(projs.length).toBe(2);
    const skillDocs = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, sys[0]!.id), eq(documents.title, 'folio')),
    });
    expect(skillDocs.length).toBe(1);
  });

  test('bootstrap FAILS LOUD on a pre-existing __system that carries ANY membership (M4)', async () => {
    const { db, seed } = await makeTestApp();
    const foreignId = nanoid();
    await db.insert(workspaces).values({
      id: foreignId,
      slug: SYSTEM_WORKSPACE_SLUG,
      name: 'Hijack',
    });
    await db.insert(memberships).values({
      workspaceId: foreignId,
      userId: seed.user.id,
      role: 'owner',
    });
    await expect(bootstrapSystemWorkspace(db)).rejects.toThrow(
      /SYSTEM_WORKSPACE_TAINTED|membership/i,
    );
  });

  test('bootstrap ACCEPTS a clean member-less __system on re-run (M4/M8)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db); // creates it, no membership
    await expect(bootstrapSystemWorkspace(db)).resolves.toBeUndefined(); // clean, no throw
  });
});
