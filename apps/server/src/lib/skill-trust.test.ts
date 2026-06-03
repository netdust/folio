import { describe, expect, test } from 'bun:test';
import { canBlessSkill } from './skill-trust.ts';

describe('canBlessSkill (T8)', () => {
  test('session user (no token) may bless', () => {
    expect(canBlessSkill(null, { id: 'u1' } as any)).toBe(true);
  });
  test('operator token (createdBy null, system origin) may bless', () => {
    expect(canBlessSkill({ createdBy: null } as any, null)).toBe(true);
  });
  test('MCP admin PAT (createdBy = a human) may NOT bless', () => {
    expect(canBlessSkill({ createdBy: 'u-human' } as any, null)).toBe(false);
  });
  test('worker token (createdBy = human) may NOT bless', () => {
    expect(canBlessSkill({ createdBy: 'u-human', agentId: 'a1' } as any, null)).toBe(false);
  });
  test('a token present (even createdBy null) with a session user → still bless (token path)', () => {
    expect(canBlessSkill({ createdBy: null } as any, { id: 'u1' } as any)).toBe(true);
  });
});
