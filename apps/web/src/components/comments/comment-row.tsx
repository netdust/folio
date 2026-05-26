import { useState } from 'react';
import type { Comment, ResolvedMention } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';
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
  onEdit?: (slug: string) => void;
  onDelete?: (slug: string) => void;
}

// ---------------------------------------------------------------------------
// Body rendering — plaintext with inline @mention + [[wiki-link]] chips
// ---------------------------------------------------------------------------

type BodyRun =
  | { type: 'text'; content: string }
  | { type: 'mention'; slug: string; stale: boolean }
  | { type: 'wiki'; slug: string };

function parseBody(body: string, mentions: ResolvedMention[]): BodyRun[] {
  // Build a lookup: target → resolved
  const staleSet = new Set(
    mentions.filter((m) => !m.resolved).map((m) => m.target),
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
}: {
  author: string;
  members: Member[];
}) {
  if (author.startsWith('agent:')) {
    const slug = author.slice('agent:'.length);
    return (
      <span className="font-medium text-sm text-fg">
        <span aria-hidden="true">🤖</span> {slug}
      </span>
    );
  }
  if (author.startsWith('user:')) {
    const id = author.slice('user:'.length);
    const member = members.find((m) => m.id === id);
    const display = member ? member.name : author;
    return (
      <span className="font-medium text-sm text-fg">
        <span aria-hidden="true">👤</span>{' '}
        <span className={member ? undefined : 'text-fg-3'}>{display}</span>
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
  currentAgentSlug?: string | null,
): boolean {
  const { author } = comment.frontmatter;
  if (author.startsWith('user:') && currentUserId) {
    return author === `user:${currentUserId}`;
  }
  if (author.startsWith('agent:') && currentAgentSlug) {
    return author === `agent:${currentAgentSlug}`;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CommentRow
// ---------------------------------------------------------------------------

export function CommentRow({
  comment,
  currentUserId,
  currentAgentSlug,
  workspaceMembers,
  onEdit,
  onDelete,
}: CommentRowProps) {
  const { frontmatter: fm, body, slug, createdAt } = comment;
  const [copyError, setCopyError] = useState<string | null>(null);

  // ---- Soft-deleted row --------------------------------------------------
  if (fm.deleted_at) {
    const authorLabel = fm.author.startsWith('agent:')
      ? `🤖 ${fm.author.slice('agent:'.length)}`
      : `@${fm.author.slice('user:'.length)}`;
    return (
      <div className="py-2 px-3 text-xs text-fg-3">
        Comment by {authorLabel} · deleted · {relativeTime(fm.deleted_at)}
      </div>
    );
  }

  const isAuthor = resolveIsAuthor(comment, currentUserId, currentAgentSlug);
  const isAgent = fm.author.startsWith('agent:');
  const showRunId = isAgent && !!fm.run_id;

  async function handleCopyMd() {
    try {
      await navigator.clipboard.writeText(commentToMarkdown(comment));
    } catch {
      setCopyError('Clipboard unavailable');
    }
  }

  return (
    <div className="group relative py-2.5 px-3 rounded-md hover:bg-card transition-colors duration-fast">
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <AuthorDisplay author={fm.author} members={workspaceMembers} />

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

          {/* Error kind: disabled Retry (Phase 3) */}
          {fm.kind === 'error' && (
            <button
              type="button"
              disabled
              title="Phase 3 wires this to the agent runner"
              className="rounded px-1.5 py-0.5 text-xs text-fg-3 opacity-40 cursor-not-allowed"
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
