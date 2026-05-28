import { describe, expect, mock, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';

// Mock at the provider-factory boundary so the route sees a stubbed testKey
// without touching any real SDK. Bun hoists mock.module before the dynamic
// import of app.ts that happens inside makeTestApp().
//
// IMPORTANT: Bun's mock.module is process-global — it leaks into other test
// files that also import '../lib/ai/provider.ts' (notably provider.test.ts).
// We mirror the real getProvider's "throws on unknown name" guard so the
// sibling test stays green.
const KNOWN = new Set(['anthropic', 'openai', 'openrouter', 'ollama']);
const mockTestKey = mock(
  async (_: { apiKey: string; model: string; baseUrl?: string }) =>
    ({ ok: true }) as { ok: true } | { ok: false; reason: string },
);
mock.module('../lib/ai/provider.ts', () => ({
  getProvider: (name: string) => {
    if (!KNOWN.has(name)) throw new Error(`Unknown AI provider: ${name}`);
    return {
      stream: () => {
        throw new Error('stream not exercised in this test');
      },
      testKey: mockTestKey,
    };
  },
}));

import { makeTestApp } from '../test/harness.ts';

describe('POST /api/v1/w/:wslug/ai/test-key', () => {
  test('returns ok:true for a happy-path mocked provider', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-mock',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ ok: true });
  });

  test('returns the provider failure verbatim', async () => {
    mockTestKey.mockImplementationOnce(
      async () => ({ ok: false, reason: 'Unauthorized (401)' }) as const,
    );
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-bad',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(false);
    expect(body.data.reason).toBe('Unauthorized (401)');
  });

  test('rejects unknown provider with 400', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', model: 'x', api_key: 'sk' }),
    });
    // zValidator default-failure status is 400 (verified in @hono/zod-validator 0.4.3).
    expect(res.status).toBe(400);
  });

  test('requires session', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no Cookie
      body: JSON.stringify({ provider: 'anthropic', model: 'x', api_key: 'sk' }),
    });
    expect(res.status).toBe(401);
  });

  test('rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // Mint a workspace-scoped human PAT for the seed user. The route is
    // documented as "UI-only / session-only" — even a perfectly valid PAT
    // belonging to the seed user must be rejected.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'test PAT',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });

    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-mock',
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('does NOT persist the key', async () => {
    const { app, db, seed } = await makeTestApp();
    const before = await db.query.aiKeys.findMany();
    await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-mock',
      }),
    });
    const after = await db.query.aiKeys.findMany();
    expect(after.length).toBe(before.length);
  });
});
