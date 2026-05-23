import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMemo } from 'react';
import { FolderOpen, Search } from 'lucide-react';
import { useMe } from '../lib/api/auth.ts';
import { useProjects } from '../lib/api/projects.ts';
import { useWorkspace, useWorkspaces } from '../lib/api/workspaces.ts';
import { Shell } from '../components/shell/shell.tsx';
import { Rail, type NavItem } from '../components/shell/rail.tsx';
import { WorkspaceSwitcher } from '../components/shell/workspace-switcher.tsx';
import { openCommandPalette } from '../lib/command-palette-bus.ts';

export const Route = createFileRoute('/w/$wslug')({
  component: WorkspaceLayout,
});

const TOOLS: NavItem[] = [{
  id: 'search',
  label: 'Search',
  lucideIcon: Search,
  kbd: '⌘K',
  onClick: openCommandPalette,
}];

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
      lucideIcon: FolderOpen,
      active: currentPath.startsWith(`/w/${wslug}/p/${p.slug}`),
      onClick: () =>
        navigate({
          to: '/w/$wslug/p/$pslug/work-items',
          params: { wslug, pslug: p.slug },
        }),
    }));
  }, [projects, currentPath, wslug, navigate]);

  const switcherEntries = useMemo(
    () =>
      (workspaces ?? []).map(({ workspace: w }) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        mark: w.name.charAt(0).toUpperCase() || 'W',
        active: w.slug === wslug,
      })),
    [workspaces, wslug],
  );

  if (isLoading) return <div className="p-8 text-fg-3">Loading workspace…</div>;
  if (!workspace) return <div className="p-8 text-danger">Workspace not found.</div>;

  const brandMark = 'F';
  const workspaceMark = workspace.name.charAt(0).toUpperCase() || 'W';
  const userName = me?.user.name ?? 'You';

  const onSelectWorkspace = (workspaceId: string) => {
    const target = switcherEntries.find((w) => w.id === workspaceId);
    if (!target || target.slug === wslug) return;
    void navigate({ to: '/w/$wslug', params: { wslug: target.slug } });
  };

  const onCreateWorkspace = () => {
    void navigate({ to: '/' });
  };

  return (
    <Shell
      rail={
        <Rail
          brand={{ mark: brandMark, label: 'Folio' }}
          workspace={{
            mark: workspaceMark,
            name: workspace.name,
            switcher: (trigger) => (
              <WorkspaceSwitcher
                trigger={trigger}
                workspaces={switcherEntries}
                onSelectWorkspace={onSelectWorkspace}
                onCreateWorkspace={onCreateWorkspace}
              />
            ),
          }}
          primary={primary}
          tools={TOOLS}
          user={{ name: userName }}
        />
      }
      main={<Outlet />}
    />
  );
}
