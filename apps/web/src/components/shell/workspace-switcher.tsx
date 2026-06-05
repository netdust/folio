import type { ReactNode } from 'react';
import { Bot, Play } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Icon } from '../ui/icon.tsx';
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
  onCreateProject?: () => void;
  // Phase 2.5: agents + triggers are workspace-scoped, surfaced here instead of
  // under each project in the rail. Triggers are reached as a tab on the agents
  // page (no standalone switcher entry — it was a duplicate route surface).
  onOpenAgents?: () => void;
  onWorkWithAgent?: () => void;
}

export function WorkspaceSwitcher({
  trigger,
  workspaces,
  onSelectWorkspace,
  onCreateWorkspace,
  onCreateProject,
  onOpenAgents,
  onWorkWithAgent,
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
        {(onOpenAgents || onWorkWithAgent) && (
          <div className="border-t border-border-light p-1">
            {onOpenAgents ? (
              <button
                type="button"
                onClick={onOpenAgents}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
              >
                <Icon icon={Bot} size={14} />
                Agents & Triggers
              </button>
            ) : null}
            {onWorkWithAgent ? (
              <button
                type="button"
                onClick={onWorkWithAgent}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
              >
                <Icon icon={Play} size={14} />
                Work with an agent
              </button>
            ) : null}
          </div>
        )}
        <div className="border-t border-border-light p-1">
          {onCreateProject ? (
            <button
              type="button"
              onClick={onCreateProject}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
            >
              + New project
            </button>
          ) : null}
          {onCreateWorkspace ? (
            <button
              type="button"
              onClick={onCreateWorkspace}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
            >
              + Create workspace
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
