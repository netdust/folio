import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { apiTokens } from '../db/schema.ts';
import { createSession } from '../lib/auth.ts';
import { roleToScopes } from '../lib/agent-schema.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * §8.1 — Token-reach boundary (regression pin).
 *
 * Post-tenancy (one instance = one team), a token-scope leak no longer fails
 * loudly: a widened ceiling looks like a teammate's data, not a stranger's. This
 * suite PINS the boundary that, if it ever silently widens, would otherwise go
 * unnoticed — a `member`-minted token MUST NOT carry authority beyond what
 * `roleToScopes('member')` grants.
 *
 * The behavior already holds (Phase-2 token-ceiling work in tokens.ts: the mint
 * route clamps requested scopes to `roleToScopes(userRole(caller))`). These
 * tests change NO production code — they assert that contract so a future edit
 * can't regress it silently. If any assertion FAILS, the ceiling regressed and
 * that is a real finding, not a test to relax.
 *
 * The boundary has two facets, both pinned here:
 *   1. SCOPE ceiling — a member cannot mint a token carrying owner-only scopes
 *      (config:write / agents:write / documents:delete / settings:write / …).
 *   2. ROLE-sensitivity — the gate is not a blanket deny: an owner CAN mint the
 *      same config:write token, proving the clamp keys off the caller's role.
 *
 * Unlike the sibling tests in tokens.test.ts (which rely on the default
 * `users.role`), this suite sets `users.role` EXPLICITLY on each seeded caller,
 * so the pin survives even if the harness or seedMemberSession default changes.
 */

const tokensPath = (wslug: string, workspaceId: string) =>
  `/api/v1/w/${wslug}/tokens/${workspaceId}`;

/**
 * Seed a fresh user with an EXPLICIT instance role + a workspace_access grant to
 * the given workspace (so resolveWorkspace lets them reach the mint route, and
 * canSeeWorkspace(:workspaceId) passes — isolating the SCOPE ceiling as the
 * operative gate). Returns a session cookie.
 */
async function seedUserWithRole(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<string> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: role,
    role, // instance role — the ceiling source (users.role)
  });
  await db.insert(schema.workspaceAccess).values({ userId, workspaceId });
  const session = await createSession(userId);
  return `folio_session=${session.id}`;
}

describe('§8.1 token-reach boundary: a member-minted token cannot exceed the member ceiling', () => {
  // Sanity: lock the assumption these tests rest on — the member ceiling is
  // read+write only. If roleToScopes('member') ever widens, this fails first and
  // tells you the boundary moved (rather than a confusing 201 downstream).
  test('roleToScopes(member) is documents:read + documents:write only', () => {
    expect(roleToScopes('member').sort()).toEqual(['documents:read', 'documents:write']);
  });

  test('a member CAN mint a token within ceiling (documents:read + documents:write → 201)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedUserWithRole(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'within-ceiling', scopes: ['documents:read', 'documents:write'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.scopes.sort()).toEqual(['documents:read', 'documents:write']);
  });

  test('a member CANNOT mint a token carrying config:write (403 FORBIDDEN_SCOPE, nothing minted)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedUserWithRole(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'escalate', scopes: ['documents:read', 'config:write'] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
    // The escalation produced NO token at all (fail-closed, not a partial mint).
    const rows = await db.query.apiTokens.findMany({
      where: eq(apiTokens.workspaceId, seed.workspace.id),
    });
    expect(rows.length).toBe(0);
  });

  // Every owner-only scope the ceiling withholds from a member, asserted as a
  // set so adding a future owner-only scope without gating it fails here.
  test.each(['agents:write', 'documents:delete', 'settings:write', 'members:write', 'workspace:admin'])(
    'a member CANNOT mint a token carrying %s (403 FORBIDDEN_SCOPE)',
    async (scope) => {
      const { app, db, seed } = await makeTestApp();
      const memberCookie = await seedUserWithRole(db, seed.workspace.id, 'member');
      const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'escalate', scopes: [scope] }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
      const rows = await db.query.apiTokens.findMany({
        where: eq(apiTokens.workspaceId, seed.workspace.id),
      });
      expect(rows.length).toBe(0);
    },
  );

  // Role-sensitivity: the same config:write request an owner makes succeeds —
  // proving the gate clamps to the CALLER'S role, not a blanket member-style deny.
  test('an owner CAN mint the same config:write token (201) — the gate is role-sensitive, not a blanket deny', async () => {
    const { app, db, seed } = await makeTestApp();
    const ownerCookie = await seedUserWithRole(db, seed.workspace.id, 'owner');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'owner-config', scopes: ['documents:read', 'config:write'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.scopes).toContain('config:write');
  });

  // Reach facet: a member-minted token cannot be pinned to a workspace the
  // member cannot SEE. The mint route gates on canSeeWorkspace(:workspaceId);
  // pointing :workspaceId at a workspace the member has no grant to → 403, and
  // nothing is minted against that workspace.
  test('a member CANNOT mint a token reaching a workspace they cannot see (403, nothing minted)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedUserWithRole(db, seed.workspace.id, 'member');
    // A second workspace the member has NO access to.
    const unseenId = nanoid();
    await db.insert(schema.workspaces).values({
      id: unseenId,
      slug: `unseen-${unseenId}`,
      name: 'Unseen',
    });
    // :wslug points at acme (member can see it → resolveWorkspace passes), but
    // :workspaceId targets the unseen workspace → the handler's canSeeWorkspace
    // guard is the operative gate.
    const res = await app.request(tokensPath(seed.workspace.slug, unseenId), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'reach-pwn', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    const rows = await db.query.apiTokens.findMany({
      where: eq(apiTokens.workspaceId, unseenId),
    });
    expect(rows.length).toBe(0);
  });
});
