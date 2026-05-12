import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { cn } from '../ui/cn.ts';

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
}

interface RailProps {
  brand: { mark: string; label: string };
  workspace: { mark: string; name: string; onSwitch?: () => void };
  primary: NavItem[];
  tools?: NavItem[];
  account?: NavItem[];
  user: { name: string };
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
  const [collapsed] = useRailCollapsed();
  return collapsed
    ? <RailCollapsed brand={brand} workspace={workspace} primary={primary} tools={tools} account={account} user={user} />
    : <RailExpanded brand={brand} workspace={workspace} primary={primary} tools={tools} account={account} user={user} />;
}

function RailExpanded({ brand, workspace, primary, tools, account, user }: RailProps) {
  return (
    <aside className="flex w-[200px] flex-col rounded-xl bg-content shadow-surface px-3 py-3.5">
      <div className="flex items-center gap-2.5 px-2 mb-2">
        <BrandMark>{brand.mark}</BrandMark>
        <span className="text-sm font-medium tracking-tight">{brand.label}</span>
      </div>

      <button
        type="button"
        onClick={workspace.onSwitch}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 mb-2 hover:bg-card transition-colors duration-fast"
      >
        <span className="inline-grid h-[22px] w-[22px] place-items-center rounded bg-primary text-primary-fg text-[11px] font-semibold">
          {workspace.mark}
        </span>
        <span className="text-sm font-medium flex-1 text-left truncate">{workspace.name}</span>
        <span className="text-fg-3 text-[11px]">▾</span>
      </button>

      <Divider />
      <NavList items={primary} expanded />

      {tools && tools.length > 0 ? (
        <>
          <Divider />
          <NavList items={tools} expanded />
        </>
      ) : null}

      <div className="flex-1" />

      {account && account.length > 0 ? <NavList items={account} expanded /> : null}

      <div className="flex items-center gap-2 px-2 pt-1.5">
        <span className="inline-grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-fg text-[11px] font-medium">
          {initials(user.name)}
        </span>
        <span className="text-xs font-medium truncate">{user.name}</span>
      </div>
    </aside>
  );
}

function RailCollapsed({ brand, workspace, primary, tools, account, user }: RailProps) {
  return (
    <aside className="flex w-16 flex-col items-center rounded-xl bg-content shadow-surface py-3.5">
      <BrandMark>{brand.mark}</BrandMark>
      <button
        type="button"
        onClick={workspace.onSwitch}
        title={workspace.name}
        className="mt-3.5 mb-2 inline-grid h-[30px] w-[30px] place-items-center rounded bg-primary text-primary-fg text-xs font-semibold"
      >
        {workspace.mark}
      </button>
      <Divider tiny />
      <NavList items={primary} expanded={false} />
      {tools && tools.length > 0 ? (
        <>
          <Divider tiny />
          <NavList items={tools} expanded={false} />
        </>
      ) : null}
      <div className="flex-1" />
      {account && account.length > 0 ? <NavList items={account} expanded={false} /> : null}
      <span
        title={user.name}
        className="mt-1.5 inline-grid h-[30px] w-[30px] place-items-center rounded-full bg-primary text-primary-fg text-[11px] font-medium"
      >
        {initials(user.name)}
      </span>
    </aside>
  );
}

function NavList({ items, expanded }: { items: NavItem[]; expanded: boolean }) {
  if (!expanded) {
    return (
      <div className="flex w-full flex-col items-center gap-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            title={item.label}
            aria-label={item.label}
            className={cn(
              'relative inline-grid h-9 w-9 place-items-center rounded-md transition-colors duration-fast',
              item.active
                ? 'bg-[rgb(0_0_0_/_0.06)] dark:bg-[rgb(255_255_255_/_0.10)] text-fg'
                : 'text-fg-3 hover:bg-card hover:text-fg-2',
            )}
          >
            {item.lucideIcon ? <Icon icon={item.lucideIcon} size={16} /> : <span className="inline-grid h-[18px] w-[18px] place-items-center">{item.icon}</span>}
            {item.active ? <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-fg" /> : null}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={item.onClick}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors duration-fast',
            item.active
              ? 'bg-[rgb(0_0_0_/_0.06)] dark:bg-[rgb(255_255_255_/_0.10)] text-fg'
              : 'text-fg-3 hover:bg-card hover:text-fg-2',
          )}
        >
          {item.lucideIcon ? <Icon icon={item.lucideIcon} size={16} /> : <span className="inline-grid h-[18px] w-[18px] place-items-center">{item.icon}</span>}
          <span className="flex-1 text-left truncate">{item.label}</span>
          {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
        </button>
      ))}
    </div>
  );
}

function BrandMark({ children }: { children: ReactNode }) {
  return (
    <span className="inline-grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-fg text-sm font-semibold tracking-tight">
      {children}
    </span>
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
