export interface CronShapeResult {
  ok: boolean;
  reason?: string;
}

const FIELD_RE = /^[0-9*,\-/]+$/;

/**
 * Per-field structural check. Rejects:
 *  - empty parts (e.g. trailing comma `1,`)
 *  - leading-dash ranges (`-1-5` → silently coerced before F13)
 *  - more than two dash-separated values per range part (`5-10-15`)
 *  - characters outside the cron alphabet
 */
function isFieldStructurallyValid(field: string): boolean {
  if (!FIELD_RE.test(field)) return false;
  for (const part of field.split(',')) {
    if (part === '') return false;
    const [rangePart, ...stepRest] = part.split('/');
    if (rangePart === undefined) return false;
    if (stepRest.length > 1) return false;
    // F13: ranges like `5-10-15` or leading-dash `-1-5` must be rejected.
    if (rangePart !== '*' && rangePart.includes('-')) {
      const range = rangePart.split('-');
      if (range.length !== 2) return false; // 3+ parts like 5-10-15
      const [aStr, bStr] = range;
      if (!aStr || !bStr) return false; // leading or trailing dash
    }
  }
  return true;
}

/** Structural validation. Phase 3's scheduler does full evaluation when the
 *  trigger fires, but the obviously-impossible shapes are caught here so the
 *  UI shows a clearer error than "no upcoming fires". */
export function validateCronShape(expr: string): CronShapeResult {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, reason: `cron must have 5 fields (got ${parts.length})` };
  }
  for (const p of parts) {
    if (!isFieldStructurallyValid(p)) {
      return { ok: false, reason: `cron field "${p}" is invalid` };
    }
  }

  // F13 — flag mathematically impossible day-of-month / month combos.
  // Feb 30 / Feb 31 / Apr 31 / Jun 31 / Sep 31 / Nov 31 never fire, so let
  // the user know at shape time rather than handing back an empty preview.
  const [_, __, domField, monthField] = parts as [string, string, string, string, string];
  const months = parseFieldNumbers(monthField, DOMAINS.month);
  const days = parseFieldNumbers(domField, DOMAINS.dom);
  if (months && days && months.size > 0 && days.size > 0) {
    let anyReachable = false;
    for (const m of months) {
      const maxDay = MAX_DAY_IN_MONTH[m] ?? 31;
      for (const d of days) {
        if (d <= maxDay) { anyReachable = true; break; }
      }
      if (anyReachable) break;
    }
    if (!anyReachable) {
      return {
        ok: false,
        reason: 'day-of-month / month combination never occurs',
      };
    }
  }

  return { ok: true };
}

// Maximum number of days in each month, indexed 1..12. Use 29 for Feb so that
// `0 0 29 2 *` is still considered reachable; the actual leap-year search is
// up to nextFires.
const MAX_DAY_IN_MONTH: Record<number, number> = {
  1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
  7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
};

interface FieldDomain {
  min: number;
  max: number;
}

const DOMAINS: { minute: FieldDomain; hour: FieldDomain; dom: FieldDomain; month: FieldDomain; dow: FieldDomain } = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
};

/** Parse a single cron field into a Set of allowed integer values.
 *  Returns null on parse failure. Rejects structurally invalid shapes the
 *  same way validateCronShape does (leading-dash, 3+ part ranges, empty
 *  parts). */
function parseField(field: string, domain: FieldDomain): Set<number> | null {
  if (!isFieldStructurallyValid(field)) return null;
  const out = new Set<number>();
  // dow=7 is Sunday equivalent to 0 in cron(5) / unix-cron / croniter; the
  // domain's max=6 rejects it without this normalization.
  const isDow = domain.max === 6 && domain.min === 0;
  for (const part of field.split(',')) {
    if (part === '') return null;

    // Step form: <range>/<step> or */<step>
    let rangePart = part;
    let step = 1;
    const slashIdx = part.indexOf('/');
    if (slashIdx !== -1) {
      rangePart = part.slice(0, slashIdx);
      const stepStr = part.slice(slashIdx + 1);
      const parsedStep = Number(stepStr);
      if (!Number.isInteger(parsedStep) || parsedStep <= 0) return null;
      step = parsedStep;
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = domain.min;
      end = domain.max;
    } else if (rangePart.includes('-')) {
      const range = rangePart.split('-');
      if (range.length !== 2) return null; // 3+ parts: belt-and-braces, also caught upstream
      const [aStr, bStr] = range;
      if (!aStr || !bStr) return null; // leading/trailing dash
      let a = Number(aStr);
      let b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      // F13: normalize dow=7 to 0 (Sunday).
      if (isDow) {
        if (a === 7) a = 0;
        if (b === 7) b = 0;
      }
      start = a;
      end = b;
    } else {
      let v = Number(rangePart);
      if (!Number.isInteger(v)) return null;
      // F13: normalize dow=7 to 0 (Sunday).
      if (isDow && v === 7) v = 0;
      start = v;
      // For single value with step (e.g. "5/10"), iterate from 5 to max.
      end = slashIdx !== -1 ? domain.max : v;
    }

    if (start < domain.min || end > domain.max || start > end) return null;
    for (let i = start; i <= end; i += step) {
      out.add(i);
    }
  }
  return out;
}

/** Lighter-weight parse used by validateCronShape's impossible-combo check.
 *  Returns the numeric set or null if the field can't be parsed. */
function parseFieldNumbers(field: string, domain: FieldDomain): Set<number> | null {
  return parseField(field, domain);
}

/** Returns N upcoming ISO timestamps (`.toISOString()` format) when the cron
 *  will next fire, starting strictly AFTER `now`. Returns `[]` if the cron
 *  is invalid or n <= 0. Walks in UTC; no timezone or DST handling. */
export function nextFires(cron: string, n: number, now: Date = new Date()): string[] {
  if (n <= 0) return [];
  if (!validateCronShape(cron).ok) return [];

  const parts = cron.trim().split(/\s+/);
  // validateCronShape guaranteed exactly 5 parts above.
  const [minuteField, hourField, domField, monthField, dowField] = parts as [string, string, string, string, string];
  const minuteSet = parseField(minuteField, DOMAINS.minute);
  const hourSet = parseField(hourField, DOMAINS.hour);
  const domSet = parseField(domField, DOMAINS.dom);
  const monthSet = parseField(monthField, DOMAINS.month);
  const dowSet = parseField(dowField, DOMAINS.dow);
  if (!minuteSet || !hourSet || !domSet || !monthSet || !dowSet) return [];

  // Detect whether DOM / DOW are restricted (non-wildcard). Standard cron
  // semantic: when BOTH restricted, match if EITHER matches.
  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  // Start at floor(now to minute) + 1 minute. Seconds/ms = 0.
  let cursor = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;

  const out: string[] = [];
  // F13 — extend search horizon to cover leap-year-only crons like
  // `0 0 29 2 *`. A bit over 4 years of minutes; impossible crons are now
  // pre-rejected at validateCronShape time so we don't waste this budget on
  // dead loops. 4*366 days * 24h * 60min = 2,108,160.
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations && out.length < n; i++) {
    const d = new Date(cursor);
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dom = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();

    const minuteOk = minuteSet.has(minute);
    const hourOk = hourSet.has(hour);
    const monthOk = monthSet.has(month);

    let dayOk: boolean;
    if (domRestricted && dowRestricted) {
      dayOk = domSet.has(dom) || dowSet.has(dow);
    } else if (domRestricted) {
      dayOk = domSet.has(dom);
    } else if (dowRestricted) {
      dayOk = dowSet.has(dow);
    } else {
      dayOk = true;
    }

    if (minuteOk && hourOk && monthOk && dayOk) {
      out.push(d.toISOString());
    }

    cursor += 60_000;
  }

  return out;
}
