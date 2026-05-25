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
import { serializeMarkdown } from '../lib/frontmatter.ts';
import { stripReservedFrontmatter } from '../services/documents.ts';
import {
  type AuthContext,
  getUser,
} from '../middleware/auth.ts';
import {
  attachToken,
  getToken,
  requireToken,
} from '../middleware/bearer.ts';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
  type DocumentType,
} from '../services/documents.ts';
import { listStatuses } from '../services/statuses.ts';
import { listFields } from '../services/fields.ts';
import { listViews, runView } from '../services/views.ts';

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

async function resolveProjectInWorkspace(
  ws: Workspace,
  args: Record<string, unknown>,
): Promise<Project> {
  const slug = requireString(args, 'project_slug');
  const p = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, slug)),
  });
  if (!p) throw new Error('project not found');
  return p;
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
    description: 'List projects in a workspace.',
    inputSchema: {
      type: 'object',
      properties: { workspace_slug: { type: 'string' } },
      required: ['workspace_slug'],
    },
    requiredScope: 'documents:read',
    handler: async ({ token }, args) => {
      const ws = await resolveWorkspaceForToken(token, args);
      const list = await db.query.projects.findMany({
        where: eq(projects.workspaceId, ws.id),
      });
      return textResult({
        projects: list.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      const p = await resolveProjectInWorkspace(ws, args);
      const type = requireString(args, 'type') as DocumentType;
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
      const p = await resolveProjectInWorkspace(ws, args);
      const slug = requireString(args, 'slug');
      const existing = await getDocument(p.id, slug);
      if (!existing) throw new Error('document not found');

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
      const p = await resolveProjectInWorkspace(ws, args);
      const slug = requireString(args, 'slug');
      const existing = await getDocument(p.id, slug);
      if (!existing) throw new Error('document not found');
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      const p = await resolveProjectInWorkspace(ws, args);
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
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message },
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
