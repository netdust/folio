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
  | 'document_ref'
  | 'currency'
  | 'relation';

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
export { rankBetween } from './board-rank.ts';
export { ErrorCode, type ErrorCode as ErrorCodeType } from './error-codes.ts';
export * from './document-schema.ts';
export { V1_MCP_TOOLS, MCP_TOOL_GROUPS, type McpTool } from './mcp-tools.ts';
export { inferFieldType, type InferContext } from './field-infer.ts';
export {
  filterCompile,
  FilterCompileError,
  type FilterAST,
  type FilterInput,
  type Operator,
} from './filter-compile.ts';
export { nextFires, validateCronShape, type CronShapeResult } from './cron.ts';
export { type EventKind, KNOWN_EVENT_KINDS } from './events.ts';
export {
  AUTHOR_KINDS,
  AUTHOR_REF_RE,
  type AuthorKind,
  type AgentRef,
  type MemberRef,
  parseAuthorRef,
  authorDisplayName,
  authorAgentSlug,
  authorMatchesCurrent,
  authorString,
  stripAuthorPrefix,
} from './author-ref.ts';
