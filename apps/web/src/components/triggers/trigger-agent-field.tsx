import { useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { useWorkspaceAgents } from '../../lib/api/workspace-documents.ts';

interface Props {
  wslug: string;
  value: string;
  onChange: (next: string) => void;
}

/**
 * Agent picker for a trigger's `agent` frontmatter field. Unlike the
 * AssigneePicker, this offers agents only (no members), commits the BARE slug
 * (triggers reference agents by slug, not the `agent:` assignee prefix), and is
 * workspace-scoped with NO project filter — a trigger isn't project-scoped. The
 * current value may also be a `$event.<key>` placeholder, which we display
 * verbatim.
 */
export function TriggerAgentField({ wslug, value, onChange }: Props) {
  // No project filter: a trigger is workspace-level.
  const agents = useWorkspaceAgents(wslug);
  const agentList = agents.data ?? [];

  const label = useMemo(() => {
    if (!value) return 'Pick an agent';
    const found = agentList.find((a) => a.slug === value);
    // Falls back to the raw value so a `$event.<key>` placeholder still shows.
    return found?.title ?? value;
  }, [value, agentList]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-md border border-border-light bg-content px-2 text-sm text-fg hover:bg-card"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px]" align="start">
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-fg-3 hover:bg-card hover:text-fg"
          >
            Clear agent
          </button>
        ) : null}

        <div className="mt-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">
            Agents
          </div>
          {agentList.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-3">No agents yet</div>
          ) : (
            agentList.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onChange(a.slug)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-card"
              >
                <div className="font-medium">{a.title}</div>
                <div className="text-[10px] font-mono text-fg-3">{a.slug}</div>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
