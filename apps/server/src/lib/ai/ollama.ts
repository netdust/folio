import type { AIProvider, ProviderEvent } from './provider.ts';

const DEFAULT_BASE = 'http://localhost:11434';

type OllamaToolCall = {
  function: { name: string; arguments: Record<string, unknown> };
};

type OllamaMessage = {
  content?: string;
  tool_calls?: OllamaToolCall[];
};

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
    if (!resp.ok || !resp.body) throw new Error(`ollama: ${resp.status} ${resp.statusText}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';

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
        const msg = chunk.message as OllamaMessage | undefined;
        if (msg?.content) yield { type: 'text', delta: msg.content } as ProviderEvent;
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            yield {
              type: 'tool_call',
              id: crypto.randomUUID(),
              name: tc.function.name,
              arguments: tc.function.arguments,
            } as ProviderEvent;
          }
        }
        if (chunk.done) {
          tokensIn = (chunk.prompt_eval_count as number | undefined) ?? tokensIn;
          tokensOut = (chunk.eval_count as number | undefined) ?? tokensOut;
          const reason = chunk.done_reason as string | undefined;
          if (reason === 'length') stopReason = 'max_tokens';
          else if (reason === 'tool_calls') stopReason = 'tool_use';
        }
      }
    }

    // Flush any trailing record that wasn't terminated with \n (e.g. a proxy
    // dropped the final newline). Without this the real done_reason + token
    // counts get silently discarded and we emit a fake-success done.
    if (buffer.trim().length > 0) {
      try {
        const chunk = JSON.parse(buffer) as Record<string, unknown>;
        const msg = chunk.message as OllamaMessage | undefined;
        if (msg?.content) yield { type: 'text', delta: msg.content } as ProviderEvent;
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            yield {
              type: 'tool_call',
              id: crypto.randomUUID(),
              name: tc.function.name,
              arguments: tc.function.arguments,
            } as ProviderEvent;
          }
        }
        if (chunk.done) {
          tokensIn = (chunk.prompt_eval_count as number | undefined) ?? tokensIn;
          tokensOut = (chunk.eval_count as number | undefined) ?? tokensOut;
          const reason = chunk.done_reason as string | undefined;
          if (reason === 'length') stopReason = 'max_tokens';
          else if (reason === 'tool_calls') stopReason = 'tool_use';
        }
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

    yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
    yield { type: 'done', reason: stopReason };
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
      if (resp.status === 404) return { ok: false, reason: `Model not found on ${base}: ${model}` };
      return { ok: false, reason: `Ollama HTTP ${resp.status}` };
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, reason: e.message ?? `Cannot reach ${base}` };
    }
  },
};
