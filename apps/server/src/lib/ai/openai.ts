import OpenAI from 'openai';
import type { AIProvider, Message, ProviderEvent } from './provider.ts';
import { sanitizeProviderError } from './sanitize-error.ts';

function client(apiKey: string, baseUrl?: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

function toOpenAIMessages(
  system: string,
  messages: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.tool_use_id });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/**
 * B round 5 #5/#6 — internal stream impl that threads a `providerName` through
 * sanitizeProviderError. openai.stream calls this with 'OpenAI'; openrouter
 * delegates with 'OpenRouter' so the surfaced message names the correct
 * upstream rather than misleading operators with 'OpenAI' on an OpenRouter
 * outage. Exported for use by openrouter.ts; not part of the AIProvider
 * interface (which deliberately has no providerName param — that would force
 * every caller to know the provider's display string).
 */
export async function* streamOpenAICompatible({
  system,
  messages,
  tools,
  maxTokens,
  apiKey,
  model,
  baseUrl,
  providerName,
}: Parameters<AIProvider['stream']>[0] & { providerName: string }): AsyncGenerator<ProviderEvent> {
  const c = client(apiKey, baseUrl);
  // B round 5 #5 — sanitize stream-startup throws. OpenAI's
  // `chat.completions.create({stream: true})` returns a Promise that resolves
  // to the iterator; auth/network errors fire on this await BEFORE the
  // for-await loop begins. Pre-fix the raw e.message propagated to the
  // runner — embedding partial keys + proxy host details. Mitigation 5.
  let stream;
  try {
    stream = await c.chat.completions.create({
      model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(system, messages),
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    });
  } catch (err) {
    throw new Error(sanitizeProviderError(err, providerName));
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let stopReason: 'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' = 'stop';
  // OpenAI streams tool_calls with `id` ONLY on the first delta per call;
  // continuation deltas carry only `index` + arg fragments. Key by `index`
  // (always present) and track id/name as separate fields set on first sight.
  const toolCallsByIndex: Record<number, { id: string; name: string; argsBuf: string }> = {};

  // B round 5 #5 — also wrap the iteration. Network failures mid-stream
  // arrive as throws from the for-await; same sanitize contract.
  try {
    for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (choices?.[0]) {
        const delta = choices[0].delta as
          | {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                // The OpenAI SDK type marks `function` as optional —
                // marker deltas like {index: N} appear in the wild between
                // parallel tool_calls. Match the SDK shape so we don't
                // assume the field is always present.
                function?: { name?: string; arguments?: string };
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
            if (tc.function?.name) entry.name = tc.function.name;
            entry.argsBuf += tc.function?.arguments ?? '';
          }
        }
        const finish = choices[0].finish_reason as string | undefined;
        if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'length') stopReason = 'max_tokens';
        else if (finish === 'content_filter') stopReason = 'refusal';
      }
      const usage = chunk.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | null
        | undefined;
      if (usage?.prompt_tokens !== undefined) tokensIn = usage.prompt_tokens;
      if (usage?.completion_tokens !== undefined) tokensOut = usage.completion_tokens;
    }
  } catch (err) {
    throw new Error(sanitizeProviderError(err, providerName));
  }

  for (const tc of Object.values(toolCallsByIndex)) {
    let args: Record<string, unknown> = {};
    if (tc.argsBuf) {
      try {
        args = JSON.parse(tc.argsBuf) as Record<string, unknown>;
      } catch (err) {
        // Malformed tool_call args buffer (truncated/garbled stream). Emit the
        // tool_call event with empty args so the runner still sees the attempt;
        // don't crash the generator before the trailing tokens/done events.
        // Warn so operators have a grep target when an agent run goes sideways
        // — silent {} is indistinguishable from a legitimate {} call.
        console.warn(
          '[ai/openai] dropped malformed tool_call JSON in stream:',
          err instanceof Error ? err.message : err,
        );
        args = {};
      }
    }
    yield {
      type: 'tool_call',
      id: tc.id,
      name: tc.name,
      arguments: args,
    } as ProviderEvent;
  }

  yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
  yield { type: 'done', reason: stopReason };
}

export const openai: AIProvider = {
  stream: (opts) => streamOpenAICompatible({ ...opts, providerName: 'OpenAI' }),

  async testKey({ apiKey, baseUrl }) {
    try {
      const c = client(apiKey, baseUrl);
      // models.list validates the key without invoking a chat completion;
      // avoids the max_tokens-vs-max_completion_tokens rejection on o1/o3.
      // testKey validates the KEY only — the model string is validated on
      // the first real stream() call.
      await c.models.list();
      return { ok: true };
    } catch (err) {
      // Round 6 #7 — migrated to the shared sanitizeProviderError helper.
      // The inline whitelist this used to carry is now centralized; same
      // contract (NEVER echo e.message, NEVER echo apiKey/baseUrl/model).
      // Helper preserves the 401/403 distinction the inline version had.
      return { ok: false, reason: sanitizeProviderError(err, 'OpenAI') };
    }
  },
};
