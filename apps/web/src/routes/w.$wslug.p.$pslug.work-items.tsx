import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ListView } from '../components/views/list-view.tsx';

const search = z.object({ doc: z.string().optional() });

export const Route = createFileRoute('/w/$wslug/p/$pslug/work-items')({
  validateSearch: search,
  component: WorkItemsRoute,
});

function WorkItemsRoute() {
  const { wslug, pslug } = Route.useParams();
  return <ListView wslug={wslug} pslug={pslug} />;
}
