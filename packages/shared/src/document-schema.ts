import { z } from 'zod';

export const documentTypeEnum = z.enum(['work_item', 'page', 'agent', 'trigger']);

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
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
export type DocumentPatchInput = z.infer<typeof documentPatchSchema>;
