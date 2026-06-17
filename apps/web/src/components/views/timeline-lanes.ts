// Pure time-scale builder + range placement for the timeline (Gantt-ish) view.
//
// NO React, NO hooks — just date math + column placement. Date construction is
// UTC/string-based (Date.UTC + toISOString), NOT local `new Date(y,m,d)`, so the
// same input yields the same columns regardless of the runner's timezone (the
// classic off-by-one-day bug). Week starts on Monday — Folio is EU/Dutch.
//
// Date recognition is delegated to calendar-grid's `bucketKey`, so the timeline
// recognizes the exact same date / datetime frontmatter surface the calendar and
// field-infer do (a datetime is sliced to its YYYY-MM-DD prefix; non-string /
// empty / malformed values are date-less).
import { bucketKey } from './calendar-grid.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 'YYYY-MM-DD' for a UTC epoch-ms value, derived deterministically. */
function isoOf(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/**
 * Monday-start weekday index (0 = Monday .. 6 = Sunday) for a UTC epoch-ms value.
 * getUTCDay() is 0 = Sunday .. 6 = Saturday, so shift by 6 mod 7.
 */
function mondayIndex(utcMs: number): number {
  return (new Date(utcMs).getUTCDay() + 6) % 7;
}

/** UTC midnight epoch-ms for a 'YYYY-MM-DD' string. */
function msOf(iso: string): number {
  const parts = iso.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return Date.UTC(y, m - 1, d);
}

const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_SHORT = MONTH_LABELS.map((m) => m.slice(0, 3));

export type TimelineZoom = 'day' | 'week' | 'month';

export interface TimeColumn {
  /** Stable ISO-ish label — the column's start date, e.g. '2026-06-10'. */
  key: string;
  /** Human label, e.g. 'Jun 10' (day), 'Wk 24' (week), 'June' (month). */
  label: string;
  /** Inclusive 'YYYY-MM-DD' start of the column. */
  startIso: string;
  /** Inclusive 'YYYY-MM-DD' end of the column. */
  endIso: string;
}

/**
 * ISO-8601 week number for a UTC epoch-ms value (Monday-start, week 1 contains
 * the year's first Thursday). Used only for the human 'Wk NN' label.
 */
function isoWeekNumber(utcMs: number): number {
  // Shift to the Thursday of this week, then count weeks from Jan 1 of that year.
  const thursdayMs = utcMs - mondayIndex(utcMs) * DAY_MS + 3 * DAY_MS;
  const thursday = new Date(thursdayMs);
  const yearStartMs = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursdayMs - yearStartMs) / (7 * DAY_MS)) + 1;
}

/**
 * Build the ordered set of columns spanning the inclusive range
 * [rangeStart, rangeEnd] (both 'YYYY-MM-DD') at the given granularity.
 *
 * - `day`   → one column per calendar day.
 * - `week`  → one column per Monday-start week; the first column starts on the
 *             Monday on or before rangeStart, the last covers the week of rangeEnd.
 * - `month` → one column per calendar month; edges snap to the 1st and last day.
 *
 * The column a date falls into is found by comparing the date to [startIso, endIso].
 */
export function buildTimeScale(
  rangeStart: string,
  rangeEnd: string,
  zoom: TimelineZoom,
): TimeColumn[] {
  const startMs = msOf(rangeStart);
  const endMs = msOf(rangeEnd);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return [];

  const columns: TimeColumn[] = [];

  if (zoom === 'day') {
    for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
      const iso = isoOf(ms);
      const d = new Date(ms);
      columns.push({
        key: iso,
        label: `${MONTH_SHORT[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}`,
        startIso: iso,
        endIso: iso,
      });
    }
    return columns;
  }

  if (zoom === 'week') {
    // Walk back to the Monday on or before rangeStart.
    let weekStartMs = startMs - mondayIndex(startMs) * DAY_MS;
    while (weekStartMs <= endMs) {
      const weekEndMs = weekStartMs + 6 * DAY_MS;
      columns.push({
        key: isoOf(weekStartMs),
        label: `Wk ${isoWeekNumber(weekStartMs)}`,
        startIso: isoOf(weekStartMs),
        endIso: isoOf(weekEndMs),
      });
      weekStartMs += 7 * DAY_MS;
    }
    return columns;
  }

  // month — walk calendar months from rangeStart's month through rangeEnd's month.
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth(); // 0-based
  const endYear = endDate.getUTCFullYear();
  const endMonth = endDate.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const firstMs = Date.UTC(year, month, 1);
    // Last day of the month = day 0 of the next month.
    const lastMs = Date.UTC(year, month + 1, 0);
    columns.push({
      key: isoOf(firstMs),
      label: MONTH_LABELS[month] ?? '',
      startIso: isoOf(firstMs),
      endIso: isoOf(lastMs),
    });
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return columns;
}

export interface TimelineFields {
  startField: string;
  endField: string;
  fallbackField: string;
}

export interface PlacedBar {
  slug: string;
  /** 0-based column index where the bar begins (clamped to the scale). */
  colStart: number;
  /** Number of columns the bar spans; always >= 1, never overflows the scale. */
  colSpan: number;
  /** Present + true only when start > end was clamped to a valid span. */
  clamped?: boolean;
}

export interface TimelinePlacement<T> {
  placed: PlacedBar[];
  unplaced: T[];
}

/**
 * Find the 0-based index of the column whose [startIso, endIso] contains `iso`.
 * Returns -1 if before the first column, scale.length if after the last (the
 * caller clamps); a date strictly between columns cannot happen for the three
 * contiguous zoom levels, but we still bound-check defensively.
 */
function columnIndexFor(iso: string, scale: TimeColumn[]): number {
  const first = scale[0];
  const last = scale[scale.length - 1];
  if (first === undefined || last === undefined) return -1;
  if (iso < first.startIso) return -1;
  if (iso > last.endIso) return scale.length;
  for (let i = 0; i < scale.length; i++) {
    const col = scale[i];
    if (col !== undefined && iso >= col.startIso && iso <= col.endIso) return i;
  }
  return scale.length;
}

/**
 * Place docs onto the time scale as bars.
 *
 * - Range doc (BOTH startField AND endField are valid dates): spans from the
 *   start column through the end column inclusive.
 * - Single-date doc (only fallbackField, or only one of start/end): one column
 *   at the date in fallbackField → startField → endField (first valid wins).
 * - start > end: clamped to colSpan >= 1 AND flagged `clamped: true`.
 * - A date outside the scale: clamped to the visible edge (never overflows,
 *   never a negative colStart) — we clamp-to-edge rather than exclude, so a bar
 *   that pokes out of the visible window still renders against the boundary.
 * - A doc with no valid date in any field → `unplaced`.
 */
export function placeOnTimeline<T extends { slug: string; frontmatter: Record<string, unknown> }>(
  docs: T[],
  fields: TimelineFields,
  scale: TimeColumn[],
): TimelinePlacement<T> {
  const placed: PlacedBar[] = [];
  const unplaced: T[] = [];
  const lastIndex = scale.length - 1;

  for (const doc of docs) {
    const startKey = bucketKey(doc.frontmatter[fields.startField]);
    const endKey = bucketKey(doc.frontmatter[fields.endField]);

    if (startKey !== null && endKey !== null) {
      // Range doc. Detect inversion before clamping to the scale.
      const inverted = endKey < startKey;
      const lo = inverted ? endKey : startKey;
      const hi = inverted ? startKey : endKey;

      const rawStart = columnIndexFor(lo, scale);
      const rawEnd = columnIndexFor(hi, scale);
      const colStart = Math.min(Math.max(rawStart, 0), lastIndex);
      const colEnd = Math.min(Math.max(rawEnd, 0), lastIndex);
      const colSpan = Math.max(colEnd - colStart + 1, 1);

      const bar: PlacedBar = { slug: doc.slug, colStart, colSpan };
      if (inverted) bar.clamped = true;
      placed.push(bar);
      continue;
    }

    // Single-date: fallback first, then whichever of start/end is present.
    const single = bucketKey(doc.frontmatter[fields.fallbackField]) ?? startKey ?? endKey;
    if (single === null) {
      unplaced.push(doc);
      continue;
    }
    const raw = columnIndexFor(single, scale);
    const colStart = Math.min(Math.max(raw, 0), lastIndex);
    placed.push({ slug: doc.slug, colStart, colSpan: 1 });
  }

  return { placed, unplaced };
}
