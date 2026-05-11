import { zValidator } from '@hono/zod-validator';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { documents, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const statusesRoute = new Hono<AuthContext & ScopeContext>();

const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;

statusesRoute.get('/', async (c) => {
  const p = getProject(c);
  const rows = await db.query.statuses.findMany({
    where: eq(statuses.projectId, p.id),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
  return jsonOk(c, rows);
});

statusesRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
      name: z.string().min(1).max(80),
      color: z.string().max(16).optional(),
      category: z.enum(CATEGORIES).optional(),
      order: z.number().int().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const ws = getWorkspace(c);
    const input = c.req.valid('json');
    const existing = await db.query.statuses.findFirst({
      where: and(eq(statuses.projectId, p.id), eq(statuses.key, input.key)),
    });
    if (existing) throw new HTTPError('SLUG_CONFLICT', `status "${input.key}" exists`, 409);

    const id = nanoid();
    const row = {
      id,
      projectId: p.id,
      key: input.key,
      name: input.name,
      color: input.color ?? '#9ca3af',
      category: input.category ?? 'unstarted',
      order: input.order ?? 0,
    };
    await db.transaction(async (tx) => {
      await tx.insert(statuses).values(row);
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'status.created', actor: user.id,
        payload: { id, key: input.key },
      });
    });
    return jsonOk(c, { status: row }, 201);
  },
);

statusesRoute.patch(
  '/:id',
  zValidator(
    'json',
    z.object({
      key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
      name: z.string().min(1).max(80).optional(),
      color: z.string().max(16).optional(),
      category: z.enum(CATEGORIES).optional(),
      order: z.number().int().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const row = await db.query.statuses.findFirst({
      where: and(eq(statuses.projectId, p.id), eq(statuses.id, id)),
    });
    if (!row) throw new HTTPError('STATUS_NOT_FOUND', `status "${id}" not found`, 404);
    const patch = c.req.valid('json');

    await db.transaction(async (tx) => {
      if (patch.key && patch.key !== row.key) {
        await tx.update(documents)
          .set({ status: patch.key })
          .where(and(eq(documents.projectId, p.id), eq(documents.status, row.key)));
      }
      await tx.update(statuses).set(patch).where(eq(statuses.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'status.updated', actor: user.id,
        payload: { id, changes: Object.keys(patch) },
      });
    });

    return jsonOk(c, { status: { ...row, ...patch } });
  },
);

statusesRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.statuses.findFirst({
    where: and(eq(statuses.projectId, p.id), eq(statuses.id, id)),
  });
  if (!row) throw new HTTPError('STATUS_NOT_FOUND', `status "${id}" not found`, 404);

  const [usage] = await db
    .select({ n: count() })
    .from(documents)
    .where(and(eq(documents.projectId, p.id), eq(documents.status, row.key)));
  if ((usage?.n ?? 0) > 0) {
    throw new HTTPError('STATUS_IN_USE', `status "${row.key}" is used by ${usage!.n} document(s)`, 409);
  }

  await db.transaction(async (tx) => {
    await tx.delete(statuses).where(eq(statuses.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'status.deleted', actor: user.id,
      payload: { id, key: row.key },
    });
  });
  return c.body(null, 204);
});

export { statusesRoute };
