import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { filterCompile, FilterCompileError } from '@folio/shared';
import { db } from '../db/client.ts';
import { views } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { dryRunResult, isDryRun } from '../lib/dry-run.ts';
import { listViews } from '../services/views.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getProject, getTable, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const viewsRoute = new Hono<AuthContext & ScopeContext>();

const baseSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['list', 'kanban']),
  filters: z.record(z.unknown()).optional(),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  groupBy: z.string().nullable().optional(),
  visibleFields: z.array(z.string()).optional(),
  columnOrder: z.array(z.string()).nullable().optional(),
  order: z.number().int().optional(),
  isDefault: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

function validateFilters(input: unknown): void {
  if (!input || typeof input !== 'object') return;
  try {
    filterCompile(input as Parameters<typeof filterCompile>[0]);
  } catch (e) {
    if (e instanceof FilterCompileError) {
      throw new HTTPError('INVALID_FILTER', e.message, 422);
    }
    throw e;
  }
}

viewsRoute.get('/', async (c) => {
  const t = getTable(c);
  return jsonOk(c, await listViews(t.id));
});

viewsRoute.post('/', requireScope('config:write'), zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');
  validateFilters(input.filters);

  const id = nanoid();
  const row = {
    id,
    projectId: p.id,
    tableId: t.id,
    name: input.name,
    type: input.type,
    filters: (input.filters ?? {}) as unknown,
    sort: (input.sort ?? []) as unknown,
    groupBy: input.groupBy ?? null,
    visibleFields: input.visibleFields ?? [],
    columnOrder: input.columnOrder ?? null,
    order: input.order ?? 0,
    isDefault: input.isDefault ?? false,
  };
  if (isDryRun(input)) {
    return jsonOk(c, dryRunResult('create', row));
  }
  await txWithEvents(db, async (tx) => {
    await tx.insert(views).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'view.created', actor: user.id,
      payload: { id, name: input.name },
    });
  });
  return jsonOk(c, { view: row }, 201);
});

viewsRoute.patch('/:id', requireScope('config:write'), zValidator('json', baseSchema.partial()), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.views.findFirst({
    where: and(eq(views.tableId, t.id), eq(views.id, id)),
  });
  if (!row) throw new HTTPError('VIEW_NOT_FOUND', `view "${id}" not found`, 404);
  const patch = c.req.valid('json');
  if (patch.filters !== undefined) validateFilters(patch.filters);
  if (isDryRun(patch)) {
    return jsonOk(c, dryRunResult('update', { ...row, ...patch }));
  }

  await txWithEvents(db, async (tx) => {
    await tx.update(views).set(patch).where(eq(views.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'view.updated', actor: user.id,
      payload: { id, changes: Object.keys(patch) },
    });
  });
  return jsonOk(c, { view: { ...row, ...patch } });
});

viewsRoute.delete('/:id', requireScope('config:write'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.views.findFirst({
    where: and(eq(views.tableId, t.id), eq(views.id, id)),
  });
  if (!row) throw new HTTPError('VIEW_NOT_FOUND', `view "${id}" not found`, 404);
  if (c.req.query('dryRun') === 'true') {
    return jsonOk(c, dryRunResult('delete', { id: row.id, name: row.name }));
  }
  await txWithEvents(db, async (tx) => {
    await tx.delete(views).where(eq(views.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'view.deleted', actor: user.id,
      payload: { id, name: row.name },
    });
  });
  return c.body(null, 204);
});

export { viewsRoute };
