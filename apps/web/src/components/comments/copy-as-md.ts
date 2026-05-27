import { type AgentRef, type MemberRef, authorDisplayName, parseAuthorRef } from '@folio/shared';
import type { Comment } from '../../lib/api/comments.ts';

/**
 * Returns the canonical MD representation of a comment: YAML frontmatter + body.
 *
 * B1: emits an `author_display` line alongside `author` whenever the canonical
 * form (`user:<id>` / `agent:<id>`) resolves to a known member or agent. The
 * machine-readable id stays the source of truth (re-import is round-trippable
 * via `author`); the display key is purely a readability courtesy so an
 * exported file isn't a wall of opaque IDs. Wedge: "Markdown is the
 * source-of-truth surface" — that surface has to be human-readable, not just
 * machine-parseable.
 */
export function commentToMarkdown(
  comment: Comment,
  agents: readonly AgentRef[] = [],
  members: readonly MemberRef[] = [],
): string {
  const fm = comment.frontmatter;
  const lines = ['---'];
  lines.push(`author: ${fm.author}`);

  // Only emit author_display when (a) the author is in canonical form
  // (`kind:id`) and (b) the id resolves to a known agent/member. Skipping
  // the line for unresolved ids keeps round-trip byte-stable for legacy
  // rows (pre-0008 `agent:<slug>`) and for authors of deleted/since-removed
  // identities — there's no useful display name to add in those cases.
  const ref = parseAuthorRef(fm.author);
  if (ref) {
    const resolved = authorDisplayName(fm.author, agents, members);
    if (resolved !== ref.value) {
      lines.push(`author_display: ${resolved}`);
    }
  }

  lines.push(`kind: ${fm.kind}`);
  if (fm.visibility !== 'normal') lines.push(`visibility: ${fm.visibility}`);
  if (fm.edited_at) lines.push(`edited_at: ${fm.edited_at}`);
  if (fm.target_agent) lines.push(`target_agent: ${fm.target_agent}`);
  if (fm.run_id) lines.push(`run_id: ${fm.run_id}`);
  if (fm.deleted_at) lines.push(`deleted_at: ${fm.deleted_at}`);
  lines.push(`created_at: ${comment.createdAt}`);
  lines.push('---');
  lines.push('');
  lines.push(comment.body);
  return lines.join('\n');
}
