import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { apiTokens } from '../db/schema.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { bootstrapSystemWorkspace, getSystemWorkspaceId } from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * Seed a second user with the given workspace role and return a session cookie
 * for them. Used to prove the token-mint scope ceiling: a member must not be
 * able to mint a token carrying owner-only scopes (config:write / agents:write
 * / documents:delete) — the same roleToScopes ceiling the runner enforces.
 */
async function seedMemberSession(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<string> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: role,
  });
  await db.insert(schema.memberships).values({ workspaceId, userId, role });
  const session = await createSession(userId);
  return `folio_session=${session.id}`;
}

// POST /api/v1/w/:wslug/tokens/:workspaceId
// DELETE /api/v1/w/:wslug/tokens/:workspaceId/:tokenId
//
// B round 5 #1, #2 — tokens.ts POST + DELETE are session-only. A stolen
// workspace Bearer must not be able to mint a higher-scope replacement
// (POST) or revoke peer Bearers (DELETE). Threat model mitigation 11.

describe('tokens.ts requireSession gate (threat model mitigation 11)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('POST /tokens rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'origin',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'pwn', scopes: ['documents:write'] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('POST /tokens rejects bearer + garbage cookie with 403 (symmetry with ai.ts)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'cookie-bypass',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    for (const garbageCookie of [
      'folio_session=garbage',
      'folio_session=',
      'folio_session=expired-id',
    ]) {
      const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: garbageCookie,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'pwn', scopes: ['documents:write'] }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    }
  });

  test('DELETE /tokens/:tokenId rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // Mint a peer token to attempt revoking.
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: seed.workspace.id,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    // Mint the attacker token used for the bearer.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'attacker',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, seed.workspace.id)}/${peerId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('DELETE /tokens/:tokenId rejects bearer + garbage cookie with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: seed.workspace.id,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'attacker',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, seed.workspace.id)}/${peerId}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: 'folio_session=garbage',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // Happy path — session caller can still POST + DELETE.
  test('POST /tokens succeeds for a session caller', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: {
        Cookie: seed.sessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'ci', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.name).toBe('ci');
  });
});

// The mint endpoint must obey the SAME role→scope ceiling (roleToScopes) that
// the runner enforces at execution time. Without this, a member-tier user mints
// a token carrying owner-only scopes (config:write etc.) and uses it directly
// against the config routes — bypassing the entire agent∩caller ceiling at the
// one place a human creates raw authority.
describe('tokens.ts POST scope ceiling (no minting above your role)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('a member CANNOT mint a token carrying config:write (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'escalate', scopes: ['documents:read', 'config:write'] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN_SCOPE');
    // Nothing was minted.
    const rows = await db.query.apiTokens.findMany({
      where: eq(apiTokens.workspaceId, seed.workspace.id),
    });
    expect(rows.length).toBe(0);
  });

  test('a member CANNOT mint agents:write or documents:delete either (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    for (const scope of ['agents:write', 'documents:delete']) {
      const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'escalate', scopes: [scope] }),
      });
      expect(res.status).toBe(403);
    }
  });

  test('a member CAN mint a token within their ceiling (documents:read/write) (201)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'member-ci', scopes: ['documents:read', 'documents:write'] }),
    });
    expect(res.status).toBe(201);
  });

  test('an owner CAN mint a token carrying config:write (201) — ceiling does not over-block', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'owner-config', scopes: ['documents:read', 'config:write'] }),
    });
    expect(res.status).toBe(201);
  });
});

// A7 — instance reach gate. api_tokens.workspace_id is nullable (null = instance
// reach). Only an instance admin (owner/admin of __system) may mint a reach=null
// token (T1). A normal mint pins to the URL workspace (back-compat). Reach is
// immutable — there is no route that mutates an existing token's workspace_id (T2).
describe('tokens.ts A7 instance reach gate (T1/T2)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('instance-admin (owner of __system) mints a reach=null token', async () => {
    const { app, db } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const systemId = await getSystemWorkspaceId(db);
    // Make a NEW user U an owner of __system.
    const userId = nanoid();
    await db.insert(schema.users).values({
      id: userId,
      email: `${userId}@test.local`,
      name: 'inst-admin',
    });
    await db.insert(schema.memberships).values({
      workspaceId: systemId,
      userId,
      role: 'owner',
    });
    const session = await createSession(userId);
    const cookie = `folio_session=${session.id}`;

    const res = await app.request(tokensPath('__system', systemId), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'inst', scopes: ['documents:read'], workspaceId: null }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.instance).toBe(true);

    const row = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, body.data.id),
    });
    expect(row).toBeDefined();
    expect(row?.workspaceId).toBeNull();
  });

  test('a non-admin (member, not __system owner) requesting workspaceId:null → 403', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // A member of acme who is NOT a __system member.
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath('acme', seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['documents:read'], workspaceId: null }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    // No instance-reach token was minted.
    const rows = await db.query.apiTokens.findMany();
    expect(rows.filter((r) => r.workspaceId === null).length).toBe(0);
  });

  test('omitting workspaceId pins to the URL workspace (back-compat)', async () => {
    const { app, db, seed } = await makeTestApp();
    const res = await app.request(tokensPath('acme', seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pinned', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const row = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, body.data.id),
    });
    expect(row?.workspaceId).toBe(seed.workspace.id);
  });

  test('reach is immutable — no PATCH route (T2)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`${tokensPath('acme', seed.workspace.id)}/sometoken`, {
      method: 'PATCH',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: null }),
    });
    expect([404, 405].includes(res.status)).toBe(true);
  });
});
