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
 * Agent Cockpit Panel: the agent list + "New agent" button. Extracted from the
 * retiring workspace-agents-page. Lean for the narrow (~360px) panel — title +
 * slug only (no project chips, no project filter). Row click and create both
 * set `?wdoc=<slug>` on the CURRENT route via `to: '.'` so the config slideover
 * (mounted at the layout level) opens regardless of which route we're on. The
 * param is `wdoc` (NOT `doc`) so it never collides with the project
 * DocumentSlideover's `?doc=` when both mount under the same layout.
 */
export function AgentList({ wslug }: Props) {
  const navigate = useNavigate();
  const agentsQ = useWorkspaceAgents(wslug);
  const create = useCreateWorkspaceDocument(wslug);
  const agents = agentsQ.data ?? [];

  const openAgent = (slug: string) =>
    void navigate({
      to: '.',
      search: (prev) => ({ ...(prev as Record<string, unknown>), wdoc: slug }),
    });

  // Minimal-viable agent: required Zod fields filled with placeholders. User
  // refines them in the slideover that opens via ?wdoc=.
  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({
        type: 'agent',
        title: 'Untitled',
        // The body IS the prompt — seed a starter so the editor isn't blank and
        // the empty-prompt guard (server) doesn't block the first run.
        body: '# Prompt\n\nDescribe this agent: its role, and what it should do on every run.',
        frontmatter: {
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
          tools: [],
        },
      });
      openAgent(created.slug);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const createButton = (
    <Button
      variant="primary"
      onClick={onCreate}
      disabled={create.isPending}
      className="whitespace-nowrap"
    >
      <Icon
        icon={create.isPending ? Loader2 : Plus}
        size={14}
        className={create.isPending ? 'animate-spin' : ''}
      />
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
        {agents.map((agent) => (
          <li key={agent.id} className="px-3 py-2.5">
            <button
              type="button"
              onClick={() => openAgent(agent.slug)}
              className="w-full min-w-0 text-left"
            >
              <div className="text-sm font-medium">{agent.title}</div>
              <div className="mt-0.5 font-mono text-[10px] text-fg-3">/{agent.slug}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
