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
        {(() => {
          const cells: React.ReactNode[] = [];
          const titleCell = (
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
          );
          cells.push(titleCell);
          // Fill the remaining columns with empty placeholders so the grid
          // keeps a consistent shape. Slice off the title column we already
          // rendered, then handle the 1fr spacer + last column the same way
          // TableRow does.
          const rest = columns.slice(1);
          if (rest.length === 0) return cells;
          for (let i = 0; i < rest.length - 1; i++) {
            const col = rest[i];
            if (!col) continue;
            cells.push(<div key={`spacer-${col.key}`} aria-hidden />);
          }
          // 1fr spacer matches gridTemplate()'s injected fr slot.
          cells.push(<div key="fr-spacer" aria-hidden />);
          const last = rest[rest.length - 1];
          if (last) cells.push(<div key={`last-${last.key}`} aria-hidden />);
          return cells;
        })()}
      </div>
    </div>
  );
}
