import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env } from './env.ts';
import { registerErrorHandler } from './lib/http.ts';
import { type AuthContext, attachUser } from './middleware/auth.ts';
import { attachToken, requireResource, requireUserOrToken } from './middleware/bearer.ts';
import {
  type ScopeContext,
  resolveProject,
  resolveTable,
  resolveWorkspace,
} from './middleware/scope.ts';
import { aiRoute } from './routes/ai.ts';
import { auth } from './routes/auth.ts';
import { commentsRoute } from './routes/comments.ts';
import { documentsRoute } from './routes/documents.ts';
import { eventsRoute } from './routes/events.ts';
import { fieldsRoute } from './routes/fields.ts';
import { healthRoute } from './routes/health.ts';
import { mcpRoute } from './routes/mcp.ts';
import { projectItemRoute, projectsRoute } from './routes/projects.ts';
import { providerHealthRoute, runsListRoute, runsRoute } from './routes/runs.ts';
import { settingsRoute } from './routes/settings.ts';
import { statusesRoute } from './routes/statuses.ts';
import { tablesRoute } from './routes/tables.ts';
import { tokensRoute } from './routes/tokens.ts';
import { viewsRoute } from './routes/views.ts';
import { workspaceDocumentsRoute } from './routes/workspace-documents.ts';
import { workspaceItemRoute, workspacesRoute } from './routes/workspaces.ts';

export const app = new Hono<AuthContext & ScopeContext>();
registerErrorHandler(app);

if (env.NODE_ENV !== 'production') {
  app.use('*', cors({ origin: ['http://localhost:5173'], credentials: true }));
}
app.use('*', logger());
app.use('*', attachUser);

// --- /api/v1 ---
const v1 = new Hono<AuthContext & ScopeContext>();
v1.route('/auth', auth);
v1.route('/workspaces', workspacesRoute);

const wScope = new Hono<AuthContext & ScopeContext>();
wScope.use('*', attachToken, requireUserOrToken, resolveWorkspace);
wScope.route('/ai', aiRoute);
wScope.route('/settings', settingsRoute);
wScope.route('/tokens', tokensRoute);
wScope.route('/events', eventsRoute);
wScope.route('/documents', workspaceDocumentsRoute);
wScope.route('/projects', projectsRoute);
// Runs: id-addressed verbs (single/create/cancel/retry) are workspace-scoped —
// a run id is globally unique and these derive the allow-list inline (m58).
wScope.route('/runs', runsRoute);
wScope.route('/provider-health', providerHealthRoute);

const pScope = new Hono<AuthContext & ScopeContext>();
// Phase 2.5: resolveProject must run before requireResource (the gate reads
// c.get('project')). requireResource bypasses session requests and human PATs;
// only agent-bound bearers are checked against frontmatter.projects.
pScope.use('*', resolveProject, requireResource());
pScope.route('/tables', tablesRoute);

// Explicit-table mount: same handlers, but resolveTable attaches the table
// chosen via :tslug instead of relying on resolveProject's default-attach.
const tScope = new Hono<AuthContext & ScopeContext>();
tScope.use('*', resolveTable);
tScope.route('/statuses', statusesRoute);
tScope.route('/fields', fieldsRoute);
tScope.route('/views', viewsRoute);
tScope.route('/documents', documentsRoute);
pScope.route('/t/:tslug', tScope);

pScope.route('/statuses', statusesRoute);
pScope.route('/fields', fieldsRoute);
pScope.route('/views', viewsRoute);
pScope.route('/documents', documentsRoute);
// Runs list is project-scoped: resolveProject + requireResource() already
// enforced the agent allow-list upstream (m24 narrowing via the filter).
pScope.route('/runs', runsListRoute);
// Comments mount: one router handles both parent-scoped POST/GET-list and
// item-scoped GET/PATCH/DELETE via full internal paths. Mounted at '/' under
// pScope so resolveProject + requireResource() apply (Phase 2.5).
pScope.route('/', commentsRoute);
pScope.route('/', projectItemRoute);

wScope.route('/p/:pslug', pScope);
wScope.route('/', workspaceItemRoute);

v1.route('/w/:wslug', wScope);
app.route('/api/v1', v1);

// --- /mcp (root-level JSON-RPC endpoint, not under /api/v1) ---
app.route('/mcp', mcpRoute);

// --- health (unversioned) ---
app.route('/', healthRoute);

// --- static SPA (prod) ---
if (env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: '../web/dist' }));
  app.get('/*', serveStatic({ path: '../web/dist/index.html' }));
}
