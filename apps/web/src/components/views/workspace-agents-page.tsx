import { Plus, Loader2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { formatApiError } from '../../lib/api/index.ts';
import { useProjects } from '../../lib/api/projects.ts';
import {
  useCreateWorkspaceDocument,
  useWorkspaceAgents,
} from '../../lib/api/workspace-documents.ts';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { WorkspaceDocumentSlideover } from '../slideover/workspace-document-slideover.tsx';

interface Props {
  wslug: string;
  /** When set, the list is filtered to agents allow-listed for this project id (URL: ?project=). */
  projectFilter?: string;
}

/**
 * Phase 2.5: workspace-level agent listing. Each row shows the agent's title
 * and chips for the projects it's allow-listed against (id → current slug
 * lookup; orphans render muted).
 */
export function WorkspaceAgentsPage({ wslug, projectFilter }: Props) {
  const navigate = useNavigate();
  const agentsQ = useWorkspaceAgents(wslug, { project: projectFilter });
  const projectsQ = useProjects(wslug);
  const create = useCreateWorkspaceDocument(wslug);
  const projectsById = new Map((projectsQ.data ?? []).map((p) => [p.id, p]));

  // Minimal-viable agent: required Zod fields filled with placeholders. User
  // refines them in the slideover. Defaults projects to ['*'] (Zod default).
  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({
        type: 'agent',
        title: 'Untitled',
        frontmatter: {
          system_prompt: 'Describe what this agent does.',
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
          tools: [],
        },
      });
      void navigate({
        to: '/w/$wslug/agents',
        params: { wslug },
        search: (prev) => ({ ...(prev as Record<string, unknown>), doc: created.slug }),
      });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  if (agentsQ.isLoading) {
    return <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-fg-2">Loading…</div>;
  }
  const agents = agentsQ.data ?? [];
  const filterName = projectFilter ? projectsById.get(projectFilter)?.name ?? projectFilter : null;

  const createButton = (
    <Button variant="primary" onClick={onCreate} disabled={create.isPending} className="whitespace-nowrap">
      <Icon
        icon={create.isPending ? Loader2 : Plus}
        size={14}
        className={create.isPending ? 'animate-spin' : ''}
      />
      New agent
    </Button>
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Agents</h1>
          <p className="mt-0.5 text-xs text-fg-2">
            AI agents in this workspace. Each agent is a markdown document with a project allow-list.
          </p>
        </div>
        {createButton}
      </header>

      {filterName && (
        <div className="mb-3 flex items-center gap-2 text-sm text-fg-2">
          Filtered to <strong className="font-medium text-fg">{filterName}</strong>
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() =>
              void navigate({
                to: '/w/$wslug/agents',
                params: { wslug },
                search: {},
              })
            }
          >
            clear
          </button>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="rounded-md border border-border-light bg-shell p-6 text-center text-sm text-fg-2">
          <p>{filterName ? `No agents allow-listed for ${filterName}.` : 'No agents yet.'}</p>
          {!filterName && (
            <div className="mt-3 inline-block">{createButton}</div>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
          {agents.map((agent) => {
            const projs = ((agent.frontmatter as { projects?: string[] }).projects) ?? ['*'];
            return (
              <li key={agent.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: '/w/$wslug/agents',
                      params: { wslug },
                      search: (prev) => ({ ...(prev as Record<string, unknown>), doc: agent.slug }),
                    })
                  }
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="text-sm font-medium">{agent.title}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-fg-3">/{agent.slug}</div>
                </button>
                <div className="flex flex-wrap gap-1.5">
                  {projs.includes('*') ? (
                    <ProjectChip label="All projects" muted />
                  ) : (
                    projs.map((id) => {
                      const proj = projectsById.get(id);
                      if (!proj) {
                        return <ProjectChip key={id} label={`${id.slice(0, 6)}·removed`} muted />;
                      }
                      return (
                        <ProjectChip
                          key={id}
                          label={proj.name}
                          onClick={() =>
                            void navigate({
                              to: '/w/$wslug/agents',
                              params: { wslug },
                              search: { project: id },
                            })
                          }
                        />
                      );
                    })
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <WorkspaceDocumentSlideover wslug={wslug} />
    </div>
  );
}

function ProjectChip({
  label,
  muted,
  onClick,
}: {
  label: string;
  muted?: boolean;
  onClick?: () => void;
}) {
  const base = 'rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-fast';
  if (!onClick) {
    return (
      <span
        className={`${base} ${muted ? 'border-border-light bg-card text-fg-3' : 'border-primary/30 bg-primary/10 text-primary'}`}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} border-primary/30 bg-primary/10 text-primary hover:bg-primary/20`}
    >
      {label}
    </button>
  );
}
