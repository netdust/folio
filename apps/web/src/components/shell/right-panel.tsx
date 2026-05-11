import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

export type PanelTab = 'context' | 'events' | 'ai';

interface RightPanelProps {
  open: boolean;
  activeTab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  showAiTab: boolean;
  children: ReactNode;
}

export function RightPanel({
  open,
  activeTab,
  onTabChange,
  showAiTab,
  children,
}: RightPanelProps) {
  if (!open) return null;
  return (
    <aside className="flex w-[320px] flex-col overflow-hidden rounded-xl bg-content shadow-surface">
      <div className="flex gap-1 border-b border-border-light px-4 pt-3">
        <PanelTabButton active={activeTab === 'context'} onClick={() => onTabChange('context')}>
          Context
        </PanelTabButton>
        <PanelTabButton active={activeTab === 'events'} onClick={() => onTabChange('events')}>
          Events
        </PanelTabButton>
        {showAiTab ? (
          <PanelTabButton active={activeTab === 'ai'} onClick={() => onTabChange('ai')}>
            AI
          </PanelTabButton>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto px-4 py-3.5">{children}</div>
    </aside>
  );
}

function PanelTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mb-px border-b-2 px-2.5 py-1.5 text-[11px] transition-colors duration-fast',
        active
          ? 'border-primary text-fg font-medium'
          : 'border-transparent text-fg-3 hover:text-fg-2',
      )}
    >
      {children}
    </button>
  );
}
