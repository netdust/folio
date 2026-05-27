import { useMemo, useState } from 'react';
import type { Member } from '../../lib/api/members.ts';
import {
  useComments,
  useCreateComment,
  useUpdateComment,
  useDeleteComment,
  type CommentVisibility,
} from '../../lib/api/comments.ts';
import { useWorkspaceAgents } from '../../lib/api/workspace-documents.ts';
import type { AgentRef } from '../../lib/author-ref.ts';
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

  // H18: only fetch the workspace agent list when the thread actually has
  // agent-authored content OR a plan that needs the list to resolve its
  // author. Threads with zero agent activity (the common case) skip the
  // extra round trip entirely. The hook still mounts every render — React
  // Query handles the enabled toggle and re-fires when it flips true.
  const needsAgentList = useMemo(
    () => comments.some(
      (c) => c.frontmatter.author.startsWith('agent:') || c.frontmatter.kind === 'plan',
    ),
    [comments],
  );
  const agentsQuery = useWorkspaceAgents(workspaceSlug, { enabled: needsAgentList });
  const workspaceAgents: AgentRef[] = useMemo(
    () => (agentsQuery.data ?? []).map((a) => ({ id: a.id, slug: a.slug })),
    [agentsQuery.data],
  );

  // H19: memoize the newest-first sort so unrelated re-renders (visibility
  // toggle, inline-edit keystrokes, delete-dialog open/close) don't re-clone
  // and re-sort. react-query gives stable refs via structural sharing, so
  // `[comments]` is the right key — the array changes identity only when
  // the comments list actually changes.
  const sorted = useMemo(
    () =>
      [...comments].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [comments],
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
      // BUG-017 — close editor on SUCCESS only. The prior shape closed in
      // `finally`, which on PATCH failure threw away the user's typed
      // correction (optimistic rollback reset the body; editor was gone;
      // toast showed an error with no way to recover the typed text).
      setEditingSlug(null);
    } catch {
      // Mutation hook surfaces error via toast (optimistic rollback handles cache).
      // Keep the editor open + textarea intact so the user can retry.
    } finally {
      setSavingEdit(false);
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
      // BUG-017 — close dialog on SUCCESS only. The prior shape closed in
      // `finally`, which on DELETE failure left the user wondering whether
      // the deletion went through (it didn't — optimistic rollback restored
      // the row). Keep the dialog open so the user can retry or cancel.
      setDeleteSlug(null);
    } catch {
      // Error handled by mutation (optimistic rollback). Keep dialog open.
    } finally {
      setDeleting(false);
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
      {/* Composer at top.
          F15: key={parentId} forces a remount when the parent document
          changes. CommentComposer captures parentId into a useRef-bound
          debounced draft writer that's built once on mount; without the
          key, navigating doc A → doc B without closing the slideover would
          let the closure persist and write doc B's text into doc A's
          localStorage draft key. Remount rebuilds the closure with the
          fresh prop and reloads the correct draft for the new doc. */}
      <div className="px-3">
        <CommentComposer
          key={parentId}
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
                  workspaceAgents={workspaceAgents}
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
                    workspaceAgents={workspaceAgents}
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
