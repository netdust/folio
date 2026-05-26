import { useState } from 'react';
import type { Comment } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';
import { useCreateComment } from '../../lib/api/comments.ts';
import { Button } from '../ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ApprovalButtonsProps {
  planComment: Comment;
  threadComments: Comment[];
  workspaceSlug: string;
  projectSlug: string;
  parentSlug: string;
  workspaceMembers: Member[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the agent slug from a comment author string like "agent:drafter".
 * Returns null if the author is not an agent.
 */
function agentSlugFromAuthor(author: string): string | null {
  if (author.startsWith('agent:')) {
    return author.slice('agent:'.length);
  }
  return null;
}

/**
 * Resolve an author string to a display label.
 * "user:<id>" → member.name (or fallback to the raw string).
 * "agent:<slug>" → "agent:<slug>".
 */
function resolveAuthorLabel(author: string, members: Member[]): string {
  if (author.startsWith('user:')) {
    const id = author.slice('user:'.length);
    const member = members.find((m) => m.id === id);
    return member ? member.name : author;
  }
  if (author.startsWith('agent:')) {
    return author; // keep full "agent:<slug>" as display
  }
  return author;
}

/**
 * Compute a human-readable duration between two ISO timestamps, e.g.
 * "3 minutes later", "2 hours later", "1 day later".
 */
function formatDurationBetween(fromIso: string, toIso: string): string {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return '';
  const diffSeconds = Math.round(Math.abs(to - from) / 1000);
  if (diffSeconds < 60) {
    return diffSeconds === 1 ? '1 second later' : `${diffSeconds} seconds later`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? '1 minute later' : `${diffMinutes} minutes later`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? '1 hour later' : `${diffHours} hours later`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? '1 day later' : `${diffDays} days later`;
}

// ---------------------------------------------------------------------------
// Resolution detection
// ---------------------------------------------------------------------------

interface Resolution {
  kind: 'approval' | 'rejection';
  authorLabel: string;
  duration: string;
}

function findResolution(
  planComment: Comment,
  threadComments: Comment[],
  agentSlug: string,
  members: Member[],
): Resolution | null {
  const planTime = new Date(planComment.createdAt).getTime();

  const matches = threadComments.filter((c) => {
    const fm = c.frontmatter;
    if (fm.kind !== 'approval' && fm.kind !== 'rejection') return false;
    if (fm.target_agent !== agentSlug) return false;
    const cTime = new Date(c.createdAt).getTime();
    if (Number.isNaN(cTime) || cTime < planTime) return false;
    return true;
  });

  if (matches.length === 0) return null;

  // Pick the earliest
  matches.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const earliest = matches[0] as Comment;
  const fm = earliest.frontmatter;

  return {
    kind: fm.kind as 'approval' | 'rejection',
    authorLabel: resolveAuthorLabel(fm.author, members),
    duration: formatDurationBetween(planComment.createdAt, earliest.createdAt),
  };
}

// ---------------------------------------------------------------------------
// RejectPopover
// ---------------------------------------------------------------------------

interface RejectPopoverProps {
  agentSlug: string;
  workspaceSlug: string;
  projectSlug: string;
  parentSlug: string;
  onDone: () => void;
}

function RejectPopover({
  agentSlug,
  workspaceSlug,
  projectSlug,
  parentSlug,
  onDone,
}: RejectPopoverProps) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const { mutate: createComment, isPending } = useCreateComment(
    workspaceSlug,
    projectSlug,
    parentSlug,
  );

  function handleReject() {
    const body = reason.trim()
      ? `Rejected @${agentSlug}: ${reason.trim()}`
      : `Rejected @${agentSlug}`;
    createComment(
      { body, kind: 'rejection', target_agent: agentSlug },
      {
        onSettled: () => {
          setOpen(false);
          setReason('');
          onDone();
        },
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          ✕ Reject
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" side="bottom" align="start">
        <div className="flex flex-col gap-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional reason"
            rows={3}
            className="w-full resize-none rounded-md border border-border-light bg-transparent px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-3 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setReason('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={isPending}
              onClick={handleReject}
            >
              Reject
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// ApproveRejectButtons — inner component that owns the approve mutation hook
// ---------------------------------------------------------------------------

interface ApproveRejectButtonsProps {
  agentSlug: string;
  workspaceSlug: string;
  projectSlug: string;
  parentSlug: string;
}

function ApproveRejectButtons({
  agentSlug,
  workspaceSlug,
  projectSlug,
  parentSlug,
}: ApproveRejectButtonsProps) {
  const { mutate: createComment, isPending } = useCreateComment(
    workspaceSlug,
    projectSlug,
    parentSlug,
  );

  function handleApprove() {
    createComment({
      body: `Approved @${agentSlug}`,
      kind: 'approval',
      target_agent: agentSlug,
    });
  }

  return (
    <div className="flex items-center gap-2 mt-1">
      <Button
        variant="secondary"
        size="sm"
        loading={isPending}
        onClick={handleApprove}
      >
        ✓ Approve
      </Button>
      <RejectPopover
        agentSlug={agentSlug}
        workspaceSlug={workspaceSlug}
        projectSlug={projectSlug}
        parentSlug={parentSlug}
        onDone={() => {}}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApprovalButtons — outer component that guards + routes to inner components
// ---------------------------------------------------------------------------

export function ApprovalButtons({
  planComment,
  threadComments,
  workspaceSlug,
  projectSlug,
  parentSlug,
  workspaceMembers,
}: ApprovalButtonsProps) {
  // Guard: only render on kind=plan comments
  if (planComment.frontmatter.kind !== 'plan') return null;

  // Guard: only render for agent-authored plans
  const agentSlug = agentSlugFromAuthor(planComment.frontmatter.author);
  if (!agentSlug) return null;

  const resolution = findResolution(
    planComment,
    threadComments,
    agentSlug,
    workspaceMembers,
  );

  // --- Resolved state ---
  if (resolution) {
    const verb = resolution.kind === 'approval' ? 'Approved' : 'Rejected';
    return (
      <p className="text-xs text-fg-3 mt-1">
        {verb} by {resolution.authorLabel}
        {resolution.duration ? ` · ${resolution.duration}` : ''}
      </p>
    );
  }

  // --- Unresolved state: show buttons ---
  return (
    <ApproveRejectButtons
      agentSlug={agentSlug}
      workspaceSlug={workspaceSlug}
      projectSlug={projectSlug}
      parentSlug={parentSlug}
    />
  );
}
