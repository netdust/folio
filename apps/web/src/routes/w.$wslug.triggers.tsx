import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceTriggersPage } from '../components/views/workspace-triggers-page.tsx';

export const Route = createFileRoute('/w/$wslug/triggers')({
  // Triggers open in the layout-mounted WorkspaceDocumentSlideover, which reads
  // ?wdoc= (distinct from the project DocumentSlideover's ?doc=).
  validateSearch: z.object({
    wdoc: z.string().optional(),
  }),
  component: TriggersRoute,
});

function TriggersRoute() {
  const { wslug } = Route.useParams();
  return <WorkspaceTriggersPage wslug={wslug} />;
}
