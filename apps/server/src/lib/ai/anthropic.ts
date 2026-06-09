import Anthropic from '@anthropic-ai/sdk';
import { coerceTokenCount } from './coerce-token-count.ts';
import type { AIProvider, ProviderEvent } from './provider.ts';
import { sanitizeProviderError } from './sanitize-error.ts';

function client(apiKey: string, baseUrl?: string): Anthropic {
  return new Anthropic({ apiKey, baseURL: baseUrl });
}

export const anthropic: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model, baseUrl }) {
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

    // Round 7 #6 — widen the try/catch to cover SDK construction AND the
    // synchronous .stream() call. Pre-round-7 the try wrapped only the
    // for-await loop; `new Anthropic({apiKey, baseURL})` and the
    // `c.messages.stream({...})` invocation can both throw synchronously
    // (invalid baseURL parse, missing required init args), and those
    // throws propagated raw to the runner. Now they're sanitized too.
    let c: Anthropic;
    let stream: ReturnType<Anthropic['messages']['stream']>;
    try {
      c = client(apiKey, baseUrl);
      stream = c.messages.stream({
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
    } catch (err) {
      throw new Error(sanitizeProviderError(err, 'Anthropic'));
    }

    let inTokens = 0;
    let outTokens = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' = 'stop';
    // G1 — whether the canonical terminal event (`message_stop`) was seen. Every
    // complete Anthropic stream ends with it. The final `done` event is emitted
    // only if so; a truncated stream (connection dropped before message_stop)
    // yields no done event → the runner's FIX#2 fails the run loudly rather than
    // recording a fake-success 'stop'.
    let sawTerminal = false;
    const toolCallsByIndex: Record<number, { id: string; name: string; jsonBuf: string }> = {};

    // B round 5 #4 — sanitize stream-startup throws. Anthropic's SDK fires
    // network/auth errors as the async iterator is awaited (not at the
    // synchronous .stream() call). Pre-fix the raw e.message propagated to
    // the runner — embedding partial keys ('Incorrect API key provided:
    // sk-real-…') and proxy/host details. Mitigation 5 whitelist.
    //
    // Round 7 #8 — finally block aborts the upstream SDK stream when the
    // consumer breaks out of the for-await early (timeout, runner shutdown).
    // Without this the SDK keeps the underlying fetch alive until GC, which
    // costs us tokens (provider still streaming) AND leaks the connection.
    // MessageStream exposes both .abort() and .controller.abort(); the
    // controller form is more defensive (works on partially-initialized
    // streams). Wrap in try/{} so a SDK-version mismatch (no .controller)
    // doesn't double-throw over the original break/throw reason.
    try {
      for await (const ev of stream as AsyncIterable<Record<string, unknown>>) {
        const t = ev.type as string;
        if (
          t === 'content_block_start' &&
          (ev.content_block as { type: string } | undefined)?.type === 'tool_use'
        ) {
          const cb = ev.content_block as { id: string; name: string };
          const idx = ev.index as number;
          toolCallsByIndex[idx] = { id: cb.id, name: cb.name, jsonBuf: '' };
        } else if (
          t === 'content_block_start' &&
          // G5 — Anthropic SERVER-side tool blocks (server_tool_use / mcp_tool_use,
          // web_search/computer-use) are NOT client tool calls we can dispatch. We
          // don't register them (no client tool_call event), but a block whose type
          // ends in `_tool_use` arriving with stop_reason:'tool_use' otherwise leaves
          // the runner's FIX#3 to fail with a GENERIC "no usable tool call" message.
          // Warn with the specific block type so the failure is diagnosable rather
          // than misleading. (Executing server tools is out of scope — see threat
          // model G5 deferral.)
          /_tool_use$/.test((ev.content_block as { type?: string } | undefined)?.type ?? '')
        ) {
          const blockType = (ev.content_block as { type: string }).type;
          console.warn(
            `[ai/anthropic] unsupported server-tool block '${blockType}' — not dispatched as a client tool call`,
          );
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
              } catch (err) {
                // Malformed tool_use input_json buffer (truncated/garbled stream).
                // Emit the tool_call event with empty args so the runner still sees
                // the attempt; don't crash the generator before the trailing
                // tokens/done events. Warn so operators have a grep target when
                // an agent run goes sideways — silent {} is indistinguishable
                // from a legitimate {} call.
                console.warn(
                  '[ai/anthropic] dropped malformed tool_use JSON in stream:',
                  err instanceof Error ? err.message : err,
                );
                args = {};
              }
            }
            yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: args } as ProviderEvent;
          }
        } else if (t === 'message_stop') {
          sawTerminal = true; // G1 — the canonical terminal event.
        } else if (t === 'message_delta') {
          const usage = ev.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
          const delta = ev.delta as { stop_reason?: string } | undefined;
          // G1 — a stop_reason is ALSO a completion signal (it immediately precedes
          // message_stop in the real protocol). Either terminal indicator counts, so
          // a stream that delivered a real stop_reason is not treated as truncated.
          if (delta?.stop_reason) sawTerminal = true;
          // Round 7 #9 — coerceTokenCount clamps negative / fractional /
          // non-numeric upstream values. Pre-round-7 the round-4 `!== undefined`
          // guard accepted any value as-is; a sloppy proxy emitting
          // input_tokens=-1 propagated into the agent_run REAL column.
          inTokens = coerceTokenCount(usage?.input_tokens, inTokens);
          outTokens = coerceTokenCount(usage?.output_tokens, outTokens);
          if (delta?.stop_reason === 'tool_use') stopReason = 'tool_use';
          else if (delta?.stop_reason === 'max_tokens') stopReason = 'max_tokens';
          else if (delta?.stop_reason === 'refusal') stopReason = 'refusal';
          else if (delta?.stop_reason === 'pause_turn') stopReason = 'pause_turn';
          // end_turn, stop_sequence, anything else → default 'stop'
        }
      }
    } catch (err) {
      throw new Error(sanitizeProviderError(err, 'Anthropic'));
    } finally {
      // Round 7 #8 — abort the SDK stream on consumer break / mid-iter
      // throw so the underlying fetch closes promptly. Defensive try/{}
      // because the controller may be undefined on partially-initialized
      // streams, and we must NEVER throw from finally (would mask the
      // original reason for exiting the loop).
      try {
        (stream as unknown as { controller?: AbortController }).controller?.abort();
      } catch {
        // Intentionally swallow — see comment above.
      }
    }

    yield { type: 'tokens', tokens_in: inTokens, tokens_out: outTokens };
    // G1 — emit `done` only if a real terminal signal arrived; a truncated stream
    // yields none → the runner's FIX#2 fails the run instead of a fake-success.
    if (sawTerminal) {
      yield { type: 'done', reason: stopReason };
    } else {
      console.warn('[ai/anthropic] stream ended without a stop_reason — no done event (truncated)');
    }
  },

  async testKey({ apiKey, baseUrl }) {
    try {
      const c = client(apiKey, baseUrl);
      // models.list validates the key with a pure read — no token usage.
      // testKey validates the KEY only — the model string is validated on
      // the first real stream() call.
      await c.models.list();
      return { ok: true };
    } catch (err) {
      // Round 6 #7 — migrated to the shared sanitizeProviderError helper.
      // Same whitelist semantics; helper preserves the 401/403 distinction.
      return { ok: false, reason: sanitizeProviderError(err, 'Anthropic') };
    }
  },
};
