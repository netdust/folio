import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { WorkspacePicker } from '../components/workspace-picker.tsx';
import { WorkspaceCreate } from '../components/onboarding/workspace-create.tsx';

export const Route = createFileRoute('/')({
  component: IndexPage,
});

function IndexPage() {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <WorkspacePicker onCreate={() => setCreating(true)} />
      <WorkspaceCreate open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
