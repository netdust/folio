import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { toast } from 'sonner';
import { useCreateDocument, useDocuments, useUpdateDocument, type DocumentSummary } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useViews } from '../../lib/api/views.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { KanbanColumn } from '../kanban/kanban-column.tsx';
import { KanbanCard } from '../kanban/kanban-card.tsx';
import { buildColumns } from '../kanban/board-grouping.ts';
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
  const listParams = useMemo(
    () => ({ type: 'work_item' as const, sort: 'updated_at' as const, dir: 'desc' as const, limit: 200 }),
    [],
  );
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: viewsData } = useViews(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
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

  const groupBy = (activeView?.groupBy ?? 'status') || 'status';
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
      const patch = groupBy === 'status' ? { status: value } : { frontmatter: { [groupBy]: value } };
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

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith('col-')) return;
    const raw = overId.slice('col-'.length);
    const colValue = raw === '__unset__' ? null : raw;
    const data = active.data.current as { slug?: string } | undefined;
    const slug = data?.slug;
    if (!slug) return;
    // The draggable id is the doc id (see KanbanCard's useDraggable).
    const doc = docsById.get(String(active.id));
    if (doc && currentGroupValue(doc) === colValue) return;
    const patch = groupBy === 'status' ? { status: colValue } : { frontmatter: { [groupBy]: colValue } };
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
      {/* MainFrame's children container already supplies px-[22px] py-2; don't double it up. */}
      <div className="flex h-full gap-3 overflow-x-auto">
        {columns.map((col) => (
          <KanbanColumn
            key={col.value ?? '__unset__'}
            value={col.value}
            label={col.label}
            color={col.color}
            count={col.docIds.length}
            onAdd={col.value === null ? undefined : () => onCreateInColumn(col.value)}
            isAddPending={create.isPending}
          >
            {col.docIds.map((id) => {
              const doc = docsById.get(id);
              if (!doc) return null;
              return <KanbanCard key={doc.id} doc={doc} onOpen={openDoc} isPending={pendingSlugs.has(doc.slug)} />;
            })}
          </KanbanColumn>
        ))}
      </div>
    </DndContext>
  );
}
