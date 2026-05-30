import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../ui/cn.ts';
import type { DocumentSummary } from '../../lib/api/documents.ts';

interface Props {
  /** In-cache documents to pick from. No fetch — driven by the editor's prop. */
  documents: DocumentSummary[];
  query: string;
  rect: { top: number; left: number };
  onSelect: (slug: string) => void;
  onClose: () => void;
}

/** Filter the in-cache documents by a `[[` trigger query (title or slug). */
function filterDocuments(documents: DocumentSummary[], query: string): DocumentSummary[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? documents.filter((d) => d.title.toLowerCase().includes(q) || d.slug.includes(q))
    : documents;
  return matches.slice(0, 8);
}

/**
 * Lightweight document picker for the `[[` wiki-link trigger. Mirrors
 * SlashMenu's presentation + keyboard nav, but lists documents from the
 * editor's in-cache `documents` prop (no fetch) rather than the slash registry.
 */
export function WikiMenu({ documents, query, rect, onSelect, onClose }: Props) {
  const items = useMemo(() => filterDocuments(documents, query), [documents, query]);
  const [active, setActive] = useState(0);

  useEffect(() => setActive(0), [query]);

  // Stable refs so the keydown handler attaches once.
  const activeRef = useRef(active);
  activeRef.current = active;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(itemsRef.current.length - 1, a + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = itemsRef.current[activeRef.current];
        if (it) onSelectRef.current(it.slug);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Link to document"
      className="fixed z-[60] max-w-[320px] rounded-md bg-content shadow-popover"
      style={{ top: rect.top, left: rect.left }}
    >
      <ul className="flex max-h-72 flex-col overflow-auto p-1">
        {items.map((it, i) => (
          <li key={it.id} role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => onSelect(it.slug)}
              className={cn(
                'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                i === active ? 'bg-card' : 'hover:bg-card',
              )}
            >
              <span className="flex-1">
                <span className="block font-medium text-fg">{it.title}</span>
                <span className="block font-mono text-[11px] text-fg-3">[[{it.slug}]]</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
