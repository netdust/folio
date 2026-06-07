import { useState } from 'react';
import type { Comment, ResolvedMention } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';
import {
  type AgentRef,
  authorDisplayName,
  authorMatchesCurrent,
} from '../../lib/author-ref.ts';
import { relativeTime } from '../../lib/relative-time.ts';
import { Chip } from '../ui/chip.tsx';
import { cn } from '../ui/cn.ts';
import { commentToMarkdown } from './copy-as-md.ts';

// TODO: replace inline mention/wiki-link substitution with a real markdown
// renderer (e.g. marked + rehype-react) in a future ticket. Phase 2.6 scope
// is intentionally plaintext + regex-only for inline elements.

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CommentRowProps {
  comment: Comment;
  currentUserId: string | null;
  currentAgentSlug?: string | null;
  workspaceMembers: Member[];
  /** Optional — when omitted, agent authors render as their raw id (post-F11) */
  workspaceAgents?: AgentRef[];
  onEdit?: (slug: string) => void;
  onDelete?: (slug: string) => void;
  /** Re-run the failed agent run that produced this error comment. Wired by the
   *  parent to useRetryRun; only meaningful on kind=error comments that carry a
   *  run_id. */
  onRetry?: (runId: string) => void;
}

// ---------------------------------------------------------------------------
// Body rendering — plaintext with inline @mention + [[wiki-link]] chips
// ---------------------------------------------------------------------------

type BodyRun =
  | { type: 'text'; content: string }
  | { type: 'mention'; slug: string; stale: boolean }
  | { type: 'wiki'; slug: string };

function parseBody(body: string, mentions: ResolvedMention[]): BodyRun[] {
  // F10 — server stores mentions.target as 'user:<id>' or 'agent:<slug>'
  // (server schema: comment-schema.ts:18, regex /^(user|agent):.+$/). The
  // @-regex below captures the BARE slug into match[2]. Without stripping
  // the prefix here, staleSet.has(match[2]) would always be false and
  // stale mentions would never render with strikethrough.
  const stripPrefix = (target: string): string => {
    const colon = target.indexOf(':');
    return colon === -1 ? target : target.slice(colon + 1);
  };
  const staleSet = new Set(
    mentions.filter((m) => !m.resolved).map((m) => stripPrefix(m.target)),
  );

  const runs: BodyRun[] = [];
  // Match either [[slug]] or @slug (word-char + hyphens)
  const re = /\[\[([^\]]+)\]\]|@([\w-]+)/g;
  let last = 0;

  for (const match of body.matchAll(re)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      runs.push({ type: 'text', content: body.slice(last, idx) });
    }
    if (match[1] !== undefined) {
      // [[wiki-link]]
      runs.push({ type: 'wiki', slug: match[1] });
    } else if (match[2] !== undefined) {
      // @mention
      runs.push({ type: 'mention', slug: match[2], stale: staleSet.has(match[2]) });
    }
    last = idx + match[0].length;
  }
  if (last < body.length) {
    runs.push({ type: 'text', content: body.slice(last) });
  }
  return runs;
}

function BodyRenderer({
  body,
  mentions,
}: {
  body: string;
  mentions: ResolvedMention[];
}) {
  const runs = parseBody(body, mentions);
  return (
    <p className="text-sm text-fg whitespace-pre-wrap break-words">
      {runs.map((run, i) => {
        if (run.type === 'text') {
          return <span key={i}>{run.content}</span>;
        }
        if (run.type === 'mention') {
          return (
            <span
              key={i}
              className={cn(
                'inline-flex items-center rounded-sm px-1 py-0.5 text-[11px] font-mono',
                'bg-primary/10 text-primary',
                run.stale && 'line-through opacity-60',
              )}
            >
              @{run.slug}
            </span>
          );
        }
        // wiki-link — styled chip, non-navigating in Phase 2.6
        return (
          <span
            key={i}
            className="inline-flex items-center rounded-sm px-1 py-0.5 text-[11px] font-mono bg-card border border-border-light text-fg-2 cursor-default"
          >
            {run.slug}
          </span>
        );
      })}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Author display
// ---------------------------------------------------------------------------

function AuthorDisplay({
  author,
  members,
  agents,
}: {
  author: string;
  members: Member[];
  agents: AgentRef[];
}) {
  // G2/H15: route BOTH branches through authorDisplayName so the
  // colon-split rule lives in exactly one place. The helper handles agent
  // (id or legacy slug) and user equally; the only branch-specific work
  // left here is the icon + the "unresolved member" tone (a member
  // lookup miss means we render the raw value, dimmed).
  if (author.startsWith('agent:')) {
    const display = authorDisplayName(author, agents, members);
    return (
      <span className="font-medium text-sm text-fg">
        <span aria-hidden="true">🤖</span> {display}
      </span>
    );
  }
  if (author.startsWith('user:')) {
    const display = authorDisplayName(author, agents, members);
    const id = author.slice('user:'.length);
    const memberFound = members.some((m) => m.id === id);
    return (
      <span className="font-medium text-sm text-fg">
        <span aria-hidden="true">👤</span>{' '}
        <span className={memberFound ? undefined : 'text-fg-3'}>{display}</span>
      </span>
    );
  }
  return <span className="font-medium text-sm text-fg">{author}</span>;
}

// ---------------------------------------------------------------------------
// Kind chip
// ---------------------------------------------------------------------------

function KindChip({ kind }: { kind: Comment['frontmatter']['kind'] }) {
  if (kind === 'comment') return null;
  if (kind === 'error') {
    return (
      // TODO: use tone="danger" variant once Chip design-system pass ships it.
      <Chip className="bg-destructive/10 text-destructive border-destructive/20">
        error
      </Chip>
    );
  }
  return <Chip muted>{kind}</Chip>;
}

// ---------------------------------------------------------------------------
// isAuthor helper
// ---------------------------------------------------------------------------

function resolveIsAuthor(
  comment: Comment,
  currentUserId: string | null,
  currentAgentSlug: string | null | undefined,
  agents: AgentRef[],
): boolean {
  // G3: server canonicalised agent authors to `agent:<id>` (post-F11). To
  // detect "is this me?" we need the current agent's id too — look it up by
  // slug in the workspace agent list. Pre-F11 rows that survived migration
  // 0008 in legacy slug form still match via the helper's id-OR-slug check.
  const currentAgent =
    currentAgentSlug
      ? agents.find((a) => a.slug === currentAgentSlug) ?? null
      : null;
  return authorMatchesCurrent(comment.frontmatter.author, currentUserId, currentAgent);
}

// ---------------------------------------------------------------------------
// CommentRow
// ---------------------------------------------------------------------------

export function CommentRow({
  comment,
  currentUserId,
  currentAgentSlug,
  workspaceMembers,
  workspaceAgents,
  onEdit,
  onDelete,
  onRetry,
}: CommentRowProps) {
  const { frontmatter: fm, body, slug, createdAt } = comment;
  const [copyError, setCopyError] = useState<string | null>(null);
  const agents = workspaceAgents ?? [];

  // ---- Soft-deleted row --------------------------------------------------
  if (fm.deleted_at) {
    // G2: use authorDisplayName so agent authors stored as `agent:<id>`
    // (post-F11) render as their slug, not the raw id.
    const display = authorDisplayName(fm.author, agents, workspaceMembers);
    const authorLabel = fm.author.startsWith('agent:') ? `🤖 ${display}` : `@${display}`;
    return (
      <div className="py-2 px-3 text-xs text-fg-3">
        Comment by {authorLabel} · deleted · {relativeTime(fm.deleted_at)}
      </div>
    );
  }

  const isAuthor = resolveIsAuthor(comment, currentUserId, currentAgentSlug, agents);
  const isAgent = fm.author.startsWith('agent:');
  const showRunId = isAgent && !!fm.run_id;

  async function handleCopyMd() {
    try {
      await navigator.clipboard.writeText(commentToMarkdown(comment, agents, workspaceMembers));
    } catch {
      setCopyError('Clipboard unavailable');
    }
  }

  return (
    <div className="group relative py-2.5 px-3 rounded-md hover:bg-card transition-colors duration-fast">
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <AuthorDisplay author={fm.author} members={workspaceMembers} agents={agents} />

        {/* Timestamp */}
        <time
          dateTime={createdAt}
          title={createdAt}
          className="text-xs text-fg-3 shrink-0"
        >
          {relativeTime(createdAt)}
        </time>

        {/* Kind chip — hidden for 'comment' */}
        <KindChip kind={fm.kind} />

        {/* Run-id badge — agent-written only */}
        {showRunId && (
          <span className="text-[11px] font-mono text-fg-3">
            run-id: {fm.run_id!.slice(0, 8)}
          </span>
        )}

        {/* Edited indicator */}
        {fm.edited_at && (
          <span className="text-[11px] text-fg-3">(edited)</span>
        )}

        {/* Hover-revealed affordances */}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-fast">
          {/* Copy as MD — always available */}
          <button
            type="button"
            aria-label="Copy as MD"
            onClick={handleCopyMd}
            className="rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-border-light hover:text-fg transition-colors"
          >
            Copy as MD
          </button>

          {/* Author-only: Edit */}
          {isAuthor && (
            <button
              type="button"
              aria-label="Edit"
              onClick={() => onEdit?.(slug)}
              className="rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-border-light hover:text-fg transition-colors"
            >
              Edit
            </button>
          )}

          {/* Author-only: Delete */}
          {isAuthor && (
            <button
              type="button"
              aria-label="Delete"
              onClick={() => onDelete?.(slug)}
              className="rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              Delete
            </button>
          )}

          {/* Error kind: Retry the failed run (needs a run_id to target). */}
          {fm.kind === 'error' && fm.run_id && (
            <button
              type="button"
              aria-label="Retry"
              title="Re-run the failed agent run"
              onClick={() => onRetry?.(fm.run_id!)}
              className="rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-border-light hover:text-fg transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <BodyRenderer body={body} mentions={fm.mentions} />

      {/* Copy error toast (best-effort) */}
      {copyError && (
        <p className="mt-1 text-[11px] text-destructive">{copyError}</p>
      )}
    </div>
  );
}
