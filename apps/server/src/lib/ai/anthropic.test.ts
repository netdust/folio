import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProviderEvent } from './provider.ts';

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
// Captures the ARGS passed to messages.stream(...) so tests can assert the request
// body (the assistant tool_use echo + tool_result mapping), not just parsed events.
// Without this the stream mock dropped its args → the request shape was wire-mock-blind.
const streamArgSpy = mock((args: unknown) => args);

mock.module('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = {
      create: mockCreate,
      stream: (args: unknown) => {
        streamArgSpy(args);
        return mockStream();
      },
    };
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
    streamArgSpy.mockClear();
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

  // G1 — a TRUNCATED stream (connection dropped before message_stop AND before any
  // message_delta carrying a stop_reason) must NOT emit a fake-success done. It
  // emits NO done event → the runner's FIX#2 (doneReason===undefined) fails loudly.
  test('stream() does NOT emit a done event when the stream is truncated (no terminal) (G1)', async () => {
    mockStream.mockImplementationOnce((async function* () {
      // Some text arrives, then the stream just ends — no message_delta(stop_reason),
      // no message_stop (the proxy dropped the connection).
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } };
      // stream ends here — truncated
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-3',
    })) {
      events.push(ev);
    }
    expect(events.filter((e) => (e as { type: string }).type === 'text').length).toBeGreaterThan(0);
    expect(events.filter((e) => (e as { type: string }).type === 'done')).toHaveLength(0);
  });

  // G5 — a SERVER-side tool block (server_tool_use / mcp_tool_use) is not a client
  // tool call. The adapter must NOT register a phantom tool_call for it, AND must
  // WARN with the specific block type so a downstream FIX#3 failure is diagnosable
  // (not the generic "no usable tool call").
  test('stream() warns on an unsupported server_tool_use block and emits no phantom tool_call (G5)', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      mockStream.mockImplementationOnce((async function* () {
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search' },
        };
        yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 2 }, delta: { stop_reason: 'tool_use' } };
        yield { type: 'message_stop' };
      }) as never);

      const events: unknown[] = [];
      for await (const ev of anthropic.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: 'sk-test',
        model: 'claude-3',
      })) {
        events.push(ev);
      }
      // No phantom client tool_call for the server block.
      expect(events.filter((e) => (e as { type: string }).type === 'tool_call')).toHaveLength(0);
      // ...but a SPECIFIC warn naming the block type (the diagnosable outcome).
      expect(warnings.some((w) => /server_tool_use/.test(w))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  // ── Test-effectiveness hardening (followup-anthropic-provider-test-hardening) ──
  // The adapter is behaviorally correct; these close green-but-blind paths so a
  // future edit that breaks them goes RED.

  // #1 (highest value, wire-mock leak) — the assistant tool_use REQUEST echo. A
  // prior assistant turn with tool_calls must serialize to a `content` array of
  // {type:'tool_use', id, name, input: tc.arguments}, and a role:'tool' message to
  // {type:'tool_result', tool_use_id, content}. The stream mock dropped its args, so
  // breaking the echo (drop it, map arguments→input wrong, emit `arguments` not
  // `input`) left every test green. Assert the SENT request shape via streamArgSpy.
  test('stream() echoes assistant tool_calls + tool results into the Anthropic request body (#1)', async () => {
    const iter = anthropic.stream({
      system: 'sys',
      messages: [
        { role: 'user', content: 'list' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tu_1', name: 'list_workspaces', arguments: { q: 'x' } }] },
        { role: 'tool', content: '{"ok":true}', tool_use_id: 'tu_1' },
      ],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    });
    for await (const _ of iter) {
      /* drain */
    }
    const sent = streamArgSpy.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // The assistant turn → a content array carrying a tool_use block.
    const assistant = sent.messages.find((m) => m.role === 'assistant');
    const toolUse = (assistant!.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>).find(
      (b) => b.type === 'tool_use',
    );
    expect(toolUse).toBeDefined();
    expect(toolUse!.id).toBe('tu_1');
    expect(toolUse!.name).toBe('list_workspaces');
    // Anthropic field is `input` (NOT `arguments`), carrying the object verbatim.
    expect(toolUse!.input).toEqual({ q: 'x' });
    // The tool result → a user message with a tool_result block carrying tool_use_id.
    const toolMsg = sent.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type: string }>)[0]?.type === 'tool_result',
    );
    const toolResult = (toolMsg!.content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0];
    expect(toolResult!.tool_use_id).toBe('tu_1');
    expect(toolResult!.content).toBe('{"ok":true}');
  });

  // #2 — thinking blocks must NOT leak into the visible text stream. The adapter
  // emits text ONLY on delta.type==='text_delta', so thinking_delta/signature_delta
  // are dropped — but nothing asserted it. (The 'pause_turn' test is mislabeled — it
  // sends a plain text_delta named 'thinking...', not a real thinking block.)
  test('stream() does NOT surface thinking_delta / signature_delta as text (#2)', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } };
      // ADVERSARIAL: the thinking delta ALSO carries a `text` field. The TYPE check
      // (`delta.type === 'text_delta'`) is the ONLY thing preventing this internal
      // reasoning from leaking as visible text — a plain `if (delta.text)` would leak
      // it. This is what makes the test bite the type guard, not just the text guard.
      yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning', text: 'SECRET_reasoning_leak' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123', text: 'SECRET_sig_leak' } };
      yield { type: 'content_block_stop', index: 0 };
      // Then the real visible answer.
      yield { type: 'content_block_start', index: 1, content_block: { type: 'text' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the answer' } };
      yield { type: 'content_block_stop', index: 1 };
      yield { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 2 }, delta: { stop_reason: 'end_turn' } };
      yield { type: 'message_stop' };
    }) as never);

    const events: ProviderEvent[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    const texts = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta);
    // ONLY the visible answer surfaces — the thinking/signature deltas (even with a
    // `text` field) are dropped because they're not text_delta type.
    expect(texts).toEqual(['the answer']);
    expect(texts.join('')).not.toContain('SECRET_reasoning_leak');
    expect(texts.join('')).not.toContain('SECRET_sig_leak');
    // ...and the turn still completes (text/tokens/done all fire).
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 3, tokens_out: 2 });
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  // #3 — multiple PARALLEL tool_use blocks (Anthropic emits these by default). Each is
  // keyed by its own ev.index and emitted at its own content_block_stop; assert two
  // distinct tool_call events surface.
  test('stream() surfaces two parallel tool_use blocks as two distinct tool_calls (#3)', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_a', name: 'a' } };
      // NON-empty + DISTINCT from block 1 on purpose: an empty `{}` here would collide
      // with the adapter's empty/parse-failure default `args = {}`, so a misrouting bug
      // that emptied block 0 would be indistinguishable from a correct empty call. A
      // distinct value makes calls[0].arguments bite cross-index buffer corruption.
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"j":2}' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_b', name: 'b' } };
      yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"k":1}' } };
      yield { type: 'content_block_stop', index: 1 };
      yield { type: 'message_delta', usage: { input_tokens: 4, output_tokens: 3 }, delta: { stop_reason: 'tool_use' } };
      yield { type: 'message_stop' };
    }) as never);

    const events: ProviderEvent[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'do two things' }],
      tools: [
        { name: 'a', description: 'a', input_schema: { type: 'object', properties: {} } },
        { name: 'b', description: 'b', input_schema: { type: 'object', properties: {} } },
      ],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    const calls = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id)).toEqual(['tu_a', 'tu_b']);
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
    // Assert BOTH payloads — each block's input_json must land in its OWN per-index
    // buffer. Asserting only calls[1] left a cross-index corruption of block 0 invisible.
    // Map-then-compare (rather than calls[0]/[1] index access) keeps it bounds-safe
    // under strict typing without a non-null assertion.
    expect(calls.map((c) => c.arguments)).toEqual([{ j: 2 }, { k: 1 }]);
  });

  // #4 (minor) — stop_reason:'max_tokens' maps to done.reason:'max_tokens' (parity
  // with the refusal/pause_turn tests).
  test('stream() maps stop_reason=max_tokens to done.reason=max_tokens (#4)', async () => {
    mockStream.mockImplementationOnce((async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'truncated' } };
      yield { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 4, output_tokens: 100 } };
      yield { type: 'message_stop' };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'long' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'max_tokens' });
  });
});
