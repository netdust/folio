import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { aiKeys, apiTokens } from '../db/schema.ts';
import { env } from '../env.ts';
import { newApiToken } from '../lib/auth.ts';
import { bootstrapSystemWorkspace, grantOwner } from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';

// Instance AI-key administration — /api/v1/instance/ai-keys (session-only,
// __system owner/admin gate). Mounted on v1 (not wScope) so a bearer never
// reaches it. Keys are instance-level (no workspace_id); the GET surface never
// returns encryptedKey.

const PATH = '/api/v1/instance/ai-keys';

/** Make the seed user a __system owner so requireInstanceAdmin passes. */
async function asInstanceAdmin(app: Awaited<ReturnType<typeof makeTestApp>>) {
  await bootstrapSystemWorkspace(app.db);
  await grantOwner(app.db, app.seed.user.email);
}

describe('GET /api/v1/instance/ai-keys', () => {
  test('a __system owner lists instance AI keys; encrypted_key never returned', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await asInstanceAdmin(harness);
    await db.insert(aiKeys).values({
      id: nanoid(),
      provider: 'anthropic',
      label: 'default',
      encryptedKey: 'CIPHERTEXT-must-not-leak',
    });

    const res = await app.request(PATH, { headers: { Cookie: seed.sessionCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = body.data.keys;
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBe(1);
    expect(keys[0].provider).toBe('anthropic');
    // M1/M3 — the secret is never serialized.
    expect(keys[0].encryptedKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('CIPHERTEXT-must-not-leak');
  });

  test('a non-__system user is forbidden (403)', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await bootstrapSystemWorkspace(db); // but DO NOT grantOwner
    const res = await app.request(PATH, { headers: { Cookie: seed.sessionCookie } });
    expect(res.status).toBe(403);
  });

  test('a bearer cannot reach the GET route (session-only)', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await asInstanceAdmin(harness);
    // Mint a real token for the seed user's workspace; it must still be rejected
    // because the route is on v1 (no attachToken) → no user → 401/403.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'bearer',
      tokenHash: hash,
      scopes: [],
      createdBy: seed.user.id,
    });
    const res = await app.request(PATH, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('POST /api/v1/instance/ai-keys', () => {
  // HERMETIC: pin the loopback hatch closed so a dev .env doesn't perturb the
  // SSRF default-closed assertions. (Moved from settings.test.ts, 2026-06-03.)
  let prevLoopback: boolean;
  beforeAll(() => {
    prevLoopback = env.FOLIO_ALLOW_LOOPBACK_AI;
    (env as { FOLIO_ALLOW_LOOPBACK_AI: boolean }).FOLIO_ALLOW_LOOPBACK_AI = false;
  });
  afterAll(() => {
    (env as { FOLIO_ALLOW_LOOPBACK_AI: boolean }).FOLIO_ALLOW_LOOPBACK_AI = prevLoopback;
  });

  async function post(
    app: Awaited<ReturnType<typeof makeTestApp>>['app'],
    cookie: string,
    body: unknown,
  ) {
    return app.request(PATH, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('creates a key (no workspace), 201; the row has no workspace_id', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await asInstanceAdmin(harness);
    const res = await post(app, seed.sessionCookie, {
      provider: 'ollama',
      apiKey: 'sk-mock',
      label: 'default',
      baseUrl: 'https://ollama.example.com',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.provider).toBe('ollama');
    expect(body.data.paid_residual_live).toBe(false);
    const rows = await db.query.aiKeys.findMany();
    expect(rows.length).toBe(1);
    // No workspace_id column exists at all on the instance table.
    expect('workspaceId' in rows[0]!).toBe(false);
  });

  test('rejects ollama baseUrl pointing at loopback IPv4 (422)', async () => {
    const harness = await makeTestApp();
    await asInstanceAdmin(harness);
    const res = await post(harness.app, harness.seed.sessionCookie, {
      provider: 'ollama',
      apiKey: 'sk-mock',
      label: 'default',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('INVALID_BODY');
  });

  test('rejects ollama baseUrl pointing at AWS metadata link-local (422)', async () => {
    const harness = await makeTestApp();
    await asInstanceAdmin(harness);
    const res = await post(harness.app, harness.seed.sessionCookie, {
      provider: 'ollama',
      apiKey: 'sk-mock',
      label: 'default',
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(res.status).toBe(422);
  });

  test('rejects ollama baseUrl pointing at IPv4-mapped IPv6 loopback (422)', async () => {
    const harness = await makeTestApp();
    await asInstanceAdmin(harness);
    const res = await post(harness.app, harness.seed.sessionCookie, {
      provider: 'ollama',
      apiKey: 'sk-mock',
      label: 'default',
      baseUrl: 'http://[::ffff:127.0.0.1]/',
    });
    expect(res.status).toBe(422);
  });

  test('rejects baseUrl when provider is openai (refine → 400)', async () => {
    const harness = await makeTestApp();
    await asInstanceAdmin(harness);
    const res = await post(harness.app, harness.seed.sessionCookie, {
      provider: 'openai',
      apiKey: 'sk-mock',
      label: 'default',
      baseUrl: 'https://evil.example.com',
    });
    expect(res.status).toBe(400);
  });

  test('rejects ollama without baseUrl (422 — persistence symmetry)', async () => {
    const harness = await makeTestApp();
    await asInstanceAdmin(harness);
    const res = await post(harness.app, harness.seed.sessionCookie, {
      provider: 'ollama',
      apiKey: 'sk-mock',
      label: 'default',
    });
    expect(res.status).toBe(422);
  });

  test('accepts anthropic without baseUrl (201) and flags the paid residual (M8)', async () => {
    const harness = await makeTestApp();
    await asInstanceAdmin(harness);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const res = await post(harness.app, harness.seed.sessionCookie, {
        provider: 'anthropic',
        apiKey: 'sk-mock',
        label: 'default',
      });
      expect(res.status).toBe(201);
      expect((await res.json()).data.paid_residual_live).toBe(true);
    } finally {
      console.warn = origWarn;
    }
    // M8: a paid-key create logs the denial-of-wallet residual warning.
    expect(warnings.some((w) => /denial-of-wallet/i.test(w))).toBe(true);
  });

  test('a non-__system user cannot POST (403)', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await bootstrapSystemWorkspace(db); // no grantOwner
    const res = await post(app, seed.sessionCookie, {
      provider: 'ollama',
      apiKey: 'sk-mock',
      label: 'default',
      baseUrl: 'https://ollama.example.com',
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/instance/ai-keys/:keyId', () => {
  test('a __system owner deletes an instance key (200) and the row is gone', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await asInstanceAdmin(harness);
    const id = nanoid();
    await db.insert(aiKeys).values({
      id,
      provider: 'anthropic',
      label: 'default',
      encryptedKey: 'x',
    });
    const res = await app.request(`${PATH}/${id}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);
    const rows = await db.query.aiKeys.findMany({ where: eq(aiKeys.id, id) });
    expect(rows.length).toBe(0);
  });

  test('a non-__system user cannot DELETE (403)', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await bootstrapSystemWorkspace(db); // no grantOwner
    const id = nanoid();
    await db.insert(aiKeys).values({ id, provider: 'anthropic', label: 'default', encryptedKey: 'x' });
    const res = await app.request(`${PATH}/${id}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(403);
  });
});
