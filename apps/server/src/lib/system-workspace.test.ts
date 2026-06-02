import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, documents, memberships, projects, users, workspaces } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { hashPassword } from './auth.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  bootstrapSystemWorkspace,
  designateInstanceOwner,
  ensureOperatorAgent,
  grantOwner,
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

describe('grantOwner + ensureOperatorAgent + designateInstanceOwner (M5/M8)', () => {
  test('grantOwner grants __system owner to an existing user, first-wins idempotent (M5)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const a = nanoid();
    const b = nanoid();
    await db
      .insert(users)
      .values({ id: a, email: 'a@x.com', name: 'A', passwordHash: await hashPassword('password123') });
    await db
      .insert(users)
      .values({ id: b, email: 'b@x.com', name: 'B', passwordHash: await hashPassword('password123') });
    await grantOwner(db, 'a@x.com');
    await grantOwner(db, 'a@x.com'); // re-run same: still one
    await grantOwner(db, 'b@x.com'); // different user: must NOT replace a
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const owners = await db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')),
    });
    expect(owners.length).toBe(1);
    expect(owners[0]!.userId).toBe(a); // first-wins
  });

  test('grantOwner throws a clear error for an unknown email (M5)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // Assert on the error CODE (convention-correct), not the message wording.
    await expect(grantOwner(db, 'nobody@x.com')).rejects.toMatchObject({
      code: 'INSTANCE_OWNER_NOT_FOUND',
    });
  });

  test('ensureOperatorAgent seeds the operator (with a user actor) idempotently (M8)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const uid = nanoid();
    await db
      .insert(users)
      .values({ id: uid, email: 'o@x.com', name: 'O', passwordHash: await hashPassword('password123') });
    await ensureOperatorAgent(db, uid);
    await ensureOperatorAgent(db, uid); // re-run: still ONE agent + ONE token
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const agents = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')),
    });
    expect(agents.length).toBe(1);
    expect((agents[0]!.frontmatter as { provider?: string }).provider).toBe('anthropic');
    const toks = await db.query.apiTokens.findMany({
      where: eq(apiTokens.agentId, agents[0]!.id),
    });
    expect(toks.length).toBe(1);
  });

  test('a failed agent seed is RECOVERED on the next designate run (fix #2)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const uid = nanoid();
    await db
      .insert(users)
      .values({ id: uid, email: 'r@x.com', name: 'R', passwordHash: await hashPassword('password123') });
    await grantOwner(db, 'r@x.com'); // owner inserted, agent NOT yet
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    let agent = await db.query.documents.findFirst({
      where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')),
    });
    expect(agent).toBeUndefined();
    await designateInstanceOwner(db, 'r@x.com'); // re-run repairs: grantOwner no-ops, ensureOperatorAgent seeds
    agent = await db.query.documents.findFirst({
      where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')),
    });
    expect(agent).toBeDefined();
  });
});
