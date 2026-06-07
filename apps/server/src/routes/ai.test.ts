import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { aiKeys, apiTokens } from '../db/schema.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { env } from '../env.ts';
import { newApiToken } from '../lib/auth.ts';

// Mock at the provider-factory boundary so the route sees a stubbed testKey /
// stream without touching any real SDK. Bun hoists mock.module before the
// dynamic import of app.ts that happens inside makeTestApp().
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

// /complete stream stub. Default: yield two text deltas + done. Tests that need
// a specific behavior (sentinel echo, error) set the override for one call.
type StreamOpts = { apiKey: string; model: string; system: string; messages: unknown };
type StreamEvent = { type: 'text'; delta: string } | { type: 'done'; reason: string };
let streamOverride:
  | ((opts: StreamOpts) => AsyncIterable<StreamEvent>)
  | undefined;
async function* defaultStream(_opts: StreamOpts): AsyncIterable<StreamEvent> {
  yield { type: 'text', delta: 'Hello ' };
  yield { type: 'text', delta: 'world.' };
  yield { type: 'done', reason: 'stop' };
}
mock.module('../lib/ai/provider.ts', () => ({
  getProvider: (name: string) => {
    if (!KNOWN.has(name)) throw new Error(`Unknown AI provider: ${name}`);
    return {
      stream: (opts: StreamOpts) => (streamOverride ?? defaultStream)(opts),
      testKey: mockTestKey,
    };
  },
}));

import { makeTestApp } from '../test/harness.ts';

describe('POST /api/v1/w/:wslug/ai/test-key', () => {
  // HERMETIC: the loopback-rejection tests below assert the SSRF guard's
  // DEFAULT-CLOSED behavior. Pin FOLIO_ALLOW_LOOPBACK_AI=false so a dev with the
  // escape-hatch enabled in .env (self-hosted Ollama) doesn't get false failures.
  // (Test-isolation fix, 2026-06-03.)
  let prevLoopback: boolean;
  beforeAll(() => {
    prevLoopback = env.FOLIO_ALLOW_LOOPBACK_AI;
    (env as { FOLIO_ALLOW_LOOPBACK_AI: boolean }).FOLIO_ALLOW_LOOPBACK_AI = false;
  });
  afterAll(() => {
    (env as { FOLIO_ALLOW_LOOPBACK_AI: boolean }).FOLIO_ALLOW_LOOPBACK_AI = prevLoopback;
  });

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

  // B round 2 fix #12 — a session caller whose browser also carries a stray
  // Authorization header must NOT get 403. The session cookie wins.
  test('accepts session callers even when an Authorization header is also present', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'stray PAT',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });

    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: seed.sessionCookie, // session present
        Authorization: `Bearer ${token}`, // stray token alongside
      },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-mock-good',
      }),
    });
    // Session takes precedence — request runs, mocked provider returns ok.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ ok: true });
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

  test('rejects base_url pointing at loopback IPv4', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3.1',
        api_key: '_',
        base_url: 'http://127.0.0.1:11434',
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  test('rejects base_url pointing at link-local AWS metadata', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'x',
        api_key: '_',
        base_url: 'http://169.254.169.254/',
      }),
    });
    expect(res.status).toBe(422);
  });

  test('rejects base_url with non-http scheme', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'x',
        api_key: '_',
        base_url: 'file:///etc/passwd',
      }),
    });
    expect(res.status).toBe(422);
  });

  test('rejects base_url hostname "localhost"', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'x',
        api_key: '_',
        base_url: 'http://localhost:11434',
      }),
    });
    expect(res.status).toBe(422);
  });

  test('rejects base_url private IPv4 (10/8, 172.16/12, 192.168/16)', async () => {
    const { app, seed } = await makeTestApp();
    for (const ip of ['http://10.0.0.5/', 'http://172.20.0.5/', 'http://192.168.1.1/']) {
      const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'ollama',
          model: 'x',
          api_key: '_',
          base_url: ip,
        }),
      });
      expect(res.status).toBe(422);
    }
  });

  test('allows base_url on a public host', async () => {
    const { app, seed } = await makeTestApp();
    // mockTestKey returns ok:true from the test setup at the top of the file
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3.1',
        api_key: '_',
        base_url: 'https://ollama.example.com/',
      }),
    });
    expect(res.status).toBe(200);
  });

  // Fix #1 — IPv4-mapped IPv6 must be rejected at the route boundary too.
  test('rejects base_url IPv4-mapped IPv6 pointing at loopback', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'x',
        api_key: '_',
        base_url: 'http://[::ffff:127.0.0.1]/',
      }),
    });
    expect(res.status).toBe(422);
  });

  // Fix #2 — base_url is only valid for ollama. For openai/anthropic/openrouter
  // the route would forward it to new OpenAI({baseURL}) and exfiltrate the
  // Bearer key. Reject at the schema layer (zValidator -> 400).
  test('rejects base_url when provider is not ollama (openai)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
        api_key: 'sk-mock',
        base_url: 'https://anything.example.com/',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects base_url when provider is anthropic', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_key: 'sk-mock',
        base_url: 'https://anything.example.com/',
      }),
    });
    expect(res.status).toBe(400);
  });

  // B round 3 fix #13 — defense-in-depth: openrouter must also be rejected
  // by the refine. OpenRouter's testKey now hits /api/v1/key directly, but
  // the refine is still the contract pin — if someone removes the override
  // or changes the schema, the test catches it.
  test('rejects base_url when provider is openrouter (refine — defense in depth)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-4-5',
        api_key: 'sk-or-mock',
        base_url: 'https://anything.example.com/',
      }),
    });
    expect(res.status).toBe(400);
  });

  // B round 3 fix #1 — A Bearer token paired with a garbage / empty /
  // unknown-id `folio_session` cookie must still be rejected. The round-2
  // guard checked cookie-header presence; Bun forwards the cookie verbatim
  // (no client cookie jar in HTTP requests), so attachUser sees the invalid
  // session-id, readSession returns null, attachToken then hydrates the
  // bearer's creator into c.user — and the cookie-presence guard waved
  // it through. We now check authMethod==='token' instead.
  test('rejects Bearer token even when an empty/garbage folio_session cookie is also sent', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'bypass-test',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });

    for (const garbageCookie of [
      'folio_session=garbage',
      'folio_session=',
      'folio_session=expired-id',
    ]) {
      const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: garbageCookie,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          api_key: 'sk-mock-good',
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    }
  });

  // claude-code is keyless/local — there is no API key to validate.
  // The route must return 422 (not 500) and never reach getProvider().
  test('rejects claude-code provider with 422 (keyless — no API key to test)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code', model: 'x', api_key: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
    expect(body.error.message).toMatch(/claude-code/i);
  });

  // Fix #5 — ollama provider defaults baseUrl to http://localhost:11434 inside
  // the SDK wrapper. The route must require an explicit base_url so callers
  // can't probe the server's loopback Ollama by omitting it.
  test('rejects ollama without base_url (default-base loopback fallback)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/test-key`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3.1',
        api_key: '_',
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });
});

describe('POST /api/v1/w/:wslug/ai/complete', () => {
  // Reset the per-test stream override so a failing test can't leak into the next.
  afterAll(() => {
    streamOverride = undefined;
  });

  async function seedAnthropicKey(db: Awaited<ReturnType<typeof makeTestApp>>['db'], secret: string) {
    await db.insert(aiKeys).values({
      id: nanoid(),
      provider: 'anthropic',
      label: 'default',
      encryptedKey: encryptSecret(secret),
    });
  }

  test('returns 409 AI_NOT_CONFIGURED when no AI key is seeded', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'summarize', content: 'Some document text.' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('AI_NOT_CONFIGURED');
  });

  test('with a configured key + stubbed provider, returns the accumulated text', async () => {
    streamOverride = undefined; // default two-delta stream
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'summarize', content: 'Some document text.' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ text: 'Hello world.' });
  });

  test('rejects API-token (Bearer) callers with 403 (session-only inherited gate)', async () => {
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'complete PAT',
      tokenHash: hash,
      scopes: ['documents:read', 'documents:write'],
      createdBy: seed.user.id,
    });
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: 'draft', content: 'x' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('requires session (no cookie → 401)', async () => {
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'draft', content: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  test('the response body NEVER contains the decrypted api key (mitigation 6)', async () => {
    // The stub echoes the apiKey it received into a text delta — if the route
    // ever leaked the key into the response, this would catch it. The route must
    // return only the model text, and the key must never reach the wire.
    const SENTINEL = 'sk-SENTINEL-leak-canary-9f3a';
    streamOverride = async function* (opts: StreamOpts) {
      // The model output legitimately contains whatever the model says — but the
      // ROUTE must not inject the key. We assert the key is absent from the body
      // regardless; here we yield a benign completion (NOT the key).
      void opts;
      yield { type: 'text', delta: 'summary' } as const;
      yield { type: 'done', reason: 'stop' } as const;
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, SENTINEL);
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'summarize', content: 'doc' }),
    });
    const raw = await res.text();
    expect(raw).not.toContain(SENTINEL);
    streamOverride = undefined;
  });

  test('a provider error is sanitized (does NOT leak the key) and returns 502', async () => {
    const SENTINEL = 'sk-SENTINEL-error-leak-7b2c';
    streamOverride = async function* (_opts: StreamOpts): AsyncIterable<StreamEvent> {
      // Simulate an SDK error whose message embeds the key — the sanitizer must
      // strip it. (yield nothing; throw on first iteration.)
      throw Object.assign(new Error(`Incorrect API key provided: ${SENTINEL}`), { status: 401 });
      // biome-ignore lint/correctness/useYield: unreachable; satisfies generator type
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, SENTINEL);
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'draft', content: 'doc' }),
    });
    expect(res.status).toBe(502);
    const raw = await res.text();
    expect(raw).not.toContain(SENTINEL);
    const body = JSON.parse(raw);
    expect(body.error.code).toBe('AI_ERROR');
    streamOverride = undefined;
  });

  test('read-only: NO document row is created and NO event is emitted', async () => {
    streamOverride = undefined;
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const docsBefore = await db.query.documents.findMany();
    const eventsBefore = await db.query.events.findMany();
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'decompose', content: 'build a thing' }),
    });
    expect(res.status).toBe(200);
    const docsAfter = await db.query.documents.findMany();
    const eventsAfter = await db.query.events.findMany();
    expect(docsAfter.length).toBe(docsBefore.length);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  test('rejects an unknown action via .strict() schema (400)', async () => {
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rewrite', content: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  // done.reason handling (findings 189/466). The stream-accumulation loop must
  // honor the terminal `done` event, not just `text` deltas: a refusal or an
  // empty normal-stop is NOT a successful `{ text: '' }`.
  test('model refusal (done.reason=refusal) → 422 AI_REFUSED, not an empty success', async () => {
    streamOverride = async function* (_opts: StreamOpts): AsyncIterable<StreamEvent> {
      // Model declined: it may emit no text, just the terminal refusal.
      yield { type: 'done', reason: 'refusal' } as const;
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'draft', content: 'do something disallowed' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('AI_REFUSED');
    streamOverride = undefined;
  });

  test('refusal wins even if some partial text was emitted before the refusal', async () => {
    streamOverride = async function* (_opts: StreamOpts): AsyncIterable<StreamEvent> {
      yield { type: 'text', delta: 'I cannot' } as const;
      yield { type: 'done', reason: 'refusal' } as const;
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'draft', content: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('AI_REFUSED');
    streamOverride = undefined;
  });

  test('empty text on a normal stop → 422 AI_EMPTY_RESPONSE, not an empty success', async () => {
    streamOverride = async function* (_opts: StreamOpts): AsyncIterable<StreamEvent> {
      // Normal stop but the model produced nothing usable.
      yield { type: 'done', reason: 'stop' } as const;
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'summarize', content: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('AI_EMPTY_RESPONSE');
    streamOverride = undefined;
  });

  test('whitespace-only text on a normal stop → 422 AI_EMPTY_RESPONSE', async () => {
    streamOverride = async function* (_opts: StreamOpts): AsyncIterable<StreamEvent> {
      yield { type: 'text', delta: '   \n  ' } as const;
      yield { type: 'done', reason: 'stop' } as const;
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'summarize', content: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('AI_EMPTY_RESPONSE');
    streamOverride = undefined;
  });

  test('truncation (done.reason=max_tokens) returns the partial text with 200 — a draft is still useful', async () => {
    streamOverride = async function* (_opts: StreamOpts): AsyncIterable<StreamEvent> {
      yield { type: 'text', delta: 'A long draft that got cut' } as const;
      yield { type: 'done', reason: 'max_tokens' } as const;
    };
    const { app, db, seed } = await makeTestApp();
    await seedAnthropicKey(db, 'sk-test-key');
    const res = await app.request(`/api/v1/w/${seed.workspace.slug}/ai/complete`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'draft', content: 'x' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.text).toBe('A long draft that got cut');
    streamOverride = undefined;
  });
});
