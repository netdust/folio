import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DocumentTypeList } from '../components/views/document-type-list.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug/triggers')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: TriggersRoute,
});

function TriggersRoute() {
  const { wslug, pslug } = Route.useParams();
  return <DocumentTypeList wslug={wslug} pslug={pslug} type="trigger" title="Triggers" />;
}
