import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { slugify } from '@folio/shared';
import { db } from '../db/client.ts';
import { tables } from '../db/schema.ts';
import { dryRunResult, isDryRun } from '../lib/dry-run.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { slugUniqueInTables } from '../lib/slug-unique.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { type ScopeContext, getProject, getWorkspace } from '../middleware/scope.ts';

const tablesRoute = new Hono<AuthContext & ScopeContext>();

const baseSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  icon: z.string().max(32).nullable().optional(),
  order: z.number().int().optional(),
  dryRun: z.boolean().optional(),
});

// PATCH intentionally excludes `slug`: renaming a table's slug would silently
// invalidate every URL pointing at that table's children (statuses, fields,
// views, documents). Slug is immutable in v1.
const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  icon: z.string().nullable().optional(),
  order: z.number().int().optional(),
  dryRun: z.boolean().optional(),
});

tablesRoute.get('/', async (c) => {
  const p = getProject(c);
  const rows = await db.query.tables.findMany({
    where: eq(tables.projectId, p.id),
    orderBy: (t, { asc }) => [asc(t.order), asc(t.createdAt)],
  });
  return jsonOk(c, rows);
});

tablesRoute.post('/', requireScope('config:write'), zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');

  let slug: string;
  if (input.slug) {
    const existing = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, p.id), eq(tables.slug, input.slug)),
    });
    if (existing) {
      throw new HTTPError('SLUG_TAKEN', `table "${input.slug}" already exists`, 409);
    }
    slug = input.slug;
  } else {
    const baseSlug = slugify(input.name) || 'table';
    slug = await slugUniqueInTables(db, p.id, baseSlug);
  }

  const id = nanoid();
  const row = {
    id,
    projectId: p.id,
    slug,
    name: input.name,
    icon: input.icon ?? null,
    order: input.order ?? 0,
  };
  if (isDryRun(input)) {
    return jsonOk(c, dryRunResult('create', row));
  }
  await txWithEvents(db, async (tx) => {
    await tx.insert(tables).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      kind: 'table.created',
      actor: user.id,
      payload: { id, slug, name: input.name },
    });
  });
  return jsonOk(c, row, 201);
});

tablesRoute.patch('/:tslug', requireScope('config:write'), zValidator('json', patchSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const tslug = c.req.param('tslug');
  const row = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, tslug)),
  });
  if (!row) throw new HTTPError('TABLE_NOT_FOUND', `table "${tslug}" not found`, 404);

  const patch = c.req.valid('json');

  // Only persist columns we actually allow patching. `slug` is intentionally
  // excluded — see patchSchema above.
  const updates: Partial<typeof tables.$inferInsert> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.icon !== undefined) updates.icon = patch.icon;
  if (patch.order !== undefined) updates.order = patch.order;

  if (isDryRun(patch)) {
    return jsonOk(c, dryRunResult('update', { ...row, ...updates }));
  }

  await txWithEvents(db, async (tx) => {
    if (Object.keys(updates).length > 0) {
      await tx.update(tables).set(updates).where(eq(tables.id, row.id));
    }
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      kind: 'table.updated',
      actor: user.id,
      payload: { id: row.id, changes: Object.keys(updates) },
    });
  });
  return jsonOk(c, { ...row, ...updates });
});

tablesRoute.delete('/:tslug', requireScope('config:write'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const tslug = c.req.param('tslug');
  const row = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, tslug)),
  });
  if (!row) throw new HTTPError('TABLE_NOT_FOUND', `table "${tslug}" not found`, 404);

  if (c.req.query('dryRun') === 'true') {
    return jsonOk(c, dryRunResult('delete', { id: row.id, slug: row.slug, name: row.name }));
  }

  await txWithEvents(db, async (tx) => {
    await tx.delete(tables).where(eq(tables.id, row.id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      kind: 'table.deleted',
      actor: user.id,
      payload: { id: row.id, slug: row.slug, name: row.name },
    });
  });
  return c.body(null, 204);
});

export { tablesRoute };
