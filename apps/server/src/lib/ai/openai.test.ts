import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

mock.module('openai', () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
    constructor(_: unknown) {}
  },
}));

import { openai } from './openai.ts';

describe('openai provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
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

  test('testKey() returns ok on a 200 from the mock', async () => {
    const r = await openai.testKey({ apiKey: 'sk', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(true);
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
