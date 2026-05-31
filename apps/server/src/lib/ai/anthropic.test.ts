import { beforeEach, describe, expect, mock, test } from 'bun:test';

// NOTE: Bun's `mock.module(...)` is process-global and leaks across test files
// within the same `bun test` run. The `@anthropic-ai/sdk` stub below covers
// only the SDK surface this provider actually uses (messages.stream/create +
// models.list); if a future test exercises other surfaces, the stub will
// return undefined and the test will fail with a cryptic error in a different
// file. See memory/feedback_mock-module-leaks-across-bun-tests.md.

// Mock the SDK module BEFORE importing the provider so the provider sees the mock.
const mockCreate = mock(async () => ({}));
const mockStream = mock(async function* () {
  yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 1 } };
  yield { type: 'message_stop' };
});
const mockModelsList = mock(async (): Promise<{ data: Array<{ id: string }> }> => ({ data: [] }));
const anthropicCtorSpy = mock((opts: unknown) => opts);

mock.module('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate, stream: () => mockStream() };
    models = { list: mockModelsList };
    constructor(opts: unknown) {
      anthropicCtorSpy(opts);
    }
  },
}));

import { anthropic } from './anthropic.ts';

describe('anthropic provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockStream.mockClear();
    mockModelsList.mockClear();
    anthropicCtorSpy.mockClear();
  });

  test('stream() yields text + tokens + done events from the Anthropic SDK stream', async () => {
    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hello' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 5, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200 response', async () => {
    mockModelsList.mockImplementationOnce(async () => ({ data: [{ id: 'claude-haiku-4-5' }] }));
    const result = await anthropic.testKey({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(true);
  });

  test('testKey() returns structured failure on 401', async () => {
    mockModelsList.mockImplementationOnce(async () => {
      const err = new Error('Unauthorized') as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const result = await anthropic.testKey({ apiKey: 'sk-bad', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unauth|401/i);
  });

  // B round 2 fix #9 — testKey() must NOT surface raw SDK e.message on
  // non-401 paths. SDK error strings can embed partial credentials, request
  // IDs, and proxy details. Whitelist by status only.
  test('testKey() reports rate-limit cleanly without leaking SDK message', async () => {
    mockModelsList.mockImplementationOnce(async () => {
      const err = new Error('Rate limit hit; key sk-ant-...XYZ at 1234567/min') as Error & {
        status: number;
      };
      err.status = 429;
      throw err;
    });
    const r = await anthropic.testKey({ apiKey: 'sk-bad', model: 'claude-haiku-4-5' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/rate limit/i);
      expect(r.reason).not.toMatch(/sk-ant/i); // no key leak
      expect(r.reason).not.toMatch(/1234567/); // no specifics from the message
    }
  });

  test('testKey() reports network error cleanly without leaking proxy details', async () => {
    mockModelsList.mockImplementationOnce(async () => {
      // No status field — looks like a fetch/connect error.
      throw new Error('ECONNREFUSED at internal.proxy.example.com:8080');
    });
    const r = await anthropic.testKey({ apiKey: 'sk', model: 'claude-haiku-4-5' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/network|unreachable/i);
      expect(r.reason).not.toMatch(/proxy\.example/);
      expect(r.reason).not.toMatch(/ECONNREFUSED/);
    }
  });

  test('stream() records the final usage.input_tokens=0 over a prior non-zero value', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield { type: 'message_delta', usage: { input_tokens: 12, output_tokens: 0 } };
      // Later delta corrects to 0 (e.g. cache-hit recomputation).
      yield { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0 } };
      yield { type: 'message_stop' };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 0, tokens_out: 0 });
  });

  test('stream() maps stop_reason=refusal to done.reason=refusal', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I cannot help with that' } };
      yield { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { input_tokens: 4, output_tokens: 6 } };
      yield { type: 'message_stop' };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys', messages: [{ role: 'user', content: 'do bad thing' }],
      tools: [], maxTokens: 100, apiKey: 'sk', model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'refusal' });
  });

  test('stream() maps stop_reason=pause_turn to done.reason=pause_turn', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'thinking...' } };
      yield { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { input_tokens: 4, output_tokens: 3 } };
      yield { type: 'message_stop' };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys', messages: [{ role: 'user', content: 'long task' }],
      tools: [], maxTokens: 100, apiKey: 'sk', model: 'claude-opus-4-7',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'pause_turn' });
  });

  test('stream() passes baseUrl through to the SDK constructor', async () => {
    const iter = anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 10,
      apiKey: 'sk',
      model: 'claude-haiku-4-5',
      baseUrl: 'https://anthropic.example.com',
    });
    for await (const _ of iter) {
      // drain
    }
    expect(anthropicCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk',
        baseURL: 'https://anthropic.example.com',
      }),
    );
  });

  test('testKey() passes baseUrl through to the SDK constructor', async () => {
    mockModelsList.mockImplementationOnce(async () => ({ data: [{ id: 'claude-haiku-4-5' }] }));
    await anthropic.testKey({
      apiKey: 'sk',
      model: 'claude-haiku-4-5',
      baseUrl: 'https://anthropic.example.com',
    });
    expect(anthropicCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk',
        baseURL: 'https://anthropic.example.com',
      }),
    );
  });

  // B round 5 #4 — round 4 mitigation 5 enriched the contract to cover
  // anthropic.stream startup throws, but only ollama.stream wrapped its
  // throws in code. anthropic.stream propagated the raw SDK error message,
  // which embeds the upstream URL and partial key. The for-await is now
  // try/catch'd; the throw rewrites to the same testKey whitelist.
  test('stream() sanitizes a 401 thrown during async iteration (mitigation 5)', async () => {
    mockStream.mockImplementationOnce((async function* () {
      const err = new Error('Incorrect API key provided: sk-real-0123456789. See https://docs.anthropic.com.') as Error & { status: number };
      err.status = 401;
      throw err;
      // eslint-disable-next-line no-unreachable
      yield {};
    }) as never);

    let thrown: unknown;
    try {
      const iter = anthropic.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: 'sk-real-0123456789',
        model: 'claude-haiku-4-5',
      });
      for await (const _ of iter) {
        // drain — should throw mid-iter
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).not.toMatch(/sk-real/);
    expect(msg).not.toMatch(/docs\.anthropic\.com/);
    expect(msg).not.toMatch(/Incorrect API key/);
    expect(msg).toMatch(/unauthorized/i);
    expect(msg).toMatch(/Anthropic/);
  });

  // Round 7 #9 — coerceTokenCount applied to message_delta usage. Pre-round-7
  // the `!== undefined` guard accepted any value as-is; a sloppy proxy
  // emitting input_tokens=-1 propagated into the agent_run REAL column.
  test('stream() coerces negative input_tokens to 0 (round 7 #9)', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield {
        type: 'message_delta',
        usage: { input_tokens: -1, output_tokens: 5 },
        delta: { stop_reason: 'end_turn' },
      };
      yield { type: 'message_stop' };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 0, tokens_out: 5 });
  });

  // Round 7 #6 — round 5 #4's try/catch wrapped only the for-await. The
  // `new Anthropic(...)` constructor + the synchronous `c.messages.stream(...)`
  // call can also throw (invalid baseURL, init mismatch); pre-round-7 those
  // throws propagated raw. Widened try now sanitizes those too.
  test('stream() sanitizes a synchronous throw from messages.stream() (round 7 #6)', async () => {
    // Make messages.stream() throw synchronously by replacing the SDK class
    // for this test only. Use mock.module is process-global, but mockStream
    // is per-test — switching to a thrower works.
    const original = mockStream.getMockImplementation();
    const throwerStream = mock(() => {
      throw new Error('Connection failed: target=sk-real-12345 host=proxy.example.com:9999');
    });
    // Replace the stream() factory on the Anthropic class — only this test
    // re-throws. Direct invocation via mockImplementationOnce mimics the
    // SDK contract (messages.stream is sync; returns an async iterator).
    mockStream.mockImplementationOnce(throwerStream as never);

    let thrown: unknown;
    try {
      const iter = anthropic.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: 'sk-real-12345',
        model: 'claude-haiku-4-5',
      });
      for await (const _ of iter) {
        // drain
      }
    } catch (e) {
      thrown = e;
    } finally {
      // Restore the default implementation for subsequent tests.
      if (original) mockStream.mockImplementation(original);
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // Contract: never leak the partial key, never leak the proxy host.
    // Status-less errors collapse to the generic network-error message
    // (matching ollama / openai network-error tests). What matters is the
    // raw SDK message body must NOT propagate.
    expect(msg).not.toMatch(/sk-real/);
    expect(msg).not.toMatch(/proxy\.example/);
    expect(msg).not.toMatch(/Connection failed/);
  });

  test('stream() yields done event even when tool_use input_json fails to JSON.parse', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_abc', name: 'f' },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"x' },
      };
      yield { type: 'content_block_stop', index: 0 };
      yield {
        type: 'message_delta',
        usage: { input_tokens: 2, output_tokens: 1 },
        delta: { stop_reason: 'tool_use' },
      };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    // Tool call event still emitted but with empty args (malformed buffer).
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'toolu_abc',
      name: 'f',
      arguments: {},
    });
    // Trailing events still fire.
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 2, tokens_out: 1 });
    expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(true);
  });
});
