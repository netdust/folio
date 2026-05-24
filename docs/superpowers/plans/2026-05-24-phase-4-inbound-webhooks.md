# Phase 4 — Inbound Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** External systems (Statamic contact forms, WordPress FluentForms, webshop checkouts, Stripe/Mollie, etc.) POST to a Folio webhook URL and a markdown document is created in a configured table with payload fields mapped to frontmatter.

**Architecture:** New `webhooks` table holds `(id, workspace_id, table_id, secret, name, mapping JSON, active, created_at)`. New public route `POST /api/v1/webhooks/:secret` matches by secret (no other auth — the secret IS the auth), looks up the configured table, applies the mapping to the JSON payload, creates a `work_item` document via the same code path as the authenticated POST. Mapping is a small `{ title: '$payload.subject', frontmatter: { customer_email: '$payload.email', ... }, body: '$payload.message' }` JSON config. Webhook CRUD lives at `/api/v1/w/:wslug/webhooks` for authenticated owners/admins.

**Tech Stack:** Existing — Bun + Hono + Drizzle + bun:sqlite + Zod. New: a tiny JSONPath-lite resolver for `$payload.<key>` references (no library — 30 lines of code). No new deps.

**Scope explicitly excluded:** HMAC signature verification (covered in a 4.1 follow-up if needed), retry/dead-letter queue, rate limiting per webhook, outbound webhooks (Folio → external), webhook frontend admin UI beyond a basic table (full UI lands in a separate small phase). The first iteration is API + CLI-driven webhook creation; the UI for managing webhooks is a 4.1 sub-phase.

---

## File Structure

**Create (backend):**
- `apps/server/src/db/schema.ts` — *extend* with `webhooks` table
- `apps/server/src/db/migrations/0005_phase_4_webhooks.sql` — generated migration
- `apps/server/src/routes/webhooks.ts` — public POST `/api/v1/webhooks/:secret` + authenticated CRUD `/api/v1/w/:wslug/webhooks`
- `apps/server/src/routes/webhooks.test.ts` — integration tests
- `apps/server/src/lib/payload-mapping.ts` — pure helper: resolve `$payload.key.nested` references against a JSON payload; return `{ title, body, frontmatter }`
- `apps/server/src/lib/payload-mapping.test.ts` — unit tests
- `apps/server/src/app.ts` — *mount* the new routes
- `packages/shared/src/webhook-mapping.ts` — shared types for `WebhookMapping`

**Frontend (admin only — Phase 4.1):**
- Out of scope for THIS plan. Webhook creation in 2.6 is via raw API call from the seed script or curl. Phase 4.1 adds the React admin UI.

**Untouched:**
- `documents.ts` route — webhook reuses its insert code path via a shared helper
- All Phase 2A/2B code

---

## Task 1: Schema — add the `webhooks` table

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Generate: `apps/server/src/db/migrations/0005_phase_4_webhooks.sql`

- [ ] **Step 1: Add the `webhooks` table to schema.ts**

After the `events` table block, append:

```ts
// --- Inbound webhooks ---

export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    secret: text('secret').notNull(),
    mapping: text('mapping', { mode: 'json' })
      .$type<WebhookMapping>()
      .notNull()
      .default({ title: null, body: null, frontmatter: {} }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastFiredAt: integer('last_fired_at', { mode: 'timestamp_ms' }),
    createdBy: text('created_by').references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    secretIdx: uniqueIndex('webhooks_secret_idx').on(t.secret),
    workspaceIdx: index('webhooks_workspace_idx').on(t.workspaceId),
  }),
);

export type Webhook = typeof webhooks.$inferSelect;

export interface WebhookMapping {
  /** A `$payload.key` reference, a literal string, or null (auto-derive from body). */
  title: string | null;
  /** A `$payload.key` reference or null (empty body). */
  body: string | null;
  /** Map of frontmatter key → `$payload.key` reference or literal value. */
  frontmatter: Record<string, string>;
}
```

The `WebhookMapping` interface gets exported because the migration's `default()` references it AND the route + helper files need it. Re-export from `packages/shared/src/index.ts` in Task 2 so both server and (future) web can use it.

- [ ] **Step 2: Generate the migration**

From repo root:

```bash
bun --filter @folio/server db:generate
```

Drizzle emits `0005_<random>.sql`. Rename it to `0005_phase_4_webhooks.sql` and update the latest entry in `apps/server/src/db/migrations/meta/_journal.json` so its `tag` matches.

- [ ] **Step 3: Inspect the generated SQL**

```bash
cat apps/server/src/db/migrations/0005_phase_4_webhooks.sql
```

Expected:
- `CREATE TABLE webhooks (...)` with all columns
- `CREATE UNIQUE INDEX webhooks_secret_idx ON webhooks (secret)`
- `CREATE INDEX webhooks_workspace_idx ON webhooks (workspace_id, created_at)` (the index is on `(workspaceId, createdAt)` if you put `t.createdAt` in there; if only `t.workspaceId`, the index is single-column — adjust if needed)

No backfill is required — the table starts empty on every existing project.

- [ ] **Step 4: Verify the migration applies cleanly**

```bash
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
```

Expected: `Migrations complete.` with no errors. Then:

```bash
bun -e '
import { Database } from "bun:sqlite";
const db = new Database("./folio.db");
const cols = db.query("PRAGMA table_info(webhooks)").all();
console.log("webhooks cols:", cols.map(c => c.name).join(", "));
'
```

Expected: `id, workspace_id, table_id, name, secret, mapping, active, last_fired_at, created_by, created_at`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-4: add webhooks schema + migration"
```

---

## Task 2: Shared types in `packages/shared`

**Files:**
- Create: `packages/shared/src/webhook-mapping.ts`
- Modify: `packages/shared/src/index.ts` — re-export from the new file

- [ ] **Step 1: Create the shared types module**

Create `packages/shared/src/webhook-mapping.ts`:

```ts
export interface WebhookMapping {
  /** A `$payload.key` reference, a literal string, or null (auto-derive from body). */
  title: string | null;
  /** A `$payload.key` reference or null (empty body). */
  body: string | null;
  /** Map of frontmatter key → `$payload.key` reference or literal value. */
  frontmatter: Record<string, string>;
}
```

- [ ] **Step 2: Re-export from the shared index**

In `packages/shared/src/index.ts`, append:

```ts
export type { WebhookMapping } from './webhook-mapping.ts';
```

- [ ] **Step 3: Update `apps/server/src/db/schema.ts`**

Replace the inline `WebhookMapping` interface (added in Task 1) with an import from the shared package:

```ts
import type { WebhookMapping } from '@folio/shared';
```

Remove the local `interface WebhookMapping` block. Keep the `.default({...})` on the column.

- [ ] **Step 4: Run server tests — no regression**

```bash
cd apps/server && bun test
```

Expected: 112 / 0 (baseline unchanged — no behavior change in this task).

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/server/src/db/schema.ts
git commit -m "phase-4: WebhookMapping type in @folio/shared"
```

---

## Task 3: Payload mapping helper (pure)

**Files:**
- Create: `apps/server/src/lib/payload-mapping.ts`
- Create: `apps/server/src/lib/payload-mapping.test.ts`

A pure helper that takes a `WebhookMapping` + a JSON payload and resolves it into `{ title, body, frontmatter }` suitable for the document insert. Reference syntax is `$payload.key.nested` — anything not starting with `$payload.` is a literal.

- [ ] **Step 1: Write the failing tests first**

Create `apps/server/src/lib/payload-mapping.test.ts`:

```ts
import { test, expect } from 'bun:test';
import type { WebhookMapping } from '@folio/shared';
import { resolveMapping } from './payload-mapping.ts';

test('resolveMapping: top-level $payload.key', () => {
  const mapping: WebhookMapping = {
    title: '$payload.subject',
    body: '$payload.message',
    frontmatter: { customer_email: '$payload.email' },
  };
  const payload = { subject: 'Hello', message: 'World', email: 'a@b.com' };
  expect(resolveMapping(mapping, payload)).toEqual({
    title: 'Hello',
    body: 'World',
    frontmatter: { customer_email: 'a@b.com' },
  });
});

test('resolveMapping: nested $payload.foo.bar', () => {
  const mapping: WebhookMapping = {
    title: '$payload.customer.name',
    body: null,
    frontmatter: { email: '$payload.customer.email' },
  };
  const payload = { customer: { name: 'Alice', email: 'a@b.com' } };
  expect(resolveMapping(mapping, payload)).toEqual({
    title: 'Alice',
    body: '',
    frontmatter: { email: 'a@b.com' },
  });
});

test('resolveMapping: literal strings (no $payload prefix) pass through', () => {
  const mapping: WebhookMapping = {
    title: 'New order',
    body: null,
    frontmatter: { source: 'webhook', region: 'eu' },
  };
  expect(resolveMapping(mapping, { foo: 'bar' })).toEqual({
    title: 'New order',
    body: '',
    frontmatter: { source: 'webhook', region: 'eu' },
  });
});

test('resolveMapping: missing path returns empty string', () => {
  const mapping: WebhookMapping = {
    title: '$payload.nope',
    body: '$payload.missing.path',
    frontmatter: { x: '$payload.also.missing' },
  };
  expect(resolveMapping(mapping, { other: 'data' })).toEqual({
    title: '',
    body: '',
    frontmatter: { x: '' },
  });
});

test('resolveMapping: null title becomes empty string (caller falls back to "Untitled")', () => {
  const mapping: WebhookMapping = { title: null, body: null, frontmatter: {} };
  expect(resolveMapping(mapping, {})).toEqual({
    title: '',
    body: '',
    frontmatter: {},
  });
});

test('resolveMapping: non-string payload values are coerced via String()', () => {
  const mapping: WebhookMapping = {
    title: '$payload.id',
    body: null,
    frontmatter: { count: '$payload.count', flag: '$payload.flag' },
  };
  const payload = { id: 42, count: 0, flag: true };
  expect(resolveMapping(mapping, payload)).toEqual({
    title: '42',
    body: '',
    frontmatter: { count: '0', flag: 'true' },
  });
});

test('resolveMapping: $payload alone (no key) returns the whole payload as JSON string', () => {
  const mapping: WebhookMapping = {
    title: 'order',
    body: '$payload',
    frontmatter: {},
  };
  const payload = { id: 1, name: 'x' };
  const result = resolveMapping(mapping, payload);
  expect(result.body).toBe(JSON.stringify(payload));
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd apps/server && bun test src/lib/payload-mapping.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the helper**

Create `apps/server/src/lib/payload-mapping.ts`:

```ts
import type { WebhookMapping } from '@folio/shared';

const PREFIX = '$payload';

function pickPath(payload: unknown, path: string[]): unknown {
  let cur: unknown = payload;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Resolve a single reference string against a payload.
 * - `$payload` → JSON-stringified whole payload
 * - `$payload.key.nested` → walked path, coerced via String(), missing → ''
 * - anything else → returned verbatim as a literal string
 */
function resolve(ref: string | null, payload: unknown): string {
  if (ref == null) return '';
  if (ref === PREFIX) return JSON.stringify(payload);
  if (ref.startsWith(`${PREFIX}.`)) {
    const path = ref.slice(PREFIX.length + 1).split('.');
    const v = pickPath(payload, path);
    if (v == null) return '';
    return String(v);
  }
  return ref;
}

export interface ResolvedDocument {
  title: string;
  body: string;
  frontmatter: Record<string, string>;
}

export function resolveMapping(
  mapping: WebhookMapping,
  payload: unknown,
): ResolvedDocument {
  const frontmatter: Record<string, string> = {};
  for (const [k, ref] of Object.entries(mapping.frontmatter)) {
    frontmatter[k] = resolve(ref, payload);
  }
  return {
    title: resolve(mapping.title, payload),
    body: resolve(mapping.body, payload),
    frontmatter,
  };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

```bash
cd apps/server && bun test src/lib/payload-mapping.test.ts
```

Expected: 7 / 7 pass.

- [ ] **Step 5: Run the full server suite — no regression**

```bash
cd apps/server && bun test
```

Expected: 119 / 0 (112 baseline + 7 new).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/payload-mapping.ts apps/server/src/lib/payload-mapping.test.ts
git commit -m "phase-4: payload-mapping helper (resolves \$payload.key refs)"
```

---

## Task 4: Public inbound POST `/api/v1/webhooks/:secret`

**Files:**
- Create: `apps/server/src/routes/webhooks.ts`
- Modify: `apps/server/src/app.ts` (mount)
- Create: `apps/server/src/routes/webhooks.test.ts`

The public POST route. No session, no token — secret-in-URL is the auth. Look up the webhook by secret, resolve mapping against the JSON payload, create a `work_item` document scoped to the webhook's table, return 202 Accepted with the created doc's slug.

The mapping is applied → a `frontmatter` object is built → `{ type: 'work_item', title, body, frontmatter }` is inserted. We don't re-export the documents.ts route logic to avoid the auth middleware getting in the way; we inline a small `insertDocumentFromWebhook` call that:
1. Validates the title (fallback to `'Untitled'` if empty)
2. Generates a unique slug
3. Inserts the row with `tableId: webhook.tableId`, `createdBy: webhook.createdBy ?? null`
4. Emits a `document.created` event AND a `webhook.fired` event in the same transaction
5. Bumps `webhooks.last_fired_at`

- [ ] **Step 1: Write the failing test FIRST**

Create `apps/server/src/routes/webhooks.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { webhooks } from '../db/schema.ts';

async function createWebhook(db: any, workspaceId: string, tableId: string, mapping: any, userId: string | null = null) {
  const id = nanoid();
  const secret = nanoid(32);
  await db.insert(webhooks).values({
    id,
    workspaceId,
    tableId,
    name: 'Test webhook',
    secret,
    mapping,
    active: true,
    createdBy: userId,
  });
  return { id, secret };
}

test('POST /api/v1/webhooks/:secret 200 creates a document from the payload', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { secret } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: '$payload.subject',
    body: '$payload.message',
    frontmatter: { customer_email: '$payload.email' },
  }, seed.user.id);

  const res = await app.request(`/api/v1/webhooks/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'New order #42', message: 'Hello', email: 'buyer@example.com' }),
  });

  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body.data.slug).toBe('new-order-42');
  expect(body.data.title).toBe('New order #42');
});

test('POST /api/v1/webhooks/:secret 404 on unknown secret', async () => {
  const { app } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request('/api/v1/webhooks/nope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('WEBHOOK_NOT_FOUND');
});

test('POST /api/v1/webhooks/:secret 403 when webhook is inactive', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { secret } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: 'x', body: null, frontmatter: {},
  });
  await db.update(webhooks).set({ active: false }).where(eq(webhooks.secret, secret));

  const res = await app.request(`/api/v1/webhooks/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('WEBHOOK_INACTIVE');
});

test('POST /api/v1/webhooks/:secret falls back to title="Untitled" when mapping resolves empty', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { secret } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: '$payload.missing',
    body: null,
    frontmatter: {},
  });

  const res = await app.request(`/api/v1/webhooks/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(202);
  expect((await res.json()).data.title).toBe('Untitled');
});

test('POST /api/v1/webhooks/:secret bumps last_fired_at', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { id: webhookId, secret } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: 'x', body: null, frontmatter: {},
  });

  const before = (await db.query.webhooks.findFirst({ where: eq(webhooks.id, webhookId) }))!;
  expect(before.lastFiredAt).toBeNull();

  await app.request(`/api/v1/webhooks/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  const after = (await db.query.webhooks.findFirst({ where: eq(webhooks.id, webhookId) }))!;
  expect(after.lastFiredAt).not.toBeNull();
});

test('POST /api/v1/webhooks/:secret 400 on invalid JSON', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { secret } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: 'x', body: null, frontmatter: {},
  });

  const res = await app.request(`/api/v1/webhooks/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  expect(res.status).toBe(400);
});
```

**Harness note**: this test references `seed.workspace.id`, `seed.user.id`, and `seed.workItemsTableId`. Verify the test harness already exposes these; if not, extend `apps/server/src/test/harness.ts` to also return the default Work Items table id when `seedProjectDefaults: true`. Inspect the harness first:

```bash
cat apps/server/src/test/harness.ts
```

If `workItemsTableId` is missing, add it to the returned `seed` object — it's a one-line query for the project's `work-items` slug table.

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd apps/server && bun test src/routes/webhooks.test.ts
```

Expected: module-not-found (routes/webhooks.ts doesn't exist yet).

- [ ] **Step 3: Implement the route**

Create `apps/server/src/routes/webhooks.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { slugify } from '@folio/shared';
import { db } from '../db/client.ts';
import { documents, webhooks } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { resolveMapping } from '../lib/payload-mapping.ts';
import { slugUniqueInDocuments } from '../lib/slug-unique.ts';

// Public webhook route — no auth middleware. The :secret IS the auth.
const publicWebhooksRoute = new Hono();

publicWebhooksRoute.post('/:secret', async (c) => {
  const secret = c.req.param('secret');
  const webhook = await db.query.webhooks.findFirst({
    where: eq(webhooks.secret, secret),
  });
  if (!webhook) throw new HTTPError('WEBHOOK_NOT_FOUND', 'unknown webhook', 404);
  if (!webhook.active) throw new HTTPError('WEBHOOK_INACTIVE', 'webhook is disabled', 403);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    throw new HTTPError('INVALID_BODY', 'request body must be valid JSON', 400);
  }

  const { title, body, frontmatter } = resolveMapping(webhook.mapping, payload);
  const safeTitle = title.trim() || 'Untitled';
  const baseSlug = slugify(safeTitle) || 'doc';

  const id = nanoid();
  const row = {
    id,
    projectId: '',                       // filled below
    tableId: webhook.tableId,
    type: 'work_item' as const,
    slug: '',                            // filled below
    title: safeTitle,
    status: null,
    body,
    frontmatter,
    parentId: null,
    createdBy: webhook.createdBy,
    updatedBy: webhook.createdBy,
  };

  await db.transaction(async (tx) => {
    // Look up the table's projectId so we can scope the slug uniqueness check.
    const t = await tx.query.tables.findFirst({
      where: (tbl, { eq: e }) => e(tbl.id, webhook.tableId),
    });
    if (!t) throw new HTTPError('TABLE_NOT_FOUND', 'webhook target table missing', 500);
    row.projectId = t.projectId;
    row.slug = await slugUniqueInDocuments(tx, t.projectId, baseSlug);

    await tx.insert(documents).values(row);
    await emitEvent(tx, {
      workspaceId: webhook.workspaceId,
      projectId: t.projectId,
      documentId: id,
      kind: 'document.created',
      actor: webhook.createdBy ?? 'webhook',
      payload: { slug: row.slug, type: 'work_item', via: 'webhook', webhookId: webhook.id },
    });
    await emitEvent(tx, {
      workspaceId: webhook.workspaceId,
      projectId: t.projectId,
      kind: 'webhook.fired',
      actor: 'webhook',
      payload: { webhookId: webhook.id, documentId: id },
    });
    await tx.update(webhooks)
      .set({ lastFiredAt: new Date() })
      .where(eq(webhooks.id, webhook.id));
  });

  return jsonOk(c, row, 202);
});

export { publicWebhooksRoute };
```

- [ ] **Step 4: Mount the route in `app.ts`**

Open `apps/server/src/app.ts`. Find the `v1.route('/auth', auth);` line. Add:

```ts
import { publicWebhooksRoute } from './routes/webhooks.ts';
// ... after v1 is created ...
v1.route('/webhooks', publicWebhooksRoute);
```

Mount it BEFORE the workspaces / wScope routes since it's public. The route is `/api/v1/webhooks/:secret` so there's no conflict with `/api/v1/workspaces`.

- [ ] **Step 5: Add `workItemsTableId` to the test harness if missing**

If Step 1 revealed the harness doesn't return it, modify `apps/server/src/test/harness.ts`:

In the section where `seedProjectDefaults` runs, capture the returned `tableId` (from Phase 2A's `seedProjectDefaults` return value `{ tableId }`) and add it to the returned `seed`:

```ts
// inside makeTestApp when seedProjectDefaults: true
const { tableId } = await seedProjectDefaults(tx, projectId);
// ... existing returns
return { app, db, seed: { ...existing, workItemsTableId: tableId } };
```

If the harness doesn't currently call `seedProjectDefaults` and capture its return, audit it — it might already be there from Phase 2A. If so, ensure `workItemsTableId` is exposed.

- [ ] **Step 6: Run the tests, verify they pass**

```bash
cd apps/server && bun test src/routes/webhooks.test.ts
```

Expected: 6 / 6 pass.

- [ ] **Step 7: Run the full server suite — no regression**

```bash
cd apps/server && bun test
```

Expected: 125 / 0 (119 + 6 new).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/routes/webhooks.ts apps/server/src/routes/webhooks.test.ts apps/server/src/app.ts apps/server/src/test/harness.ts
git commit -m "phase-4: public POST /api/v1/webhooks/:secret creates doc from payload"
```

---

## Task 5: Authenticated webhook CRUD `/api/v1/w/:wslug/webhooks`

**Files:**
- Modify: `apps/server/src/routes/webhooks.ts` — add the authenticated router
- Modify: `apps/server/src/app.ts` — mount under workspace scope
- Modify: `apps/server/src/routes/webhooks.test.ts` — add CRUD tests

Authenticated endpoints for owners/admins to list, create, update, delete webhooks. Members CAN list but cannot create/update/delete.

- [ ] **Step 1: Add CRUD tests to `webhooks.test.ts`**

Append these tests at the end of the existing test file:

```ts
test('GET /webhooks lists webhooks for the workspace', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: 'x', body: null, frontmatter: {},
  });
  const res = await app.request('/api/v1/w/acme/webhooks', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ name: 'Test webhook' });
  // Secret should be REDACTED in list responses — never leak it after creation.
  expect(body.data[0].secret).toBeUndefined();
});

test('POST /webhooks creates a webhook and returns secret ONCE', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request('/api/v1/w/acme/webhooks', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Contact form',
      tableId: seed.workItemsTableId,
      mapping: {
        title: '$payload.subject',
        body: '$payload.message',
        frontmatter: { customer_email: '$payload.email' },
      },
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.secret).toBeTruthy();
  expect(body.data.secret.length).toBeGreaterThanOrEqual(20);
  expect(body.data.url).toMatch(/\/api\/v1\/webhooks\//);
});

test('POST /webhooks 422 on invalid mapping shape', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request('/api/v1/w/acme/webhooks', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad',
      tableId: seed.workItemsTableId,
      mapping: 'not an object',
    }),
  });
  expect(res.status).toBe(422);
});

test('POST /webhooks 404 when tableId belongs to another workspace', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  // Create a second workspace + table; try to attach a webhook in the first workspace to that table.
  const { workspaces, projects, tables, memberships } = await import('../db/schema.ts');
  const otherWsId = nanoid();
  await db.insert(workspaces).values({ id: otherWsId, slug: 'other', name: 'Other' });
  await db.insert(memberships).values({ workspaceId: otherWsId, userId: seed.user.id, role: 'owner' });
  const otherProjectId = nanoid();
  await db.insert(projects).values({ id: otherProjectId, workspaceId: otherWsId, slug: 'p2', name: 'P2' });
  const otherTableId = nanoid();
  await db.insert(tables).values({ id: otherTableId, projectId: otherProjectId, slug: 't2', name: 'T2' });

  const res = await app.request('/api/v1/w/acme/webhooks', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cross-tenant attempt',
      tableId: otherTableId,
      mapping: { title: 'x', body: null, frontmatter: {} },
    }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('TABLE_NOT_FOUND');
});

test('PATCH /webhooks/:id renames + toggles active', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { id } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: 'x', body: null, frontmatter: {},
  });
  const res = await app.request(`/api/v1/w/acme/webhooks/${id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', active: false }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.name).toBe('Renamed');
  expect(body.data.active).toBe(false);
});

test('DELETE /webhooks/:id returns 204', async () => {
  const { app, db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const { id } = await createWebhook(db, seed.workspace.id, seed.workItemsTableId, {
    title: 'x', body: null, frontmatter: {},
  });
  const res = await app.request(`/api/v1/w/acme/webhooks/${id}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('GET /webhooks 401 without session', async () => {
  const { app } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request('/api/v1/w/acme/webhooks');
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run the new tests, verify they fail**

```bash
cd apps/server && bun test src/routes/webhooks.test.ts
```

Expected: 7 new failures (the CRUD routes don't exist yet). The 6 from Task 4 should still pass.

- [ ] **Step 3: Add the authenticated router to `webhooks.ts`**

In `apps/server/src/routes/webhooks.ts`, append after the `publicWebhooksRoute` export:

```ts
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth.ts';
import { getUser } from '../middleware/auth.ts';
import { getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import { tables } from '../db/schema.ts';

const mappingSchema = z.object({
  title: z.string().nullable(),
  body: z.string().nullable(),
  frontmatter: z.record(z.string()),
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  tableId: z.string().min(1),
  mapping: mappingSchema,
  active: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  mapping: mappingSchema.optional(),
  active: z.boolean().optional(),
});

const workspaceWebhooksRoute = new Hono<AuthContext & ScopeContext>();

function redact(w: typeof webhooks.$inferSelect, includeSecret = false) {
  const { secret, ...rest } = w;
  if (includeSecret) return { ...rest, secret };
  return rest;
}

workspaceWebhooksRoute.get('/', async (c) => {
  const ws = getWorkspace(c);
  const rows = await db.query.webhooks.findMany({
    where: eq(webhooks.workspaceId, ws.id),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return jsonOk(c, rows.map((r) => redact(r)));
});

workspaceWebhooksRoute.post('/', zValidator('json', createSchema), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');

  // Verify the target table belongs to a project inside this workspace.
  const t = await db.query.tables.findFirst({
    where: eq(tables.id, input.tableId),
  });
  if (!t) throw new HTTPError('TABLE_NOT_FOUND', `table not found`, 404);
  const proj = await db.query.projects.findFirst({
    where: (p, { eq: e }) => e(p.id, t.projectId),
  });
  if (!proj || proj.workspaceId !== ws.id) {
    throw new HTTPError('TABLE_NOT_FOUND', `table not in this workspace`, 404);
  }

  const id = nanoid();
  const secret = nanoid(32);
  const row = {
    id,
    workspaceId: ws.id,
    tableId: input.tableId,
    name: input.name,
    secret,
    mapping: input.mapping,
    active: input.active ?? true,
    createdBy: user.id,
  };
  await db.transaction(async (tx) => {
    await tx.insert(webhooks).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: t.projectId,
      kind: 'webhook.created',
      actor: user.id,
      payload: { id, name: input.name, tableId: input.tableId },
    });
  });

  // Return secret + URL ONCE on creation.
  return jsonOk(c, { ...redact(row, true), url: `/api/v1/webhooks/${secret}` }, 201);
});

workspaceWebhooksRoute.patch('/:id', zValidator('json', patchSchema), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const existing = await db.query.webhooks.findFirst({
    where: and(eq(webhooks.id, id), eq(webhooks.workspaceId, ws.id)),
  });
  if (!existing) throw new HTTPError('WEBHOOK_NOT_FOUND', `webhook "${id}" not found`, 404);
  const patch = c.req.valid('json');
  await db.transaction(async (tx) => {
    await tx.update(webhooks).set(patch).where(eq(webhooks.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: '',
      kind: 'webhook.updated',
      actor: user.id,
      payload: { id, changes: Object.keys(patch) },
    });
  });
  return jsonOk(c, redact({ ...existing, ...patch }));
});

workspaceWebhooksRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const existing = await db.query.webhooks.findFirst({
    where: and(eq(webhooks.id, id), eq(webhooks.workspaceId, ws.id)),
  });
  if (!existing) throw new HTTPError('WEBHOOK_NOT_FOUND', `webhook "${id}" not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(webhooks).where(eq(webhooks.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: '',
      kind: 'webhook.deleted',
      actor: user.id,
      payload: { id, name: existing.name },
    });
  });
  return c.body(null, 204);
});

export { workspaceWebhooksRoute };
```

Note: the `events.kind` union needs `webhook.created`, `webhook.updated`, `webhook.deleted`, `webhook.fired` added — extend `apps/server/src/lib/events.ts`'s `EventKind` type. Pattern mirrors how Phase 2A added `table.*` kinds (commit `19fdac8`).

- [ ] **Step 4: Mount the workspace router in `app.ts`**

In `apps/server/src/app.ts`, find the `wScope` block (where `wScope.route('/projects', projectsRoute)` etc. live). Add:

```ts
import { workspaceWebhooksRoute, publicWebhooksRoute } from './routes/webhooks.ts';
// ... in wScope:
wScope.route('/webhooks', workspaceWebhooksRoute);
```

The `publicWebhooksRoute` mount from Task 4 stays as-is.

- [ ] **Step 5: Run the tests, verify they pass**

```bash
cd apps/server && bun test src/routes/webhooks.test.ts
```

Expected: 13 / 13 pass.

- [ ] **Step 6: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 132 / 0 (125 + 7 new). If any pre-existing tests regress, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/webhooks.ts apps/server/src/routes/webhooks.test.ts apps/server/src/app.ts apps/server/src/lib/events.ts
git commit -m "phase-4: authenticated CRUD for /webhooks (workspace-scoped, secret returned once)"
```

---

## Task 6: Smoke test against a running server

**Files:**
- Modify: `scripts/seed-demo.ts` — optionally seed one demo webhook per project

A quick end-to-end check: wipe DB, seed, create a webhook via the API, POST a fake "contact form" payload to it, verify the doc landed.

- [ ] **Step 1: Add a demo webhook to the seed**

In `scripts/seed-demo.ts`, find the project-creation loop (after the standard fields are registered). Add at the bottom of the loop:

```ts
const tablesResForWebhook = await api('GET', `/api/v1/w/${WSLUG}/p/${p.slug}/tables`);
const defaultTableId = tablesResForWebhook.data.find((t) => t.slug === 'work-items').id;
const webhookRes = await api('POST', `/api/v1/w/${WSLUG}/webhooks`, {
  name: `${p.name} — contact form`,
  tableId: defaultTableId,
  mapping: {
    title: '$payload.subject',
    body: '$payload.message',
    frontmatter: { customer_email: '$payload.email', source: 'demo-webhook' },
  },
});
console.log(`      • webhook ${webhookRes.data.name} → ${webhookRes.data.url}`);
```

- [ ] **Step 2: Wipe + remigrate + reseed**

```bash
cd /home/ntdst/Projects/folio
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
cd /home/ntdst/Projects/folio
# Server must be running. Start it in background or skip if already running.
cd apps/server && bun --hot src/index.ts &
SERVER_PID=$!
sleep 2
cd /home/ntdst/Projects/folio
bun run scripts/seed-demo.ts
```

Expected output: each project logs `webhook <name> → /api/v1/webhooks/<secret>`. Copy one of those URLs for the next step.

- [ ] **Step 3: Fire a payload at the webhook**

```bash
# Replace <SECRET> with the secret printed in step 2.
curl -s -X POST http://localhost:3001/api/v1/webhooks/<SECRET> \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Smoke test — contact form submission",
    "message": "Hi, I would like to know more about your services. Best, Alice.",
    "email": "alice@example.com"
  }'
```

Expected: 202 response with `data.slug` like `smoke-test-contact-form-submission`. The new doc shows up in the project's work-items list at http://localhost:5173 (if web is also running).

- [ ] **Step 4: Verify in the running web UI**

Browse to the project's work-items table. The new doc appears at the top with `customer_email` and `source` populated from the webhook mapping.

- [ ] **Step 5: Kill the background server**

```bash
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-demo.ts
git commit -m "phase-4: seed-demo creates a demo webhook per project"
```

---

## Task 7: Memory + close-out

**Files:**
- Modify: `memory/STATE.md`
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Update STATE.md**

Mark Phase 4 as shipped, list the new capability, bump test counts (~132 server).

- [ ] **Step 2: Update DECISIONS.md**

Add a Phase 4 section:

```markdown
## Phase 4 — Inbound webhooks (2026-XX-XX)

- Public POST `/api/v1/webhooks/:secret` creates a `work_item` document in the configured table from the JSON payload via stored mapping.
- The :secret IS the auth. Rotate by deleting + recreating the webhook (no in-place secret rotation in v1).
- Mapping uses `$payload.key.nested` references; literals pass through. JSON-stringify the whole payload via bare `$payload`. Missing paths resolve to empty string.
- `webhooks.last_fired_at` is bumped on every successful POST.
- Events: `webhook.created`, `webhook.updated`, `webhook.deleted`, `webhook.fired`.
- Authenticated CRUD lives at `/api/v1/w/:wslug/webhooks` (owners + admins). Secret returned ONCE on creation; list responses redact it.
- Out of scope for 2.6: HMAC verification, retries, frontend admin UI (4.1 follow-up).
```

- [ ] **Step 3: Commit**

```bash
git add memory/STATE.md memory/DECISIONS.md
git commit -m "memory(folio): close out Phase 4 inbound webhooks"
```

---

## Self-Review

**Spec coverage:**
- ✅ Public POST creates doc — Task 4
- ✅ Workspace-scoped CRUD — Task 5
- ✅ Field mapping via `$payload.key` — Task 3 + Task 4
- ✅ Secret-in-URL auth — Task 4
- ✅ Workspace cross-tenant guard — Task 5
- ✅ Smoke verification — Task 6
- ✅ Memory close-out — Task 7

**Out of scope and deferred to 4.1:**
- Frontend admin UI for managing webhooks
- HMAC signature verification (alternative auth)
- Per-webhook rate limiting
- Retry queue for failed handler runs (currently the POST runs inline; a 500 in `slugUniqueInDocuments` or DB failure surfaces a 500 to the caller, who must retry)
- Outbound webhook deliveries (Folio → external) — fundamentally different feature, deferred

**Risk areas:**
- The secret in the URL appears in server logs by default. Recommend customer's reverse proxy redacts these or doesn't log webhook URLs. Document in Phase 4.1.
- A high-volume sender could fill `events` with `webhook.fired` rows. Phase 3+ should consider archiving / compaction.
- `slugUniqueInDocuments` does a `LIKE` query per insert — for 10k+ docs in a single project this gets slow. v1 fine; Phase 3+ should add an index or switch to ID-based slugs.
