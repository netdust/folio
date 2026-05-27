export interface CronShapeResult {
  ok: boolean;
  reason?: string;
}

const FIELD_RE = /^[0-9*,\-/]+$/;

/** Structural validation only — does NOT verify the cron is meaningful.
 *  Phase 3's scheduler does full evaluation when the trigger fires. */
export function validateCronShape(expr: string): CronShapeResult {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, reason: `cron must have 5 fields (got ${parts.length})` };
  }
  for (const p of parts) {
    if (!FIELD_RE.test(p)) {
      return { ok: false, reason: `cron field "${p}" contains invalid characters` };
    }
  }
  return { ok: true };
}

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
 *  Returns null on parse failure. */
function parseField(field: string, domain: FieldDomain): Set<number> | null {
  const out = new Set<number>();
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
      const [aStr, bStr] = rangePart.split('-');
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      start = a;
      end = b;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) return null;
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
  // Cap at ~one year of minutes (366 * 24 * 60).
  const maxIterations = 366 * 24 * 60;
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
