import { describe, expect, test } from 'bun:test';
// Populate env before importing system-workspace.ts (which reads env at eval).
import '../test/env-setup.ts';
import { isReservedSlug } from './system-workspace.ts';
import {
  OPERATOR_SLUG,
  getOperatorDefinition,
  isOperator,
} from './operator.ts';

describe('operator runtime singleton (Task 16)', () => {
  test('OPERATOR_SLUG is reserved (unspawnable by users)', () => {
    // _operator is `_`-prefixed → isReservedSlug blocks a user creating an
    // agent with this slug (defense-in-depth: the resolver also returns the
    // code singleton, never a queried row — proven in Task 17).
    expect(isReservedSlug(OPERATOR_SLUG)).toBe(true);
    expect(OPERATOR_SLUG).toBe('_operator');
  });

  test('isOperator(OPERATOR_SLUG) is true; any other slug is not', () => {
    expect(isOperator(OPERATOR_SLUG)).toBe(true);
    expect(isOperator('folio-operator')).toBe(false); // the OLD derived slug
    expect(isOperator('worker')).toBe(false);
    expect(isOperator('')).toBe(false);
  });

  test('getOperatorDefinition returns the prompt + tools (a code singleton)', () => {
    const def = getOperatorDefinition();
    expect(def.prompt.length).toBeGreaterThan(100);
    expect(def.tools).toContain('folio_api');
    expect(def.tools).toContain('set_skill_trust');
    expect(def.slug).toBe(OPERATOR_SLUG);
  });
});
