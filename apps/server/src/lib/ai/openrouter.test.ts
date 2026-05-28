import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// NOTE: openai.test.ts uses `mock.module('openai', ...)` and Bun's module mocks
// are process-global, leaking across files within a run. We mock the SDK here
// too so the stream-sanitize test below works whether or not openai.test.ts
// ran first. The shape mirrors openai.test.ts's stub.
const mockCreate = mock(async (_opts: { stream?: boolean }) => ({ id: 'cmpl_x' }));
const mockModelsList = mock(async (): Promise<{ data: Array<{ id: string }> }> => ({ data: [] }));

mock.module('openai', () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
    models = { list: mockModelsList };
    constructor(_: unknown) {}
  },
}));

import { openrouter } from './openrouter.ts';

// `global.fetch` is process-global — restore after each test.
const originalFetch = global.fetch;

describe('openrouter provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockModelsList.mockClear();
  });

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

  // B round 5 #6 — round 4 mitigation 5 enriched the contract to cover
  // openrouter.stream startup throws. Round 4 left it inheriting openai.stream's
  // (broken) propagation of raw SDK errors. Round 5 threads providerName
  // through streamOpenAICompatible so OpenRouter requests get correctly-named
  // sanitized messages (mitigation 5 + cosmetic correctness for operators).
  test('stream() sanitizes a 401 thrown by chat.completions.create and names OpenRouter', async () => {
    mockCreate.mockImplementationOnce((async () => {
      const err = new Error('Incorrect API key: sk-or-real-XYZ at openrouter.internal.example.com') as Error & { status: number };
      err.status = 401;
      throw err;
    }) as never);

    let thrown: unknown;
    try {
      const iter = openrouter.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: 'sk-or-real-XYZ',
        model: 'anthropic/claude-haiku-4-5',
      });
      for await (const _ of iter) {
        // drain
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).not.toMatch(/sk-or-real/);
    expect(msg).not.toMatch(/internal\.example/);
    expect(msg).not.toMatch(/Incorrect API key/);
    expect(msg).toMatch(/unauthorized/i);
    // The provider name in the sanitized message is OpenRouter, not OpenAI.
    expect(msg).toMatch(/OpenRouter/);
    expect(msg).not.toMatch(/OpenAI/);
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
