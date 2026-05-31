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
