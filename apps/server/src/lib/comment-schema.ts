import { z } from 'zod';

export const commentKindSchema = z.enum([
  'comment',
  'plan',
  'result',
  'error',
  'approval',
  'rejection',
  'reply',
]);
export type CommentKind = z.infer<typeof commentKindSchema>;

export const commentVisibilitySchema = z.enum(['normal', 'internal']);
export type CommentVisibility = z.infer<typeof commentVisibilitySchema>;

export const resolvedMentionSchema = z.object({
  target: z.string().regex(/^(user|agent):.+$/),
  resolved: z.boolean(),
  resolvedId: z.string().optional(),
  resolvedType: z.enum(['agent', 'user']).optional(),
});
export type ResolvedMention = z.infer<typeof resolvedMentionSchema>;

/**
 * Storage shape for comment frontmatter. The schema declares ALL persisted
 * fields including server-managed ones (`mentions`, `edited_at`, `deleted_at`).
 * Route handlers must whitelist client-writable input separately (see services/routes
 * in later Phase 2.6 tasks).
 */
export const commentFrontmatterSchema = z
  .object({
    author: z.string().regex(/^(user|agent):.+$/),
    kind: commentKindSchema.default('comment'),
    visibility: commentVisibilitySchema.default('normal'),
    mentions: z.array(resolvedMentionSchema).default([]),
    edited_at: z.string().datetime().optional(),
    target_agent: z.string().optional(),
    run_id: z.string().uuid().optional(),
    deleted_at: z.string().datetime().optional(),
  })
  .strict()
  .refine((d) => !(d.kind === 'approval' || d.kind === 'rejection') || !!d.target_agent, {
    message: 'target_agent is required when kind is approval or rejection',
  })
  .refine((d) => !d.target_agent || d.kind === 'approval' || d.kind === 'rejection', {
    message: 'target_agent is only valid when kind is approval or rejection',
  });
export type CommentFrontmatter = z.infer<typeof commentFrontmatterSchema>;
