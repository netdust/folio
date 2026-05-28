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
});
