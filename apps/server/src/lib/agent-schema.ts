import { z } from 'zod';
// Single source of truth — both server Zod and the web ToolsField consume this.
import { V1_MCP_TOOLS, type McpTool } from '@folio/shared';
export { V1_MCP_TOOLS, type McpTool };

export const agentFrontmatterSchema = z.object({
  // Legacy: the agent's prompt now lives in its document BODY (snapshotted onto
  // each run at create-time). Kept optional so pre-migration agents still
  // validate; migration 0013 strips it. New agents don't carry it.
  system_prompt: z.string().optional(),
  // Empty string OR null means "no model". The agent form commits `model: ''`
  // when switching to the modelless Claude Code provider; a per-key frontmatter
  // PATCH clears a field by sending '' (form) or null (Folio's null-clears
  // convention). Coerce both '' and null → undefined so the field reads as
  // absent (valid for claude-code; the superRefine below + the post-merge
  // re-check in updateDocument still require a model for API providers). A
  // present non-empty model must be ≥1 char.
  model: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().min(1).optional(),
  ),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama', 'claude-code']),
  tools: z.array(z.enum([...V1_MCP_TOOLS] as [string, ...string[]])),
  // Phase B: frontmatter-declared skills, materialized at load by the runner's
  // loadAgentDefinition (a narrow internal SYSTEM-auth read of the __system Skills
  // project — NOT a tool). Each entry is a slug of a `page` doc in the __system
  // `skills` project. Absent/[] ⇒ no skills. Validated as slugs (the same shape
  // the Skills docs use).
  skills: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
  // Phase 2.5: project allow-list. `['*']` (default) = all workspace projects.
  // Explicit ids are project uuids (survives rename). Wildcard cannot mix with ids.
  projects: z.array(z.string()).default(['*']).refine(
    (arr) => !(arr.includes('*') && arr.length > 1),
    { message: "'*' cannot be combined with explicit project ids" },
  ),
  max_delegation_depth: z.number().int().min(0).max(5).default(2),
  max_tokens_per_run: z.number().int().min(1).max(100_000).default(10_000),
  requires_approval: z.boolean().default(false),
  // Which instance AI key this agent uses, by (provider, label). The `provider`
  // field above selects the provider; this selects the key label (the instance
  // may hold multiple keys per provider). Default 'default'. The reference is a
  // non-secret label — the key MATERIAL is read server-side by the runner only
  // (see runner.ts AI-key resolution; the secret never reaches frontmatter).
  ai_key_label: z.string().min(1).default('default'),
  // Server-managed fields rejected on client input.
  api_token_id: z.undefined(),
  parent_agent: z.undefined(),
}).strict().superRefine((fm, ctx) => {
  if (fm.provider !== 'claude-code' && !fm.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'model is required for API providers' });
  }
});

const READ_TOOLS: ReadonlySet<string> = new Set([
  'list_workspaces', 'list_projects', 'list_documents',
  'get_document', 'get_document_markdown',
  'list_statuses', 'list_fields', 'list_views',
  'run_view',
  // get_agent_self is read-only metadata-on-self; resolved via the bearer's
  // agent_id, no agents:write needed. Maps to documents:read since the agent
  // row is a document.
  'get_agent_self',
  // Phase-op-3 — operator REST read bridge. GET-forced, maps to documents:read
  // so the run's read scope gates it (the write tool folio_api → config:write
  // lives in CONFIG_WRITE_TOOLS below).
  'folio_api_get',
  // Piece B — narrow __system skills-page read. Maps to documents:read; reaches
  // only (__system, skills, type=page) by construction (see agent-tools-registry).
  'get_skill',
]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['create_document', 'update_document']);
const DELETE_TOOLS: ReadonlySet<string> = new Set(['delete_document']);
// Phase 2.6 sub-phase D — agent lifecycle tools require the new agents:write
// scope. get_agent_self is NOT in this set; it's read-only (see READ_TOOLS).
const AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_agent', 'update_agent', 'delete_agent',
]);
// Phase 2 (operator) — structure/config mutation (tables, fields, views,
// statuses, project config) is reached through the general folio_api primitive
// (Phase 3), gated on the new canonical config:write scope. Registered here so
// toolsToScopes is consistent the moment folio_api is added; owner/admin gets
// config:write via ALL_DOCUMENT_SCOPES in roleToScopes.
// set_skill_trust (Piece B, T8) is a privileged config-class op — maps to
// config:write here; the actual bless gate (canBlessSkill) is enforced inside
// setSkillTrust, not by the scope alone.
const CONFIG_WRITE_TOOLS: ReadonlySet<string> = new Set(['folio_api', 'set_skill_trust']);

/**
 * The complete set of scopes a fully-privileged caller (owner/admin) may
 * delegate. Four are gated by the tool registry today
 * (documents:read/write/delete + agents:write); config:write is reserved ahead
 * of its consumer — the Phase-3 folio_api primitive — so owner/admin delegation
 * already carries it the moment that tool is registered.
 */
const ALL_DOCUMENT_SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'agents:write',
  'config:write',
] as const;

/** Admin-only scopes — gate the HIGH-privilege folio_api write surfaces
 *  (workspace settings, membership changes, workspace rename/delete). Granted
 *  to owner/admin membership roles ONLY; never to `member`, and never derived
 *  from an agent's tool whitelist (workers stay document-scoped). */
export const ADMIN_SCOPES = ['settings:write', 'members:write', 'workspace:admin'] as const;

/** Human analog of toolsToScopes: map a workspace membership role to the scope
 *  set a delegated run may use on that caller's behalf (Phase 1 delegation).
 *  owner/admin → all scopes; member → day-to-day read+write (NOT delete, NOT
 *  agents:write). The run's effective authority is still agent ∩ caller. */
export function roleToScopes(role: 'owner' | 'admin' | 'member'): string[] {
  if (role === 'owner' || role === 'admin') return [...ALL_DOCUMENT_SCOPES, ...ADMIN_SCOPES];
  return ['documents:read', 'documents:write'];
}

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
    if (AGENT_WRITE_TOOLS.has(tool)) {
      scopes.add('agents:write');
      scopes.add('documents:read'); // agent rows are documents
    }
    if (CONFIG_WRITE_TOOLS.has(tool)) {
      scopes.add('config:write');
      scopes.add('documents:read'); // config edits imply reading structure
    }
  }
  return Array.from(scopes);
}
