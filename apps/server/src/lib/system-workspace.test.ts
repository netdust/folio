import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, documents, memberships, projects, users, workspaces } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { roleToScopes } from './agent-schema.ts';
import { hashPassword } from './auth.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  bootstrapSystemWorkspace,
  designateInstanceOwner,
  ensureOperatorAgent,
  findSystemOwnerId,
  getSystemWorkspaceId,
  grantOwner,
  isReservedSlug,
  runBootTasks,
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

  test('bootstrap FAILS LOUD on a pre-existing __system with a NON-owner membership (M4)', async () => {
    const { db, seed } = await makeTestApp();
    const foreignId = nanoid();
    await db.insert(workspaces).values({
      id: foreignId,
      slug: SYSTEM_WORKSPACE_SLUG,
      name: 'Hijack',
    });
    // A 'member'-role membership is never legitimate on __system → tainted.
    await db.insert(memberships).values({
      workspaceId: foreignId,
      userId: seed.user.id,
      role: 'member',
    });
    await expect(bootstrapSystemWorkspace(db)).rejects.toThrow(
      /SYSTEM_WORKSPACE_TAINTED|membership/i,
    );
  });

  test('bootstrap FAILS LOUD on a pre-existing __system with MORE THAN ONE membership (M4)', async () => {
    const { db, seed } = await makeTestApp();
    const foreignId = nanoid();
    await db.insert(workspaces).values({
      id: foreignId,
      slug: SYSTEM_WORKSPACE_SLUG,
      name: 'Hijack',
    });
    const other = nanoid();
    await db.insert(users).values({
      id: other,
      email: 'other@x.com',
      name: 'Other',
      passwordHash: await hashPassword('password123'),
    });
    // Two memberships (even if both owner-ish) is never the legitimate shape
    // (exactly one owner) → tainted.
    await db.insert(memberships).values({ workspaceId: foreignId, userId: seed.user.id, role: 'owner' });
    await db.insert(memberships).values({ workspaceId: foreignId, userId: other, role: 'owner' });
    await expect(bootstrapSystemWorkspace(db)).rejects.toThrow(
      /SYSTEM_WORKSPACE_TAINTED|membership/i,
    );
  });

  test('bootstrap ACCEPTS a clean member-less __system on re-run (M4/M8)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db); // creates it, no membership
    await expect(bootstrapSystemWorkspace(db)).resolves.toBeUndefined(); // clean, no throw
  });

  test('bootstrap ACCEPTS a __system carrying its single legitimate owner — idempotent across restarts (M4/M8, review fix #1)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const uid = nanoid();
    await db.insert(users).values({
      id: uid,
      email: 'owner@x.com',
      name: 'Owner',
      passwordHash: await hashPassword('password123'),
    });
    await designateInstanceOwner(db, 'owner@x.com'); // grants the single owner + seeds the agent
    // A SUBSEQUENT boot must NOT throw TAINTED on its own legitimate owner.
    await expect(bootstrapSystemWorkspace(db)).resolves.toBeUndefined();
    // And re-designating is still idempotent (one owner, one agent).
    await expect(designateInstanceOwner(db, 'owner@x.com')).resolves.toBeUndefined();
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const owners = await db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')),
    });
    expect(owners.length).toBe(1);
    const agents = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')),
    });
    expect(agents.length).toBe(1);
  });
});

describe('B4: seeded folio skill is blessed', () => {
  test('seeded folio skill carries trusted:true + description + when_to_use', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const skillsProject = await db.query.projects.findFirst({
      where: and(eq(projects.workspaceId, sys!.id), eq(projects.slug, 'skills')),
    });
    const folio = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, sys!.id),
        eq(documents.projectId, skillsProject!.id),
        eq(documents.title, 'folio'),
      ),
    });
    expect(folio).toBeDefined();
    const fm = folio!.frontmatter as {
      trusted?: unknown;
      description?: unknown;
      when_to_use?: unknown;
    };
    expect(fm.trusted).toBe(true);
    expect(typeof fm.description).toBe('string');
    expect((fm.description as string).length).toBeGreaterThan(0);
    expect(typeof fm.when_to_use).toBe('string');
    expect((fm.when_to_use as string).length).toBeGreaterThan(0);
  });

  test('the setup-project-ref page still has empty frontmatter (the default arg, not blessed)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const ref = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, sys!.id),
        eq(documents.type, 'page'),
        eq(documents.title, 'Set up a project'),
      ),
    });
    expect(ref).toBeDefined();
    const fm = ref!.frontmatter as Record<string, unknown>;
    expect('trusted' in fm).toBe(false);
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

  test('grantOwner returns the resolved owner userId (review fix #8)', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const a = nanoid();
    await db
      .insert(users)
      .values({ id: a, email: 'a@x.com', name: 'A', passwordHash: await hashPassword('password123') });
    expect(await grantOwner(db, 'a@x.com')).toBe(a); // granted now
    expect(await grantOwner(db, 'a@x.com')).toBe(a); // first-wins no-op returns the same id
  });

  test('concurrent designateInstanceOwner yields exactly ONE owner + ONE agent (review fix #5 — race)', async () => {
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
    // Two simultaneous first-user designations (different emails). The
    // transactional first-wins guard in grantOwner must prevent two owner rows.
    await Promise.all([
      designateInstanceOwner(db, 'a@x.com'),
      designateInstanceOwner(db, 'b@x.com'),
    ]);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    const owners = await db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')),
    });
    expect(owners.length).toBe(1); // NOT two instance admins
    const agents = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')),
    });
    expect(agents.length).toBe(1); // NOT two operator agents
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
    // The operator carries ai_key_label so the runner resolves its instance key
    // by (provider, label). Seed default is 'default'; UI-editable post-seed.
    expect((agents[0]!.frontmatter as { ai_key_label?: string }).ai_key_label).toBe('default');
    // Phase B: the operator declares its `folio` skill in frontmatter (the runner
    // materializes it at load via loadAgentDefinition, not a runtime get_document).
    expect((agents[0]!.frontmatter as { skills?: string[] }).skills).toEqual(['folio']);
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

describe('A9: operator instance token (T8 origin, T3 carve-out)', () => {
  async function seedOwnerAndDesignate(db: Awaited<ReturnType<typeof makeTestApp>>['db']) {
    await bootstrapSystemWorkspace(db);
    const uid = nanoid();
    await db.insert(users).values({
      id: uid,
      email: 'op-owner@x.com',
      name: 'OpOwner',
      passwordHash: await hashPassword('password123'),
    });
    await designateInstanceOwner(db, 'op-owner@x.com');
    return uid;
  }

  async function findOperatorAndToken(
    db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  ) {
    const systemId = await getSystemWorkspaceId(db);
    const operator = await db.query.documents.findFirst({
      where: and(eq(documents.workspaceId, systemId), eq(documents.type, 'agent')),
    });
    expect(operator).toBeDefined();
    const token = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.agentId, operator!.id),
    });
    expect(token).toBeDefined();
    return { operator: operator!, token: token! };
  }

  test('operator token is provisioned instance-wide with system origin', async () => {
    const { db } = await makeTestApp();
    await seedOwnerAndDesignate(db);
    const { operator, token } = await findOperatorAndToken(db);
    // Instance reach (T8) + unforgeable system-origin marker:
    expect(token.workspaceId).toBeNull();
    expect(token.createdBy).toBeNull();
    // T3 carve-out: agentId is KEPT (runner loads the operator token by agentId).
    expect(token.agentId).toBe(operator.id);
    // Full owner scopes.
    const owner = roleToScopes('owner');
    expect(owner.every((s) => token.scopes.includes(s))).toBe(true);
  });

  test('operator token is NOT mintable via POST /tokens (system origin is code-only)', async () => {
    const { db } = await makeTestApp();
    await seedOwnerAndDesignate(db);
    // T8: createdBy:null is an unforgeable marker — POST /tokens (A7) always
    // stamps a human createdBy, so a createdBy:null token can only arise from
    // code provisioning. Exactly the operator carries it.
    const allTokens = await db.query.apiTokens.findMany();
    const systemOrigin = allTokens.filter((t) => t.createdBy === null);
    expect(systemOrigin.length).toBe(1);
    const { operator } = await findOperatorAndToken(db);
    expect(systemOrigin[0]!.agentId).toBe(operator.id);
    expect(systemOrigin[0]!.workspaceId).toBeNull();
  });

  test('re-running ensureOperatorAgent is idempotent and keeps the instance token', async () => {
    const { db } = await makeTestApp();
    const ownerUserId = await seedOwnerAndDesignate(db);
    await ensureOperatorAgent(db, ownerUserId); // re-run
    const systemId = await getSystemWorkspaceId(db);
    const agents = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, systemId), eq(documents.type, 'agent')),
    });
    expect(agents.length).toBe(1); // still exactly one operator
    const { operator, token } = await findOperatorAndToken(db);
    expect(token.workspaceId).toBeNull();
    expect(token.createdBy).toBeNull();
    expect(token.agentId).toBe(operator.id);
  });

  // CR#9 — ensureOperatorToken skips the UPDATE when the token is ALREADY in
  // system-origin instance form. The observable contract is: a double-designate
  // leaves the token byte-for-byte unchanged (workspaceId null, createdBy null,
  // owner scopes, agentId kept). We assert correctness-after-double-call AND
  // capture the full row before/after to prove the "no needless write" path
  // didn't mutate anything.
  test('CR#9: a second ensureOperatorAgent leaves the already-provisioned token unchanged', async () => {
    const { db } = await makeTestApp();
    const ownerUserId = await seedOwnerAndDesignate(db);
    // First designate already provisioned the token into system-origin form.
    const before = await findOperatorAndToken(db);
    // Sanity: it IS already in the provisioned shape (so the early-return fires).
    expect(before.token.workspaceId).toBeNull();
    expect(before.token.createdBy).toBeNull();
    const ownerScopes = roleToScopes('owner');
    expect(ownerScopes.every((s) => before.token.scopes.includes(s))).toBe(true);

    // Re-run: ensureOperatorToken should hit the alreadyProvisioned early-return.
    await ensureOperatorAgent(db, ownerUserId);

    const after = await findOperatorAndToken(db);
    // Same row (matched by agentId), still correct + unchanged.
    expect(after.token.id).toBe(before.token.id);
    expect(after.token.workspaceId).toBeNull();
    expect(after.token.createdBy).toBeNull();
    expect(after.token.agentId).toBe(after.operator.id);
    expect(after.token.scopes.sort()).toEqual(before.token.scopes.sort());
    // Full-row equality: the idempotent path mutated NOTHING.
    expect(after.token).toEqual(before.token);
  });
});

describe('getSystemWorkspaceId (Phase B B2 — cross-workspace resolution)', () => {
  test('returns the bootstrapped __system id', async () => {
    const { db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const id = await getSystemWorkspaceId(db);
    const sys = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
    expect(id).toBe(sys!.id);
  });

  test('throws SYSTEM_WORKSPACE_MISSING before bootstrap', async () => {
    const { db } = await makeTestApp();
    await expect(getSystemWorkspaceId(db)).rejects.toThrow(
      /SYSTEM_WORKSPACE_MISSING|__system/,
    );
  });
});

describe('runBootTasks (M4/M5/M8 boot wiring)', () => {
  test('runBootTasks creates __system and designates the env owner (M4/M5)', async () => {
    const { db } = await makeTestApp();
    const uid = nanoid();
    await db.insert(users).values({ id: uid, email: 'env-owner@x.com', name: 'EO', passwordHash: await hashPassword('password123') });
    await runBootTasks(db, { FOLIO_INSTANCE_OWNER: 'env-owner@x.com' });
    const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
    expect(sys).toBeDefined();
    const owner = await db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
    expect(owner!.userId).toBe(uid);
    // operator agent seeded too (designate calls ensureOperatorAgent)
    const agent = await db.query.documents.findFirst({ where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')) });
    expect(agent).toBeDefined();
  });

  test('runBootTasks bootstraps __system but skips designation when no owner env is set (M8)', async () => {
    const { db } = await makeTestApp();
    await runBootTasks(db, { FOLIO_INSTANCE_OWNER: undefined });
    const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
    expect(sys).toBeDefined();
    // no owner, no agent (designation didn't run)
    const owner = await db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
    expect(owner).toBeUndefined();
  });

  test('runBootTasks does NOT crash when FOLIO_INSTANCE_OWNER points to a missing user (M5)', async () => {
    const { db } = await makeTestApp();
    await expect(runBootTasks(db, { FOLIO_INSTANCE_OWNER: 'nobody@x.com' })).resolves.toBeUndefined();
    const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
    expect(sys).toBeDefined(); // bootstrap still happened
    const owner = await db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
    expect(owner).toBeUndefined(); // no owner granted (user absent), but no crash
  });
});
