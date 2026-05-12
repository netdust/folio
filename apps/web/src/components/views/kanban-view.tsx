import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useDocuments, type DocumentSummary } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { KanbanColumn } from '../kanban/kanban-column.tsx';
import { KanbanCard } from '../kanban/kanban-card.tsx';
import { EmptyState } from './empty-state.tsx';

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

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
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

  if (isLoading) return <div className="p-4 text-fg-3">Loading…</div>;
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
    <div className="flex h-full gap-3 overflow-x-auto px-[22px] py-2">
      {statuses.map((s) => (
        <KanbanColumn key={s.key} status={s} count={grouped.get(s.key)?.length ?? 0}>
          {(grouped.get(s.key) ?? []).map((doc) => (
            <KanbanCard key={doc.id} doc={doc} onOpen={openDoc} />
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
              <KanbanCard key={doc.id} doc={doc} onOpen={openDoc} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
