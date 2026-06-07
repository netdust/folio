import { relativeTime } from '../../lib/relative-time.ts';

/** "Last used 3d ago" / "Never used" — shared by both token list tabs. */
export function lastUsedLabel(iso: string | null): string {
  if (!iso) return 'Never used';
  const rel = relativeTime(iso);
  return rel ? `Last used ${rel}` : 'Never used';
}

/** "Expires 7/1/2026" / "Never expires" — shared by both token list tabs. */
export function expiresLabel(iso: string | null): string {
  if (!iso) return 'Never expires';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Never expires';
  return `Expires ${date.toLocaleDateString()}`;
}
