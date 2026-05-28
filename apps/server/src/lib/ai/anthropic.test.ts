import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock the SDK module BEFORE importing the provider so the provider sees the mock.
const mockCreate = mock(async () => ({}));
const mockStream = mock(async function* () {
  yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 1 } };
  yield { type: 'message_stop' };
});

mock.module('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate, stream: () => mockStream() };
    constructor(_: unknown) {}
  },
}));

import { anthropic } from './anthropic.ts';

describe('anthropic provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockStream.mockClear();
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
    mockCreate.mockImplementationOnce(async () => ({ id: 'msg_x' }));
    const result = await anthropic.testKey({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(true);
  });

  test('testKey() returns structured failure on 401', async () => {
    mockCreate.mockImplementationOnce(async () => {
      const err = new Error('Unauthorized') as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const result = await anthropic.testKey({ apiKey: 'sk-bad', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unauth|401/i);
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
