export function relativeTime(iso: string): string {
  // Guard against missing or malformed input — `new Date('').getTime()` is
  // NaN, every diff comparison is false, and the fallback returns the literal
  // "Invalid Date" string. An empty string is more honest in the UI.
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const now = Date.now();
  const diff = Math.round((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
