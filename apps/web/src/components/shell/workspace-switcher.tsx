import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { cn } from '../ui/cn.ts';

interface Workspace {
  id: string;
  slug: string;
  name: string;
  mark: string;
  active?: boolean;
}

interface WorkspaceSwitcherProps {
  trigger: ReactNode;
  workspaces: Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onOpenSettings?: () => void;
}

export function WorkspaceSwitcher({
  trigger,
  workspaces,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenSettings,
}: WorkspaceSwitcherProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[320px] max-h-[480px] flex flex-col" align="start">
        <div className="flex-1 overflow-auto py-1">
          {workspaces.map((ws) => (
            <button
              type="button"
              key={ws.id}
              onClick={() => onSelectWorkspace(ws.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                'hover:bg-card transition-colors duration-fast',
                ws.active && 'bg-card',
              )}
            >
              <span className="inline-grid h-[22px] w-[22px] place-items-center rounded bg-primary text-primary-fg text-[11px] font-semibold">
                {ws.mark}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{ws.name}</div>
                <div className="text-[10px] font-mono text-fg-3 truncate">{ws.slug}</div>
              </div>
              {ws.active ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
            </button>
          ))}
        </div>
        <div className="border-t border-border-light p-1">
          {onCreateWorkspace ? (
            <button
              type="button"
              onClick={onCreateWorkspace}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
            >
              + Create workspace
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              onClick={onOpenSettings}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
            >
              Workspace settings
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
