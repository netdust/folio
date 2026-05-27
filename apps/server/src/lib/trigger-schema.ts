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
  // Phase 2.6 sub-phase D: agent is optional + nullable. Accepts a direct
  // slug ('drafter'), the `agent:<slug>` form, or a `$event.<key>` dynamic
  // placeholder. S19: the previous schema also listed a regex-constrained
  // `$event.<key>` variant FIRST; the second `z.string().min(1)` matched
  // everything the regex matched, so the regex was a dead branch. Slug
  // shape and `$event` validity are checked at dispatch time, not here.
  agent: z.union([
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
