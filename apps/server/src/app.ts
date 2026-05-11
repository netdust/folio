import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { env } from './env.ts';
import { onError } from './middleware/error.ts';
import { attachUser, type AuthContext } from './middleware/auth.ts';
import { auth } from './routes/auth.ts';
import { settingsRoute } from './routes/settings.ts';
import { documentsRoute, mcpRoute, viewsRoute } from './routes/stubs.ts';
import { tokensRoute } from './routes/tokens.ts';
import { workspacesRoute } from './routes/workspaces.ts';

export const app = new Hono<AuthContext>();
app.onError(onError);

app.use('*', logger());
app.use('*', attachUser);

// --- API ---
const api = new Hono<AuthContext>();
api.route('/auth', auth);
api.route('/workspaces', workspacesRoute);
api.route('/documents', documentsRoute);
api.route('/views', viewsRoute);
api.route('/settings', settingsRoute);
api.route('/tokens', tokensRoute);
api.get('/health', (c) => c.json({ status: 'ok', version: '0.0.1' }));

app.route('/api', api);

// --- MCP (agent-facing surface) ---
app.route('/mcp', mcpRoute);

// --- Static SPA ---
if (env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: '../web/dist' }));
  app.get('/*', serveStatic({ path: '../web/dist/index.html' }));
}
