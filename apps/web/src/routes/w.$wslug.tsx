import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AgentCockpitPanel } from '../components/agent-panel/agent-cockpit-panel.tsx';
import { ProjectCreate } from '../components/onboarding/project-create.tsx';
import { TableCreate } from '../components/onboarding/table-create.tsx';
import { WorkspaceCreate } from '../components/onboarding/workspace-create.tsx';
import { ProviderHealthBanner } from '../components/shell/provider-health-banner.tsx';
import { type NavItem, Rail } from '../components/shell/rail.tsx';
import { ReactorHaltBanner } from '../components/shell/reactor-halt-banner.tsx';
import { Shell } from '../components/shell/shell.tsx';
import { useRailHandlers } from '../components/shell/use-rail-handlers.ts';
import { UserMenu } from '../components/shell/user-menu.tsx';
import { WorkspaceSwitcher } from '../components/shell/workspace-switcher.tsx';
import { WorkspaceDocumentSlideover } from '../components/slideover/workspace-document-slideover.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog.tsx';
import { NewViewSheet } from '../components/views/new-view-sheet.tsx';
import { agentPanelBus } from '../lib/agent-panel-bus.ts';
import { useIsInstanceAdmin, useLogout, useMe } from '../lib/api/auth.ts';
import { client } from '../lib/api/client.ts';
import { documentsKeys } from '../lib/api/documents.ts';
import { EventStreamProvider } from '../lib/api/event-stream-context.tsx';
import { formatApiError } from '../lib/api/index.ts';
import {
  projectsKeys,
  useDeleteProject,
  useProjects,
  useUpdateProject,
} from '../lib/api/projects.ts';
import { type Table, tablesKeys } from '../lib/api/tables.ts';
import { type View, fetchProjectViews, viewsKeys } from '../lib/api/views.ts';
import { useWorkspace, useWorkspaces } from '../lib/api/workspaces.ts';
import { openCommandPalette } from '../lib/command-palette-bus.ts';
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';
import { setLastWorkspaceSlug } from '../lib/last-workspace.ts';
import { modKeyHint } from '../lib/platform.ts';
import { activeTableFromPath } from '../lib/rail-nav.ts';
import { buildRailTree } from '../lib/rail-tree.ts';
import { resolveNewViewColumns } from '../lib/resolve-new-view-columns.ts';
import { reorderViewIds } from '../lib/view-reorder.ts';

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
  // The operator cockpit panel is open by default and toggled from the
  // workspace dropdown ("Agents") and Cmd-K ("Toggle operator") — no rail tool,
  // to avoid a redundant entry.
];

function WorkspaceLayout() {
  // Use generic useParams so the component is mountable in tests without the
  // file-route plumbing. `strict: false` lets it match wherever the route
  // exposes :wslug.
  const { wslug } = useParams({ strict: false }) as { wslug: string };
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { data: me } = useMe();
  // Show the "Instance settings" menu entry only to instance admins (the
  // surfaces /settings renders — AI keys, roles, invitations — are all
  // instance-admin gated). The __system "System Library" entry was removed in
  // Phase 4 (drop-workspace-tenancy).
  const isInstanceAdmin = useIsInstanceAdmin();
  const hasInstanceSettings = isInstanceAdmin;
  const { data: workspace, isLoading } = useWorkspace(wslug);
  const { data: workspaces } = useWorkspaces();
  const { data: projects } = useProjects(wslug);
  const logout = useLogout();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingTable, setCreatingTable] = useState<{ pslug: string } | null>(null);
  const [newViewSheet, setNewViewSheet] = useState<{ pslug: string; tslug: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'project'; pslug: string; name: string }
    | { kind: 'table'; pslug: string; tslug: string; name: string }
    | { kind: 'view'; pslug: string; tslug: string; viewId: string; name: string }
    | null
  >(null);

  // Remember the workspace the user is in, so the root landing route reopens it
  // next launch instead of the all-workspaces grid. Only persist once the
  // workspace actually resolved — never store a slug that 404s.
  useEffect(() => {
    if (workspace) setLastWorkspaceSlug(wslug);
  }, [workspace, wslug]);

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

  const tablesByProject = useMemo(() => {
    const map: Record<string, Table[]> = {};
    projectList.forEach((p, i) => {
      map[p.slug] = tableQueries[i]?.data ?? [];
    });
    return map;
  }, [projectList, tableQueries]);

  // PERF (M3 audit 3.5): views are batched ONE QUERY PER PROJECT, not per
  // (project, table) pair. The old fan-out fired O(projects × tables) requests on
  // the always-mounted sidebar; the batched GET /p/<pslug>/views?tables=slugA,slugB
  // endpoint returns every table's views for a project in one request, grouped by
  // tableId. The rail still consumes `viewsByTable` keyed BY TABLE ID — identical
  // shape — so nothing downstream changes. staleTime (5m) prevents refetch storms.
  //
  // Why batched, not expand-gating: the project-expand state lives in
  // rail-tree.tsx's per-node `useExpanded` (default-OPEN, written on mount only),
  // unreadable reactively at this parent fetch site without a state-lift refactor,
  // and gating risks re-introducing the V3 "view vanished when collapsed" bug. The
  // batched endpoint is purely additive and touches no expand logic.
  //
  // `useQueries` over PROJECTS is stable in length per render of `projectList`. A
  // project with 0 tables sends `?tables=` (empty) → the server returns {} with no
  // table fetch. Per-project DEGRADATION: each project is its own query, so one
  // project's failed batch leaves only that project's views empty — the rest of
  // the rail is unaffected.
  const projectTslugs = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const p of projectList) {
      map[p.slug] = (tablesByProject[p.slug] ?? []).map((t) => t.slug);
    }
    return map;
  }, [projectList, tablesByProject]);

  const viewQueries = useQueries({
    queries: projectList.map((p) => {
      const tslugs = projectTslugs[p.slug] ?? [];
      return {
        queryKey: viewsKeys.batch(wslug, p.slug, tslugs),
        queryFn: () => fetchProjectViews(wslug, p.slug, tslugs),
        staleTime: 5 * 60_000,
      };
    }),
  });

  const viewsByTable = useMemo(() => {
    const map: Record<string, View[]> = {};
    projectList.forEach((p, i) => {
      // Each project's batch is `{ [tableId]: View[] }`; merge into the flat
      // tableId-keyed lookup the rail expects. A pending/failed project query
      // (data === undefined) simply contributes nothing — that project's tables
      // resolve to [] via the `?? []` reads downstream.
      const grouped = viewQueries[i]?.data;
      if (grouped) Object.assign(map, grouped);
    });
    return map;
  }, [projectList, viewQueries]);

  // V2 (views UX shake-out): the columns the user is CURRENTLY looking at, so the
  // New-view sheet captures them. The active view (by `?view=`, else the table's
  // default) holds the live visibleFields/columnOrder (column tweaks auto-save to
  // it). Scoped to the project the sheet was opened for.
  const newViewCurrentColumns = useMemo(() => {
    if (!newViewSheet) return undefined;
    const tables = tablesByProject[newViewSheet.pslug] ?? [];
    // Seed from the table the sheet was OPENED on (newViewSheet.tslug), not
    // tables[0] (the default/work-items table) — otherwise a view created from
    // the `bugs` rail row inherits work-items' columns.
    const activeTable = tables.find((t) => t.slug === newViewSheet.tslug) ?? tables[0];
    const views = viewsByTable[activeTable?.id ?? ''] ?? [];
    const active =
      views.find((v) => v.id === activeViewId) ?? views.find((v) => v.isDefault) ?? views[0];
    // Prefer the on-screen snapshot for the OPENED table (the bug fix): the
    // default view's saved visibleFields is usually null, so the raw read seeded
    // nothing → server defaulted to the 3 builtins. The snapshot carries the
    // real on-screen column set + order. Falls back to the raw saved view when
    // the table wasn't rendered this session.
    return resolveNewViewColumns({
      tslug: newViewSheet.tslug,
      activeView: active
        ? { visibleFields: active.visibleFields, columnOrder: active.columnOrder }
        : null,
    });
  }, [newViewSheet, tablesByProject, viewsByTable, activeViewId]);

  const activePslug = currentPath.match(/\/p\/([^/]+)/)?.[1];
  // The table the rail should highlight: a /t/<tslug> path → that slug; the
  // legacy /work-items|/board paths → the default table; else undefined.
  const activeTslug = activeTableFromPath(currentPath);

  const handlers = useRailHandlers({
    navigate,
    wslug,
    qc,
    updateProject,
    searchRef,
    setNewViewSheet,
    setCreatingProject,
    setCreatingTable,
    setConfirmDelete,
  });

  const primary: NavItem[] = useMemo(
    () =>
      buildRailTree({
        projects: projectList.map((p) => ({ slug: p.slug, name: p.name, icon: p.icon })),
        tablesByProject,
        viewsByTable,
        currentRoute: {
          wslug,
          pslug: activePslug,
          tslug: activeTslug,
          viewId: activeViewId,
          isWiki: currentPath.endsWith('/wiki'),
        },
        handlers,
      }),
    [
      projectList,
      tablesByProject,
      viewsByTable,
      wslug,
      activePslug,
      activeTslug,
      activeViewId,
      currentPath,
      handlers,
    ],
  );

  // Reverse lookup: a rail sortable group is a TABLE ID (see rail-tree.ts
  // `sortableGroup: table.id`). Resolve it back to (pslug, tslug) so the
  // drag-reorder can hit the per-project views PATCH route.
  const tableIndex = useMemo(() => {
    const idx = new Map<string, { pslug: string; tslug: string }>();
    for (const p of projectList) {
      for (const t of tablesByProject[p.slug] ?? [])
        idx.set(t.id, { pslug: p.slug, tslug: t.slug });
    }
    return idx;
  }, [projectList, tablesByProject]);

  const onReorder = useCallback(
    (group: string, activeId: string, overId: string) => {
      const loc = tableIndex.get(group);
      if (!loc) return;
      // active/over ids are the rail NavItem ids: `view:${tableId}:${viewId}`.
      // Strip the `view:<tableId>:` prefix to recover the raw view id (slice(2)
      // + join handles a view id that itself contains ':').
      const toViewId = (navId: string) => navId.split(':').slice(2).join(':');
      // Match the rail's DISPLAY order (rail-tree.ts sorts by `order`, then default
      // first on ties) so reorderViewIds computes against the same baseline the user
      // dragged within — the raw API order can differ.
      const currentIds = [...(viewsByTable[group] ?? [])]
        .sort((a, b) =>
          a.order !== b.order ? a.order - b.order : Number(b.isDefault) - Number(a.isDefault),
        )
        .map((v) => v.id);
      const newIds = reorderViewIds(currentIds, toViewId(activeId), toViewId(overId));
      if (newIds === currentIds) return; // reorderViewIds returns same ref on no-op
      handlers.onReorderViews?.(loc.pslug, loc.tslug, newIds);
    },
    [tableIndex, viewsByTable, handlers],
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
        await client.delete(
          `/api/v1/w/${wslug}/p/${confirmDelete.pslug}/tables/${confirmDelete.tslug}`,
        );
        await qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, confirmDelete.pslug) });
        // Views and documents cascade-delete in the DB; the FE caches won't
        // notice without explicit invalidation, leaving ghost rows in the rail
        // and stale doc list responses.
        await qc.invalidateQueries({
          queryKey: viewsKeys.list(wslug, confirmDelete.pslug, confirmDelete.tslug),
        });
        // The rail reads the batched per-project views query (keyed by the full
        // table-slug set, which just changed) — invalidate by project prefix so
        // it refetches and the deleted table's views vanish from the rail.
        await qc.invalidateQueries({
          queryKey: viewsKeys.batchPrefix(wslug, confirmDelete.pslug),
        });
        await qc.invalidateQueries({
          queryKey: documentsKeys.listPrefix(wslug, confirmDelete.pslug, confirmDelete.tslug),
        });
        toast.success(`Deleted table "${confirmDelete.name}"`);
      } else if (confirmDelete.kind === 'view') {
        await client.delete(
          `/api/v1/w/${wslug}/p/${confirmDelete.pslug}/t/${confirmDelete.tslug}/views/${confirmDelete.viewId}`,
        );
        await qc.invalidateQueries({
          queryKey: viewsKeys.list(wslug, confirmDelete.pslug, confirmDelete.tslug),
        });
        // Refresh the rail's batched per-project views (see table-delete branch).
        await qc.invalidateQueries({
          queryKey: viewsKeys.batchPrefix(wslug, confirmDelete.pslug),
        });
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
    <EventStreamProvider wslug={wslug}>
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
                  onOpenAgents={() => void navigate({ to: '/w/$wslug/agents', params: { wslug } })}
                  onWorkWithAgent={() => agentPanelBus.toggle()}
                />
              ),
            }}
            primary={primary}
            onReorder={onReorder}
            tools={TOOLS}
            user={{
              name: userName,
              menu: (trigger) => (
                <UserMenu
                  trigger={trigger}
                  email={me?.user.email}
                  onSignOut={onSignOut}
                  onCreateWorkspace={onCreateWorkspace}
                  onOpenInstanceSettings={
                    hasInstanceSettings
                      ? () =>
                          void navigate({
                            to: '/w/$wslug/instance-settings',
                            params: { wslug },
                          })
                      : undefined
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
        panel={<AgentCockpitPanel />}
      />
      <WorkspaceCreate open={creatingWorkspace} onOpenChange={setCreatingWorkspace} />
      <ProjectCreate wslug={wslug} open={creatingProject} onOpenChange={setCreatingProject} />
      {creatingTable && (
        <TableCreate
          wslug={wslug}
          pslug={creatingTable.pslug}
          open={creatingTable !== null}
          onOpenChange={(open) => {
            if (!open) setCreatingTable(null);
          }}
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
          tslug={newViewSheet.tslug}
          currentSearch={currentSearch}
          currentColumns={newViewCurrentColumns}
        />
      )}
      <Dialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogTitle>
                Delete {confirmDelete.kind} "{confirmDelete.name}"?
              </DialogTitle>
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
    </EventStreamProvider>
  );
}
