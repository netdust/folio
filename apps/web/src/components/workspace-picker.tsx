import { useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from './ui/button.tsx';
import { useWorkspaces, type WorkspaceMembership } from '../lib/api/workspaces.ts';

interface WorkspacePickerProps {
  onCreate: () => void;
}

export function WorkspacePicker({ onCreate }: WorkspacePickerProps) {
  const { data: memberships, isPending, isError } = useWorkspaces();
  const navigate = useNavigate();

  useEffect(() => {
    if (memberships && memberships.length === 1) {
      void navigate({
        to: '/w/$wslug',
        params: { wslug: memberships[0]!.workspace.slug },
        replace: true,
      });
    }
  }, [memberships, navigate]);

  if (isPending) {
    return <p className="text-fg-3">Loading…</p>;
  }

  if (isError) {
    return <p className="text-danger">Failed to load workspaces.</p>;
  }

  if (memberships.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <h1 className="text-2xl font-semibold text-fg">Welcome to Folio</h1>
        <p className="mt-2 text-fg-3">
          Create your first workspace to start managing work.
        </p>
        <Button className="mt-6" variant="primary" size="lg" onClick={onCreate}>
          Create workspace
        </Button>
      </div>
    );
  }

  if (memberships.length === 1) {
    // Redirecting via useEffect — show nothing while navigating.
    return null;
  }

  return (
    <div>
      <h1 className="text-2xl font-medium tracking-tight">Your workspaces</h1>
      <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {memberships.map((m: WorkspaceMembership) => (
          <li key={m.workspace.id}>
            <Link
              to="/w/$wslug"
              params={{ wslug: m.workspace.slug }}
              className="flex flex-col gap-1 rounded-lg border border-border-light bg-content p-5 shadow-surface transition-colors duration-fast hover:bg-card"
            >
              <div className="text-sm font-medium text-fg">{m.workspace.name}</div>
              <div className="text-xs text-fg-3">/{m.workspace.slug}</div>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <Button variant="secondary" size="md" onClick={onCreate}>
          New workspace
        </Button>
      </div>
    </div>
  );
}
