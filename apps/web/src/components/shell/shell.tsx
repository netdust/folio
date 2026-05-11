import type { ReactNode } from 'react';

interface ShellProps {
  rail: ReactNode;
  main: ReactNode;
  panel?: ReactNode;
}

export function Shell({ rail, main, panel }: ShellProps) {
  return (
    <div className="flex h-screen gap-1.5 bg-shell p-1.5">
      {rail}
      <div className="flex-1 min-w-0">{main}</div>
      {panel}
    </div>
  );
}
