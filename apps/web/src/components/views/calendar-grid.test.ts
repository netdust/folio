import { describe, expect, it } from 'vitest';
import { buildMonthGrid, placeDocuments } from './calendar-grid.ts';

describe('buildMonthGrid', () => {
  it('returns a 42-cell (6x7) grid for June 2026', () => {
    const grid = buildMonthGrid(2026, 6);
    expect(grid).toHaveLength(42);
  });

  it('contains 2026-06-01 marked inMonth', () => {
    const grid = buildMonthGrid(2026, 6);
    expect(grid).toContainEqual({ iso: '2026-06-01', day: 1, inMonth: true });
  });

  it('starts each grid on a Monday (week starts Monday — EU/Dutch convention)', () => {
    // June 2026: the 1st is a Monday, so the first cell IS 2026-06-01.
    const grid = buildMonthGrid(2026, 6);
    expect(grid[0]).toEqual({ iso: '2026-06-01', day: 1, inMonth: true });
    // 2026-07-01 is a Wednesday → leading cells are Mon 2026-06-29, Tue 2026-06-30.
    const july = buildMonthGrid(2026, 7);
    expect(july[0]).toEqual({ iso: '2026-06-29', day: 29, inMonth: false });
    expect(july[1]).toEqual({ iso: '2026-06-30', day: 30, inMonth: false });
    expect(july[2]).toEqual({ iso: '2026-07-01', day: 1, inMonth: true });
  });

  it('marks leading and trailing filler days inMonth:false', () => {
    const july = buildMonthGrid(2026, 7);
    // leading filler from June
    expect(july[0].inMonth).toBe(false);
    // trailing filler: last cell is in August (next month)
    expect(july[41].inMonth).toBe(false);
    // all in-month cells carry inMonth:true
    const inMonthDays = july.filter((c) => c.inMonth).map((c) => c.day);
    expect(inMonthDays).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1), // July has 31 days
    );
  });

  it('places the last day of the month with inMonth:true (June 30)', () => {
    const grid = buildMonthGrid(2026, 6);
    expect(grid).toContainEqual({ iso: '2026-06-30', day: 30, inMonth: true });
  });

  it('returns 42 cells for a month that starts on Sunday (Feb 2026)', () => {
    // 2026-02-01 is a Sunday → 6 leading filler days (Mon-Sat of prior week).
    const grid = buildMonthGrid(2026, 2);
    expect(grid).toHaveLength(42);
    expect(grid).toContainEqual({ iso: '2026-02-01', day: 1, inMonth: true });
    // Feb 2026 has 28 days; last day present + inMonth.
    expect(grid).toContainEqual({ iso: '2026-02-28', day: 28, inMonth: true });
    // first cell is the Monday before: 2026-01-26.
    expect(grid[0]).toEqual({ iso: '2026-01-26', day: 26, inMonth: false });
  });

  it('handles a year boundary (Jan 2026 leading cells fall in Dec 2025)', () => {
    // 2026-01-01 is a Thursday → leading Mon/Tue/Wed are Dec 29/30/31 2025.
    const grid = buildMonthGrid(2026, 1);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ iso: '2025-12-29', day: 29, inMonth: false });
    expect(grid).toContainEqual({ iso: '2026-01-01', day: 1, inMonth: true });
  });

  it('is timezone-deterministic by construction (no local-time drift)', () => {
    // The 1st-of-month ISO must be exactly the input regardless of runner TZ —
    // a local-Date off-by-one would shift this to 2026-05-31 in TZ west of UTC.
    const grid = buildMonthGrid(2026, 6);
    const first = grid.find((c) => c.inMonth && c.day === 1);
    expect(first?.iso).toBe('2026-06-01');
  });
});

describe('placeDocuments', () => {
  it('buckets a dated doc by ISO date and separates undated docs', () => {
    const docs = [
      { slug: 'a', frontmatter: { due_date: '2026-06-10' } },
      { slug: 'b', frontmatter: {} },
    ];
    const { byDay, unscheduled } = placeDocuments(docs, 'due_date');
    expect(byDay['2026-06-10']).toEqual([docs[0]]);
    expect(unscheduled).toEqual([docs[1]]);
  });

  it('slices the date prefix from a datetime value for bucketing', () => {
    const docs = [{ slug: 'a', frontmatter: { due_date: '2026-06-10T09:00:00Z' } }];
    const { byDay, unscheduled } = placeDocuments(docs, 'due_date');
    expect(byDay['2026-06-10']).toEqual([docs[0]]);
    expect(unscheduled).toEqual([]);
  });

  it('routes an invalid date string to unscheduled (does not crash)', () => {
    const docs = [{ slug: 'a', frontmatter: { due_date: 'not-a-date' } }];
    const { byDay, unscheduled } = placeDocuments(docs, 'due_date');
    expect(byDay).toEqual({});
    expect(unscheduled).toEqual([docs[0]]);
  });

  it('routes empty-string, non-string, and missing values to unscheduled', () => {
    const docs = [
      { slug: 'empty', frontmatter: { due_date: '' } },
      { slug: 'num', frontmatter: { due_date: 20260610 } },
      { slug: 'null', frontmatter: { due_date: null } },
      { slug: 'absent', frontmatter: {} },
    ];
    const { byDay, unscheduled } = placeDocuments(docs, 'due_date');
    expect(byDay).toEqual({});
    expect(unscheduled).toEqual(docs);
  });

  it('buckets multiple docs on the same day in input order', () => {
    const docs = [
      { slug: 'a', frontmatter: { due_date: '2026-06-10' } },
      { slug: 'b', frontmatter: { due_date: '2026-06-10' } },
      { slug: 'c', frontmatter: { due_date: '2026-06-11' } },
    ];
    const { byDay } = placeDocuments(docs, 'due_date');
    expect(byDay['2026-06-10']).toEqual([docs[0], docs[1]]);
    expect(byDay['2026-06-11']).toEqual([docs[2]]);
  });

  it('rejects a malformed near-date (wrong digit count) as unscheduled', () => {
    const docs = [
      { slug: 'short', frontmatter: { due_date: '2026-6-1' } },
      { slug: 'long', frontmatter: { due_date: '2026-06-100' } },
    ];
    const { byDay, unscheduled } = placeDocuments(docs, 'due_date');
    expect(byDay).toEqual({});
    expect(unscheduled).toEqual(docs);
  });

  it('reads the configured dateField, not a hard-coded due_date', () => {
    const docs = [{ slug: 'a', frontmatter: { start_on: '2026-06-10', due_date: 'nope' } }];
    const { byDay } = placeDocuments(docs, 'start_on');
    expect(byDay['2026-06-10']).toEqual([docs[0]]);
  });
});
