import { zValidator } from '@hono/zod-validator';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { documents, statuses } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { dryRunResult, isDryRun, isDryRunDelete } from '../lib/dry-run.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { listStatuses } from '../services/statuses.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getProject, getTable, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const statusesRoute = new Hono<AuthContext & ScopeContext>();

const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;

statusesRoute.get('/', async (c) => {
  const t = getTable(c);
  return jsonOk(c, await listStatuses(t.id));
});

statusesRoute.post(
  '/',
  requireScope('config:write'),
  zValidator(
    'json',
    z.object({
      key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
      name: z.string().min(1).max(80),
      color: z.string().max(16).optional(),
      category: z.enum(CATEGORIES).optional(),
      order: z.number().int().optional(),
      dryRun: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const t = getTable(c);
    const ws = getWorkspace(c);
    const input = c.req.valid('json');
    const existing = await db.query.statuses.findFirst({
      where: and(eq(statuses.tableId, t.id), eq(statuses.key, input.key)),
    });
    if (existing) throw new HTTPError('SLUG_CONFLICT', `status "${input.key}" exists`, 409);

    const id = nanoid();
    const row = {
      id,
      projectId: p.id,
      tableId: t.id,
      key: input.key,
      name: input.name,
      color: input.color ?? '#9ca3af',
      category: input.category ?? 'unstarted',
      order: input.order ?? 0,
    };
    if (isDryRun(input)) {
      return jsonOk(c, dryRunResult('create', { status: row }));
    }
    await txWithEvents(db, async (tx) => {
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
  requireScope('config:write'),
  zValidator(
    'json',
    z.object({
      key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/).optional(),
      name: z.string().min(1).max(80).optional(),
      color: z.string().max(16).optional(),
      category: z.enum(CATEGORIES).optional(),
      order: z.number().int().optional(),
      dryRun: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const t = getTable(c);
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const row = await db.query.statuses.findFirst({
      where: and(eq(statuses.tableId, t.id), eq(statuses.id, id)),
    });
    if (!row) throw new HTTPError('STATUS_NOT_FOUND', `status "${id}" not found`, 404);
    const patch = c.req.valid('json');
    const { dryRun: _dryRun, ...patchFields } = patch;
    if (isDryRun(patch)) {
      return jsonOk(c, dryRunResult('update', { status: { ...row, ...patchFields } }));
    }

    await txWithEvents(db, async (tx) => {
      if (patchFields.key && patchFields.key !== row.key) {
        await tx.update(documents)
          .set({ status: patchFields.key })
          .where(and(eq(documents.tableId, t.id), eq(documents.status, row.key)));
      }
      await tx.update(statuses).set(patchFields).where(eq(statuses.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'status.updated', actor: user.id,
        payload: { id, changes: Object.keys(patchFields) },
      });
    });

    return jsonOk(c, { status: { ...row, ...patchFields } });
  },
);

statusesRoute.delete('/:id', requireScope('config:write'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.statuses.findFirst({
    where: and(eq(statuses.tableId, t.id), eq(statuses.id, id)),
  });
  if (!row) throw new HTTPError('STATUS_NOT_FOUND', `status "${id}" not found`, 404);

  const [usage] = await db
    .select({ n: count() })
    .from(documents)
    .where(and(eq(documents.tableId, t.id), eq(documents.status, row.key)));
  if ((usage?.n ?? 0) > 0) {
    throw new HTTPError('STATUS_IN_USE', `status "${row.key}" is used by ${usage!.n} document(s)`, 409);
  }

  if (isDryRunDelete(c)) {
    return jsonOk(c, dryRunResult('delete', { id: row.id, key: row.key }));
  }

  await txWithEvents(db, async (tx) => {
    await tx.delete(statuses).where(eq(statuses.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'status.deleted', actor: user.id,
      payload: { id, key: row.key },
    });
  });
  return c.body(null, 204);
});

export { statusesRoute };
