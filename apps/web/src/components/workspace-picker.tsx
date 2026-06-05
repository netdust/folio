import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from './ui/button.tsx';
import { useWorkspaces } from '../lib/api/workspaces.ts';
import { getLastWorkspaceSlug } from '../lib/last-workspace.ts';

interface WorkspacePickerProps {
  onCreate: () => void;
}

// Picks the workspace to land on at "/": the last-opened one if it's still
// accessible, else the first in the list. The all-workspaces grid is gone — with
// workspaces as plain folders (not tenancy boundaries) an overview screen was
// just an extra click; the user always wants to be IN a workspace. Only a user
// with ZERO workspaces sees a screen here (the create-first prompt).
export function WorkspacePicker({ onCreate }: WorkspacePickerProps) {
  const { data: memberships, isPending, isError } = useWorkspaces();
  const navigate = useNavigate();

  useEffect(() => {
    if (!memberships || memberships.length === 0) return;
    const slugs = memberships.map((m) => m.workspace.slug);
    const last = getLastWorkspaceSlug();
    const target = last && slugs.includes(last) ? last : slugs[0]!;
    void navigate({ to: '/w/$wslug', params: { wslug: target }, replace: true });
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

  // Redirecting via useEffect — show nothing while navigating.
  return null;
}
