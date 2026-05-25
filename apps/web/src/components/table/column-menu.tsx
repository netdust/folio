import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';

interface Props {
  columnKey: string;
  columnLabel: string;
  onRename: () => void;
  onChangeType: () => void;
  onHide: () => void;
  onDelete: () => Promise<void>;
  affectedDocCount?: number;
}

export function ColumnMenu({
  columnKey,
  columnLabel,
  onRename,
  onChangeType,
  onHide,
  onDelete,
  affectedDocCount,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirmDelete() {
    setDeleting(true);
    try {
      await onDelete();
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <IconButton label="Column actions" size="sm">
            <Icon icon={MoreHorizontal} size={14} />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[180px] p-1">
          <div role="menu">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
              onClick={() => {
                setMenuOpen(false);
                onRename();
              }}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
              onClick={() => {
                setMenuOpen(false);
                onChangeType();
              }}
            >
              Change type
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
              onClick={() => {
                setMenuOpen(false);
                onHide();
              }}
            >
              Hide column
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm text-danger hover:bg-card"
              onClick={() => {
                setMenuOpen(false);
                setConfirmOpen(true);
              }}
            >
              Delete column
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!deleting) setConfirmOpen(o);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete column &ldquo;{columnLabel}&rdquo;?</DialogTitle>
          <DialogDescription>
            The pinned field <code>{columnKey}</code> will be removed from this table.
            {typeof affectedDocCount === 'number' && affectedDocCount > 0
              ? ` At least ${affectedDocCount} document${affectedDocCount === 1 ? '' : 's'} on this page ${affectedDocCount === 1 ? 'has' : 'have'} a value for this key — the values remain in raw frontmatter but lose their column.`
              : ''}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleConfirmDelete()}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
