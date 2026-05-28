import { describe, expect, mock, test } from 'bun:test';

const mockStream = mock(async function* () {
  yield { choices: [{ delta: { content: 'Hi' } }], usage: null };
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };
});

mock.module('openai', () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: mock(async (opts: { stream?: boolean }) => {
          if (opts.stream) return mockStream();
          return { id: 'cmpl_x' };
        }),
      },
    };
    constructor(_: unknown) {}
  },
}));

import { openai } from './openai.ts';

describe('openai provider', () => {
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

  test('testKey() returns ok on a 200 from the mock', async () => {
    const r = await openai.testKey({ apiKey: 'sk', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(true);
  });
});
