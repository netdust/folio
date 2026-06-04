import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { apiTokens, users, workspaceAccess } from '../db/schema.ts';
import { env } from '../env.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * Seed a SECOND user with the default instance role `member` and a
 * workspace_access grant on the seed workspace, then return a session cookie
 * for them. Such a user passes the wScope visibility gate (the grant) but is
 * NOT an instance owner/admin — the exact principal the AI-key write gate must
 * reject (post-tenancy: role lives on users.role, not a membership row).
 */
async function seedMemberSession(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
): Promise<{ cookie: string; userId: string }> {
  const id = nanoid();
  // No explicit role → defaults to 'member' (users.role default).
  await db.insert(users).values({ id, email: `member-${id}@test.local`, name: 'Member', passwordHash: null });
  await db.insert(workspaceAccess).values({ userId: id, workspaceId });
  const session = await createSession(id);
  return { cookie: `folio_session=${session.id}`, userId: id };
}

// POST /api/v1/w/:wslug/settings/:workspaceId/ai-keys
// Mount path: wScope.route('/settings', settingsRoute) — the route file
// declares /:workspaceId/ai-keys, so the workspaceId UUID lives after the
// wslug. The seed user is the workspace owner (see harness.ts).

describe('POST /api/v1/w/:wslug/settings/:workspaceId/ai-keys', () => {
  const path = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/settings/${workspaceId}/ai-keys`;

  // HERMETIC: these assert the SSRF guard's DEFAULT-CLOSED behavior (loopback
  // rejected). Pin FOLIO_ALLOW_LOOPBACK_AI=false so a dev with the loopback
  // escape-hatch enabled in their .env (self-hosted Ollama) doesn't get false
  // failures — the route reads the frozen `env` object, so we pin it here and
  // restore. (Test-isolation fix, 2026-06-03 — the hatch is exercised
  // explicitly in url-allow-list.test.ts with allowLoopback:true.)
  let prevLoopback: boolean;
  beforeAll(() => {
    prevLoopback = env.FOLIO_ALLOW_LOOPBACK_AI;
    (env as { FOLIO_ALLOW_LOOPBACK_AI: boolean }).FOLIO_ALLOW_LOOPBACK_AI = false;
  });
  afterAll(() => {
    (env as { FOLIO_ALLOW_LOOPBACK_AI: boolean }).FOLIO_ALLOW_LOOPBACK_AI = prevLoopback;
  });

  // Fix #3 — baseUrl pointing at loopback must be rejected by the persistence
  // route. Previously it would have been encrypted and stored, then fetched by
  // the Sub-phase C agent runner. validatePublicUrl => HTTPError(422).
  test('rejects ollama baseUrl pointing at loopback IPv4 (422)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: 'sk-mock',
        label: 'default',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  test('rejects ollama baseUrl pointing at AWS metadata link-local (422)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: 'sk-mock',
        label: 'default',
        baseUrl: 'http://169.254.169.254/',
      }),
    });
    expect(res.status).toBe(422);
  });

  test('rejects ollama baseUrl pointing at IPv4-mapped IPv6 loopback (422)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: 'sk-mock',
        label: 'default',
        baseUrl: 'http://[::ffff:127.0.0.1]/',
      }),
    });
    expect(res.status).toBe(422);
  });

  // Fix #2 mirrored on persistence — baseUrl only allowed for ollama. zValidator
  // returns 400 on .refine() failures (see ai.test.ts "rejects unknown provider").
  test('rejects baseUrl when provider is openai (400 from refine)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiKey: 'sk-mock',
        label: 'default',
        baseUrl: 'https://anything.example.com/',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects baseUrl when provider is anthropic (400 from refine)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-mock',
        label: 'default',
        baseUrl: 'https://anything.example.com/',
      }),
    });
    expect(res.status).toBe(400);
  });

  // B round 3 fix #13 — defense-in-depth: openrouter persistence must also
  // be rejected by the refine. Persistence symmetry with /ai/test-key.
  test('rejects baseUrl when provider is openrouter (400 from refine)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        apiKey: 'sk-or-mock',
        label: 'default',
        baseUrl: 'https://anything.example.com/',
      }),
    });
    expect(res.status).toBe(400);
  });

  // Happy path — ollama with a public baseUrl persists.
  test('accepts ollama with a public baseUrl (200)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: 'sk-mock',
        label: 'default',
        baseUrl: 'https://ollama.example.com/',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ ok: true });
  });

  // B round 3 fix #2 — persistence symmetry with /ai/test-key. Ollama
  // without baseUrl would fall through to the DEFAULT_BASE='http://
  // localhost:11434' loopback bypass inside the provider wrapper. Round 2
  // closed that hole on test-key but left persistence open. Mirror the guard.
  test('rejects ollama without baseUrl (422 — persistence symmetry)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: 'sk-mock',
        label: 'default',
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  // Happy path — non-ollama provider without baseUrl still works.
  test('accepts anthropic without baseUrl (200)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-mock',
        label: 'default',
      }),
    });
    expect(res.status).toBe(200);
  });

  // B round 4 fix #1 — mirror the authMethod gate from /ai/test-key onto the
  // persistence path. Pre-fix the route only ran requireUser; attachToken
  // hydrates user from token.createdBy, so a stolen / leaked workspace PAT
  // could mint or rotate the workspace's AI key without ever touching
  // test-key. AI-key management is session-only.
  test('POST /ai-keys rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'persistence-PAT',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-mock',
        label: 'default',
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // B round 4 fix #1 — symmetric to ai.test.ts: garbage cookie + valid bearer
  // must still resolve to authMethod==='token' (cookie-presence is not auth).
  test('POST /ai-keys rejects bearer even when an empty/garbage folio_session cookie is also sent', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'cookie-bypass-PAT',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    for (const garbageCookie of [
      'folio_session=garbage',
      'folio_session=',
      'folio_session=expired-id',
    ]) {
      const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: garbageCookie,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          provider: 'anthropic',
          apiKey: 'sk-mock',
          label: 'default',
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    }
  });

  // B round 5 #10 — symmetric to POST: garbage cookie + valid bearer must
  // still resolve to authMethod==='token' on DELETE. Round 4 added the POST
  // garbage-cookie test but left DELETE asymmetric. Threat mitigation 11
  // contract requires both verbs tested with garbage-cookie variants.
  test('DELETE /ai-keys/:keyId rejects bearer + garbage cookie with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // Seed an aiKeys row first via the session-authenticated POST.
    const postRes = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-mock',
        label: 'default',
      }),
    });
    expect(postRes.status).toBe(200);
    const listRes = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'GET',
      headers: { Cookie: seed.sessionCookie },
    });
    const listBody = await listRes.json();
    const keyId = listBody.data.keys[0]?.id as string;
    expect(typeof keyId).toBe('string');

    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'delete-cookie-bypass-PAT',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    for (const garbageCookie of [
      'folio_session=garbage',
      'folio_session=',
      'folio_session=expired-id',
    ]) {
      const res = await app.request(
        `${path(seed.workspace.slug, seed.workspace.id)}/${keyId}`,
        {
          method: 'DELETE',
          headers: {
            Cookie: garbageCookie,
            Authorization: `Bearer ${token}`,
          },
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    }
  });

  // B round 4 fix #1 — DELETE inherits the authMethod check from mitigation 11.
  test('DELETE /ai-keys/:keyId rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // Seed an aiKeys row first via the session-authenticated POST.
    const postRes = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-mock',
        label: 'default',
      }),
    });
    expect(postRes.status).toBe(200);
    const listRes = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'GET',
      headers: { Cookie: seed.sessionCookie },
    });
    const listBody = await listRes.json();
    const keyId = listBody.data.keys[0]?.id as string;
    expect(typeof keyId).toBe('string');

    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'delete-PAT',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${path(seed.workspace.slug, seed.workspace.id)}/${keyId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // Post-tenancy access/role gate (Task P2.T8.5) — the write gate moved off the
  // legacy memberships role onto the INSTANCE role (users.role). A user who CAN
  // see the workspace (has a workspace_access grant, so wScope passes) but is a
  // plain instance `member` must be REJECTED on POST/DELETE, while READ stays
  // access-only. These exercise the migrated gate directly (the prior tests only
  // covered the session-only/SSRF gates, not the role gate).
  test('POST /ai-keys: member with ws access but NOT instance-admin → 403 (role gate)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { cookie } = await seedMemberSession(db, seed.workspace.id);
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', apiKey: 'sk-mock', label: 'default' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('GET /ai-keys: member with ws access → 200 (read is access-only, not role-gated)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { cookie } = await seedMemberSession(db, seed.workspace.id);
    const res = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'GET',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.keys)).toBe(true);
  });

  test('DELETE /ai-keys/:keyId: member with ws access but NOT instance-admin → 403 (role gate)', async () => {
    const { app, db, seed } = await makeTestApp();
    // Owner seeds a key via the session POST.
    const postRes = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', apiKey: 'sk-mock', label: 'default' }),
    });
    expect(postRes.status).toBe(200);
    const listRes = await app.request(path(seed.workspace.slug, seed.workspace.id), {
      method: 'GET',
      headers: { Cookie: seed.sessionCookie },
    });
    const keyId = (await listRes.json()).data.keys[0]?.id as string;
    expect(typeof keyId).toBe('string');

    const { cookie } = await seedMemberSession(db, seed.workspace.id);
    const res = await app.request(
      `${path(seed.workspace.slug, seed.workspace.id)}/${keyId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });
});
