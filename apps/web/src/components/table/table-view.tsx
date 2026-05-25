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
import { useFields, useCreateField } from '../../lib/api/fields.ts';
import { useViews, useUpdateView } from '../../lib/api/views.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Icon } from '../ui/icon.tsx';
import { FilterBar } from '../filter/filter-bar.tsx';
import { EmptyState } from '../views/empty-state.tsx';
import { ListSkeleton } from '../views/list-skeleton.tsx';
import { TableHeader, type SortState } from './table-header.tsx';
import { ColumnPicker } from './column-picker.tsx';
import { TableRow } from './table-row.tsx';
import { TableAddRow } from './table-add-row.tsx';
import { TableAddColumn, type AddColumnPayload } from './table-add-column.tsx';
import {
  mergeColumns,
  applyColumnOrder,
  effectiveVisibleKeys,
  type Column,
} from './columns.ts';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

/**
 * One-level structural equality for URL search values. `===` is wrong here:
 * filter arrays (status/labels) are fresh references each render even when
 * their contents match, which would force `same` to false on every hydration
 * pass. Exported for direct unit tests.
 */
export function sameSearchValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return false;
}

export function TableView({ wslug, pslug, tslug }: Props) {
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
  const { data: fields } = useFields(wslug, pslug, tslug);
  const { data: viewsData } = useViews(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
  const updateView = useUpdateView(wslug, pslug);
  const createField = useCreateField(wslug, pslug, tslug);
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
    const FILTER_KEYS = ['status', 'priority', 'assignee', 'labels', 'updated_since'] as const;

    if (search.doc) nextSearch.doc = search.doc;
    if (urlViewId) nextSearch.view = urlViewId;

    // URL filter params win — a user who deep-links with ?view=v1&status=todo
    // explicitly chose that override; the view's stored value only fills
    // missing keys.
    for (const key of FILTER_KEYS) {
      const urlValue = search[key];
      if (urlValue !== undefined && urlValue !== null && urlValue !== '') {
        nextSearch[key] = urlValue;
      }
    }

    // The compiler accepts both flat (`{status: 'In Progress'}`) and AST
    // (`{status: {$eq: 'In Progress'}}`); honor both at read time.
    for (const key of FILTER_KEYS) {
      if (key in nextSearch) continue; // URL already supplied this key.
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

    // Sort: URL wins for the same reason.
    const urlSort = search.sort;
    if (typeof urlSort === 'string' && urlSort) {
      nextSearch.sort = urlSort;
      const urlDir = search.dir;
      nextSearch.dir = urlDir === 'desc' ? 'desc' : 'asc';
    } else {
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
    }

    const searchObj = search as Record<string, unknown>;
    const same =
      Object.keys(searchObj).length === Object.keys(nextSearch).length &&
      Object.keys(nextSearch).every((k) => sameSearchValue(nextSearch[k], searchObj[k]));
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

  const onCreate = async (title: string = 'Untitled') => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onClauseChange = (next: FilterClauseUrl[]) => {
    const nextSearch: Record<string, unknown> = { ...search };
    const flatFilters: Record<string, unknown> = {};
    for (const k of ['status', 'priority', 'labels', 'assignee', 'updated_since']) {
      delete nextSearch[k];
    }
    for (const c of next) {
      if (c.kind === 'status') { nextSearch['status'] = c.values; flatFilters['status'] = c.values; }
      if (c.kind === 'priority') { nextSearch['priority'] = c.value; flatFilters['priority'] = c.value; }
      if (c.kind === 'labels') { nextSearch['labels'] = c.values; flatFilters['labels'] = c.values; }
      if (c.kind === 'assignee') { nextSearch['assignee'] = c.value; flatFilters['assignee'] = c.value; }
      if (c.kind === 'updated_since') { nextSearch['updated_since'] = c.value; flatFilters['updated_since'] = c.value; }
    }
    void navigate({ to: '.', search: nextSearch, replace: false });
    // Only autosave when the user has explicitly opened this view (?view=<id>).
    // Without ?view=, activeView is a fallback — filter changes are ad-hoc.
    if (urlViewId && activeView && activeView.id === urlViewId) {
      updateView.mutate(
        { id: activeView.id, patch: { filters: flatFilters } },
        { onError: (err) => toast.error(formatApiError(err)) },
      );
    }
  };

  const onSortChange = (next: SortState | null) => {
    // 1) Update URL (existing behavior, unchanged)
    const nextSearch: Record<string, unknown> = { ...search };
    if (next) {
      nextSearch.sort = next.key;
      nextSearch.dir = next.dir;
    } else {
      delete nextSearch.sort;
      delete nextSearch.dir;
    }
    void navigate({ to: '.', search: nextSearch, replace: false });

    // 2) Auto-save to active view (parity with columnOrder + visibleFields).
    // Same consent gate as onClauseChange — only mutate when the user
    // explicitly opened this view via ?view=<id>.
    if (!urlViewId || !activeView || activeView.id !== urlViewId) return;
    const patchSort = next ? [{ key: next.key, dir: next.dir }] : [];
    updateView.mutate(
      { id: activeView.id, patch: { sort: patchSort } },
      {
        onError: (err) => toast.error(formatApiError(err)),
      },
    );
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

  const onAddColumn = useCallback(
    async (payload: AddColumnPayload) => {
      const created = await createField.mutateAsync(payload);
      if (activeView) {
        const nextVisible = [
          ...(activeView.visibleFields ?? effectiveVisibleKeys(allColumns, activeView)),
          created.key,
        ];
        try {
          await updateView.mutateAsync({ id: activeView.id, patch: { visibleFields: nextVisible } });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      }
    },
    [createField, activeView, allColumns, updateView],
  );

  const filteredDocs = useMemo(
    () => applyFrontmatterClauses(page?.data ?? [], clauses),
    [page, clauses],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-2">
        <FilterBar
          clauses={clauses}
          statuses={statuses ?? []}
          pinnedFields={fields ?? []}
          onChange={onClauseChange}
        />
        <ColumnPicker
          columns={allColumns}
          visibleKeys={visibleKeys}
          onChange={onVisibilityChange}
        />
      </div>
      <div
        data-testid="table-scroll"
        className="folio-scroll -mx-[22px] flex-1 min-h-0 overflow-auto"
      >
        {/* No left padding here: the sticky first column owns its own 22px
            of left whitespace via `pl-[22px]` so the whitespace stays put
            from the first pixel of horizontal scroll (instead of collapsing
            as the row slides left until the cell hits left:0). */}
        <div className="pr-[22px]">
          <TableHeader
            columns={visibleColumns}
            sort={sort}
            onSort={onSortChange}
            onReorder={onReorder}
            trailing={<TableAddColumn onSubmit={onAddColumn} />}
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
                  ? { label: 'Create your first work item', onClick: () => void onCreate() }
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
            {!isLoading && !error && filteredDocs.length > 0 ? (
              <TableAddRow
                columns={visibleColumns}
                isPending={create.isPending}
                onCreate={(title) => void onCreate(title)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
