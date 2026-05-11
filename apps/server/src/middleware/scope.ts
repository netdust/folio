import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { memberships, projects, workspaces } from '../db/schema.ts';
import type { Workspace, Project } from '../db/schema.ts';
import type { AuthContext } from './auth.ts';
import { HTTPError } from '../lib/http.ts';

export type Role = 'owner' | 'admin' | 'member';

export interface ScopeContext {
  Variables: {
    workspace?: Workspace;
    project?: Project;
    role?: Role;
  };
}

export const resolveWorkspace: MiddlewareHandler<AuthContext & ScopeContext> = async (c, next) => {
  const wslug = c.req.param('wslug');
  if (!wslug) throw new HTTPError('WORKSPACE_NOT_FOUND', 'missing :wslug', 404);

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, wslug) });
  if (!ws) throw new HTTPError('WORKSPACE_NOT_FOUND', `workspace "${wslug}" not found`, 404);

  const user = c.get('user');
  if (!user) throw new HTTPError('UNAUTHENTICATED', 'login required', 401);

  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, user.id)),
  });
  if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);

  c.set('workspace', ws);
  c.set('role', m.role as Role);
  return next();
};

export const resolveProject: MiddlewareHandler<AuthContext & ScopeContext> = async (c, next) => {
  const ws = c.get('workspace');
  if (!ws) throw new HTTPError('WORKSPACE_NOT_FOUND', 'resolveWorkspace must run first', 500);
  const pslug = c.req.param('pslug');
  if (!pslug) throw new HTTPError('PROJECT_NOT_FOUND', 'missing :pslug', 404);
  const p = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, pslug)),
  });
  if (!p) throw new HTTPError('PROJECT_NOT_FOUND', `project "${pslug}" not found`, 404);
  c.set('project', p);
  return next();
};

export function getWorkspace(c: Context<AuthContext & ScopeContext>): Workspace {
  const ws = c.get('workspace');
  if (!ws) throw new Error('workspace not attached');
  return ws;
}

export function getProject(c: Context<AuthContext & ScopeContext>): Project {
  const p = c.get('project');
  if (!p) throw new Error('project not attached');
  return p;
}

export function getRole(c: Context<AuthContext & ScopeContext>): Role {
  const r = c.get('role');
  if (!r) throw new Error('role not attached');
  return r;
}
