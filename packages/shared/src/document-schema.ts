import { z } from 'zod';

// R1 fix (post-review-of-review) — kept lockstep with the server's
// DocumentType union (apps/server/src/services/documents.ts:47). C-1
// widened the server union; this shared enum was not updated. A FE
// Zod parse of a server response that includes agent_run rows would
// otherwise strict-fail on type narrowing. The shared schema's
// `documentCreateSchema` continues to reject agent_run at create time
// (route layer additionally rejects, see services/documents.ts:304
// F9 guard); the enum widening here is purely for read-shape parsing.
export const documentTypeEnum = z.enum(['work_item', 'page', 'agent', 'trigger', 'agent_run']);

/**
 * Frontmatter keys the SERVER owns and injects — clients must never echo them
 * back on a PATCH. The agent/trigger frontmatter schemas are `.strict()` and
 * reject these (e.g. `api_token_id: z.undefined()`), and the document service
 * strips the generic-reserved ones on merge anyway. The buffered-save draft
 * (`useDocumentDraft`) strips this set before diffing/sending so round-tripping
 * a doc's own frontmatter doesn't 422.
 *
 * Union of: generic RESERVED_FRONTMATTER_KEYS (services/documents.ts) +
 * agent server-managed (lib/agent-schema.ts) + trigger server-managed
 * (lib/trigger-schema.ts). Keep in sync if those grow.
 */
export const SERVER_MANAGED_FRONTMATTER_KEYS = [
  // Generic reserved (mirror columns / server bookkeeping)
  'type',
  'title',
  'status',
  'last_touched_at',
  // Agent server-managed
  'api_token_id',
  'parent_agent',
  // Trigger server-managed
  'last_fired_at',
  'last_status',
] as const;

export const documentCreateSchema = z.object({
  type: documentTypeEnum,
  title: z.string().min(1).max(500),
  body: z.string().default(''),
  frontmatter: z.record(z.unknown()).default({}),
  parentId: z.string().nullable().optional(),
});

export const documentPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: z.string().nullable().optional(),
  body: z.string().optional(),
  frontmatter: z.record(z.unknown()).optional(),
  parentId: z.string().nullable().optional(),
  // Fractional rank for manual kanban ordering; null = unranked. Set by the
  // board's within-column drag-reorder.
  boardPosition: z.string().nullable().optional(),
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
export type DocumentPatchInput = z.infer<typeof documentPatchSchema>;
