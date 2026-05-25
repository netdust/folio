import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

interface MainFrameProps {
  title: ReactNode;
  subMeta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function MainFrame({
  title,
  subMeta,
  actions,
  tabs,
  toolbar,
  children,
  className,
}: MainFrameProps) {
  return (
    <section
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-xl bg-content shadow-surface',
        className,
      )}
    >
      <div className="flex items-center px-[22px] pt-4">
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium tracking-tight">{title}</div>
          {subMeta ? (
            <div className="mt-0.5 font-mono text-[11px] text-fg-3 truncate">{subMeta}</div>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {tabs ? <div className="flex gap-1 px-[22px] pt-3">{tabs}</div> : null}
      {toolbar ? (
        <div className="flex items-center gap-1.5 border-b border-border-light px-[22px] py-2.5">
          {toolbar}
        </div>
      ) : null}
      <div className="folio-scroll flex-1 min-h-0 overflow-auto px-[22px] py-2">{children}</div>
    </section>
  );
}

interface TabProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

export function FrameTab({ active = false, onClick, children }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-sm px-2.5 py-1 text-[11px] transition-colors duration-fast',
        active ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:bg-card',
      )}
    >
      {children}
    </button>
  );
}
