import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { toast } from 'sonner';
import { useCreateDocument, useDocuments, useUpdateDocument, type DocumentSummary } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useViews } from '../../lib/api/views.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { KanbanColumn } from '../kanban/kanban-column.tsx';
import { KanbanCard } from '../kanban/kanban-card.tsx';
import { boardControlsBus, type BoardSort } from '../../lib/board-controls-bus.ts';
import { buildColumns } from '../kanban/board-grouping.ts';
import { computeReorderPosition } from '../kanban/board-reorder.ts';
import { resolveDrop, coerceGroupValue } from '../kanban/board-drag.ts';
import { EmptyState } from './empty-state.tsx';
import { KanbanSkeleton } from './kanban-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

export function KanbanView({ wslug, pslug, tslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: viewsData } = useViews(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

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
        : { type: 'work_item' as const, sort: 'board_position', dir: 'asc' as const, limit: 200 },
    [effectiveSort],
  );

  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);

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

  // Manual mode (no field sort) is the only mode where within-column
  // drag-reorder is allowed; a field-sort active means the order is derived,
  // so reordering would be meaningless.
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
  const dropSlotPosition = (col: { docIds: string[] }, activeId: string, overDocId: string | null): string => {
    const idsWithoutActive = col.docIds.filter((id) => id !== activeId);
    const idx = overDocId === null ? idsWithoutActive.length : idsWithoutActive.indexOf(overDocId);
    const targetIndex = idx === -1 ? idsWithoutActive.length : idx;
    const positions = idsWithoutActive.map((id) => docsById.get(id)?.boardPosition ?? null);
    return computeReorderPosition(positions, targetIndex);
  };

  const onDragEnd = async (event: DragEndEvent) => {
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
    if (action.kind === 'reorder' && activeId === overId) return;

    let patch: Record<string, unknown>;
    if (action.kind === 'reorder') {
      patch = { boardPosition: dropSlotPosition(destCol, activeId, overId) };
    } else if (action.kind === 'regroup') {
      patch = groupingPatch(destColumnValue);
    } else {
      // regroup-reorder: land the card where dropped in the destination column.
      const overDocId = overIsColumn ? null : overId;
      patch = { ...groupingPatch(destColumnValue), boardPosition: dropSlotPosition(destCol, activeId, overDocId) };
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

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
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
            reorderEnabled={reorderEnabled}
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
                  sortable={reorderEnabled}
                />
              );
            })}
            </KanbanColumn>
          ))}
        </div>
      </div>
    </DndContext>
  );
}
