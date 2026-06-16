import { createFileRoute } from '@tanstack/react-router';
import { ViewRouter } from '../components/views/view-router.tsx';
import { tableSearchSchema } from '../lib/table-search.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug')({
  validateSearch: tableSearchSchema,
  component: TableRoute,
});

function TableRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <ViewRouter wslug={wslug} pslug={pslug} tslug={tslug} />;
}
