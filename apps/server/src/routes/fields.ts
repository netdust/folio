import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { fields } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getTable, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const fieldsRoute = new Hono<AuthContext & ScopeContext>();

const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
] as const;

const baseSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(FIELD_TYPES),
  label: z.string().max(80).optional(),
  options: z.array(z.string()).optional(),
  order: z.number().int().optional(),
});

function validateOptions(type: string, options: string[] | undefined): void {
  const needs = type === 'select' || type === 'multi_select';
  if (needs && (!options || options.length === 0)) {
    throw new HTTPError('INVALID_BODY', `field type "${type}" requires non-empty options`, 422);
  }
  if (!needs && options !== undefined) {
    throw new HTTPError('INVALID_BODY', `field type "${type}" does not allow options`, 422);
  }
}

fieldsRoute.get('/', async (c) => {
  const t = getTable(c);
  const rows = await db.query.fields.findMany({
    where: eq(fields.tableId, t.id),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
  return jsonOk(c, rows);
});

fieldsRoute.post('/', zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');
  validateOptions(input.type, input.options);

  const existing = await db.query.fields.findFirst({
    where: and(eq(fields.tableId, t.id), eq(fields.key, input.key)),
  });
  if (existing) throw new HTTPError('SLUG_CONFLICT', `field "${input.key}" exists`, 409);

  const id = nanoid();
  const row = {
    id,
    projectId: p.id,
    tableId: t.id,
    key: input.key,
    type: input.type,
    label: input.label ?? null,
    options: input.options ?? null,
    order: input.order ?? 0,
  };
  await db.transaction(async (tx) => {
    await tx.insert(fields).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'field.created', actor: user.id,
      payload: { id, key: input.key, type: input.type },
    });
  });
  return jsonOk(c, { field: row }, 201);
});

fieldsRoute.patch(
  '/:id',
  zValidator('json', baseSchema.partial()),
  async (c) => {
    const user = getUser(c);
    const p = getProject(c);
    const t = getTable(c);
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const row = await db.query.fields.findFirst({
      where: and(eq(fields.tableId, t.id), eq(fields.id, id)),
    });
    if (!row) throw new HTTPError('FIELD_NOT_FOUND', `field "${id}" not found`, 404);
    const patch = c.req.valid('json');
    const finalType = patch.type ?? row.type;
    const finalOptions =
      patch.options !== undefined ? patch.options : (row.options ?? undefined);
    validateOptions(finalType, finalOptions ?? undefined);

    await db.transaction(async (tx) => {
      await tx.update(fields).set(patch).where(eq(fields.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'field.updated', actor: user.id,
        payload: { id, changes: Object.keys(patch) },
      });
    });
    return jsonOk(c, { field: { ...row, ...patch } });
  },
);

fieldsRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.fields.findFirst({
    where: and(eq(fields.tableId, t.id), eq(fields.id, id)),
  });
  if (!row) throw new HTTPError('FIELD_NOT_FOUND', `field "${id}" not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(fields).where(eq(fields.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'field.deleted', actor: user.id,
      payload: { id, key: row.key },
    });
  });
  return c.body(null, 204);
});

export { fieldsRoute };
