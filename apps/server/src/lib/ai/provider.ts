import type { Provider } from '../agent-run-schema.ts';

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tokens'; tokens_in: number; tokens_out: number }
  | { type: 'done'; reason: 'stop' | 'tool_use' | 'max_tokens' };

export type Message =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: Array<{ id: string; name: string; arguments: unknown }>;
    }
  | { role: 'tool'; content: string; tool_use_id: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export interface AIProvider {
  stream(opts: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    maxTokens: number;
    apiKey: string;
    model: string;
    baseUrl?: string;
  }): AsyncIterable<ProviderEvent>;

  testKey(opts: {
    apiKey: string;
    model: string;
    baseUrl?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const REGISTRY: Record<Provider, () => Promise<AIProvider>> = {
  anthropic: async () => (await import('./anthropic.ts')).anthropic,
  openai: async () => (await import('./openai.ts')).openai,
  openrouter: async () => (await import('./openrouter.ts')).openrouter,
  ollama: async () => (await import('./ollama.ts')).ollama,
};

const cache: Partial<Record<Provider, AIProvider>> = {};

export function getProvider(name: Provider): AIProvider {
  if (!REGISTRY[name]) throw new Error(`Unknown AI provider: ${String(name)}`);
  const cached = cache[name];
  if (cached) return cached;
  const proxy: AIProvider = {
    async *stream(opts) {
      const impl = await REGISTRY[name]();
      cache[name] = impl;
      yield* impl.stream(opts);
    },
    async testKey(opts) {
      const impl = await REGISTRY[name]();
      cache[name] = impl;
      return impl.testKey(opts);
    },
  };
  return proxy;
}
