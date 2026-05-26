import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

interface Project {
  id: string;
  name: string;
}

interface Props {
  value: string[];
  projects: Project[];
  onChange: (next: string[]) => void;
}

/**
 * Phase 2.5: project allow-list editor for agent frontmatter.
 *
 * Behavior:
 * - ["*"] = wildcard, rendered as "All projects" chip; Select-all checkbox on.
 * - Explicit ids = one chip per project; per-project checkbox state.
 * - [] = "No projects" chip; useful explicit state but also the natural floor
 *   when Select-all is unchecked from a wildcard.
 *
 * Wildcard collapse semantics: toggling an individual project OFF while in
 * wildcard state replaces the value with the explicit list minus that project
 * in a single transition — never producing the invalid ["*", "p-a"] state that
 * the server's Zod refinement would reject.
 */
export function ProjectsField({ value, projects, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const isWildcard = value.includes('*');
  const selected = new Set(value);

  function toggleSelectAll(checked: boolean) {
    onChange(checked ? ['*'] : []);
  }

  function toggleProject(id: string, checked: boolean) {
    if (isWildcard) {
      if (checked) return; // already implicitly included
      onChange(projects.filter((p) => p.id !== id).map((p) => p.id));
      return;
    }
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(projects.filter((p) => next.has(p.id)).map((p) => p.id));
  }

  const trigger = (() => {
    if (isWildcard) return [<Chip key="all" label="All projects" muted />];
    if (value.length === 0) return [<Chip key="empty" label="No projects" muted />];
    return value.map((id) => {
      const proj = projects.find((p) => p.id === id);
      return (
        <Chip
          key={id}
          label={proj?.name ?? `${id.slice(0, 6)}·removed`}
          muted={!proj}
        />
      );
    });
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex flex-wrap gap-1.5 rounded-md px-1 py-0.5 hover:bg-card"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-1" align="start">
        <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-card cursor-pointer">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={isWildcard}
            onChange={(e) => toggleSelectAll(e.target.checked)}
          />
          <span className="font-medium">Select all</span>
        </label>
        <div className="my-1 border-t border-border-light" />
        {projects.map((p) => (
          <label
            key={p.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-card cursor-pointer"
          >
            <input
              type="checkbox"
              aria-label={p.name}
              checked={isWildcard || selected.has(p.id)}
              onChange={(e) => toggleProject(p.id, e.target.checked)}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Chip({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <span
      className={
        'rounded-full px-2 py-0.5 text-[11px] ' +
        (muted ? 'bg-card text-fg-3' : 'bg-primary/10 text-primary')
      }
    >
      {label}
    </span>
  );
}
