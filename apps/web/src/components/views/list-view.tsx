import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useDocuments, useUpdateDocument } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { EmptyState } from './empty-state.tsx';
import { ListRow } from './list-row.tsx';

interface Props {
  wslug: string;
  pslug: string;
}

export function ListView({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { doc?: string };
  const listParams = useMemo(
    () => ({ type: 'work_item' as const, sort: 'updated_at' as const, dir: 'desc' as const }),
    [],
  );
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const { data: statuses } = useStatuses(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onUpdate = async (vars: { slug: string; patch: { title?: string; status?: string | null } }) => {
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

  if (isLoading) return <div className="p-4 text-fg-3">Loading…</div>;
  if (error) return <div className="p-4 text-danger">Failed to load documents.</div>;
  if (!page || page.data.length === 0) {
    return (
      <EmptyState
        title="No work items"
        description="Use Cmd-K → New work item to create one."
      />
    );
  }

  return (
    <div role="list" className="flex flex-col">
      {page.data.map((doc) => (
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
  );
}
