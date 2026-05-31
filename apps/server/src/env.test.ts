import { describe, expect, test } from 'bun:test';
import { envSchema } from './env.ts';

const base = {
  SESSION_SECRET: 'x'.repeat(32),
  FOLIO_MASTER_KEY: 'a'.repeat(64),
};

describe('FOLIO_CLAUDE_CODE_ENABLED', () => {
  test('defaults to false when unset', () => {
    expect(envSchema.parse({ ...base }).FOLIO_CLAUDE_CODE_ENABLED).toBe(false);
  });
  test("'false' string yields false", () => {
    expect(envSchema.parse({ ...base, FOLIO_CLAUDE_CODE_ENABLED: 'false' }).FOLIO_CLAUDE_CODE_ENABLED).toBe(false);
  });
  test("'true' string yields true", () => {
    expect(envSchema.parse({ ...base, FOLIO_CLAUDE_CODE_ENABLED: 'true' }).FOLIO_CLAUDE_CODE_ENABLED).toBe(true);
  });
});
