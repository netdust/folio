import { z } from 'zod';
import { validateCronShape, type CronShapeResult } from '@folio/shared';
import type { EventKind } from './events.ts';

// Re-export so existing server imports (`from './trigger-schema.ts'`) stay stable.
export { validateCronShape, type CronShapeResult };

/** Source-of-truth list. Keep in sync with EventKind in events.ts. */
export const KNOWN_EVENT_KINDS: readonly EventKind[] = [
  'document.created', 'document.updated', 'document.deleted',
  'status.created',   'status.updated',   'status.deleted',
  'field.created',    'field.updated',    'field.deleted',
  'view.created',     'view.updated',     'view.deleted',
  'table.created',    'table.updated',    'table.deleted',
  'project.created',  'project.updated',  'project.deleted',
  'workspace.created','workspace.updated',
  'activity.logged',
  'agent.created',    'agent.deleted',   'agent.task.assigned',
  'comment.created',  'comment.mentioned', 'comment.deleted',
  'agent.allow_list.reconciled',
];

const cronOrNull = z.union([
  z.string().refine((s) => validateCronShape(s).ok, { message: 'invalid cron expression' }),
  z.null(),
]);

const onEventOrNull = z.union([
  z.enum(KNOWN_EVENT_KINDS as unknown as readonly [string, ...string[]]),
  z.null(),
]);

export const triggerFrontmatterSchema = z.object({
  agent: z.string().min(1),
  schedule: cronOrNull,
  on_event: onEventOrNull,
  event_filter: z.union([z.record(z.unknown()), z.null()]).default(null),
  payload: z.union([z.record(z.unknown()), z.null()]).default(null),
  enabled: z.boolean().default(true),
  // Server-managed fields rejected on client input.
  last_fired_at: z.undefined(),
  last_status: z.undefined(),
}).strict().refine(
  (d) => d.schedule !== null || d.on_event !== null,
  { message: 'trigger must have at least one of schedule or on_event' },
);
