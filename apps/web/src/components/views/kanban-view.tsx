import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { toast } from 'sonner';
import { useCreateDocument, useDocuments, useUpdateDocument, type DocumentSummary } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { KanbanColumn } from '../kanban/kanban-column.tsx';
import { KanbanCard } from '../kanban/kanban-card.tsx';
import { EmptyState } from './empty-state.tsx';
import { KanbanSkeleton } from './kanban-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
}

export function KanbanView({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const listParams = useMemo(
    () => ({ type: 'work_item' as const, sort: 'updated_at' as const, dir: 'desc' as const, limit: 200 }),
    [],
  );
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onCreateInColumn = async (statusKey: string) => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title: 'Untitled' });
      await update.mutateAsync({ slug: created.slug, patch: { status: statusKey } });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith('col-')) return;
    const newStatus = overId.slice('col-'.length);
    const data = active.data.current as { slug?: string; currentStatus?: string | null } | undefined;
    const slug = data?.slug;
    const currentStatus = data?.currentStatus;
    if (!slug) return;
    if (currentStatus === newStatus) return;
    setPendingSlugs((p) => new Set(p).add(slug));
    try {
      await update.mutateAsync({ slug, patch: { status: newStatus } });
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setPendingSlugs((p) => { const n = new Set(p); n.delete(slug); return n; });
    }
  };

  const grouped = useMemo(() => {
    if (!statuses || !page) return new Map<string, DocumentSummary[]>();
    const m = new Map<string, DocumentSummary[]>();
    for (const s of statuses) m.set(s.key, []);
    m.set('__no_status__', []);
    for (const d of page.data) {
      const k = d.status && m.has(d.status) ? d.status : '__no_status__';
      m.get(k)!.push(d);
    }
    return m;
  }, [statuses, page]);

  if (isLoading) return <KanbanSkeleton />;
  if (error) return <div className="p-4 text-danger">Failed to load board.</div>;
  if (!statuses || statuses.length === 0) {
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
        {statuses.map((s) => (
          <KanbanColumn
            key={s.key}
            status={s}
            count={grouped.get(s.key)?.length ?? 0}
            onAdd={() => onCreateInColumn(s.key)}
            isAddPending={create.isPending}
          >
            {(grouped.get(s.key) ?? []).map((doc) => (
              <KanbanCard key={doc.id} doc={doc} onOpen={openDoc} isPending={pendingSlugs.has(doc.slug)} />
            ))}
          </KanbanColumn>
        ))}
        {/* Cards without a status get rendered in a parking lot — Phase 1 keeps them visible. */}
        {(grouped.get('__no_status__')?.length ?? 0) > 0 ? (
          <div className="flex w-[280px] shrink-0 flex-col">
            <div className="mb-2 flex items-center gap-2 px-1 text-sm font-medium text-fg-3">
              No status
            </div>
            <div className="flex min-h-[200px] flex-col gap-2 rounded-md p-1">
              {grouped.get('__no_status__')!.map((doc) => (
                <KanbanCard key={doc.id} doc={doc} onOpen={openDoc} isPending={pendingSlugs.has(doc.slug)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </DndContext>
  );
}
