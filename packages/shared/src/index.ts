/**
 * Shared types and utilities used by both server and web.
 */

export type DocumentType = 'work_item' | 'page';
export type ViewType = 'list' | 'kanban';
export type AiProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';
export type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'multi_select'
  | 'user_ref'
  | 'boolean'
  | 'url';

/**
 * Type inference for frontmatter values. Used by the UI when no per-project
 * field config exists yet. Per-project config (the `fields` table) overrides
 * this.
 */
export function inferFieldType(value: unknown): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'multi_select';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    if (/^https?:\/\//.test(value)) return 'url';
    return 'text';
  }
  return 'text';
}

export interface DocumentSummary {
  id: string;
  projectId: string;
  type: DocumentType;
  slug: string;
  title: string;
  status: string | null;
  frontmatter: Record<string, unknown>;
  updatedAt: number;
}
