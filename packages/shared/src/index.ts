export type DocumentType = 'work_item' | 'page';
export type ViewType = 'list' | 'kanban';
export type AiProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'user_ref'
  | 'url'
  | 'document_ref';

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

export { slugify } from './slug.ts';
export { ErrorCode, type ErrorCode as ErrorCodeType } from './error-codes.ts';
export * from './document-schema.ts';
export { inferFieldType, type InferContext } from './field-infer.ts';
export {
  filterCompile,
  FilterCompileError,
  type FilterAST,
  type FilterInput,
  type Operator,
} from './filter-compile.ts';
