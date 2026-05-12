import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ProjectPicker } from '../components/project-picker.tsx';
import { ProjectCreate } from '../components/onboarding/project-create.tsx';

export const Route = createFileRoute('/w/$wslug/')({
  component: WorkspaceIndex,
});

function WorkspaceIndex() {
  const { wslug } = Route.useParams();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <ProjectPicker wslug={wslug} onCreate={() => setCreateOpen(true)} />
      <ProjectCreate wslug={wslug} open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
