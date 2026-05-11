import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { memberships, projects, workspaces } from '../db/schema.ts';
import { slugify } from '@folio/shared';
import { type AuthContext, getUser, requireUser } from '../middleware/auth.ts';

const workspacesRoute = new Hono<AuthContext>();

workspacesRoute.use('*', requireUser);

// List workspaces the user belongs to
workspacesRoute.get('/', async (c) => {
  const user = getUser(c);
  const rows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, user.id));
  return c.json({ workspaces: rows });
});

// Create a workspace (creator becomes owner)
workspacesRoute.post(
  '/',
  zValidator('json', z.object({ name: z.string().min(1).max(80) })),
  async (c) => {
    const user = getUser(c);
    const { name } = c.req.valid('json');
    const id = nanoid();
    const slug = `${slugify(name)}-${id.slice(0, 6)}`;
    await db.insert(workspaces).values({ id, slug, name });
    await db.insert(memberships).values({ workspaceId: id, userId: user.id, role: 'owner' });
    return c.json({ workspace: { id, slug, name } });
  },
);

// List projects in a workspace
workspacesRoute.get('/:workspaceId/projects', async (c) => {
  const user = getUser(c);
  const workspaceId = c.req.param('workspaceId');
  // membership check
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
  });
  if (!m) return c.json({ error: 'not a member' }, 403);

  const rows = await db.query.projects.findMany({
    where: eq(projects.workspaceId, workspaceId),
  });
  return c.json({ projects: rows });
});

// Create a project
workspacesRoute.post(
  '/:workspaceId/projects',
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(80), icon: z.string().optional() }),
  ),
  async (c) => {
    const user = getUser(c);
    const workspaceId = c.req.param('workspaceId');
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
    });
    if (!m) return c.json({ error: 'not a member' }, 403);

    const { name, icon } = c.req.valid('json');
    const id = nanoid();
    const slug = slugify(name);
    await db.insert(projects).values({ id, workspaceId, slug, name, icon });
    return c.json({ project: { id, workspaceId, slug, name, icon } });
  },
);

export { workspacesRoute };
