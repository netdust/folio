import { describe, expect, test } from 'bun:test';
import { cn } from './cn.ts';

describe('cn', () => {
  test('joins truthy strings', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  test('filters falsy', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
  test('merges conflicting tailwind utilities (later wins)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
  test('preserves non-conflicting classes', () => {
    expect(cn('text-fg bg-content', 'rounded-md')).toBe('text-fg bg-content rounded-md');
  });
});
