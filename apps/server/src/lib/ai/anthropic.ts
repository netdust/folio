import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ProviderEvent } from './provider.ts';

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export const anthropic: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model }) {
    const c = client(apiKey);

    const anthropicMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            { type: 'tool_result' as const, tool_use_id: m.tool_use_id, content: m.content },
          ],
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.tool_calls.map((tc) => ({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const stream = c.messages.stream({
      model,
      system,
      max_tokens: maxTokens,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as { type: 'object'; [k: string]: unknown },
      })),
      messages: anthropicMessages as Anthropic.MessageParam[],
    });

    let inTokens = 0;
    let outTokens = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' = 'stop';
    const toolCallsByIndex: Record<number, { id: string; name: string; jsonBuf: string }> = {};

    for await (const ev of stream as AsyncIterable<Record<string, unknown>>) {
      const t = ev.type as string;
      if (
        t === 'content_block_start' &&
        (ev.content_block as { type: string } | undefined)?.type === 'tool_use'
      ) {
        const cb = ev.content_block as { id: string; name: string };
        const idx = ev.index as number;
        toolCallsByIndex[idx] = { id: cb.id, name: cb.name, jsonBuf: '' };
      } else if (t === 'content_block_delta') {
        const delta = ev.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text } as ProviderEvent;
        } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const idx = ev.index as number;
          if (toolCallsByIndex[idx]) toolCallsByIndex[idx].jsonBuf += delta.partial_json;
        }
      } else if (t === 'content_block_stop') {
        const idx = ev.index as number;
        const tc = toolCallsByIndex[idx];
        if (tc) {
          let args: Record<string, unknown> = {};
          if (tc.jsonBuf.length > 0) {
            try {
              args = JSON.parse(tc.jsonBuf) as Record<string, unknown>;
            } catch {
              // Malformed tool_use input_json buffer (truncated/garbled stream).
              // Emit the tool_call event with empty args so the runner still sees
              // the attempt; don't crash the generator before the trailing
              // tokens/done events.
              args = {};
            }
          }
          yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: args } as ProviderEvent;
        }
      } else if (t === 'message_delta') {
        const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const delta = ev.delta as { stop_reason?: string } | undefined;
        if (usage?.input_tokens !== undefined) inTokens = usage.input_tokens;
        if (usage?.output_tokens !== undefined) outTokens = usage.output_tokens;
        if (delta?.stop_reason === 'tool_use') stopReason = 'tool_use';
        else if (delta?.stop_reason === 'max_tokens') stopReason = 'max_tokens';
        else if (delta?.stop_reason === 'refusal') stopReason = 'refusal';
        else if (delta?.stop_reason === 'pause_turn') stopReason = 'pause_turn';
        // end_turn, stop_sequence, anything else → default 'stop'
      }
    }

    yield { type: 'tokens', tokens_in: inTokens, tokens_out: outTokens };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ apiKey }) {
    try {
      const c = client(apiKey);
      // models.list validates the key with a pure read — no token usage.
      // testKey validates the KEY only — the model string is validated on
      // the first real stream() call.
      await c.models.list();
      return { ok: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401)
        return { ok: false, reason: 'Unauthorized (401): key rejected by Anthropic.' };
      return { ok: false, reason: e.message ?? 'Unknown error' };
    }
  },
};
