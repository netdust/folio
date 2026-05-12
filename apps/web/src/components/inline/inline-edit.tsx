import { useEffect, useRef, useState } from 'react';
import { cn } from '../ui/cn.ts';

interface Props {
  value: string;
  onCommit: (next: string) => void;
  isPending?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
}

export function InlineEdit({
  value,
  onCommit,
  isPending = false,
  placeholder,
  className,
  inputClassName,
  ariaLabel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
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
    if (draft !== value) onCommit(draft);
  };
  const revert = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        aria-label={ariaLabel}
        className={cn(
          'block w-full rounded-sm border border-border-light bg-shell px-1 py-0.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          inputClassName,
        )}
        value={draft}
        placeholder={placeholder}
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
    );
  }

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
      className={cn(
        'inline-block cursor-text rounded-sm px-1 py-0.5 hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        isPending && 'opacity-60',
        className,
      )}
    >
      {value || <span className="text-fg-3">{placeholder ?? '…'}</span>}
    </span>
  );
}
