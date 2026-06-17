// Pure month/week grid + document placement for the calendar view.
//
// NO React, NO hooks — just date math + bucketing. Date construction is
// UTC/string-based (Date.UTC + toISOString), NOT local `new Date(y,m,d)`, so the
// same input yields the same cells regardless of the runner's timezone (the
// classic calendar off-by-one-day bug). Week starts on Monday — Folio is
// EU/Dutch.

// Mirror packages/shared/src/field-infer.ts so calendar placement recognizes the
// same date / datetime surface the rest of Folio infers. A value matching
// neither (or empty / non-string) is unscheduled.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/;

export interface DayCell {
  /** 'YYYY-MM-DD' */
  iso: string;
  /** day-of-month (1-31) */
  day: number;
  /** false for leading/trailing filler days from the adjacent month */
  inMonth: boolean;
}

/**
 * Monday-start weekday index (0 = Monday .. 6 = Sunday) for a UTC epoch-ms value.
 * getUTCDay() is 0 = Sunday .. 6 = Saturday, so shift by 6 mod 7.
 */
function mondayIndex(utcMs: number): number {
  return (new Date(utcMs).getUTCDay() + 6) % 7;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 'YYYY-MM-DD' for a UTC epoch-ms value, derived deterministically. */
function isoOf(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** UTC day-of-month for a UTC epoch-ms value. */
function dayOf(utcMs: number): number {
  return new Date(utcMs).getUTCDate();
}

/**
 * 42-cell (6 weeks x 7 days) grid spanning the given month, with leading days
 * from the prior month and trailing days from the next, so the month always
 * fills a stable 6x7 Monday-start grid. `month` is 1-based (June = 6).
 */
export function buildMonthGrid(year: number, month: number): DayCell[] {
  // First day of the requested month, at UTC midnight.
  const firstOfMonthMs = Date.UTC(year, month - 1, 1);
  // Walk back to the Monday on or before the 1st.
  const startMs = firstOfMonthMs - mondayIndex(firstOfMonthMs) * DAY_MS;

  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const ms = startMs + i * DAY_MS;
    const d = new Date(ms);
    cells.push({
      iso: isoOf(ms),
      day: d.getUTCDate(),
      // 0-based month from UTC vs the requested 0-based month.
      inMonth: d.getUTCMonth() === month - 1 && d.getUTCFullYear() === year,
    });
  }
  return cells;
}

/**
 * The 7-day Monday-start week containing the given date. `month` is 1-based.
 * Cells in the queried month are inMonth:true; days that spill into an adjacent
 * month are inMonth:false.
 */
export function buildWeekGrid(year: number, month: number, day: number): DayCell[] {
  const targetMs = Date.UTC(year, month - 1, day);
  const startMs = targetMs - mondayIndex(targetMs) * DAY_MS;

  const cells: DayCell[] = [];
  for (let i = 0; i < 7; i++) {
    const ms = startMs + i * DAY_MS;
    const d = new Date(ms);
    cells.push({
      iso: isoOf(ms),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1 && d.getUTCFullYear() === year,
    });
  }
  return cells;
}

/**
 * Normalize a frontmatter value into a bucket key ('YYYY-MM-DD') or null.
 * A datetime (`2026-06-10T14:30:00Z`) is sliced to its date prefix. A value
 * that is non-string, empty, or matches neither the date nor datetime shape is
 * unscheduled (returns null).
 */
function bucketKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (DATE_RE.test(value)) return value;
  if (DATETIME_RE.test(value)) return value.slice(0, 10);
  return null;
}

export interface PlacementResult<T> {
  byDay: Record<string, T[]>;
  unscheduled: T[];
}

/**
 * Bucket docs by their `frontmatter[dateField]` value, keyed by ISO date. A doc
 * with no / empty / invalid date value lands in `unscheduled`. Input order is
 * preserved within each bucket.
 */
export function placeDocuments<T extends { slug: string; frontmatter: Record<string, unknown> }>(
  docs: T[],
  dateField: string,
): PlacementResult<T> {
  const byDay: Record<string, T[]> = {};
  const unscheduled: T[] = [];

  for (const doc of docs) {
    const key = bucketKey(doc.frontmatter[dateField]);
    if (key === null) {
      unscheduled.push(doc);
      continue;
    }
    const bucket = byDay[key];
    if (bucket === undefined) {
      byDay[key] = [doc];
    } else {
      bucket.push(doc);
    }
  }

  return { byDay, unscheduled };
}
