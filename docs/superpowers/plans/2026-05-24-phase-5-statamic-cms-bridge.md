# Phase 5 — Statamic CMS Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Folio documents can be published to a Statamic site. A document with status `published` in a "Content pipeline" table syncs to a Statamic collection entry; subsequent edits replicate; unpublishing deletes the entry. The user configures one or more "sync targets" per workspace pointing at a Statamic instance.

**Architecture:** New `sync_targets` table holds connection config (base URL, API token, collection slug, table_id source, status field mapping). A small `StatamicAdapter` class wraps Statamic's REST API (auth header, collection POST/PATCH/DELETE). A "sync engine" subscribes to `document.updated`/`document.created`/`document.deleted` events for documents in a sync-target's source table, computes the desired state, and pushes to Statamic. Sync runs synchronously inside the same request transaction for v1 — failures surface as toasts; in v5.1 we'll move to a queue. New `sync_log` table records every attempt for visibility + retry.

**Tech Stack:** Existing — Bun + Hono + Drizzle + bun:sqlite. New: native `fetch` against Statamic's REST API; no SDK dep. Auth: Statamic API tokens (bearer header). Folio stores the token libsodium-encrypted in `ai_keys`-style fashion (reuse existing crypto helpers).

**Scope explicitly excluded:** WordPress adapter (Phase 5.1 follow-up; same architecture, different adapter class), bidirectional sync (Statamic → Folio), asset/image upload (v1 publishes text-only entries; clients add images directly in Statamic), conflict resolution beyond last-write-wins, scheduled publish (Statamic handles that; Folio just sets the `published_at` field), multi-site Statamic targets per workspace (v1 supports one target per source table — add multiple in 5.1).

**Reference:** [Statamic REST API docs](https://statamic.dev/rest-api). Auth via `Authorization: Bearer <token>`; collection entries at `POST /api/collections/{handle}/entries`; PATCH at `/api/collections/{handle}/entries/{id}`; DELETE at the same path. Statamic returns the created/updated entry with its assigned `id` — we store that mapping so updates know which entry to patch.

---

## File Structure

**Create (backend):**
- `apps/server/src/db/schema.ts` — *extend* with `sync_targets` and `sync_log` tables
- `apps/server/src/db/migrations/0006_phase_5_sync_targets.sql` — generated migration
- `apps/server/src/lib/adapters/statamic.ts` — `StatamicAdapter` class
- `apps/server/src/lib/adapters/statamic.test.ts` — unit tests using stubbed `fetch`
- `apps/server/src/lib/adapters/interface.ts` — `CmsAdapter` interface (forward-compatible with future WordPress adapter)
- `apps/server/src/lib/sync-engine.ts` — picks an adapter per target, computes the push/patch/delete, writes to `sync_log`
- `apps/server/src/lib/sync-engine.test.ts` — integration tests
- `apps/server/src/lib/sync-mapping.ts` — pure: doc.frontmatter → Statamic blueprint fields per target's mapping config
- `apps/server/src/lib/sync-mapping.test.ts` — unit tests
- `apps/server/src/routes/sync-targets.ts` — workspace-scoped CRUD
- `apps/server/src/routes/sync-targets.test.ts` — integration tests
- `apps/server/src/app.ts` — *mount* the new routes
- `apps/server/src/routes/documents.ts` — *extend* PATCH to invoke sync after commit
- `packages/shared/src/sync-target.ts` — shared types

**Frontend:**
- Out of scope for THIS plan. A management UI (`/w/:wslug/settings/sync`) lands in 5.0.1 — for v1, configure sync targets via the seed script or curl.

**Untouched:**
- All Phase 2 code
- The webhook code from 2.6 (sync is INDEPENDENT of webhooks — they happen to use the same `events` table for observability)

---

## Task 1: Schema — `sync_targets` and `sync_log`

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Generate: `apps/server/src/db/migrations/0006_phase_5_sync_targets.sql`

- [ ] **Step 1: Add the two tables to `schema.ts`**

After the `webhooks` table block (from Phase 4), append:

```ts
// --- CMS sync targets (Phase 5) ---

export const syncTargets = sqliteTable(
  'sync_targets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceTableId: text('source_table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'statamic' (5.0). 'wordpress' lands in 5.1. */
    adapter: text('adapter', { enum: ['statamic'] }).notNull(),
    /** Statamic base URL, e.g. https://example.com */
    baseUrl: text('base_url').notNull(),
    /** Collection handle on the Statamic side, e.g. 'blog' */
    collectionHandle: text('collection_handle').notNull(),
    /** Libsodium-encrypted Statamic API token. */
    tokenEncrypted: text('token_encrypted').notNull(),
    /** Doc status (in Folio) that triggers publish. Defaults to 'published'. */
    publishOnStatus: text('publish_on_status').notNull().default('published'),
    /** Frontmatter → Statamic blueprint field mapping. JSON. */
    mapping: text('mapping', { mode: 'json' })
      .$type<SyncMapping>()
      .notNull()
      .default({ fields: {} }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    workspaceIdx: index('sync_targets_workspace_idx').on(t.workspaceId),
    sourceTableIdx: index('sync_targets_source_table_idx').on(t.sourceTableId),
  }),
);

export type SyncTarget = typeof syncTargets.$inferSelect;

/** Records each push/patch/delete attempt for visibility + retry. */
export const syncLog = sqliteTable(
  'sync_log',
  {
    id: text('id').primaryKey(),
    syncTargetId: text('sync_target_id')
      .notNull()
      .references(() => syncTargets.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** The remote (Statamic) entry id once we've published it. Null until first push. */
    remoteId: text('remote_id'),
    operation: text('operation', { enum: ['create', 'update', 'delete'] }).notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    /** HTTP status if applicable; null otherwise. */
    httpStatus: integer('http_status'),
    /** Error message or empty string. */
    error: text('error').notNull().default(''),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    targetIdx: index('sync_log_target_idx').on(t.syncTargetId, t.createdAt),
    documentIdx: index('sync_log_document_idx').on(t.documentId),
  }),
);

export type SyncLogRow = typeof syncLog.$inferSelect;

export interface SyncMapping {
  /**
   * Map of Statamic blueprint field handle → source.
   * `$title`, `$body`, `$slug` reference Folio document built-ins.
   * `$frontmatter.key` references frontmatter. Anything else is a literal.
   *
   * Example: { title: '$title', content: '$body', author: 'stefan' }
   */
  fields: Record<string, string>;
}
```

Note the `SyncMapping` interface — same pattern as Phase 4's `WebhookMapping`. Re-export from `@folio/shared` in Task 2.

- [ ] **Step 2: Generate the migration**

```bash
bun --filter @folio/server db:generate
```

Rename the generated `0006_<random>.sql` to `0006_phase_5_sync_targets.sql` and update `meta/_journal.json`.

- [ ] **Step 3: Inspect + verify the migration on empty DB**

```bash
cat apps/server/src/db/migrations/0006_phase_5_sync_targets.sql
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
```

Expected: `Migrations complete.` Sanity-check both tables:

```bash
bun -e '
import { Database } from "bun:sqlite";
const db = new Database("./folio.db");
for (const t of ["sync_targets", "sync_log"]) {
  const cols = db.query(`PRAGMA table_info(${t})`).all();
  console.log(t, ":", cols.map(c => c.name).join(", "));
}
'
```

Expected: both tables present with the columns from Step 1.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-5: add sync_targets + sync_log schema"
```

---

## Task 2: Shared types

**Files:**
- Create: `packages/shared/src/sync-target.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/db/schema.ts` — import `SyncMapping` from `@folio/shared`

Mirror what Phase 4 did with `WebhookMapping`.

- [ ] **Step 1: Create the shared types module**

`packages/shared/src/sync-target.ts`:

```ts
export interface SyncMapping {
  fields: Record<string, string>;
}

export type AdapterKind = 'statamic';
```

- [ ] **Step 2: Re-export from `packages/shared/src/index.ts`**

```ts
export type { SyncMapping, AdapterKind } from './sync-target.ts';
```

- [ ] **Step 3: Replace the inline `SyncMapping` in schema.ts with an import**

In `apps/server/src/db/schema.ts`, remove the local `interface SyncMapping` and replace with:

```ts
import type { SyncMapping } from '@folio/shared';
```

(Combine with the existing `WebhookMapping` import — same line.)

- [ ] **Step 4: Run server tests — no regression**

```bash
cd apps/server && bun test
```

Expected: 132 / 0 (Phase 4 baseline unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/server/src/db/schema.ts
git commit -m "phase-5: SyncMapping + AdapterKind in @folio/shared"
```

---

## Task 3: `CmsAdapter` interface

**Files:**
- Create: `apps/server/src/lib/adapters/interface.ts`

A contract that the Statamic adapter implements today and the WordPress adapter will implement in 5.1. Keeps the sync engine adapter-agnostic.

- [ ] **Step 1: Create the interface**

`apps/server/src/lib/adapters/interface.ts`:

```ts
export interface AdapterEntry {
  /** Statamic-style: slug. WordPress-style: slug. Used as the human-readable URL piece. */
  slug: string;
  /** Field map: `{ title: '...', content: '...', author: '...' }`. Shape is per-CMS. */
  fields: Record<string, unknown>;
  /** Whether the entry is publicly visible. */
  published: boolean;
}

export interface AdapterCreateResult {
  /** The remote entry id (Statamic id, WP post id). */
  remoteId: string;
}

export interface CmsAdapter {
  /** Create a new entry; return the remote id. */
  createEntry(entry: AdapterEntry): Promise<AdapterCreateResult>;
  /** Update an existing entry by its remote id. */
  updateEntry(remoteId: string, entry: AdapterEntry): Promise<void>;
  /** Delete an entry by its remote id. */
  deleteEntry(remoteId: string): Promise<void>;
}
```

No tests for this file — it's a pure interface. Concrete adapters get their own tests.

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/lib/adapters/interface.ts
git commit -m "phase-5: CmsAdapter interface (forward-compatible for WP in 5.1)"
```

---

## Task 4: `StatamicAdapter` implementation + tests

**Files:**
- Create: `apps/server/src/lib/adapters/statamic.ts`
- Create: `apps/server/src/lib/adapters/statamic.test.ts`

Concrete adapter for Statamic's REST API. Uses `fetch` with `Authorization: Bearer <token>` against the configured base URL.

- [ ] **Step 1: Write the failing tests first**

`apps/server/src/lib/adapters/statamic.test.ts`:

```ts
import { test, expect, mock } from 'bun:test';
import { StatamicAdapter } from './statamic.ts';

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return mock(async (_url: string, _init?: RequestInit) => {
    const r = responses[i++] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const target = {
  baseUrl: 'https://example.com',
  collectionHandle: 'blog',
  token: 'fake-token-123',
};

test('StatamicAdapter.createEntry POSTs to /api/collections/:handle/entries with bearer + body', async () => {
  const fetchMock = stubFetch([{ status: 201, body: { data: { id: 'entry-abc' } } }]);
  const a = new StatamicAdapter(target, fetchMock);

  const result = await a.createEntry({
    slug: 'hello-world',
    fields: { title: 'Hello', content: 'World' },
    published: true,
  });

  expect(result.remoteId).toBe('entry-abc');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://example.com/api/collections/blog/entries');
  expect(init!.method).toBe('POST');
  expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer fake-token-123');
  const sent = JSON.parse(init!.body as string);
  expect(sent.slug).toBe('hello-world');
  expect(sent.published).toBe(true);
  expect(sent.title).toBe('Hello');
  expect(sent.content).toBe('World');
});

test('StatamicAdapter.createEntry throws on non-2xx with helpful message', async () => {
  const fetchMock = stubFetch([{ status: 422, body: { message: 'Title is required' } }]);
  const a = new StatamicAdapter(target, fetchMock);
  await expect(
    a.createEntry({ slug: 'x', fields: {}, published: true }),
  ).rejects.toThrow(/422/);
});

test('StatamicAdapter.updateEntry PATCHes the entry endpoint', async () => {
  const fetchMock = stubFetch([{ status: 200, body: { data: {} } }]);
  const a = new StatamicAdapter(target, fetchMock);
  await a.updateEntry('entry-abc', {
    slug: 'hello-world',
    fields: { title: 'Hello (revised)' },
    published: true,
  });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://example.com/api/collections/blog/entries/entry-abc');
  expect(init!.method).toBe('PATCH');
  const sent = JSON.parse(init!.body as string);
  expect(sent.title).toBe('Hello (revised)');
});

test('StatamicAdapter.deleteEntry DELETEs the entry endpoint', async () => {
  const fetchMock = stubFetch([{ status: 204, body: {} }]);
  const a = new StatamicAdapter(target, fetchMock);
  await a.deleteEntry('entry-abc');
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://example.com/api/collections/blog/entries/entry-abc');
  expect(init!.method).toBe('DELETE');
});

test('StatamicAdapter trims trailing slash from baseUrl', async () => {
  const fetchMock = stubFetch([{ status: 201, body: { data: { id: 'x' } } }]);
  const a = new StatamicAdapter(
    { ...target, baseUrl: 'https://example.com/' },
    fetchMock,
  );
  await a.createEntry({ slug: 'x', fields: {}, published: true });
  const [url] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://example.com/api/collections/blog/entries');
});
```

- [ ] **Step 2: Run the tests, verify they fail**

```bash
cd apps/server && bun test src/lib/adapters/statamic.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the adapter**

`apps/server/src/lib/adapters/statamic.ts`:

```ts
import type { CmsAdapter, AdapterEntry, AdapterCreateResult } from './interface.ts';

export interface StatamicAdapterConfig {
  baseUrl: string;
  collectionHandle: string;
  token: string;
}

type Fetch = typeof fetch;

export class StatamicAdapter implements CmsAdapter {
  private readonly baseUrl: string;
  private readonly handle: string;
  private readonly token: string;
  private readonly fetchImpl: Fetch;

  constructor(config: StatamicAdapterConfig, fetchImpl: Fetch = fetch) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.handle = config.collectionHandle;
    this.token = config.token;
    this.fetchImpl = fetchImpl;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  private collectionUrl(remoteId?: string): string {
    const base = `${this.baseUrl}/api/collections/${this.handle}/entries`;
    return remoteId ? `${base}/${remoteId}` : base;
  }

  private async ensureOk(res: Response, op: string): Promise<void> {
    if (res.ok) return;
    let detail = '';
    try {
      const body = await res.text();
      detail = body.slice(0, 500);
    } catch {
      // ignore
    }
    throw new Error(`Statamic ${op} failed (${res.status}): ${detail}`);
  }

  async createEntry(entry: AdapterEntry): Promise<AdapterCreateResult> {
    const body = { slug: entry.slug, published: entry.published, ...entry.fields };
    const res = await this.fetchImpl(this.collectionUrl(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    await this.ensureOk(res, 'create');
    const json = (await res.json()) as { data: { id: string } };
    return { remoteId: json.data.id };
  }

  async updateEntry(remoteId: string, entry: AdapterEntry): Promise<void> {
    const body = { slug: entry.slug, published: entry.published, ...entry.fields };
    const res = await this.fetchImpl(this.collectionUrl(remoteId), {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    await this.ensureOk(res, 'update');
  }

  async deleteEntry(remoteId: string): Promise<void> {
    const res = await this.fetchImpl(this.collectionUrl(remoteId), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return;   // already gone — treat as success
    await this.ensureOk(res, 'delete');
  }
}
```

- [ ] **Step 4: Run the tests, verify pass**

```bash
cd apps/server && bun test src/lib/adapters/statamic.test.ts
```

Expected: 5 / 5.

- [ ] **Step 5: Run full server suite — no regression**

```bash
cd apps/server && bun test
```

Expected: 137 / 0 (132 + 5).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/adapters/statamic.ts apps/server/src/lib/adapters/statamic.test.ts
git commit -m "phase-5: StatamicAdapter (create/update/delete via REST API + bearer token)"
```

---

## Task 5: Pure mapping helper — doc → adapter entry

**Files:**
- Create: `apps/server/src/lib/sync-mapping.ts`
- Create: `apps/server/src/lib/sync-mapping.test.ts`

Pure: takes a `Document` row + a `SyncMapping` config + the publish-on-status setting and computes the `AdapterEntry` to send. Mirror of Phase 4's payload-mapping helper (different direction).

- [ ] **Step 1: Write the failing tests first**

`apps/server/src/lib/sync-mapping.test.ts`:

```ts
import { test, expect } from 'bun:test';
import type { SyncMapping } from '@folio/shared';
import { resolveSyncEntry } from './sync-mapping.ts';

const baseDoc = {
  slug: 'hello-world',
  title: 'Hello world',
  body: '# Hello\n\nBody.',
  status: 'published',
  frontmatter: { author: 'stefan', summary: 'A test post' },
};

test('resolveSyncEntry: $title, $body, $slug, $frontmatter.key', () => {
  const mapping: SyncMapping = {
    fields: {
      title: '$title',
      content: '$body',
      slug: '$slug',
      author: '$frontmatter.author',
      summary: '$frontmatter.summary',
    },
  };
  const result = resolveSyncEntry(baseDoc, mapping, 'published');
  expect(result.slug).toBe('hello-world');
  expect(result.published).toBe(true);
  expect(result.fields.title).toBe('Hello world');
  expect(result.fields.content).toBe('# Hello\n\nBody.');
  expect(result.fields.author).toBe('stefan');
  expect(result.fields.summary).toBe('A test post');
});

test('resolveSyncEntry: literal values pass through', () => {
  const mapping: SyncMapping = {
    fields: { title: '$title', author_role: 'editor', region: 'eu' },
  };
  const result = resolveSyncEntry(baseDoc, mapping, 'published');
  expect(result.fields.author_role).toBe('editor');
  expect(result.fields.region).toBe('eu');
});

test('resolveSyncEntry: published=false when status does not match publish-on-status', () => {
  const mapping: SyncMapping = { fields: { title: '$title' } };
  const result = resolveSyncEntry({ ...baseDoc, status: 'draft' }, mapping, 'published');
  expect(result.published).toBe(false);
});

test('resolveSyncEntry: missing frontmatter key resolves to empty string', () => {
  const mapping: SyncMapping = {
    fields: { title: '$title', missing: '$frontmatter.nope' },
  };
  const result = resolveSyncEntry(baseDoc, mapping, 'published');
  expect(result.fields.missing).toBe('');
});

test('resolveSyncEntry: non-string frontmatter values are coerced', () => {
  const mapping: SyncMapping = {
    fields: { count: '$frontmatter.count', flag: '$frontmatter.flag' },
  };
  const doc = { ...baseDoc, frontmatter: { count: 42, flag: true } };
  const result = resolveSyncEntry(doc, { fields: mapping.fields }, 'published');
  expect(result.fields.count).toBe('42');
  expect(result.fields.flag).toBe('true');
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd apps/server && bun test src/lib/sync-mapping.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement**

`apps/server/src/lib/sync-mapping.ts`:

```ts
import type { SyncMapping } from '@folio/shared';
import type { AdapterEntry } from './adapters/interface.ts';

export interface SyncSourceDoc {
  slug: string;
  title: string;
  body: string;
  status: string | null;
  frontmatter: Record<string, unknown>;
}

function resolveField(ref: string, doc: SyncSourceDoc): string {
  if (ref === '$title') return doc.title;
  if (ref === '$body') return doc.body;
  if (ref === '$slug') return doc.slug;
  if (ref.startsWith('$frontmatter.')) {
    const key = ref.slice('$frontmatter.'.length);
    const v = doc.frontmatter?.[key];
    if (v == null) return '';
    return String(v);
  }
  return ref;
}

export function resolveSyncEntry(
  doc: SyncSourceDoc,
  mapping: SyncMapping,
  publishOnStatus: string,
): AdapterEntry {
  const fields: Record<string, unknown> = {};
  for (const [k, ref] of Object.entries(mapping.fields)) {
    fields[k] = resolveField(ref, doc);
  }
  return {
    slug: doc.slug,
    fields,
    published: doc.status === publishOnStatus,
  };
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd apps/server && bun test src/lib/sync-mapping.test.ts
```

Expected: 5 / 5.

- [ ] **Step 5: Full suite — no regression**

```bash
cd apps/server && bun test
```

Expected: 142 / 0 (137 + 5).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/sync-mapping.ts apps/server/src/lib/sync-mapping.test.ts
git commit -m "phase-5: sync-mapping helper (doc → AdapterEntry)"
```

---

## Task 6: Sync engine — orchestrate adapter + log

**Files:**
- Create: `apps/server/src/lib/sync-engine.ts`
- Create: `apps/server/src/lib/sync-engine.test.ts`

The engine is invoked after a document write. It:
1. Finds any `sync_targets` whose `source_table_id` matches the doc's table
2. For each target: looks up the latest `sync_log` row for `(doc, target)` to see if there's a `remote_id`
3. Decides operation: `create` (no remote_id, doc is publishable), `update` (has remote_id, doc still publishable), `delete` (has remote_id, doc no longer publishable / deleted)
4. Decrypts the token, instantiates the right adapter, calls the right method
5. Writes a `sync_log` row with status

Crypto: reuse `apps/server/src/lib/crypto.ts` (Phase 2's BYOK encryption helpers). Tests stub the adapter to avoid network calls.

- [ ] **Step 1: Write failing tests first**

`apps/server/src/lib/sync-engine.test.ts`:

```ts
import { test, expect, mock } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { syncTargets, syncLog, documents } from '../db/schema.ts';
import { encrypt } from './crypto.ts';
import { syncDocument } from './sync-engine.ts';
import type { CmsAdapter } from './adapters/interface.ts';

function makeStubAdapter() {
  return {
    createEntry: mock(async () => ({ remoteId: 'remote-123' })),
    updateEntry: mock(async () => {}),
    deleteEntry: mock(async () => {}),
  } satisfies CmsAdapter;
}

async function makeTarget(db: any, workspaceId: string, sourceTableId: string) {
  const id = nanoid();
  const tokenEncrypted = encrypt('fake-token');
  await db.insert(syncTargets).values({
    id,
    workspaceId,
    sourceTableId,
    name: 'Statamic blog',
    adapter: 'statamic',
    baseUrl: 'https://example.com',
    collectionHandle: 'blog',
    tokenEncrypted,
    publishOnStatus: 'published',
    mapping: { fields: { title: '$title', content: '$body' } },
    active: true,
  });
  return id;
}

async function makeDoc(db: any, projectId: string, tableId: string, status: string | null) {
  const id = nanoid();
  await db.insert(documents).values({
    id,
    projectId,
    tableId,
    type: 'work_item',
    slug: 'hello-world',
    title: 'Hello world',
    status,
    body: '# Body',
    frontmatter: {},
  });
  return id;
}

test('syncDocument: creates remote entry when doc is publishable and no prior sync', async () => {
  const { db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const targetId = await makeTarget(db, seed.workspace.id, seed.workItemsTableId);
  const docId = await makeDoc(db, seed.project.id, seed.workItemsTableId, 'published');

  const adapter = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter });

  expect(adapter.createEntry).toHaveBeenCalledTimes(1);
  const [{ remoteId }] = adapter.createEntry.mock.results[0]!.value
    ? [adapter.createEntry.mock.results[0]!.value]
    : [{ remoteId: '' }];

  const logRows = await db.select().from(syncLog).where(eq(syncLog.documentId, docId));
  expect(logRows).toHaveLength(1);
  expect(logRows[0].operation).toBe('create');
  expect(logRows[0].status).toBe('ok');
  expect(logRows[0].remoteId).toBe('remote-123');
});

test('syncDocument: updates remote entry on subsequent edit', async () => {
  const { db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const targetId = await makeTarget(db, seed.workspace.id, seed.workItemsTableId);
  const docId = await makeDoc(db, seed.project.id, seed.workItemsTableId, 'published');

  // First sync: create.
  const adapter1 = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter1 });

  // Second sync: update.
  const adapter2 = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter2 });

  expect(adapter2.createEntry).toHaveBeenCalledTimes(0);
  expect(adapter2.updateEntry).toHaveBeenCalledTimes(1);
  const [remoteId] = adapter2.updateEntry.mock.calls[0]!;
  expect(remoteId).toBe('remote-123');
});

test('syncDocument: deletes remote entry when doc becomes unpublishable', async () => {
  const { db, seed } = await makeTestApp({ seedProjectDefaults: true });
  await makeTarget(db, seed.workspace.id, seed.workItemsTableId);
  const docId = await makeDoc(db, seed.project.id, seed.workItemsTableId, 'published');

  const adapter1 = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter1 });

  // Change status away from 'published'.
  await db.update(documents).set({ status: 'draft' }).where(eq(documents.id, docId));

  const adapter2 = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter2 });

  expect(adapter2.deleteEntry).toHaveBeenCalledTimes(1);
});

test('syncDocument: no-op when no sync_targets match the doc table', async () => {
  const { db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const docId = await makeDoc(db, seed.project.id, seed.workItemsTableId, 'published');

  const adapter = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter });

  expect(adapter.createEntry).toHaveBeenCalledTimes(0);
  const logRows = await db.select().from(syncLog).where(eq(syncLog.documentId, docId));
  expect(logRows).toHaveLength(0);
});

test('syncDocument: writes sync_log with error status when adapter throws', async () => {
  const { db, seed } = await makeTestApp({ seedProjectDefaults: true });
  await makeTarget(db, seed.workspace.id, seed.workItemsTableId);
  const docId = await makeDoc(db, seed.project.id, seed.workItemsTableId, 'published');

  const adapter = {
    createEntry: mock(async () => {
      throw new Error('Statamic create failed (422): blueprint mismatch');
    }),
    updateEntry: mock(async () => {}),
    deleteEntry: mock(async () => {}),
  } satisfies CmsAdapter;

  // Should NOT throw — the engine swallows + logs.
  await syncDocument(db, docId, { adapterFactory: () => adapter });

  const logRows = await db.select().from(syncLog).where(eq(syncLog.documentId, docId));
  expect(logRows).toHaveLength(1);
  expect(logRows[0].status).toBe('error');
  expect(logRows[0].error).toContain('blueprint mismatch');
});

test('syncDocument: respects target.active=false', async () => {
  const { db, seed } = await makeTestApp({ seedProjectDefaults: true });
  const targetId = await makeTarget(db, seed.workspace.id, seed.workItemsTableId);
  await db.update(syncTargets).set({ active: false }).where(eq(syncTargets.id, targetId));
  const docId = await makeDoc(db, seed.project.id, seed.workItemsTableId, 'published');

  const adapter = makeStubAdapter();
  await syncDocument(db, docId, { adapterFactory: () => adapter });

  expect(adapter.createEntry).toHaveBeenCalledTimes(0);
});
```

`seed.project.id` may not be on the existing harness — verify and extend if needed (Phase 4's Task 4 step 5 had the same kind of harness audit). If only `seed.project.slug` is exposed, add `seed.project = { id, slug, ... }` to the harness.

- [ ] **Step 2: Run, verify failing**

```bash
cd apps/server && bun test src/lib/sync-engine.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the engine**

`apps/server/src/lib/sync-engine.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db as defaultDb } from '../db/client.ts';
import type { DB } from '../db/client.ts';
import { documents, syncLog, syncTargets } from '../db/schema.ts';
import { decrypt } from './crypto.ts';
import { StatamicAdapter } from './adapters/statamic.ts';
import type { CmsAdapter } from './adapters/interface.ts';
import { resolveSyncEntry, type SyncSourceDoc } from './sync-mapping.ts';

export interface SyncOptions {
  /** Allow tests to inject a stub adapter without going through StatamicAdapter. */
  adapterFactory?: (target: typeof syncTargets.$inferSelect) => CmsAdapter;
}

function makeAdapter(target: typeof syncTargets.$inferSelect): CmsAdapter {
  const token = decrypt(target.tokenEncrypted);
  if (target.adapter === 'statamic') {
    return new StatamicAdapter({
      baseUrl: target.baseUrl,
      collectionHandle: target.collectionHandle,
      token,
    });
  }
  throw new Error(`Unsupported adapter: ${target.adapter}`);
}

export async function syncDocument(
  db: DB,
  documentId: string,
  options: SyncOptions = {},
): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc) return;
  // Pages are project-scoped and have no tableId; they don't participate in CMS sync v1.
  if (doc.tableId == null) return;

  const targets = await db.query.syncTargets.findMany({
    where: and(eq(syncTargets.sourceTableId, doc.tableId), eq(syncTargets.active, true)),
  });
  if (targets.length === 0) return;

  for (const target of targets) {
    await syncOne(db, doc, target, options);
  }
}

async function syncOne(
  db: DB,
  doc: typeof documents.$inferSelect,
  target: typeof syncTargets.$inferSelect,
  options: SyncOptions,
): Promise<void> {
  const adapter = options.adapterFactory ? options.adapterFactory(target) : makeAdapter(target);

  // Most recent prior log row tells us the remote_id (if any).
  const prior = await db.query.syncLog.findFirst({
    where: and(eq(syncLog.syncTargetId, target.id), eq(syncLog.documentId, doc.id)),
    orderBy: [desc(syncLog.createdAt)],
  });
  const remoteId = prior?.remoteId ?? null;

  const source: SyncSourceDoc = {
    slug: doc.slug,
    title: doc.title,
    body: doc.body,
    status: doc.status,
    frontmatter: (doc.frontmatter as Record<string, unknown>) ?? {},
  };
  const entry = resolveSyncEntry(source, target.mapping, target.publishOnStatus);

  let operation: 'create' | 'update' | 'delete';
  if (remoteId == null) {
    if (!entry.published) return;   // never published, still not — no-op
    operation = 'create';
  } else if (entry.published) {
    operation = 'update';
  } else {
    operation = 'delete';
  }

  const logId = nanoid();
  try {
    let nextRemoteId: string | null = remoteId;
    if (operation === 'create') {
      const result = await adapter.createEntry(entry);
      nextRemoteId = result.remoteId;
    } else if (operation === 'update') {
      await adapter.updateEntry(remoteId!, entry);
    } else {
      await adapter.deleteEntry(remoteId!);
      nextRemoteId = null;
    }
    await db.insert(syncLog).values({
      id: logId,
      syncTargetId: target.id,
      documentId: doc.id,
      remoteId: nextRemoteId,
      operation,
      status: 'ok',
      httpStatus: null,
      error: '',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(syncLog).values({
      id: logId,
      syncTargetId: target.id,
      documentId: doc.id,
      remoteId,
      operation,
      status: 'error',
      httpStatus: null,
      error: message,
    });
  }
}
```

- [ ] **Step 4: Run engine tests, verify pass**

```bash
cd apps/server && bun test src/lib/sync-engine.test.ts
```

Expected: 6 / 6.

- [ ] **Step 5: Full suite**

```bash
cd apps/server && bun test
```

Expected: 148 / 0 (142 + 6).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/sync-engine.ts apps/server/src/lib/sync-engine.test.ts apps/server/src/test/harness.ts
git commit -m "phase-5: sync-engine (orchestrates adapter, computes op, writes sync_log)"
```

---

## Task 7: Hook sync into document writes

**Files:**
- Modify: `apps/server/src/routes/documents.ts` — call `syncDocument` AFTER commit in POST + PATCH

The sync engine should run AFTER the document write transaction commits, not inside it — if Statamic is slow or fails, we don't want to roll back the local insert. v1 runs sync inline (the user's POST/PATCH waits); v5.1 will move it to a background queue.

- [ ] **Step 1: Audit the existing POST + PATCH structure**

```bash
grep -n "documentsRoute.post\|documentsRoute.patch\|emitEvent\|db.transaction" apps/server/src/routes/documents.ts | head -20
```

Identify where the `await db.transaction(...)` block ends in each handler. The sync call goes after that block, before `return jsonOk(...)`.

- [ ] **Step 2: Add the sync call to POST**

Find the POST handler in `documents.ts`. Just before `return jsonOk(c, row, 201);`:

```ts
// Phase 5: push to any configured CMS sync targets. Runs AFTER the transaction
// so a sync failure doesn't roll back the local write. Failures are recorded
// in sync_log and surfaced to the client via... [not implemented in v1; check sync_log UI later].
await syncDocument(db, id);
```

Add the import at the top: `import { syncDocument } from '../lib/sync-engine.ts';`

- [ ] **Step 3: Add the sync call to PATCH (both markdown and JSON branches)**

In the PATCH handler, the existing code has two transaction blocks (markdown branch and JSON branch). After each, before the `return jsonOk(...)`:

```ts
await syncDocument(db, existing.id);
```

- [ ] **Step 4: Add the sync call to DELETE**

In the DELETE handler, BEFORE the actual delete (we need to read the doc to give the engine a chance to issue a remote delete). Inside the transaction, capture the row; after the transaction, call sync:

Wait — actually a delete is destructive of the local doc, but sync needs the doc to exist to read its tableId. The cleanest approach is to read the targets BEFORE deletion, then issue remote deletes AFTER local deletion.

Refactor the delete handler:

```ts
documentsRoute.delete('/:slug', async (c) => {
  // ... existing lookup of `existing` ...

  // Snapshot targets BEFORE delete so we can clean up remote entries.
  const targetsToCleanup = existing.tableId
    ? await db.query.syncTargets.findMany({
        where: and(eq(syncTargets.sourceTableId, existing.tableId), eq(syncTargets.active, true)),
      })
    : [];

  await db.transaction(async (tx) => {
    await tx.delete(documents).where(eq(documents.id, existing.id));
    // ... emit event as before ...
  });

  // For each target, issue a delete on the remote entry if we have one logged.
  for (const target of targetsToCleanup) {
    const prior = await db.query.syncLog.findFirst({
      where: and(eq(syncLog.syncTargetId, target.id), eq(syncLog.documentId, existing.id)),
      orderBy: [desc(syncLog.createdAt)],
    });
    if (prior?.remoteId) {
      // Use a synthetic doc with status=null to force delete operation.
      // Actually: the sync engine looks up the doc by id and finds nothing because we just deleted it.
      // So we issue the delete directly via the adapter here.
      try {
        const adapter = makeAdapter(target);   // imported from sync-engine.ts
        await adapter.deleteEntry(prior.remoteId);
        await db.insert(syncLog).values({
          id: nanoid(),
          syncTargetId: target.id,
          documentId: existing.id,
          remoteId: null,
          operation: 'delete',
          status: 'ok',
          httpStatus: null,
          error: '',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.insert(syncLog).values({
          id: nanoid(),
          syncTargetId: target.id,
          documentId: existing.id,
          remoteId: prior.remoteId,
          operation: 'delete',
          status: 'error',
          httpStatus: null,
          error: message,
        });
      }
    }
  }

  return c.body(null, 204);
});
```

Note: this requires exporting `makeAdapter` from `sync-engine.ts`. Add at the top of sync-engine.ts:

```ts
export { makeAdapter };
```

(Change the existing `function makeAdapter` to `export function makeAdapter`.)

- [ ] **Step 5: Run all documents tests**

```bash
cd apps/server && bun test src/routes/documents.test.ts
```

Expected: all green. The pre-existing tests don't configure any sync targets, so `syncDocument` is a no-op and doesn't affect their outcomes.

- [ ] **Step 6: Full suite**

```bash
cd apps/server && bun test
```

Expected: 148 / 0 (no new tests, no regressions).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/documents.ts apps/server/src/lib/sync-engine.ts
git commit -m "phase-5: invoke syncDocument after POST/PATCH/DELETE on /documents"
```

---

## Task 8: Workspace-scoped CRUD for sync_targets

**Files:**
- Create: `apps/server/src/routes/sync-targets.ts`
- Create: `apps/server/src/routes/sync-targets.test.ts`
- Modify: `apps/server/src/app.ts` (mount)

Mirror of Phase 4 Task 5 — workspace owners/admins create/update/delete sync targets. Token is libsodium-encrypted on create; never returned in list/get responses.

- [ ] **Step 1: Write failing tests**

`apps/server/src/routes/sync-targets.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

test('GET /sync-targets lists targets for the workspace', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const created = await (await app.request('/api/v1/w/acme/sync-targets', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Statamic blog',
      sourceTableId: seed.workItemsTableId,
      adapter: 'statamic',
      baseUrl: 'https://example.com',
      collectionHandle: 'blog',
      token: 'fake-statamic-token',
      mapping: { fields: { title: '$title', content: '$body' } },
    }),
  })).json();
  expect(created.data.id).toBeTruthy();

  const res = await app.request('/api/v1/w/acme/sync-targets', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  // Token must be REDACTED in list responses.
  expect(body.data[0].token).toBeUndefined();
  expect(body.data[0].tokenEncrypted).toBeUndefined();
});

test('POST /sync-targets 422 on unsupported adapter', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request('/api/v1/w/acme/sync-targets', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad',
      sourceTableId: seed.workItemsTableId,
      adapter: 'wordpress',   // not supported in 3.0
      baseUrl: 'https://example.com',
      collectionHandle: 'blog',
      token: 'x',
      mapping: { fields: {} },
    }),
  });
  expect(res.status).toBe(422);
});

test('POST /sync-targets 404 when sourceTableId is in another workspace', async () => {
  // Same pattern as Phase 4 cross-tenant test — create a second workspace,
  // try to attach a sync target in workspace A to a table in workspace B.
  // ... (full setup as in webhooks.test.ts)
});

test('PATCH /sync-targets/:id toggles active', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const created = await (await app.request('/api/v1/w/acme/sync-targets', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Blog',
      sourceTableId: seed.workItemsTableId,
      adapter: 'statamic',
      baseUrl: 'https://example.com',
      collectionHandle: 'blog',
      token: 'x',
      mapping: { fields: { title: '$title' } },
    }),
  })).json();

  const res = await app.request(`/api/v1/w/acme/sync-targets/${created.data.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.active).toBe(false);
});

test('DELETE /sync-targets/:id returns 204', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const created = await (await app.request('/api/v1/w/acme/sync-targets', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Blog',
      sourceTableId: seed.workItemsTableId,
      adapter: 'statamic',
      baseUrl: 'https://example.com',
      collectionHandle: 'blog',
      token: 'x',
      mapping: { fields: { title: '$title' } },
    }),
  })).json();

  const res = await app.request(`/api/v1/w/acme/sync-targets/${created.data.id}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});
```

Fill in the cross-tenant test (3rd test) following the pattern in `webhooks.test.ts` from Phase 4 Task 5.

- [ ] **Step 2: Run, verify failing**

```bash
cd apps/server && bun test src/routes/sync-targets.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the route**

`apps/server/src/routes/sync-targets.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { syncTargets, tables, projects } from '../db/schema.ts';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { emitEvent } from '../lib/events.ts';
import { encrypt } from '../lib/crypto.ts';
import { type AuthContext, getUser } from '../middleware/auth.ts';
import { getWorkspace, type ScopeContext } from '../middleware/scope.ts';

const mappingSchema = z.object({ fields: z.record(z.string()) });

const createSchema = z.object({
  name: z.string().min(1).max(80),
  sourceTableId: z.string().min(1),
  adapter: z.enum(['statamic']),
  baseUrl: z.string().url(),
  collectionHandle: z.string().min(1).max(80),
  token: z.string().min(8),
  publishOnStatus: z.string().min(1).max(64).optional(),
  mapping: mappingSchema,
  active: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().optional(),
  collectionHandle: z.string().min(1).max(80).optional(),
  token: z.string().min(8).optional(),
  publishOnStatus: z.string().min(1).max(64).optional(),
  mapping: mappingSchema.optional(),
  active: z.boolean().optional(),
});

const syncTargetsRoute = new Hono<AuthContext & ScopeContext>();

function redact(t: typeof syncTargets.$inferSelect) {
  const { tokenEncrypted, ...rest } = t;
  return rest;
}

syncTargetsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);
  const rows = await db.query.syncTargets.findMany({
    where: eq(syncTargets.workspaceId, ws.id),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return jsonOk(c, rows.map(redact));
});

syncTargetsRoute.post('/', zValidator('json', createSchema), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const input = c.req.valid('json');

  // Verify sourceTableId is in this workspace.
  const tbl = await db.query.tables.findFirst({ where: eq(tables.id, input.sourceTableId) });
  if (!tbl) throw new HTTPError('TABLE_NOT_FOUND', 'table not found', 404);
  const proj = await db.query.projects.findFirst({ where: eq(projects.id, tbl.projectId) });
  if (!proj || proj.workspaceId !== ws.id) {
    throw new HTTPError('TABLE_NOT_FOUND', 'table not in this workspace', 404);
  }

  const id = nanoid();
  const row = {
    id,
    workspaceId: ws.id,
    sourceTableId: input.sourceTableId,
    name: input.name,
    adapter: input.adapter,
    baseUrl: input.baseUrl,
    collectionHandle: input.collectionHandle,
    tokenEncrypted: encrypt(input.token),
    publishOnStatus: input.publishOnStatus ?? 'published',
    mapping: input.mapping,
    active: input.active ?? true,
    createdBy: user.id,
  };
  await db.transaction(async (tx) => {
    await tx.insert(syncTargets).values(row);
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: tbl.projectId,
      kind: 'sync_target.created',
      actor: user.id,
      payload: { id, name: input.name, adapter: input.adapter },
    });
  });
  return jsonOk(c, redact(row as typeof syncTargets.$inferSelect), 201);
});

syncTargetsRoute.patch('/:id', zValidator('json', patchSchema), async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const existing = await db.query.syncTargets.findFirst({
    where: and(eq(syncTargets.id, id), eq(syncTargets.workspaceId, ws.id)),
  });
  if (!existing) throw new HTTPError('SYNC_TARGET_NOT_FOUND', `not found`, 404);
  const patch = c.req.valid('json');
  const update: Partial<typeof syncTargets.$inferInsert> = { ...patch };
  if (patch.token) {
    delete (update as Record<string, unknown>).token;
    update.tokenEncrypted = encrypt(patch.token);
  }
  await db.transaction(async (tx) => {
    await tx.update(syncTargets).set(update).where(eq(syncTargets.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: '',
      kind: 'sync_target.updated',
      actor: user.id,
      payload: { id, changes: Object.keys(patch) },
    });
  });
  return jsonOk(c, redact({ ...existing, ...update } as typeof syncTargets.$inferSelect));
});

syncTargetsRoute.delete('/:id', async (c) => {
  const user = getUser(c);
  const ws = getWorkspace(c);
  const id = c.req.param('id');
  const existing = await db.query.syncTargets.findFirst({
    where: and(eq(syncTargets.id, id), eq(syncTargets.workspaceId, ws.id)),
  });
  if (!existing) throw new HTTPError('SYNC_TARGET_NOT_FOUND', `not found`, 404);
  await db.transaction(async (tx) => {
    await tx.delete(syncTargets).where(eq(syncTargets.id, id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: '',
      kind: 'sync_target.deleted',
      actor: user.id,
      payload: { id, name: existing.name },
    });
  });
  return c.body(null, 204);
});

export { syncTargetsRoute };
```

- [ ] **Step 4: Mount in `app.ts`**

Find the `wScope` block. Add:

```ts
import { syncTargetsRoute } from './routes/sync-targets.ts';
// inside wScope:
wScope.route('/sync-targets', syncTargetsRoute);
```

Extend `events.ts` `EventKind` union with `sync_target.created`, `sync_target.updated`, `sync_target.deleted`, `sync.fired` (the last one is emitted by the engine — add it here too for forward compat).

- [ ] **Step 5: Run tests**

```bash
cd apps/server && bun test src/routes/sync-targets.test.ts
```

Expected: 5 / 5.

- [ ] **Step 6: Full suite**

```bash
cd apps/server && bun test
```

Expected: 153 / 0 (148 + 5).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/sync-targets.ts apps/server/src/routes/sync-targets.test.ts apps/server/src/app.ts apps/server/src/lib/events.ts
git commit -m "phase-5: workspace-scoped CRUD for /sync-targets (token encrypted at rest)"
```

---

## Task 9: End-to-end manual verification

**Files:** none (manual test against a real Statamic site if available, or a mocked endpoint)

This task is the smoke test before declaring 3.0 shipped. The agent doing this task should:

1. Either run a local Statamic site (the user has the stack) OR mock the Statamic endpoint with a tiny Bun server that records calls.
2. Wipe + remigrate + seed the Folio dev DB.
3. Create a sync target via API.
4. Create a document with `status: 'published'` — verify Statamic receives a POST.
5. Edit the doc title — verify Statamic receives a PATCH on the same remote_id.
6. Change status to `draft` — verify Statamic receives a DELETE.
7. Inspect `sync_log` to confirm rows for each operation.

- [ ] **Step 1: Decide on local Statamic vs. mock**

Ask the user: do they have a Statamic site to point at, or should we mock?

If user has a Statamic site:
```bash
# user runs:
ddev start    # in the Statamic project
# then provides: STATAMIC_BASE_URL, STATAMIC_TOKEN, COLLECTION_HANDLE
```

If mocking:
```bash
# Create a tiny mock server alongside Folio:
cat > /tmp/mock-statamic.ts << 'EOF'
const calls: any[] = [];
Bun.serve({
  port: 4444,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method !== 'GET' ? await req.text().catch(() => '') : '';
    calls.push({ method: req.method, path: url.pathname, body });
    console.log(`[mock-statamic] ${req.method} ${url.pathname}`);
    if (req.method === 'POST') {
      return Response.json({ data: { id: `mock-${calls.length}` } }, { status: 201 });
    }
    return Response.json({ data: {} }, { status: 200 });
  },
});
console.log('Mock Statamic listening on http://localhost:4444');
EOF
bun /tmp/mock-statamic.ts &
```

- [ ] **Step 2: Wipe + reseed Folio**

```bash
cd /home/ntdst/Projects/folio
rm -f apps/server/folio.db apps/server/folio.db-shm apps/server/folio.db-wal
cd apps/server && bun run src/db/migrate.ts
cd /home/ntdst/Projects/folio
cd apps/server && bun --hot src/index.ts &
SERVER_PID=$!
sleep 2
cd /home/ntdst/Projects/folio
bun run scripts/seed-demo.ts
```

- [ ] **Step 3: Log in and create a sync target**

```bash
# Log in:
curl -sc /tmp/folio-cookies.txt -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"stefan@netdust.be","password":"demo-password-1"}'

# Get the Folio work-items table id:
TABLE_ID=$(curl -sb /tmp/folio-cookies.txt http://localhost:3001/api/v1/w/netdust/p/folio/tables \
  | bun -e 'const d=JSON.parse(await Bun.stdin.text()); console.log(d.data.find(t=>t.slug==="work-items").id)')

# Create the sync target (pointed at mock or real Statamic):
curl -sb /tmp/folio-cookies.txt -X POST http://localhost:3001/api/v1/w/netdust/sync-targets \
  -H 'Content-Type: application/json' \
  -d "{
    \"name\": \"Smoke test Statamic\",
    \"sourceTableId\": \"$TABLE_ID\",
    \"adapter\": \"statamic\",
    \"baseUrl\": \"http://localhost:4444\",
    \"collectionHandle\": \"blog\",
    \"token\": \"fake-token\",
    \"mapping\": { \"fields\": { \"title\": \"\$title\", \"content\": \"\$body\" } }
  }"
```

- [ ] **Step 4: Create a published document → expect mock POST**

```bash
curl -sb /tmp/folio-cookies.txt -X POST http://localhost:3001/api/v1/w/netdust/p/folio/documents \
  -H 'Content-Type: application/json' \
  -d '{ "type": "work_item", "title": "Phase 5 smoke test", "body": "Body here.", "frontmatter": { "status": "published" } }'
```

Check the mock server's terminal output: should show `POST /api/collections/blog/entries`.

- [ ] **Step 5: Edit the doc → expect mock PATCH**

```bash
curl -sb /tmp/folio-cookies.txt -X PATCH http://localhost:3001/api/v1/w/netdust/p/folio/documents/phase-3-smoke-test \
  -H 'Content-Type: application/json' \
  -d '{ "title": "Phase 5 smoke test (revised)" }'
```

Mock should show `PATCH /api/collections/blog/entries/mock-1` (or whatever id the mock returned).

- [ ] **Step 6: Unpublish → expect mock DELETE**

```bash
# Change status away from 'published':
curl -sb /tmp/folio-cookies.txt -X PATCH http://localhost:3001/api/v1/w/netdust/p/folio/documents/phase-3-smoke-test \
  -H 'Content-Type: application/json' \
  -d '{ "frontmatter": { "status": "draft" } }'
```

Mock should show `DELETE /api/collections/blog/entries/mock-1`.

- [ ] **Step 7: Inspect sync_log**

```bash
cd apps/server && bun -e '
import { Database } from "bun:sqlite";
const db = new Database("./folio.db");
const rows = db.query("SELECT operation, status, remote_id, error FROM sync_log ORDER BY created_at").all();
console.log(rows);
'
```

Expected: 3 rows — create/update/delete, all `ok`, remote_id set then nullified.

- [ ] **Step 8: Kill the background server + mock**

```bash
kill $SERVER_PID 2>/dev/null || true
pkill -f mock-statamic.ts 2>/dev/null || true
```

- [ ] **Step 9: No commit needed for this task** — it's verification only.

If anything fails, STOP and report BLOCKED with the specific HTTP response.

---

## Task 10: Memory + close-out

**Files:**
- Modify: `memory/STATE.md`
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Update STATE.md**

Mark Phase 5 as shipped. Add to "What's working in the UI": "Configurable Statamic sync target per workspace — documents in a source table publish to a Statamic collection on status change." Bump test counts (~153 server).

- [ ] **Step 2: Update DECISIONS.md**

Add a Phase 5 section:

```markdown
## Phase 5 — Statamic CMS bridge (2026-XX-XX)

- One sync target = (workspace, source_table) → Statamic collection. Token libsodium-encrypted at rest (reuse the BYOK crypto helpers).
- Adapter is pluggable via `CmsAdapter` interface; only `statamic` ships in 3.0. WordPress is 5.1.
- Publishability is determined by `doc.status === target.publish_on_status` (default `'published'`). Other statuses delete the remote entry if one exists.
- Mapping uses `$title`, `$body`, `$slug`, `$frontmatter.key` references; literals pass through. Same dialect as Phase 4's webhook mapping.
- Sync runs SYNCHRONOUSLY inside the API request (after the document write transaction commits). Failures don't roll back the local write; they're recorded in `sync_log` with status='error'. v5.1 moves to a background queue.
- DELETE on a document with a `remote_id` in sync_log issues a remote DELETE before returning 204. v1 swallows remote-delete errors and logs them.
- Out of scope for 3.0: bidirectional sync, asset/image upload, conflict resolution, scheduled publish (Statamic handles this), multiple targets per source table.
- `sync_log` is append-only. Phase 5.2 should add a UI to view it + retry failed syncs.
```

- [ ] **Step 3: Commit**

```bash
git add memory/STATE.md memory/DECISIONS.md
git commit -m "memory(folio): close out Phase 5 Statamic CMS bridge"
```

---

## Self-Review

**Spec coverage:**
- ✅ `sync_targets` + `sync_log` schema — Task 1
- ✅ Shared types — Task 2
- ✅ Pluggable adapter interface — Task 3
- ✅ Statamic adapter — Task 4
- ✅ Pure mapping helper — Task 5
- ✅ Sync engine (create/update/delete decision) — Task 6
- ✅ Hooked into document writes — Task 7
- ✅ Workspace-scoped CRUD — Task 8
- ✅ End-to-end manual smoke — Task 9
- ✅ Memory close-out — Task 10

**Out of scope and deferred:**
- WordPress adapter (5.1)
- Sync UI in the web app (5.0.1)
- Background queue / retry (5.1)
- Bidirectional sync (5.2+)
- Asset upload (5.2+)
- Multiple sync targets per source table (5.1)

**Risk areas:**
- Inline sync means slow Statamic = slow Folio writes. For v1 acceptable; a real client's first deploy will tell us if it's a problem.
- `decrypt(token)` happens on every sync — if FOLIO_MASTER_KEY rotates, existing targets break. Document this in DECISIONS.md.
- Sync runs OUTSIDE the doc write transaction. If the server crashes between the doc commit and the sync call, the doc exists locally but isn't on Statamic. Phase 5.1's queue fixes this with at-least-once delivery.
- The CMS adapter interface is currently shaped around Statamic's REST API. WordPress has a richer JSON shape (post_meta, terms, featured_media). The interface may need extension when 5.1 lands — be willing to revise.

**Type consistency check:**
- `SyncMapping` is defined in `@folio/shared/sync-target.ts` — used in schema.ts, sync-mapping.ts, sync-targets.ts.
- `CmsAdapter` from `adapters/interface.ts` — implemented by `StatamicAdapter`, consumed by `sync-engine.ts`.
- `AdapterEntry` shape — passed from `resolveSyncEntry` to the adapter. The `fields` is `Record<string, unknown>` (Statamic accepts mixed-type values).
- `SyncSourceDoc` shape — built from a `Document` row by `syncOne`; consumed by `resolveSyncEntry`.

No placeholder steps. All tasks include test code AND implementation code. Each task ends with an explicit commit.
