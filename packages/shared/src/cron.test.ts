import { describe, it, expect } from 'bun:test';
import { nextFires, validateCronShape } from './cron.ts';

describe('nextFires', () => {
  it('returns N upcoming ISO timestamps for a daily cron', () => {
    const out = nextFires('0 9 * * *', 3, new Date('2026-05-26T08:00:00Z'));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('2026-05-26T09:00:00.000Z');
    expect(out[1]).toBe('2026-05-27T09:00:00.000Z');
    expect(out[2]).toBe('2026-05-28T09:00:00.000Z');
  });

  it('handles */5 minute crons', () => {
    const out = nextFires('*/5 * * * *', 2, new Date('2026-05-26T08:03:00Z'));
    expect(out[0]).toBe('2026-05-26T08:05:00.000Z');
    expect(out[1]).toBe('2026-05-26T08:10:00.000Z');
  });

  it('handles ranges (1-5) on weekday', () => {
    // Monday=1..Friday=5. 2026-05-26 is a Tuesday. Should match Tue,Wed,Thu (3 weekdays).
    const out = nextFires('0 9 * * 1-5', 3, new Date('2026-05-26T08:00:00Z'));
    expect(out[0]).toBe('2026-05-26T09:00:00.000Z');
    expect(out[1]).toBe('2026-05-27T09:00:00.000Z');
    expect(out[2]).toBe('2026-05-28T09:00:00.000Z');
  });

  it('handles comma lists (0,30) on minute', () => {
    const out = nextFires('0,30 * * * *', 3, new Date('2026-05-26T08:15:00Z'));
    expect(out[0]).toBe('2026-05-26T08:30:00.000Z');
    expect(out[1]).toBe('2026-05-26T09:00:00.000Z');
    expect(out[2]).toBe('2026-05-26T09:30:00.000Z');
  });

  it('returns empty array on invalid cron', () => {
    expect(nextFires('not a cron', 3)).toEqual([]);
  });

  it('returns empty array when n <= 0', () => {
    expect(nextFires('0 9 * * *', 0)).toEqual([]);
  });
});

describe('validateCronShape (relocated)', () => {
  it('accepts 5-field crons', () => {
    expect(validateCronShape('0 9 * * *').ok).toBe(true);
    expect(validateCronShape('*/5 * * * *').ok).toBe(true);
    expect(validateCronShape('0 9 * * 1-5').ok).toBe(true);
  });

  it('rejects wrong field count', () => {
    const r = validateCronShape('0 9 * *');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('5 fields');
  });

  it('rejects invalid characters', () => {
    expect(validateCronShape('a b c d e').ok).toBe(false);
  });
});
