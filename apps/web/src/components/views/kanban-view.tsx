import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import { useCreateDocument, useDocuments, useUpdateDocument, type DocumentSummary } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useViews, useUpdateView } from '../../lib/api/views.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { KanbanColumn } from '../kanban/kanban-column.tsx';
import { KanbanCard } from '../kanban/kanban-card.tsx';
import { boardControlsBus, type BoardSort } from '../../lib/board-controls-bus.ts';
import { buildColumns } from '../kanban/board-grouping.ts';
import { resolveDrop, coerceGroupValue, dropSlotPosition } from '../kanban/board-drag.ts';
import { EmptyState } from './empty-state.tsx';
import { KanbanSkeleton } from './kanban-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

// DragOverlay drop animation is DISABLED (dropAnimation={null}). Why: the
// optimistic re-sort (useUpdateDocument.onMutate) places the REAL card in its
// final slot on the same frame the drag releases. ANY drop animation keeps the
// overlay clone alive on top of that already-placed card for its duration — so
// the dragged card renders TWICE for ~Nms (a fading ghost + the real card),
// which on a DOWNWARD reorder (where the passed cards also reflow up) reads as a
// flicker: cards appear to vanish and reappear. dnd-kit's default keyframes are
// even worse (they slide the overlay back toward the source rect = snap-back).
// With no drop animation the overlay vanishes instantly on release and only the
// optimistically-placed card remains — no duplicate, no flicker. (Verified via
// live DOM frame-sampling 2026-06-08: the 180ms fade was the duplicate-card
// window.)

export function KanbanView({ wslug, pslug, tslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { data: statuses } = useStatuses(wslug, pslug, tslug);
  const { data: viewsData } = useViews(wslug, pslug, tslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());
  // The card currently being dragged. Drives the <DragOverlay> clone (which
  // portals above everything so the dragged card isn't clipped by a column's
  // overflow). Set on drag start, cleared on end/cancel.
  const [activeId, setActiveId] = useState<string | null>(null);

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
  // Selecting Manual / a group-by applies IMMEDIATELY without `?view=`; the
  // override wins over the view's stored value. The bus returns the same
  // Map-stored reference until mutated, so getSnapshot is stable (no loop).
  const override = useSyncExternalStore(
    boardControlsBus.subscribe,
    () => (activeView ? boardControlsBus.get(activeView.id) : undefined),
  );

  // Derive the board's in-column sort. The bus override wins INCLUDING `null`
  // (manual); otherwise fall back to `activeView.sort` (a JSON array of
  // `{key,dir}`, first entry wins) exactly like table-view. `null` = manual,
  // which sorts by `board_position` for hand-ranked ordering.
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

  const listParams = useMemo(
    () =>
      effectiveSort
        ? { type: 'work_item' as const, sort: effectiveSort.key, dir: effectiveSort.dir, limit: 200 }
        // Manual mode (null sort): query by board_position ascending. The server
        // coalesces a null board_position to a high sentinel, so unranked cards
        // (never dragged) sort LAST — deterministic and stable. The first drag
        // assigns a rank via rankBetween, lifting the card out of the unranked tail.
        : { type: 'work_item' as const, sort: 'board_position', dir: 'asc' as const, limit: 200 },
    [effectiveSort],
  );

  const { data: page, isLoading, error } = useDocuments(wslug, pslug, tslug, listParams);
  const update = useUpdateDocument(wslug, pslug, tslug, listParams);
  const create = useCreateDocument(wslug, pslug, tslug);
  const updateView = useUpdateView(wslug, pslug, tslug);

  // Switch Sort→Manual the SAME way board-controls.tsx onSortChange does: set
  // the live bus override to null (manual) AND persist `sort: []` (empty array =
  // manual / board_position) on the active view so it survives a reload. Reused
  // by the auto-switch-on-reorder path (ISSUE 1) — keep in lockstep with the
  // toolbar's writer so the two never diverge.
  const persistManualSort = () => {
    if (!activeView) return;
    boardControlsBus.setSort(activeView.id, null);
    updateView.mutate(
      { id: activeView.id, patch: { sort: [] } },
      { onError: (err) => toast.error(formatApiError(err)) },
    );
  };

  const groupBy = (override?.groupBy ?? activeView?.groupBy ?? 'status') || 'status';
  const groupField = groupBy === 'status' ? null : (fields ?? []).find((f) => f.key === groupBy) ?? null;

  const columns = useMemo(
    () => buildColumns({ docs: page?.data ?? [], groupBy, field: groupField, statuses: statuses ?? [] }),
    [page, groupBy, groupField, statuses],
  );

  const docsById = useMemo(() => {
    const m = new Map<string, DocumentSummary>();
    for (const d of page?.data ?? []) m.set(d.id, d);
    return m;
  }, [page]);

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onCreateInColumn = async (value: string | null) => {
    if (value === null) return;
    try {
      const created = await create.mutateAsync({ type: 'work_item', title: 'Untitled' });
      const patch =
        groupBy === 'status'
          ? { status: value }
          : { frontmatter: { [groupBy]: coerceGroupValue(value, groupField?.type) } };
      await update.mutateAsync({ slug: created.slug, patch });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // Returns the doc's current grouping value (status key or frontmatter value)
  // so onDragEnd can no-op when the card is dropped on its own column.
  const currentGroupValue = (d: DocumentSummary): string | null => {
    if (groupBy === 'status') return d.status ?? null;
    const v = (d.frontmatter as Record<string, unknown>)[groupBy];
    if (v === null || v === undefined || v === '') return null;
    return String(v);
  };

  // Manual mode (no field sort) is where within-column drag-reorder writes
  // board_position directly. A null effectiveSort = manual mode. In SORTED mode
  // a within-column card-over-card drop is a hand-reorder INTENT that the active
  // sort can't express — onDragEnd auto-switches the view to Manual and applies
  // the reorder (the `auto-manual-reorder` action). Cards are sortable in BOTH
  // modes so dnd-kit reports the over-CARD (not just the column) and we can
  // resolve the slot to drop into; only the PERSIST behavior is mode-gated.
  const reorderEnabled = effectiveSort === null;

  // Builds the grouping-field patch for moving a card into `colValue`.
  // Status grouping writes the status column directly; field grouping coerces
  // the (always-string) column value back to the field's declared type so we
  // don't flip e.g. number 3 into the string "3".
  const groupingPatch = (colValue: string | null): Record<string, unknown> =>
    groupBy === 'status'
      ? { status: colValue }
      : { frontmatter: { [groupBy]: coerceGroupValue(colValue, groupField?.type) } };

  // Computes the board_position for dropping the active card into `col` at the
  // slot occupied by `overDocId` (drop-before). `null` overDocId appends.
  const slotPosition = (col: { docIds: string[] }, activeId: string, overDocId: string | null): string =>
    dropSlotPosition(col.docIds, (id) => docsById.get(id)?.boardPosition ?? null, activeId, overDocId);

  const onDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const onDragCancel = () => {
    setActiveId(null);
  };

  const onDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    const activeId = String(active.id);
    const slug = (active.data.current as { slug?: string } | undefined)?.slug;
    if (!slug) return;

    const overIsColumn = overId.startsWith('col-');
    // Destination column: either the col-* droppable, or the column owning the
    // over-card (manual mode drops land on cards inside per-column contexts).
    let destCol: { value: string | null; docIds: string[] } | undefined;
    if (overIsColumn) {
      const raw = overId.slice('col-'.length);
      const value = raw === '__unset__' ? null : raw;
      destCol = columns.find((c) => c.value === value) ?? { value, docIds: [] };
    } else {
      destCol = columns.find((c) => c.docIds.includes(overId));
    }
    if (!destCol) return;
    const destColumnValue = destCol.value;

    const activeDoc = docsById.get(activeId);
    const activeGroupValue = activeDoc ? currentGroupValue(activeDoc) : null;

    const action = resolveDrop({ reorderEnabled, overIsColumn, activeGroupValue, destColumnValue });
    if (action.kind === 'none') return;
    if ((action.kind === 'reorder' || action.kind === 'auto-manual-reorder') && activeId === overId) return;

    let patch: Record<string, unknown>;
    if (action.kind === 'reorder') {
      patch = { boardPosition: slotPosition(destCol, activeId, overId) };
    } else if (action.kind === 'auto-manual-reorder') {
      // Sorted mode + same-column card drop = hand-reorder intent. Flip the view
      // to Manual (live bus + persisted `sort: []`) so board_position becomes the
      // ordering, THEN apply the reorder patch so the card lands where dropped.
      // The bus flip re-derives effectiveSort=null → reorderEnabled=true and the
      // board re-queries by board_position; the toolbar Sort label reads the same
      // bus override, so it updates to "Manual" automatically.
      persistManualSort();
      patch = { boardPosition: slotPosition(destCol, activeId, overId) };
    } else if (action.kind === 'regroup') {
      patch = groupingPatch(destColumnValue);
    } else {
      // regroup-reorder: land the card where dropped in the destination column.
      const overDocId = overIsColumn ? null : overId;
      patch = { ...groupingPatch(destColumnValue), boardPosition: slotPosition(destCol, activeId, overDocId) };
    }

    setPendingSlugs((p) => new Set(p).add(slug));
    try {
      await update.mutateAsync({ slug, patch });
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setPendingSlugs((p) => {
        const n = new Set(p);
        n.delete(slug);
        return n;
      });
    }
  };

  if (isLoading) return <KanbanSkeleton />;
  if (error) return <div className="p-4 text-danger">Failed to load board.</div>;
  if (groupBy === 'status' && (!statuses || statuses.length === 0)) {
    return (
      <EmptyState
        title="No statuses"
        description="Project has no statuses; expected the auto-seeded defaults."
      />
    );
  }

  const activeDoc = activeId ? docsById.get(activeId) ?? null : null;

  return (
    <DndContext
      sensors={sensors}
      // closestCorners returns the nearest droppable by corner distance: a CARD
      // when the pointer is over a card (→ within-column reorder registers as
      // reorder, not the column), the COLUMN when over its whitespace (→ empty-
      // column regroup still wins). The default rectIntersection favored the big
      // column droppable, so card-over-card drops reported col-* and no-op'd.
      collisionDetection={closestCorners}
      // Re-measure droppables on EVERY render during a drag (not just at drag
      // start). After a cross-column move, the just-moved card's optimistic
      // re-render changes the DOM, but dnd-kit caches rects at drag-start — so
      // on the NEXT drag the moved card's column had a STALE measurement: no gap
      // opened and the card couldn't be reordered until another drag forced a
      // re-measure ("I first have to move another item"). `Always` re-measures
      // so the moved card is immediately reorderable.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* MainFrame's children container already supplies px-[22px] py-2; don't double it up. */}
        <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto">
          {columns.map((col) => (
          <KanbanColumn
            key={col.value ?? '__unset__'}
            value={col.value}
            label={col.label}
            color={col.color}
            count={col.docIds.length}
            onAdd={col.value === null ? undefined : () => onCreateInColumn(col.value)}
            isAddPending={create.isPending}
            docIds={col.docIds}
            // Always wrap in a SortableContext so a card-over-card drop reports
            // the over-CARD even in sorted mode (lets onDragEnd resolve the slot
            // for the auto-switch-to-Manual reorder). The PERSIST gate is
            // reorderEnabled, handled in onDragEnd — not here.
            sortable
          >
            {col.docIds.map((id) => {
              const doc = docsById.get(id);
              if (!doc) return null;
              return (
                <KanbanCard
                  key={doc.id}
                  doc={doc}
                  onOpen={openDoc}
                  isPending={pendingSlugs.has(doc.slug)}
                  // Always sortable (both modes) so over.id is a card on a
                  // card-over-card drop — see KanbanColumn `sortable` note.
                  sortable
                />
              );
            })}
            </KanbanColumn>
          ))}
        </div>
      </div>
      {/* The dragged card's visible clone. DragOverlay portals to the body, so
          it escapes each column's `overflow-y-auto` clip and paints on top —
          the original in-place card hides (opacity 0) while this shows. */}
      <DragOverlay dropAnimation={null}>
        {activeDoc ? <KanbanCard doc={activeDoc} onOpen={openDoc} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
