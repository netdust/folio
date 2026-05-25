import { z } from 'zod';
import type { EventKind } from './events.ts';

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
];

export interface CronShapeResult {
  ok: boolean;
  reason?: string;
}

const FIELD_RE = /^[0-9*,\-/]+$/;

/** Structural validation only — does NOT verify the cron is meaningful.
 *  Phase 3's scheduler does full evaluation when the trigger fires. */
export function validateCronShape(expr: string): CronShapeResult {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, reason: `cron must have 5 fields (got ${parts.length})` };
  }
  for (const p of parts) {
    if (!FIELD_RE.test(p)) {
      return { ok: false, reason: `cron field "${p}" contains invalid characters` };
    }
  }
  return { ok: true };
}

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
