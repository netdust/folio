/**
 * Workspace-scoped document routes for agents and triggers (Phase 2.5).
 *
 * Mounted at /api/v1/w/:wslug/documents. Auth + workspace resolution happen
 * upstream via wScope; this router only accepts type=agent or type=trigger
 * (the project-scoped router rejects those types with INVALID_DOCUMENT_SCOPE).
 */
import { Hono } from 'hono';
import { documentCreateSchema, documentPatchSchema } from '@folio/shared';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import {
  createDocument,
  deleteDocument,
  getWorkspaceDocument,
  listWorkspaceDocuments,
  stripReservedFrontmatter,
  updateDocument,
  type DocumentType,
} from '../services/documents.ts';

export const workspaceDocumentsRoute = new Hono<AuthContext & ScopeContext>();

function assertWorkspaceType(type: unknown): asserts type is 'agent' | 'trigger' {
  if (type !== 'agent' && type !== 'trigger') {
    throw new HTTPError(
      'INVALID_DOCUMENT_SCOPE',
      'workspace-scoped documents must be type=agent or type=trigger',
      422,
    );
  }
}

workspaceDocumentsRoute.post('/', requireScope('documents:write'), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const json = await c.req.json();
  const parsed = documentCreateSchema.safeParse(json);
  if (!parsed.success) {
    throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
  }
  const v = parsed.data;
  assertWorkspaceType(v.type);

  const fmStatus = typeof v.frontmatter?.status === 'string' ? v.frontmatter.status : null;
  const fmRest = stripReservedFrontmatter((v.frontmatter ?? {}) as Record<string, unknown>);

  const { document, agentTokenPlaintext } = await createDocument({
    workspace: ws,
    project: null,
    table: null,
    actor: user,
    token: c.get('token'),
    isTableScopedUrl: false,
    input: { type: v.type, title: v.title, body: v.body, frontmatter: fmRest, status: fmStatus },
  });

  const responseData = agentTokenPlaintext
    ? { ...document, agent_token: agentTokenPlaintext }
    : document;
  return jsonOk(c, responseData, 201);
});

workspaceDocumentsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);
  const type = c.req.query('type');
  assertWorkspaceType(type);
  const projectFilter = c.req.query('project') ?? null;

  const rows = await listWorkspaceDocuments({
    workspaceId: ws.id,
    type,
    projectFilter,
  });
  return c.json({ data: rows });
});

workspaceDocumentsRoute.get('/:slug', async (c) => {
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  // Search both types; the (workspace_id, type, slug) index makes either lookup cheap.
  const row =
    (await getWorkspaceDocument(ws.id, 'agent', slug)) ??
    (await getWorkspaceDocument(ws.id, 'trigger', slug));
  if (!row) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  return jsonOk(c, row);
});

workspaceDocumentsRoute.patch('/:slug', requireScope('documents:write'), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing =
    (await getWorkspaceDocument(ws.id, 'agent', slug)) ??
    (await getWorkspaceDocument(ws.id, 'trigger', slug));
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const json = await c.req.json();
  const parsed = documentPatchSchema.safeParse(json);
  if (!parsed.success) throw new HTTPError('INVALID_BODY', parsed.error.message, 422);

  const updated = await updateDocument({
    workspace: ws,
    project: null,
    fallbackTable: null,
    actor: user,
    existing,
    patch: parsed.data,
  });
  return jsonOk(c, updated);
});

workspaceDocumentsRoute.delete('/:slug', requireScope('documents:delete'), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const slug = c.req.param('slug');
  const existing =
    (await getWorkspaceDocument(ws.id, 'agent', slug)) ??
    (await getWorkspaceDocument(ws.id, 'trigger', slug));
  if (!existing) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);
  await deleteDocument({ workspace: ws, project: null, actor: user, existing });
  return c.body(null, 204);
});
