import { createFileRoute } from '@tanstack/react-router';
import { TableView } from '../components/table/table-view.tsx';
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';
import { tableSearchSchema } from '../lib/table-search.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug/work-items')({
  validateSearch: tableSearchSchema,
  component: WorkItemsRoute,
});

function WorkItemsRoute() {
  const { wslug, pslug } = Route.useParams();
  return <TableView wslug={wslug} pslug={pslug} tslug={DEFAULT_TABLE_SLUG} />;
}
