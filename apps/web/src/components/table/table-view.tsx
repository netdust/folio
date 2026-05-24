import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
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
import { SaveFiltersAction } from '../views/save-filters-action.tsx';
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

  const urlViewId = typeof search.view === 'string' ? search.view : undefined;

  const activeView = useMemo(() => {
    const list = viewsData ?? [];
    if (urlViewId) {
      const found = list.find((v) => v.id === urlViewId);
      if (found) return found;
    }
    return list.find((v) => v.isDefault) ?? list[0] ?? null;
  }, [urlViewId, viewsData]);

  // Hydrate URL filters/sort from the active view ONCE per view. The ref guard
  // prevents the effect from re-firing when `search` updates as a result of
  // hydration. User changes to the URL after hydration always win until they
  // explicitly save filters back to the view (Task 8).
  const hydratedViewId = useRef<string | null>(null);
  useEffect(() => {
    if (!activeView) return;
    if (hydratedViewId.current === activeView.id) return;
    hydratedViewId.current = activeView.id;

    const viewFilters = (activeView.filters ?? {}) as Record<string, unknown>;
    const nextSearch: Record<string, unknown> = {};

    if (search.doc) nextSearch.doc = search.doc;
    if (urlViewId) nextSearch.view = urlViewId;

    // The compiler accepts both flat (`{status: 'In Progress'}`) and AST
    // (`{status: {$eq: 'In Progress'}}`); honor both at read time.
    for (const key of ['status', 'priority', 'assignee', 'labels', 'updated_since'] as const) {
      const raw = viewFilters[key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw === 'string' || typeof raw === 'number' || Array.isArray(raw)) {
        nextSearch[key] = raw;
        continue;
      }
      if (typeof raw === 'object') {
        const op = raw as Record<string, unknown>;
        if ('$eq' in op && op['$eq'] !== undefined) nextSearch[key] = op['$eq'];
        else if ('$in' in op && Array.isArray(op['$in'])) nextSearch[key] = op['$in'] as unknown[];
      }
    }

    const viewSort = activeView.sort;
    if (Array.isArray(viewSort) && viewSort.length > 0) {
      const first = viewSort[0];
      if (first && typeof first === 'object' && 'key' in first) {
        const k = (first as { key: unknown }).key;
        if (typeof k === 'string') {
          nextSearch.sort = k;
          const d = (first as { dir?: unknown }).dir;
          nextSearch.dir = d === 'desc' ? 'desc' : 'asc';
        }
      }
    }

    const searchObj = search as Record<string, unknown>;
    const same =
      Object.keys(searchObj).length === Object.keys(nextSearch).length &&
      Object.keys(nextSearch).every((k) => nextSearch[k] === searchObj[k]);
    if (same) return;

    void navigate({ to: '.', search: nextSearch, replace: true });
  }, [activeView, urlViewId, navigate, search]);

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

  const onVisibilityChange = async (next: string[]) => {
    if (!activeView) return;
    try {
      await updateView.mutateAsync({ id: activeView.id, patch: { visibleFields: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onReorder = async (next: string[]) => {
    if (!activeView) return;
    try {
      await updateView.mutateAsync({ id: activeView.id, patch: { columnOrder: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const filteredDocs = useMemo(
    () => applyFrontmatterClauses(page?.data ?? [], clauses),
    [page, clauses],
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <FilterBar
          clauses={clauses}
          statuses={statuses ?? []}
          pinnedFields={fields ?? []}
          onChange={onClauseChange}
        />
        {activeView && (
          <SaveFiltersAction
            wslug={wslug}
            pslug={pslug}
            view={activeView}
            clauses={clauses}
          />
        )}
      </div>
      <div className="folio-scroll -mx-[22px] overflow-x-auto">
        <div className="min-w-max px-[22px]">
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
        </div>
      </div>
    </>
  );
}
