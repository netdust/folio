import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceAgentsPage } from '../components/views/workspace-agents-page.tsx';

export const Route = createFileRoute('/w/$wslug/agents')({
  validateSearch: z.object({
    doc: z.string().optional(),
    project: z.string().optional(),
    // Per-document slideover tab (driven by ?doc=).
    tab: z.enum(['fields', 'activity', 'runs']).optional(),
    // Page-level tab: which consolidated agent surface is showing.
    view: z.enum(['agents', 'activity', 'run']).optional(),
  }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { wslug } = Route.useParams();
  const { project, view } = Route.useSearch();
  return <WorkspaceAgentsPage wslug={wslug} projectFilter={project} initialView={view} />;
}
