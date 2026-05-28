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
});
