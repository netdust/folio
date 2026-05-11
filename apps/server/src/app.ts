import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { env } from './env.ts';
import { registerErrorHandler } from './lib/http.ts';
import { attachUser, requireUser, type AuthContext } from './middleware/auth.ts';
import { resolveProject, resolveWorkspace, type ScopeContext } from './middleware/scope.ts';
import { auth } from './routes/auth.ts';
import { fieldsRoute } from './routes/fields.ts';
import { healthRoute } from './routes/health.ts';
import { projectsRoute } from './routes/projects.ts';
import { settingsRoute } from './routes/settings.ts';
import { statusesRoute } from './routes/statuses.ts';
import { tokensRoute } from './routes/tokens.ts';
import { workspacesRoute } from './routes/workspaces.ts';

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
wScope.use('*', requireUser, resolveWorkspace);
wScope.route('/settings', settingsRoute);
wScope.route('/tokens', tokensRoute);
wScope.route('/projects', projectsRoute);

const pScope = new Hono<AuthContext & ScopeContext>();
pScope.use('*', resolveProject);
pScope.route('/statuses', statusesRoute);
pScope.route('/fields', fieldsRoute);
// pScope (documents/views) further routes mounted in later tasks

wScope.route('/p/:pslug', pScope);

v1.route('/w/:wslug', wScope);
app.route('/api/v1', v1);

// --- health (unversioned) ---
app.route('/', healthRoute);

// --- static SPA (prod) ---
if (env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: '../web/dist' }));
  app.get('/*', serveStatic({ path: '../web/dist/index.html' }));
}
