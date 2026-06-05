import { useEffect, useMemo, useState } from 'react';
import { useMembers } from '../../lib/api/members.ts';
import { useWorkspaceAgents } from '../../lib/api/workspace-documents.ts';
import { cn } from '../ui/cn.ts';

interface MentionPickerProps {
  workspaceSlug: string;
  projectId: string;
  query: string;
  onSelect: (target: { type: 'agent' | 'user'; value: string }) => void;
  onClose: () => void;
}

export function MentionPicker({
  workspaceSlug,
  projectId,
  query,
  onSelect,
  onClose,
}: MentionPickerProps) {
  const agentsQ = useWorkspaceAgents(workspaceSlug, { project: projectId, enabled: !!projectId });
  const membersQ = useMembers(workspaceSlug);

  const q = query.trim().toLowerCase();

  const allAgents = agentsQ.data ?? [];
  const allMembers = membersQ.data ?? [];

  const filteredAgents = useMemo(() => {
    if (!q) return allAgents;
    return allAgents.filter(
      (a) => a.slug.toLowerCase().includes(q) || a.title.toLowerCase().includes(q),
    );
  }, [allAgents, q]);

  const filteredMembers = useMemo(() => {
    if (!q) return allMembers;
    return allMembers.filter((m) => {
      const localpart = m.email.split('@')[0]?.toLowerCase() ?? '';
      return localpart.includes(q) || m.name.toLowerCase().includes(q);
    });
  }, [allMembers, q]);

  const total = filteredAgents.length + filteredMembers.length;
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selection when the filtered shape changes (e.g. query changes).
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredAgents.length, filteredMembers.length]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (total > 0 ? (i + 1) % total : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (total > 0 ? (i - 1 + total) % total : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex < filteredAgents.length) {
        const agent = filteredAgents[selectedIndex];
        if (agent) onSelect({ type: 'agent', value: agent.slug });
      } else {
        const member = filteredMembers[selectedIndex - filteredAgents.length];
        if (member) {
          const localpart = member.email.split('@')[0] ?? '';
          onSelect({ type: 'user', value: localpart });
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      role="listbox"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-border-light bg-content shadow-md p-1 w-[260px]"
    >
      {/* AGENTS section */}
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">AGENTS</div>

      {allAgents.length === 0 ? (
        <div className="px-2 py-1 text-xs text-fg-3">No agents yet</div>
      ) : filteredAgents.length === 0 ? (
        <div className="px-2 py-1 text-xs text-fg-3">No matching agents</div>
      ) : (
        filteredAgents.map((a, i) => {
          const isSel = selectedIndex === i;
          return (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={isSel}
              onClick={() => onSelect({ type: 'agent', value: a.slug })}
              className={cn(
                'block w-full rounded-md px-2 py-1.5 text-left text-sm',
                isSel ? 'bg-card' : 'hover:bg-card',
              )}
            >
              <div className="font-medium">
                <span aria-hidden="true">🤖 </span>
                {a.title}
              </div>
              <div className="text-[10px] font-mono text-fg-3">{`agent:${a.slug}`}</div>
            </button>
          );
        })
      )}

      {/* MEMBERS section */}
      <div className="mt-2 border-t border-border-light pt-1">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">MEMBERS</div>

        {allMembers.length === 0 ? (
          <div className="px-2 py-1 text-xs text-fg-3">No members yet</div>
        ) : filteredMembers.length === 0 ? (
          <div className="px-2 py-1 text-xs text-fg-3">No matching members</div>
        ) : (
          filteredMembers.map((m, i) => {
            const globalIdx = filteredAgents.length + i;
            const isSel = selectedIndex === globalIdx;
            const localpart = m.email.split('@')[0] ?? '';
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => onSelect({ type: 'user', value: localpart })}
                className={cn(
                  'block w-full rounded-md px-2 py-1.5 text-left text-sm',
                  isSel ? 'bg-card' : 'hover:bg-card',
                )}
              >
                <div className="font-medium">
                  <span aria-hidden="true">👤 </span>
                  {m.name}
                </div>
                <div className="text-[10px] text-fg-3">{m.email}</div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
