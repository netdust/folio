import { describe, it, expect } from 'vitest';
import { dueUrgency } from './due-urgency.ts';

describe('dueUrgency', () => {
  const now = new Date('2026-05-24T12:00:00Z');

  it('returns "none" for empty / unparseable values', () => {
    expect(dueUrgency(null, now)).toBe('none');
    expect(dueUrgency(undefined, now)).toBe('none');
    expect(dueUrgency('', now)).toBe('none');
    expect(dueUrgency('not-a-date', now)).toBe('none');
  });

  it('returns "overdue" for today and past dates', () => {
    expect(dueUrgency('2026-05-24', now)).toBe('overdue');
    expect(dueUrgency('2026-05-23', now)).toBe('overdue');
    expect(dueUrgency('2025-01-01', now)).toBe('overdue');
  });

  it('returns "soon" for next 1–7 days', () => {
    expect(dueUrgency('2026-05-25', now)).toBe('soon');
    expect(dueUrgency('2026-05-31', now)).toBe('soon');
  });

  it('returns "later" for >7 days out', () => {
    expect(dueUrgency('2026-06-01', now)).toBe('later');
    expect(dueUrgency('2027-01-01', now)).toBe('later');
  });
});
