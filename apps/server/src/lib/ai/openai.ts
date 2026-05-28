import OpenAI from 'openai';
import type { AIProvider, Message, ProviderEvent } from './provider.ts';

function client(apiKey: string, baseUrl?: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

function toOpenAIMessages(system: string, messages: Message[]) {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.tool_use_id });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const openai: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model, baseUrl }) {
    const c = client(apiKey, baseUrl);
    const stream = await c.chat.completions.create({
      model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(system, messages) as never,
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    });

    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';
    // OpenAI streams tool_calls with `id` ONLY on the first delta per call;
    // continuation deltas carry only `index` + arg fragments. Key by `index`
    // (always present) and track id/name as separate fields set on first sight.
    const toolCallsByIndex: Record<number, { id: string; name: string; argsBuf: string }> = {};

    for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (choices?.[0]) {
        const delta = choices[0].delta as
          | {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function: { name?: string; arguments?: string };
              }>;
            }
          | undefined;
        if (delta?.content) yield { type: 'text', delta: delta.content } as ProviderEvent;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const entry =
              toolCallsByIndex[tc.index] ??
              (toolCallsByIndex[tc.index] = { id: '', name: '', argsBuf: '' });
            if (tc.id) entry.id = tc.id;
            if (tc.function.name) entry.name = tc.function.name;
            entry.argsBuf += tc.function.arguments ?? '';
          }
        }
        const finish = choices[0].finish_reason as string | undefined;
        if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'length') stopReason = 'max_tokens';
      }
      const usage = chunk.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | null
        | undefined;
      if (usage?.prompt_tokens) tokensIn = usage.prompt_tokens;
      if (usage?.completion_tokens) tokensOut = usage.completion_tokens;
    }

    for (const tc of Object.values(toolCallsByIndex)) {
      yield {
        type: 'tool_call',
        id: tc.id,
        name: tc.name,
        arguments: tc.argsBuf ? JSON.parse(tc.argsBuf) : {},
      } as ProviderEvent;
    }

    yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ apiKey, model, baseUrl }) {
    try {
      const c = client(apiKey, baseUrl);
      await c.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) return { ok: false, reason: 'Unauthorized (401): key rejected by OpenAI.' };
      if (e.status === 404) return { ok: false, reason: `Model not found (404): ${model}` };
      return { ok: false, reason: e.message ?? 'Unknown error' };
    }
  },
};
