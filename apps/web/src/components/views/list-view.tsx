import { useNavigate, useSearch } from '@tanstack/react-router';
import { useDocuments } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { EmptyState } from './empty-state.tsx';
import { ListRow } from './list-row.tsx';

interface Props {
  wslug: string;
  pslug: string;
}

export function ListView({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  // The doc search param is read from the current route; child routes pass
  // it via URL. Keep this hook free of the route type by reading the raw search.
  const search = useSearch({ strict: false }) as { doc?: string };
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, {
    type: 'work_item',
    sort: 'updated_at',
    dir: 'desc',
  });
  const { data: statuses } = useStatuses(wslug, pslug);

  const openDoc = (slug: string) => {
    void navigate({
      to: '.',
      search: { ...search, doc: slug },
      replace: false,
    });
  };

  if (isLoading) return <div className="p-4 text-fg-3">Loading…</div>;
  if (error) return <div className="p-4 text-danger">Failed to load documents.</div>;
  if (!page || page.data.length === 0) {
    return (
      <EmptyState
        title="No work items"
        description="Create one with the New work item button (Cmd-K → New work item, available after Task 28)."
      />
    );
  }

  return (
    <div role="list" className="flex flex-col">
      {page.data.map((doc) => (
        <div role="listitem" key={doc.id}>
          <ListRow doc={doc} statuses={statuses ?? []} onOpen={openDoc} />
        </div>
      ))}
    </div>
  );
}
