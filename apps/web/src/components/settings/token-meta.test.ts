import { describe, it, expect } from 'vitest';
import { expiresLabel, lastUsedLabel } from './token-meta.ts';

describe('expiresLabel', () => {
  it('returns "Never expires" for null', () => {
    expect(expiresLabel(null)).toBe('Never expires');
  });

  it('returns "Never expires" for an unparseable date instead of "Expires Invalid Date"', () => {
    expect(expiresLabel('not-a-date')).toBe('Never expires');
  });

  it('returns "Expires <date>" for a valid ISO timestamp', () => {
    // Date is locale-formatted; assert the prefix + that the year is present.
    const out = expiresLabel('2027-01-01T00:00:00.000Z');
    expect(out).toMatch(/^Expires /);
    expect(out).toMatch(/2027/);
  });
});

describe('lastUsedLabel', () => {
  it('returns "Never used" for null', () => {
    expect(lastUsedLabel(null)).toBe('Never used');
  });

  it('returns "Last used <rel>" for a recent timestamp', () => {
    expect(lastUsedLabel(new Date().toISOString())).toMatch(/^Last used /);
  });
});
