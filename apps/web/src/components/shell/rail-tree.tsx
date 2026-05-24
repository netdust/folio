import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { cn } from '../ui/cn.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import type { NavItem, RowMenuItem } from './rail.tsx';

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
  const [expanded, setExpanded] = useExpanded(item.id, depth === 0);
  const [renaming, setRenaming] = useState(false);

  const onLabelClick = () => {
    if (hasChildren) setExpanded(!expanded);
    item.onClick?.();
  };

  return (
    <li>
      <div
        className={cn(
          'group/row flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors duration-fast',
          item.active ? 'bg-nav-active text-fg' : 'text-fg-3 hover:bg-card hover:text-fg-2',
        )}
        style={{ paddingLeft: `${8 + depth * 10}px` }}
      >
        {item.lucideIcon ? (
          <Icon icon={item.lucideIcon} size={14} className="text-fg-3 shrink-0" />
        ) : item.icon ? (
          <span className="inline-grid h-[14px] w-[14px] place-items-center text-fg-3 shrink-0">{item.icon}</span>
        ) : null}

        {renaming && item.onRename ? (
          <RenameInput initial={item.label} onCommit={(next) => { item.onRename!(next); setRenaming(false); }} onCancel={() => setRenaming(false)} />
        ) : (
          <button
            type="button"
            onClick={onLabelClick}
            onDoubleClick={item.onRename ? () => setRenaming(true) : undefined}
            data-testid="rail-tree-item"
            aria-expanded={hasChildren ? expanded : undefined}
            className="flex-1 truncate text-left"
          >
            {item.label}
          </button>
        )}

        {(() => {
          const renameItem: RowMenuItem | null = item.onRename
            ? { label: 'Rename', onSelect: () => setRenaming(true) }
            : null;
          const menuItems = renameItem
            ? [renameItem, ...(item.menuItems ?? [])]
            : (item.menuItems ?? []);
          const hasMenu = menuItems.length > 0;
          if (!hasMenu && !item.onPlus) return null;
          return (
            <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity duration-fast">
              {hasMenu ? <RowMenu items={menuItems} /> : null}
              {item.onPlus ? (
                <button
                  type="button"
                  aria-label={item.plusLabel ?? 'Create'}
                  title={item.plusLabel ?? 'Create'}
                  data-testid="rail-tree-plus"
                  onClick={(e) => { e.stopPropagation(); item.onPlus!(); }}
                  className="grid h-4 w-4 place-items-center rounded text-fg-2 hover:bg-card hover:text-fg"
                >
                  <Icon icon={Plus} size={14} />
                </button>
              ) : null}
            </span>
          );
        })()}
      </div>

      {hasChildren && expanded ? <RailTree items={item.children ?? []} depth={depth + 1} /> : null}
    </li>
  );
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const next = value.trim();
    if (!next || next === initial) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <input
      ref={ref}
      data-testid="rail-tree-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className="flex-1 min-w-0 rounded bg-shell px-1 py-0.5 text-sm text-fg input-focus"
    />
  );
}

function RowMenu({ items }: { items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More actions"
          data-testid="rail-tree-menu"
          onClick={(e) => e.stopPropagation()}
          className="grid h-4 w-4 place-items-center rounded text-fg-2 hover:bg-card hover:text-fg"
        >
          <Icon icon={MoreHorizontal} size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-[140px] py-1">
        <div role="menu" className="flex flex-col">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); it.onSelect(); }}
              className={cn(
                'px-3 py-1.5 text-left text-sm transition-colors duration-fast hover:bg-card',
                it.destructive ? 'text-danger' : 'text-fg-2',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
