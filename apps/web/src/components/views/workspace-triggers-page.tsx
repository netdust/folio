import { Plus, Loader2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { formatApiError } from '../../lib/api/index.ts';
import {
  useCreateWorkspaceDocument,
  useWorkspaceAgents,
  useWorkspaceTriggers,
} from '../../lib/api/workspace-documents.ts';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';

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
  const create = useCreateWorkspaceDocument(wslug);
  const agentBySlug = new Map((agentsQ.data ?? []).map((a) => [a.slug, a]));

  // Minimal-viable trigger: required Zod fields filled with placeholders.
  // The user picks a real agent + schedule/event in the slideover. Daily 9am
  // is an unambiguous default that satisfies the schema's
  // "at least one of schedule or on_event" refine.
  const onCreate = async () => {
    const firstAgent = agentsQ.data?.[0];
    if (!firstAgent) {
      toast.error('Create an agent first — triggers reference an agent by slug.');
      return;
    }
    try {
      const created = await create.mutateAsync({
        type: 'trigger',
        title: 'Untitled trigger',
        frontmatter: {
          agent: firstAgent.slug,
          schedule: '0 9 * * *',
          on_event: null,
        },
      });
      void navigate({
        to: '/w/$wslug/agents',
        params: { wslug },
        search: (prev) => ({ ...(prev as Record<string, unknown>), wdoc: created.slug }),
      });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  if (triggersQ.isLoading) {
    return <div className="text-sm text-fg-2">Loading…</div>;
  }
  const triggers = triggersQ.data ?? [];

  const createButton = (
    <Button variant="primary" onClick={onCreate} disabled={create.isPending} className="whitespace-nowrap">
      <Icon
        icon={create.isPending ? Loader2 : Plus}
        size={14}
        className={create.isPending ? 'animate-spin' : ''}
      />
      New trigger
    </Button>
  );

  return (
    <div>
      <div className="mb-3 flex justify-end">{createButton}</div>

      {triggers.length === 0 ? (
        <div className="rounded-md border border-border-light bg-shell p-6 text-center text-sm text-fg-2">
          <p>No triggers yet.</p>
          <div className="mt-3 inline-block">{createButton}</div>
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
                      to: '/w/$wslug/agents',
                      params: { wslug },
                      search: (prev) => ({ ...(prev as Record<string, unknown>), wdoc: trigger.slug }),
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
