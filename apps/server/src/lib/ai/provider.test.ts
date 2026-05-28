import { describe, expect, test } from 'bun:test';
import type { AIProvider } from './provider.ts';
import { __INTERNAL_TEST_ONLY__, getProvider } from './provider.ts';

describe('getProvider', () => {
  test('returns a provider object exposing stream + testKey for each known provider', () => {
    for (const name of ['anthropic', 'openai', 'openrouter', 'ollama'] as const) {
      const p = getProvider(name);
      expect(typeof p.stream).toBe('function');
      expect(typeof p.testKey).toBe('function');
    }
  });

  test('throws on unknown provider', () => {
    // @ts-expect-error — testing runtime guard for an unknown name
    expect(() => getProvider('gemini')).toThrow();
  });
});

// B round 4 fix #6 — runtime guard on the test-only escape hatch. Round 3's
// rename to __INTERNAL_TEST_ONLY__ was cosmetic. A future production refactor
// or IDE-autocomplete reach could still call these and silently poison the
// process-wide provider cache. Now every entry-point throws unless
// NODE_ENV === 'test'. Production code that accidentally lands an import
// crashes loudly at the call site.
describe('__INTERNAL_TEST_ONLY__ runtime guard', () => {
  test('overrideRegistry throws when NODE_ENV is not test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        __INTERNAL_TEST_ONLY__.overrideRegistry('anthropic', async () => {
          throw new Error('should not be reached');
        }),
      ).toThrow(/tests only/i);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('reset throws when NODE_ENV is not test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => __INTERNAL_TEST_ONLY__.reset()).toThrow(/tests only/i);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('hasInflight + hasCached + loadProvider throw when NODE_ENV is not test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => __INTERNAL_TEST_ONLY__.hasInflight('anthropic')).toThrow(/tests only/i);
      expect(() => __INTERNAL_TEST_ONLY__.hasCached('anthropic')).toThrow(/tests only/i);
      expect(() => __INTERNAL_TEST_ONLY__.loadProvider('anthropic')).toThrow(/tests only/i);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('all entry-points work normally when NODE_ENV === "test"', () => {
    // Bun sets NODE_ENV=test by default in `bun test`; assert sanity.
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => __INTERNAL_TEST_ONLY__.hasInflight('anthropic')).not.toThrow();
    expect(() => __INTERNAL_TEST_ONLY__.hasCached('anthropic')).not.toThrow();
  });
});

describe('loadProvider rejection handling', () => {
  test('clears loading[name] on rejection so subsequent calls do not see the cached failure', async () => {
    // Save original state. We override the 'ollama' registry entry to drive
    // the rejection-cleanup path through real code, then restore.
    const originalLoader = (): Promise<AIProvider> =>
      import('./ollama.ts').then((m) => m.ollama);
    __INTERNAL_TEST_ONLY__.reset();

    // First call: import fails.
    let failures = 0;
    __INTERNAL_TEST_ONLY__.overrideRegistry('ollama', async () => {
      failures += 1;
      throw new Error('simulated import failure');
    });
    await expect(__INTERNAL_TEST_ONLY__.loadProvider('ollama')).rejects.toThrow('simulated import failure');

    // After the rejection settles, the loading table must be empty — otherwise
    // every subsequent caller would await the same poisoned rejection forever.
    expect(__INTERNAL_TEST_ONLY__.hasInflight('ollama')).toBe(false);
    expect(__INTERNAL_TEST_ONLY__.hasCached('ollama')).toBe(false);

    // Second call with a now-working loader resolves normally — proves we are
    // NOT receiving the prior rejection from a poisoned slot.
    const fakeImpl: AIProvider = {
      async *stream() {
        yield { type: 'done', reason: 'stop' };
      },
      async testKey() {
        return { ok: true };
      },
    };
    __INTERNAL_TEST_ONLY__.overrideRegistry('ollama', async () => fakeImpl);
    const got = await __INTERNAL_TEST_ONLY__.loadProvider('ollama');
    expect(got).toBe(fakeImpl);
    expect(failures).toBe(1); // only the first attempt rejected

    // Restore.
    __INTERNAL_TEST_ONLY__.overrideRegistry('ollama', originalLoader);
    __INTERNAL_TEST_ONLY__.reset();
  });
});
