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
    // S10: target_agent stores ONE of three forms — slugs and ids both occur
    // because two writers populate it:
    //   1. mention-parser → bare slug (e.g. `drafter`)
    //   2. client clear-text payload → `agent:<slug>` (e.g. `agent:drafter`)
    //   3. legacy/migrated rows → `agent:<id>` (the F11 canonical form)
    // The web `approval-buttons` and server consumers all resolve through
    // `agents.find((a) => a.id === target || a.slug === target)`, which
    // accepts all three. Constraining to one shape now would break stored
    // frontmatter. We bound the length to prevent obvious abuse (DoS-via-fm
    // bloat) but leave the form loose.
    target_agent: z.string().min(1).max(200).optional(),
    // BUG-013 — immutable handle to the target agent. The slug-form
    // `target_agent` is preserved for human readability + back-compat with
    // existing rows; `target_agent_id` is what every server-side resolver
    // SHOULD prefer (Phase 3 dispatcher, approval-buttons UI). Same kind
    // gating as `target_agent`. Mirrors the F11/S2 immutable-handle pattern
    // already established for `author` and `payload.agent_id`.
    target_agent_id: z.string().min(1).max(200).optional(),
    run_id: z.string().uuid().optional(),
    deleted_at: z.string().datetime().optional(),
  })
  .strict()
  // S11: these two refines are storage-layer defense in depth. The route
  // layer (`services/comments.ts::resolveKindAndTarget`) already throws
  // TYPED HTTP errors (TARGET_AGENT_REQUIRED / TARGET_AGENT_FORBIDDEN)
  // before reaching `commentFrontmatterSchema.parse`. If that path is ever
  // bypassed (direct service call, future MCP shortcut), the schema fires
  // a generic ZodError so a malformed row can't reach the DB. Keep both
  // layers — the typed error is for API consumers, the schema is for
  // anyone bypassing the API surface.
  .refine((d) => !(d.kind === 'approval' || d.kind === 'rejection') || !!d.target_agent, {
    message: 'target_agent is required when kind is approval or rejection',
  })
  .refine((d) => !d.target_agent || d.kind === 'approval' || d.kind === 'rejection', {
    message: 'target_agent is only valid when kind is approval or rejection',
  })
  // BUG-013: target_agent_id follows the same kind-gating as target_agent.
  .refine((d) => !d.target_agent_id || d.kind === 'approval' || d.kind === 'rejection', {
    message: 'target_agent_id is only valid when kind is approval or rejection',
  });
export type CommentFrontmatter = z.infer<typeof commentFrontmatterSchema>;
