import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { WorkspaceCreate } from '../components/onboarding/workspace-create.tsx';
import { WorkspacePicker } from '../components/workspace-picker.tsx';

export const Route = createFileRoute('/')({
  component: IndexPage,
});

function IndexPage() {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <WorkspacePicker onCreate={() => setCreating(true)} />
      <WorkspaceCreate open={creating} onOpenChange={setCreating} />
    </>
  );
}
