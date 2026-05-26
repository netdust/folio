import { useNavigate } from '@tanstack/react-router';
import { useWorkspaceAgents, useWorkspaceTriggers } from '../../lib/api/workspace-documents.ts';

interface Props {
  wslug: string;
}

/**
 * Phase 2.5: workspace-level trigger listing. Each row shows the trigger's
 * title, the referenced agent slug, and the schedule (cron) or event name.
 * Triggers inherit their project allow-list from the referenced agent, so we
 * don't render project chips on triggers themselves.
 */
export function WorkspaceTriggersPage({ wslug }: Props) {
  const navigate = useNavigate();
  const triggersQ = useWorkspaceTriggers(wslug);
  // Loaded so we can show the agent's title alongside the agent slug. Cheap
  // because the agents query is cached at the picker level too.
  const agentsQ = useWorkspaceAgents(wslug);
  const agentBySlug = new Map((agentsQ.data ?? []).map((a) => [a.slug, a]));

  if (triggersQ.isLoading) {
    return <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-fg-2">Loading…</div>;
  }
  const triggers = triggersQ.data ?? [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-medium tracking-tight">Triggers</h1>
        <p className="mt-0.5 text-xs text-fg-2">
          Cron- and event-driven triggers that fire workspace agents.
        </p>
      </header>

      {triggers.length === 0 ? (
        <div className="rounded-md border border-border-light bg-shell p-6 text-center text-sm text-fg-2">
          No triggers yet.
        </div>
      ) : (
        <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
          {triggers.map((trigger) => {
            const fm = trigger.frontmatter as {
              agent?: string;
              schedule?: string | null;
              on_event?: string | null;
            };
            const agentSlug = fm.agent ?? '';
            const agent = agentBySlug.get(agentSlug);
            const trail =
              fm.schedule != null
                ? `cron: ${fm.schedule}`
                : fm.on_event != null
                  ? `on: ${fm.on_event}`
                  : '(no schedule / event)';
            return (
              <li key={trigger.id}>
                <button
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: '/w/$wslug/triggers',
                      params: { wslug },
                      search: (prev) => ({ ...(prev as Record<string, unknown>), doc: trigger.slug }),
                    })
                  }
                  className="block w-full px-3 py-2.5 text-left hover:bg-card"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium">{trigger.title}</div>
                    <div className="font-mono text-[10px] text-fg-3">{trail}</div>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-fg-3">
                    /{trigger.slug} · agent:{agentSlug}
                    {agent ? ` (${agent.title})` : ' (missing)'}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
