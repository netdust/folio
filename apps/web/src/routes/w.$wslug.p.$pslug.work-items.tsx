import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TableView } from '../components/table/table-view.tsx';

const stringOrArray = z.union([z.string(), z.array(z.string())]).optional();

const search = z.object({
  doc: z.string().optional(),
  status: stringOrArray,
  priority: z.string().optional(),
  labels: stringOrArray,
  assignee: z.string().optional(),
  updated_since: z.string().optional(),
  sort: z.enum(['updated_at', 'title', 'priority', 'status']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export const Route = createFileRoute('/w/$wslug/p/$pslug/work-items')({
  validateSearch: search,
  component: WorkItemsRoute,
});

function WorkItemsRoute() {
  const { wslug, pslug } = Route.useParams();
  return <TableView wslug={wslug} pslug={pslug} />;
}
