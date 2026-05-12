import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  useDocuments,
  useUpdateDocument,
  parseFilters,
  clausesToListParams,
  applyFrontmatterClauses,
  type DocumentPatch,
  type FilterClauseUrl,
} from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useFields } from '../../lib/api/fields.ts';
import { FilterBar } from '../filter/filter-bar.tsx';
import { EmptyState } from './empty-state.tsx';
import { ListRow } from './list-row.tsx';

interface Props {
  wslug: string;
  pslug: string;
}

export function ListView({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const clauses = useMemo(() => parseFilters(search), [search]);
  const listParams = useMemo(() => clausesToListParams(clauses), [clauses]);
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
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
      <FilterBar
        clauses={clauses}
        statuses={statuses ?? []}
        pinnedFields={fields ?? []}
        onChange={onClauseChange}
      />
      {isLoading ? <div className="p-4 text-fg-3">Loading…</div> : null}
      {error ? <div className="p-4 text-danger">Failed to load documents.</div> : null}
      {!isLoading && !error && filteredDocs.length === 0 ? (
        <EmptyState
          title={clauses.length > 0 ? 'No matching documents' : 'No work items'}
          description={
            clauses.length > 0
              ? 'Try removing a filter chip above.'
              : 'Use Cmd-K → New work item to create one.'
          }
        />
      ) : null}
      <div role="list" className="flex flex-col">
        {filteredDocs.map((doc) => (
          <ListRow
            key={doc.id}
            doc={doc}
            statuses={statuses ?? []}
            onOpen={openDoc}
            onUpdate={onUpdate}
            pendingSlugs={pendingSlugs}
          />
        ))}
      </div>
    </>
  );
}
