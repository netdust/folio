import { useEffect, useMemo, useState } from 'react';
import { useDocuments } from '../../lib/api/documents.ts';
import { DEFAULT_TABLE_SLUG } from '../../lib/default-table.ts';
import { cn } from '../ui/cn.ts';

interface WikiLinkPickerProps {
  workspaceSlug: string;
  projectSlug: string;
  query: string;
  onSelect: (target: { slug: string; title: string }) => void;
  onClose: () => void;
}

export function WikiLinkPicker({
  workspaceSlug,
  projectSlug,
  query,
  onSelect,
  onClose,
}: WikiLinkPickerProps) {
  // [[wiki-link]] candidate resolution. The picker is rendered from the comment
  // composer (comment-composer.tsx) — it has NO route :tslug context and no
  // tslug prop, so it targets DEFAULT_TABLE_SLUG. pages ignore tslug server-side
  // (project-scoped); the work_item set is current-table-scoped — the same
  // accepted v1 cross-table-relation limitation as the slideover relation
  // resolver (no project-wide cross-table document endpoint exists).
  const pagesQ = useDocuments(workspaceSlug, projectSlug, DEFAULT_TABLE_SLUG, { type: 'page' });
  const itemsQ = useDocuments(workspaceSlug, projectSlug, DEFAULT_TABLE_SLUG, { type: 'work_item' });

  const allDocs = useMemo(
    () => [...(pagesQ.data?.data ?? []), ...(itemsQ.data?.data ?? [])],
    [pagesQ.data, itemsQ.data],
  );

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return allDocs;
    return allDocs.filter((d) => d.title.toLowerCase().includes(q));
  }, [allDocs, q]);

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selection when the filtered shape changes (e.g. query changes).
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
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">DOCUMENTS</div>

      {allDocs.length === 0 ? (
        <div className="px-2 py-1 text-xs text-fg-3">No documents in this project</div>
      ) : filtered.length === 0 ? (
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
