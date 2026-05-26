import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceTriggersPage } from '../components/views/workspace-triggers-page.tsx';

export const Route = createFileRoute('/w/$wslug/triggers')({
  validateSearch: z.object({
    doc: z.string().optional(),
  }),
  component: TriggersRoute,
});

function TriggersRoute() {
  const { wslug } = Route.useParams();
  return <WorkspaceTriggersPage wslug={wslug} />;
}
