import type { QueryClient } from '@tanstack/react-query';
import type { useNavigate } from '@tanstack/react-router';
import { type MutableRefObject, useMemo } from 'react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client.ts';
import { formatApiError } from '../../lib/api/index.ts';
import type { useUpdateProject } from '../../lib/api/projects.ts';
import { tablesKeys } from '../../lib/api/tables.ts';
import { viewsKeys } from '../../lib/api/views.ts';
import { resolveTableNav, resolveViewNav } from '../../lib/rail-nav.ts';
import type { RailTreeHandlers } from '../../lib/rail-tree.ts';
import { spacedOrders } from '../../lib/view-reorder.ts';

type ConfirmDelete =
  | { kind: 'project'; pslug: string; name: string }
  | { kind: 'table'; pslug: string; tslug: string; name: string }
  | { kind: 'view'; pslug: string; tslug: string; viewId: string; name: string };

export interface UseRailHandlersDeps {
  navigate: ReturnType<typeof useNavigate>;
  wslug: string;
  qc: QueryClient;
  updateProject: ReturnType<typeof useUpdateProject>;
  /** Live current-search ref — read at click time to preserve `?doc=` on view switch. */
  searchRef: MutableRefObject<Record<string, unknown>>;
  setNewViewSheet: (v: { pslug: string; tslug: string } | null) => void;
  setCreatingProject: (v: boolean) => void;
  setCreatingTable: (v: { pslug: string } | null) => void;
  setConfirmDelete: (v: ConfirmDelete | null) => void;
}

/**
 * The rail's interaction handlers, extracted verbatim from the workspace layout
 * (M3 audit 3.5 — pure extraction, behavior-identical). The view-mutating
 * handlers invalidate BOTH the per-table `viewsKeys.list` (legacy consumers) AND
 * the project's `viewsKeys.batchPrefix` — the rail now reads the batched query,
 * which a per-table invalidation alone would not refresh.
 */
export function useRailHandlers(deps: UseRailHandlersDeps): RailTreeHandlers {
  const {
    navigate,
    wslug,
    qc,
    updateProject,
    searchRef,
    setNewViewSheet,
    setCreatingProject,
    setCreatingTable,
    setConfirmDelete,
  } = deps;

  return useMemo<RailTreeHandlers>(
    () => ({
      onProjectClick: (pslug: string) => {
        void navigate({
          to: '/w/$wslug/p/$pslug/work-items',
          params: { wslug, pslug },
        });
      },
      // Clicking a table in the rail lands on its grid. The DEFAULT table uses
      // the legacy /work-items route (no :tslug); every other table routes to
      // its own /t/$tslug grid. resolveTableNav owns that branch.
      onTableClick: (pslug: string, tslug: string) => {
        const target = resolveTableNav(tslug);
        void navigate({
          to: target.to,
          params: target.withTslug ? { wslug, pslug, tslug } : { wslug, pslug },
        });
      },
      onViewClick: (pslug: string, tslug: string, viewId: string, type: 'list' | 'kanban') => {
        // Default table → /work-items|/board; non-default → /t/$tslug(/board).
        const target = resolveViewNav(tslug, type);
        // Preserve ?doc= (open slideover) but drop the previous view's filter
        // and sort params — TableView's hydration treats URL params as winners
        // over view.filters, so carrying ?status= across a view switch would
        // silently mask the new view's stored filters.
        const prev = searchRef.current;
        const next: Record<string, unknown> = { view: viewId };
        if (typeof prev.doc === 'string') next.doc = prev.doc;
        void navigate({
          to: target.to,
          params: target.withTslug ? { wslug, pslug, tslug } : { wslug, pslug },
          search: next,
        });
      },
      onWikiClick: (pslug: string) => {
        void navigate({ to: '/w/$wslug/p/$pslug/wiki', params: { wslug, pslug } });
      },
      // Phase 2.5: agents + triggers moved to workspace popover; no project-level handlers here.
      onNewView: (pslug: string, tslug: string) => {
        setNewViewSheet({ pslug, tslug });
      },
      onNewProject: () => setCreatingProject(true),
      onNewTable: (pslug: string) => setCreatingTable({ pslug }),
      onRenameProject: async (pslug, next) => {
        try {
          await updateProject.mutateAsync({ pslug, patch: { name: next } });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      },
      onDeleteProject: (pslug, name) => setConfirmDelete({ kind: 'project', pslug, name }),
      onRenameTable: async (pslug, tslug, next) => {
        try {
          await client.patch(`/api/v1/w/${wslug}/p/${pslug}/tables/${tslug}`, { name: next });
          await qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, pslug) });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      },
      onDeleteTable: (pslug, tslug, name) =>
        setConfirmDelete({ kind: 'table', pslug, tslug, name }),
      onRenameView: async (pslug, tslug, viewId, next) => {
        try {
          await client.patch(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views/${viewId}`, {
            name: next,
          });
          await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
          await qc.invalidateQueries({ queryKey: viewsKeys.batchPrefix(wslug, pslug) });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      },
      onDeleteView: (pslug, tslug, viewId, name) =>
        setConfirmDelete({ kind: 'view', pslug, tslug, viewId, name }),
      onMoveView: async (pslug, tslug, viewId, neighborOrder, direction) => {
        try {
          // Single direction-aware reseat: move the view to just past its neighbor
          // (down → neighbor+1, up → neighbor-1). One write, atomic, and correct
          // even when the two share an `order` — unlike a value-swap, which no-ops
          // on ties. The rail sorts by `order`, so ±1 always lands the view on the
          // right side of the neighbor.
          const target = direction === 'down' ? neighborOrder + 1 : neighborOrder - 1;
          await client.patch(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views/${viewId}`, {
            order: target,
          });
          await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
          await qc.invalidateQueries({ queryKey: viewsKeys.batchPrefix(wslug, pslug) });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      },
      onReorderViews: async (pslug, tslug, orderedViewIds) => {
        try {
          // Reassign gap-spaced (0,10,20,…) orders by the new position and PATCH
          // every view. Re-setting a view to the order it already has is a harmless
          // no-op write, so we don't need the current orders here — which keeps this
          // handler (and the whole rail tree) free of a viewsByTable dependency.
          // The new ordered ids come from the `onReorder` callback near <Rail>,
          // which DOES have the live ordering.
          await Promise.all(
            spacedOrders(orderedViewIds).map((n) =>
              client.patch(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views/${n.id}`, {
                order: n.order,
              }),
            ),
          );
          await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
          await qc.invalidateQueries({ queryKey: viewsKeys.batchPrefix(wslug, pslug) });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      },
    }),
    [
      navigate,
      wslug,
      qc,
      updateProject,
      searchRef,
      setNewViewSheet,
      setCreatingProject,
      setCreatingTable,
      setConfirmDelete,
    ],
  );
}
