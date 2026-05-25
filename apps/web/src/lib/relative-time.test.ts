import { describe, it, expect } from 'vitest';
import { relativeTime } from './relative-time.ts';

describe('relativeTime', () => {
  it('returns "just now" for very recent timestamps', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now');
  });

  it('returns "Nm ago" for minutes', () => {
    const t = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(t)).toMatch(/^[45]m ago$/);
  });

  it('returns a localized date for entries older than a week', () => {
    const t = new Date(Date.now() - 30 * 86_400_000).toISOString();
    // Locale-dependent — just assert it's neither 'just now' nor an Invalid Date.
    const out = relativeTime(t);
    expect(out).not.toBe('just now');
    expect(out).not.toMatch(/Invalid/);
  });

  it('returns an empty string for unparseable input instead of "Invalid Date"', () => {
    // Server-side activity events occasionally arrive with a missing or
    // malformed createdAt (e.g. legacy seed rows). Showing "Invalid Date"
    // in the slideover's activity column is worse than showing nothing.
    expect(relativeTime('')).toBe('');
    expect(relativeTime('not-a-date')).toBe('');
  });
});
