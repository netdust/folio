import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TableView } from '../components/table/table-view.tsx';

const stringOrArray = z.union([z.string(), z.array(z.string())]).optional();

// Schema copied verbatim from w.$wslug.p.$pslug.work-items.tsx (the tested
// default-table route) so the non-default /t/:tslug grid carries identical
// view/filter/sort search state. Kept inline (not imported) per the plan.
const search = z.object({
  doc: z.string().optional(),
  view: z.string().min(1).optional(),
  status: stringOrArray,
  priority: z.string().optional(),
  labels: stringOrArray,
  assignee: z.string().optional(),
  updated_since: z.string().optional(),
  // Widened from a fixed enum so views can persist sort by any column key,
  // including custom frontmatter field keys. The TableHeader is the source of
  // truth for which keys are actually sortable; the URL just carries intent.
  sort: z.string().min(1).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug')({
  validateSearch: search,
  component: TableRoute,
});

function TableRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <TableView wslug={wslug} pslug={pslug} tslug={tslug} />;
}
