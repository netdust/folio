import type { ReactNode } from 'react';
import { Button } from '../ui/button.tsx';

interface Props {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: Props) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-6 text-center">
      {icon ? <div className="mb-3 text-fg-3">{icon}</div> : null}
      <h3 className="text-base font-medium text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-fg-3">{description}</p> : null}
      {action ? (
        <Button className="mt-4" onClick={action.onClick}>{action.label}</Button>
      ) : null}
    </div>
  );
}
