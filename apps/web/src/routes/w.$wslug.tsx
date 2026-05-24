import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { useLogout, useMe } from '../lib/api/auth.ts';
import { useProjects } from '../lib/api/projects.ts';
import { type Table, tablesKeys } from '../lib/api/tables.ts';
import { type View, viewsKeys } from '../lib/api/views.ts';
import { client } from '../lib/api/client.ts';
import { useWorkspace, useWorkspaces } from '../lib/api/workspaces.ts';
import { formatApiError } from '../lib/api/index.ts';
import { Shell } from '../components/shell/shell.tsx';
import { Rail, type NavItem } from '../components/shell/rail.tsx';
import { WorkspaceSwitcher } from '../components/shell/workspace-switcher.tsx';
import { UserMenu } from '../components/shell/user-menu.tsx';
import { WorkspaceCreate } from '../components/onboarding/workspace-create.tsx';
import { openCommandPalette } from '../lib/command-palette-bus.ts';
import { modKeyHint } from '../lib/platform.ts';
import { buildRailTree, type RailTreeHandlers } from '../lib/rail-tree.ts';

export const Route = createFileRoute('/w/$wslug')({
  component: WorkspaceLayout,
});

const TOOLS: NavItem[] = [{
  id: 'search',
  label: 'Search',
  lucideIcon: Search,
  kbd: modKeyHint('K'),
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
  const logout = useLogout();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const currentPath = routerState.location.pathname;

  // Per-project tables + views fetched in batch. `useQueries` is a single hook
  // call, so it's legal in render even though the inner array varies in length.
  const projectList = useMemo(() => projects ?? [], [projects]);

  const tableQueries = useQueries({
    queries: projectList.map((p) => ({
      queryKey: tablesKeys.list(wslug, p.slug),
      queryFn: () => client.get<Table[]>(`/api/v1/w/${wslug}/p/${p.slug}/tables`),
      staleTime: 5 * 60_000,
    })),
  });

  const viewQueries = useQueries({
    queries: projectList.map((p) => ({
      queryKey: viewsKeys.list(wslug, p.slug),
      queryFn: () => client.get<View[]>(`/api/v1/w/${wslug}/p/${p.slug}/views`),
      staleTime: 5 * 60_000,
    })),
  });

  const tablesByProject = useMemo(() => {
    const map: Record<string, Table[]> = {};
    projectList.forEach((p, i) => {
      map[p.slug] = tableQueries[i]?.data ?? [];
    });
    return map;
  }, [projectList, tableQueries]);

  // v1 SIMPLIFICATION: the GET /views endpoint returns ALL views for a project
  // (across tables), and the frontend `View` type does not yet expose `tableId`.
  // Since seed-project-defaults.ts creates exactly one default table per project
  // (`work-items`), we group every project's views under that single first table.
  // TODO: when projects support multiple tables, expose `tableId` on the View
  // serializer (apps/server/src/routes/views.ts) and key viewsByTable by it.
  const viewsByTable = useMemo(() => {
    const map: Record<string, View[]> = {};
    projectList.forEach((p, i) => {
      const tables = tablesByProject[p.slug] ?? [];
      const firstTable = tables[0];
      if (!firstTable) return;
      map[firstTable.id] = viewQueries[i]?.data ?? [];
    });
    return map;
  }, [projectList, tablesByProject, viewQueries]);

  const activePslug = currentPath.match(/\/p\/([^/]+)/)?.[1];

  const handlers = useMemo<RailTreeHandlers>(
    () => ({
      onProjectClick: (pslug: string) => {
        void navigate({
          to: '/w/$wslug/p/$pslug/work-items',
          params: { wslug, pslug },
        });
      },
      onViewClick: (pslug: string, _tslug: string, viewId: string) => {
        void navigate({
          to: '/w/$wslug/p/$pslug/work-items',
          params: { wslug, pslug },
          // TODO Task 7: declare `view?: string` on the work-items route's
          // validateSearch schema, then drop this cast. The route schema
          // currently rejects unknown keys, so we widen `search` locally.
          search: { view: viewId } as unknown as Record<string, never>,
        });
      },
      onNewView: (pslug: string, tslug: string) => {
        // TODO Task 6: open the New View sheet wired to (pslug, tslug).
        console.log('TODO: open New View sheet', pslug, tslug);
      },
    }),
    [navigate, wslug],
  );

  const primary: NavItem[] = useMemo(
    () =>
      buildRailTree({
        projects: projectList.map((p) => ({ slug: p.slug, name: p.name, icon: p.icon })),
        tablesByProject,
        viewsByTable,
        currentRoute: {
          wslug,
          pslug: activePslug,
          // TODO Task 7: read the active view id from `?view=` URL search.
          viewId: undefined,
        },
        handlers,
      }),
    [projectList, tablesByProject, viewsByTable, wslug, activePslug, handlers],
  );

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
    setCreatingWorkspace(true);
  };

  const onSignOut = async () => {
    try {
      await logout.mutateAsync();
      void navigate({ to: '/login' });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <>
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
            user={{
              name: userName,
              menu: (trigger) => (
                <UserMenu
                  trigger={trigger}
                  email={me?.user.email}
                  onSignOut={onSignOut}
                  onCreateWorkspace={onCreateWorkspace}
                />
              ),
            }}
          />
        }
        main={<Outlet />}
      />
      <WorkspaceCreate open={creatingWorkspace} onOpenChange={setCreatingWorkspace} />
    </>
  );
}
