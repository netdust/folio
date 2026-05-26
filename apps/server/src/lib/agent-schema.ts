import { z } from 'zod';

export const V1_MCP_TOOLS = [
  'list_workspaces', 'list_projects', 'list_documents',
  'get_document', 'get_document_markdown',
  'create_document', 'update_document', 'delete_document',
  'list_statuses', 'list_fields', 'list_views',
  'run_view',
] as const;

export type McpTool = (typeof V1_MCP_TOOLS)[number];

export const agentFrontmatterSchema = z.object({
  system_prompt: z.string().min(1),
  model: z.string().min(1),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  tools: z.array(z.enum([...V1_MCP_TOOLS] as [string, ...string[]])),
  // Phase 2.5: project allow-list. `['*']` (default) = all workspace projects.
  // Explicit ids are project uuids (survives rename). Wildcard cannot mix with ids.
  projects: z.array(z.string()).default(['*']).refine(
    (arr) => !(arr.includes('*') && arr.length > 1),
    { message: "'*' cannot be combined with explicit project ids" },
  ),
  max_delegation_depth: z.number().int().min(0).max(5).default(2),
  max_tokens_per_run: z.number().int().min(1).max(100_000).default(10_000),
  requires_approval: z.boolean().default(false),
  // Server-managed fields rejected on client input.
  api_token_id: z.undefined(),
  parent_agent: z.undefined(),
}).strict();

const READ_TOOLS: ReadonlySet<string> = new Set([
  'list_workspaces', 'list_projects', 'list_documents',
  'get_document', 'get_document_markdown',
  'list_statuses', 'list_fields', 'list_views',
  'run_view',
]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['create_document', 'update_document']);
const DELETE_TOOLS: ReadonlySet<string> = new Set(['delete_document']);

/** Translate the agent's tool whitelist into the matching set of token scopes. */
export function toolsToScopes(tools: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const tool of tools) {
    if (READ_TOOLS.has(tool)) scopes.add('documents:read');
    if (WRITE_TOOLS.has(tool)) {
      scopes.add('documents:write');
      scopes.add('documents:read');  // write implies read
    }
    if (DELETE_TOOLS.has(tool)) {
      scopes.add('documents:delete');
      scopes.add('documents:read');
    }
  }
  return Array.from(scopes);
}
