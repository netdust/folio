import { describe, expect, it } from 'vitest';
import { buildTimeScale, placeOnTimeline } from './timeline-lanes.ts';

const FIELDS = { startField: 'start_date', endField: 'end_date', fallbackField: 'due_date' };

describe('buildTimeScale', () => {
  it('builds one column per day across an inclusive day range', () => {
    const scale = buildTimeScale('2026-06-01', '2026-06-30', 'day');
    expect(scale).toHaveLength(30);
    expect(scale[0].startIso).toBe('2026-06-01');
    expect(scale[0].endIso).toBe('2026-06-01');
    expect(scale[29].startIso).toBe('2026-06-30');
  });

  it('day columns are ordered ascending', () => {
    const scale = buildTimeScale('2026-06-01', '2026-06-05', 'day');
    const isos = scale.map((c) => c.startIso);
    expect(isos).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']);
  });

  it('builds Monday-start week columns covering the range', () => {
    // 2026-06-01 is a Monday. Range 2026-06-01..2026-06-21 spans 3 full weeks.
    const scale = buildTimeScale('2026-06-01', '2026-06-21', 'week');
    expect(scale).toHaveLength(3);
    expect(scale[0].startIso).toBe('2026-06-01');
    expect(scale[0].endIso).toBe('2026-06-07');
    expect(scale[1].startIso).toBe('2026-06-08');
    expect(scale[2].startIso).toBe('2026-06-15');
  });

  it('week scale starts on the Monday on or before rangeStart', () => {
    // 2026-06-03 is a Wednesday → its week starts Monday 2026-06-01.
    const scale = buildTimeScale('2026-06-03', '2026-06-10', 'week');
    expect(scale[0].startIso).toBe('2026-06-01');
    expect(scale[0].endIso).toBe('2026-06-07');
    expect(scale[1].startIso).toBe('2026-06-08');
  });

  it('builds one column per calendar month', () => {
    const scale = buildTimeScale('2026-06-10', '2026-06-25', 'month');
    expect(scale).toHaveLength(1);
    expect(scale[0].startIso).toBe('2026-06-01');
    expect(scale[0].endIso).toBe('2026-06-30');
  });

  it('builds month columns across a multi-month range with the right edges', () => {
    const scale = buildTimeScale('2026-05-15', '2026-07-03', 'month');
    expect(scale).toHaveLength(3);
    expect(scale[0].startIso).toBe('2026-05-01');
    expect(scale[0].endIso).toBe('2026-05-31');
    expect(scale[1].startIso).toBe('2026-06-01');
    expect(scale[1].endIso).toBe('2026-06-30');
    expect(scale[2].startIso).toBe('2026-07-01');
    expect(scale[2].endIso).toBe('2026-07-31');
  });

  it('each column carries a stable key and a human label', () => {
    const day = buildTimeScale('2026-06-10', '2026-06-10', 'day')[0];
    expect(day.key).toBe('2026-06-10');
    expect(typeof day.label).toBe('string');
    expect(day.label.length).toBeGreaterThan(0);
  });
});

describe('placeOnTimeline', () => {
  const dayScale = buildTimeScale('2026-06-01', '2026-06-30', 'day');

  it('places a single-date (fallback) doc as 1 column and a range doc as a multi-column span', () => {
    const docs = [
      { slug: 'a', frontmatter: { due_date: '2026-06-10' } },
      { slug: 'b', frontmatter: { start_date: '2026-06-05', end_date: '2026-06-08' } },
    ];
    const { placed, unplaced } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(unplaced).toHaveLength(0);

    const a = placed.find((p) => p.slug === 'a');
    const b = placed.find((p) => p.slug === 'b');
    // 'a' falls on June 10 → column index 9, span 1.
    expect(a).toMatchObject({ slug: 'a', colStart: 9, colSpan: 1 });
    // 'b' spans June 5..8 → columns 4..7 → colStart 4, colSpan 4.
    expect(b).toMatchObject({ slug: 'b', colStart: 4, colSpan: 4 });
  });

  it('treats start == end as a 1-column span', () => {
    const docs = [{ slug: 'c', frontmatter: { start_date: '2026-06-10', end_date: '2026-06-10' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed[0]).toMatchObject({ slug: 'c', colStart: 9, colSpan: 1 });
  });

  it('clamps start > end to span >= 1 and flags it (clamped: true)', () => {
    // Adversarial / denial path: an inverted range must never yield a zero/negative span.
    const docs = [{ slug: 'd', frontmatter: { start_date: '2026-06-08', end_date: '2026-06-05' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed).toHaveLength(1);
    expect(placed[0].colSpan).toBeGreaterThanOrEqual(1);
    expect(placed[0].clamped).toBe(true);
  });

  it('falls back to fallbackField when only one of start/end is present', () => {
    const docs = [{ slug: 'e', frontmatter: { start_date: '2026-06-12', due_date: '2026-06-20' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    // Only start present → not a range → single-date placement via fallback (due_date June 20).
    expect(placed[0]).toMatchObject({ slug: 'e', colStart: 19, colSpan: 1 });
  });

  it('places a doc with only a start date (no end, no fallback) as a single column', () => {
    const docs = [{ slug: 'f', frontmatter: { start_date: '2026-06-03' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed[0]).toMatchObject({ slug: 'f', colStart: 2, colSpan: 1 });
  });

  it('puts a doc with no valid date in any field into unplaced', () => {
    const docs = [
      { slug: 'g', frontmatter: {} },
      { slug: 'h', frontmatter: { due_date: 'not-a-date' } },
      { slug: 'i', frontmatter: { start_date: 12345 } },
    ];
    const { placed, unplaced } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed).toHaveLength(0);
    expect(unplaced.map((d) => d.slug).sort()).toEqual(['g', 'h', 'i']);
  });

  it('clamps a bar whose range starts before the scale to the visible left edge', () => {
    const docs = [{ slug: 'j', frontmatter: { start_date: '2026-05-20', end_date: '2026-06-03' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed[0].colStart).toBe(0);
    // June 3 is column 2 → from clamped start 0, span covers 0..2 inclusive = 3.
    expect(placed[0].colStart + placed[0].colSpan).toBeLessThanOrEqual(dayScale.length);
    expect(placed[0]).toMatchObject({ colStart: 0, colSpan: 3 });
  });

  it('clamps a bar whose range ends after the scale to the visible right edge', () => {
    const docs = [{ slug: 'k', frontmatter: { start_date: '2026-06-28', end_date: '2026-07-15' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed[0].colStart).toBe(27);
    expect(placed[0].colStart + placed[0].colSpan).toBe(dayScale.length);
  });

  it('normalizes a datetime value to its date for placement', () => {
    const docs = [{ slug: 'l', frontmatter: { due_date: '2026-06-10T14:30:00Z' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, dayScale);
    expect(placed[0]).toMatchObject({ slug: 'l', colStart: 9, colSpan: 1 });
  });

  it('maps a known date to the expected column at week zoom (TZ-independent by construction)', () => {
    const weekScale = buildTimeScale('2026-06-01', '2026-06-21', 'week');
    const docs = [{ slug: 'm', frontmatter: { due_date: '2026-06-10' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, weekScale);
    // June 10 is in the 2026-06-08 week → column index 1.
    expect(placed[0]).toMatchObject({ slug: 'm', colStart: 1, colSpan: 1 });
  });

  it('maps a known date to the expected column at month zoom', () => {
    const monthScale = buildTimeScale('2026-05-01', '2026-07-31', 'month');
    const docs = [{ slug: 'n', frontmatter: { due_date: '2026-06-10' } }];
    const { placed } = placeOnTimeline(docs, FIELDS, monthScale);
    // June is the second month column → index 1.
    expect(placed[0]).toMatchObject({ slug: 'n', colStart: 1, colSpan: 1 });
  });
});
