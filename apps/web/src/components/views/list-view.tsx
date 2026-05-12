import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
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
import { formatApiError } from '../../lib/api/index.ts';
import { Icon } from '../ui/icon.tsx';
import { FilterBar } from '../filter/filter-bar.tsx';
import { EmptyState } from './empty-state.tsx';
import { ListRow } from './list-row.tsx';
import { ListHeader, type SortState } from './list-header.tsx';
import { ListSkeleton } from './list-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
}

export function ListView({ wslug, pslug }: Props) {
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
    if (sort) {
      return { ...base, sort: sort.key, dir: sort.dir };
    }
    return base;     // server default = updated_at desc
  }, [clauses, sort]);
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

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
    // Clear all known filter keys before writing current state (so removing a filter actually removes the param)
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

  const onUpdate = async (vars: { slug: string; patch: Pick<DocumentPatch, 'title' | 'status'> }) => {
    setPendingSlugs((prev) => new Set(prev).add(vars.slug));
    try {
      await update.mutateAsync(vars);
    } finally {
      setPendingSlugs((prev) => {
        const next = new Set(prev);
        next.delete(vars.slug);
        return next;
      });
    }
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
      <ListHeader sort={sort} onSort={onSortChange} />
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
          action={clauses.length === 0 ? { label: 'New work item', onClick: onCreate } : undefined}
        />
      ) : null}
      <div role="list" className="flex flex-col">
        {filteredDocs.map((doc) => (
          <ListRow
            key={doc.id}
            doc={doc}
            statuses={statuses ?? []}
            wslug={wslug}
            pslug={pslug}
            onOpen={openDoc}
            onUpdate={onUpdate}
            pendingSlugs={pendingSlugs}
          />
        ))}
      </div>
    </>
  );
}
