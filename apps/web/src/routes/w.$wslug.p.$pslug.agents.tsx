import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DocumentTypeList } from '../components/views/document-type-list.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug/agents')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { wslug, pslug } = Route.useParams();
  return <DocumentTypeList wslug={wslug} pslug={pslug} type="agent" title="Agents" />;
}
