import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useMe } from '../lib/api/auth.ts';
import { useProjects } from '../lib/api/projects.ts';
import { useWorkspace, useWorkspaces } from '../lib/api/workspaces.ts';
import { Shell } from '../components/shell/shell.tsx';
import { Rail, type NavItem } from '../components/shell/rail.tsx';

export const Route = createFileRoute('/w/$wslug')({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { wslug } = Route.useParams();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { data: me } = useMe();
  const { data: workspace, isLoading } = useWorkspace(wslug);
  const { data: workspaces } = useWorkspaces();
  const { data: projects } = useProjects(wslug);

  const currentPath = routerState.location.pathname;

  const primary: NavItem[] = useMemo(() => {
    if (!projects) return [];
    return projects.map((p) => ({
      id: p.id,
      label: p.name,
      icon: <span className="font-mono text-[11px]">{p.icon ?? '·'}</span>,
      active: currentPath.startsWith(`/w/${wslug}/p/${p.slug}`),
      onClick: () =>
        navigate({
          to: '/w/$wslug/p/$pslug/work-items',
          params: { wslug, pslug: p.slug },
        }),
    }));
  }, [projects, currentPath, wslug, navigate]);

  if (isLoading) return <div className="p-8 text-fg-3">Loading workspace…</div>;
  if (!workspace) return <div className="p-8 text-danger">Workspace not found.</div>;

  const brandMark = 'F';
  const workspaceMark = workspace.name.charAt(0).toUpperCase() || 'W';
  const userName = me?.user.name ?? 'You';

  const onSwitchWorkspace = () => {
    if (!workspaces || workspaces.length <= 1) return;
    void navigate({ to: '/' });
  };

  return (
    <Shell
      rail={
        <Rail
          brand={{ mark: brandMark, label: 'Folio' }}
          workspace={{ mark: workspaceMark, name: workspace.name, onSwitch: onSwitchWorkspace }}
          primary={primary}
          user={{ name: userName }}
        />
      }
      main={<Outlet />}
    />
  );
}
