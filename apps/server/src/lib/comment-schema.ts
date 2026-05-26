import { z } from 'zod';

export const CommentKindSchema = z.enum([
  'comment',
  'plan',
  'result',
  'error',
  'approval',
  'rejection',
  'reply',
]);
export type CommentKind = z.infer<typeof CommentKindSchema>;

export const CommentVisibilitySchema = z.enum(['normal', 'internal']);
export type CommentVisibility = z.infer<typeof CommentVisibilitySchema>;

export const ResolvedMentionSchema = z.object({
  target: z.string().regex(/^(user|agent):.+$/),
  resolved: z.boolean(),
  resolvedId: z.string().optional(),
  resolvedType: z.enum(['agent', 'user']).optional(),
});
export type ResolvedMention = z.infer<typeof ResolvedMentionSchema>;

export const CommentFrontmatterSchema = z
  .object({
    author: z.string().regex(/^(user|agent):.+$/),
    kind: CommentKindSchema.default('comment'),
    visibility: CommentVisibilitySchema.default('normal'),
    mentions: z.array(ResolvedMentionSchema).default([]),
    edited_at: z.string().datetime().optional(),
    target_agent: z.string().optional(),
    run_id: z.string().uuid().optional(),
    deleted_at: z.string().datetime().optional(),
  })
  .refine((d) => !(d.kind === 'approval' || d.kind === 'rejection') || !!d.target_agent, {
    message: 'target_agent is required when kind is approval or rejection',
  })
  .refine((d) => !d.target_agent || d.kind === 'approval' || d.kind === 'rejection', {
    message: 'target_agent is only valid when kind is approval or rejection',
  });
export type CommentFrontmatter = z.infer<typeof CommentFrontmatterSchema>;
