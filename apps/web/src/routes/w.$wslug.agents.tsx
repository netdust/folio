import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { WorkspaceAutomationPage, type AutomationTab } from '../components/views/workspace-automation-page.tsx';

// `tab` is SHARED across this layout: it selects the automation PAGE tab
// (agents|triggers|api|activity) AND, when a config slideover is open via ?wdoc=,
// the slideover's own sub-tab (fields|activity|runs). So the schema tolerates
// both vocabularies; each consumer narrows its own (the page via PAGE_TABS, the
// slideover via asWorkspaceDocTab). Without the slideover values here, a deep
// link like ?wdoc=<agent>&tab=runs would have `runs` stripped before the
// slideover could read it (the Activity tab's "open the agent's Runs" link).
const PAGE_TABS = ['agents', 'triggers', 'api', 'activity'] as const;

export const Route = createFileRoute('/w/$wslug/agents')({
  validateSearch: z.object({
    wdoc: z.string().optional(),
    tab: z.enum(['agents', 'triggers', 'api', 'activity', 'fields', 'runs']).optional(),
  }),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { wslug } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  // Narrow to a real PAGE tab; a slideover-only value (fields|runs) → default.
  const active: AutomationTab = (PAGE_TABS as readonly string[]).includes(tab ?? '')
    ? (tab as AutomationTab)
    : 'agents';
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
