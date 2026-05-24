import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { cn } from '../ui/cn.ts';
import type { NavItem } from './rail.tsx';

function useExpanded(id: string, defaultOpen = false): [boolean, (v: boolean) => void] {
  const key = `folio:rail-expanded:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return defaultOpen;
    const v = localStorage.getItem(key);
    return v === null ? defaultOpen : v === '1';
  });
  useEffect(() => {
    localStorage.setItem(key, open ? '1' : '0');
  }, [key, open]);
  return [open, setOpen];
}

export function RailTree({ items, depth = 0 }: { items: NavItem[]; depth?: number }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <RailTreeNode key={item.id} item={item} depth={depth} />
      ))}
    </ul>
  );
}

function RailTreeNode({ item, depth }: { item: NavItem; depth: number }) {
  const hasChildren = !!item.children && item.children.length > 0;
  // Default: top-level rows start expanded; deeper rows start collapsed.
  const [expanded, setExpanded] = useExpanded(item.id, depth === 0);

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-fast',
          item.active ? 'bg-nav-active text-fg' : 'text-fg-3 hover:bg-card hover:text-fg-2',
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
            data-testid="rail-tree-chevron"
            onClick={() => setExpanded(!expanded)}
            className="grid h-4 w-4 place-items-center rounded text-fg-2 hover:text-fg"
          >
            <Icon
              icon={ChevronRight}
              size={14}
              className={cn('transition-transform duration-fast', expanded ? 'rotate-90' : '')}
            />
          </button>
        ) : (
          <span className="inline-block h-4 w-4" aria-hidden />
        )}

        {item.lucideIcon ? (
          <Icon icon={item.lucideIcon} size={14} className="text-fg-3 shrink-0" />
        ) : item.icon ? (
          <span className="inline-grid h-[14px] w-[14px] place-items-center text-fg-3 shrink-0">{item.icon}</span>
        ) : null}

        <button
          type="button"
          onClick={item.onClick}
          data-testid="rail-tree-item"
          className="flex-1 truncate text-left"
        >
          {item.label}
        </button>

        {item.trailing ? <span className="ml-auto opacity-60 hover:opacity-100 transition-opacity duration-fast">{item.trailing}</span> : null}
      </div>

      {hasChildren && expanded ? <RailTree items={item.children ?? []} depth={depth + 1} /> : null}
    </li>
  );
}
