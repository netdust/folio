import { beforeEach, describe, expect, mock, test } from 'bun:test';

// NOTE: Bun's `mock.module(...)` is process-global and leaks across test files
// within the same `bun test` run. The `openai` stub below covers only the SDK
// surface this provider actually uses (chat.completions.create + models.list);
// if a future test exercises other surfaces, the stub will return undefined
// and the test will fail with a cryptic error in a different file. See
// memory/feedback_mock-module-leaks-across-bun-tests.md.

const defaultStream = mock(async function* () {
  yield { choices: [{ delta: { content: 'Hi' } }], usage: null };
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };
});

const mockCreate = mock(async (opts: { stream?: boolean }) => {
  if (opts.stream) return defaultStream();
  return { id: 'cmpl_x' };
});
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

import { openai } from './openai.ts';

describe('openai provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockModelsList.mockClear();
  });

  test('stream() yields text + tokens + done', async () => {
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 4, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200 from the models.list mock', async () => {
    mockModelsList.mockImplementationOnce(async () => ({ data: [{ id: 'gpt-4o-mini' }] }));
    const r = await openai.testKey({ apiKey: 'sk', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(true);
  });

  test('testKey() does not call chat.completions with max_tokens (avoids o1/o3 rejection)', async () => {
    mockCreate.mockClear();
    mockModelsList.mockImplementationOnce(async () => ({ data: [{ id: 'o1-mini' }] }));
    const r = await openai.testKey({ apiKey: 'sk', model: 'o1-mini' });
    expect(r.ok).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('stream() correctly assembles a multi-chunk tool_call when id only appears on first chunk', async () => {
    // OpenAI streams tool_calls with `id` ONLY on the first delta;
    // continuation deltas carry only `index` + arg fragments.
    const multiChunkStream = async function* () {
      // First chunk: id + name + opening of args JSON.
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_abc', function: { name: 'search', arguments: '{"q":"hel' } },
              ],
            },
          },
        ],
        usage: null,
      };
      // Continuation chunk: NO id, NO name — only index + partial args.
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'lo"}' } }],
            },
          },
        ],
        usage: null,
      };
      // Final chunk: finish_reason + usage.
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      };
    };

    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (opts.stream) return multiChunkStream();
      return { id: 'cmpl_x' };
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'x', input_schema: { type: 'object' } }],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }

    const toolCalls = events.filter((e) => (e as { type: string }).type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: 'tool_call',
      id: 'call_abc',
      name: 'search',
      arguments: { q: 'hello' },
    });
  });

  test('stream() records usage.prompt_tokens=0 and completion_tokens=0 on the final chunk', async () => {
    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (!opts.stream) return { id: 'cmpl_x' };
      return (async function* () {
        // Interim chunk reports non-zero usage.
        yield {
          choices: [{ delta: { content: '' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        };
        // Final chunk legitimately reports 0/0 (e.g. content_filter stop).
        yield {
          choices: [{ delta: {}, finish_reason: 'content_filter' }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 0, tokens_out: 0 });
  });

  test('stream() maps finish_reason=content_filter to done.reason=refusal', async () => {
    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (!opts.stream) return { id: 'cmpl_x' };
      return (async function* () {
        yield { choices: [{ delta: { content: 'I cannot' } }], usage: null };
        yield {
          choices: [{ delta: {}, finish_reason: 'content_filter' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys', messages: [{ role: 'user', content: 'do bad thing' }],
      tools: [], maxTokens: 100, apiKey: 'sk', model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'refusal' });
  });

  test('stream() handles a tool_call delta with no function field (marker chunk)', async () => {
    // The OpenAI SDK types ToolCall.function as optional. A marker delta
    // {index: N} with no function field appears in the wild (e.g. between
    // parallel tool_calls). Pre-fix this crashed the generator with a
    // TypeError on `tc.function.name` before the trailing tokens/done fired.
    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (!opts.stream) return { id: 'cmpl_x' };
      return (async function* () {
        // Marker delta — no function field.
        yield { choices: [{ delta: { tool_calls: [{ index: 0 }] } }], usage: null };
        // Follow-up with the real first chunk for the same index.
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_a', function: { name: 'f', arguments: '{}' } },
                ],
              },
            },
          ],
          usage: null,
        };
        yield {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'tool_use' });
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call_a',
      name: 'f',
      arguments: {},
    });
  });

  // B round 2 fix #9 — testKey() must NOT surface raw SDK e.message on
  // non-401 paths. SDK error strings can embed partial credentials, request
  // IDs, and proxy details. Whitelist by status only.
  test('testKey() reports rate-limit cleanly without leaking SDK message', async () => {
    mockModelsList.mockImplementationOnce(async () => {
      const err = new Error('Rate limit hit; key sk-...XYZ at 1234567/min') as Error & {
        status: number;
      };
      err.status = 429;
      throw err;
    });
    const r = await openai.testKey({ apiKey: 'sk-bad', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/rate limit/i);
      expect(r.reason).not.toMatch(/sk-/i); // no key leak
      expect(r.reason).not.toMatch(/1234567/); // no specifics from the message
    }
  });

  test('testKey() reports network error cleanly without leaking proxy details', async () => {
    mockModelsList.mockImplementationOnce(async () => {
      // No status field — looks like a fetch/connect error.
      throw new Error('ECONNREFUSED at internal.proxy.example.com:8080');
    });
    const r = await openai.testKey({ apiKey: 'sk', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/network|unreachable/i);
      expect(r.reason).not.toMatch(/proxy\.example/);
      expect(r.reason).not.toMatch(/ECONNREFUSED/);
    }
  });

  // B round 5 #5 — round 4 mitigation 5 enriched the contract to cover
  // openai.stream startup throws, but only ollama.stream wrapped its throws
  // in code. openai.stream propagated the raw SDK error message on the
  // create() await — embedding partial keys and proxy hostnames. The await
  // is now try/catch'd; the throw rewrites to the same testKey whitelist.
  test('stream() sanitizes a 401 thrown by chat.completions.create (mitigation 5)', async () => {
    mockCreate.mockImplementationOnce((async () => {
      const err = new Error('Incorrect API key provided: sk-real-0123456789. See https://platform.openai.com/account/api-keys.') as Error & { status: number };
      err.status = 401;
      throw err;
    }) as never);

    let thrown: unknown;
    try {
      const iter = openai.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: 'sk-real-0123456789',
        model: 'gpt-4o-mini',
      });
      for await (const _ of iter) {
        // drain
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).not.toMatch(/sk-real/);
    expect(msg).not.toMatch(/platform\.openai\.com/);
    expect(msg).not.toMatch(/Incorrect API key/);
    expect(msg).toMatch(/unauthorized/i);
    expect(msg).toMatch(/OpenAI/);
  });

  // Round 7 #9 — coerceTokenCount applied to chunk.usage. Pre-round-7 the
  // round-4 `!== undefined` guard accepted any value as-is; a sloppy
  // OpenAI-compatible proxy emitting completion_tokens=7.5 propagated into
  // the agent_run REAL column (IEEE-754 drift on SUM for budget accounting).
  test('stream() coerces fractional prompt_tokens via truncation (round 7 #9)', async () => {
    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (!opts.stream) return { id: 'cmpl_x' };
      return (async function* () {
        yield { choices: [{ delta: { content: 'Hi' } }], usage: null };
        yield {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7.5, completion_tokens: 3 },
        };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 3 });
  });

  // Round 7 #7 — round 5 #5's try/catch covered the `await c.chat.create()`
  // but NOT the `new OpenAI({baseURL})` constructor. A synchronous throw
  // from the constructor (malformed baseURL) propagated raw pre-round-7.
  // The widened try now sanitizes those too.
  test('stream() sanitizes a synchronous throw from chat.completions.create (round 7 #7)', async () => {
    mockCreate.mockImplementationOnce((() => {
      // Synchronous throw (not async) — mimics the SDK's pre-stream argument
      // validation throwing before the Promise is even returned.
      throw new Error('Bad init: target=sk-real-12345 host=proxy.example.com:9999');
    }) as never);

    let thrown: unknown;
    try {
      const iter = openai.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: 'sk-real-12345',
        model: 'gpt-4o-mini',
      });
      for await (const _ of iter) {
        // drain
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // Contract: never leak the partial key, never leak the proxy host.
    // Status-less errors collapse to the generic network-error message
    // (matching ollama / anthropic network-error tests). What matters is
    // the raw SDK message body must NOT propagate.
    expect(msg).not.toMatch(/sk-real/);
    expect(msg).not.toMatch(/proxy\.example/);
    expect(msg).not.toMatch(/Bad init/);
  });

  // Round 7 #11 — flush skips entries with empty name (truncated marker
  // delta). Pre-round-7 the runner dispatcher received `name: ''` and
  // either no-op'd or threw 'unknown tool: '. The new skip drops the
  // event with a warn log instead.
  test('stream() drops tool_call with empty name (truncated marker delta, round 7 #11)', async () => {
    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (!opts.stream) return { id: 'cmpl_x' };
      return (async function* () {
        // Marker delta only — no id/name ever fills in.
        yield { choices: [{ delta: { tool_calls: [{ index: 0 }] } }], usage: null };
        yield {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    // No tool_call event should be emitted for the empty-name entry.
    const toolCalls = events.filter((e) => (e as { type: string }).type === 'tool_call');
    expect(toolCalls).toHaveLength(0);
    // Trailing events still fire.
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 2, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'tool_use' });
  });

  test('stream() yields done event even when tool_call args fail to JSON.parse', async () => {
    mockCreate.mockImplementationOnce((async (opts: { stream?: boolean }) => {
      if (!opts.stream) return { id: 'cmpl_x' };
      return (async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_abc', function: { name: 'f', arguments: '{"x' } },
                ],
              },
            },
          ],
          usage: null,
        };
        yield {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    // Tool call event still emitted but with empty args (malformed buffer).
    expect(events).toContainEqual({ type: 'tool_call', id: 'call_abc', name: 'f', arguments: {} });
    // Trailing events still fire.
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 2, tokens_out: 1 });
    expect(events.some((e) => (e as { type: string }).type === 'done')).toBe(true);
  });

  // --- Thinking-model hardening: the SAME class of bug fixed in the Ollama
  // adapter. OpenRouter serves qwen3 / deepseek-r1 over this OpenAI-compatible
  // path; those models emit tool calls with finish_reason 'stop' and stream
  // their visible turn under `reasoning`. ---

  test("stream() surfaces the tool_call and reports the honest finish_reason 'stop' (no relabel)", async () => {
    mockCreate.mockImplementationOnce((async (_opts: { stream?: boolean }) => {
      return (async function* () {
        // tool_call arrives across deltas (id first, then args)...
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_workspaces', arguments: '' } }] } }] };
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] };
        // ...but the model finishes with 'stop' (the thinking-model quirk), NOT 'tool_calls'.
        yield {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      })();
    }) as never);
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'list' }],
      tools: [{ name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'qwen/qwen3-8b',
    })) {
      events.push(ev);
    }
    // The call surfaces (what the runner gates the round on); done.reason is the
    // HONEST 'stop' the model reported — the adapter no longer relabels it.
    expect(events).toContainEqual({ type: 'tool_call', id: 'call_1', name: 'list_workspaces', arguments: {} });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test("stream() prefers max_tokens over tool_use when a tool call is truncated ('length')", async () => {
    mockCreate.mockImplementationOnce((async (_opts: { stream?: boolean }) => {
      return (async function* () {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a":' } }] } }] };
        yield {
          choices: [{ delta: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      })();
    }) as never);
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 1,
      apiKey: 'sk-test',
      model: 'qwen/qwen3-8b',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'max_tokens' });
    expect(events).not.toContainEqual({ type: 'done', reason: 'tool_use' });
  });

  // code-review #1 — reasoning/reasoning_content must NEVER be surfaced as `text`.
  // The runner accumulates every text event into textBuf, which is BOTH shown to
  // the user AND replayed as the assistant's prior content next round. On the normal
  // interleaved turn (reasoning deltas THEN content deltas, in SEPARATE chunks), an
  // earlier "surface reasoning as text" fix leaked the model's chain-of-thought into
  // the visible reply and the history. We match the Anthropic adapter: reasoning is
  // dropped (only `text_delta`/`content` becomes text). A reasoning-only turn with
  // no content + no tool call is honestly empty → "(no output)".
  test('stream() does NOT surface reasoning as text on a normal interleaved turn (content only)', async () => {
    mockCreate.mockImplementationOnce((async (_opts: { stream?: boolean }) => {
      return (async function* () {
        // Normal interleaving: reasoning deltas (content empty) THEN content deltas.
        yield { choices: [{ delta: { reasoning: 'Let me think, the user wants ' } }] };
        yield { choices: [{ delta: { reasoning: 'the capital.' } }] };
        yield { choices: [{ delta: { content: 'Paris' } }] };
        yield { choices: [{ delta: { content: '.' } }] };
        yield {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        };
      })();
    }) as never);
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'deepseek/deepseek-r1',
    })) {
      events.push(ev);
    }
    const texts = events.filter((e) => (e as { type: string }).type === 'text');
    // ONLY the content surfaces as text — the reasoning trace is dropped.
    expect(texts).toEqual([
      { type: 'text', delta: 'Paris' },
      { type: 'text', delta: '.' },
    ]);
  });

  test('stream() yields no text for a reasoning-only turn (honestly empty, not the chain-of-thought)', async () => {
    mockCreate.mockImplementationOnce((async (_opts: { stream?: boolean }) => {
      return (async function* () {
        yield { choices: [{ delta: { reasoning: 'thinking...' } }] };
        yield {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      })();
    }) as never);
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'deepseek/deepseek-r1',
    })) {
      events.push(ev);
    }
    expect(events.filter((e) => (e as { type: string }).type === 'text')).toHaveLength(0);
  });

  test('stream() handles two CONCURRENT streams without state bleed (separate tool_use vs stop)', async () => {
    // The streamer keeps per-call state (stopReason, toolCallsByIndex). Two streams
    // driven concurrently must not cross-contaminate: the tool turn surfaces its call,
    // the plain turn surfaces none, both report the honest 'stop' (the runner decides
    // the tool round from the collected calls, not from the done.reason label).
    const toolGen = async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    };
    const plainGen = async function* () {
      yield { choices: [{ delta: { content: 'hi' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    };
    let call = 0;
    mockCreate.mockImplementation((async (_opts: { stream?: boolean }) => {
      call += 1;
      return call === 1 ? toolGen() : plainGen();
    }) as never);

    const drain = async (model: string) => {
      const evs: any[] = [];
      for await (const ev of openai.stream({
        system: 'sys', messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 100, apiKey: 'sk', model,
      })) evs.push(ev);
      return evs;
    };

    // Run both at once (interleaved by the event loop).
    const [a, b] = await Promise.all([drain('qwen/qwen3-8b'), drain('gpt-4o-mini')]);
    // Tool stream surfaces its call; plain stream surfaces none. Both honest 'stop'.
    expect(a).toContainEqual({ type: 'tool_call', id: 'c1', name: 'f', arguments: {} });
    expect(a).toContainEqual({ type: 'done', reason: 'stop' });
    expect(b).toContainEqual({ type: 'done', reason: 'stop' });
    expect(b.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    mockCreate.mockImplementation((async (opts: { stream?: boolean }) => {
      if (opts.stream) return defaultStream();
      return { id: 'cmpl_x' };
    }) as never);
  });

  // --- Wire-mock-leak hardening: the request body (assistant tool_calls echo +
  // tool mapping) was never asserted — only parsed responses were. ---

  test('stream() echoes assistant tool_calls into the request so a follow-up tool result correlates', async () => {
    mockCreate.mockClear();
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [
        { role: 'user', content: 'list' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'list_workspaces', arguments: { q: 'x' } }] },
        { role: 'tool', content: '{"ok":true}', tool_use_id: 'call_1' },
      ],
      tools: [{ name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    // Inspect what was SENT, not just what came back.
    const sent = mockCreate.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: unknown; tool_calls?: any[]; tool_call_id?: string }>;
      tools?: Array<{ function: { name: string; parameters: unknown } }>;
    };
    const assistant = sent.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistant).toBeDefined();
    expect(assistant!.tool_calls![0].id).toBe('call_1');
    expect(assistant!.tool_calls![0].function.name).toBe('list_workspaces');
    // OpenAI takes arguments as a JSON STRING (the inverse of Ollama's object).
    expect(assistant!.tool_calls![0].function.arguments).toBe(JSON.stringify({ q: 'x' }));
    // Tool result carries the correlation id.
    const tool = sent.messages.find((m) => m.role === 'tool');
    expect(tool!.tool_call_id).toBe('call_1');
    // Tools map input_schema → function.parameters.
    expect(sent.tools![0]!.function.name).toBe('list_workspaces');
  });

  // G1 — a stream that ends mid-flight with NO finish_reason (a proxy clean-EOF)
  // must NOT emit a fake-success done. It emits NO done event → the runner's FIX#2
  // fails the run loudly.
  test('stream() does NOT emit a done event when the stream ends with no finish_reason (G1)', async () => {
    mockCreate.mockImplementationOnce((async (_opts: { stream?: boolean }) => {
      return (async function* () {
        // Text arrives, then the stream just ends — no chunk carries finish_reason.
        yield { choices: [{ delta: { content: 'partial' } }] };
        yield { choices: [{ delta: { content: ' answer' } }] };
      })();
    }) as never);

    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events.filter((e) => (e as { type: string }).type === 'text').length).toBeGreaterThan(0);
    expect(events.filter((e) => (e as { type: string }).type === 'done')).toHaveLength(0);
  });
});
