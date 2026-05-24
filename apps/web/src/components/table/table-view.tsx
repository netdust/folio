import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState, useCallback } from 'react';
import { Inbox } from 'lucide-react';
import { toast } from 'sonner';
import {
  useDocuments,
  useCreateDocument,
  useUpdateDocument,
  parseFilters,
  clausesToListParams,
  applyFrontmatterClauses,
  type DocumentPatch,
  type FilterClauseUrl,
} from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useFields } from '../../lib/api/fields.ts';
import { useViews, useUpdateView } from '../../lib/api/views.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Icon } from '../ui/icon.tsx';
import { FilterBar } from '../filter/filter-bar.tsx';
import { EmptyState } from '../views/empty-state.tsx';
import { ListSkeleton } from '../views/list-skeleton.tsx';
import { TableHeader, type SortState } from './table-header.tsx';
import { TableRow } from './table-row.tsx';
import {
  mergeColumns,
  applyColumnOrder,
  effectiveVisibleKeys,
  type Column,
} from './columns.ts';

interface Props {
  wslug: string;
  pslug: string;
}

export function TableView({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const clauses = useMemo(() => parseFilters(search), [search]);

  const sort: SortState | null = useMemo(() => {
    const k = typeof search.sort === 'string' ? search.sort : null;
    const d = typeof search.dir === 'string' ? search.dir : null;
    if (!k) return null;
    return { key: k as SortState['key'], dir: (d as SortState['dir']) ?? 'asc' };
  }, [search.sort, search.dir]);

  const listParams = useMemo(() => {
    const base = clausesToListParams(clauses);
    return sort ? { ...base, sort: sort.key, dir: sort.dir } : base;
  }, [clauses, sort]);

  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug);
  const { data: viewsData } = useViews(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
  const updateView = useUpdateView(wslug, pslug);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

  // For Phase 2B: use the default view if any, else the first; null if neither.
  // Phase 2C will read the active view from ?view=:slug in the URL.
  const activeView = useMemo(() => {
    const list = viewsData ?? [];
    return list.find((v) => v.isDefault) ?? list[0] ?? null;
  }, [viewsData]);

  const allColumns: Column[] = useMemo(
    () => mergeColumns(fields ?? [], activeView),
    [fields, activeView],
  );
  const orderedColumns: Column[] = useMemo(
    () => applyColumnOrder(allColumns, activeView?.columnOrder ?? null),
    [allColumns, activeView],
  );
  const visibleKeys = useMemo(
    () => effectiveVisibleKeys(allColumns, activeView),
    [allColumns, activeView],
  );
  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => visibleKeys.includes(c.key)),
    [orderedColumns, visibleKeys],
  );

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title: 'Untitled' });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onClauseChange = (next: FilterClauseUrl[]) => {
    const nextSearch: Record<string, unknown> = { ...search };
    for (const k of ['status', 'priority', 'labels', 'assignee', 'updated_since']) {
      delete nextSearch[k];
    }
    for (const c of next) {
      if (c.kind === 'status') nextSearch['status'] = c.values;
      if (c.kind === 'priority') nextSearch['priority'] = c.value;
      if (c.kind === 'labels') nextSearch['labels'] = c.values;
      if (c.kind === 'assignee') nextSearch['assignee'] = c.value;
      if (c.kind === 'updated_since') nextSearch['updated_since'] = c.value;
    }
    void navigate({ to: '.', search: nextSearch, replace: false });
  };

  const onSortChange = (next: SortState | null) => {
    const nextSearch: Record<string, unknown> = { ...search };
    if (next) {
      nextSearch.sort = next.key;
      nextSearch.dir = next.dir;
    } else {
      delete nextSearch.sort;
      delete nextSearch.dir;
    }
    void navigate({ to: '.', search: nextSearch, replace: false });
  };

  const onUpdate = useCallback(
    async (slug: string, patch: DocumentPatch) => {
      setPendingSlugs((prev) => new Set(prev).add(slug));
      try {
        await update.mutateAsync({ slug, patch });
      } finally {
        setPendingSlugs((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    },
    [update],
  );

  const onVisibilityChange = (next: string[]) => {
    if (!activeView) return;
    updateView.mutate({ id: activeView.id, patch: { visibleFields: next } });
  };

  const onReorder = (next: string[]) => {
    if (!activeView) return;
    updateView.mutate({ id: activeView.id, patch: { columnOrder: next } });
  };

  const filteredDocs = useMemo(
    () => applyFrontmatterClauses(page?.data ?? [], clauses),
    [page, clauses],
  );

  return (
    <>
      <div className="px-[22px] py-2">
        <FilterBar
          clauses={clauses}
          statuses={statuses ?? []}
          pinnedFields={fields ?? []}
          onChange={onClauseChange}
        />
      </div>
      <TableHeader
        columns={visibleColumns}
        allColumns={allColumns}
        visibleKeys={visibleKeys}
        sort={sort}
        onSort={onSortChange}
        onVisibilityChange={onVisibilityChange}
        onReorder={onReorder}
      />
      {isLoading ? <ListSkeleton rows={6} /> : null}
      {error ? <div className="p-4 text-danger">Failed to load documents.</div> : null}
      {!isLoading && !error && filteredDocs.length === 0 ? (
        <EmptyState
          icon={clauses.length === 0 ? <Icon icon={Inbox} size={20} /> : undefined}
          title={clauses.length > 0 ? 'No matching documents' : 'No work items yet'}
          description={
            clauses.length > 0
              ? 'Try removing a filter chip above.'
              : 'Create your first work item to get started.'
          }
          action={
            clauses.length === 0
              ? { label: 'Create your first work item', onClick: onCreate }
              : undefined
          }
        />
      ) : null}
      <div role="list" className="flex flex-col">
        {filteredDocs.map((doc) => (
          <TableRow
            key={doc.id}
            doc={doc}
            columns={visibleColumns}
            statuses={statuses ?? []}
            wslug={wslug}
            pslug={pslug}
            isPending={pendingSlugs.has(doc.slug)}
            onOpen={openDoc}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </>
  );
}
