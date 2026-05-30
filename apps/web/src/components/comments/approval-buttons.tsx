import { useState } from 'react';
import type { Comment } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';
import { useCreateComment } from '../../lib/api/comments.ts';
import { type AgentRef, authorAgentSlug, authorDisplayName } from '../../lib/author-ref.ts';
import { useRun } from '../../lib/api/runs.ts';
import { RunStatusChip } from '../runs/run-status-chip.tsx';
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
  /**
   * Agent refs (id + slug) needed to resolve id-canonical comment authors to
   * the slug stored in `target_agent` and to render human-readable labels.
   * Without this we can't distinguish `agent:<id>` from `agent:<slug>` rows
   * (G1 / F11 follow-up).
   */
  workspaceAgents: AgentRef[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  agents: AgentRef[],
  members: Member[],
): Resolution | null {
  const planTime = new Date(planComment.createdAt).getTime();

  const matches = threadComments.filter((c) => {
    const fm = c.frontmatter;
    if (fm.kind !== 'approval' && fm.kind !== 'rejection') return false;
    // H11: comment-schema declares target_agent as `z.string()` (no shape
    // refinement), so REST/MCP clients can post EITHER `<slug>` or `<id>`.
    // findResolution's agentSlug is always slug-form (resolved from the
    // plan's author through the workspaceAgents list). Resolve target_agent
    // through the same helper so id-form and slug-form both match.
    const targetAgent =
      typeof fm.target_agent === 'string' ? fm.target_agent : null;
    if (!targetAgent) return false;
    const targetAsSlug =
      agents.find((a) => a.id === targetAgent || a.slug === targetAgent)?.slug ??
      targetAgent;
    if (targetAsSlug !== agentSlug) return false;
    // F9: soft-deleted approvals/rejections do not resolve the plan. The
    // server keeps the row visible in listComments by design (UI mutes it);
    // resolution detection must explicitly skip them, otherwise a retracted
    // approval locks the plan into "Approved by …" forever.
    if (fm.deleted_at != null && fm.deleted_at !== '') return false;
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
    authorLabel: authorDisplayName(fm.author, agents, members),
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
  workspaceAgents,
}: ApprovalButtonsProps) {
  // useRun MUST be called before any early return (rules of hooks). It's
  // enabled only when run_id is present, so a comment without run_id never
  // fetches — preserving the exact legacy behavior for unlinked comments.
  const runId = planComment.frontmatter.run_id;
  const { data: run } = useRun(workspaceSlug, runId);

  // Guard: only render on kind=plan comments
  if (planComment.frontmatter.kind !== 'plan') return null;

  // Guard: only render for agent-authored plans. G1: server stores author as
  // `agent:<id>` (post-F11) but mention-parser writes target_agent=<slug>;
  // the helper resolves both shapes back to a slug for the comparison below.
  const agentSlug = authorAgentSlug(planComment.frontmatter.author, workspaceAgents);
  if (!agentSlug) return null;

  const resolution = findResolution(
    planComment,
    threadComments,
    agentSlug,
    workspaceAgents,
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

  // --- E-6: live run state ---
  // When the comment is linked to a run, reflect the run's LIVE state.
  // Interactive buttons ONLY while the run still awaits approval; once it has
  // moved on (running/completed/failed/rejected), show a muted status line
  // instead of stale buttons. A found `resolution` above (an explicit human
  // approval/rejection comment) still takes priority — the recorded human
  // decision is the strongest signal. When there is no run_id (legacy
  // comments) `run` is undefined and we fall through unchanged.
  if (runId && run && run.status !== 'awaiting_approval') {
    return (
      <p className="text-xs text-fg-3 mt-1 flex items-center gap-1.5">
        <RunStatusChip status={run.status ?? 'unknown'} />
        <span>run {run.status}</span>
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
