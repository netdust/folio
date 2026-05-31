import { Loader2, Plus } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { formatApiError } from '../../lib/api/index.ts';
import {
  useCreateWorkspaceDocument,
  useWorkspaceAgents,
} from '../../lib/api/workspace-documents.ts';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';

interface Props {
  wslug: string;
}

/**
 * Agents tab of the workspace automation page. Lists workspace agents with
 * provider·model + project-allow-list chips (so workspace-scoping is visible at
 * a glance), plus a "New agent" create. Row click + create both set
 * `?wdoc=<slug>` on the CURRENT route (`to: '.'`) so the layout-mounted config
 * slideover opens. `wdoc` (NOT `doc`) avoids colliding with the project
 * DocumentSlideover's `?doc=`.
 */
export function WorkspaceAgentsTab({ wslug }: Props) {
  const navigate = useNavigate();
  const agentsQ = useWorkspaceAgents(wslug);
  const create = useCreateWorkspaceDocument(wslug);
  const agents = agentsQ.data ?? [];

  const openAgent = (slug: string) =>
    void navigate({
      to: '.',
      search: (prev) => ({ ...(prev as Record<string, unknown>), wdoc: slug }),
    });

  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({
        type: 'agent',
        title: 'Untitled',
        body: '# Prompt\n\nDescribe this agent: its role, and what it should do on every run.',
        frontmatter: { model: 'claude-haiku-4-5', provider: 'anthropic', tools: [] },
      });
      openAgent(created.slug);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const createButton = (
    <Button variant="primary" onClick={onCreate} disabled={create.isPending} className="whitespace-nowrap">
      <Icon icon={create.isPending ? Loader2 : Plus} size={14} className={create.isPending ? 'animate-spin' : ''} />
      New agent
    </Button>
  );

  if (agentsQ.isLoading) {
    return <div className="text-sm text-fg-2">Loading…</div>;
  }
  if (agents.length === 0) {
    return (
      <div className="rounded-md border border-border-light bg-shell p-6 text-center text-sm text-fg-2">
        <p>No agents yet.</p>
        <div className="mt-3 inline-block">{createButton}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">{createButton}</div>
      <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
        {agents.map((agent) => {
          const fm = agent.frontmatter as { provider?: string; model?: string; projects?: string[] };
          const providerModel = [fm.provider, fm.model].filter(Boolean).join('·');
          const projects = Array.isArray(fm.projects) ? fm.projects : ['*'];
          const projectLabel = projects.includes('*')
            ? 'All projects'
            : `${projects.length} project${projects.length === 1 ? '' : 's'}`;
          return (
            <li key={agent.id} className="px-3 py-2.5">
              <button type="button" onClick={() => openAgent(agent.slug)} className="w-full min-w-0 text-left">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">{agent.title}</div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {providerModel ? (
                      <span className="rounded-sm bg-card px-1.5 py-0.5 font-mono text-[10px] text-fg-3">{providerModel}</span>
                    ) : null}
                    <span className="rounded-sm bg-card px-1.5 py-0.5 text-[10px] text-fg-3">{projectLabel}</span>
                  </div>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-fg-3">/{agent.slug}</div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
