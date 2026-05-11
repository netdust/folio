import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { slugify } from '@folio/shared';
import { db } from '../db/client.ts';
import { projects } from '../db/schema.ts';
import { emitEvent } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { slugUniqueInProjects } from '../lib/slug-unique.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import {
  type ScopeContext,
  getProject,
  getRole,
  getWorkspace,
  resolveProject,
} from '../middleware/scope.ts';

const projectsRoute = new Hono<AuthContext & ScopeContext>();

// Mounted under wScope, which has already run resolveWorkspace + requireUser.

projectsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);
  const rows = await db.query.projects.findMany({
    where: eq(projects.workspaceId, ws.id),
  });
  return jsonOk(c, rows);
});

projectsRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      slug: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      icon: z.string().max(32).optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const ws = getWorkspace(c);
    const { name, slug: explicit, icon } = c.req.valid('json');
    const id = nanoid();

    let slug = explicit ?? slugify(name);
    if (explicit) {
      const existing = await db.query.projects.findFirst({
        where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, explicit)),
      });
      if (existing)
        throw new HTTPError('SLUG_CONFLICT', `slug "${explicit}" is taken in this workspace`, 409);
    } else {
      slug = await slugUniqueInProjects(db, ws.id, slug || 'project');
    }

    await db.transaction(async (tx) => {
      await tx.insert(projects).values({ id, workspaceId: ws.id, slug, name, icon: icon ?? null });
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: id,
        kind: 'project.created',
        actor: user.id,
        payload: { slug, name },
      });
    });

    return jsonOk(c, { project: { id, workspaceId: ws.id, slug, name, icon: icon ?? null } }, 201);
  },
);

const item = new Hono<AuthContext & ScopeContext>();
item.use('*', resolveProject);

item.get('/', (c) => jsonOk(c, { project: getProject(c) }));

item.patch(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80).optional(),
      icon: z.string().max(32).nullable().optional(),
    }),
  ),
  async (c) => {
    const p = getProject(c);
    const ws = getWorkspace(c);
    const user = getUser(c);
    const patch = c.req.valid('json');
    await db.transaction(async (tx) => {
      await tx.update(projects).set(patch).where(eq(projects.id, p.id));
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: p.id,
        kind: 'project.updated',
        actor: user.id,
        payload: { changes: Object.keys(patch) },
      });
    });
    return jsonOk(c, { project: { ...p, ...patch } });
  },
);

item.delete('/', async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const p = getProject(c);
  await db.delete(projects).where(eq(projects.id, p.id));
  return c.body(null, 204);
});

projectsRoute.route('/:pslug', item);

export { projectsRoute };
