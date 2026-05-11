import { Hono } from 'hono';
import { type AuthContext, requireUser } from '../middleware/auth.ts';

/**
 * Document CRUD. Phase 1 work.
 *
 * Endpoints to implement:
 *   GET    /:projectId                      list, with frontmatter filters via query
 *   POST   /:projectId                      create (accepts raw MD body or structured payload)
 *   GET    /:projectId/:slug                read (returns structured + raw MD via `?format=md`)
 *   PATCH  /:projectId/:slug                update (PATCH semantics: title, status, body, frontmatter)
 *   DELETE /:projectId/:slug                soft-delete
 *
 * Writes MUST emit an event row (events table) so SSE/agents stay live.
 */
export const documentsRoute = new Hono<AuthContext>()
  .use('*', requireUser)
  .get('/health', (c) => c.json({ status: 'stub - implement in phase 1' }));

/**
 * Views (saved filters/sorts/groupings). Phase 1 work.
 *
 * Endpoints to implement:
 *   GET    /:projectId         list views for project
 *   POST   /:projectId         create
 *   PATCH  /:projectId/:viewId update
 *   DELETE /:projectId/:viewId delete
 */
export const viewsRoute = new Hono<AuthContext>()
  .use('*', requireUser)
  .get('/health', (c) => c.json({ status: 'stub - implement in phase 1' }));

/**
 * MCP server endpoint. Phase 2 work.
 *
 * This is the heart of the agent-first promise. Mount a Streamable HTTP MCP
 * transport here. Tools to expose:
 *   - list_documents(project_id, filters?)
 *   - get_document(project_id, slug)
 *   - create_document(project_id, type, title, body, frontmatter)
 *   - update_document(project_id, slug, patch)
 *   - list_projects(workspace_id)
 *   - subscribe_events (SSE stream)
 *
 * Auth via Bearer api_token (folio_pat_xxx). Token resolves to a workspace.
 */
export const mcpRoute = new Hono<AuthContext>().get('/', (c) =>
  c.json({
    server: 'folio-mcp',
    status: 'stub',
    note: 'Implement Streamable HTTP MCP transport in phase 2',
  }),
);
