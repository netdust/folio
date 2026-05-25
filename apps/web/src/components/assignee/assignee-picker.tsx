import { useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { useMembers } from '../../lib/api/members.ts';
import { useDocuments } from '../../lib/api/documents.ts';

interface Props {
  wslug: string;
  pslug: string;
  value: string;
  onChange: (next: string) => void;
}

export function AssigneePicker({ wslug, pslug, value, onChange }: Props) {
  const members = useMembers(wslug);
  const agents = useDocuments(wslug, pslug, { type: 'agent' });

  const memberList = members.data ?? [];
  const agentList = agents.data?.data ?? [];

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
            Clear assignee
          </button>
        ) : null}

        <div className="mt-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">
            Members
          </div>
          {memberList.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-3">No members</div>
          ) : (
            memberList.map((m) => (
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
