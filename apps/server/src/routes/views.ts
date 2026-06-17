import { FilterCompileError, filterCompile } from '@folio/shared';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { tables, views } from '../db/schema.ts';
import { dryRunResult, isDryRun, isDryRunDelete } from '../lib/dry-run.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { type ScopeContext, getProject, getTable, getWorkspace } from '../middleware/scope.ts';
import { listViews, listViewsForTables } from '../services/views.ts';

const viewsRoute = new Hono<AuthContext & ScopeContext>();

const baseSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['table', 'list', 'kanban', 'calendar', 'timeline', 'gallery']),
  filters: z.record(z.unknown()).optional(),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  groupBy: z.string().nullable().optional(),
  visibleFields: z.array(z.string()).optional(),
  columnOrder: z.array(z.string()).nullable().optional(),
  settings: z.record(z.unknown()).optional(),
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
  // BATCHED form (M3 audit 3.5): `?tables=slugA,slugB` collapses the rail's
  // per-(project,table) views fan-out into ONE project-scoped request that
  // returns views GROUPED BY tableId. Access is already enforced upstream — this
  // route is mounted under pScope (resolveProject + requireResource), the SAME
  // visibility convergence point (lib/access.ts, invariant 4a) as the legacy
  // list — so a caller who can't see the project is 404'd before we run.
  //
  // Cross-project guard: the requested table SLUGS are resolved ONLY against
  // THIS project's tables (eq(tables.projectId, p.id) + inArray(slug)). A slug
  // that belongs to another project resolves to nothing here, so its views can
  // never leak through this endpoint — the query is intersected with the
  // project's own tables, not the caller's raw input.
  //
  // Dual-mount note: viewsRoute is mounted under BOTH pScope and tScope, so
  // `?tables=` is technically reachable on a table-scoped URL (/t/:tslug/views),
  // where it ignores :tslug and serves the project-scoped batch. Harmless (same
  // project ceiling + same cross-project guard) and no client calls it that way;
  // the rail only ever hits the project mount.
  const tablesParam = c.req.query('tables');
  if (tablesParam !== undefined) {
    const p = getProject(c);
    const slugs = tablesParam
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (slugs.length === 0) return jsonOk(c, {});
    const owned = await db
      .select({ id: tables.id })
      .from(tables)
      .where(and(eq(tables.projectId, p.id), inArray(tables.slug, slugs)));
    const tableIds = owned.map((row) => row.id);
    return jsonOk(c, await listViewsForTables(tableIds));
  }

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

  // V1 (views UX shake-out): assign a UNIQUE order when the caller omits one —
  // `max(order for this table) + 10`, NOT 0. A 0-default collided with the seeded
  // default view (order 0) + every other custom view, giving the rail an unstable
  // sort that reads as "views duplicated". The New-view sheet never sends `order`,
  // so this is the common path. (Gapless ids aren't needed — only strict ordering.)
  let resolvedOrder = input.order;
  if (resolvedOrder === undefined) {
    const [maxRow] = await db
      .select({ max: max(views.order) })
      .from(views)
      .where(eq(views.tableId, t.id));
    resolvedOrder = (maxRow?.max ?? -10) + 10;
  }

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
    settings: input.settings ?? {},
    order: resolvedOrder,
    isDefault: input.isDefault ?? false,
  };
  if (isDryRun(input)) {
    return jsonOk(c, dryRunResult('create', { view: row }));
  }
  await txWithEvents(db, async (tx) => {
    await tx.insert(views).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      kind: 'view.created',
      actor: user.id,
      payload: { id, name: input.name },
    });
  });
  return jsonOk(c, { view: row }, 201);
});

viewsRoute.patch(
  '/:id',
  requireScope('config:write'),
  zValidator('json', baseSchema.partial()),
  async (c) => {
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
    const { dryRun: _dryRun, ...patchFields } = patch;
    if (isDryRun(patch)) {
      return jsonOk(c, dryRunResult('update', { view: { ...row, ...patchFields } }));
    }

    await txWithEvents(db, async (tx) => {
      await tx.update(views).set(patchFields).where(eq(views.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: p.id,
        kind: 'view.updated',
        actor: user.id,
        payload: { id, changes: Object.keys(patchFields) },
      });
    });
    return jsonOk(c, { view: { ...row, ...patchFields } });
  },
);

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
  // The default view is the table's main view (the plain spreadsheet a user
  // always returns to). Deleting it left the table with no default + no way back
  // (Stefan, 2026-06-18) — so it is protected. Other views delete freely.
  if (row.isDefault) {
    throw new HTTPError('VIEW_PROTECTED', 'the default view cannot be deleted', 409);
  }
  if (isDryRunDelete(c)) {
    return jsonOk(c, dryRunResult('delete', { id: row.id, name: row.name }));
  }
  await txWithEvents(db, async (tx) => {
    await tx.delete(views).where(eq(views.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      kind: 'view.deleted',
      actor: user.id,
      payload: { id, name: row.name },
    });
  });
  return c.body(null, 204);
});

export { viewsRoute };
