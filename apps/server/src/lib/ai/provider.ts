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

// Round 7 #15 — module-load snapshot of REGISTRY for the test-only reset()
// hatch. Pre-round-7 reset() cleared `cache` + `loading` but left REGISTRY
// mutations from `__INTERNAL_TEST_ONLY__.overrideRegistry(...)` in place;
// a test that threw mid-test before its explicit restore leaked the stub
// to every subsequent test in the Bun process. Snapshotting at module load
// lets reset() restore the original loaders without needing per-call cleanup
// in the tests. Spread is intentional — a per-test mutation to REGISTRY[k]
// must NOT mutate ORIGINAL_REGISTRY (which would defeat the snapshot).
const ORIGINAL_REGISTRY: Record<Provider, () => Promise<AIProvider>> = { ...REGISTRY };

const cache: Partial<Record<Provider, AIProvider>> = {};
// Share one in-flight import per provider so concurrent first-callers
// don't each trigger a dynamic import + duplicate module evaluation.
const loading: Partial<Record<Provider, Promise<AIProvider>>> = {};

async function loadProvider(name: Provider): Promise<AIProvider> {
  const cached = cache[name];
  if (cached) return cached;
  const inflight = loading[name];
  if (inflight) return inflight;
  const promise = REGISTRY[name]()
    .then((impl) => {
      cache[name] = impl;
      delete loading[name];
      return impl;
    })
    .catch((err) => {
      // A failed dynamic import previously stayed in `loading[name]` forever
      // — every subsequent caller awaited the same rejection until restart.
      // Clear the slot so transient failures (e.g. a flaky filesystem during
      // SDK import) recover on the next call.
      delete loading[name];
      throw err;
    });
  loading[name] = promise;
  return promise;
}

/**
 * @internal
 *
 * INTERNAL TEST-ONLY ESCAPE HATCH. Do not import from production code.
 *
 * Lets specs override REGISTRY entries with a stub (to drive the
 * rejection-cleanup path through real code) and observe the `loading` table
 * without exposing it. Renamed in B round 3 fix #11 from `__testing` to
 * `__INTERNAL_TEST_ONLY__` to make accidental imports from production code
 * visible at the call site.
 *
 * B round 4 fix #6 — runtime guard added. Every entry-point checks
 * NODE_ENV === 'test' and throws otherwise. Round 3's rename was cosmetic;
 * a future production refactor or IDE-autocomplete reach calls these and
 * silently poisons the process-wide provider cache. Now it crashes loudly
 * instead. A follow-up (deferred to v1.1) extracts these into a separate
 * file gated by an ESLint rule that bans non-test imports.
 *
 * Any production reference to this export is a bug.
 */
function guardTestOnly(method: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `provider.__INTERNAL_TEST_ONLY__.${method} is for tests only; not callable in NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`,
    );
  }
}

export const __INTERNAL_TEST_ONLY__ = {
  overrideRegistry(name: Provider, loader: () => Promise<AIProvider>): void {
    guardTestOnly('overrideRegistry');
    REGISTRY[name] = loader;
  },
  hasInflight(name: Provider): boolean {
    guardTestOnly('hasInflight');
    return loading[name] !== undefined;
  },
  hasCached(name: Provider): boolean {
    guardTestOnly('hasCached');
    return cache[name] !== undefined;
  },
  reset(): void {
    guardTestOnly('reset');
    for (const k of Object.keys(cache) as Provider[]) delete cache[k];
    for (const k of Object.keys(loading) as Provider[]) delete loading[k];
    // Round 7 #15 — restore the module-load REGISTRY snapshot so test stubs
    // from overrideRegistry() are unwound. See ORIGINAL_REGISTRY comment.
    for (const k of Object.keys(REGISTRY) as Provider[]) {
      REGISTRY[k] = ORIGINAL_REGISTRY[k];
    }
  },
  loadProvider(name: Provider): Promise<AIProvider> {
    guardTestOnly('loadProvider');
    return loadProvider(name);
  },
};

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
