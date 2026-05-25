import { useInstance } from '@milkdown/react';
import { callCommand } from '@milkdown/utils';
import {
  turnIntoTextCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
} from '@milkdown/preset-commonmark';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { useState } from 'react';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Pilcrow,
  Quote,
  Code2,
  Table as TableIcon,
} from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { cn } from '../ui/cn.ts';

/**
 * Formatting toolbar for the body editor. Renders inside MilkdownProvider so
 * `useInstance` resolves the editor instance.
 *
 * Why not toggle commands here? Milkdown's commonmark preset only ships
 * `wrapIn…` variants; toggling back to a paragraph is `turnIntoTextCommand`
 * (paragraph). The text-style popover offers both directions explicitly
 * (Paragraph + H1/H2/H3) so the user never wonders why a second click on H1
 * doesn't undo it.
 */
export function BodyToolbar() {
  const [loading, getInstance] = useInstance();
  // Generic over the command's payload type so TS picks the correct
  // `callCommand(slice: CmdKey<T>, payload?: T)` overload. Each $Command's
  // `.key` is a CmdKey<T>; pass it through, not its string form.
  const call = <T,>(cmd: { key: { __cmdSlice?: unknown } & object }, payload?: T) => {
    if (loading) return;
    const editor = getInstance();
    if (!editor) return;
    // `cmd.key` is a CmdKey<T>; the callCommand overload accepts it directly.
    editor.action(callCommand(cmd.key as never, payload as never));
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-1 border-b border-border-light px-1 py-1">
      <TextStylePopover
        onParagraph={() => call(turnIntoTextCommand)}
        onHeading={(level) => call(wrapInHeadingCommand, level)}
      />
      <Divider />
      <ToolbarButton label="Bullet list" onClick={() => call(wrapInBulletListCommand)}>
        <Icon icon={List} size={16} />
      </ToolbarButton>
      <ToolbarButton label="Numbered list" onClick={() => call(wrapInOrderedListCommand)}>
        <Icon icon={ListOrdered} size={16} />
      </ToolbarButton>
      <Divider />
      <ToolbarButton label="Quote" onClick={() => call(wrapInBlockquoteCommand)}>
        <Icon icon={Quote} size={16} />
      </ToolbarButton>
      <ToolbarButton label="Code block" onClick={() => call(createCodeBlockCommand)}>
        <Icon icon={Code2} size={16} />
      </ToolbarButton>
      <ToolbarButton label="Insert table" onClick={() => call(insertTableCommand, { row: 3, col: 3 })}>
        <Icon icon={TableIcon} size={16} />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded text-fg-2 hover:bg-card hover:text-fg"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div aria-hidden className="mx-0.5 h-4 w-px bg-border-light" />;
}

function TextStylePopover({
  onParagraph,
  onHeading,
}: {
  onParagraph: () => void;
  onHeading: (level: 1 | 2 | 3) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Text style"
          title="Text style"
          className="inline-flex h-7 items-center gap-1 rounded px-1.5 font-medium text-fg-2 hover:bg-card hover:text-fg"
        >
          <span className="text-sm">Aa</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="min-w-[160px] py-1">
        <div role="menu" className="flex flex-col">
          <TextStyleItem onSelect={() => { setOpen(false); onParagraph(); }} icon={Pilcrow}>
            Paragraph
          </TextStyleItem>
          <TextStyleItem onSelect={() => { setOpen(false); onHeading(1); }} icon={Heading1}>
            Heading 1
          </TextStyleItem>
          <TextStyleItem onSelect={() => { setOpen(false); onHeading(2); }} icon={Heading2}>
            Heading 2
          </TextStyleItem>
          <TextStyleItem onSelect={() => { setOpen(false); onHeading(3); }} icon={Heading3}>
            Heading 3
          </TextStyleItem>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TextStyleItem({
  onSelect,
  icon,
  children,
}: {
  onSelect: () => void;
  icon: typeof Heading1;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-2 transition-colors duration-fast hover:bg-card hover:text-fg',
      )}
    >
      <Icon icon={icon} size={14} />
      {children}
    </button>
  );
}
