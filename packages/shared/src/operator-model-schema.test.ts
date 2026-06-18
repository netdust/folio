import { describe, expect, test } from 'bun:test';
import { operatorModelSettingSchema } from './operator-model-schema.ts';

describe('operatorModelSettingSchema — claude-code provider', () => {
  test('accepts provider: claude-code with the default model sentinel', () => {
    const r = operatorModelSettingSchema.safeParse({
      provider: 'claude-code',
      model: 'default',
      aiKeyLabel: 'default',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.provider).toBe('claude-code');
  });

  test('still accepts the four keyed providers', () => {
    for (const p of ['anthropic', 'openai', 'openrouter', 'ollama'] as const) {
      expect(operatorModelSettingSchema.safeParse({ provider: p, model: 'm' }).success).toBe(true);
    }
  });

  test('rejects an unknown provider (e.g. a per-customer-style misuse)', () => {
    expect(
      operatorModelSettingSchema.safeParse({ provider: 'openai-customer-acme', model: 'm' })
        .success,
    ).toBe(false);
  });

  test('still rejects an empty model (min(1) preserved — the default sentinel is a non-empty string)', () => {
    expect(
      operatorModelSettingSchema.safeParse({ provider: 'claude-code', model: '' }).success,
    ).toBe(false);
  });
});
