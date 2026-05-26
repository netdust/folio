import { useState } from 'react';
import { MCP_TOOL_GROUPS, type McpTool } from '@folio/shared';
import { Chip } from '../ui/chip.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * Multi-select chip editor for agent `frontmatter.tools`. Mirrors the
 * ProjectsField pattern: trigger renders chips, popover opens checkbox groups.
 *
 * The server's Zod (agent-schema.ts) rejects any tool not in V1_MCP_TOOLS.
 * Sourcing the dropdown from the same constant means the UI can't desync
 * from the server's allowed set.
 */
export function ToolsField({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const selected = new Set(value);

  function toggleTool(tool: McpTool, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(tool);
    else next.delete(tool);
    // Preserve the group order from MCP_TOOL_GROUPS so the persisted array
    // round-trips with stable ordering (avoids spurious diffs in MD export).
    const ordered: string[] = [];
    for (const group of MCP_TOOL_GROUPS) {
      for (const t of group.tools) if (next.has(t)) ordered.push(t);
    }
    onChange(ordered);
  }

  const trigger = (() => {
    if (value.length === 0) return [<Chip key="empty" muted mono>No tools</Chip>];
    return value.map((t) => <Chip key={t} mono>{t}</Chip>);
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
      <PopoverContent className="w-[300px] p-1" align="start">
        {MCP_TOOL_GROUPS.map((group, idx) => (
          <div key={group.label}>
            {idx > 0 ? <div className="my-1 border-t border-border-light" /> : null}
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-3">
              {group.label}
            </div>
            {group.tools.map((tool) => (
              <label
                key={tool}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-card cursor-pointer"
              >
                <input
                  type="checkbox"
                  aria-label={tool}
                  checked={selected.has(tool)}
                  onChange={(e) => toggleTool(tool, e.target.checked)}
                />
                <span className="font-mono text-[12px]">{tool}</span>
              </label>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

