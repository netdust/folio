import type { AIProvider, ProviderEvent } from './provider.ts';
import { sanitizeProviderError } from './sanitize-error.ts';

const DEFAULT_BASE = 'http://localhost:11434';

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
  }
}

/**
 * Type-guard + sign-clamp + truncate. Returns the new value if input is a
 * usable count, otherwise returns `existing` (preserving the running total).
 *
 * Accepts:
 *   - `number` values that pass `Number.isFinite`
 *   - `string` values that match `/^-?\d+(\.\d+)?$/` (round-5's sloppy-proxy
 *     intent; the regex rejects ''/'abc'/'null'/'false'/'true')
 *
 * Rejects (returns `existing`):
 *   - `null`, `undefined`, `''`, `false`, `[]`, objects, NaN
 *   - strings that don't match the digits pattern
 *
 * Output is clamped to >=0 and truncated to integer (rationale in caller).
 */
function coerceTokenCount(raw: unknown, existing: number): number {
  let n: number | null = null;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw)) {
    n = Number(raw);
  }
  if (n === null || !Number.isFinite(n)) return existing;
  return Math.max(0, Math.trunc(n));
}

export const ollama: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    const body = {
      model,
      stream: true,
      options: { num_predict: maxTokens },
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) =>
          m.role === 'tool'
            ? { role: 'tool', content: m.content, tool_call_id: m.tool_use_id }
            : { role: m.role, content: m.content },
        ),
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
      headers: { 'content-type': 'application/json' },
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
    const state: ParserState = { tokensIn: 0, tokensOut: 0, stopReason: 'stop' };

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

    yield { type: 'tokens', tokens_in: state.tokensIn, tokens_out: state.tokensOut };
    yield { type: 'done', reason: state.stopReason };
  },

  async testKey({ model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    try {
      const resp = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
