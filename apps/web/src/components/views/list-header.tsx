export type SortKey = 'title' | 'status' | 'updated_at' | 'priority';
export type SortDir = 'asc' | 'desc';
export interface SortState { key: SortKey; dir: SortDir; }

interface Props {
  sort: SortState | null;        // null = default (updated_at desc)
  onSort: (next: SortState | null) => void;
}

const COLS: Array<{ key: SortKey; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'updated_at', label: 'Updated' },
];

export function ListHeader({ sort, onSort }: Props) {
  return (
    <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border-light bg-content px-4 py-1.5 text-[11px] uppercase tracking-wide text-fg-3">
      {COLS.map((c) => (
        <button
          key={c.key}
          type="button"
          className="inline-flex items-center gap-1 text-left hover:text-fg-2"
          onClick={() => {
            const isActive = sort?.key === c.key;
            if (!isActive) onSort({ key: c.key, dir: 'asc' });
            else if (sort.dir === 'asc') onSort({ key: c.key, dir: 'desc' });
            else onSort(null);
          }}
        >
          {c.label}
          {sort?.key === c.key ? (
            <span className="font-mono text-[10px]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
