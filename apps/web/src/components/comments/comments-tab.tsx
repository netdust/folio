import { useState } from 'react';
import type { Member } from '../../lib/api/members.ts';
import {
  useComments,
  useCreateComment,
  useUpdateComment,
  useDeleteComment,
  type CommentVisibility,
} from '../../lib/api/comments.ts';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog.tsx';
import { CommentComposer } from './comment-composer.tsx';
import { CommentRow } from './comment-row.tsx';
import { ApprovalButtons } from './approval-buttons.tsx';

// ---------------------------------------------------------------------------
// SSE subscription is INTENTIONALLY DEFERRED.
// When SSE ships, mount an EventSource here that subscribes to:
//   /api/v1/w/:wslug/p/:pslug/documents/:parentSlug/events?types=comment_created,comment_updated,comment_deleted
// and invalidates commentsKeys.list on receipt.
// See future task: "SSE consumer for CommentsTab".
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommentsTabProps {
  workspaceSlug: string;
  workspaceId: string;        // for the localStorage key on the visibility toggle
  projectSlug: string;
  projectId: string;          // passed to the composer
  parentSlug: string;
  parentId: string;
  currentUserId: string | null;
  currentAgentSlug?: string | null;
  workspaceMembers: Member[];
  onCollapse?: () => void;
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

const LS_KEY = (workspaceId: string) =>
  `folio:comments-show-internal:${workspaceId}`;

function readShowInternal(workspaceId: string): boolean {
  try {
    return localStorage.getItem(LS_KEY(workspaceId)) === 'true';
  } catch {
    return false;
  }
}

function writeShowInternal(workspaceId: string, value: boolean) {
  try {
    if (value) {
      localStorage.setItem(LS_KEY(workspaceId), 'true');
    } else {
      localStorage.removeItem(LS_KEY(workspaceId));
    }
  } catch {
    // localStorage unavailable — swallow
  }
}

// ---------------------------------------------------------------------------
// InlineEditRow — plain textarea for editing a comment body in-place.
// Spec explicitly says: do NOT use a second Milkdown instance here.
// ---------------------------------------------------------------------------

interface InlineEditRowProps {
  initialBody: string;
  onSave: (body: string) => void;
  onCancel: () => void;
  saving?: boolean;
}

function InlineEditRow({ initialBody, onSave, onCancel, saving }: InlineEditRowProps) {
  const [body, setBody] = useState(initialBody);
  return (
    <div className="flex flex-col gap-2 py-2 px-3">
      <textarea
        data-testid="inline-edit-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        className="w-full resize-y rounded-md border border-border-light bg-transparent px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-3 focus:outline-none focus:ring-1 focus:ring-primary"
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          data-testid="inline-edit-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => onSave(body)}
          disabled={!body.trim() || saving}
          loading={saving}
          data-testid="inline-edit-save"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeleteConfirmDialog
// ---------------------------------------------------------------------------

interface DeleteConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  deleting?: boolean;
}

function DeleteConfirmDialog({ open, onConfirm, onCancel, deleting }: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent>
        <DialogTitle>Delete comment</DialogTitle>
        <DialogDescription>
          This comment will be soft-deleted and replaced with a deletion notice. This cannot be undone.
        </DialogDescription>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={deleting}
            data-testid="delete-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={onConfirm}
            loading={deleting}
            data-testid="delete-confirm-btn"
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CommentsTab
// ---------------------------------------------------------------------------

export function CommentsTab({
  workspaceSlug,
  workspaceId,
  projectSlug,
  projectId,
  parentSlug,
  parentId,
  currentUserId,
  currentAgentSlug,
  workspaceMembers,
  onCollapse,
}: CommentsTabProps) {
  // ---------- Visibility toggle ----------------------------------------
  const [showInternal, setShowInternal] = useState<boolean>(() =>
    readShowInternal(workspaceId),
  );

  const visibility: CommentVisibility[] = showInternal
    ? ['normal', 'internal']
    : ['normal'];

  function toggleShowInternal() {
    const next = !showInternal;
    setShowInternal(next);
    writeShowInternal(workspaceId, next);
  }

  // ---------- Comments query -------------------------------------------
  const { data: comments = [], refetch } = useComments(
    workspaceSlug,
    projectSlug,
    parentSlug,
    { visibility },
  );

  // Newest-first sort (server may return any order).
  const sorted = [...comments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // ---------- Mutations -------------------------------------------------
  const createComment = useCreateComment(workspaceSlug, projectSlug, parentSlug);
  const updateComment = useUpdateComment(workspaceSlug, projectSlug);
  const deleteComment = useDeleteComment(workspaceSlug, projectSlug);

  // ---------- Inline edit state ----------------------------------------
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  function handleEdit(slug: string) {
    setEditingSlug(slug);
  }

  async function handleSaveEdit(slug: string, body: string) {
    setSavingEdit(true);
    try {
      await new Promise<void>((resolve, reject) => {
        updateComment.mutate(
          { slug, body },
          { onSettled: (_data, err) => (err ? reject(err) : resolve()) },
        );
      });
    } catch {
      // Mutation hook surfaces error via toast (optimistic rollback handles cache).
    } finally {
      setSavingEdit(false);
      setEditingSlug(null);
    }
  }

  function handleCancelEdit() {
    setEditingSlug(null);
  }

  // ---------- Delete confirm state ------------------------------------
  const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function handleDeleteRequest(slug: string) {
    setDeleteSlug(slug);
  }

  async function handleDeleteConfirm() {
    if (!deleteSlug) return;
    setDeleting(true);
    const slug = deleteSlug;
    try {
      await new Promise<void>((resolve, reject) => {
        deleteComment.mutate(
          { slug },
          { onSettled: (_data, err) => (err ? reject(err) : resolve()) },
        );
      });
    } catch {
      // Error handled by mutation (optimistic rollback).
    } finally {
      setDeleting(false);
      setDeleteSlug(null);
    }
  }

  function handleDeleteCancel() {
    setDeleteSlug(null);
  }

  // ---------- Composer submit -----------------------------------------
  async function handleCompose(body: string) {
    await new Promise<void>((resolve, reject) => {
      createComment.mutate(
        { body },
        { onSettled: (_data, err) => (err ? reject(err) : resolve()) },
      );
    });
  }

  // ---------- Load more (v1: inert — cursor pagination in Phase 7) ----
  // TODO: replace with cursor-based pagination when the server exposes a
  //       cursor/total_count in the list response. For now, show the button
  //       when we hit the default page size cap (50) but the button just
  //       re-fetches the same 50 rows.
  const showLoadMore = comments.length >= 50;

  // ---------- Render ---------------------------------------------------
  return (
    <div className="flex flex-col gap-3 py-3">
      {/* Composer at top */}
      <div className="px-3">
        <CommentComposer
          workspaceSlug={workspaceSlug}
          projectSlug={projectSlug}
          parentId={parentId}
          projectId={projectId}
          onSubmit={handleCompose}
          onCollapse={onCollapse}
        />
      </div>

      {/* Visibility toggle */}
      <div className="px-3 flex items-center">
        <button
          type="button"
          role="button"
          aria-pressed={showInternal}
          onClick={toggleShowInternal}
          className="text-xs text-fg-3 hover:text-fg transition-colors rounded px-2 py-1 hover:bg-card"
        >
          Show internal
        </button>
      </div>

      {/* Count row */}
      <div className="px-3 text-xs text-fg-3 select-none">
        💬 {comments.length} comments · newest first
      </div>

      {/* Comment list */}
      <div className="flex flex-col">
        {sorted.map((comment) => {
          const isEditing = editingSlug === comment.slug;

          return (
            <div key={comment.slug}>
              {isEditing ? (
                <InlineEditRow
                  initialBody={comment.body}
                  onSave={(body) => void handleSaveEdit(comment.slug, body)}
                  onCancel={handleCancelEdit}
                  saving={savingEdit}
                />
              ) : (
                <CommentRow
                  comment={comment}
                  currentUserId={currentUserId}
                  currentAgentSlug={currentAgentSlug}
                  workspaceMembers={workspaceMembers}
                  onEdit={handleEdit}
                  onDelete={handleDeleteRequest}
                />
              )}

              {/* ApprovalButtons — only for kind=plan rows (when not in edit mode) */}
              {!isEditing && comment.frontmatter.kind === 'plan' && (
                <div className="px-3 pb-1">
                  <ApprovalButtons
                    planComment={comment}
                    threadComments={comments}
                    workspaceSlug={workspaceSlug}
                    projectSlug={projectSlug}
                    parentSlug={parentSlug}
                    workspaceMembers={workspaceMembers}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Load more — v1 stub (inert until cursor pagination ships in Phase 7) */}
      {showLoadMore && (
        <div className="px-3 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refetch()}
          >
            Load more
          </Button>
        </div>
      )}

      {/* Delete confirm dialog */}
      <DeleteConfirmDialog
        open={deleteSlug !== null}
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={handleDeleteCancel}
        deleting={deleting}
      />
    </div>
  );
}
