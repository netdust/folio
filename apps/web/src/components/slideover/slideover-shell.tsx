import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Document } from '../../lib/api/documents.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import { ResizeHandle } from '../ui/resize-handle.tsx';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import type { InnerActions } from './use-slideover-lifecycle.ts';

/**
 * The shared Sheet shell for BOTH slideovers. It owns the structurally-identical
 * scaffold the two forks duplicated:
 *  - the <Sheet> + <SheetContent> + <SheetHeader> + loading/error <SheetTitle>
 *  - the keyed inner mount slot (the parent passes the already-keyed inner node)
 *  - the Delete-confirm dialog + the unsaved-changes prompt dialog
 *
 * Everything that diverges is a prop / render-prop:
 *  - `width` + `resizeHandle` (project: fixed 800, none; workspace: resizable)
 *  - `toolbarTestId` (`slideover-toolbar` vs `workspace-slideover-toolbar`)
 *  - `title` (each wrapper's own keyed SlideoverTitleEditor)
 *  - `toolbar` (the divergent action bar — copy-MD/mode/log vs mode-radios menu)
 *  - `inner` (the already-keyed inner component for the loaded doc)
 *
 * The dirty-guard plumbing (close/prompt/proceed/cancel/saving) is passed in
 * from useSlideoverLifecycle so the two prompt dialogs behave identically.
 */
export function SlideoverShell({
  doc,
  isLoading,
  error,
  open,
  width,
  resizeHandle,
  toolbarTestId,
  title,
  toolbar,
  inner,
  close,
  saving,
  prompting,
  proceed,
  cancelPrompt,
  actionsRef,
  confirmDelete,
  setConfirmDelete,
  deletePending,
  onDelete,
}: {
  doc: Document | undefined;
  isLoading: boolean;
  error: unknown;
  open: boolean;
  width: number;
  resizeHandle?: ReactNode;
  toolbarTestId: string;
  title: ReactNode;
  toolbar: ReactNode;
  inner: ReactNode;
  close: () => void;
  saving: boolean;
  prompting: boolean;
  proceed: () => void;
  cancelPrompt: () => void;
  actionsRef: React.MutableRefObject<InnerActions | null>;
  confirmDelete: boolean;
  setConfirmDelete: (open: boolean) => void;
  deletePending: boolean;
  onDelete: () => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <SheetContent width={width} className="h-screen">
        {resizeHandle}
        <SheetHeader>
          <SheetTitle>
            {isLoading ? (
              <Skeleton width={200} height={20} />
            ) : error ? (
              'Failed to load'
            ) : doc ? (
              title
            ) : (
              '—'
            )}
          </SheetTitle>
          <div data-testid={toolbarTestId} className="flex items-center gap-1.5">
            {doc ? toolbar : null}
            <IconButton label="Close document" onClick={close}>
              <Icon icon={X} size={16} />
            </IconButton>
          </div>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">{inner}</div>
      </SheetContent>
      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!deletePending) setConfirmDelete(o);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete this document?</DialogTitle>
          <DialogDescription>
            {doc ? <>Delete &ldquo;{doc.title}&rdquo;? This cannot be undone.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={deletePending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => onDelete()} disabled={deletePending}>
              {deletePending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={prompting}
        onOpenChange={(o) => {
          if (!o) cancelPrompt();
        }}
      >
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {doc ? <>You have unsaved edits to &ldquo;{doc.title}&rdquo;.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                actionsRef.current?.discard();
                proceed();
              }}
            >
              Discard
            </Button>
            <Button variant="secondary" onClick={() => cancelPrompt()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={saving}
              onClick={async () => {
                await actionsRef.current?.save();
                proceed();
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
