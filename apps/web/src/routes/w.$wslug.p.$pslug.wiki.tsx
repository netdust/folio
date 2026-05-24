import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { WikiTree } from '../components/views/wiki-tree.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug/wiki')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: WikiRoute,
});

function WikiRoute() {
  const { wslug, pslug } = Route.useParams();
  return <WikiTree wslug={wslug} pslug={pslug} />;
}
