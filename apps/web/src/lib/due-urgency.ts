export type DueUrgency = 'overdue' | 'soon' | 'later' | 'none';

/** Classifies a date string by urgency relative to today.
 *  - overdue: today or in the past
 *  - soon: within the next 7 days
 *  - later: more than 7 days out
 *  - none: empty / unparseable
 */
export function dueUrgency(value: unknown, now: Date = new Date()): DueUrgency {
  if (value === null || value === undefined || value === '') return 'none';
  const s = typeof value === 'string' ? value : String(value);

  // Date-only strings ("YYYY-MM-DD") get parsed by `new Date()` as UTC
  // midnight, then getFullYear/Month/Date reads them back in local time —
  // in west-of-UTC zones that shifts to the previous day. Parse them as
  // local midnight directly so urgency tracks the user's local calendar.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const due = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(s);
  const dueTs = due.getTime();
  if (Number.isNaN(dueTs)) return 'none';

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const diffDays = Math.round((dueDay - today) / 86_400_000);
  if (diffDays <= 0) return 'overdue';
  if (diffDays <= 7) return 'soon';
  return 'later';
}

export function urgencyClasses(u: DueUrgency): string {
  switch (u) {
    case 'overdue': return 'text-danger';
    case 'soon': return 'text-warning';
    case 'later':
    case 'none':
    default: return '';
  }
}
