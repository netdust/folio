import { describe, expect, test } from 'bun:test';
import { rankBetween } from './board-rank.ts';

describe('rankBetween', () => {
  test('between null/null (empty list) returns a non-empty key', () => {
    const k = rankBetween(null, null);
    expect(typeof k).toBe('string');
    expect(k.length).toBeGreaterThan(0);
  });
  test('before-first: rankBetween(null, x) < x lexically', () => {
    const x = rankBetween(null, null);
    const before = rankBetween(null, x);
    expect(before < x).toBe(true);
  });
  test('after-last: rankBetween(x, null) > x lexically', () => {
    const x = rankBetween(null, null);
    const after = rankBetween(x, null);
    expect(after > x).toBe(true);
  });
  test('between two keys yields a key strictly between them', () => {
    const a = rankBetween(null, null);
    const c = rankBetween(a, null);
    const b = rankBetween(a, c);
    expect(a < b && b < c).toBe(true);
  });
  test('repeated midpoint insertions just above lo stay strictly ordered', () => {
    let lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    for (let i = 0; i < 30; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      hi = mid;
    }
  });
  test('repeated midpoint insertions just below hi stay strictly ordered', () => {
    let lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    for (let i = 0; i < 30; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      lo = mid;
    }
  });
  test('adjacent keys (single-digit gap) still yield a strictly-between key', () => {
    // Two keys produced at front and just-after force the algorithm to extend
    // with an extra digit rather than pick a middle digit.
    const a = rankBetween(null, null);
    let lo = rankBetween(null, a);
    // hammer the front so lo and a become lexically adjacent-ish
    for (let i = 0; i < 50; i++) {
      const mid = rankBetween(lo, a);
      expect(lo < mid && mid < a).toBe(true);
      lo = mid;
    }
  });
  test('500 inserts each just-before-hi stay strictly ordered & unique', () => {
    const lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    const keys: string[] = [lo, hi];
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      keys.push(mid);
      hi = mid;
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
  test('500 inserts each just-after-lo stay strictly ordered & unique', () => {
    let lo = rankBetween(null, null);
    const hi = rankBetween(lo, null);
    const keys: string[] = [lo, hi];
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      keys.push(mid);
      lo = mid;
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
  test('reordering a full small list keeps all keys strictly increasing', () => {
    // simulate building 5 ranks at the end, then inserting between each pair
    const keys: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 5; i++) { const k = rankBetween(prev, null); keys.push(k); prev = k; }
    for (let i = 0; i < keys.length - 1; i++) {
      const mid = rankBetween(keys[i]!, keys[i + 1]!);
      expect(keys[i]! < mid && mid < keys[i + 1]!).toBe(true);
    }
  });
});
