import { describe, expect, test } from 'bun:test';
import { getProvider } from './provider.ts';

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
