import { cn } from '../ui/cn.ts';

const TOKEN_RE = /^\[\[([\w-]+)\]\]$/;

export interface RelationCellProps {
  value: unknown;
  resolve: (slug: string) => { slug: string; title: string } | null;
  onChipClick?: (slug: string) => void;
}

function toTokens(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

export function RelationCell({ value, resolve, onChipClick }: RelationCellProps) {
  const tokens = toTokens(value);
  if (tokens.length === 0) return <span className="text-fg-3">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tokens.map((tok) => {
        const m = TOKEN_RE.exec(tok);
        const slug = m?.[1];
        const resolved = slug ? resolve(slug) : null;
        if (!resolved) {
          return (
            <span
              key={tok}
              className="rounded-sm bg-card px-1.5 py-0.5 text-xs font-mono text-fg-3 line-through"
            >
              {tok}
            </span>
          );
        }
        return (
          <button
            key={tok}
            type="button"
            onClick={() => onChipClick?.(resolved.slug)}
            className="rounded-sm bg-card px-1.5 py-0.5 text-xs hover:bg-border-light"
          >
            {resolved.title}
          </button>
        );
      })}
    </span>
  );
}
