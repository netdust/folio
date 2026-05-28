import { describe, expect, test } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

// POST /api/v1/w/:wslug/settings/:workspaceId/ai-keys
// Mount path: wScope.route('/settings', settingsRoute) — the route file
// declares /:workspaceId/ai-keys, so the workspaceId UUID lives after the
// wslug. The seed user is the workspace owner (see harness.ts).

describe('POST /api/v1/w/:wslug/settings/:workspaceId/ai-keys', () => {
  const path = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/settings/${workspaceId}/ai-keys`;

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
    expect(body.error.message).toMatch(/loopback|private|baseUrl|base_url/i);
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
});
