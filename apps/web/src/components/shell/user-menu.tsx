import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Icon } from '../ui/icon.tsx';

interface UserMenuProps {
  trigger: ReactNode;
  email?: string;
  onSignOut: () => void;
  onCreateWorkspace?: () => void;
  // Instance-level settings (shared AI keys, roles, invitations) — labeled
  // simply "Settings". Only provided to users who have an instance-level surface
  // to manage (instance admin), so the entry hides for everyone else. (There is
  // no longer a workspace-settings entry: per-workspace API tokens moved to the
  // Agents & Triggers → API tab.)
  onOpenInstanceSettings?: () => void;
}

export function UserMenu({
  trigger,
  email,
  onSignOut,
  onCreateWorkspace,
  onOpenInstanceSettings,
}: UserMenuProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[220px]" align="end" side="top">
        {email ? (
          <div className="px-2 py-1.5 text-[10px] font-mono text-fg-3 truncate" title={email}>
            {email}
          </div>
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
        {onOpenInstanceSettings ? (
          <button
            type="button"
            onClick={onOpenInstanceSettings}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
          >
            <Icon icon={Settings} size={14} />
            Settings
          </button>
        ) : null}
        <div className="my-1 h-px bg-border-light" />
        <button
          type="button"
          onClick={onSignOut}
          className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-card hover:text-fg"
        >
          Sign out
        </button>
      </PopoverContent>
    </Popover>
  );
}
