/**
 * Hand-rolled JSON-RPC 2.0 MCP endpoint at POST /mcp.
 *
 * Speaks `initialize`, `tools/list`, `tools/call`, and `ping`. All tool
 * implementations delegate to the service layer in `services/*` so the MCP and
 * REST surfaces share the same writes + event emissions.
 *
 * Scope gating is INLINE (not via `requireScope` middleware) because we want
 * JSON-RPC error envelopes for scope rejections, not HTTP 403. Per-tool
 * `requiredScope` is enforced before the handler runs.
 *
 * The token's `workspaceId` is the only workspace this MCP session can access.
 * Every tool that takes `workspace_slug` checks that the slug resolves to the
 * token's workspace; otherwise it throws "workspace not accessible".
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import {
  documents,
  projects,
  tables as tablesTable,
  views as viewsTable,
  workspaces,
} from '../db/schema.ts';
import type {
  ApiToken,
  Project,
  TableEntity,
  Workspace,
} from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import {
  assertAgentAllowListWidening,
} from '../lib/agent-guards.ts';
import { serializeMarkdown } from '../lib/frontmatter.ts';
import { stripReservedFrontmatter } from '../services/documents.ts';
import {
  type AuthContext,
  getUser,
} from '../middleware/auth.ts';
import {
  attachToken,
  getToken,
  intersect,
  requireToken,
} from '../middleware/bearer.ts';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getWorkspaceDocument,
  listDocuments,
  updateDocument,
  type DocumentType,
} from '../services/documents.ts';
import { listStatuses } from '../services/statuses.ts';
import { listFields } from '../services/fields.ts';
import { listViews, runView } from '../services/views.ts';
import {
  type AuthorContext,
  createComment,
  deleteComment,
  getComment,
  listComments,
  updateComment,
} from '../services/comments.ts';
import {
  type CommentKind,
  type CommentVisibility,
  commentKindSchema,
  commentVisibilitySchema,
} from '../lib/comment-schema.ts';

// --- JSON-RPC types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- Tool registry ---

interface ToolContext {
  token: ApiToken;
  actor: { id: string };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScope: string;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function textResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function markdownResult(md: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: md }] };
}

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

/** Resolve and validate that the workspace_slug matches the token's workspace. */
async function resolveWorkspaceForToken(
  token: ApiToken,
  args: Record<string, unknown>,
): Promise<Workspace> {
  const slug = requireString(args, 'workspace_slug');
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, slug),
  });
  if (!ws || ws.id !== token.workspaceId) {
    throw new Error('workspace not accessible');
  }
  return ws;
}

/**
 * MCP JSON-RPC "invalid params" error (-32602). Carries structured `data` so the
 * agent can branch on `reason` programmatically; the human-readable `message`
 * stays brief.
 */
function mcpInvalidParams(message: string, data: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { code: number; data: Record<string, unknown> };
  err.code = -32602;
  err.data = data;
  return err;
}

/**
 * Translate an HTTPError thrown by `lib/agent-guards.ts` into the MCP-shaped
 * error so create_agent / update_agent / delete_agent all surface the same
 * `error.data.reason` strings the protocol promises.
 */
function rethrowAgentGuardAsMcp(err: unknown): never {
  if (err instanceof HTTPError) {
    if (err.code === 'ALLOW_LIST_WIDENING_FORBIDDEN') {
      throw mcpInvalidParams(err.message, { reason: 'allow_list_widening_forbidden' });
    }
    if (err.code === 'CANNOT_DELETE_SELF') {
      throw mcpInvalidParams(err.message, { reason: 'cannot_delete_self' });
    }
  }
  throw err as Error;
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

  // Phase 2.5: when the request comes through an agent-bound token, intersect
  // the agent's frontmatter.projects with the token's optional projectIds
  // narrowing and reject if the requested project isn't in the result.
  if (token.agentId) {
    const agent = await db.query.documents.findFirst({
      where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
    });
    if (!agent) {
      throw mcpInvalidParams('agent for this token no longer exists', {
        reason: 'agent_missing',
      });
    }
    const agentProjects =
      ((agent.frontmatter as { projects?: string[] }).projects) ?? ['*'];
    const effective = intersect(agentProjects, token.projectIds ?? null);
    if (!effective.includes('*') && !effective.includes(p.id)) {
      // Structured server log — needed for operators debugging "my agent is
      // silently ignoring this project". The MCP response keeps minimal data
      // (not leaky); the log carries the full reasoning trail.
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
  }
  return p;
}

/**
 * Resolve the comment author context for a bearer token.
 *
 * - Agent-bound token (`token.agentId` set) → `{ type: 'agent', agentSlug, agentId }`.
 *   The slug is looked up from the agent doc; clients never supply it.
 * - Otherwise → `{ type: 'user', userId: token.createdBy }` (human PAT / session bearer).
 *
 * Mirrors `resolveAuthorContext` in routes/comments.ts but takes a token directly
 * because MCP has no session/user context plumbing.
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
  // Human PAT: attribute the comment to the token's owner (createdBy). A
  // workspace-scoped token without a creator (legacy/system) cannot author a
  // comment — surface this as an MCP error rather than silently mis-attributing.
  if (!token.createdBy) {
    throw mcpInvalidParams('token has no owner; cannot resolve comment author', {
      reason: 'unknown_author',
    });
  }
  return { type: 'user', userId: token.createdBy };
}

/** Parse a possibly-CSV string MCP arg into a typed list (or undefined). */
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

const TOOLS: ToolDef[] = [
  {
    name: 'list_workspaces',
    description: 'List workspaces visible to the token.',
    inputSchema: { type: 'object', properties: {} },
    requiredScope: 'documents:read',
    handler: async ({ token }) => {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, token.workspaceId),
      });
      return textResult({
        workspaces: ws ? [{ id: ws.id, slug: ws.slug, name: ws.name }] : [],
      });
    },
  },
  {
    name: 'list_projects',
    description:
      'List projects in the bound workspace. For agent-bound tokens, filtered to the agent\'s allow-list.',
    inputSchema: {
      type: 'object',
      properties: { workspace_slug: { type: 'string' } },
      required: ['workspace_slug'],
    },
    requiredScope: 'documents:read',
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const all = await db.query.projects.findMany({
        where: eq(projects.workspaceId, ws.id),
      });
      // Human PAT or no agent binding — return all.
      if (!token.agentId) {
        return textResult({
          projects: all.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
        });
      }
      const agent = await db.query.documents.findFirst({
        where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
      });
      const agentProjects =
        ((agent?.frontmatter as { projects?: string[] })?.projects) ?? ['*'];
      const effective = intersect(agentProjects, token.projectIds ?? null);
      const filtered = effective.includes('*')
        ? all
        : all.filter((p) => effective.includes(p.id));
      return textResult({
        projects: filtered.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
      });
    },
  },
  {
    name: 'list_documents',
    description: 'List documents in a project. Optional type filter and pagination.',
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const type = optionalString(args, 'type');
      // For work_item lists, default to the project's first table unless
      // table_slug is given. For all other type filters, leave activeTableId
      // null so the service applies its default selection.
      let activeTableId: string | null = null;
      if (type === 'work_item') {
        const t = await resolveTableForArgs(p, args);
        activeTableId = t.id;
      }
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 50;
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
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const doc = await getDocument(p.id, slug);
      if (!doc) throw new Error('document not found');
      return textResult(doc);
    },
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const doc = await getDocument(p.id, slug);
      if (!doc) throw new Error('document not found');
      // Mirror documents.ts GET /:slug.md: strip reserved keys, then layer
      // canonical column values on top so they win.
      const userFm = stripReservedFrontmatter(
        (doc.frontmatter as Record<string, unknown>) ?? {},
      );
      const fm: Record<string, unknown> = {
        ...userFm,
        type: doc.type,
        title: doc.title,
        ...(doc.status ? { status: doc.status } : {}),
        ...(doc.lastTouchedAt
          ? { last_touched_at: doc.lastTouchedAt.toISOString() }
          : {}),
      };
      const md = serializeMarkdown({ frontmatter: fm, body: doc.body });
      return markdownResult(md);
    },
  },
  {
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
    handler: async ({ token, actor }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const type = requireString(args, 'type') as DocumentType;
      // Phase 2.5: agent/trigger lifecycle is HTTP-only in this phase.
      // create_agent / create_trigger MCP tools ship in Phase 2.6.
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

      const table =
        type === 'work_item' ? await resolveTableForArgs(p, args) : null;

      const { document, agentTokenPlaintext } = await createDocument({
        workspace: ws,
        project: p,
        table,
        actor: actor as never,
        token,
        // MCP never routes through a table-scoped URL. The service uses this
        // flag to reject agent/trigger creation on table URLs — irrelevant
        // here.
        isTableScopedUrl: false,
        input: { type, title, body, frontmatter, status: statusArg },
      });

      const payload = agentTokenPlaintext
        ? { ...document, agent_token: agentTokenPlaintext }
        : document;
      return textResult(payload);
    },
  },
  {
    name: 'update_document',
    description:
      'Patch a document. Supplied frontmatter is shallow-merged into the existing frontmatter (null values delete keys). Reserved keys (type, title, status, last_touched_at) live as columns and are ignored when present in frontmatter.',
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
    handler: async ({ token, actor }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getDocument(p.id, slug);
      if (!existing) throw new Error('document not found');
      // Phase 2.5: agent/trigger mutation is HTTP-only in this phase.
      if (existing.type === 'agent' || existing.type === 'trigger') {
        throw mcpInvalidParams(
          `${existing.type} documents cannot be mutated via MCP in Phase 2.5; use PATCH /api/v1/w/:wslug/documents/${slug}`,
          { reason: 'agent_lifecycle_via_http_only' },
        );
      }
      // F5: comments must go through update_comment so the author-only guard
      // + soft-delete + kind-immutable invariants apply.
      if (existing.type === 'comment') {
        throw mcpInvalidParams(
          'comment documents must be mutated via the update_comment tool',
          { reason: 'comment_requires_comment_tool' },
        );
      }

      // For work_item patches, surface a fallback table only if the doc has
      // none (legacy rows). The service tolerates `null` here for non-work_item
      // updates.
      let fallbackTable: TableEntity | null = null;
      if (existing.type === 'work_item' && !existing.tableId) {
        const t = await db.query.tables.findFirst({
          where: eq(tablesTable.projectId, p.id),
          orderBy: (col, { asc }) => [asc(col.order)],
        });
        fallbackTable = t ?? null;
      }

      const patch: Parameters<typeof updateDocument>[0]['patch'] = {};
      if (typeof args['title'] === 'string') patch.title = args['title'];
      if (typeof args['body'] === 'string') patch.body = args['body'];
      if (
        typeof args['status'] === 'string' ||
        args['status'] === null
      ) {
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
        actor: actor as never,
        existing,
        patch,
      });
      return textResult(updated);
    },
  },
  {
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
    handler: async ({ token, actor }, args) => {
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
      // F5: comments must go through delete_comment (soft-delete + author guard).
      if (existing.type === 'comment') {
        throw mcpInvalidParams(
          'comment documents must be deleted via the delete_comment tool',
          { reason: 'comment_requires_comment_tool' },
        );
      }
      await deleteDocument({
        workspace: ws,
        project: p,
        actor: actor as never,
        existing,
      });
      return textResult({ ok: true, slug });
    },
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const t = await resolveTableForArgs(p, args);
      const list = await listStatuses(t.id);
      return textResult({ table: { id: t.id, slug: t.slug }, statuses: list });
    },
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const t = await resolveTableForArgs(p, args);
      const list = await listFields(t.id);
      return textResult({ table: { id: t.id, slug: t.slug }, fields: list });
    },
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const t = await resolveTableForArgs(p, args);
      const list = await listViews(t.id);
      return textResult({ table: { id: t.id, slug: t.slug }, views: list });
    },
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const p = await resolveProjectInWorkspace(ws, token, args);
      const t = await resolveTableForArgs(p, args);
      // Views don't have a slug column in v1, so accept either view_id or
      // view name match via view_slug (slugified name match would be brittle
      // — use view_id when known).
      const viewId = optionalString(args, 'view_id');
      const viewSlug = optionalString(args, 'view_slug');
      let view = null;
      if (viewId) {
        view = await db.query.views.findFirst({
          where: and(eq(viewsTable.tableId, t.id), eq(viewsTable.id, viewId)),
        });
      } else if (viewSlug) {
        // Fallback: look up by name (case-insensitive exact match). Views have
        // no slug column; we accept the human name here.
        const candidates = await db.query.views.findMany({
          where: eq(viewsTable.tableId, t.id),
        });
        view =
          candidates.find(
            (v) => v.name.toLowerCase() === viewSlug.toLowerCase(),
          ) ?? null;
      } else {
        // No identifier — return the default view if one exists.
        view = await db.query.views.findFirst({
          where: and(eq(viewsTable.tableId, t.id), eq(viewsTable.isDefault, true)),
        });
      }
      if (!view) throw new Error('view not found');
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 50;
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
  },

  // ---------------------------------------------------------------------------
  // Phase 2.6 — comment tools (delegate to services/comments.ts).
  //
  // Author resolution: agent-bound tokens always post as `agent:<slug>`; clients
  // do NOT supply `author`. Human PATs post as `user:<creator>`. The service
  // handles mention parsing + approval-keyword detection. Update/delete enforce
  // author-only at the service layer; this route catches COMMENT_AUTHOR_ONLY
  // and re-throws as a structured JSON-RPC error so agents can branch on
  // `data.reason`.
  // ---------------------------------------------------------------------------
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const parentSlug = requireString(args, 'parent_slug');
      const parent = await db.query.documents.findFirst({
        where: and(eq(documents.projectId, project.id), eq(documents.slug, parentSlug)),
      });
      if (!parent) throw new Error(`parent ${parentSlug} not found`);

      const authorContext = await resolveAuthorContextForToken(token);
      const body = requireString(args, 'body');

      // Narrow the enum-typed args through the same Zod parsers the route uses,
      // so an invalid value surfaces a clean JSON-RPC error instead of leaking
      // into the service.
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
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const parentSlug = requireString(args, 'parent_slug');
      const parent = await db.query.documents.findFirst({
        where: and(eq(documents.projectId, project.id), eq(documents.slug, parentSlug)),
      });
      if (!parent) throw new Error(`parent ${parentSlug} not found`);

      // `kind` and `visibility` accept a single value or a comma-separated list,
      // matching the REST query convention (?kind=plan,result).
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
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getComment(ws.id, slug);
      if (!existing) throw new Error('comment not found');
      // Defense-in-depth: comments live under a project; verify the slug the
      // caller passed belongs to THIS project. (resolveProjectInWorkspace already
      // applied the agent allow-list check.)
      if (existing.projectId !== project.id) {
        throw new Error('comment not found');
      }

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
  },
  {
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
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const project = await resolveProjectInWorkspace(ws, token, args);
      const slug = requireString(args, 'slug');
      const existing = await getComment(ws.id, slug);
      if (!existing) throw new Error('comment not found');
      if (existing.projectId !== project.id) {
        throw new Error('comment not found');
      }

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
  },

  // ---------------------------------------------------------------------------
  // Phase 2.6 sub-phase D — agent-lifecycle tools.
  //
  // create_agent / update_agent / delete_agent all delegate to the same
  // service layer the workspace-scoped HTTP routes use (see
  // routes/workspace-documents.ts). create_agent returns the freshly minted
  // bearer token as `agent_token` on the response (one-time reveal — same
  // contract as the HTTP POST). update_agent enforces an allow-list-widening
  // guard: an agent-bound token cannot patch a target agent's
  // frontmatter.projects to include project ids it doesn't have itself.
  // delete_agent rejects self-delete. get_agent_self is read-only and
  // requires only documents:read but additionally needs the token to be
  // agent-bound.
  // ---------------------------------------------------------------------------
  {
    name: 'create_agent',
    description:
      'Create a workspace-scoped agent document. Mints a bearer token and returns it ONCE in the response as `agent_token`. The token is scoped to the calling token\'s workspace.',
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
    handler: async ({ token, actor }, args) => {
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

      // Reject child agents whose allow-list widens past the calling agent's
      // own. update_agent has had this guard since Phase 2.6 D8; create_agent
      // was missing it (Phase 2.6 review finding F2).
      await assertAgentAllowListWidening(token, frontmatter).catch(rethrowAgentGuardAsMcp);

      const { document, agentTokenPlaintext } = await createDocument({
        workspace: ws,
        project: null,
        table: null,
        actor: actor as never,
        token,
        isTableScopedUrl: false,
        input: { type: 'agent', title, body, frontmatter, status: null },
      });

      return textResult({
        ...document,
        ...(agentTokenPlaintext ? { agent_token: agentTokenPlaintext } : {}),
      });
    },
  },
  {
    name: 'update_agent',
    description:
      'Patch an existing workspace-scoped agent document. Reserved keys are ignored. When called with an agent-bound token, the target\'s frontmatter.projects allow-list cannot be widened beyond the calling agent\'s own allow-list.',
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
    handler: async ({ token, actor }, args) => {
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
      if (typeof args['title'] === 'string') patch.title = args['title'];
      if (typeof args['body'] === 'string') patch.body = args['body'];
      const fmArg = args['frontmatter'];
      if (fmArg !== undefined) {
        if (!fmArg || typeof fmArg !== 'object' || Array.isArray(fmArg)) {
          throw mcpInvalidParams('frontmatter must be an object', {
            reason: 'invalid_frontmatter',
          });
        }
        patch.frontmatter = fmArg as Record<string, unknown>;

        // Allow-list widening guard — shared with create_agent and the HTTP
        // workspace-documents routes via lib/agent-guards.ts.
        await assertAgentAllowListWidening(token, patch.frontmatter).catch(rethrowAgentGuardAsMcp);
      }

      const updated = await updateDocument({
        workspace: ws,
        project: null,
        fallbackTable: null,
        actor: actor as never,
        existing,
        patch,
      });
      return textResult(updated);
    },
  },
  {
    name: 'delete_agent',
    description:
      'Soft-delete a workspace-scoped agent document. Cascades to revoke the agent\'s bearer token. Rejects self-delete when called with an agent-bound token.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['workspace_slug', 'slug'],
    },
    requiredScope: 'agents:write',
    handler: async ({ token, actor }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const slug = requireString(args, 'slug');
      const existing = await getWorkspaceDocument(ws.id, 'agent', slug);
      if (!existing) {
        throw mcpInvalidParams(`agent ${slug} not found`, {
          reason: 'agent_not_found',
          slug,
        });
      }
      // Self-delete guard: only meaningful when the call comes from an
      // agent-bound token.
      if (token.agentId && existing.id === token.agentId) {
        throw mcpInvalidParams('agent cannot delete itself via MCP', {
          reason: 'cannot_delete_self',
        });
      }

      await deleteDocument({
        workspace: ws,
        project: null,
        actor: actor as never,
        existing,
      });
      return textResult({ ok: true, slug });
    },
  },
  {
    name: 'get_agent_self',
    description:
      'Return the calling agent\'s own document. Requires an agent-bound bearer token; user-minted (PAT) tokens have no agent identity and receive an error.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiredScope: 'documents:read',
    handler: async ({ token }) => {
      if (!token.agentId) {
        throw mcpInvalidParams(
          'get_agent_self requires an agent-bound token',
          { reason: 'no_agent_bound_to_token' },
        );
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
  },
];

// --- Route ---

const mcpRoute = new Hono<AuthContext>();
mcpRoute.use('*', attachToken, requireToken);

mcpRoute.post('/', async (c) => {
  let body: JsonRpcRequest;
  try {
    body = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return c.json<JsonRpcResponse>(
      {
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32700, message: 'parse error' },
      },
      200,
    );
  }

  const id = body.id;
  const token = getToken(c);
  const actor = getUser(c);

  if (body.method === 'initialize') {
    return c.json<JsonRpcResponse>({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'folio', version: '0.1.0' },
        capabilities: { tools: {} },
      },
    });
  }

  if (body.method === 'ping') {
    return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id, result: {} });
  }

  if (body.method === 'tools/list') {
    return c.json<JsonRpcResponse>({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
  }

  if (body.method === 'tools/call') {
    const params = (body.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) {
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unknown tool: ${params.name ?? '?'}` },
      });
    }
    if (!token.scopes.includes(tool.requiredScope)) {
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `tool ${tool.name} requires scope: ${tool.requiredScope}`,
          data: { tool: tool.name, required_scope: tool.requiredScope },
        },
      });
    }
    try {
      const result = await tool.handler(
        { token, actor: { id: actor.id } },
        params.arguments ?? {},
      );
      return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const message =
        err instanceof HTTPError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Errors thrown via mcpInvalidParams() carry their own `code` and `data`.
      const e = err as { code?: number; data?: unknown };
      const code = typeof e.code === 'number' ? e.code : -32603;
      const data = e.data;
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0',
        id,
        error: data !== undefined ? { code, message, data } : { code, message },
      });
    }
  }

  return c.json<JsonRpcResponse>({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not supported: ${body.method}` },
  });
});

export { mcpRoute };
