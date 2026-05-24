import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

interface UserMenuProps {
  trigger: ReactNode;
  email?: string;
  onSignOut: () => void;
  onCreateWorkspace?: () => void;
}

export function UserMenu({ trigger, email, onSignOut, onCreateWorkspace }: UserMenuProps) {
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
