import { slugify } from '@folio/shared';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { memberships, workspaces } from '../db/schema.ts';
import { emitEvent } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { slugUniqueInWorkspaces } from '../lib/slug-unique.ts';
import { type AuthContext, getUser, requireUser } from '../middleware/auth.ts';
import { type ScopeContext, getRole, getWorkspace, resolveWorkspace } from '../middleware/scope.ts';

const workspacesRoute = new Hono<AuthContext & ScopeContext>();

workspacesRoute.use('*', requireUser);

// --- collection ---

workspacesRoute.get('/', async (c) => {
  const user = getUser(c);
  const rows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, user.id));
  return jsonOk(c, rows);
});

workspacesRoute.post(
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
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const { name, slug: explicit } = c.req.valid('json');
    const id = nanoid();

    const baseSlug = explicit ?? slugify(name);
    let slug = baseSlug;
    if (explicit) {
      const existing = await db.query.workspaces.findFirst({
        where: eq(workspaces.slug, explicit),
      });
      if (existing) throw new HTTPError('SLUG_CONFLICT', `slug "${explicit}" is taken`, 409);
    } else {
      slug = await slugUniqueInWorkspaces(db, baseSlug || 'workspace');
    }

    await db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id, slug, name });
      await tx.insert(memberships).values({ workspaceId: id, userId: user.id, role: 'owner' });
      await emitEvent(tx, {
        workspaceId: id,
        kind: 'workspace.created',
        actor: user.id,
        payload: { slug, name },
      });
    });

    return jsonOk(c, { id, slug, name }, 201);
  },
);

// --- item (slug-scoped via resolveWorkspace) ---

const item = new Hono<AuthContext & ScopeContext>();
item.use('*', resolveWorkspace);

item.get('/', (c) => jsonOk(c, { ...getWorkspace(c), role: getRole(c) }));

item.patch('/', zValidator('json', z.object({ name: z.string().min(1).max(80) })), async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const ws = getWorkspace(c);
  const { name } = c.req.valid('json');
  const user = getUser(c);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({ name, updatedAt: now }).where(eq(workspaces.id, ws.id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      kind: 'workspace.updated',
      actor: user.id,
      payload: { changes: ['name'] },
    });
  });
  return jsonOk(c, { ...ws, name, updatedAt: now });
});

item.delete('/', async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const ws = getWorkspace(c);
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  return c.body(null, 204);
});

workspacesRoute.route('/:wslug', item);

export { workspacesRoute };
