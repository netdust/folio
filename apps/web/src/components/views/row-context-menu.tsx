import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  hint?: string;
}

interface Props {
  items: MenuItem[];
  children: ReactNode;
}

/**
 * Wraps its children with a right-click context menu.
 * The menu closes on Escape or click-outside.
 */
export function RowContextMenu({ items, children }: Props) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    setPosition({ x: e.clientX, y: e.clientY });
  };

  const close = () => setPosition(null);

  // Close on Escape
  useEffect(() => {
    if (!position) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [position]);

  // Close on click-outside
  useEffect(() => {
    if (!position) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [position]);

  return (
    <div onContextMenu={open} style={{ display: 'contents' }}>
      {children}
      {position ? (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[160px] overflow-hidden rounded-md border border-border-light bg-surface py-1 shadow-lg"
          style={{ top: position.y, left: position.x }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-sm text-fg hover:bg-card focus:outline-none focus-visible:bg-card"
              onClick={() => {
                item.onSelect();
                close();
              }}
            >
              <span>{item.label}</span>
              {item.hint ? (
                <span className="font-mono text-[10px] text-fg-3">{item.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
