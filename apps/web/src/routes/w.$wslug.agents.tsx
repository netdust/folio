import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceAgentsPage } from '../components/views/workspace-agents-page.tsx';

export const Route = createFileRoute('/w/$wslug/agents')({
  validateSearch: z.object({
    doc: z.string().optional(),
    project: z.string().optional(),
  }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { wslug } = Route.useParams();
  const { project } = Route.useSearch();
  return <WorkspaceAgentsPage wslug={wslug} projectFilter={project} />;
}
