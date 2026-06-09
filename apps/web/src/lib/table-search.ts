import { z } from 'zod';

/**
 * The shared `validateSearch` schema for a project TABLE-GRID route. Both the
 * default-table route (`work-items.tsx`) and the table-scoped route
 * (`w.$wslug.p.$pslug.t.$tslug.tsx`) import this so the search-param contract
 * can't drift between the two route families (a param added to one but not the
 * other would silently strip on the table-scoped route).
 *
 * Safe to import into a file route: TanStack's codegen anchors on the literal
 * `createFileRoute('<path>')` string only; `validateSearch` may be any value.
 */
const stringOrArray = z.union([z.string(), z.array(z.string())]).optional();

/** The narrow board/view search shape (doc + view), shared by the kanban routes. */
export const viewSearchSchema = z.object({
  doc: z.string().optional(),
  view: z.string().min(1).optional(),
});

/** The full table-grid search shape — extends the view shape with filters + sort. */
export const tableSearchSchema = viewSearchSchema.extend({
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
