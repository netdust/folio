import type { Provider } from '../agent-run-schema.ts';

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tokens'; tokens_in: number; tokens_out: number }
  | { type: 'done'; reason: 'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' };

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
// Share one in-flight import per provider so concurrent first-callers
// don't each trigger a dynamic import + duplicate module evaluation.
const loading: Partial<Record<Provider, Promise<AIProvider>>> = {};

async function loadProvider(name: Provider): Promise<AIProvider> {
  const cached = cache[name];
  if (cached) return cached;
  const inflight = loading[name];
  if (inflight) return inflight;
  const promise = REGISTRY[name]().then((impl) => {
    cache[name] = impl;
    delete loading[name];
    return impl;
  });
  loading[name] = promise;
  return promise;
}

export function getProvider(name: Provider): AIProvider {
  if (!REGISTRY[name]) throw new Error(`Unknown AI provider: ${String(name)}`);
  const cached = cache[name];
  if (cached) return cached;
  const proxy: AIProvider = {
    async *stream(opts) {
      const impl = await loadProvider(name);
      yield* impl.stream(opts);
    },
    async testKey(opts) {
      const impl = await loadProvider(name);
      return impl.testKey(opts);
    },
  };
  return proxy;
}
