import { useMemo, useState } from 'react';
import { useMembers } from '../../lib/api/members.ts';
import { useProjects } from '../../lib/api/projects.ts';
import { useWorkspaceAgents } from '../../lib/api/workspace-documents.ts';
import { filterAgents, filterMembers } from '../../lib/assignee-filter.ts';
import { cn } from '../ui/cn.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

interface Props {
  wslug: string;
  pslug: string;
  value: string;
  onChange: (next: string) => void;
}

export function AssigneePicker({ wslug, pslug, value, onChange }: Props) {
  const members = useMembers(wslug);
  // Phase 2.5: agents live at workspace level; the picker filters server-side
  // to those allow-listed for this project. id is resolved from the URL pslug.
  const projectsQ = useProjects(wslug);
  const projectId = projectsQ.data?.find((p) => p.slug === pslug)?.id;
  const agents = useWorkspaceAgents(wslug, { project: projectId, enabled: !!projectId });

  const memberList = members.data ?? [];
  const agentList = agents.data ?? [];

  // Type-to-filter search (additive — public props unchanged). The trigger
  // `label` below intentionally reads the UNFILTERED lists so it resolves the
  // current value regardless of the query.
  const [query, setQuery] = useState('');
  const filteredMembers = filterMembers(memberList, query);
  const filteredAgents = filterAgents(agentList, query);

  const label = useMemo(() => {
    if (!value) return 'Unassigned';
    if (value.startsWith('agent:')) {
      const slug = value.slice('agent:'.length);
      const found = agentList.find((a) => a.slug === slug);
      return found?.title ?? slug;
    }
    const found = memberList.find((m) => m.email === value);
    return found?.name ?? value;
  }, [value, memberList, agentList]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Match the borderless EditableShell field look (text-sm px-1 py-0.5
            rounded-sm, hover-bg lift, no border/fixed-height) so the assignee
            cell sits like every other field. Unassigned reads muted (text-fg-3)
            like other empty field placeholders. */}
        <button
          type="button"
          className={cn(
            'inline-flex items-center rounded-sm px-1 py-0.5 text-sm transition-colors duration-150 ease-out hover:bg-card focus-visible:shadow-none',
            value ? 'text-fg' : 'text-fg-3',
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px]" align="start">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Filter assignees"
          className="mb-1 block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm input-focus"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-fg-3 hover:bg-card hover:text-fg"
          >
            Clear assignee
          </button>
        ) : null}

        <div className="mt-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">Members</div>
          {filteredMembers.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-3">No members</div>
          ) : (
            filteredMembers.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChange(m.email)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-card"
              >
                <div className="font-medium">{m.name}</div>
                <div className="text-[10px] text-fg-3">{m.email}</div>
              </button>
            ))
          )}
        </div>

        <div className="mt-2 border-t border-border-light pt-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">Agents</div>
          {filteredAgents.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-3">No agents yet</div>
          ) : (
            filteredAgents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onChange(`agent:${a.slug}`)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-card"
              >
                <div className="font-medium">{a.title}</div>
                <div className="text-[10px] font-mono text-fg-3">agent:{a.slug}</div>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
