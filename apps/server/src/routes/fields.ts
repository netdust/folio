import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { fields } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { FIELD_TYPES, type FieldType, validateTypeChange } from '../lib/field-type-change.ts';
import { dryRunResult, isDryRun, isDryRunDelete } from '../lib/dry-run.ts';
import { listFields } from '../services/fields.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getProject, getTable, getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const fieldsRoute = new Hono<AuthContext & ScopeContext>();

const baseSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(FIELD_TYPES),
  label: z.string().max(80).optional(),
  options: z.array(z.string()).nullable().optional(),
  order: z.number().int().optional(),
  dryRun: z.boolean().optional(),
});

function validateOptions(type: string, options: string[] | undefined): void {
  if (type === 'select' || type === 'multi_select') {
    if (!options || options.length === 0) {
      throw new HTTPError('INVALID_BODY', `field type "${type}" requires non-empty options`, 422);
    }
    return;
  }
  if (type === 'currency') {
    if (!options || options.length !== 1 || !/^[A-Z]{3}$/.test(options[0] ?? '')) {
      throw new HTTPError('INVALID_BODY', `field type "currency" requires options to be a single ISO-4217 code (e.g. ["EUR"])`, 422);
    }
    return;
  }
  if (type === 'relation') {
    if (!options || options.length !== 2) {
      throw new HTTPError(
        'INVALID_BODY',
        'field type "relation" requires options [target, cardinality], e.g. ["wiki","single"] or ["table:<id>","multi"]',
        422,
      );
    }
    const [target, cardinality] = options;
    const targetOk = target === 'wiki' || /^table:[\w-]+$/.test(target ?? '');
    if (!targetOk) {
      throw new HTTPError('INVALID_BODY', `relation target must be "wiki" or "table:<id>", got "${target}"`, 422);
    }
    if (cardinality !== 'single' && cardinality !== 'multi') {
      throw new HTTPError('INVALID_BODY', `relation cardinality must be "single" or "multi", got "${cardinality}"`, 422);
    }
    return;
  }
  if (options !== undefined) {
    throw new HTTPError('INVALID_BODY', `field type "${type}" does not allow options`, 422);
  }
}

fieldsRoute.get('/', async (c) => {
  const t = getTable(c);
  return jsonOk(c, await listFields(t.id));
});

fieldsRoute.post('/', requireScope('config:write'), zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');
  // Normalize null → undefined for POST: callers may send options: null to
  // explicitly say "no options", which is equivalent to omitting the field.
  validateOptions(input.type, input.options ?? undefined);

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
  if (isDryRun(input)) {
    return jsonOk(c, dryRunResult('create', { field: row }));
  }
  await txWithEvents(db, async (tx) => {
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
  requireScope('config:write'),
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
    const { dryRun: _dryRun, ...patchFields } = patch;
    const finalType = patch.type ?? row.type;

    if (patch.type && patch.type !== row.type) {
      const check = validateTypeChange(row.type, patch.type);
      if (!check.ok) {
        throw new HTTPError('INVALID_TYPE_CHANGE', check.reason, 422);
      }
    }

    // Build the effective options for validation + persistence.
    // Treat `options: null` from the client the same as `options: undefined`
    // for the "carry existing" branch — null means "no replacement provided,
    // clear if appropriate". This also makes the dropping-currency branch
    // reachable for both null and undefined.
    let finalOptions: string[] | undefined =
      patch.options !== undefined && patch.options !== null
        ? patch.options
        : (row.options ?? undefined);

    // * → currency: inject default ['EUR'] when no options supplied.
    if (
      patch.type === 'currency' &&
      row.type !== 'currency' &&
      (!finalOptions || finalOptions.length === 0)
    ) {
      finalOptions = ['EUR'];
    }

    // currency → *: drop options when no replacement supplied OR client
    // explicitly cleared with options: null.
    const droppingCurrencyOptions =
      row.type === 'currency' &&
      patch.type !== undefined &&
      patch.type !== 'currency' &&
      (patch.options === undefined || patch.options === null);
    if (droppingCurrencyOptions) {
      finalOptions = undefined;
    }

    validateOptions(finalType, finalOptions ?? undefined);

    // Persist the (possibly mutated) options.
    const updatePatch: { type?: FieldType; key?: string; label?: string; options?: string[] | null; order?: number } = { ...patchFields };
    if (
      patch.type === 'currency' &&
      row.type !== 'currency' &&
      (!patch.options || patch.options.length === 0)
    ) {
      updatePatch.options = ['EUR'];
    }
    if (droppingCurrencyOptions) {
      updatePatch.options = null;
    }

    if (isDryRun(patch)) {
      return jsonOk(c, dryRunResult('update', { field: { ...row, ...updatePatch } }));
    }

    await txWithEvents(db, async (tx) => {
      await tx.update(fields).set(updatePatch).where(eq(fields.id, id));
      await emitEvent(tx, {
        workspaceId: ws.id, projectId: p.id, kind: 'field.updated', actor: user.id,
        payload: { id, changes: Object.keys(updatePatch) },
      });
    });
    return jsonOk(c, { field: { ...row, ...updatePatch } });
  },
);

fieldsRoute.delete('/:id', requireScope('config:write'), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const t = getTable(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const row = await db.query.fields.findFirst({
    where: and(eq(fields.tableId, t.id), eq(fields.id, id)),
  });
  if (!row) throw new HTTPError('FIELD_NOT_FOUND', `field "${id}" not found`, 404);
  if (isDryRunDelete(c)) {
    return jsonOk(c, dryRunResult('delete', { id: row.id, key: row.key }));
  }
  await txWithEvents(db, async (tx) => {
    await tx.delete(fields).where(eq(fields.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'field.deleted', actor: user.id,
      payload: { id, key: row.key },
    });
  });
  return c.body(null, 204);
});

export { fieldsRoute };
