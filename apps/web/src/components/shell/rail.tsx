import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronsUpDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { cn } from '../ui/cn.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { RailTree } from './rail-tree.tsx';

const STORAGE_KEY = 'folio:rail-collapsed';

export interface NavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  lucideIcon?: LucideIcon;
  href?: string;
  kbd?: string;
  active?: boolean;
  onClick?: () => void;
  /** When set, the item is expandable and renders its children indented below. */
  children?: NavItem[];
  /** Hover-reveal "+" button next to row. */
  onPlus?: () => void;
  plusLabel?: string;
  /** Hover-reveal "⋯" menu next to row. */
  menuItems?: RowMenuItem[];
  /** Double-click the label to inline-edit. Called with the trimmed new name. */
  onRename?: (next: string) => void;
}

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export interface WorkspaceConfig {
  mark: string;
  name: string;
  onSwitch?: () => void;
  switcher?: (trigger: ReactNode) => ReactNode;
}

export interface UserConfig {
  name: string;
  menu?: (trigger: ReactNode) => ReactNode;
}

interface RailProps {
  brand: { mark: string; label: string };
  workspace: WorkspaceConfig;
  primary: NavItem[];
  tools?: NavItem[];
  account?: NavItem[];
  user: UserConfig;
}

export function useRailCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === '1';
  });
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  return [collapsed, setCollapsed];
}

export function Rail({ brand, workspace, primary, tools, account, user }: RailProps) {
  const [collapsed, setCollapsed] = useRailCollapsed();
  return collapsed
    ? <RailCollapsed brand={brand} workspace={workspace} primary={primary} tools={tools} account={account} user={user} onToggle={() => setCollapsed(false)} />
    : <RailExpanded brand={brand} workspace={workspace} primary={primary} tools={tools} account={account} user={user} onToggle={() => setCollapsed(true)} />;
}

function WorkspaceButton({ workspace }: { workspace: WorkspaceConfig }) {
  const trigger = (
    <button
      type="button"
      onClick={workspace.switcher ? undefined : workspace.onSwitch}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-card transition-colors duration-fast"
    >
      <span className="inline-grid h-[22px] w-[22px] place-items-center rounded bg-primary text-primary-fg text-[11px] font-semibold">
        {workspace.mark}
      </span>
      <span className="text-sm font-medium flex-1 text-left truncate">{workspace.name}</span>
      <Icon icon={ChevronsUpDown} size={14} className="text-fg-3" />
    </button>
  );
  return workspace.switcher ? <>{workspace.switcher(trigger)}</> : trigger;
}

function RailExpanded({ brand, workspace, primary, tools, account, user, onToggle }: RailProps & { onToggle: () => void }) {
  return (
    <aside className="flex w-[200px] flex-col rounded-xl bg-content shadow-surface px-3 py-3.5">
      <div className="px-2 mb-3 text-[11px] font-medium tracking-wide text-fg-3 uppercase">
        {brand.label}
      </div>

      <WorkspaceButton workspace={workspace} />

      <Divider />
      <NavList items={primary} expanded />

      <div className="flex-1" />

      {tools && tools.length > 0 ? (
        <>
          <NavList items={tools} expanded />
          <Divider />
        </>
      ) : null}

      {account && account.length > 0 ? <NavList items={account} expanded /> : null}

      <div className="flex items-center gap-2 px-2 pt-1.5">
        <UserChip user={user} />
        <button
          type="button"
          aria-label="Collapse rail"
          onClick={onToggle}
          className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg-2"
        >
          <Icon icon={PanelLeftClose} size={14} />
        </button>
      </div>
    </aside>
  );
}

function RailCollapsed({ brand, workspace, primary, tools, account, user, onToggle }: RailProps & { onToggle: () => void }) {
  return (
    <aside className="flex w-16 flex-col items-center rounded-xl bg-content shadow-surface py-3.5">
      <span className="text-[9px] font-medium tracking-wide text-fg-3 uppercase" aria-hidden>
        {brand.mark}
      </span>
      <WorkspaceMark workspace={workspace} />
      <Divider tiny />
      <NavList items={primary} expanded={false} />
      <div className="flex-1" />
      {tools && tools.length > 0 ? (
        <>
          <NavList items={tools} expanded={false} />
          <Divider tiny />
        </>
      ) : null}
      {account && account.length > 0 ? <NavList items={account} expanded={false} /> : null}
      <UserChip user={user} compact />

      <button
        type="button"
        aria-label="Expand rail"
        onClick={onToggle}
        title="Expand"
        className="mt-1.5 grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg-2"
      >
        <Icon icon={PanelLeftOpen} size={14} />
      </button>
    </aside>
  );
}

function UserChip({ user, compact = false }: { user: UserConfig; compact?: boolean }) {
  const trigger = compact ? (
    <button
      type="button"
      title={user.name}
      className="mt-1.5 inline-grid h-[30px] w-[30px] place-items-center rounded-full bg-primary text-primary-fg text-[11px] font-medium"
    >
      {initials(user.name)}
    </button>
  ) : (
    <button
      type="button"
      className="flex items-center gap-2 flex-1 min-w-0 rounded-md px-1 -mx-1 py-0.5 hover:bg-card transition-colors duration-fast"
    >
      <span className="inline-grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-fg text-[11px] font-medium">
        {initials(user.name)}
      </span>
      <span className="text-xs font-medium truncate text-left">{user.name}</span>
    </button>
  );
  return user.menu ? <>{user.menu(trigger)}</> : trigger;
}

function WorkspaceMark({ workspace }: { workspace: WorkspaceConfig }) {
  const trigger = (
    <button
      type="button"
      onClick={workspace.switcher ? undefined : workspace.onSwitch}
      title={workspace.name}
      className="mt-3 mb-2 inline-grid h-[30px] w-[30px] place-items-center rounded bg-primary text-primary-fg text-xs font-semibold"
    >
      {workspace.mark}
    </button>
  );
  return workspace.switcher ? <>{workspace.switcher(trigger)}</> : trigger;
}

function CollapsedNavButton({ item }: { item: NavItem }) {
  const className = cn(
    'relative inline-grid h-9 w-9 place-items-center rounded-md transition-colors duration-fast',
    item.active ? 'bg-nav-active text-fg' : 'text-fg-3 hover:bg-card hover:text-fg-2',
  );
  const visual = (
    <>
      {item.lucideIcon ? (
        <Icon icon={item.lucideIcon} size={16} />
      ) : (
        <span className="inline-grid h-[18px] w-[18px] place-items-center">{item.icon}</span>
      )}
      {item.active ? (
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-fg" />
      ) : null}
    </>
  );

  const hasChildren = !!item.children && item.children.length > 0;
  if (!hasChildren) {
    return (
      <button
        type="button"
        onClick={item.onClick}
        title={item.label}
        aria-label={item.label}
        className={className}
      >
        {visual}
      </button>
    );
  }

  // Collapsed rail can't show inline children — surface them via a popover so
  // the user can still jump to a table/view without expanding the rail.
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title={item.label} aria-label={item.label} className={className}>
          {visual}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={6} className="min-w-[180px] p-1">
        <div className="flex flex-col gap-0.5">
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors duration-fast',
                'text-fg hover:bg-card',
              )}
            >
              {item.lucideIcon ? <Icon icon={item.lucideIcon} size={14} /> : null}
              <span className="truncate">{item.label}</span>
            </button>
          ) : null}
          {item.children!.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={child.onClick}
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors duration-fast',
                child.active ? 'bg-nav-active text-fg' : 'text-fg-2 hover:bg-card hover:text-fg',
              )}
            >
              {child.lucideIcon ? <Icon icon={child.lucideIcon} size={14} /> : null}
              <span className="truncate">{child.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NavList({ items, expanded }: { items: NavItem[]; expanded: boolean }) {
  if (!expanded) {
    return (
      <div className="flex w-full flex-col items-center gap-0.5">
        {items.map((item) => (
          <CollapsedNavButton key={item.id} item={item} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        if (item.children && item.children.length > 0) {
          return <RailTree key={item.id} items={[item]} />;
        }
        return (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors duration-fast',
              item.active
                ? 'bg-nav-active text-fg'
                : 'text-fg-3 hover:bg-card hover:text-fg-2',
            )}
          >
            {item.lucideIcon ? <Icon icon={item.lucideIcon} size={16} /> : <span className="inline-grid h-[18px] w-[18px] place-items-center">{item.icon}</span>}
            <span className="flex-1 text-left truncate">{item.label}</span>
            {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
          </button>
        );
      })}
    </div>
  );
}

function Divider({ tiny = false }: { tiny?: boolean }) {
  return (
    <div className={cn('bg-border-light my-1.5', tiny ? 'h-px w-7 self-center' : 'h-px mx-1')} />
  );
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?';
}
