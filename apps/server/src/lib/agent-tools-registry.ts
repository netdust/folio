/**
 * D-2: the 20 production tools, registered into the shared `executeTool`
 * registry so BOTH transport faces (MCP route + in-process runner) dispatch
 * them through the one auth+dispatch point in `agent-tools.ts`.
 *
 * Migrated verbatim from the legacy inline `TOOLS` array in `routes/mcp.ts`.
 * Two shape changes versus the legacy handlers:
 *
 *   1. Handler signature is `(args, ctx)` (canonical order), not the legacy
 *      `(ctx, args)`. `executeTool` calls handlers this way.
 *   2. `ctx.actor` is a STRING (the legacy `ctx.actor.id`). Service calls that
 *      need a `User`-shaped actor wrap it as `{ id: ctx.actor } as never` —
 *      identical to the legacy `actor as never` cast, which passed an object
 *      whose `.id` is the FK-valid user id. The MCP transport supplies the
 *      authenticated user id as actor; the runner supplies its FK-valid
 *      transition actor. Neither is D-2's concern — D-2 preserves behavior.
 *
 * Error shape (option (b) from the D-2 plan): agent-lifecycle guards in
 * `agent-guards.ts` throw `HTTPError`; the legacy MCP route translated those
 * to JSON-RPC `-32602` shapes via `mcpInvalidParams` + `rethrowAgentGuardAsMcp`
 * + `mcpRejectHumanPat`. Those translations are REPLICATED here, inside the
 * migrated handlers, so the handler emits the exact same error shape the MCP
 * route emits today. D-3 then becomes a pure transport swap (catch the thrown
 * error, copy `.code`/`.data`/`.message` into the JSON-RPC envelope) with zero
 * behavior change. The HTTP-side carve-out (agent CRUD via the workspace
 * documents route is intentionally NOT human-PAT-gated) is unaffected — those
 * routes keep calling `agent-guards.ts` directly.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { env } from '../env.ts';
import {
  type ApiToken,
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
  documents,
  projects,
  tables as tablesTable,
  users as usersTable,
  views as viewsTable,
  workspaces,
} from '../db/schema.ts';
import { emitChainSuppressed } from './autonomy-gate.ts';
import { isInstanceReach } from './token-reach.ts';
import type { AgentRunFrontmatter, RunStatus } from './agent-run-schema.ts';
import { runStatusSchema } from './agent-run-schema.ts';
import { createRunForParent, loadRunScopedByToken } from '../routes/runs.ts';
import {
  type ListRunsFilter,
  getActiveRun,
  listRuns,
  redactRunForApi,
  transitionRun,
} from '../services/agent-runs.ts';
import {
  type AuthorContext,
  createComment,
  deleteComment,
  getCommentScoped,
  listComments,
  updateComment,
} from '../services/comments.ts';
import {
  type DocumentType,
  createDocument,
  deleteDocument,
  findDocumentsInProjects,
  getDocument,
  getWorkspaceDocument,
  listDocuments,
  stripReservedFrontmatter,
  updateDocument,
} from '../services/documents.ts';
import { listFields } from '../services/fields.ts';
import { listStatuses } from '../services/statuses.ts';
import { listViews, runView } from '../services/views.ts';
import { assertAgentAllowListWidening, assertAgentToolsWidening } from './agent-guards.ts';
import { intersectAgentProjects, resolveAgentProjects } from './agent-projects.ts';
import { registerTool } from './agent-tools.ts';
import type { ToolContext } from './agent-tools.ts';
import { registerFolioApiTools } from './folio-api-tool.ts';
import {
  type CommentKind,
  type CommentVisibility,
  commentKindSchema,
  commentVisibilitySchema,
} from './comment-schema.ts';
import { serializeMarkdown } from './frontmatter.ts';
import { HTTPError } from './http.ts';
import { mcpInvalidParams, mcpRejectHumanPat, rethrowAgentGuardAsMcp } from './mcp-errors.ts';
import { isReservedSlug } from './system-workspace.ts';
import { canManageWorkspace, canSeeProject, visibleProjectIds } from './access.ts';
import { resolveAgentForRun } from './agent-resolver.ts';
import { getInstanceSkill } from './instance-skills.ts';
import { setSkillTrust } from './skill-trust.ts';
import { choiceCardSchema, ENTITY_TYPES, linkPanelSchema } from './ui-tool.ts';

// ---------------------------------------------------------------------------
// Result envelopes — verbatim from routes/mcp.ts.
// ---------------------------------------------------------------------------

function textResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function markdownResult(md: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Arg helpers — verbatim from routes/mcp.ts, adapted to take a parsed args bag.
//
// The legacy handlers re-validated args inline via requireString/optionalString
// even though MCP performs no schema validation. `executeTool` now runs
// `schema.parse(args)` FIRST (mitigation 26), so the Zod schema is the gate;
// these helpers keep the same coercion semantics for the handler body (e.g.
// "empty string → absent" for optionalString) so behavior is identical.
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing or invalid argument: ${key}`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Parse a possibly-CSV string arg into a typed list (or undefined). */
function parseCsvArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
): T[] | undefined {
  const raw = args[key];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as T[];
  return parts.length > 0 ? parts : undefined;
}

/** Resolve and validate that the workspace_slug matches the token's workspace. */
async function resolveWorkspaceForToken(
  token: ApiToken,
  args: Record<string, unknown>,
): Promise<Workspace> {
  const slug = requireString(args, 'workspace_slug');
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, slug),
  });
  if (!ws) throw new Error('workspace not accessible');
  // Instance-reach token (workspaceId null) reaches any existing workspace; a
  // pinned token must match its own. NOTE: during an agent RUN the token passed
  // here is the NARROWED run token (effective reach, Task A8), so this also
  // enforces the per-run floor.
  if (!isInstanceReach(token) && ws.id !== token.workspaceId) {
    throw new Error('workspace not accessible');
  }
  return ws;
}

/**
 * The project ceiling for a HUMAN PAT on the MCP surface. Mirrors the HTTP
 * `resolveCallerProjectAllowList` (runs.ts): a human PAT whose owner is NOT a
 * whole-workspace principal (owner / workspace_access) is a project-only
 * invitee and must be narrowed to exactly their `project_access` grants. Returns
 * `null` = UNRESTRICTED (agent-bound token — bounded separately by the agent
 * allow-list; system-origin token with no createdBy; or a whole-ws human). A
 * Set = the only project ids this human PAT may reach. This closes the CR-7/CR-9
 * cross-project leak on the MCP layer (the per-user narrowing the HTTP routes
 * got but the tools did not).
 */
async function humanPatProjectCeiling(
  ws: Workspace,
  token: ApiToken,
): Promise<Set<string> | null> {
  if (token.agentId) return null; // agent-bound: agent allow-list governs, not this
  if (!token.createdBy) return null; // system-origin (operator): no human narrowing
  if (await canManageWorkspace(db, token.createdBy, ws.id)) return null; // whole-ws human
  return visibleProjectIds(db, token.createdBy, ws.id); // project-only invitee
}

async function resolveProjectInWorkspace(
  ws: Workspace,
  token: ApiToken,
  args: Record<string, unknown>,
): Promise<Project> {
  const slug = requireString(args, 'project_slug');
  const p = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, slug)),
  });
  if (!p) throw new Error('project not found');

  // Phase 2.5: agent-bound tokens intersect the agent's frontmatter.projects
  // with the token's optional projectIds narrowing; reject if the requested
  // project isn't in the result. Phase 1 delegation (mitigation D4): the
  // caller's project set is ALREADY folded into `token.projectIds` upstream in
  // loadContext (the central clamp), so this single intersect now enforces
  // agent ∩ token ∩ caller — no per-site caller param needed.
  if (token.agentId) {
    const agent = await db.query.documents.findFirst({
      where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
    });
    if (!agent) {
      throw mcpInvalidParams('agent for this token no longer exists', {
        reason: 'agent_missing',
      });
    }
    const agentProjects = resolveAgentProjects(agent);
    const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
    if (!effective.includes('*') && !effective.includes(p.id)) {
      console.info('[mcp] allow-list rejection', {
        agent_slug: agent.slug,
        agent_id: agent.id,
        requested_project_slug: slug,
        requested_project_id: p.id,
        allowed_projects: agentProjects,
      });
      throw mcpInvalidParams(`agent not allow-listed for project ${slug}`, {
        reason: 'agent_not_in_allow_list',
        project_slug: slug,
        agent_slug: agent.slug,
      });
    }
  } else if (token.createdBy && !(await canManageWorkspace(db, token.createdBy, ws.id))) {
    // Human PAT, project-only invitee: reject a project they have no grant to.
    // (A whole-ws human / agent token short-circuits above.) Closes the CR-7/CR-9
    // cross-project leak on the MCP single-project resolver.
    if (!(await canSeeProject(db, token.createdBy, p.id))) {
      throw mcpInvalidParams(`not granted access to project ${slug}`, {
        reason: 'no_project_access',
        project_slug: slug,
      });
    }
  }
  return p;
}

/**
 * Resolve the comment author context for a bearer token.
 * - Agent-bound token → `{ type: 'agent', agentSlug, agentId }`.
 * - Otherwise → `{ type: 'user', userId: token.createdBy }`.
 */
async function resolveAuthorContextForToken(token: ApiToken): Promise<AuthorContext> {
  if (token.agentId) {
    const agent = await db.query.documents.findFirst({
      where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
    });
    if (!agent) {
      throw mcpInvalidParams('agent for this token no longer exists', {
        reason: 'agent_missing',
      });
    }
    return { type: 'agent', agentSlug: agent.slug, agentId: token.agentId };
  }
  if (!token.createdBy) {
    throw mcpInvalidParams('token has no owner; cannot resolve comment author', {
      reason: 'unknown_author',
    });
  }
  return { type: 'user', userId: token.createdBy };
}

/**
 * Resolve a table for a project. If `table_slug` is provided, look it up;
 * otherwise return the first table by `order` (the project's default).
 */
async function resolveTableForArgs(
  p: Project,
  args: Record<string, unknown>,
): Promise<TableEntity> {
  const slug = optionalString(args, 'table_slug');
  if (slug) {
    const t = await db.query.tables.findFirst({
      where: and(eq(tablesTable.projectId, p.id), eq(tablesTable.slug, slug)),
    });
    if (!t) throw new Error('table not found');
    return t;
  }
  const t = await db.query.tables.findFirst({
    where: eq(tablesTable.projectId, p.id),
    orderBy: (col, { asc }) => [asc(col.order)],
  });
  if (!t) throw new Error('project has no tables');
  return t;
}

/** Wrap the string actor as the `{ id }`-shaped value the service layer reads. */
function serviceActor(ctx: ToolContext): never {
  return { id: ctx.actor } as never;
}

// ---------------------------------------------------------------------------
// D-4: run-management tool helpers. Token-based equivalents of the Context-
// coupled helpers in routes/runs.ts, so the MCP run tools share D-1's seam.
// ---------------------------------------------------------------------------

/**
 * Resolve a bearer token's effective project allow-list. Returns `null` when
 * there is no narrowing (human PAT or wildcard agent). Token-based twin of
 * `resolveAgentAllowList` in routes/runs.ts — same `resolveAgentProjects` +
 * `intersectAgentProjects` shape.
 */
async function resolveAgentAllowListForToken(token: ApiToken): Promise<string[] | null> {
  if (!token.agentId) return null;
  const agent = await db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
  if (!agent) {
    throw mcpInvalidParams('agent for this token no longer exists', { reason: 'agent_missing' });
  }
  const effective = intersectAgentProjects(resolveAgentProjects(agent), token.projectIds ?? null);
  return effective.includes('*') ? null : effective;
}

/**
 * Resolve the human owner `User` for createRunForParent's `actor`. Twin of
 * `resolveActorUser` in routes/runs.ts: for a human PAT the owner is
 * `token.createdBy → user`. The autonomy gate (mit 54) fires first for
 * agent-bound bearers, so this is only reached on the human-PAT path; if no
 * user resolves we reject rather than fabricate provenance.
 */
async function resolveActorUserForToken(token: ApiToken): Promise<User> {
  if (token.createdBy) {
    const user = await db.query.users.findFirst({
      where: eq(usersTable.id, token.createdBy),
    });
    if (user) return user;
  }
  throw mcpInvalidParams('no user resolves for this run', { reason: 'no_actor_user' });
}

/** Resolve a parent document by slug within a workspace (404-equivalent if gone). */
async function resolveParentInWorkspace(ws: Workspace, parentSlug: string): Promise<Document> {
  const parent = await db.query.documents.findFirst({
    where: and(eq(documents.workspaceId, ws.id), eq(documents.slug, parentSlug)),
  });
  if (!parent) {
    throw mcpInvalidParams(`parent "${parentSlug}" not found`, {
      reason: 'parent_not_found',
      parent_slug: parentSlug,
    });
  }
  return parent;
}

/** Resolve a project row by id (used for the input-comment on run_agent). */
async function resolveProjectById(projectId: string): Promise<Project> {
  const p = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!p) {
    throw mcpInvalidParams('parent has no project', { reason: 'parent_not_found' });
  }
  return p;
}

// ---------------------------------------------------------------------------
// Zod schemas — capture the SAME required/optional fields each legacy handler
// reads, per the legacy inline checks + the advisory inputSchema. `.strict()`
// is house style. `executeTool` runs `schema.parse(args)` before the handler.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool registrations. Wrapped in a function (not run at import time) so the
// circular import with agent-tools.ts resolves — agent-tools.ts invokes this
// AFTER its `registry`/`registerTool` are initialized. Idempotent-guarded so a
// double call (e.g. test re-import) is a no-op rather than a duplicate-name
// throw.
// ---------------------------------------------------------------------------

let registered = false;

export function registerRealTools(): void {
  if (registered) return;
  registered = true;

  registerTool({
    name: 'list_workspaces',
    description: 'List workspaces visible to the token.',
    inputSchema: { type: 'object', properties: {} },
    requiredScope: 'documents:read',
    schema: z.object({}).strict(),
    handler: async (_args, ctx) => {
      const all = isInstanceReach(ctx.token)
        ? // CR#4 — an instance token enumerates every workspace EXCEPT the
          // reserved __system library (other surfaces hide it via isReservedSlug;
          // list_workspaces must not leak the reserved namespace).
          (await db.query.workspaces.findMany()).filter((ws) => !isReservedSlug(ws.slug))
        : await db.query.workspaces
            .findFirst({ where: eq(workspaces.id, ctx.token.workspaceId!) })
            .then((ws) => (ws ? [ws] : []));
      return textResult({
        workspaces: all.map((ws) => ({ id: ws.id, slug: ws.slug, name: ws.name })),
      });
    },
  });

  registerTool({
    name: 'get_skill',
    description:
      'Load an instance skill by name. Read-only — use before shaping a workspace or adding a provider.',
    requiredScope: 'documents:read',
    schema: z.object({ slug: z.string() }).strict(),
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The skill name to load from the instance library.' },
      },
      required: ['slug'],
    },
    handler: async (args: { slug: string }, _ctx) => {
      // Phase 4: skills live in `instance_skills` by name. `trusted` is the
      // typed column; description/when_to_use ride frontmatter. Gated by the
      // documents:read requiredScope above (executeTool checks token + caller).
      const skill = await getInstanceSkill(db, args.slug);
      if (!skill) throw new Error('skill not found');
      const sfm = (skill.frontmatter ?? {}) as {
        description?: string;
        when_to_use?: string;
      };
      return textResult({
        slug: skill.name,
        body: skill.body,
        trusted: skill.trusted === true,
        description: sfm.description,
        when_to_use: sfm.when_to_use,
      });
    },
  });

  registerTool({
    name: 'set_skill_trust',
    description:
      'Bless or unbless an instance skill (set its trusted flag). Restricted to the system operator or a session user.',
    requiredScope: 'config:write', // a privileged config-class op
    // C3 (/shakeout 2026-06-03): trust-elevation is refused on an unattended
    // (trigger-fired) run. The operator token is createdBy-null so canBlessSkill
    // would otherwise pass even on a no-human run over attacker-supplied content,
    // letting an injection bless a planted skill into the trusted channel. Floored
    // by tool name (not scope) so folio_api's allowed unattended document writes
    // are unaffected.
    unattendedFloor: true,
    schema: z.object({ slug: z.string(), trusted: z.boolean() }).strict(),
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, trusted: { type: 'boolean' } },
      required: ['slug', 'trusted'],
    },
    handler: async (args: { slug: string; trusted: boolean }, ctx) => {
      // T8 gate lives in setSkillTrust(canBlessSkill). The tool caller is always
      // a token; sessionUser is null on the tool path (the operator's
      // createdBy-null token is the live blesser — an MCP admin PAT carries a
      // human createdBy and is refused). Returns the refusal as a structured
      // result if not allowed instead of throwing through the tool envelope.
      try {
        await setSkillTrust(db, {
          slug: args.slug,
          trusted: args.trusted,
          token: ctx.token,
          sessionUser: null,
        });
        return textResult({ slug: args.slug, trusted: args.trusted, ok: true });
      } catch (e) {
        return textResult({
          slug: args.slug,
          refused: true,
          reason: e instanceof Error ? e.message : 'refused',
        });
      }
    },
  });

  registerTool({
    name: 'list_projects',
    description:
      "List projects in the bound workspace. For agent-bound tokens, filtered to the agent's allow-list.",
    inputSchema: {
      type: 'object',
      properties: { workspace_slug: { type: 'string' } },
      required: ['workspace_slug'],
    },
    requiredScope: 'documents:read',
    schema: z.object({ workspace_slug: z.string() }).strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const all = await db.query.projects.findMany({
        where: eq(projects.workspaceId, ws.id),
      });
      if (!token.agentId) {
        // Human PAT: narrow a project-only invitee to their visible projects
        // (null = whole-ws human / system-origin → unrestricted).
        const ceiling = await humanPatProjectCeiling(ws, token);
        const visible = ceiling === null ? all : all.filter((p) => ceiling.has(p.id));
        return textResult({
          projects: visible.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
        });
      }
      const agent = await db.query.documents.findFirst({
        where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
      });
      const agentProjects = agent ? resolveAgentProjects(agent) : ['*'];
      const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
      const filtered = effective.includes('*') ? all : all.filter((p) => effective.includes(p.id));
      return textResult({
        projects: filtered.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
      });
    },
  });

  registerTool({
    name: 'list_documents',
    description:
      'List documents in a project. Returns work_item + page only. Comments → list_comments; runs → list_runs. Optional type filter and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        type: { type: 'string', enum: ['work_item', 'page', 'agent', 'trigger'] },
        table_slug: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        // Handler explicitly rejects agent_run; allow any string through so that
        // rejection (a clean error message) fires instead of a Zod path error.
        type: z.string().optional(),
        table_slug: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const type = optionalString(args, 'type');
      if (type === 'agent_run') {
        throw new Error(
          'agent_run documents must be listed via the runs endpoints (Sub-phase D), not list_documents',
        );
      }
      let activeTableId: string | null = null;
      if (type === 'work_item') {
        const t = await resolveTableForArgs(p, args);
        activeTableId = t.id;
      }
      const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : 50;
      const cursor = optionalString(args, 'cursor');
      const result = await listDocuments({
        projectId: p.id,
        activeTableId,
        type,
        limit,
        cursor,
      });
      return textResult({
        documents: result.data.map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          type: d.type,
          status: d.status,
          updated_at: d.updatedAt,
        })),
        next_cursor: result.nextCursor,
      });
    },
  });

  registerTool({
    name: 'find_documents',
    description:
      'Resolve a title to a document. Case-insensitive substring match on title, workspace-wide by default (narrow with project_slug). Use this when you have a title but not a slug — do NOT page through list_documents.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        query: { type: 'string' },
        project_slug: { type: 'string' },
        type: { type: 'string', enum: ['work_item', 'page'] },
        limit: { type: 'number' },
      },
      required: ['workspace_slug', 'query'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        query: z.string(),
        project_slug: z.string().optional(),
        type: z.enum(['work_item', 'page']).optional(),
        // min(1): limit:0 would otherwise pass through as LIMIT 0 and silently
        // return an empty result (Math.min(200, 0 ?? 25) === 0).
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const query = requireString(args, 'query');
      const typeArg = optionalString(args, 'type') as 'work_item' | 'page' | undefined;
      const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : 25;

      // Fetch workspace projects ONCE — reused for the workspace-wide allow-list
      // resolution AND the id→slug result mapping (one query, not two).
      const all = await db.query.projects.findMany({ where: eq(projects.workspaceId, ws.id) });

      let projectIds: string[];
      const projectSlug = optionalString(args, 'project_slug');
      if (projectSlug) {
        const p = await resolveProjectInWorkspace(ws, token, args); // enforces allow-list
        projectIds = [p.id];
      } else if (!token.agentId) {
        // Human PAT: a project-only invitee sees only their granted projects.
        const ceiling = await humanPatProjectCeiling(ws, token);
        projectIds =
          ceiling === null ? all.map((p) => p.id) : all.filter((p) => ceiling.has(p.id)).map((p) => p.id);
      } else {
        const agent = await db.query.documents.findFirst({
          where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
        });
        const agentProjects = agent ? resolveAgentProjects(agent) : ['*'];
        const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
        projectIds = effective.includes('*')
          ? all.map((p) => p.id)
          : all.filter((p) => effective.includes(p.id)).map((p) => p.id);
      }

      const rows = await findDocumentsInProjects({
        projectIds,
        titleQuery: query,
        types: typeArg ? [typeArg] : undefined,
        limit,
      });

      const idToSlug = new Map(all.map((p) => [p.id, p.slug]));
      return textResult({
        documents: rows.map((d) => ({
          id: d.id,
          slug: d.slug,
          title: d.title,
          type: d.type,
          status: d.status,
          project_slug: d.projectId ? (idToSlug.get(d.projectId) ?? null) : null,
          updated_at: d.updatedAt,
        })),
      });
    },
  });

  registerTool({
    name: 'describe_workspace',
    description:
      "One-call orientation: every allow-listed project, its tables, and each table's status keys. Call this first to learn the workspace shape.",
    inputSchema: {
      type: 'object',
      properties: { workspace_slug: { type: 'string' } },
      required: ['workspace_slug'],
    },
    requiredScope: 'documents:read',
    schema: z.object({ workspace_slug: z.string() }).strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const all = await db.query.projects.findMany({ where: eq(projects.workspaceId, ws.id) });

      let visible = all;
      if (token.agentId) {
        const agent = await db.query.documents.findFirst({
          where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
        });
        const agentProjects = agent ? resolveAgentProjects(agent) : ['*'];
        const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
        visible = effective.includes('*') ? all : all.filter((p) => effective.includes(p.id));
      } else {
        // Human PAT: narrow a project-only invitee to their visible projects.
        const ceiling = await humanPatProjectCeiling(ws, token);
        if (ceiling !== null) visible = all.filter((p) => ceiling.has(p.id));
      }

      const projectsOut = [];
      for (const p of visible) {
        const tbls = await db.query.tables.findMany({
          where: eq(tablesTable.projectId, p.id),
          orderBy: (t, { asc }) => [asc(t.order)],
        });
        const tablesOut = [];
        for (const t of tbls) {
          const statuses = await listStatuses(t.id);
          tablesOut.push({
            slug: t.slug,
            statuses: statuses.map((s) => ({ key: s.key, name: s.name, category: s.category })),
          });
        }
        projectsOut.push({ slug: p.slug, name: p.name, tables: tablesOut });
      }

      return textResult({
        workspace: { slug: ws.slug, name: ws.name },
        projects: projectsOut,
      });
    },
  });

  registerTool({
    name: 'get_document',
    description: 'Get a single document with frontmatter + body.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        slug: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const slug = requireString(args, 'slug');
      const doc = await getDocument(p.id, slug);
      if (!doc) throw new Error('document not found');
      if (doc.type === 'agent_run') {
        throw new Error(
          'agent_run documents must be read via the runs endpoints (Sub-phase D), not get_document',
        );
      }
      return textResult(doc);
    },
  });

  registerTool({
    name: 'get_document_markdown',
    description: 'Get the raw markdown (YAML frontmatter + body) of a document.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        slug: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const slug = requireString(args, 'slug');
      const doc = await getDocument(p.id, slug);
      if (!doc) throw new Error('document not found');
      if (doc.type === 'agent_run') {
        throw new Error(
          'agent_run documents must be read via the runs endpoints (Sub-phase D), not get_document_markdown',
        );
      }
      const userFm = stripReservedFrontmatter((doc.frontmatter as Record<string, unknown>) ?? {});
      const fm: Record<string, unknown> = {
        ...userFm,
        type: doc.type,
        title: doc.title,
        ...(doc.status ? { status: doc.status } : {}),
        ...(doc.lastTouchedAt ? { last_touched_at: doc.lastTouchedAt.toISOString() } : {}),
      };
      const md = serializeMarkdown({ frontmatter: fm, body: doc.body });
      return markdownResult(md);
    },
  });

  registerTool({
    name: 'create_document',
    description:
      'Create a document. type: work_item|page|agent|trigger. work_item creation uses the project default table unless table_slug is given. Agents return a one-time api_token in the response.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        type: { type: 'string', enum: ['work_item', 'page', 'agent', 'trigger'] },
        title: { type: 'string' },
        body: { type: 'string' },
        frontmatter: { type: 'object' },
        status: { type: 'string' },
        table_slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'type', 'title'],
    },
    requiredScope: 'documents:write',
    // T7 confirm gate: a routine content write — reversible-ish, the act-then-
    // report majority. Opt DOWN to 'normal' so it does NOT require confirmation in
    // a conversation. (Destructive ops — delete_* / agents:write lifecycle — keep
    // the fail-closed 'high' default.)
    riskTier: 'normal',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        // Legacy mcp.ts ran NO Zod validation on `type`; the handler + service
        // layer reject unsupported types with precise messages (e.g.
        // type=comment → COMMENT_REQUIRES_COMMENT_TOOL, type=agent/trigger →
        // mcpInvalidParams "via the workspace-scoped HTTP endpoint"). Keeping
        // this a plain string (not `documentTypeEnum`) preserves that contract:
        // a non-enum value surfaces the handler's rejection rather than a Zod
        // path error. Mirrors `list_documents`, which keeps `type` lax to let
        // its own agent_run rejection fire.
        type: z.string(),
        title: z.string(),
        body: z.string().optional(),
        frontmatter: z.record(z.unknown()).optional(),
        status: z.string().optional(),
        table_slug: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const type = requireString(args, 'type') as DocumentType;
      if (type === 'agent' || type === 'trigger') {
        throw mcpInvalidParams(
          `${type} documents must be created via the workspace-scoped HTTP endpoint (POST /api/v1/w/:wslug/documents); not available via MCP in Phase 2.5`,
          { reason: 'agent_lifecycle_via_http_only' },
        );
      }
      const p = await resolveProjectInWorkspace(ws, token, args);
      const title = requireString(args, 'title');
      const body = optionalString(args, 'body') ?? '';
      const fmArg = args['frontmatter'];
      const frontmatter: Record<string, unknown> =
        fmArg && typeof fmArg === 'object' && !Array.isArray(fmArg)
          ? (fmArg as Record<string, unknown>)
          : {};
      const statusArg = optionalString(args, 'status') ?? null;

      const table = type === 'work_item' ? await resolveTableForArgs(p, args) : null;

      const { document, agentTokenPlaintext } = await createDocument({
        workspace: ws,
        project: p,
        table,
        actor: serviceActor(ctx),
        token,
        isTableScopedUrl: false,
        input: { type, title, body, frontmatter, status: statusArg },
      });

      const payload = agentTokenPlaintext
        ? { ...document, agent_token: agentTokenPlaintext }
        : document;
      return textResult(payload);
    },
  });

  registerTool({
    name: 'update_document',
    description:
      'Patch a document. Supplied frontmatter is shallow-merged into the existing frontmatter (null values delete keys). Reserved keys (type, title, status, last_touched_at) live as columns and are ignored when present in frontmatter. Discover valid status keys via list_statuses.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        slug: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: ['string', 'null'] },
        frontmatter: { type: 'object' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:write',
    // T7 confirm gate: routine reversible content update — opt down to 'normal'.
    riskTier: 'normal',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        slug: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        status: z.string().nullable().optional(),
        // Handler validates frontmatter is a non-array object itself and throws
        // a precise error; allow any value through Zod so that check fires.
        frontmatter: z.unknown().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getDocument(p.id, slug);
      if (!existing) throw new Error('document not found');
      if (existing.type === 'agent' || existing.type === 'trigger') {
        throw mcpInvalidParams(
          `${existing.type} documents cannot be mutated via MCP in Phase 2.5; use PATCH /api/v1/w/:wslug/documents/${slug}`,
          { reason: 'agent_lifecycle_via_http_only' },
        );
      }
      if (existing.type === 'comment') {
        throw mcpInvalidParams('comment documents must be mutated via the update_comment tool', {
          reason: 'comment_requires_comment_tool',
        });
      }

      let fallbackTable: TableEntity | null = null;
      if (existing.type === 'work_item' && !existing.tableId) {
        const t = await db.query.tables.findFirst({
          where: eq(tablesTable.projectId, p.id),
          orderBy: (col, { asc }) => [asc(col.order)],
        });
        fallbackTable = t ?? null;
      }

      const patch: Parameters<typeof updateDocument>[0]['patch'] = {};
      if (typeof args['title'] === 'string') patch.title = args['title'] as string;
      if (typeof args['body'] === 'string') patch.body = args['body'] as string;
      if (typeof args['status'] === 'string' || args['status'] === null) {
        patch.status = args['status'] as string | null;
      }
      const fmArg = args['frontmatter'];
      if (fmArg !== undefined) {
        if (!fmArg || typeof fmArg !== 'object' || Array.isArray(fmArg)) {
          throw new Error('frontmatter must be an object');
        }
        patch.frontmatter = fmArg as Record<string, unknown>;
      }

      const updated = await updateDocument({
        workspace: ws,
        project: p,
        fallbackTable,
        actor: serviceActor(ctx),
        existing,
        patch,
      });
      return textResult(updated);
    },
  });

  registerTool({
    name: 'delete_document',
    description: 'Delete a document.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:delete',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        slug: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getDocument(p.id, slug);
      if (!existing) throw new Error('document not found');
      if (existing.type === 'agent' || existing.type === 'trigger') {
        throw mcpInvalidParams(
          `${existing.type} documents cannot be deleted via MCP in Phase 2.5; use DELETE /api/v1/w/:wslug/documents/${slug}`,
          { reason: 'agent_lifecycle_via_http_only' },
        );
      }
      if (existing.type === 'comment') {
        throw mcpInvalidParams('comment documents must be deleted via the delete_comment tool', {
          reason: 'comment_requires_comment_tool',
        });
      }
      await deleteDocument({
        workspace: ws,
        project: p,
        actor: serviceActor(ctx),
        existing,
      });
      return textResult({ ok: true, slug });
    },
  });

  registerTool({
    name: 'list_statuses',
    description: 'List statuses for a table (uses the project default unless table_slug is given).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        table_slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        table_slug: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const t = await resolveTableForArgs(p, args);
      const list = await listStatuses(t.id);
      return textResult({ table: { id: t.id, slug: t.slug }, statuses: list });
    },
  });

  registerTool({
    name: 'list_fields',
    description: 'List fields for a table (uses the project default unless table_slug is given).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        table_slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        table_slug: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const t = await resolveTableForArgs(p, args);
      const list = await listFields(t.id);
      return textResult({ table: { id: t.id, slug: t.slug }, fields: list });
    },
  });

  registerTool({
    name: 'list_views',
    description: 'List views for a table (uses the project default unless table_slug is given).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        table_slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        table_slug: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const t = await resolveTableForArgs(p, args);
      const list = await listViews(t.id);
      return textResult({ table: { id: t.id, slug: t.slug }, views: list });
    },
  });

  registerTool({
    name: 'run_view',
    description:
      'Run a saved view by view_slug (or view_id). Applies stored filters and returns matching documents.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        view_slug: { type: 'string' },
        view_id: { type: 'string' },
        table_slug: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        view_slug: z.string().optional(),
        view_id: z.string().optional(),
        table_slug: z.string().optional(),
        limit: z.number().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const p = await resolveProjectInWorkspace(ws, ctx.token, args);
      const t = await resolveTableForArgs(p, args);
      const viewId = optionalString(args, 'view_id');
      const viewSlug = optionalString(args, 'view_slug');
      let view = null;
      if (viewId) {
        view = await db.query.views.findFirst({
          where: and(eq(viewsTable.tableId, t.id), eq(viewsTable.id, viewId)),
        });
      } else if (viewSlug) {
        const candidates = await db.query.views.findMany({
          where: eq(viewsTable.tableId, t.id),
        });
        view = candidates.find((v) => v.name.toLowerCase() === viewSlug.toLowerCase()) ?? null;
      } else {
        view = await db.query.views.findFirst({
          where: and(eq(viewsTable.tableId, t.id), eq(viewsTable.isDefault, true)),
        });
      }
      if (!view) throw new Error('view not found');
      const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : 50;
      const docs = await runView({
        view,
        projectId: p.id,
        tableId: t.id,
        limit,
      });
      return textResult({
        view: { id: view.id, name: view.name },
        documents: docs,
      });
    },
  });

  // --- Phase 2.6 comment tools ---

  registerTool({
    name: 'create_comment',
    description:
      'Post a comment on a work_item or page. Mention parsing + approval-keyword detection happen server-side; the author is resolved from the bearer token.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        parent_slug: { type: 'string' },
        body: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['comment', 'plan', 'result', 'error', 'approval', 'rejection', 'reply'],
        },
        target_agent: { type: 'string' },
        visibility: { type: 'string', enum: ['normal', 'internal'] },
      },
      required: ['workspace_slug', 'project_slug', 'parent_slug', 'body'],
    },
    requiredScope: 'documents:write',
    // T7 confirm gate: routine reversible content write — opt down to 'normal'.
    riskTier: 'normal',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        parent_slug: z.string(),
        body: z.string(),
        kind: commentKindSchema.optional(),
        target_agent: z.string().optional(),
        visibility: commentVisibilitySchema.optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const parentSlug = requireString(args, 'parent_slug');
      const parent = await db.query.documents.findFirst({
        where: and(eq(documents.projectId, project.id), eq(documents.slug, parentSlug)),
      });
      if (!parent) throw new Error(`parent ${parentSlug} not found`);

      const authorContext = await resolveAuthorContextForToken(token);
      const body = requireString(args, 'body');

      const kindArg = optionalString(args, 'kind');
      const kind = kindArg !== undefined ? commentKindSchema.parse(kindArg) : undefined;
      const visibilityArg = optionalString(args, 'visibility');
      const visibility =
        visibilityArg !== undefined ? commentVisibilitySchema.parse(visibilityArg) : undefined;
      const targetAgent = optionalString(args, 'target_agent');

      const doc = await createComment({
        workspace: ws,
        project,
        parent,
        authorContext,
        actor: token.id,
        body,
        kind,
        targetAgent,
        visibility,
      });
      const fm = doc.frontmatter as Record<string, unknown>;
      return textResult({
        slug: doc.slug,
        kind: fm.kind,
        ...(fm.target_agent !== undefined ? { target_agent: fm.target_agent } : {}),
      });
    },
  });

  registerTool({
    name: 'list_comments',
    description:
      'List comments on a work_item or page. Newest-first. Optional kind / since / visibility filters. Default visibility is "normal" (internal rows excluded unless explicitly requested).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        parent_slug: { type: 'string' },
        kind: { type: 'string' },
        since: { type: 'string' },
        visibility: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'parent_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        parent_slug: z.string(),
        // kind/visibility accept a single value OR a comma-separated list; the
        // handler parses + validates each part via comment-schema. Keep Zod lax.
        kind: z.string().optional(),
        since: z.string().optional(),
        visibility: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const ws = await resolveWorkspaceForToken(ctx.token, args);
      const project = await resolveProjectInWorkspace(ws, ctx.token, args);
      const parentSlug = requireString(args, 'parent_slug');
      const parent = await db.query.documents.findFirst({
        where: and(eq(documents.projectId, project.id), eq(documents.slug, parentSlug)),
      });
      if (!parent) throw new Error(`parent ${parentSlug} not found`);

      const kinds = parseCsvArg<string>(args, 'kind');
      const visibility = parseCsvArg<string>(args, 'visibility');
      const since = optionalString(args, 'since');

      const kindParsed: CommentKind[] | undefined = kinds
        ? kinds.map((k) => commentKindSchema.parse(k))
        : undefined;
      const visibilityParsed: CommentVisibility[] | undefined = visibility
        ? visibility.map((v) => commentVisibilitySchema.parse(v))
        : undefined;

      const rows = await listComments({
        parentId: parent.id,
        kind: kindParsed,
        since,
        visibility: visibilityParsed,
      });
      return textResult(rows);
    },
  });

  registerTool({
    name: 'update_comment',
    description:
      'Edit a comment body or visibility. Author-only — `kind` is immutable after creation; supplying it is rejected by the service.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        slug: { type: 'string' },
        body: { type: 'string' },
        visibility: { type: 'string', enum: ['normal', 'internal'] },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:write',
    // T7 confirm gate: routine reversible content update — opt down to 'normal'.
    riskTier: 'normal',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        slug: z.string(),
        body: z.string().optional(),
        visibility: commentVisibilitySchema.optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getCommentScoped(ws.id, project.id, slug);
      if (!existing) throw new Error('comment not found');

      const authorContext = await resolveAuthorContextForToken(token);
      const visibilityRaw = optionalString(args, 'visibility');
      const visibility = visibilityRaw ? commentVisibilitySchema.parse(visibilityRaw) : undefined;

      try {
        const updated = await updateComment({
          workspace: ws,
          project,
          existing,
          authorContext,
          body: optionalString(args, 'body'),
          visibility,
          actor: token.id,
        });
        const fm = updated.frontmatter as Record<string, unknown>;
        return textResult({
          slug: updated.slug,
          edited_at: fm.edited_at,
        });
      } catch (err) {
        if (err instanceof HTTPError && err.code === 'COMMENT_AUTHOR_ONLY') {
          throw mcpInvalidParams('only the comment author can edit', {
            reason: 'comment_author_only',
          });
        }
        throw err;
      }
    },
  });

  registerTool({
    name: 'delete_comment',
    description:
      'Soft-delete a comment. Author-only. The row stays in the database with `deleted_at` set; downstream UIs mute it.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:delete',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        slug: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getCommentScoped(ws.id, project.id, slug);
      if (!existing) throw new Error('comment not found');

      const authorContext = await resolveAuthorContextForToken(token);

      try {
        const updated = await deleteComment({
          workspace: ws,
          project,
          existing,
          authorContext,
          actor: token.id,
        });
        const fm = updated.frontmatter as Record<string, unknown>;
        return textResult({
          slug: updated.slug,
          deleted_at: fm.deleted_at,
        });
      } catch (err) {
        if (err instanceof HTTPError && err.code === 'COMMENT_AUTHOR_ONLY') {
          throw mcpInvalidParams('only the comment author can delete', {
            reason: 'comment_author_only',
          });
        }
        throw err;
      }
    },
  });

  // --- Phase 2.6 sub-phase D — agent-lifecycle tools (carry mitigation 57) ---

  registerTool({
    name: 'create_agent',
    description:
      "Create a workspace-scoped agent document. Mints a bearer token and returns it ONCE in the response as `agent_token`. The token is scoped to the calling token's workspace.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        slug: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        frontmatter: { type: 'object' },
      },
      required: ['workspace_slug', 'title', 'frontmatter'],
    },
    requiredScope: 'agents:write',
    schema: z
      .object({
        workspace_slug: z.string(),
        slug: z.string().optional(),
        title: z.string(),
        body: z.string().optional(),
        // Handler validates frontmatter is a non-array object itself; allow any
        // value through Zod so the precise mcpInvalidParams error fires.
        frontmatter: z.unknown(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      // Round 6 #1: human PATs cannot mint agent bearers via MCP.
      mcpRejectHumanPat(token);
      const ws = await resolveWorkspaceForToken(token, args);
      const title = requireString(args, 'title');
      const body = optionalString(args, 'body') ?? '';
      const fmArg = args['frontmatter'];
      if (!fmArg || typeof fmArg !== 'object' || Array.isArray(fmArg)) {
        throw mcpInvalidParams('frontmatter must be an object', {
          reason: 'invalid_frontmatter',
        });
      }
      const frontmatter = fmArg as Record<string, unknown>;

      await assertAgentAllowListWidening(token, frontmatter, 'create').catch(
        rethrowAgentGuardAsMcp,
      );
      await assertAgentToolsWidening(token, frontmatter, 'create').catch(rethrowAgentGuardAsMcp);

      const { document, agentTokenPlaintext } = await createDocument({
        workspace: ws,
        project: null,
        table: null,
        actor: serviceActor(ctx),
        token,
        isTableScopedUrl: false,
        input: { type: 'agent', title, body, frontmatter, status: null },
      });

      return textResult({
        ...document,
        ...(agentTokenPlaintext ? { agent_token: agentTokenPlaintext } : {}),
      });
    },
  });

  registerTool({
    name: 'update_agent',
    description:
      "Patch an existing workspace-scoped agent document. Reserved keys are ignored. When called with an agent-bound token, the target's frontmatter.projects allow-list cannot be widened beyond the calling agent's own allow-list.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        slug: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        frontmatter: { type: 'object' },
      },
      required: ['workspace_slug', 'slug'],
    },
    requiredScope: 'agents:write',
    schema: z
      .object({
        workspace_slug: z.string(),
        slug: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        frontmatter: z.unknown().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      // Round 6 #1: human PATs cannot modify agent bearers via MCP.
      mcpRejectHumanPat(token);
      const ws = await resolveWorkspaceForToken(token, args);
      const slug = requireString(args, 'slug');
      const existing = await getWorkspaceDocument(ws.id, 'agent', slug);
      if (!existing) {
        throw mcpInvalidParams(`agent ${slug} not found`, {
          reason: 'agent_not_found',
          slug,
        });
      }

      const patch: Parameters<typeof updateDocument>[0]['patch'] = {};
      if (typeof args['title'] === 'string') patch.title = args['title'] as string;
      if (typeof args['body'] === 'string') patch.body = args['body'] as string;
      const fmArg = args['frontmatter'];
      if (fmArg !== undefined) {
        if (!fmArg || typeof fmArg !== 'object' || Array.isArray(fmArg)) {
          throw mcpInvalidParams('frontmatter must be an object', {
            reason: 'invalid_frontmatter',
          });
        }
        patch.frontmatter = fmArg as Record<string, unknown>;

        await assertAgentAllowListWidening(token, patch.frontmatter, 'patch').catch(
          rethrowAgentGuardAsMcp,
        );
        await assertAgentToolsWidening(token, patch.frontmatter, 'patch').catch(
          rethrowAgentGuardAsMcp,
        );
      }

      const updated = await updateDocument({
        workspace: ws,
        project: null,
        fallbackTable: null,
        actor: serviceActor(ctx),
        existing,
        patch,
      });
      return textResult(updated);
    },
  });

  registerTool({
    name: 'delete_agent',
    description:
      "Soft-delete a workspace-scoped agent document. Cascades to revoke the agent's bearer token. Rejects self-delete when called with an agent-bound token.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['workspace_slug', 'slug'],
    },
    requiredScope: 'agents:write',
    schema: z
      .object({
        workspace_slug: z.string(),
        slug: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      // Round 6 #1: human PATs cannot revoke agent bearers via MCP.
      mcpRejectHumanPat(token);
      const ws = await resolveWorkspaceForToken(token, args);
      const slug = requireString(args, 'slug');
      const existing = await getWorkspaceDocument(ws.id, 'agent', slug);
      if (!existing) {
        throw mcpInvalidParams(`agent ${slug} not found`, {
          reason: 'agent_not_found',
          slug,
        });
      }
      // Self-delete guard: kept inline (not `assertNotSelfDelete`) because the
      // HTTP and MCP layers throw different error shapes — HTTPError vs
      // mcpInvalidParams — and the helper hardcodes HTTPError.
      if (token.agentId && existing.id === token.agentId) {
        throw mcpInvalidParams('agent cannot delete itself via MCP', {
          reason: 'cannot_delete_self',
        });
      }

      await deleteDocument({
        workspace: ws,
        project: null,
        actor: serviceActor(ctx),
        existing,
      });
      return textResult({ ok: true, slug });
    },
  });

  registerTool({
    name: 'get_agent_self',
    description:
      "Return the calling agent's own document. Requires an agent-bound bearer token; user-minted (PAT) tokens have no agent identity and receive an error.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiredScope: 'documents:read',
    schema: z.object({}).strict(),
    handler: async (_args, ctx) => {
      const { token } = ctx;
      if (!token.agentId) {
        throw mcpInvalidParams('get_agent_self requires an agent-bound token', {
          reason: 'no_agent_bound_to_token',
        });
      }
      const agent = await db.query.documents.findFirst({
        where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
      });
      if (!agent) {
        throw mcpInvalidParams('agent for this token no longer exists', {
          reason: 'agent_missing',
        });
      }
      return textResult(agent);
    },
  });

  // --- Phase 3 Sub-phase D (Task D-4) — run-management tools ---
  //
  // MCP twins of D-1's HTTP run verbs. Each delegates to the SAME service /
  // runner functions the routes call (createRunForParent, loadRunScopedByToken,
  // listRuns, transitionRun, createComment) so enforcement is shared. The
  // `AgentRun` return type is the raw run Document(s) — matching how
  // list_documents returns rows. Bound mitigations: 24 (list narrowing), 54
  // (autonomy gate), 55 (allow-list on parent), 56/63 (idempotency via the
  // shared create tail), 58 (id re-scope), 59 (input-comment ordering).
  //
  // Error surfacing: HTTPErrors from the shared helpers (RUN_ALREADY_ACTIVE
  // 409, AGENT_RUN_NOT_FOUND 404, etc.) propagate as-is and D-3's
  // `mapToolErrorToJsonRpc` falls them through to -32603 carrying the message.
  // "Parity" with the HTTP twin means same ROW EFFECT + same semantic outcome,
  // not a byte-identical error envelope (HTTP returns a status, MCP a JSON-RPC
  // error). Per-tool argument/scope rejections that are MCP-native (autonomy
  // gate, missing parent/agent) use `mcpInvalidParams` for the structured
  // `data.reason` the protocol promises.

  registerTool({
    name: 'list_runs',
    description:
      "List agent_run documents in a project. Optional status / agent_slug / since filters. For agent-bound tokens, narrowed to the agent's allow-list.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        status: { type: 'string' },
        agent_slug: { type: 'string' },
        since: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        project_slug: z.string(),
        // status validated against the run-status enum in the handler so an
        // unknown value surfaces a clean rejection rather than a Zod path error.
        status: z.string().optional(),
        agent_slug: z.string().optional(),
        since: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const allowList = await resolveAgentAllowListForToken(token);

      const statusRaw = optionalString(args, 'status');
      let status: RunStatus | undefined;
      if (statusRaw !== undefined) {
        const parsed = runStatusSchema.safeParse(statusRaw);
        if (!parsed.success) {
          throw mcpInvalidParams(`invalid status: ${statusRaw}`, { reason: 'invalid_status' });
        }
        status = parsed.data;
      }

      const filter: ListRunsFilter = {
        projectId: project.id,
        status,
        agentSlug: optionalString(args, 'agent_slug'),
        since: optionalString(args, 'since'),
        callerAgentProjectsAllowList: allowList ?? undefined,
      };
      // Redact system_prompt from every row — the MCP list path must match the
      // HTTP list routes + the single-run loader (system_prompt is never exposed
      // over read surfaces). listRuns returns raw rows for internal callers.
      const rows = await listRuns(filter);
      return textResult(rows.map(redactRunForApi));
    },
  });

  registerTool({
    name: 'get_run',
    description: 'Get a single agent_run document by id.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        run_id: { type: 'string' },
      },
      required: ['workspace_slug', 'run_id'],
    },
    requiredScope: 'documents:read',
    schema: z
      .object({
        workspace_slug: z.string(),
        run_id: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const allowList = await resolveAgentAllowListForToken(token);
      const runId = requireString(args, 'run_id');
      const run = await loadRunScopedByToken(runId, { workspaceId: ws.id, allowList });
      return textResult(run);
    },
  });

  registerTool({
    name: 'run_agent',
    description:
      'Start an agent run targeted at a parent work_item or page. Returns { run_id, status }. Optional `input` is posted as a comment on the parent. Agent-originated chains require FOLIO_AGENT_CHAINS_ENABLED.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        agent_slug: { type: 'string' },
        parent_slug: { type: 'string' },
        input: { type: 'string' },
      },
      required: ['workspace_slug', 'agent_slug', 'parent_slug'],
    },
    requiredScope: 'agents:write',
    schema: z
      .object({
        workspace_slug: z.string(),
        agent_slug: z.string(),
        parent_slug: z.string(),
        input: z.string().optional(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);

      // 1. Resolve parent within the workspace.
      const parentSlug = requireString(args, 'parent_slug');
      const parent = await resolveParentInWorkspace(ws, parentSlug);
      const agentSlug = requireString(args, 'agent_slug');

      // 2. Autonomy gate (mit 54) — an agent-bound bearer create is an
      //    agent-ORIGINATED chain hop; gate behind FOLIO_AGENT_CHAINS_ENABLED.
      //    Human PATs (agentId null) are always allowed.
      const agentOriginated = !!token.agentId;
      if (agentOriginated && !env.FOLIO_AGENT_CHAINS_ENABLED) {
        await emitChainSuppressed(db, {
          workspaceId: ws.id,
          projectId: parent.projectId ?? null,
          documentId: parent.id,
          agentSlug,
          actor: token.id,
        });
        throw mcpInvalidParams('agent-originated chains are disabled', {
          reason: 'agent_chains_disabled',
        });
      }

      // 3. Allow-list (mit 55) — parent.projectId must be in the caller's
      //    allowed projects. BEFORE the input comment (mit 59 ordering).
      const allowList = await resolveAgentAllowListForToken(token);
      if (
        allowList !== null &&
        (parent.projectId === null || !allowList.includes(parent.projectId))
      ) {
        throw mcpInvalidParams('not allow-listed for that project', {
          reason: 'agent_not_in_allow_list',
        });
      }

      // 4. Resolve agent doc — gated by the home predicate {run-ws, __system}
      //    (B1): a B-local agent OR a __system library agent (local shadows
      //    library); an agent that lives only in a third workspace never
      //    resolves (fail-closed). HTTP-twin parity with routes/runs.ts.
      const agent = await resolveAgentForRun(db, agentSlug);
      if (!agent) {
        throw mcpInvalidParams(`agent "${agentSlug}" not found`, {
          reason: 'agent_not_found',
          agent_slug: agentSlug,
        });
      }

      // 5. Early idempotency check (m56) — mirror the HTTP face's ordering
      //    (routes/runs.ts). A duplicate-active create must reject BEFORE the
      //    input comment is posted (step 6), otherwise a duplicate run_agent
      //    with `input` leaves a STRAY comment then throws (Finding 3). The
      //    backstop inside createRunForParent remains the shared contract guard.
      const earlyActive = await getActiveRun({ parentId: parent.id, agentSlug: agent.slug });
      if (earlyActive) {
        throw new HTTPError('RUN_ALREADY_ACTIVE', 'a run is already active for this parent', 409);
      }

      // 6. Optional input comment (mit 59) — posted AFTER the allow-list +
      //    idempotency checks so a disallowed/duplicate parent never receives a
      //    comment.
      const input = optionalString(args, 'input');
      if (input) {
        if (parent.projectId === null) {
          throw mcpInvalidParams('parent has no project', { reason: 'parent_not_found' });
        }
        await createComment({
          workspace: ws,
          project: await resolveProjectById(parent.projectId),
          parent,
          authorContext: await resolveAuthorContextForToken(token),
          actor: token.id,
          body: input,
        });
      }

      // 7. Shared create tail (m56 idempotency backstop + ensureRunsTable + createRun).
      const actorUser = await resolveActorUserForToken(token);
      const document = await createRunForParent({
        workspace: ws,
        parent,
        agent,
        actorUser,
        firedBy: 'manual',
      });
      return textResult({ run_id: document.id, status: 'planning' });
    },
  });

  registerTool({
    name: 'cancel_run',
    description:
      'Cancel an agent run by id. planning|awaiting_approval → failed (cancelled). running → posts a rejection comment (in-loop cancel signal). terminal → no-op. Returns { run_id, status }.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        run_id: { type: 'string' },
      },
      required: ['workspace_slug', 'run_id'],
    },
    requiredScope: 'agents:write',
    schema: z
      .object({
        workspace_slug: z.string(),
        run_id: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const allowList = await resolveAgentAllowListForToken(token);
      const runId = requireString(args, 'run_id');
      const run = await loadRunScopedByToken(runId, { workspaceId: ws.id, allowList });
      const status = run.status as RunStatus;

      if (status === 'planning' || status === 'awaiting_approval') {
        // transitionRun writes `updatedBy` (FK → users.id), so the actor must
        // be an FK-valid user id — `ctx.actor` (the MCP route / runner supplies
        // the authenticated user id), NOT `token.id`. Mirrors D-2's serviceActor
        // convention.
        await transitionRun(run.id, {
          newStatus: 'failed',
          actor: ctx.actor,
          errorReason: 'cancelled',
        });
        return textResult({ run_id: run.id, status: 'failed' });
      }

      if (status === 'running') {
        // Mit 44 — one cancel path. A post-start kind=rejection comment is the
        // runner's in-loop cancel signal (see lib/runner.ts wasCancelled).
        if (run.parentId === null || run.projectId === null) {
          throw mcpInvalidParams('run has no parent', { reason: 'agent_run_not_found' });
        }
        const parent = await db.query.documents.findFirst({
          where: eq(documents.id, run.parentId),
        });
        if (!parent) {
          throw mcpInvalidParams('parent missing', { reason: 'agent_run_not_found' });
        }
        const project = await resolveProjectById(run.projectId);
        const runAgentSlug = (run.frontmatter as AgentRunFrontmatter).agent_slug;
        await createComment({
          workspace: ws,
          project,
          parent,
          authorContext: await resolveAuthorContextForToken(token),
          actor: token.id,
          body: 'Cancellation requested.',
          kind: 'rejection',
          targetAgent: `agent:${runAgentSlug}`,
        });
        return textResult({ run_id: run.id, status: 'running' });
      }

      // Terminal — no-op.
      return textResult({ run_id: run.id, status });
    },
  });

  registerTool({
    name: 'retry_run',
    description:
      "Retry an agent run by id. Re-resolves the original's agent + parent and creates a fresh planning run. Rejects (idempotency) if a run is still active for that parent. Returns { run_id, status }.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        run_id: { type: 'string' },
      },
      required: ['workspace_slug', 'run_id'],
    },
    requiredScope: 'agents:write',
    schema: z
      .object({
        workspace_slug: z.string(),
        run_id: z.string(),
      })
      .strict(),
    handler: async (args, ctx) => {
      const { token } = ctx;
      const ws = await resolveWorkspaceForToken(token, args);
      const allowList = await resolveAgentAllowListForToken(token);
      const runId = requireString(args, 'run_id');
      const original = await loadRunScopedByToken(runId, { workspaceId: ws.id, allowList });
      const fm = original.frontmatter as AgentRunFrontmatter;
      const agentSlug = fm.agent_slug;

      if (original.parentId === null || original.projectId === null) {
        throw mcpInvalidParams('run has no parent', { reason: 'agent_run_not_found' });
      }

      const parent = await db.query.documents.findFirst({
        where: eq(documents.id, original.parentId),
      });
      if (!parent) {
        throw mcpInvalidParams('parent missing', { reason: 'agent_run_not_found' });
      }
      // Resolve the agent by slug, instance-wide (Phase 4 — no tenancy boundary)
      // so a retry re-resolves instead of 404ing.
      const agent = await resolveAgentForRun(db, agentSlug);
      if (!agent) {
        throw mcpInvalidParams(`agent "${agentSlug}" not found`, {
          reason: 'agent_not_found',
          agent_slug: agentSlug,
        });
      }

      // Autonomy gate (mit 54) — a retry SPAWNS a fresh planning run, so an
      // agent-bound bearer retry is an agent-ORIGINATED chain hop and must be
      // gated identically to run_agent. Without this, an agent could retry a run
      // in its allow-list with chains OFF and bypass the gate (Finding 2).
      if (token.agentId && !env.FOLIO_AGENT_CHAINS_ENABLED) {
        await emitChainSuppressed(db, {
          workspaceId: ws.id,
          projectId: parent.projectId ?? null,
          documentId: parent.id,
          agentSlug,
          actor: token.id,
        });
        throw mcpInvalidParams('agent-originated chains are disabled', {
          reason: 'agent_chains_disabled',
        });
      }

      const actorUser = await resolveActorUserForToken(token);

      // m63 — the idempotency check inside createRunForParent intentionally does
      // NOT exclude the original run; a still-active original blocks the retry.
      const document = await createRunForParent({
        workspace: ws,
        parent,
        agent,
        actorUser,
        firedBy: `retry-of:${runId}`,
      });
      return textResult({ run_id: document.id, status: 'planning' });
    },
  });

  // --- Operator cockpit chat (Task 3) — the `ui` tool surface ---
  //
  // Two CHAT-ONLY tools. Both map to `documents:read` (emitting UI is not a
  // privileged op; the underlying action carries the risk, gated in T7). Each
  // handler emits a `component` message through `ctx.conversationSink`. If the
  // sink is absent — a non-chat run (document-thread / MCP / headless) called a
  // chat-only tool — the handler throws `forbidden:` so `isFatalToolError`
  // (runner.ts) terminates the run (fail-closed; ui tools are chat-only).

  registerTool({
    name: 'show_link_panel',
    description:
      'Render a clickable reference to an entity in the chat. Chat-only. The frontend resolves entityType → route; you do not author URLs.',
    requiredScope: 'documents:read',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            entityType: {
              type: 'string',
              enum: [...ENTITY_TYPES],
            },
            entityId: { type: 'string' },
            wslug: { type: 'string' },
            pslug: {
              type: 'string',
              description:
                'The project slug. REQUIRED for document/work_item (they open at the project route); omit for agent/trigger.',
            },
          },
          required: ['entityType', 'entityId', 'wslug'],
        },
        title: { type: 'string' },
        subtitle: { type: 'string' },
      },
      required: ['target', 'title'],
    },
    schema: linkPanelSchema,
    handler: async (args, ctx) => {
      if (!ctx.conversationSink) {
        throw new Error('forbidden: ui tools require a conversation context');
      }
      await ctx.conversationSink.component({
        type: 'link_panel',
        target: args.target,
        title: args.title,
        ...(args.subtitle !== undefined ? { subtitle: args.subtitle } : {}),
      });
      return textResult({ ok: true });
    },
  });

  registerTool({
    name: 'ask_choice',
    description:
      'Present a multi-option choice card in the chat and pause for the user to pick. Chat-only. At least two options, each with a stable id.',
    requiredScope: 'documents:read',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        options: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' } },
            required: ['id', 'label'],
          },
        },
      },
      required: ['prompt', 'options'],
    },
    schema: choiceCardSchema,
    handler: async (args, ctx) => {
      if (!ctx.conversationSink) {
        throw new Error('forbidden: ui tools require a conversation context');
      }
      await ctx.conversationSink.component({
        type: 'choice_card',
        prompt: args.prompt,
        options: args.options,
      });
      return textResult({ ok: true });
    },
  });

  // Phase-op-3: the operator agent's general REST bridge. folio_api_get (reads,
  // GET-forced) registers here; the write tool folio_api is added in Task 5.
  // Registered last, and in its own module, to keep this file's tool defs and
  // the bridge's mint/dispatch core (folio-api-tool.ts) separate.
  registerFolioApiTools();
} // end registerRealTools
