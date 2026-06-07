/**
 * Phase Gate A — cross-task integration scenarios for the "agent authority"
 * feature. These exercise REAL HTTP (app.request) and the REAL folio_api TOOL
 * handler against a REAL migrated DB, asserting BOTH the response AND the
 * persisted state. They catch escalation paths that compose across tasks
 * A4/A6/A7/A8 — paths the per-task unit tests miss.
 *
 * Scenario coverage:
 *  - S1 (T4 privilege-borrow) — a library/operator run targeting B, triggered
 *    by a member of B only, cannot reach a THIRD workspace C. This is
 *    LOAD-BEARING (A8) and is fully covered by the loadContext unit tests in
 *    `runner.test.ts`:
 *      describe('loadContext: per-run effective-reach (A8 / T4)')
 *        · 'a library-agent run narrowed token reaches run.workspaceId, not
 *           __system (T4 + B5 preservation)'  — ctx.token.workspaceId === B
 *        · 'a forged third-workspace home still fails closed (T4 upstream
 *           guard)'                            — loadContext → null for C
 *      describe('loadContext: home-gated agent resolution (B1)')
 *        · 'REJECTS a run whose agent_home is a third workspace C'
 *    Because the narrowed run token's reach IS B (ctx.token.workspaceId === B),
 *    any resolver call the run makes against a THIRD workspace C goes through
 *    resolveWorkspace, which 403s a pinned (workspaceId=B) token on /c — the
 *    same gate S2's control case proves below via real HTTP. The run harness
 *    (scaffold + seedLibraryAgentWithSkills) is intentionally not re-scaffolded
 *    here; the unit coverage above is the canonical proof.
 *  - S2 (A4 + A7) — instance bearer crosses workspaces over real HTTP.   [HERE]
 *  - S3 (A6)      — secret + default-deny floor holds for a FULL-scope token via
 *                   the folio_api tool handler.                          [HERE]
 */

import { describe, expect, test } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, documents, projects, tables, workspaces } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { executeTool } from '../lib/agent-tools.ts';
import { registerRealTools } from '../lib/agent-tools-registry.ts';
import type { ApiToken } from '../db/schema.ts';
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';
import { makeTestApp } from '../test/harness.ts';

// folio_api / folio_api_get are registered via registerRealTools().
// Idempotent-guarded, so calling at module load is safe.
registerRealTools();

// ===========================================================================
// S2 — instance admin cross-workspace via real HTTP (A4 + A7)
// ===========================================================================
//
// SCENARIO: an instance bearer (workspaceId null = instance reach), created by a
//   user who is owner of acme but a NON-member of a second workspace B ('beta'),
//   reads AND writes documents in B over real HTTP. A CONTROL token pinned to
//   acme (workspaceId = acme) is 403'd on the same /beta read.
//   GIVEN: instance bearer scopes ['documents:read','documents:write',
//          'config:write']; B exists with a project+default Work Items table;
//          the bearer's creator has NO membership in B.
//   WHEN:  GET /api/v1/w/beta/p/<p>/documents and POST a work_item to it.
//   THEN:  GET → 200; POST → 201; the row persists in B (workspaceId = bId);
//          the acme-pinned control GET on /beta → 403 (resolveWorkspace gate).
// ===========================================================================

describe('S2: instance bearer crosses workspaces over real HTTP (A4 + A7)', () => {
  test('instance reach reads + writes B; acme-pinned control is 403 on B', async () => {
    const { app, db, seed } = await makeTestApp();

    // --- Seed workspace B ('beta') with a project + default table. seed.user is
    //     the instance owner but is deliberately NOT given a workspace_access
    //     grant to B (the post-tenancy equivalent of "not a member of B"). ---
    const bId = nanoid();
    await db.insert(workspaces).values({ id: bId, slug: 'beta', name: 'Beta' });
    const bProjectId = nanoid();
    await db
      .insert(projects)
      .values({ id: bProjectId, workspaceId: bId, slug: 'site', name: 'Site' });
    await seedProjectDefaults(db, bProjectId);

    // Sanity: the bearer's creator has no workspace_access grant to B.
    const bAccess = await db.query.workspaceAccess.findMany({
      where: (wa, { eq: e, and: a }) => a(e(wa.workspaceId, bId), e(wa.userId, seed.user.id)),
    });
    expect(bAccess.length).toBe(0);

    // --- Instance bearer: workspaceId null = instance reach. createdBy hydrates
    //     the user in attachToken so resolveWorkspace can run the reach bypass. ---
    const { token: instanceRaw, hash: instanceHash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: null,
      name: 'instance-admin',
      tokenHash: instanceHash,
      scopes: ['documents:read', 'documents:write', 'config:write'],
      createdBy: seed.user.id,
    });

    // --- Control: a token PINNED to acme. Must 403 on /beta. ---
    const { token: pinnedRaw, hash: pinnedHash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'acme-pinned',
      tokenHash: pinnedHash,
      scopes: ['documents:read', 'documents:write'],
      createdBy: seed.user.id,
    });

    const bDocsPath = '/api/v1/w/beta/p/site/documents';

    // WHEN: instance bearer GETs documents in B.
    const getRes = await app.request(bDocsPath, {
      headers: { Authorization: `Bearer ${instanceRaw}` },
    });
    // THEN: 200 (not 403) — instance reach bypasses the membership check (A4).
    expect(getRes.status).toBe(200);

    // WHEN: instance bearer WRITES a work_item to B.
    const postRes = await app.request(bDocsPath, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${instanceRaw}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'work_item', title: 'Cross-ws write' }),
    });
    // THEN: 201 created.
    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as { data: { id: string; slug: string } };
    expect(postBody.data.slug).toBe('cross-ws-write');

    // THEN: the row PERSISTS in B (workspaceId = bId) — assert DB state, not just
    //       the response. A 201 with nothing saved would be a bug.
    const persisted = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, bId), eq(documents.slug, 'cross-ws-write')),
    });
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.title).toBe('Cross-ws write');
    expect(persisted[0]!.workspaceId).toBe(bId);
    // And it landed in B, not acme.
    expect(persisted[0]!.workspaceId).not.toBe(seed.workspace.id);

    // CONTROL: the acme-pinned token is 403'd reading B (TM1 — pinned reach does
    //          NOT cross workspaces, even with the right scope).
    const controlRes = await app.request(bDocsPath, {
      headers: { Authorization: `Bearer ${pinnedRaw}` },
    });
    expect(controlRes.status).toBe(403);
  });
});

// ===========================================================================
// S3 — secret + default-deny floor holds for the MOST-privileged token (A6)
// ===========================================================================
//
// SCENARIO: a token with EVERY scope (and full callerScopes) still cannot, via
//   the folio_api tool, (a) create a token, (b) write an ai-key, or (c) hit an
//   unmapped write path. The floor is structural — privilege does not unlock it.
//   GIVEN: token scopes = every scope; callerScopes = same; unattended:false.
//   WHEN:  folio_api POST /tokens, PATCH /settings/<id>/ai-keys, POST an
//          unmapped /p/web/<future> route.
//   THEN:  each returns { refused: true } with the right reason; AND the DB
//          shows no new token row and no ai-key persisted.
// ===========================================================================

const FULL_SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'agents:write',
  'config:write',
  'settings:write',
  'members:write',
  'workspace:admin',
];

function fullScopeToken(over: Partial<ApiToken>): ApiToken {
  return {
    id: 'tok_full',
    workspaceId: '',
    name: 'full-scope',
    tokenHash: 'unused',
    scopes: FULL_SCOPES,
    agentId: null,
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    ...over,
  };
}

describe('S3: secret + default-deny floor holds for a full-scope token (A6)', () => {
  test('(a) folio_api POST /tokens is REFUSED even at full scope; no token row created', async () => {
    const { db, seed } = await makeTestApp();
    const tok = fullScopeToken({ workspaceId: seed.workspace.id, createdBy: seed.user.id });

    const tokensBefore = (await db.select().from(apiTokens)).length;

    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/tokens`,
        body: { name: 'minted-by-agent', scopes: ['documents:read'] },
      },
      undefined,
      { callerScopes: FULL_SCOPES, unattended: false },
    )) as { refused: boolean; reason: string };

    expect(out.refused).toBe(true);
    expect(out.reason).toMatch(/secret-class write/);

    // DB: no token row was created (refuse-with-plan, never dispatched).
    const tokensAfter = (await db.select().from(apiTokens)).length;
    expect(tokensAfter).toBe(tokensBefore);
  });

  test('(b) folio_api PATCH /settings/<id>/ai-keys is REFUSED; no ai-key persisted', async () => {
    const { db, seed } = await makeTestApp();
    const tok = fullScopeToken({ workspaceId: seed.workspace.id, createdBy: seed.user.id });

    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'PATCH',
        path: `/api/v1/w/${seed.workspace.slug}/settings/some-id/ai-keys`,
        body: { provider: 'anthropic', key: 'sk-should-never-land' },
      },
      undefined,
      { callerScopes: FULL_SCOPES, unattended: false },
    )) as { refused: boolean; reason: string };

    expect(out.refused).toBe(true);
    expect(out.reason).toMatch(/secret-class write/);

    // DB: the plaintext key must NOT appear in any ai_keys row. The table is
    // empty for a fresh workspace; assert no row at all surfaced.
    const aiKeys = await db.query.aiKeys.findMany();
    expect(aiKeys.length).toBe(0);
  });

  test('(c) folio_api POST to an UNMAPPED write path is REFUSED (default-deny, T5)', async () => {
    const { db, seed } = await makeTestApp();
    const tok = fullScopeToken({ workspaceId: seed.workspace.id, createdBy: seed.user.id });

    // Snapshot table count — the unmapped path must never dispatch a side effect.
    const tablesBefore = (await db.select().from(tables)).length;

    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/some-unmapped-future-route`,
        body: { anything: true },
      },
      undefined,
      { callerScopes: FULL_SCOPES, unattended: false },
    )) as { refused: boolean; reason: string };

    expect(out.refused).toBe(true);
    expect(out.reason).toMatch(/no scope mapping/);

    // DB: nothing was created on the unmapped path.
    const tablesAfter = (await db.select().from(tables)).length;
    expect(tablesAfter).toBe(tablesBefore);
  });

  test('instance-reach token row round-trips through the DB (isNull reach query)', async () => {
    // A focused guard that the A1 nullable column actually stores null and is
    // queryable as "instance reach" (the column the S2 bypass keys on).
    const { db, seed } = await makeTestApp();
    const { hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: null,
      name: 'reach-roundtrip',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });

    const instanceTokens = await db
      .select()
      .from(apiTokens)
      .where(and(isNull(apiTokens.workspaceId), eq(apiTokens.name, 'reach-roundtrip')));
    expect(instanceTokens.length).toBe(1);
    expect(instanceTokens[0]!.workspaceId).toBeNull();
  });
});
