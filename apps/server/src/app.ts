import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { env } from './env.ts';
import { registerErrorHandler } from './lib/http.ts';
import { attachUser, type AuthContext } from './middleware/auth.ts';
import { attachToken, requireResource, requireUserOrToken } from './middleware/bearer.ts';
import {
  resolveProject,
  resolveTable,
  resolveWorkspace,
  type ScopeContext,
} from './middleware/scope.ts';
import { auth } from './routes/auth.ts';
import { documentsRoute } from './routes/documents.ts';
import { eventsRoute } from './routes/events.ts';
import { fieldsRoute } from './routes/fields.ts';
import { healthRoute } from './routes/health.ts';
import { mcpRoute } from './routes/mcp.ts';
import { projectItemRoute, projectsRoute } from './routes/projects.ts';
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
wScope.route('/settings', settingsRoute);
wScope.route('/tokens', tokensRoute);
wScope.route('/events', eventsRoute);
wScope.route('/documents', workspaceDocumentsRoute);
wScope.route('/projects', projectsRoute);

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
