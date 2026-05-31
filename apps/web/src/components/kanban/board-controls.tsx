import { useMemo, useSyncExternalStore } from 'react';
import { useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useViews, useUpdateView } from '../../lib/api/views.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { BoardToolbar } from './board-toolbar.tsx';
import { boardControlsBus, type BoardSort } from '../../lib/board-controls-bus.ts';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

// Self-contained group-by/sort controls rendered in the project tab row on the
// Board tab. This is the SOLE WRITER of the board-controls bus + view
// persistence; KanbanView is a pure reader of the bus.
export function BoardControls({ wslug, pslug, tslug }: Props) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { data: viewsData } = useViews(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const updateView = useUpdateView(wslug, pslug);

  const urlViewId = typeof search.view === 'string' ? search.view : undefined;
  const activeView = useMemo(() => {
    const list = viewsData ?? [];
    if (urlViewId) {
      const found = list.find((v) => v.id === urlViewId);
      if (found) return found;
    }
    return list.find((v) => v.isDefault) ?? list[0] ?? null;
  }, [urlViewId, viewsData]);

  // Ad-hoc group-by / sort overrides live in a module bus keyed by view id.
  // Mirror kanban-view's subscription so both stay in lockstep.
  const override = useSyncExternalStore(boardControlsBus.subscribe, () =>
    activeView ? boardControlsBus.get(activeView.id) : undefined,
  );

  // Effective sort: bus override wins (including `null` = manual); otherwise
  // fall back to the view's stored sort (first entry of the JSON array).
  const effectiveSort: BoardSort | null = useMemo(() => {
    if (override && 'sort' in override) return override.sort ?? null;
    const viewSort = activeView?.sort;
    if (!Array.isArray(viewSort) || viewSort.length === 0) return null;
    const first = viewSort[0];
    if (!first || typeof first !== 'object' || !('key' in first)) return null;
    const k = (first as { key: unknown }).key;
    if (typeof k !== 'string') return null;
    const d = (first as { dir?: unknown }).dir;
    return { key: k, dir: d === 'desc' ? 'desc' : 'asc' };
  }, [activeView, override]);

  const effectiveGroupBy = (override?.groupBy ?? activeView?.groupBy ?? 'status') || 'status';

  // Persistence to the stored view follows the consent gate: only write when
  // the user explicitly opened the view via `?view=<id>`.
  const isActiveViewUrlPinned = !!urlViewId && !!activeView && activeView.id === urlViewId;

  const onGroupByChange = (gb: string) => {
    if (!activeView) return;
    boardControlsBus.setGroupBy(activeView.id, gb);
    if (isActiveViewUrlPinned) {
      // Store 'status' as null per the column's "defaults to status" convention.
      updateView.mutate(
        { id: activeView.id, patch: { groupBy: gb === 'status' ? null : gb } },
        { onError: (err) => toast.error(formatApiError(err)) },
      );
    }
  };

  const onSortChange = (s: BoardSort | null) => {
    if (!activeView) return;
    boardControlsBus.setSort(activeView.id, s);
    if (isActiveViewUrlPinned) {
      // Empty array = manual (board_position) ordering.
      updateView.mutate(
        { id: activeView.id, patch: { sort: s ? [{ key: s.key, dir: s.dir }] : [] } },
        { onError: (err) => toast.error(formatApiError(err)) },
      );
    }
  };

  if (!activeView) return null;

  return (
    <div className="flex items-center gap-1">
      <BoardToolbar
        groupBy={effectiveGroupBy}
        sort={effectiveSort}
        fields={fields ?? []}
        onGroupByChange={onGroupByChange}
        onSortChange={onSortChange}
      />
    </div>
  );
}
