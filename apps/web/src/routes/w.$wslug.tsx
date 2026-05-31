import { createFileRoute, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Bot, Search } from 'lucide-react';
import { z } from 'zod';
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
import { ProviderHealthBanner } from '../components/shell/provider-health-banner.tsx';
import { ReactorHaltBanner } from '../components/shell/reactor-halt-banner.tsx';
import { modKeyHint } from '../lib/platform.ts';
import { buildRailTree, type RailTreeHandlers } from '../lib/rail-tree.ts';
import { agentPanelBus } from '../lib/agent-panel-bus.ts';
import { AgentCockpitPanel } from '../components/agent-panel/agent-cockpit-panel.tsx';
import { WorkspaceDocumentSlideover } from '../components/slideover/workspace-document-slideover.tsx';

export const Route = createFileRoute('/w/$wslug')({
  // The agent cockpit panel + config slideover live at the layout, so `?wdoc=`
  // and `?tab=` must validate workspace-wide (the no-project landing route
  // doesn't declare them otherwise). `wdoc` (workspace-doc) is DISTINCT from
  // the project DocumentSlideover's `?doc=` so the two slideovers — both
  // mounted under this layout — never open as stacked dual modals on one param.
  // The work-item `?doc=` param is validated by the CHILD project routes
  // (work-items / board / wiki each declare it), not here.
  validateSearch: z.object({
    wdoc: z.string().optional(),
    // Broad `string` (not a narrow enum) so the merged parent type doesn't
    // collide with sibling routes that declare their own narrower `tab` enums
    // (settings: tokens|ai, agents: fields|activity|runs). A parent enum would
    // force `tab` to that enum everywhere and reject e.g. settings' `tab:'ai'`
    // at navigate sites. The slideover narrows `tab` on read.
    tab: z.string().optional(),
  }),
  component: WorkspaceLayout,
});

// Exported for tests. Production callers go through the file route.
export { WorkspaceLayout };

const TOOLS: NavItem[] = [
  {
    id: 'search',
    label: 'Search',
    lucideIcon: Search,
    kbd: modKeyHint('K'),
    onClick: openCommandPalette,
  },
  {
    id: 'agents',
    label: 'Agents',
    lucideIcon: Bot,
    onClick: () => agentPanelBus.toggle(),
  },
];

function WorkspaceLayout() {
  // Use generic useParams so the component is mountable in tests without the
  // file-route plumbing. `strict: false` lets it match wherever the route
  // exposes :wslug.
  const { wslug } = useParams({ strict: false }) as { wslug: string };
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
  // Rail rename for tables/views uses raw client.patch + invalidateQueries
  // because the canonical `useUpdateTable(wslug, pslug)` / `useUpdateView`
  // hooks bind pslug at render time, and the rail rename callback receives
  // any pslug at call time. Restructuring those hooks to take pslug per-mutate
  // would unify the patterns but breaks an existing TableView consumer; defer
  // until that consumer is restructured (Phase 2+).

  const currentPath = routerState.location.pathname;
  const currentSearch = routerState.location.search as Record<string, unknown>;
  const activeViewId = typeof currentSearch.view === 'string' ? currentSearch.view : undefined;
  // `currentSearch` changes on every navigation. The rail handlers only need
  // its current value at click time (to preserve `doc=` when switching views),
  // so route it through a ref to keep the `handlers` memo stable across
  // navigations — otherwise the whole rail tree rebuilds on every ?doc=.
  const searchRef = useRef(currentSearch);
  useEffect(() => {
    searchRef.current = currentSearch;
  }, [currentSearch]);

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
      // Clicking a table in the rail (most visible in the collapsed-rail
      // popover, where there are no children to expand into) lands on its
      // work-items page on the default view. No ?view= → TableView's
      // activeView fallback picks the default. Today there's one table per
      // project, so this is functionally the same as onProjectClick, but
      // keeping a dedicated handler avoids a "click does nothing" footgun and
      // gives us a place to route by tslug once multiple tables per project
      // ship.
      onTableClick: (pslug: string, _tslug: string) => {
        void navigate({
          to: '/w/$wslug/p/$pslug/work-items',
          params: { wslug, pslug },
        });
      },
      onViewClick: (pslug: string, _tslug: string, viewId: string, type: 'list' | 'kanban') => {
        const to = type === 'kanban' ? '/w/$wslug/p/$pslug/board' : '/w/$wslug/p/$pslug/work-items';
        // Preserve ?doc= (open slideover) but drop the previous view's filter
        // and sort params — TableView's hydration treats URL params as winners
        // over view.filters, so carrying ?status= across a view switch would
        // silently mask the new view's stored filters.
        const prev = searchRef.current;
        const next: Record<string, unknown> = { view: viewId };
        if (typeof prev.doc === 'string') next.doc = prev.doc;
        void navigate({
          to,
          params: { wslug, pslug },
          search: next,
        });
      },
      onWikiClick: (pslug: string) => {
        void navigate({ to: '/w/$wslug/p/$pslug/wiki', params: { wslug, pslug } });
      },
      // Phase 2.5: agents + triggers moved to workspace popover; no project-level handlers here.
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
          isWiki: currentPath.endsWith('/wiki'),
        },
        handlers,
      }),
    [projectList, tablesByProject, viewsByTable, wslug, activePslug, activeViewId, currentPath, handlers],
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
        // Views and documents cascade-delete in the DB; the FE caches won't
        // notice without explicit invalidation, leaving ghost rows in the rail
        // and stale doc list responses.
        await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, confirmDelete.pslug) });
        await qc.invalidateQueries({ queryKey: ['documents', wslug, confirmDelete.pslug, 'list'] });
        toast.success(`Deleted table "${confirmDelete.name}"`);
      } else if (confirmDelete.kind === 'view') {
        await client.delete(`/api/v1/w/${wslug}/p/${confirmDelete.pslug}/views/${confirmDelete.viewId}`);
        await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, confirmDelete.pslug) });
        toast.success(`Deleted view "${confirmDelete.name}"`);
        // If the user was viewing the now-deleted view, drop the dead
        // ?view=<id> param so the table falls back cleanly to its default.
        if (activeViewId === confirmDelete.viewId) {
          const { view: _view, ...rest } = currentSearch;
          void navigate({ to: '.', search: rest, replace: true });
        }
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
                  onOpenAgents={() => agentPanelBus.toggle()}
                  onOpenTriggers={() =>
                    void navigate({ to: '/w/$wslug/triggers', params: { wslug } })
                  }
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
                  onOpenSettings={() =>
                    void navigate({ to: '/w/$wslug/settings', params: { wslug } })
                  }
                />
              ),
            }}
          />
        }
        main={
          // flex column so a visible banner reserves its own height (shrink-0)
          // and the Outlet page fills the rest (flex-1 min-h-0) instead of an
          // h-full page overflowing the viewport beneath the banner. Banners
          // are null in the healthy case → this collapses to just the Outlet.
          <div className="flex h-full min-h-0 flex-col">
            <ReactorHaltBanner wslug={wslug} />
            <ProviderHealthBanner wslug={wslug} />
            <div className="min-h-0 flex-1">
              <Outlet />
            </div>
          </div>
        }
        panel={<AgentCockpitPanel wslug={wslug} />}
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
          currentSearch={currentSearch}
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
      <WorkspaceDocumentSlideover wslug={wslug} />
    </>
  );
}
