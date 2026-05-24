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
  const ts = new Date(s).getTime();
  if (Number.isNaN(ts)) return 'none';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const due = new Date(s);
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
