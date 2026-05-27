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

// ---------------------------------------------------------------------------
// F13 — cron correctness fixes (Phase 2.6 review)
// ---------------------------------------------------------------------------

describe('F13: cron parser edge cases', () => {
  // F13.1 — dow=7 must be accepted as Sunday (croniter / cron(5) / unix-cron).
  it('accepts day-of-week 7 as Sunday equivalent to 0', () => {
    // 2026-05-31 is a Sunday.
    const out7 = nextFires('0 9 * * 7', 1, new Date('2026-05-30T08:00:00Z'));
    expect(out7).toHaveLength(1);
    expect(out7[0]).toBe('2026-05-31T09:00:00.000Z');
    // And 0 still works the same.
    const out0 = nextFires('0 9 * * 0', 1, new Date('2026-05-30T08:00:00Z'));
    expect(out0).toEqual(out7);
  });

  // G7 — F13's first-pass fix broke ranges containing 7. The post-process
  // remap (7→0 after expansion) preserves cross-rollover ranges correctly.
  it('G7: dow range 5-7 (Fri-Sun) fires Fri/Sat/Sun, not silently nothing', () => {
    // 2026-05-29 is a Friday. Expect three consecutive 09:00 fires.
    const out = nextFires('0 9 * * 5-7', 3, new Date('2026-05-28T08:00:00Z'));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('2026-05-29T09:00:00.000Z'); // Fri
    expect(out[1]).toBe('2026-05-30T09:00:00.000Z'); // Sat
    expect(out[2]).toBe('2026-05-31T09:00:00.000Z'); // Sun
  });

  it('G7: dow range 0-7 fires every day (Sunday once, not duplicated)', () => {
    // From Sat 2026-05-30 morning, the cron fires daily for the next week.
    const out = nextFires('0 9 * * 0-7', 7, new Date('2026-05-30T08:00:00Z'));
    expect(out).toHaveLength(7);
    expect(out[0]).toBe('2026-05-30T09:00:00.000Z'); // Sat
    expect(out[1]).toBe('2026-05-31T09:00:00.000Z'); // Sun
    expect(out[6]).toBe('2026-06-05T09:00:00.000Z'); // Fri
  });

  it('G7: dow range 1-7 fires Mon..Sun (every day)', () => {
    // Sun 2026-05-24 → 7 daily fires through Sat 2026-05-30. (7 normalizes
    // to 0/Sun, so range 1-7 covers all 7 days of the week.)
    const out = nextFires('0 9 * * 1-7', 7, new Date('2026-05-24T08:00:00Z'));
    expect(out).toHaveLength(7);
    expect(out[0]).toBe('2026-05-24T09:00:00.000Z'); // Sun
    expect(out[6]).toBe('2026-05-30T09:00:00.000Z'); // Sat
  });

  // F13.2 — leading-dash range `-1-5` must be rejected, not silently coerced
  // to {0,1}. Without this fix the cron runs at minutes 0 and 1 instead of
  // erroring at parse time.
  it('rejects leading-dash ranges in any field', () => {
    expect(nextFires('-1-5 * * * *', 1)).toEqual([]);
    expect(validateCronShape('-1-5 * * * *').ok).toBe(false);
  });

  // F13.3 — Three-part "ranges" like 5-10-15 must be rejected, not silently
  // truncated to 5-10. The user probably meant a comma list.
  it('rejects three-part ranges in any field', () => {
    expect(nextFires('0 9 5-10-15 * *', 1)).toEqual([]);
    expect(validateCronShape('0 9 5-10-15 * *').ok).toBe(false);
  });

  // F13.4 — Crons whose next firing is more than 366 days out (Feb 29 leap
  // day, or impossible like Feb 31) currently return []. At minimum the
  // parser should report this clearly via validateCronShape when the cron
  // is mathematically impossible. Feb 29 falls back to extended search now.
  it('extends search horizon to find Feb 29 within 4 years', () => {
    // 2025 was not a leap year; 2026 isn't either; 2027 isn't; 2028 is.
    const out = nextFires('0 0 29 2 *', 1, new Date('2025-03-01T00:00:00Z'));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rejects mathematically impossible day-of-month/month combos', () => {
    // Feb 31 never exists. The parser flags it at shape time so the UI can
    // surface a clearer error than "no upcoming fires".
    expect(validateCronShape('0 0 31 2 *').ok).toBe(false);
  });
});
