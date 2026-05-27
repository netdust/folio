import { z } from 'zod';
import { validateCronShape, type CronShapeResult, KNOWN_EVENT_KINDS } from '@folio/shared';

// Re-export so existing server imports (`from './trigger-schema.ts'`) stay stable.
export { validateCronShape, type CronShapeResult, KNOWN_EVENT_KINDS };

const cronOrNull = z.union([
  z.string().refine((s) => validateCronShape(s).ok, { message: 'invalid cron expression' }),
  z.null(),
]);

const onEventOrNull = z.union([
  z.enum(KNOWN_EVENT_KINDS as unknown as readonly [string, ...string[]]),
  z.null(),
]);

export const triggerFrontmatterSchema = z.object({
  // Phase 2.6 sub-phase D: agent is optional + nullable, and can also be a
  // `$event.<key>` dynamic-resolution string. The regex variant lives first
  // for clarity / error messages; the plain-string variant catches direct
  // slugs like 'drafter' or 'agent:drafter' (and intentionally accepts
  // arbitrary non-empty strings — slug shape isn't gated here).
  agent: z.union([
    z.string().min(1).regex(/^\$event\.[a-z_]+$/),
    z.string().min(1),
    z.null(),
  ]).optional(),
  schedule: cronOrNull,
  on_event: onEventOrNull,
  event_filter: z.union([z.record(z.unknown()), z.null()]).default(null),
  payload: z.union([z.record(z.unknown()), z.null()]).default(null),
  enabled: z.boolean().default(true),
  // Phase 2.6 sub-phase D: marks a trigger as auto-seeded. Server-locked
  // (only frontmatter.enabled is mutable; document is non-deletable).
  builtin: z.boolean().default(false),
  // Phase 2.6 sub-phase D: builtin triggers that resume/reject paused agent
  // runs instead of invoking an agent.
  internal_action: z.enum(['resume_run', 'reject_run']).optional(),
  // Server-managed fields rejected on client input.
  last_fired_at: z.undefined(),
  last_status: z.undefined(),
}).strict().refine(
  (d) => d.schedule !== null || d.on_event !== null,
  { message: 'trigger must have at least one of schedule or on_event' },
);
