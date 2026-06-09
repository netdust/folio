import { createFileRoute } from '@tanstack/react-router';
import { TableView } from '../components/table/table-view.tsx';
import { tableSearchSchema } from '../lib/table-search.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug')({
  validateSearch: tableSearchSchema,
  component: TableRoute,
});

function TableRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <TableView wslug={wslug} pslug={pslug} tslug={tslug} />;
}
