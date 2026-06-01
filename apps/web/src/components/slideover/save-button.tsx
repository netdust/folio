import { Loader2, Save } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';

interface SaveButtonProps {
  /** Buffer differs from the loaded doc. */
  dirty: boolean;
  /** A save PATCH is in flight. */
  saving: boolean;
  onSave: () => void;
}

/**
 * Header save affordance shared by both document slideovers. Clean → disabled +
 * muted; dirty → enabled + accent; saving → spinner. Built on the same token
 * styling as IconButton so it can't regress to the white-on-white pill the old
 * inline trigger Save button had (bg-fg text-bg rendered invisible).
 */
export function SaveButton({ dirty, saving, onSave }: SaveButtonProps) {
  const disabled = !dirty || saving;
  return (
    <button
      type="button"
      aria-label="Save"
      title={dirty ? 'Save changes' : 'No unsaved changes'}
      onClick={onSave}
      disabled={disabled}
      className={
        'grid h-6 w-6 place-items-center rounded transition-colors duration-fast ' +
        (disabled
          ? 'cursor-default text-fg-3'
          : 'text-fg hover:bg-card hover:text-fg')
      }
    >
      <Icon icon={saving ? Loader2 : Save} size={16} className={saving ? 'animate-spin' : ''} />
    </button>
  );
}
