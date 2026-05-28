import { describe, expect, test } from 'bun:test';
import type { AIProvider } from './provider.ts';
import { __testing, getProvider } from './provider.ts';

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

describe('loadProvider rejection handling', () => {
  test('clears loading[name] on rejection so subsequent calls do not see the cached failure', async () => {
    // Save original state. We override the 'ollama' registry entry to drive
    // the rejection-cleanup path through real code, then restore.
    const originalLoader = (): Promise<AIProvider> =>
      import('./ollama.ts').then((m) => m.ollama);
    __testing.reset();

    // First call: import fails.
    let failures = 0;
    __testing.overrideRegistry('ollama', async () => {
      failures += 1;
      throw new Error('simulated import failure');
    });
    await expect(__testing.loadProvider('ollama')).rejects.toThrow('simulated import failure');

    // After the rejection settles, the loading table must be empty — otherwise
    // every subsequent caller would await the same poisoned rejection forever.
    expect(__testing.hasInflight('ollama')).toBe(false);
    expect(__testing.hasCached('ollama')).toBe(false);

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
    __testing.overrideRegistry('ollama', async () => fakeImpl);
    const got = await __testing.loadProvider('ollama');
    expect(got).toBe(fakeImpl);
    expect(failures).toBe(1); // only the first attempt rejected

    // Restore.
    __testing.overrideRegistry('ollama', originalLoader);
    __testing.reset();
  });
});
