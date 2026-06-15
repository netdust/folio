import { describe, expect, test } from 'bun:test';
import { envSchema } from './env.ts';

const base = {
  FOLIO_MASTER_KEY: 'a'.repeat(64),
};

test('env parses with no SESSION_SECRET (it is removed/dead)', () => {
  // `base` deliberately omits SESSION_SECRET. Parsing must NOT throw — the
  // schema no longer requires it. Regression guard: if a required
  // SESSION_SECRET rule is ever re-added, this goes RED again.
  expect(() => envSchema.parse(base)).not.toThrow();
});

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
