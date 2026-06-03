import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { memberships, projects, tables, workspaces } from '../db/schema.ts';
import type { Project, TableEntity, Workspace } from '../db/schema.ts';
import type { AuthContext } from './auth.ts';
import { HTTPError } from '../lib/http.ts';
import { isInstanceReach } from '../lib/token-reach.ts';

export type Role = 'owner' | 'admin' | 'member';

export interface ScopeContext {
  Variables: {
    workspace?: Workspace;
    project?: Project;
    table?: TableEntity;
    role?: Role;
  };
}

export const resolveWorkspace: MiddlewareHandler<AuthContext & ScopeContext> = async (c, next) => {
  const wslug = c.req.param('wslug');
  if (!wslug) throw new HTTPError('WORKSPACE_NOT_FOUND', 'missing :wslug', 404);

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, wslug) });
  if (!ws) throw new HTTPError('WORKSPACE_NOT_FOUND', `workspace "${wslug}" not found`, 404);

  const user = c.get('user');
  const token = c.get('token');

  // Instance-reach token (workspaceId null) may target any workspace; a pinned
  // token must match its own. (During an agent RUN the NARROWED run token is
  // passed, so this also enforces the per-run floor — runner.ts Task A8.)
  if (token && !isInstanceReach(token) && token.workspaceId !== ws.id) {
    throw new HTTPError('FORBIDDEN', 'token does not belong to this workspace', 403);
  }

  // Authentication is still required — an instance token bypasses MEMBERSHIP,
  // not auth. A human-minted instance token's creator is hydrated into `user`
  // by attachToken; the system operator token (createdBy null) never reaches
  // this REST path.
  if (!user) throw new HTTPError('UNAUTHENTICATED', 'login required', 401);

  if (token && isInstanceReach(token)) {
    // Instance token: owner-equivalent by capability, not per-workspace
    // membership. Skip the membership requirement; role is owner for downstream
    // getRole() consumers (config gates etc.).
    c.set('role', 'owner');
  } else {
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, user.id)),
    });
    if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);
    c.set('role', m.role as Role);
  }

  c.set('workspace', ws);
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

  // Always look up the project's default "Work Items" table and attach it.
  // On /p/:pslug/* legacy routes, this is the only table the handlers can see.
  // On /p/:pslug/t/:tslug/* explicit routes, resolveTable runs next and
  // overwrites this with the explicit table. (Parent middleware in Hono does
  // not see child-router URL params, so we can't conditionally skip based on
  // :tslug — the query runs every request either way.)
  // Soft-fail: a project that pre-dates the default-table backfill (or had its
  // only table deleted) simply has no table attached; routes that require one
  // will throw at getTable(c).
  const defaultTable = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, 'work-items')),
  });
  if (defaultTable) c.set('table', defaultTable);

  return next();
};

export const resolveTable: MiddlewareHandler<AuthContext & ScopeContext> = async (c, next) => {
  const p = c.get('project');
  if (!p) throw new HTTPError('PROJECT_NOT_FOUND', 'resolveProject must run first', 500);
  const tslug = c.req.param('tslug');
  if (!tslug) throw new HTTPError('TABLE_NOT_FOUND', 'missing :tslug', 404);
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, tslug)),
  });
  if (!t) throw new HTTPError('TABLE_NOT_FOUND', `table "${tslug}" not found`, 404);
  c.set('table', t);
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

export function getTable(c: Context<AuthContext & ScopeContext>): TableEntity {
  const t = c.get('table');
  if (!t) throw new Error('table not attached');
  return t;
}

export function getRole(c: Context<AuthContext & ScopeContext>): Role {
  const r = c.get('role');
  if (!r) throw new Error('role not attached');
  return r;
}
