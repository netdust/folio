import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Icon } from '../ui/icon.tsx';
import type { Field } from '../../lib/api/fields.ts';
import type { BoardSort } from '../../lib/board-controls-bus.ts';

// Canonical home is board-controls-bus; re-export so existing importers
// (kanban-view) keep working without churn.
export type { BoardSort };

interface Props {
  groupBy: string; // 'status' or field key
  sort: BoardSort | null; // null = manual
  fields: Field[];
  onGroupByChange: (groupBy: string) => void;
  onSortChange: (sort: BoardSort | null) => void;
}

// Built-in sort keys, mirrored from the server's sort whitelist. Group-by only
// supports status + fields (built-in columns aren't groupable), so these are
// sort-only.
const BUILTIN_SORTS: { key: string; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'updated_at', label: 'Updated' },
];

function fieldLabel(f: Field): string {
  return f.label ?? f.key;
}

function sortLabel(sort: BoardSort | null, fields: Field[]): string {
  // A null sort = Manual (hand-ranked board_position order).
  if (!sort) return 'Manual';
  const field = fields.find((f) => f.key === sort.key);
  const builtin = BUILTIN_SORTS.find((b) => b.key === sort.key);
  const label = field ? fieldLabel(field) : builtin?.label ?? sort.key;
  return `${label} ${sort.dir === 'desc' ? '↓' : '↑'}`;
}

function groupLabel(groupBy: string, fields: Field[]): string {
  if (groupBy === 'status') return 'Status';
  const field = fields.find((f) => f.key === groupBy);
  return field ? fieldLabel(field) : groupBy;
}

const triggerClass =
  'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-fg-2 hover:bg-card';
const itemClass =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm text-fg-1 hover:bg-card';

export function BoardToolbar({ groupBy, sort, fields, onGroupByChange, onSortChange }: Props) {
  const [groupOpen, setGroupOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const groupableFields = fields.filter((f) => f.type !== 'multi_select');

  const pickGroupBy = (key: string) => {
    setGroupOpen(false);
    onGroupByChange(key);
  };

  const pickSort = (key: string) => {
    setSortOpen(false);
    // Clicking the already-active field toggles its direction; a fresh field
    // starts at ascending.
    if (sort && sort.key === key) {
      onSortChange({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    onSortChange({ key, dir: 'asc' });
  };

  const pickManual = () => {
    setSortOpen(false);
    // null = manual (board_position) hand-ranked order.
    onSortChange(null);
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      <Popover open={groupOpen} onOpenChange={setGroupOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClass}>
            <span className="text-fg-3">Group:</span>
            <span>{groupLabel(groupBy, fields)}</span>
            <Icon icon={ChevronDown} size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[200px] p-1">
          <button type="button" role="menuitem" className={itemClass} onClick={() => pickGroupBy('status')}>
            Status
          </button>
          {groupableFields.map((f) => (
            <button
              key={f.key}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => pickGroupBy(f.key)}
            >
              {fieldLabel(f)}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover open={sortOpen} onOpenChange={setSortOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClass}>
            <span className="text-fg-3">Sort:</span>
            <span>{sortLabel(sort, fields)}</span>
            <Icon icon={ChevronDown} size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[200px] p-1">
          {/* Manual (drag) sort: a null sort puts the board in hand-ranked
              board_position order, where within-column drag-reorder is enabled. */}
          <button type="button" role="menuitem" className={itemClass} onClick={pickManual}>
            Manual
          </button>
          {BUILTIN_SORTS.map((b) => (
            <button
              key={b.key}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => pickSort(b.key)}
            >
              {b.label}
            </button>
          ))}
          {fields.map((f) => (
            <button
              key={f.key}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => pickSort(f.key)}
            >
              {fieldLabel(f)}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
