import { useEffect, useRef, useState } from 'react';
import { cn } from '../ui/cn.ts';
import { EditableShell, SHELL_INPUT } from './editable-shell.tsx';

interface Props {
  value: string;
  onCommit: (next: string) => void;
  isPending?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
  defaultEditing?: boolean;
}

export function InlineEdit({
  value,
  onCommit,
  isPending = false,
  placeholder,
  className,
  inputClassName,
  ariaLabel,
  defaultEditing = false,
}: Props) {
  const [editing, setEditing] = useState(defaultEditing);
  // When defaultEditing is true, treat the initial value as a placeholder to
  // overwrite (e.g. "Untitled" from a freshly created doc), so typing replaces
  // it rather than appending — independent of input.select() timing.
  const [draft, setDraft] = useState(defaultEditing ? '' : value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    // Don't commit an empty draft over a non-empty value — happens when
    // defaultEditing pre-fills the draft empty and the user blurs without
    // typing. Revert silently instead.
    if (draft === '' && value !== '') {
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  const revert = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    // The shell owns box metrics + the focus-ring/bg treatment; the input
    // keeps ONLY the fill-the-box + transparent classes so it inherits the
    // shell's identical font/padding (no layout shift entering edit, Bug 2).
    return (
      <EditableShell mode="edit" isPending={isPending} className={cn('w-full', className)}>
        <input
          ref={inputRef}
          type="text"
          aria-label={ariaLabel}
          className={cn(SHELL_INPUT, inputClassName)}
          value={draft}
          placeholder={value || placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              revert();
            }
          }}
          onBlur={commit}
        />
      </EditableShell>
    );
  }

  // The shell carries the box metrics + the hover-bg affordance (the test at
  // inline-edit.test.tsx asserts the text-bearing element has hover:bg-card —
  // the shell IS that element). The a11y/enter-edit handlers wrap the shell so
  // a click/Enter anywhere in the box opens edit mode; behavior is unchanged.
  //
  // LAYOUT (Bug-2 follow-up): the caller's `className` (e.g. the title cell's
  // `block w-full truncate`) controls how the editable element fills + clips
  // inside the caller's flex parent (`min-w-0 flex-1`). It must reach the
  // text-bearing box — the SHELL — or `truncate` has no width to clip against
  // and long titles overflow the column. The wrapper only fills its parent so
  // the shell's `w-full` resolves to the real column width; the shell carries
  // the caller's layout (`w-full truncate`) on the box that actually holds the
  // text. The shell must be `block` for `truncate`'s ellipsis to apply.
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className="block min-w-0 cursor-text focus:outline-none"
    >
      <EditableShell mode="display" isPending={isPending} className={cn('w-full', className)}>
        {value || <span className="text-fg-3">{placeholder ?? '…'}</span>}
      </EditableShell>
    </span>
  );
}
