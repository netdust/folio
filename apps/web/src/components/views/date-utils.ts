/**
 * Shared UTC-only date helpers for the view renderers (calendar grid, timeline
 * lanes, timeline drag). Date construction is deliberately UTC-string-based
 * (Date.UTC + toISOString().slice(0,10)) and NEVER `new Date(year, month, day)`
 * local-time — so a grid/scale is identical regardless of the runner's or the
 * user's timezone (the calendar off-by-one-day bug class is structurally closed).
 *
 * Extracted from calendar-grid.ts / timeline-lanes.ts / timeline-view.tsx, which
 * each carried byte-identical copies (the Cluster-5 review flagged the
 * triplication). One home keeps the TZ-safety discipline from drifting per-copy.
 */

/** Milliseconds in one UTC day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 'YYYY-MM-DD' for a UTC epoch-ms value, derived deterministically. */
export function isoOf(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** UTC-midnight epoch-ms for a 'YYYY-MM-DD' string (NaN if malformed). */
export function msOfIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/**
 * Monday-start weekday index (0 = Monday .. 6 = Sunday) for a UTC epoch-ms value.
 * getUTCDay() is 0 = Sunday .. 6 = Saturday, so shift by 6 mod 7.
 */
export function mondayIndex(utcMs: number): number {
  return (new Date(utcMs).getUTCDay() + 6) % 7;
}
