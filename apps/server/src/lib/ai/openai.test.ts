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
});
