import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../ui/cn.ts';
import {
  filterSlash,
  slashRegistry,
  type SlashContext,
  type SlashItem,
} from '../../lib/slash-registry.ts';

interface Props {
  ctx: SlashContext;
  query: string;
  rect: { top: number; left: number };
  onClose: () => void;
}

export function SlashMenu({ ctx, query, rect, onClose }: Props) {
  const items = useMemo(() => filterSlash(slashRegistry, query), [query]);
  const [active, setActive] = useState(0);

  useEffect(() => setActive(0), [query]);

  const selectItem = (item: SlashItem) => {
    const enabled = item.isEnabled ? item.isEnabled(ctx) : true;
    if (enabled) {
      item.onSelect(ctx, query);
    } else {
      ctx.notify(item.disabledHint?.(ctx) ?? `${item.label} is unavailable`, 'info');
    }
    onClose();
  };

  // Stable refs so the keydown handler is attached once (not re-added on every render)
  const activeRef = useRef(active);
  activeRef.current = active;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectRef = useRef(selectItem);
  selectRef.current = selectItem;
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
        if (it) selectRef.current(it);
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
      aria-label="Slash commands"
      className="fixed z-[60] max-w-[320px] rounded-md bg-content shadow-popover"
      style={{ top: rect.top, left: rect.left }}
    >
      <ul className="flex max-h-72 flex-col overflow-auto p-1">
        {items.map((it, i) => {
          const enabled = it.isEnabled ? it.isEnabled(ctx) : true;
          return (
            <li key={it.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                aria-disabled={!enabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => selectItem(it)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  i === active ? 'bg-card' : 'hover:bg-card',
                  !enabled && 'opacity-60',
                )}
              >
                <span className="font-mono text-[11px] text-fg-3 pt-0.5 w-12 shrink-0">
                  /{it.id}
                </span>
                <span className="flex-1">
                  <span className="block font-medium text-fg">{it.label}</span>
                  {it.hint ? <span className="block text-xs text-fg-3">{it.hint}</span> : null}
                  {!enabled && it.disabledHint ? (
                    <span className="mt-0.5 block text-[11px] text-fg-3 italic">
                      {it.disabledHint(ctx)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
