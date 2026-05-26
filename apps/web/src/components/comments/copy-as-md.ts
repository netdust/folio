import type { Comment } from '../../lib/api/comments.ts';

/**
 * Returns the canonical MD representation of a comment: YAML frontmatter + body.
 * Used by the "Copy as MD" affordance on each comment row.
 */
export function commentToMarkdown(comment: Comment): string {
  const fm = comment.frontmatter;
  const lines = ['---'];
  lines.push(`author: ${fm.author}`);
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
