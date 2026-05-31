import { useEffect, useMemo, useState } from 'react';
import { cn } from '../ui/cn.ts';

export interface RelationCandidate {
  id: string;
  slug: string;
  title: string;
}

interface RelationPickerProps {
  candidates: RelationCandidate[];
  query: string;
  excludeSlugs?: string[];
  onSelect: (target: { slug: string; title: string }) => void;
  onClose: () => void;
}

export function RelationPicker({
  candidates,
  query,
  excludeSlugs = [],
  onSelect,
  onClose,
}: RelationPickerProps) {
  const exclude = useMemo(() => new Set(excludeSlugs), [excludeSlugs]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      candidates
        .filter((d) => !exclude.has(d.slug))
        .filter((d) => (q ? d.title.toLowerCase().includes(q) : true)),
    [candidates, exclude, q],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (filtered.length > 0 ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) =>
        filtered.length > 0 ? (i - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const doc = filtered[selectedIndex];
      if (doc) onSelect({ slug: doc.slug, title: doc.title });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      role="listbox"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-border-light bg-content p-1 shadow-md w-[260px]"
    >
      {filtered.length === 0 ? (
        <div className="px-2 py-1 text-xs text-fg-3">No matching documents</div>
      ) : (
        filtered.map((d, i) => {
          const isSel = selectedIndex === i;
          return (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={isSel}
              onClick={() => onSelect({ slug: d.slug, title: d.title })}
              className={cn(
                'block w-full rounded-md px-2 py-1.5 text-left text-sm',
                isSel ? 'bg-card' : 'hover:bg-card',
              )}
            >
              <div className="font-medium">{d.title}</div>
              <div className="text-[10px] font-mono text-fg-3">{`[[${d.slug}]]`}</div>
            </button>
          );
        })
      )}
    </div>
  );
}
