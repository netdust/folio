import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { gridTemplate, type Column } from './columns.ts';

interface Props {
  columns: Column[];
  isPending: boolean;
  onCreate: (title: string) => void;
}

export function TableAddRow({ columns, isPending, onCreate }: Props) {
  const [editing, setEditing] = useState(false);

  const onCommit = (next: string) => {
    setEditing(false);
    const trimmed = next.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <div
      role="listitem"
      data-testid="table-add-row"
      className="group/row flex min-h-[35px] w-full items-center gap-2 border-b border-border-light py-1 text-fg-3 hover:bg-card hover:text-fg-2"
    >
      <div
        className="grid flex-1 items-center gap-3"
        style={{ gridTemplateColumns: gridTemplate(columns) }}
      >
        <div key="title-add" className="sticky left-0 z-[1] flex items-center border-r border-border-light bg-content pl-[22px] pr-3 group-hover/row:bg-card">
          <div className="flex min-w-0 items-center gap-2">
            <Icon icon={Plus} size={14} />
            {editing ? (
              <InlineEdit
                value=""
                onCommit={onCommit}
                defaultEditing
                isPending={isPending}
                placeholder="New work item…"
                ariaLabel="New work item title"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label="Add work item"
                className="rounded-sm px-1 py-0.5 text-left"
              >
                Add work item
              </button>
            )}
          </div>
        </div>
        {/* One empty placeholder per non-title column keeps the grid shape
            consistent with TableRow / TableHeader so widths align. The
            1fr spacer that used to live before the last column was dropped
            with Bug E's fix. */}
        {columns.slice(1).map((c) => (
          <div key={`placeholder-${c.key}`} aria-hidden />
        ))}
      </div>
    </div>
  );
}
