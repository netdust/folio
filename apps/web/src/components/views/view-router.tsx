import type { ViewType } from '@folio/shared';
import type { ReactElement } from 'react';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { TableView } from '../table/table-view.tsx';
import { CalendarView } from './calendar-view.tsx';
import { GroupedListView } from './grouped-list-view.tsx';
import { KanbanView } from './kanban-view.tsx';

interface RendererProps {
  wslug: string;
  pslug: string;
  tslug: string;
}

/**
 * THE single place that maps a view type → its renderer (invariant 18, renderer
 * half). A second `switch (view.type)` that picks a component anywhere else is a
 * bug — add the case HERE. The map is exhaustive over `ViewType`: a missing key
 * is a compile error, which is the convergence-point guarantee.
 *
 * `table` = the existing spreadsheet. `list`/`calendar`/`timeline`/`gallery`
 * start as graceful placeholders and are filled in by later clusters (2b/4/5/6).
 */
const viewRendererFor: Record<ViewType, (p: RendererProps) => ReactElement> = {
  table: (p) => <TableView {...p} />, // the existing spreadsheet
  list: (p) => <GroupedListView {...p} />, // cluster 2b (grouped list)
  kanban: (p) => <KanbanView {...p} />,
  calendar: (p) => <CalendarView {...p} />, // cluster 4
  timeline: (p) => <UnsupportedView type="timeline" {...p} />, // cluster 5
  gallery: (p) => <UnsupportedView type="gallery" {...p} />, // cluster 6
};

export function ViewRouter({ wslug, pslug, tslug }: RendererProps) {
  const { view, isLoading } = useActiveView(wslug, pslug, tslug);
  if (isLoading) return <div className="p-8 text-fg-3">Loading view…</div>;
  // No view yet (table with zero views) → default to the TABLE (spreadsheet)
  // render so the table is never blank; the seed always creates a default
  // `table` view, so this is the mid-migration / brand-new-table edge.
  const type = (view?.type ?? 'table') as ViewType;
  return viewRendererFor[type]({ wslug, pslug, tslug });
}

function UnsupportedView({ type }: RendererProps & { type: string }) {
  return (
    <div data-testid={`unsupported-${type}`} className="p-8 text-fg-3">
      The {type} view is coming soon.
    </div>
  );
}
