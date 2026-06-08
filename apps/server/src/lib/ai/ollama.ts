import { coerceTokenCount } from './coerce-token-count.ts';
import type { AIProvider, ProviderEvent } from './provider.ts';
import { sanitizeProviderError } from './sanitize-error.ts';

// 127.0.0.1, NOT localhost: Ollama binds to IPv4 127.0.0.1, but `localhost` can
// resolve to ::1 (IPv6) first, and Bun's fetch does not reliably fall back from
// ::1 → 127.0.0.1 — a `localhost` default throws a statusless "Unable to connect"
// that sanitizes to the opaque "Network error or unreachable host." Pin v4.
const DEFAULT_BASE = 'http://127.0.0.1:11434';

type OllamaToolCall = {
  function: { name: string; arguments: Record<string, unknown> };
};

type OllamaMessage = {
  content?: string;
  tool_calls?: OllamaToolCall[];
};

type ParserState = {
  tokensIn: number;
  tokensOut: number;
  stopReason: 'stop' | 'tool_use' | 'max_tokens';
  // Whether ANY tool call streamed this turn. Thinking models (qwen3) emit a
  // tool_calls chunk but finish with done_reason: 'stop' (not 'tool_calls'),
  // so the done_reason label alone can't decide tool_use — track it directly.
  sawToolCall: boolean;
};

/**
 * B round 3 fix #10 — extracted from the read-loop + trailing-flush so the
 * two call sites share one implementation. Pre-fix the two paths drifted
 * (e.g. round 2 added a console.warn to only one). yield* lets the caller
 * forward events transparently; `state` carries the running totals.
 *
 * B round 3 fix #15 — numeric chunk fields are coerced via Number() so a
 * stringified value from a sloppy proxy ("7" instead of 7) doesn't propagate
 * a string into the accumulators (which would then surface in the `tokens`
 * event and break consumers that arithmetic on it).
 */
function* handleOllamaChunk(
  chunk: Record<string, unknown>,
  state: ParserState,
): Generator<ProviderEvent> {
  const msg = chunk.message as OllamaMessage | undefined;
  if (msg?.content) yield { type: 'text', delta: msg.content };
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      state.sawToolCall = true;
      yield {
        type: 'tool_call',
        id: crypto.randomUUID(),
        name: tc.function.name,
        arguments: tc.function.arguments,
      };
    }
  }
  if (chunk.done) {
    // Fix #15 — Number()||existing keeps the running total when the proxy
    // sends a non-numeric value (NaN coerces back to the previous total).
    //
    // B round 4 fix #7 — Math.trunc on the coerced value. Number('7.5') is
    // 7.5; without truncation the fractional value propagates into the
    // `tokens` event + the SQLite column (REAL, with IEEE-754 drift on SUM
    // for budget accounting). Tokens are intrinsically integer; pin the type.
    //
    // B round 5 #9 — Math.max(0, ...) clamp. Round 4's Math.trunc pinned the
    // type but not the sign: Number('-7') is -7 (passes isFinite, trunc keeps
    // the sign), so a malformed proxy payload with a negative count propagated
    // into the accumulator + the tokens event + the SQLite REAL column. The
    // agent_run_schema.ts z.nonnegative() is a downstream backstop; this is
    // defense in depth at the source.
    //
    // B round 6 #3 — type-guard the input BEFORE Number coercion. The round-5
    // rewrite `Number.isFinite(Number(x))` accepts the falsy set ('', null,
    // false, []) — all coerce to 0 — and clobbered the running accumulator to
    // 0 on any falsy chunk. The original (round 3) `Number(x) || existing`
    // preserved the running total via the OR fallback; the round-5 rewrite
    // lost that property. Tighten: accept number-typed values, OR string-typed
    // values that match a digits-only regex (the round-5 intent of "accept
    // stringified ints from sloppy proxies" — '7' → 7, but '' / 'abc' → reject).
    state.tokensIn = coerceTokenCount(chunk.prompt_eval_count, state.tokensIn);
    state.tokensOut = coerceTokenCount(chunk.eval_count, state.tokensOut);
    const reason = chunk.done_reason as string | undefined;
    if (reason === 'length') state.stopReason = 'max_tokens';
    else if (reason === 'tool_calls') state.stopReason = 'tool_use';
    // qwen3 + other thinking models stream a tool_calls chunk but finish with
    // done_reason: 'stop'. If a tool call actually streamed, the turn IS a
    // tool-use turn — the runner gates execution on reason==='tool_use', so
    // without this the tool round is skipped and the run yields "(no output)".
    // 'length' (truncation) wins: a tool call cut off mid-stream isn't usable.
    else if (state.sawToolCall) state.stopReason = 'tool_use';
  }
}

// Round 7 #9 — `coerceTokenCount` is now in `lib/ai/coerce-token-count.ts`
// shared with the anthropic + openai providers. Round 7 also tightened the
// string-accepting regex from /^-?\d+(\.\d+)?$/ (round 5's permissive
// "stringified ints from sloppy proxies" intent) to /^\d+$/ (digits-only,
// non-negative). The number-typed path keeps the sign-clamp + truncate
// since `number` values still need defense against NaN/negative/fractional.

/**
 * Round 7 #5 — Ollama silently dropped the apiKey arg pre-round-7. The fetch
 * sent `content-type` only. Self-hosted users with TLS-fronted Ollama
 * (reverse proxy requiring Authorization) had their key stored but never
 * sent — the upstream rejected every request.
 *
 * Send `Authorization: Bearer <apiKey>` when apiKey is non-empty. The
 * canonical localhost installation doesn't require it; passing an empty
 * key keeps headers identical to pre-round-7 (no Authorization line).
 */
function buildOllamaHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey && apiKey.length > 0) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

export const ollama: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    const body = {
      model,
      stream: true,
      // Disable "thinking" for reasoning models (qwen3, deepseek-r1, …). On a
      // local GPU the <think> preamble dominates latency — qwen3:8b spent ~3.4s
      // reasoning before a one-line reply to "hi" (4.2s total → 0.8s with this
      // off), and it still emits tool calls correctly. The operator should ACT
      // (call tools), not ruminate, so the reasoning trace is pure tax here.
      // Ollama ignores this field for non-thinking models, so it's safe globally.
      think: false,
      options: { num_predict: maxTokens },
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) => {
          if (m.role === 'tool') {
            return { role: 'tool', content: m.content, tool_call_id: m.tool_use_id };
          }
          // An assistant turn that called tools must echo those tool_calls back, or
          // the follow-up `tool` result messages have nothing to correlate to and
          // Ollama drops the round (the OpenAI adapter already does this). Ollama
          // takes `arguments` as an OBJECT (unlike OpenAI's stringified form).
          if (m.role === 'assistant' && m.tool_calls?.length) {
            return {
              role: 'assistant',
              content: m.content,
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            };
          }
          return { role: m.role, content: m.content };
        }),
      ],
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    };

    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: buildOllamaHeaders(apiKey),
      body: JSON.stringify(body),
    });
    // B round 4 fix #2 — sanitize the stream-startup error throw. Pre-fix
    // the throw echoed resp.statusText raw, which proxies happily populate
    // with internal hostnames + path fragments. The runner surfaces this
    // error message to operators (and potentially to comments on the
    // agent_run row), so it inherits the same testKey whitelist. NEVER
    // echo `resp.statusText`, `base`, or the caller-supplied `model`.
    //
    // Round 6 #7 — migrated to the shared sanitizeProviderError helper. The
    // inline whitelist was identical to the helper's output; centralizing
    // closes the drift risk + picks up the round-6 401/403 distinction.
    if (!resp.ok || !resp.body) {
      throw new Error(sanitizeProviderError(resp, 'Ollama'));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const state: ParserState = {
      tokensIn: 0,
      tokensOut: 0,
      stopReason: 'stop',
      sawToolCall: false,
    };

    // Round 7 #8 — try/finally ensures the reader is cancelled + released
    // when the consumer breaks out of the for-await early (timeout, runner
    // shutdown, exception). Bun's GC does NOT promptly release a locked
    // ReadableStream — pre-round-7 the underlying socket leaked until the
    // process eventually finalized the reader, which under high agent-run
    // concurrency exhausted FDs. Cancel first (signals upstream we're
    // done), then releaseLock so future getReader() calls succeed.
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(line) as Record<string, unknown>;
          } catch (err) {
            // Skip malformed NDJSON lines (proxy keep-alives, mid-stream HTML
            // error pages, network blips). Don't crash a stream that has valid
            // lines around the garbage. Warn so operators have a grep target
            // when an agent run goes sideways.
            console.warn(
              '[ai/ollama] dropped malformed NDJSON line in stream:',
              err instanceof Error ? err.message : err,
            );
            continue;
          }
          yield* handleOllamaChunk(chunk, state);
        }
      }

      // Flush any trailing record that wasn't terminated with \n (e.g. a proxy
      // dropped the final newline). Without this the real done_reason + token
      // counts get silently discarded and we emit a fake-success done.
      if (buffer.trim().length > 0) {
        try {
          const chunk = JSON.parse(buffer) as Record<string, unknown>;
          yield* handleOllamaChunk(chunk, state);
        } catch (err) {
          // Drop silently in terms of stream output; matches in-loop behavior.
          // The trailing tokens/done below still fire, but we may have missed
          // a real done flag. Warn so operators have a grep target.
          console.warn(
            '[ai/ollama] dropped malformed trailing NDJSON record:',
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      // Defensive try/{} on each — must NEVER throw from finally, which
      // would mask the original reason for exiting the loop.
      try {
        await reader.cancel();
      } catch {
        // Reader already errored / cancelled. Swallow.
      }
      try {
        reader.releaseLock();
      } catch {
        // Lock already released (cancel may release implicitly). Swallow.
      }
    }

    yield { type: 'tokens', tokens_in: state.tokensIn, tokens_out: state.tokensOut };
    yield { type: 'done', reason: state.stopReason };
  },

  async testKey({ apiKey, model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    try {
      const resp = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: buildOllamaHeaders(apiKey),
        body: JSON.stringify({ name: model }),
      });
      if (resp.ok) return { ok: true };
      // Round 6 #7 — migrated to the shared sanitizeProviderError helper.
      // Ollama testKey has one non-shared case: 404 means "model not found"
      // (the model arg was wrong, not the key), so it's kept inline. All
      // other statuses go through the shared whitelist. The helper preserves
      // the 401/403 distinction and the no-echo-of-baseUrl-or-model contract.
      if (resp.status === 404) return { ok: false, reason: 'Model not found (404).' };
      return { ok: false, reason: sanitizeProviderError(resp, 'Ollama') };
    } catch (err) {
      // Round 6 #7 — helper for symmetry. Network errors (no .status) map to
      // the network-error branch. Never surface err.message (proxy hostnames,
      // ECONNREFUSED targets, system paths can leak through).
      return { ok: false, reason: sanitizeProviderError(err, 'Ollama') };
    }
  },
};
