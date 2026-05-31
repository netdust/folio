import { describe, expect, test } from 'bun:test';
import { coerceTokenCount } from './coerce-token-count.ts';

describe('coerceTokenCount', () => {
  test('number values are truncated to integer', () => {
    expect(coerceTokenCount(7, 99)).toBe(7);
    expect(coerceTokenCount(7.5, 99)).toBe(7);
    expect(coerceTokenCount(7.999, 99)).toBe(7);
  });

  test('negative numbers are clamped to 0', () => {
    expect(coerceTokenCount(-7, 99)).toBe(0);
    expect(coerceTokenCount(-0.5, 99)).toBe(0);
  });

  test('digit-only strings are parsed', () => {
    expect(coerceTokenCount('7', 99)).toBe(7);
    expect(coerceTokenCount('0', 99)).toBe(0);
    expect(coerceTokenCount('123', 99)).toBe(123);
  });

  test('fractional strings preserve fallback (round 7 tightened from round 5)', () => {
    // Round 5 accepted '7.5' and produced 7 via Math.trunc. Round 7 rejects
    // string fractional values; only digits-only strings pass. A consumer
    // serializing tokens-as-string was incorrectly relying on the round-5
    // permissive shape; correct that at the source (proxy / SDK).
    expect(coerceTokenCount('7.5', 99)).toBe(99);
  });

  test('negative strings preserve fallback (round 7 tightened from round 5)', () => {
    expect(coerceTokenCount('-7', 99)).toBe(99);
  });

  test('non-numeric inputs preserve fallback', () => {
    expect(coerceTokenCount('abc', 42)).toBe(42);
    expect(coerceTokenCount('', 42)).toBe(42);
    expect(coerceTokenCount(null, 42)).toBe(42);
    expect(coerceTokenCount(undefined, 42)).toBe(42);
    expect(coerceTokenCount(false, 42)).toBe(42);
    expect(coerceTokenCount(true, 42)).toBe(42);
    expect(coerceTokenCount([], 42)).toBe(42);
    expect(coerceTokenCount({}, 42)).toBe(42);
    expect(coerceTokenCount(Number.NaN, 42)).toBe(42);
    expect(coerceTokenCount(Number.POSITIVE_INFINITY, 42)).toBe(42);
  });
});
