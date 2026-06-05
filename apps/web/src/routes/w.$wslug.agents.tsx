import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceAutomationPage, type AutomationTab } from '../components/views/workspace-automation-page.tsx';

export const Route = createFileRoute('/w/$wslug/agents')({
  validateSearch: z.object({
    wdoc: z.string().optional(),
    tab: z.enum(['agents', 'triggers', 'api']).optional(),
  }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { wslug } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const active: AutomationTab = tab ?? 'agents';
  return (
    <WorkspaceAutomationPage
      wslug={wslug}
      tab={active}
      onTabChange={(next) =>
        void navigate({
          to: '/w/$wslug/agents',
          params: { wslug },
          search: (prev) => ({ ...(prev as Record<string, unknown>), tab: next }),
        })
      }
    />
  );
}
