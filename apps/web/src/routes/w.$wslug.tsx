import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { useLogout, useMe } from '../lib/api/auth.ts';
import { useProjects, useUpdateProject, useDeleteProject, projectsKeys } from '../lib/api/projects.ts';
import { type Table, tablesKeys } from '../lib/api/tables.ts';
import { type View, viewsKeys } from '../lib/api/views.ts';
import { client } from '../lib/api/client.ts';
import { useWorkspace, useWorkspaces } from '../lib/api/workspaces.ts';
import { formatApiError } from '../lib/api/index.ts';
import { Shell } from '../components/shell/shell.tsx';
import { Rail, type NavItem } from '../components/shell/rail.tsx';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog.tsx';
import { Button } from '../components/ui/button.tsx';
import { WorkspaceSwitcher } from '../components/shell/workspace-switcher.tsx';
import { UserMenu } from '../components/shell/user-menu.tsx';
import { WorkspaceCreate } from '../components/onboarding/workspace-create.tsx';
import { ProjectCreate } from '../components/onboarding/project-create.tsx';
import { TableCreate } from '../components/onboarding/table-create.tsx';
import { NewViewSheet } from '../components/views/new-view-sheet.tsx';
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
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingTable, setCreatingTable] = useState<{ pslug: string } | null>(null);
  const [newViewSheet, setNewViewSheet] = useState<{ pslug: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'project'; pslug: string; name: string }
    | { kind: 'table'; pslug: string; tslug: string; name: string }
    | { kind: 'view'; pslug: string; tslug: string; viewId: string; name: string }
    | null
  >(null);

  const qc = useQueryClient();
  const updateProject = useUpdateProject(wslug);
  const deleteProject = useDeleteProject(wslug);

  const currentPath = routerState.location.pathname;
  const currentSearch = routerState.location.search as Record<string, unknown>;
  const activeViewId = typeof currentSearch.view === 'string' ? currentSearch.view : undefined;

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
          search: { view: viewId },
        });
      },
      onWikiClick: (pslug: string) => {
        void navigate({ to: '/w/$wslug/p/$pslug/wiki', params: { wslug, pslug } });
      },
      onNewView: (pslug: string, _tslug: string) => {
        setNewViewSheet({ pslug });
      },
      onNewProject: () => setCreatingProject(true),
      onNewTable: (pslug: string) => setCreatingTable({ pslug }),
      onRenameProject: async (pslug, next) => {
        try {
          await updateProject.mutateAsync({ pslug, patch: { name: next } });
        } catch (err) { toast.error(formatApiError(err)); }
      },
      onDeleteProject: (pslug, name) => setConfirmDelete({ kind: 'project', pslug, name }),
      onRenameTable: async (pslug, tslug, next) => {
        try {
          await client.patch(`/api/v1/w/${wslug}/p/${pslug}/tables/${tslug}`, { name: next });
          await qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, pslug) });
        } catch (err) { toast.error(formatApiError(err)); }
      },
      onDeleteTable: (pslug, tslug, name) => setConfirmDelete({ kind: 'table', pslug, tslug, name }),
      onRenameView: async (pslug, _tslug, viewId, next) => {
        try {
          await client.patch(`/api/v1/w/${wslug}/p/${pslug}/views/${viewId}`, { name: next });
          await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
        } catch (err) { toast.error(formatApiError(err)); }
      },
      onDeleteView: (pslug, tslug, viewId, name) => setConfirmDelete({ kind: 'view', pslug, tslug, viewId, name }),
    }),
    [navigate, wslug, qc, updateProject],
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
          viewId: activeViewId,
        },
        handlers,
      }),
    [projectList, tablesByProject, viewsByTable, wslug, activePslug, activeViewId, handlers],
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

  const executeDelete = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.kind === 'project') {
        await deleteProject.mutateAsync(confirmDelete.pslug);
        toast.success(`Deleted project "${confirmDelete.name}"`);
        if (activePslug === confirmDelete.pslug) {
          void navigate({ to: '/w/$wslug', params: { wslug } });
        }
      } else if (confirmDelete.kind === 'table') {
        await client.delete(`/api/v1/w/${wslug}/p/${confirmDelete.pslug}/tables/${confirmDelete.tslug}`);
        await qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, confirmDelete.pslug) });
        toast.success(`Deleted table "${confirmDelete.name}"`);
      } else if (confirmDelete.kind === 'view') {
        await client.delete(`/api/v1/w/${wslug}/p/${confirmDelete.pslug}/views/${confirmDelete.viewId}`);
        await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, confirmDelete.pslug) });
        toast.success(`Deleted view "${confirmDelete.name}"`);
      }
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setConfirmDelete(null);
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
                  onCreateProject={() => setCreatingProject(true)}
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
      <ProjectCreate wslug={wslug} open={creatingProject} onOpenChange={setCreatingProject} />
      {creatingTable && (
        <TableCreate
          wslug={wslug}
          pslug={creatingTable.pslug}
          open={creatingTable !== null}
          onOpenChange={(open) => { if (!open) setCreatingTable(null); }}
        />
      )}
      {newViewSheet && (
        <NewViewSheet
          open={newViewSheet !== null}
          onOpenChange={(open) => {
            if (!open) setNewViewSheet(null);
          }}
          wslug={wslug}
          pslug={newViewSheet.pslug}
        />
      )}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogTitle>Delete {confirmDelete.kind} "{confirmDelete.name}"?</DialogTitle>
              <DialogDescription>
                {confirmDelete.kind === 'project'
                  ? 'All tables, views, and documents in this project will be permanently removed.'
                  : confirmDelete.kind === 'table'
                  ? 'All views and documents in this table will be permanently removed.'
                  : 'This view will be removed. Documents are not affected.'}
              </DialogDescription>
              <div className="mt-6 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
                <Button type="button" onClick={executeDelete}>
                  Delete
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
