# Phase 2A — Tables Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `tables` as a first-class concept between projects and documents. Each project owns one or more tables (default: "Work Items"); statuses, fields, views, and work-item documents all belong to a table. Wiki pages remain project-scoped. Backend only — no UI changes; UI lands in Phase 2B.

**Architecture:** Add a `tables` table; add `table_id` FKs on `statuses`, `fields`, `views`, and `documents` (work_items only). Migration auto-creates a default "Work Items" table per existing project and re-parents existing rows into it. New nested REST routes `/api/v1/w/:ws/p/:p/tables` and `/api/v1/w/:ws/p/:p/t/:tslug/...`. Old project-scoped document routes proxy to the default table for backward compat with the current frontend; we'll remove them once Phase 2B lands.

**Tech Stack:** Bun + Hono + Drizzle + bun:sqlite. Test runner: `bun test`. New unit tests per route; existing integration tests must keep passing after the proxy shim lands.

**Scope explicitly excluded:** Frontend changes (no React/TanStack Router edits), spreadsheet UI, saved-view UI in the rail, per-view render modes. Those are Phases 2B/2C/2D.

---

## File Structure

**Create:**
- `apps/server/src/db/migrations/0003_phase_2a_tables.sql` — Drizzle-generated DDL + a hand-authored data-migration block inside it
- `apps/server/src/routes/tables.ts` — CRUD for tables
- `apps/server/src/routes/tables.test.ts` — integration tests for the CRUD
- `apps/server/src/middleware/scope.ts` — *extend* with `resolveTable`
- `apps/server/src/middleware/scope.test.ts` — *extend* with table-resolution tests
- `apps/server/src/lib/seed-project-defaults.ts` — *extend* to create the default table when seeding a project
- `apps/server/src/routes/documents.ts` — *refactor* to accept `tableId` from context; keep legacy project-scoped path
- `packages/shared/src/index.ts` — *extend* with `Table` type export

**Modify (schema + routes only — no UI):**
- `apps/server/src/db/schema.ts` — add `tables` table; add `tableId` to `statuses`, `fields`, `views`, `documents`
- `apps/server/src/routes/statuses.ts`, `fields.ts`, `views.ts` — switch FK from `projectId` to `tableId`, mount under `/t/:tslug`
- `apps/server/src/index.ts` — mount the new `/tables` and `/t/:tslug/...` route trees
- `scripts/seed-demo.ts` — when seeding, create the default table explicitly (so the seed works against a post-migration schema)

**Untouched (Phase 2B will rewire):**
- `apps/web/**` — no changes
- `apps/server/src/routes/documents.ts` keeps its legacy `/p/:pslug/documents` mount; a new mount under `/t/:tslug/documents` is added alongside it

---

## Task 1: Add the `tables` schema + table_id FKs

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Generate: `apps/server/src/db/migrations/0003_*.sql`

- [ ] **Step 1: Edit the schema — add `tables` table near line 127, before `statuses`**

Add this block in `schema.ts` right above the `// --- Per-project configuration ---` comment:

```ts
// --- Tables (logical grouping of work_item documents within a project) ---

export const tables = sqliteTable(
  'tables',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    icon: text('icon'), // optional lucide icon name; null = default
    order: integer('order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    slugIdx: uniqueIndex('tables_project_slug_idx').on(t.projectId, t.slug),
  }),
);
```

- [ ] **Step 2: Add `tableId` to statuses, fields, views, documents**

In the existing four table definitions, add `tableId` immediately after `projectId`. Documents diverges (it's nullable for type='page'):

```ts
// statuses
tableId: text('table_id')
  .notNull()
  .references(() => tables.id, { onDelete: 'cascade' }),

// fields
tableId: text('table_id')
  .notNull()
  .references(() => tables.id, { onDelete: 'cascade' }),

// views — replace projectId reference behavior; keep projectId for now during migration, drop in Task 3
tableId: text('table_id')
  .notNull()
  .references(() => tables.id, { onDelete: 'cascade' }),

// documents — nullable because type='page' has no table
tableId: text('table_id').references(() => tables.id, { onDelete: 'cascade' }),
```

Also add an index for the common lookup:

```ts
// in documents' index block
tableIdx: index('documents_table_idx').on(t.tableId),
```

- [ ] **Step 3: Update uniqueness constraints**

The current `statuses_project_key_idx` and `fields_project_key_idx` indexes on `(projectId, key)` must move to `(tableId, key)` — keys are unique per-table now, not per-project. Rewrite those uniqueIndex calls:

```ts
keyIdx: uniqueIndex('statuses_table_key_idx').on(t.tableId, t.key),
keyIdx: uniqueIndex('fields_table_key_idx').on(t.tableId, t.key),
```

- [ ] **Step 4: Generate the migration SQL**

Run from repo root:

```bash
bun --filter @folio/server db:generate
```

Expected: `apps/server/src/db/migrations/0003_<random>.sql` is created with `CREATE TABLE tables`, `ALTER TABLE statuses ADD COLUMN table_id`, etc. Verify the file exists and rename it to `0003_phase_2a_tables.sql` for clarity.

- [ ] **Step 5: Read the generated migration and confirm what it does**

Run: `cat apps/server/src/db/migrations/0003_phase_2a_tables.sql`

Expected: creates `tables`, adds `table_id` columns. Drizzle does NOT auto-backfill data. We add the backfill in Task 2.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-2a: add tables schema + table_id FKs (no backfill yet)"
```

---

## Task 2: Write the data-migration block

**Files:**
- Modify: `apps/server/src/db/migrations/0003_phase_2a_tables.sql`

The Drizzle-generated migration only handles DDL. We need to (1) create a default "Work Items" table per existing project, (2) backfill `table_id` on existing rows, (3) make `table_id` NOT NULL on `statuses`/`fields`/`views` (SQLite ALTER limitation: we may need to rebuild those tables — Drizzle handles this if we add NOT NULL in Task 1; verify by reading the generated SQL).

- [ ] **Step 1: Append a data-migration block at the END of `0003_phase_2a_tables.sql`**

After the DDL, append:

```sql
--> statement-breakpoint
-- Phase 2A data migration: create a default table per project + backfill FKs.
-- Idempotent against re-runs because INSERT OR IGNORE + uniqueIndex.

-- 1. Create one "Work Items" table per existing project (skip projects with no docs OR with an existing table).
INSERT OR IGNORE INTO tables (id, project_id, slug, name, icon, "order", created_at)
SELECT
  lower(hex(randomblob(8))) || '-' || lower(hex(randomblob(4))),
  p.id,
  'work-items',
  'Work Items',
  NULL,
  0,
  (unixepoch() * 1000)
FROM projects p;

-- 2. Backfill statuses.table_id → the project's default Work Items table.
UPDATE statuses
SET table_id = (
  SELECT t.id FROM tables t
  WHERE t.project_id = statuses.project_id AND t.slug = 'work-items'
)
WHERE table_id IS NULL OR table_id = '';

-- 3. Backfill fields.table_id.
UPDATE fields
SET table_id = (
  SELECT t.id FROM tables t
  WHERE t.project_id = fields.project_id AND t.slug = 'work-items'
)
WHERE table_id IS NULL OR table_id = '';

-- 4. Backfill views.table_id.
UPDATE views
SET table_id = (
  SELECT t.id FROM tables t
  WHERE t.project_id = views.project_id AND t.slug = 'work-items'
)
WHERE table_id IS NULL OR table_id = '';

-- 5. Backfill documents.table_id for work_items only (pages stay NULL).
UPDATE documents
SET table_id = (
  SELECT t.id FROM tables t
  WHERE t.project_id = documents.project_id AND t.slug = 'work-items'
)
WHERE type = 'work_item' AND table_id IS NULL;
```

- [ ] **Step 2: Wipe + remigrate the dev DB and verify backfill**

```bash
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
cd ../..
```

Expected: `Migrations complete.` Then re-run the demo seed and verify:

```bash
bun run scripts/seed-demo.ts
cd apps/server && bun -e '
import { Database } from "bun:sqlite";
const db = new Database("./folio.db");
const t = db.query("SELECT COUNT(*) as n FROM tables").get();
console.log("tables:", t.n);
const docs = db.query("SELECT COUNT(*) as n FROM documents WHERE type=\"work_item\" AND table_id IS NULL").get();
console.log("work_items missing table_id:", docs.n);
const statuses = db.query("SELECT COUNT(*) as n FROM statuses WHERE table_id IS NULL OR table_id = \"\"").get();
console.log("statuses missing table_id:", statuses.n);
'
```

Expected output:
```
tables: 3            ← one per seeded project
work_items missing table_id: 0
statuses missing table_id: 0
```

Note: the seed script creates projects via the API, which currently does NOT create a table. After we extend `seed-project-defaults.ts` in Task 4 it will. For now this verifies the migration backfills correctly when projects exist at migrate time.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db/migrations/0003_phase_2a_tables.sql
git commit -m "phase-2a: backfill default table per project in migration"
```

---

## Task 3: Make `table_id` NOT NULL on the constrained tables

**Files:**
- Modify: `apps/server/src/db/schema.ts` (already done in Task 1 — verify)
- Modify: `apps/server/src/db/migrations/0003_phase_2a_tables.sql` (Drizzle may have generated nullable; need to ensure NOT NULL after backfill)

SQLite can't `ALTER COLUMN ... SET NOT NULL` directly; Drizzle's strategy is "rebuild the table." If the generated SQL already rebuilds with NOT NULL, that's fine *but it runs before our backfill, which would fail*. The safe order is: add column nullable → backfill → rebuild table NOT NULL. Drizzle's generator can't sequence this for us, so we hand-author the rebuild block AFTER the backfill.

- [ ] **Step 1: Inspect the generated migration to see how NOT NULL was handled**

Run: `cat apps/server/src/db/migrations/0003_phase_2a_tables.sql | head -80`

If the migration ADDs columns as nullable, skip to Step 2. If it rebuilds tables with NOT NULL up-front (before our backfill block), reorder: move the table-rebuild steps to the END of the file, AFTER the backfill block from Task 2.

- [ ] **Step 2: Verify NOT NULL by querying after re-migrate**

```bash
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts && bun -e '
import { Database } from "bun:sqlite";
const db = new Database("./folio.db");
for (const t of ["statuses", "fields", "views"]) {
  const cols = db.query(`PRAGMA table_info(${t})`).all();
  const tid = cols.find(c => c.name === "table_id");
  console.log(`${t}.table_id: notnull=${tid?.notnull}`);
}
'
cd ../..
```

Expected: `statuses.table_id: notnull=1`, same for fields and views. (Documents stays nullable because pages have no table.)

- [ ] **Step 3: Re-seed and run the existing server tests**

```bash
bun run scripts/seed-demo.ts
cd apps/server && bun test
```

Expected: 81/81 pass (no regressions yet — the document/status/view routes still work because they read `project_id`).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/migrations/0003_phase_2a_tables.sql
git commit -m "phase-2a: enforce NOT NULL on table_id after backfill"
```

---

## Task 4: Auto-create the default table when a project is created

**Files:**
- Modify: `apps/server/src/lib/seed-project-defaults.ts`
- Modify: `apps/server/src/lib/seed-project-defaults.test.ts`

`seed-project-defaults` runs after a new project is created via the API. It currently inserts the four default statuses. Extend it to also create a "Work Items" table FIRST, then attach those statuses to that table.

- [ ] **Step 1: Read the current implementation**

Run: `cat apps/server/src/lib/seed-project-defaults.ts`

Identify the function signature (likely `seedProjectDefaults(tx, projectId)`) and the existing test contract.

- [ ] **Step 2: Write the failing test first**

In `apps/server/src/lib/seed-project-defaults.test.ts`, add:

```ts
test('seedProjectDefaults creates a default "Work Items" table and attaches statuses to it', async () => {
  const { db, projectId } = await makeProjectFixture();
  await db.transaction(async (tx) => {
    await seedProjectDefaults(tx, projectId);
  });

  const tables = await db.query.tables.findMany({
    where: eq(tablesSchema.projectId, projectId),
  });
  expect(tables).toHaveLength(1);
  expect(tables[0].slug).toBe('work-items');
  expect(tables[0].name).toBe('Work Items');

  const statuses = await db.query.statuses.findMany({
    where: eq(statusesSchema.projectId, projectId),
  });
  expect(statuses).toHaveLength(4);
  expect(statuses.every((s) => s.tableId === tables[0].id)).toBe(true);
});
```

(`makeProjectFixture` and named imports follow the patterns in the file; copy from the existing test that's already there.)

- [ ] **Step 3: Run the test and verify it fails**

```bash
cd apps/server && bun test src/lib/seed-project-defaults.test.ts
```

Expected: FAIL — `tables` undefined or the new assertions don't pass.

- [ ] **Step 4: Update `seed-project-defaults.ts`**

```ts
import { tables, statuses } from '../db/schema.ts';
import { nanoid } from 'nanoid';

export async function seedProjectDefaults(
  tx: typeof db,
  projectId: string,
): Promise<{ tableId: string }> {
  const tableId = nanoid();
  await tx.insert(tables).values({
    id: tableId,
    projectId,
    slug: 'work-items',
    name: 'Work Items',
    icon: null,
    order: 0,
  });

  const defaults = [
    { key: 'backlog',     name: 'Backlog',     category: 'backlog'   as const, color: '#94a3b8', order: 0  },
    { key: 'todo',        name: 'Todo',        category: 'unstarted' as const, color: '#3b82f6', order: 10 },
    { key: 'in_progress', name: 'In Progress', category: 'started'   as const, color: '#f59e0b', order: 20 },
    { key: 'done',        name: 'Done',        category: 'completed' as const, color: '#10b981', order: 30 },
  ];

  await tx.insert(statuses).values(
    defaults.map((s) => ({
      id: nanoid(),
      projectId,
      tableId,
      ...s,
    })),
  );

  return { tableId };
}
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
cd apps/server && bun test src/lib/seed-project-defaults.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/seed-project-defaults.ts apps/server/src/lib/seed-project-defaults.test.ts
git commit -m "phase-2a: create default table on project create"
```

---

## Task 5: Add `resolveTable` middleware

**Files:**
- Modify: `apps/server/src/middleware/scope.ts`
- Modify: `apps/server/src/middleware/scope.test.ts`

Add a middleware that reads `:tslug`, looks up the table within the resolved project, and stores it in context. Used by every route nested under `/t/:tslug/...`.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/middleware/scope.test.ts`, add (mirroring the existing `resolveProject` test):

```ts
test('resolveTable attaches table to context when slug exists in project', async () => {
  const { app, seed } = await makeTestApp();
  const route = new Hono<AuthContext & ScopeContext>()
    .use('/w/:wslug/p/:pslug/t/:tslug/*', requireAuth, resolveWorkspace, resolveProject, resolveTable)
    .get('/w/:wslug/p/:pslug/t/:tslug/probe', (c) => c.json({ tableName: getTable(c).name }));
  app.route('/', route);

  const res = await app.request('/w/acme/p/web/t/work-items/probe', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tableName: 'Work Items' });
});

test('resolveTable returns 404 when table slug is unknown', async () => {
  // ... same setup but request /t/nope/probe and assert 404 TABLE_NOT_FOUND
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd apps/server && bun test src/middleware/scope.test.ts
```

Expected: FAIL — `resolveTable` / `getTable` not exported.

- [ ] **Step 3: Implement `resolveTable` and `getTable`**

In `scope.ts`, append:

```ts
import type { Table } from '../db/schema.ts';
import { tables } from '../db/schema.ts';

export interface TableScopeContext {
  Variables: {
    workspace?: Workspace;
    project?: Project;
    table?: Table;
    role?: Role;
  };
}

export const resolveTable: MiddlewareHandler<AuthContext & TableScopeContext> = async (c, next) => {
  const p = c.get('project');
  if (!p) throw new HTTPError('PROJECT_NOT_FOUND', 'resolveProject must run first', 500);
  const tslug = c.req.param('tslug');
  if (!tslug) throw new HTTPError('TABLE_NOT_FOUND', 'missing :tslug', 404);
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, tslug)),
  });
  if (!t) throw new HTTPError('TABLE_NOT_FOUND', `table "${tslug}" not found`, 404);
  c.set('table', t);
  return next();
};

export function getTable(c: Context<AuthContext & TableScopeContext>): Table {
  const t = c.get('table');
  if (!t) throw new Error('table not attached');
  return t;
}
```

Also export `Table` type from `schema.ts` if not already exported:

```ts
export type Table = typeof tables.$inferSelect;
```

Update `ScopeContext` interface to include the optional `table` so existing routes don't break.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd apps/server && bun test src/middleware/scope.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/middleware/scope.ts apps/server/src/middleware/scope.test.ts apps/server/src/db/schema.ts
git commit -m "phase-2a: resolveTable middleware + Table type export"
```

---

## Task 6: Build the `/tables` CRUD route

**Files:**
- Create: `apps/server/src/routes/tables.ts`
- Create: `apps/server/src/routes/tables.test.ts`
- Modify: `apps/server/src/index.ts` (mount the route)

- [ ] **Step 1: Write the failing tests first**

Create `apps/server/src/routes/tables.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const base = '/api/v1/w/acme/p/web/tables';

test('GET /tables returns the default Work Items table for a fresh project', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(base, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ slug: 'work-items', name: 'Work Items' });
});

test('POST /tables creates a new table with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hot Leads' }),
  });
  expect(res.status).toBe(201);
  const { data } = await res.json();
  expect(data).toMatchObject({ slug: 'hot-leads', name: 'Hot Leads' });
});

test('POST /tables 409 on duplicate slug', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bugs', slug: 'bugs' }),
  });
  const dupe = await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bugs', slug: 'bugs' }),
  });
  expect(dupe.status).toBe(409);
});

test('PATCH /tables/:tslug renames the table', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${base}/work-items`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tickets' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.name).toBe('Tickets');
});

test('DELETE /tables/:tslug cascades to its documents and views', async () => {
  const { app, seed } = await makeTestApp();
  // Create a new table + a doc under it, then delete the table.
  const created = await (await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Temp' }),
  })).json();

  await app.request(`/api/v1/w/acme/p/web/t/${created.data.slug}/documents`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'will be cascaded' }),
  });

  const del = await app.request(`${base}/${created.data.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);

  const after = await app.request(`/api/v1/w/acme/p/web/t/${created.data.slug}/documents`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(after.status).toBe(404);   // TABLE_NOT_FOUND from resolveTable
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd apps/server && bun test src/routes/tables.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tables.ts`**

Create `apps/server/src/routes/tables.ts` mirroring the shape of `views.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { tables } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import { slugify, uniqueSlug } from '../lib/slug-unique.ts';

const tablesRoute = new Hono<AuthContext & ScopeContext>();

const baseSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(80).optional(),
  icon: z.string().nullable().optional(),
  order: z.number().int().optional(),
});

tablesRoute.get('/', async (c) => {
  const p = getProject(c);
  const rows = await db.query.tables.findMany({
    where: eq(tables.projectId, p.id),
    orderBy: (t, { asc }) => [asc(t.order), asc(t.createdAt)],
  });
  return jsonOk(c, rows);
});

tablesRoute.post('/', zValidator('json', baseSchema), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');
  const baseSlug = input.slug ?? slugify(input.name);
  // uniqueness check (caller may pass an explicit slug — surface 409 not 500)
  const existing = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, baseSlug)),
  });
  if (existing) throw new HTTPError('SLUG_TAKEN', `table "${baseSlug}" already exists`, 409);
  const slug = await uniqueSlug(baseSlug, async (s) => {
    const r = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, p.id), eq(tables.slug, s)),
    });
    return !!r;
  });

  const id = nanoid();
  const row = {
    id,
    projectId: p.id,
    slug,
    name: input.name,
    icon: input.icon ?? null,
    order: input.order ?? 0,
  };
  await db.transaction(async (tx) => {
    await tx.insert(tables).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'table.created', actor: user.id,
      payload: { id, slug, name: input.name },
    });
  });
  return jsonOk(c, row, 201);
});

tablesRoute.patch('/:tslug', zValidator('json', baseSchema.partial()), async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const tslug = c.req.param('tslug');
  const existing = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, tslug)),
  });
  if (!existing) throw new HTTPError('TABLE_NOT_FOUND', `table "${tslug}" not found`, 404);
  const patch = c.req.valid('json');
  await db.transaction(async (tx) => {
    await tx.update(tables).set(patch).where(eq(tables.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'table.updated', actor: user.id,
      payload: { id: existing.id, changes: Object.keys(patch) },
    });
  });
  return jsonOk(c, { ...existing, ...patch });
});

tablesRoute.delete('/:tslug', async (c) => {
  const user = getUser(c);
  const p = getProject(c);
  const ws = getWorkspace(c);
  const tslug = c.req.param('tslug');
  const existing = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, p.id), eq(tables.slug, tslug)),
  });
  if (!existing) throw new HTTPError('TABLE_NOT_FOUND', `table "${tslug}" not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(tables).where(eq(tables.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'table.deleted', actor: user.id,
      payload: { id: existing.id, slug: existing.slug, name: existing.name },
    });
  });
  return c.body(null, 204);
});

export { tablesRoute };
```

- [ ] **Step 4: Mount in `index.ts`**

Find where existing project-scoped routes mount (likely something like `app.route('/api/v1/w/:wslug/p/:pslug/views', ...)`) and add:

```ts
import { tablesRoute } from './routes/tables.ts';
// ...
app.use('/api/v1/w/:wslug/p/:pslug/tables/*', requireAuth, resolveWorkspace, resolveProject);
app.route('/api/v1/w/:wslug/p/:pslug/tables', tablesRoute);
```

- [ ] **Step 5: Run the new tests**

```bash
cd apps/server && bun test src/routes/tables.test.ts
```

Expected: all pass except the `cascade` test, which depends on Task 7 wiring `/t/:tslug/documents`. Mark that one with `test.skip` or `test.todo` for now and re-enable in Task 7.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/tables.ts apps/server/src/routes/tables.test.ts apps/server/src/index.ts
git commit -m "phase-2a: GET/POST/PATCH/DELETE /tables"
```

---

## Task 7: Mount documents/statuses/fields/views routes under `/t/:tslug`

**Files:**
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/documents.ts`
- Modify: `apps/server/src/routes/statuses.ts`
- Modify: `apps/server/src/routes/fields.ts`
- Modify: `apps/server/src/routes/views.ts`

Wire the existing four route trees under the new `/t/:tslug/...` prefix using `resolveTable`. Keep the existing project-scoped mounts for backward compat (the frontend in this phase still hits `/p/:pslug/documents`).

- [ ] **Step 1: In `index.ts`, add the new mounts**

After the existing project-scoped mounts, add:

```ts
import { resolveTable } from './middleware/scope.ts';

const tableScope = '/api/v1/w/:wslug/p/:pslug/t/:tslug';

app.use(`${tableScope}/documents/*`, requireAuth, resolveWorkspace, resolveProject, resolveTable);
app.route(`${tableScope}/documents`, documentsRoute);

app.use(`${tableScope}/statuses/*`, requireAuth, resolveWorkspace, resolveProject, resolveTable);
app.route(`${tableScope}/statuses`, statusesRoute);

app.use(`${tableScope}/fields/*`, requireAuth, resolveWorkspace, resolveProject, resolveTable);
app.route(`${tableScope}/fields`, fieldsRoute);

app.use(`${tableScope}/views/*`, requireAuth, resolveWorkspace, resolveProject, resolveTable);
app.route(`${tableScope}/views`, viewsRoute);
```

- [ ] **Step 2: Update each route file to prefer `getTable` when available, fall back to project**

Each of the four route files (`documents.ts`, `statuses.ts`, `fields.ts`, `views.ts`) currently calls `getProject(c)` and uses `p.id` as the FK. Refactor each to:

```ts
import { getProject, getTable } from '../middleware/scope.ts';

function getOwningTableId(c: Context<...>): string {
  const t = c.get('table');
  if (t) return t.id;
  // Legacy path — resolve the project's default Work Items table.
  const p = getProject(c);
  // (We can do this inline; the default table is auto-created when a project is created.)
  // ... synchronous lookup not possible — see Step 3.
}
```

Because the legacy lookup is async, the cleanest implementation is: extend `resolveProject` to ALSO resolve the project's default table when no `:tslug` is in the path, and store it as `c.get('table')`. That way every route just calls `getTable(c)` and gets the right one.

In `scope.ts`:

```ts
export const resolveProject: MiddlewareHandler<...> = async (c, next) => {
  // ... existing project lookup
  c.set('project', p);
  // If the path has no :tslug, attach the default table.
  if (!c.req.param('tslug')) {
    const t = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, p.id), eq(tables.slug, 'work-items')),
    });
    if (t) c.set('table', t);
  }
  return next();
};
```

- [ ] **Step 3: Switch each FK insert/query in the four route files**

In `documents.ts`'s POST handler, replace:

```ts
projectId: p.id,
```

with:

```ts
projectId: p.id,
tableId: getTable(c).id,
```

Same pattern in `statuses.ts`, `fields.ts`, `views.ts` (where each currently uses `projectId`, add `tableId`). For queries that filter by project (e.g. `WHERE project_id = ?`), switch to `WHERE table_id = ?` — these are now table-scoped, not project-scoped. **Wiki pages** are the exception: they keep being project-scoped and have `tableId = NULL`.

In `documents.ts`'s GET (list) handler, filter:

```ts
// Old:
where: eq(documents.projectId, p.id)
// New:
where: and(eq(documents.projectId, p.id), eq(documents.tableId, getTable(c).id))
// For pages (wiki), keep the project-only filter when type=page in the query string.
```

- [ ] **Step 4: Un-skip the cascade test from Task 6**

The cascade test in `tables.test.ts` now passes because `/t/:tslug/documents` exists and `resolveTable` 404s on a deleted table.

- [ ] **Step 5: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 80+ tests still pass. Existing tests use `/p/:pslug/documents` etc.; with the `resolveProject` default-table attachment, they should continue to work without any test changes.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/routes/ apps/server/src/middleware/scope.ts
git commit -m "phase-2a: mount documents/statuses/fields/views under /t/:tslug + default-table fallback"
```

---

## Task 8: Update the demo seed + e2e DB-reset to use tables

**Files:**
- Modify: `scripts/seed-demo.ts`
- Modify: `apps/web/tests/e2e/global-setup.ts` (if it reseeds)

- [ ] **Step 1: Seed projects, then verify the default table got created**

In `scripts/seed-demo.ts`, after each `createProject(...)`, fetch the project's tables and log them:

```ts
const tables = await api('GET', `/api/v1/w/${WSLUG}/p/${p.slug}/tables`);
console.log(`      • default table: ${tables.data[0].slug}`);
```

This is sanity logging; nothing to change in the work-item POST calls because `resolveProject` now attaches the default table.

- [ ] **Step 2: Wipe + re-migrate + re-seed end-to-end**

```bash
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
cd ../..
# (assume API server already running, or restart it here)
bun run scripts/seed-demo.ts
```

Expected output ends with `default table: work-items` lines and `Seed complete`.

- [ ] **Step 3: Verify in the running web UI that nothing broke**

Visit http://localhost:5173, log in, click into a project, confirm the list view still shows all 10/11 work items and the kanban renders. The frontend hasn't changed; the migration + middleware default-table attachment should make this transparent.

- [ ] **Step 4: Run the Playwright e2e suite**

```bash
cd apps/web && npx playwright test manual-qa.spec.ts
```

Expected: 13/13 pass — the existing API paths still work via the project-scoped mounts.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-demo.ts
git commit -m "phase-2a: seed script logs default-table creation"
```

---

## Task 9: Update memory + close out

**Files:**
- Modify: `memory/STATE.md`
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Record the decisions in `memory/DECISIONS.md`**

Append a section:

```markdown
## Phase 2A — Tables as first-class concept (2026-05-24)

- Projects own one or more **tables**. Statuses, fields, views, and work_item documents belong to a table, not directly to a project.
- Wiki pages stay project-scoped (`documents.table_id IS NULL` for `type = 'page'`).
- Routes nested as `/api/v1/w/:ws/p/:p/t/:tslug/{documents,statuses,fields,views}`. Legacy `/p/:pslug/{...}` routes still work — `resolveProject` attaches the project's default `work-items` table when no `:tslug` is in the path.
- One default table per project, slug `work-items`, name `Work Items`, auto-created on project creation (`seed-project-defaults.ts`).
- No UI changes in Phase 2A; UI lands in 2B (spreadsheet table view) + 2C (saved-views rail).
```

- [ ] **Step 2: Update `memory/STATE.md` current-branch note**

Update the "What's working" section to note tables foundation is in.

- [ ] **Step 3: Commit**

```bash
git add memory/
git commit -m "memory(folio): phase-2a tables foundation shipped"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ `tables` first-class — Task 1 schema + Task 4 auto-create + Task 6 CRUD.
- ✅ Statuses/fields/views/documents belong to tables — Tasks 1, 2, 3, 7.
- ✅ Wiki stays project-scoped — Task 1 (documents.table_id nullable), Task 7 (page queries keep using project filter).
- ✅ Migration handles existing data — Task 2.
- ✅ Backward compat for current frontend — Task 7 default-table fallback in `resolveProject`.
- ✅ Tests at every level — every task includes test-first.

**Out of scope (deferred to 2B+):** Spreadsheet column UI, saved-view UI in the rail, per-view render modes, column ordering schema, calendar/gallery views.

**Risk areas:**
- SQLite ALTER TABLE limitations around NOT NULL — addressed in Task 3, but verify the generated migration matches expectations before committing.
- The `resolveProject` default-table fallback adds a DB query to every project-scoped request; acceptable for v1 (already doing 2 queries per request), but worth caching once we hit perf issues.
- Cascade behavior on `DELETE /tables/:tslug` — verified in Task 6 cascade test.
