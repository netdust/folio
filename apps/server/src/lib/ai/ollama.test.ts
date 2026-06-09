import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ollama } from './ollama.ts';

// NOTE: this file overrides `global.fetch` instead of using `mock.module(...)`,
// but the same hazard applies — `global.fetch` is process-global. The
// `afterEach` below restores the original; if a future test forgets to swap
// it back, ALL subsequent fetch calls in the bun-test process (other test
// files included) will hit the stale mock. See
// memory/feedback_mock-module-leaks-across-bun-tests.md.

const originalFetch = global.fetch;

function jsonl(lines: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(JSON.stringify(l) + '\n'));
      controller.close();
    },
  });
}

describe('ollama provider', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('stream() yields text + tokens + done from /api/chat NDJSON', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            { message: { content: 'Hi ' }, done: false },
            { message: { content: 'there' }, done: false },
            {
              message: { content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 7,
              eval_count: 2,
            },
          ]),
          { status: 200 },
        ),
    ) as never;

    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi ' });
    expect(events).toContainEqual({ type: 'text', delta: 'there' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 2 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200', async () => {
    global.fetch = mock(async () => new Response('{}', { status: 200 })) as never;
    const r = await ollama.testKey({
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    });
    expect(r.ok).toBe(true);
  });

  test('testKey() returns failure on connection refused', async () => {
    global.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    const r = await ollama.testKey({
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    });
    expect(r.ok).toBe(false);
  });

  // B round 3 fix #3 — Ollama testKey must mirror the openai/anthropic
  // whitelist: never echo the base URL, model name, or raw error message
  // into the reason string. The pre-fix shape interpolated `${base}` and
  // `${model}` into the reason, which surfaces in the AI tab DOM + log
  // shippers.
  test('testKey() network error does not echo baseUrl or proxy hostname', async () => {
    global.fetch = mock(async () => {
      throw new Error('ECONNREFUSED at internal.proxy.example.com:8080');
    }) as never;
    const r = await ollama.testKey({
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://internal-ollama.lan:11434',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/network|unreachable/i);
      expect(r.reason).not.toMatch(/proxy\.example/);
      expect(r.reason).not.toMatch(/internal-ollama/);
      expect(r.reason).not.toMatch(/ECONNREFUSED/);
    }
  });

  test('testKey() 404 does not echo the model name', async () => {
    global.fetch = mock(async () => new Response('not found', { status: 404 })) as never;
    const r = await ollama.testKey({
      apiKey: '',
      model: 'org/secret-internal-model:v17',
      baseUrl: 'http://internal-ollama.lan:11434',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/secret-internal-model/);
      expect(r.reason).not.toMatch(/internal-ollama/);
    }
  });

  test('stream() parses the trailing NDJSON record even without a final newline', async () => {
    // A sloppy proxy can drop the final \n. Pre-fix the trailing record sat
    // in `buffer` and was silently discarded — the generator yielded a
    // fake-success done.reason='stop' with tokens=0/0 instead of the real
    // done_reason + token counts. Verify the flush picks it up.
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(JSON.stringify({ message: { content: 'Hi' }, done: false }) + '\n'),
        );
        // No trailing newline on the final record.
        controller.enqueue(
          enc.encode(
            JSON.stringify({
              message: { content: '' },
              done: true,
              done_reason: 'length',
              prompt_eval_count: 7,
              eval_count: 99,
            }),
          ),
        );
        controller.close();
      },
    });
    global.fetch = mock(async () => new Response(body, { status: 200 })) as never;

    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 99 });
    expect(events).toContainEqual({ type: 'done', reason: 'max_tokens' });
  });

  // G1 — TRUNCATED stream (no terminal `done:true` chunk ever arrives — a proxy
  // dropped the connection mid-stream). The adapter must NOT emit a fake-success
  // `done:'stop'`; it must emit NO `done` event, so the runner's FIX#2
  // (doneReason===undefined → provider_error) fires and the run fails loudly
  // rather than recording a truncated generation as a clean completion.
  test('stream() does NOT emit a done event when the stream ends with no terminal chunk (G1)', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Text chunks arrive, then the stream just ENDS — no `done:true` chunk.
        controller.enqueue(enc.encode(JSON.stringify({ message: { content: 'partial ' }, done: false }) + '\n'));
        controller.enqueue(enc.encode(JSON.stringify({ message: { content: 'answer' }, done: false }) + '\n'));
        controller.close(); // connection dropped before the terminal chunk
      },
    });
    global.fetch = mock(async () => new Response(body, { status: 200 })) as never;

    const events: any[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    // The partial text surfaced...
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(0);
    // ...but NO done event — the runner's FIX#2 must see doneReason===undefined.
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
  });

  // B round 4 fix #2 — stream() startup error throw must NOT echo the raw
  // response statusText (which proxies populate with internal hostnames + path
  // fragments) or the base URL. Mirror the testKey whitelist on the throw.
  test('stream() throws a sanitized error on 502, no statusText echo', async () => {
    global.fetch = mock(
      async () =>
        new Response('', {
          status: 502,
          statusText: 'Cannot reach upstream ollama-7.internal.svc.cluster.local',
        }),
    ) as never;
    let caught: unknown;
    try {
      const iter = ollama.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 10,
        apiKey: '',
        model: 'llama3.1',
        baseUrl: 'http://example.com:11434',
      });
      for await (const _ of iter) {
        // drain
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/internal\.svc\.cluster/);
    expect(message).not.toMatch(/example\.com/);
    expect(message).toMatch(/server error/i);
  });

  test('stream() throws sanitized error on 401, no statusText echo', async () => {
    global.fetch = mock(
      async () =>
        new Response('', {
          status: 401,
          statusText: 'Token rejected by internal-auth-proxy.lan:8443',
        }),
    ) as never;
    let caught: unknown;
    try {
      const iter = ollama.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 10,
        apiKey: '',
        model: 'llama3.1',
        baseUrl: 'http://example.com:11434',
      });
      for await (const _ of iter) {
        // drain
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toMatch(/internal-auth-proxy/);
    expect(message).toMatch(/unauthorized/i);
  });

  // B round 4 fix #7 — token counts must be integer. Number('7.5') is 7.5;
  // pre-fix the fractional value propagated into the tokens event + SQLite
  // REAL column with IEEE-754 drift on SUM for budget accounting. Math.trunc
  // pins the type at the boundary.
  test('stream() truncates fractional token counts to integers', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            { message: { content: 'Hi' }, done: false },
            {
              message: { content: '' },
              done: true,
              done_reason: 'stop',
              // Proxy / sloppy stringifier could send fractional numbers
              // (or strings that Number() coerces to fractions).
              prompt_eval_count: 7.5,
              eval_count: 99.9,
            },
          ]),
          { status: 200 },
        ),
    ) as never;
    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://example.com:11434',
    })) {
      events.push(ev);
    }
    // Truncated, not rounded — Math.trunc(7.5) === 7, Math.trunc(99.9) === 99.
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 99 });
  });

  // B round 5 #9 — Math.max(0, ...) clamp. Round 4's Math.trunc pinned the
  // type but not the sign. Number('-7') passes isFinite and Math.trunc keeps
  // the sign, so a malformed proxy payload with a negative count propagated
  // into the accumulator + the tokens event. agent_run_schema.ts z.nonnegative
  // would catch it downstream but the source should clamp.
  test('stream() clamps negative token counts to 0', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            { message: { content: 'Hi' }, done: false },
            {
              message: { content: '' },
              done: true,
              done_reason: 'stop',
              // Malformed proxy could send negatives. Pre-fix these
              // propagated as -7 / -3 into the tokens event.
              prompt_eval_count: -7,
              eval_count: -3,
            },
          ]),
          { status: 200 },
        ),
    ) as never;
    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://example.com:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 0, tokens_out: 0 });
  });

  test('stream() skips malformed NDJSON lines and still yields done', async () => {
    // Hand-roll the body so we can inject a literally-malformed line between
    // two valid JSON lines (jsonl() JSON-encodes everything, including strings).
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(JSON.stringify({ message: { content: 'Hi' }, done: false }) + '\n'),
        );
        controller.enqueue(enc.encode('not-json-at-all\n'));
        controller.enqueue(
          enc.encode(
            JSON.stringify({
              message: { content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 4,
              eval_count: 1,
            }) + '\n',
          ),
        );
        controller.close();
      },
    });
    global.fetch = mock(async () => new Response(body, { status: 200 })) as never;

    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 4, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  // qwen3 (and other thinking models) emit a `tool_calls` chunk but then finish
  // the stream with `done_reason: 'stop'` (NOT 'tool_calls') — reasoning went to
  // `message.thinking`, `content` is empty. The adapter SURFACES the tool_call and
  // reports the HONEST done.reason ('stop'); the runner derives "run the tool round"
  // from the collected call, not from this label (the convergence point lives in
  // runner.ts — see runner.test.ts "ALTITUDE — a collected tool_call with
  // done.reason=stop still runs the tool round"). The adapter does NOT relabel.
  test("stream() surfaces the tool_call and reports the honest done.reason 'stop' (no relabel)", async () => {
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            // qwen3 thinking arrives under message.thinking; content stays empty.
            { message: { role: 'assistant', content: '', thinking: 'I should list' }, done: false },
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'list_workspaces', arguments: {} } }],
              },
              done: false,
            },
            // The kicker: the final chunk reports 'stop', not 'tool_calls'.
            {
              message: { content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 10,
              eval_count: 5,
            },
          ]),
          { status: 200 },
        ),
    ) as never;

    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'list workspaces' }],
      tools: [
        { name: 'list_workspaces', description: 'List workspaces.', input_schema: { type: 'object', properties: {} } },
      ],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    // The tool call must surface (this is what the runner gates the round on)...
    expect(events).toContainEqual({
      type: 'tool_call',
      id: expect.any(String),
      name: 'list_workspaces',
      arguments: {},
    });
    // ...AND the done.reason is the HONEST 'stop' the model reported — the adapter
    // no longer relabels it to tool_use (the runner derives that from the call).
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  // --- Hardening: the REQUEST body (think:false + tool_calls echo) was wholly
  // untested — tests only mocked the RESPONSE (wire-mock-leak blind spot). These
  // capture what the adapter actually SENDS to Ollama. ---

  // Capture the request body a single stream() call sends. Drains the stream so
  // the generator runs to completion (the body is built before the first chunk,
  // but draining keeps the mock + reader lifecycle honest).
  async function captureRequestBody(args: Parameters<typeof ollama.stream>[0]): Promise<any> {
    let sentBody: any;
    global.fetch = mock(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(
        jsonl([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }]),
        { status: 200 },
      );
    }) as never;
    for await (const _ of ollama.stream(args)) {
      /* drain */
    }
    return sentBody;
  }

  test('stream() sends think:false so reasoning models do not pay the <think> tax', async () => {
    const body = await captureRequestBody({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    });
    expect(body.think).toBe(false);
  });

  test('stream() echoes assistant tool_calls back so a follow-up tool result correlates', async () => {
    const body = await captureRequestBody({
      system: 'sys',
      messages: [
        { role: 'user', content: 'list' },
        // The assistant turn that called a tool (what the runner replays each round).
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'list_workspaces', arguments: { q: 'x' } }] },
        { role: 'tool', content: '{"ok":true}', tool_use_id: 'call_1' },
      ],
      tools: [
        { name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } },
      ],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    });
    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls[0].id).toBe('call_1');
    expect(assistant.tool_calls[0].function.name).toBe('list_workspaces');
    // Ollama takes arguments as an OBJECT (not OpenAI's JSON string) — regression
    // guard: if someone "harmonizes" this with the OpenAI adapter's JSON.stringify,
    // Ollama silently ignores the call and the multi-round chain breaks.
    expect(assistant.tool_calls[0].function.arguments).toEqual({ q: 'x' });
    // The tool result must carry the correlation id back.
    const tool = body.messages.find((m: any) => m.role === 'tool');
    expect(tool.tool_call_id).toBe('call_1');
  });

  test('stream() does NOT add tool_calls to a plain assistant message (no tools called)', async () => {
    const body = await captureRequestBody({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' }, // no tool_calls
      ],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    });
    const assistant = body.messages.find((m: any) => m.content === 'hello there');
    expect(assistant.tool_calls).toBeUndefined();
  });

  // --- Hardening: stopReason precedence + per-stream state isolation. ---

  test("stream() prefers max_tokens over tool_use when a tool call is TRUNCATED (done_reason 'length')", async () => {
    // A tool call that streamed but the model hit the token cap mid-call: the
    // partial call is unusable, so truncation must win — NOT tool_use.
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            {
              message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_workspaces', arguments: {} } }] },
              done: false,
            },
            { message: { content: '' }, done: true, done_reason: 'length' },
          ]),
          { status: 200 },
        ),
    ) as never;
    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 1,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'max_tokens' });
    expect(events).not.toContainEqual({ type: 'done', reason: 'tool_use' });
  });

  test('stream() does NOT leak tool_call events across calls — a tool-less turn after a tool turn emits no calls', async () => {
    // The adapter emits tool_call events per-stream. A tool turn must not bleed its
    // tool_call event into a later tool-less turn. (done.reason is the honest 'stop'
    // for both — the runner decides the tool round from the collected calls.)
    const toolStream = () =>
      new Response(
        jsonl([
          { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_workspaces', arguments: {} } }] }, done: false },
          { message: { content: '' }, done: true, done_reason: 'stop' },
        ]),
        { status: 200 },
      );
    const plainStream = () =>
      new Response(jsonl([{ message: { content: 'just text' }, done: true, done_reason: 'stop' }]), { status: 200 });

    const baseArgs = {
      system: 'sys',
      messages: [{ role: 'user' as const, content: 'x' }],
      tools: [{ name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    };

    // Turn 1: a tool turn → surfaces the call, honest 'stop' reason.
    global.fetch = mock(async () => toolStream()) as never;
    const r1: any[] = [];
    for await (const ev of ollama.stream(baseArgs)) r1.push(ev);
    expect(r1.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(r1).toContainEqual({ type: 'done', reason: 'stop' });

    // Turn 2 (fresh call): plain text, NO tool call → ZERO tool_call events, 'stop'.
    global.fetch = mock(async () => plainStream()) as never;
    const r2: any[] = [];
    for await (const ev of ollama.stream(baseArgs)) r2.push(ev);
    expect(r2.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    expect(r2).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('stream() surfaces MULTIPLE tool calls in one chunk (honest done.reason stop)', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { function: { name: 'list_workspaces', arguments: {} } },
                  { function: { name: 'list_projects', arguments: { workspace_slug: 'acme' } } },
                ],
              },
              done: false,
            },
            { message: { content: '' }, done: true, done_reason: 'stop' },
          ]),
          { status: 200 },
        ),
    ) as never;
    const events: any[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } },
        { name: 'list_projects', description: 'List.', input_schema: { type: 'object', properties: {} } },
      ],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
    expect(calls).toEqual(['list_workspaces', 'list_projects']);
    // Honest done.reason — the runner runs the round from the two collected calls.
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test("stream() maps an EXPLICIT done_reason 'tool_calls' to tool_use", async () => {
    // A well-behaved (non-thinking) model that DOES send done_reason 'tool_calls'
    // maps to tool_use via the explicit label path — unchanged by the altitude fix.
    global.fetch = mock(
      async () =>
        new Response(
          jsonl([
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: {} } }] }, done: false },
            { message: { content: '' }, done: true, done_reason: 'tool_calls' },
          ]),
          { status: 200 },
        ),
    ) as never;
    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'done', reason: 'tool_use' });
  });

  test('stream() echoes MULTIPLE assistant tool_calls from history (parallel calls), each correlated', async () => {
    // A prior turn that made TWO parallel tool calls must replay BOTH in the
    // request, each with its own id, or one of the follow-up tool results is orphaned.
    let sentBody: any;
    global.fetch = mock(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(jsonl([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }]), { status: 200 });
    }) as never;
    for await (const _ of ollama.stream({
      system: 'sys',
      messages: [
        { role: 'user', content: 'do two things' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', name: 'list_workspaces', arguments: {} },
            { id: 'c2', name: 'list_projects', arguments: { workspace_slug: 'qa' } },
          ],
        },
        { role: 'tool', content: '{"a":1}', tool_use_id: 'c1' },
        { role: 'tool', content: '{"b":2}', tool_use_id: 'c2' },
      ],
      tools: [
        { name: 'list_workspaces', description: 'List.', input_schema: { type: 'object', properties: {} } },
        { name: 'list_projects', description: 'List.', input_schema: { type: 'object', properties: {} } },
      ],
      maxTokens: 100,
      apiKey: '',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434',
    })) {
      /* drain */
    }
    const assistant = sentBody.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistant.tool_calls).toHaveLength(2);
    expect(assistant.tool_calls.map((t: any) => t.id)).toEqual(['c1', 'c2']);
    expect(assistant.tool_calls.map((t: any) => t.function.name)).toEqual(['list_workspaces', 'list_projects']);
    // Both tool results carry their correlation ids.
    const toolIds = sentBody.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
    expect(toolIds).toEqual(['c1', 'c2']);
  });

  test('stream() handles two CONCURRENT streams without state bleed', async () => {
    // `stopReason` + the tool_call emission live in a per-call `const state`. Two
    // streams driven concurrently must not cross-contaminate: the tool turn surfaces
    // its call, the plain turn surfaces none, both report the honest 'stop'.
    const toolBody = () =>
      new Response(
        jsonl([
          { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: {} } }] }, done: false },
          { message: { content: '' }, done: true, done_reason: 'stop' },
        ]),
        { status: 200 },
      );
    const plainBody = () => new Response(jsonl([{ message: { content: 'hi' }, done: true, done_reason: 'stop' }]), { status: 200 });

    let n = 0;
    global.fetch = mock(async () => {
      n += 1;
      return n === 1 ? toolBody() : plainBody();
    }) as never;

    const drain = async () => {
      const evs: any[] = [];
      for await (const ev of ollama.stream({
        system: 'sys', messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'f', description: 'f', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 100, apiKey: '', model: 'qwen3:8b', baseUrl: 'http://localhost:11434',
      })) evs.push(ev);
      return evs;
    };
    const [a, b] = await Promise.all([drain(), drain()]);
    // First fetch → tool turn → surfaces its call; second → plain → no calls.
    // Both report honest 'stop'. No tool_call bleed between the concurrent streams.
    expect(a.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(b.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    expect(a).toContainEqual({ type: 'done', reason: 'stop' });
    expect(b).toContainEqual({ type: 'done', reason: 'stop' });
  });

  // B round 6 #3 — `Number.isFinite(Number(x))` regression: ''/null/false/[]
  // all coerce to 0 and clobber the running accumulator to 0. The new
  // type-guard accepts number-typed values or digits-only strings; everything
  // else preserves the running total. Tests run two done chunks: first sets
  // a non-zero running total, second carries a falsy value — the final tokens
  // event MUST show the preserved value, not 0.
  describe('round 6 #3 — falsy token-count preservation', () => {
    async function streamAndCollect(falsyValue: unknown): Promise<unknown[]> {
      global.fetch = mock(
        async () =>
          new Response(
            jsonl([
              // First done chunk: sets tokensIn=42, tokensOut=13.
              {
                message: { content: '' },
                done: true,
                done_reason: 'stop',
                prompt_eval_count: 42,
                eval_count: 13,
              },
              // Second done chunk: falsy value MUST be ignored, not clobber to 0.
              {
                message: { content: '' },
                done: true,
                done_reason: 'stop',
                prompt_eval_count: falsyValue,
                eval_count: falsyValue,
              },
            ]),
            { status: 200 },
          ),
      ) as never;
      const events: unknown[] = [];
      for await (const ev of ollama.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxTokens: 100,
        apiKey: '',
        model: 'llama3.1',
        baseUrl: 'http://example.com:11434',
      })) {
        events.push(ev);
      }
      return events;
    }

    test('empty string preserves running tokensIn/tokensOut', async () => {
      const events = await streamAndCollect('');
      expect(events).toContainEqual({ type: 'tokens', tokens_in: 42, tokens_out: 13 });
    });

    test('null preserves running tokensIn/tokensOut', async () => {
      const events = await streamAndCollect(null);
      expect(events).toContainEqual({ type: 'tokens', tokens_in: 42, tokens_out: 13 });
    });

    test('false preserves running tokensIn/tokensOut', async () => {
      const events = await streamAndCollect(false);
      expect(events).toContainEqual({ type: 'tokens', tokens_in: 42, tokens_out: 13 });
    });

    test('empty array preserves running tokensIn/tokensOut', async () => {
      const events = await streamAndCollect([]);
      expect(events).toContainEqual({ type: 'tokens', tokens_in: 42, tokens_out: 13 });
    });

    test('digits-only string coerces (round-5 intent — "7" → 7)', async () => {
      const events = await streamAndCollect('7');
      // Second chunk's '7' replaces the first chunk's 42.
      expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 7 });
    });

    test('non-numeric string preserves running total', async () => {
      const events = await streamAndCollect('abc');
      expect(events).toContainEqual({ type: 'tokens', tokens_in: 42, tokens_out: 13 });
    });
  });
});
