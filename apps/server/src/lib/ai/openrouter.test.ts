import { afterEach, describe, expect, mock, test } from 'bun:test';
import { openrouter } from './openrouter.ts';

// `global.fetch` is process-global — restore after each test.
const originalFetch = global.fetch;

describe('openrouter provider', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('exposes stream + testKey', () => {
    expect(typeof openrouter.stream).toBe('function');
    expect(typeof openrouter.testKey).toBe('function');
  });

  // B round 3 fix #6 — OpenRouter's /api/v1/models endpoint is PUBLIC.
  // The pre-fix testKey delegated to openai.testKey which calls models.list,
  // and that returned ok:true for any apiKey value (including an empty
  // string). Override hits /api/v1/key which requires Bearer auth.
  test('testKey() hits /api/v1/key (auth-required), not /models (public)', async () => {
    const calls: string[] = [];
    global.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return new Response('{"data":{"label":"my-key"}}', { status: 200 });
    }) as never;
    await openrouter.testKey({ apiKey: 'sk-or-test', model: 'anthropic/claude-haiku-4-5' });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/\/api\/v1\/key$/);
    expect(calls[0]).not.toMatch(/\/models/);
  });

  test('testKey() sends the apiKey as a Bearer header', async () => {
    const seen: { auth: string | null } = { auth: null };
    global.fetch = mock(async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      seen.auth = init?.headers?.Authorization ?? null;
      return new Response('{"data":{}}', { status: 200 });
    }) as never;
    await openrouter.testKey({ apiKey: 'sk-or-secret', model: 'x' });
    expect(seen.auth).toBe('Bearer sk-or-secret');
  });

  test('testKey() returns ok on 200 from /key', async () => {
    global.fetch = mock(async () => new Response('{"data":{}}', { status: 200 })) as never;
    const r = await openrouter.testKey({ apiKey: 'sk-or-test', model: 'anthropic/claude-haiku-4-5' });
    expect(r.ok).toBe(true);
  });

  test('testKey() returns failure on 401 (key rejected)', async () => {
    global.fetch = mock(async () => new Response('', { status: 401 })) as never;
    const r = await openrouter.testKey({ apiKey: 'bogus', model: 'anything' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unauth/i);
  });

  test('testKey() network error returns sanitized reason (no echo of internal host)', async () => {
    global.fetch = mock(async () => {
      throw new Error('ECONNRESET at openrouter.internal.example.com');
    }) as never;
    const r = await openrouter.testKey({ apiKey: 'sk-or-test', model: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/network|unreachable/i);
      expect(r.reason).not.toMatch(/internal\.example/);
      expect(r.reason).not.toMatch(/ECONNRESET/);
    }
  });
});
