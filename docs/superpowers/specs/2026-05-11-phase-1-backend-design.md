# Phase 1 Backend — Design Spec

**Status:** approved 2026-05-11
**Scope:** Phase 1 backend (Core CRUD) + bundled Phase 0 carry-over (workspaces re-scoped by slug, projects split into its own router).
**Out of scope:** Frontend (list view, kanban, slideover, editor) — separate spec.

---

## 1. Goal

Deliver the REST surface that the Phase 1 frontend will consume and that agents will hit via REST in v1 (and via the MCP server in Phase 2). After this lands, you can `curl` your way to:

1. Create a workspace and a project.
2. CRUD work-item and page documents with both JSON and `text/markdown` bodies.
3. Configure per-project statuses, frontmatter field type pins, and saved views.
4. Read any document as raw markdown with round-trippable frontmatter.
5. See an audit row in the `events` table for every write.

---

## 2. Architectural choices (locked in during brainstorming)

| Decision | Choice |
|---|---|
| Phase 0 carry-over (workspaces by slug, projects split) | Bundled into Phase 1 |
| Schema vs FOLIO-BRIEFING.md §6 drift | Follow existing schema; reconcile briefing later in docs-only commit |
| Events emission scope | Insert into `events` table on every write; SSE channel deferred to Phase 2 |
| Test approach | TDD per route file, `:memory:` SQLite, `bun test` |
| Markdown ingest on POST/PATCH | Branch on `Content-Type` header, single endpoint |
| Shared logic (`field-infer`, `filter-compile`, `slug`) location | `packages/shared` |
| Route file organization | Resource-per-file + `middleware/scope.ts` |

---

## 3. File structure

### `apps/server/src/`

```
routes/
  workspaces.ts        REWRITE — slug-scoped CRUD
  projects.ts          NEW     — nested under /w/:wslug/projects
  documents.ts         REPLACE stub
  statuses.ts          NEW
  fields.ts            NEW
  views.ts             REPLACE stub

middleware/
  scope.ts             NEW     — resolveWorkspace, resolveProject

lib/
  events.ts            NEW     — emitEvent helper
  slug-unique.ts       NEW     — server-side dedup wrapper
  http.ts              NEW     — jsonOk, jsonError envelope helpers
  filter-to-drizzle.ts NEW     — adapter from shared AST to Drizzle where()

routes/stubs.ts        DELETE
app.ts                 MODIFY  — mount /api/v1 with new routers
```

Remove `apps/server/src/lib/slugify.ts` — its content moves to `packages/shared/src/slug.ts`.

### `packages/shared/src/`

```
index.ts               EXTEND  — re-export new modules
field-infer.ts         NEW     — briefing §7 inference rules
filter-compile.ts      NEW     — ViewConfig → AST
slug.ts                NEW     — pure slugify (moved from server)
document-schema.ts     NEW     — Zod schema shared by POST/PATCH
error-codes.ts         NEW     — string constants for the error envelope
```

The existing `inferFieldType()` stub in `packages/shared/src/index.ts` is replaced by the full implementation in `field-infer.ts`.

### Tests

`*.test.ts` siblings to source files. End-to-end happy-path at `apps/server/src/__e2e__/phase-1-roundtrip.test.ts`. Test harness at `apps/server/src/test/harness.ts`.

---

## 4. URL surface

All routes under `/api/v1/`. `app.ts` currently mounts at `/api/` — that gets changed to `/api/v1/` as part of this phase. Sub-routers are mounted such that scope middleware runs once at the appropriate level.

```
Auth (unchanged):
  POST   /api/v1/auth/register
  POST   /api/v1/auth/login
  POST   /api/v1/auth/logout
  POST   /api/v1/auth/magic-link/request
  POST   /api/v1/auth/magic-link/consume
  GET    /api/v1/auth/me

Workspaces:
  GET    /api/v1/workspaces
  POST   /api/v1/workspaces
  GET    /api/v1/workspaces/:wslug
  PATCH  /api/v1/workspaces/:wslug
  DELETE /api/v1/workspaces/:wslug

Projects:
  GET    /api/v1/w/:wslug/projects
  POST   /api/v1/w/:wslug/projects
  GET    /api/v1/w/:wslug/projects/:pslug
  PATCH  /api/v1/w/:wslug/projects/:pslug
  DELETE /api/v1/w/:wslug/projects/:pslug

Documents:
  GET    /api/v1/w/:wslug/p/:pslug/documents
  POST   /api/v1/w/:wslug/p/:pslug/documents
  GET    /api/v1/w/:wslug/p/:pslug/documents/:slug
  GET    /api/v1/w/:wslug/p/:pslug/documents/:slug.md
  PATCH  /api/v1/w/:wslug/p/:pslug/documents/:slug
  DELETE /api/v1/w/:wslug/p/:pslug/documents/:slug

Statuses:
  GET    /api/v1/w/:wslug/p/:pslug/statuses
  POST   /api/v1/w/:wslug/p/:pslug/statuses
  PATCH  /api/v1/w/:wslug/p/:pslug/statuses/:id
  DELETE /api/v1/w/:wslug/p/:pslug/statuses/:id

Fields:
  GET    /api/v1/w/:wslug/p/:pslug/fields
  POST   /api/v1/w/:wslug/p/:pslug/fields
  PATCH  /api/v1/w/:wslug/p/:pslug/fields/:id
  DELETE /api/v1/w/:wslug/p/:pslug/fields/:id

Views:
  GET    /api/v1/w/:wslug/p/:pslug/views
  POST   /api/v1/w/:wslug/p/:pslug/views
  PATCH  /api/v1/w/:wslug/p/:pslug/views/:id
  DELETE /api/v1/w/:wslug/p/:pslug/views/:id

Settings (existing, envelope-migrated):
  GET    /api/v1/w/:wslug/settings/ai-keys
  POST   /api/v1/w/:wslug/settings/ai-keys
  DELETE /api/v1/w/:wslug/settings/ai-keys/:id

Tokens (existing, envelope-migrated):
  GET    /api/v1/w/:wslug/tokens
  POST   /api/v1/w/:wslug/tokens
  DELETE /api/v1/w/:wslug/tokens/:id
```

### Mounting in `app.ts`

```ts
const v1 = new Hono<AuthContext & ScopeContext>();
v1.route('/auth', auth);
v1.route('/workspaces', workspacesRoute);

const wScope = new Hono<AuthContext & ScopeContext>();
wScope.use('*', requireUser, resolveWorkspace);
wScope.route('/projects', projectsRoute);
wScope.route('/settings', settingsRoute);
wScope.route('/tokens', tokensRoute);

const pScope = new Hono<AuthContext & ScopeContext>();
pScope.use('*', resolveProject);
pScope.route('/documents', documentsRoute);
pScope.route('/statuses', statusesRoute);
pScope.route('/fields', fieldsRoute);
pScope.route('/views', viewsRoute);

wScope.route('/p/:pslug', pScope);
v1.route('/w/:wslug', wScope);
app.route('/api/v1', v1);
```

---

## 5. Response envelope

Standardize on briefing §8 across every route.

**Success:**
```json
{ "data": <payload> }
```

**Error:**
```json
{ "error": { "code": "DOCUMENT_NOT_FOUND", "message": "..." } }
```

Helpers in `lib/http.ts`:

```ts
export function jsonOk<T>(c: Context, data: T, status = 200): Response;
export function jsonError(
  c: Context,
  code: string,
  message: string,
  status: ContentfulStatusCode,
): Response;
```

Codes (Phase 1):

```
UNAUTHENTICATED         401   session missing or invalid
FORBIDDEN               403   member-only or role-gated action denied
WORKSPACE_NOT_FOUND     404
PROJECT_NOT_FOUND       404
DOCUMENT_NOT_FOUND      404
STATUS_NOT_FOUND        404
FIELD_NOT_FOUND         404
VIEW_NOT_FOUND          404
SLUG_CONFLICT           409
STATUS_IN_USE           409   DELETE status with documents still using it
INVALID_BODY            422
INVALID_FILTER          422
INVALID_STATUS          422   document.status not in project's statuses registry
```

Pagination response for list endpoints adds `nextCursor`:

```json
{ "data": [...], "nextCursor": "opaque" | null }
```

Existing routes (`auth.ts`, `settings.ts`, `workspaces.ts`, `tokens.ts`) migrate from ad-hoc shapes to this envelope. None of these are consumed by frontend code yet — low-risk.

---

## 6. Scope middleware

### `middleware/scope.ts`

```ts
export interface ScopeContext {
  Variables: {
    workspace?: Workspace;
    project?: Project;
    role?: 'owner' | 'admin' | 'member';
  };
}

export const resolveWorkspace: MiddlewareHandler<AuthContext & ScopeContext>;
export const resolveProject:   MiddlewareHandler<AuthContext & ScopeContext>;

export function getWorkspace(c: Context): Workspace;  // throws if missing
export function getProject(c: Context): Project;
export function getRole(c: Context): 'owner' | 'admin' | 'member';
```

- `resolveWorkspace` reads `:wslug`, loads workspace + the caller's membership, returns 404 if workspace unknown, 403 if not a member. On success: attaches `workspace` and `role`.
- `resolveProject` requires `resolveWorkspace` already ran; reads `:pslug`, loads the project scoped to the workspace, returns 404 if not found. On success: attaches `project`.

Both middlewares assume `requireUser` has already run. The mounting pattern in §4 enforces this ordering.

---

## 7. Documents API

### 7.1 GET `/documents`

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `type` | `work_item \| page` | unfiltered | |
| `cursor` | base64 string | none | last `(updated_at, id)` from previous page |
| `limit` | int 1..200 | 50 | |
| `filter` | URL-encoded JSON | none | filter AST, see §9 |
| `sort` | URL-encoded JSON | `[{key:'updated_at', dir:'desc'}]` | array of `{key, dir}` |

Returns `DocumentSummary[]` (subset of the row — id, projectId, type, slug, title, status, frontmatter, updatedAt) plus `nextCursor`.

Cursor encodes `${updatedAtMs}:${id}`; resume condition is `(updated_at, id) < cursor` to dedupe equal timestamps.

### 7.2 POST `/documents`

Branches on `Content-Type`:

**`application/json` branch.** Zod schema (`documentInputSchema.create`):

```ts
{
  type: 'work_item' | 'page',
  title: string (min 1),
  body?: string (default ''),
  frontmatter?: Record<string, unknown> (default {}),
  parentId?: string,
}
```

**`text/markdown` / `text/plain` branch.** Reads body as raw string, runs `parseMarkdown(raw)` → `{ frontmatter, body }`. Title resolution order:

1. First `# H1` heading in the body (regex `^#\s+(.+)$`m, anywhere in the body string).
2. `frontmatter.title` if present.
3. Fallback `'Untitled'`.

Type resolution: `frontmatter.type` if `'work_item' | 'page'`, else default `'work_item'`. Status (for `work_item`): `frontmatter.status` if present.

Both branches converge to the same shape, then:

1. Generate slug: `await slugUniqueInProject(documents, projectId, baseSlugFromTitle)`.
2. If `type === 'work_item'` and `status` is set: lookup `statuses.key` in this project. 422 `INVALID_STATUS` if missing.
3. Validate pinned frontmatter fields against `fields` registry (see §10).
4. In one transaction: insert document, insert `events` row with kind `document.created`.

Response: full document row, 201.

### 7.3 GET `/documents/:slug`

Returns the full document. 404 if not in this project.

### 7.4 GET `/documents/:slug.md`

Route pattern uses `:slug{[^.]+}.md` so it never matches `:slug`. Serializes:

```ts
serializeMarkdown({
  frontmatter: {
    type: row.type,
    title: row.title,                          // duplicates row.title for round-trip safety
    ...(row.status ? { status: row.status } : {}),
    ...row.frontmatter,                        // user-defined keys, spread last so user values win
  },
  body: row.body,
});
```

Headers:
```
Content-Type: text/markdown; charset=utf-8
Content-Disposition: inline; filename="<slug>.md"
```

### 7.5 PATCH `/documents/:slug`

Same Content-Type branching as POST.

**JSON branch.** Zod schema (`documentInputSchema.patch` — all fields optional):

```ts
{
  title?: string,
  status?: string | null,            // null clears
  body?: string,
  frontmatter?: Record<string, unknown>,
  parentId?: string | null,
}
```

`frontmatter` is **deep-merged shallowly** — incoming keys overwrite; missing keys preserved; keys with `null` value are **deleted** from the stored frontmatter.

**Markdown branch.** Parses full body; treats it as a **complete replacement**:

```ts
{ title, body, frontmatter, status, type? }   // all derived from parsed MD
```

`type` change is **rejected** (422 `INVALID_BODY`) — documents don't change type.

Validation:
- If `status` is changing on a `work_item`: validate against `statuses` registry.
- Pinned frontmatter keys validated (see §10).

In one transaction: update document (with `updatedAt = now`, `updatedBy = user.id`), emit `document.updated` event with payload `{ changes: <changed top-level keys> }`.

### 7.6 DELETE `/documents/:slug`

Hard delete. Emits `document.deleted` with payload `{ id, slug, type, title }`. Returns 204.

### 7.7 Deferred to Phase 2

- `body_append`, `body_prepend`, `frontmatter_merge` JSON-Patch-like operators (briefing §9) — MCP tool conveniences.
- Soft delete / archive — not in briefing §6, not added in v1.
- Document-level realtime collaboration — out of scope per CLAUDE.md.

---

## 8. Statuses / Fields / Views

All three follow the same shape: `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`. Keyed by `id` (not slug) — these are settings, not content.

### 8.1 Statuses

`POST` body: `{ key, name, color?, category?, order? }` where `category` ∈ `backlog | unstarted | started | completed | cancelled` (matches schema enum). `key` is what gets written into `documents.status` rows.

`PATCH /:id` allows renaming `key`. On commit:

```sql
UPDATE documents SET status = :newKey
WHERE project_id = :projectId AND status = :oldKey;
```

Inside the same transaction as the status update. Single `status.updated` event emitted; per-document update events are skipped for this bulk rename. Agents seeing a rename can refetch the affected list.

`DELETE /:id` runs `SELECT COUNT(*) FROM documents WHERE project_id = ? AND status = ?`. If non-zero → 409 `STATUS_IN_USE`. Force-delete (with cascade-clear) deferred.

**Default seeding on project create.** `routes/projects.ts` POST inserts these statuses (within the same transaction):

| key | name | category | color | order |
|---|---|---|---|---|
| `backlog` | Backlog | backlog | `#94a3b8` | 0 |
| `todo` | Todo | unstarted | `#3b82f6` | 10 |
| `in_progress` | In Progress | started | `#f59e0b` | 20 |
| `done` | Done | completed | `#10b981` | 30 |

### 8.2 Fields

`POST` body: `{ key, type, label?, options?, order? }`. `type` is the schema enum (`text | number | date | select | multi_select | user_ref | boolean | url`). `options: string[]` is required when `type ∈ {select, multi_select}` and rejected otherwise (422 `INVALID_BODY`).

Uniqueness enforced by `fields_project_key_idx`.

`PATCH /:id` allows changing `type`. Existing `documents.frontmatter` values are **not migrated** — inference and pin coexist on read; the UI surfaces the mismatch and lets the user heal manually. Rationale: forced migrations on a type change risk destroying valid agent-written data.

`DELETE /:id` drops the pin. `documents.frontmatter` values stay; UI falls back to inference.

### 8.3 Views

Schema migration bundled in this phase (see §11):

- `views.order INTEGER NOT NULL DEFAULT 0`
- `views.is_default INTEGER NOT NULL DEFAULT 0`

`POST` body: `{ name, type, filters?, sort?, groupBy?, visibleFields?, order?, isDefault? }`. `type` ∈ `list | kanban`. `filters` validated by attempting to compile via `filterCompile()` — 422 `INVALID_FILTER` on parse failure.

**Default seeding on project create:**

```ts
[
  {
    name: 'All work items',
    type: 'list',
    filters: { type: { $eq: 'work_item' } },
    sort: [{ key: 'updated_at', dir: 'desc' }],
    visibleFields: ['status', 'priority'],
    isDefault: true,
    order: 0,
  },
  {
    name: 'Board',
    type: 'kanban',
    filters: { type: { $eq: 'work_item' } },
    groupBy: 'status',
    visibleFields: ['priority', 'assignee'],
    order: 10,
  },
]
```

`PATCH /:id` — partial; `filters` re-validated if present. `DELETE /:id` — straight delete.

### 8.4 Events

All three resources emit `<resource>.created | .updated | .deleted` events on every write. Same `emitEvent()` helper. Payload includes the resource `id` plus `{ changes: <keys> }` for `updated`.

---

## 9. Shared helpers (`packages/shared/`)

### 9.1 `field-infer.ts`

Order-sensitive rules from FOLIO-BRIEFING.md §7. First match wins:

1. `boolean` — `value === true || value === false`
2. `datetime` — string matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$`
3. `date` — string matches `^\d{4}-\d{2}-\d{2}$`
4. `number` — `typeof value === 'number' && Number.isFinite(value)`
5. `multi_select` — `Array.isArray(value) && value.every(v => typeof v === 'string')`
6. `user_ref` — string matches email regex AND context.knownEmails (optional) contains it; otherwise skipped
7. `url` — string starts with `http://`, `https://`, or `mailto:`
8. `document_ref` — string matches `^\[\[[\w-]+\]\]$`
9. `text` — string with newlines
10. `string` — fallback

Signature:

```ts
export function inferFieldType(
  value: unknown,
  context?: { knownEmails?: Set<string>; knownSlugs?: Set<string> },
): FieldType;
```

`FieldType` enum stays in `packages/shared/src/index.ts` — already there; extend with `datetime`, `document_ref`, `string`.

### 9.2 `filter-compile.ts`

Operators (v1):

| Op | Meaning | Notes |
|---|---|---|
| (scalar) | `$eq` | `{ status: 'todo' }` shorthand |
| `$eq` | equality | |
| `$ne` | not equal | |
| `$in` | value in array | `{ status: { $in: ['todo','done'] } }` |
| `$nin` | value not in array | |
| `$gt`, `$gte`, `$lt`, `$lte` | comparisons | numbers and ISO date strings |
| `$exists` | key presence | `{ priority: { $exists: true } }` |

Compiles a `FilterInput` (briefing-style nested object) into a normalized `FilterAST`:

```ts
type FilterAST =
  | { kind: 'and'; clauses: FilterAST[] }
  | { kind: 'cmp'; key: string; op: Operator; value: JsonValue };
```

Top-level keys are AND-combined. No OR support in v1. Validation errors throw `FilterCompileError` with a message; route handler catches and returns 422 `INVALID_FILTER`.

### 9.3 `slug.ts`

Move existing 9-line `slugify()` here unchanged. `apps/server/src/lib/slugify.ts` is deleted.

### 9.4 `document-schema.ts`

Zod schemas shared between server route and (future) client write paths:

```ts
export const documentCreateSchema = z.object({...});
export const documentPatchSchema  = z.object({...});  // all fields .optional()
```

### 9.5 `error-codes.ts`

```ts
export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  // ... full list from §5
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];
```

---

## 10. Server lib (`apps/server/src/lib/`)

### 10.1 `events.ts`

```ts
export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated';
//                       ^^^ no workspace.deleted: events.workspace_id is NOT NULL
//                           and ON DELETE CASCADE would clear the event row itself.
//                           Workspace deletion is intentionally unobservable through
//                           the events log; agents detect it via 404 on subsequent reads.

export async function emitEvent(
  tx: DB | Transaction,
  args: {
    workspaceId: string;
    projectId?: string;
    documentId?: string;
    kind: EventKind;
    actor: string;                 // user_id (or 'system' for seeding)
    payload?: unknown;
  },
): Promise<void>;
```

Called inside transactions:

```ts
await db.transaction(async (tx) => {
  await tx.insert(documents).values({...});
  await emitEvent(tx, { kind: 'document.created', workspaceId, projectId, documentId: id, actor: user.id, payload: { slug, type } });
});
```

### 10.2 `slug-unique.ts`

Server-side dedup wrapper. Pure `slugify()` from shared, plus a DB query:

```ts
export async function slugUniqueInProject(
  tx: DB | Transaction,
  table: 'documents',
  projectId: string,
  base: string,
): Promise<string>;

export async function slugUniqueInWorkspace(
  tx: DB | Transaction,
  workspaceId: string,
  base: string,
): Promise<string>;
```

Strategy: query for slugs matching `base` or `base-<n>` in scope; return first free in the sequence `base, base-2, base-3, ...`. Single round-trip.

### 10.3 `filter-to-drizzle.ts`

Adapter — takes a `FilterAST` from `filter-compile.ts` and emits a Drizzle `SQL` (where clause):

```ts
export function compileFilterToWhere(
  ast: FilterAST,
  table: typeof documents,
): SQL;
```

Comparison rules:
- `status`, `type`, `title`, `slug`, `parent_id` map to direct table columns.
- Any other key compiles to a JSON-path comparison on `frontmatter`:
  `json_extract(documents.frontmatter, '$.<key>') = ?`
- `$exists`: `json_extract(documents.frontmatter, '$.<key>') IS NOT NULL` (true) / `IS NULL` (false).
- `$in` / `$nin` → SQL `IN` / `NOT IN`.

### 10.4 `http.ts`

`jsonOk` and `jsonError` as described in §5. Plus a thin `HTTPError` class for throwing inside handlers:

```ts
export class HTTPError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
```

`app.onError` in `app.ts` catches `HTTPError` and renders it through `jsonError()`.

---

## 11. Migration

One new Drizzle migration file (`bun --filter=server db:generate` after schema edits):

```sql
ALTER TABLE views ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE views ADD COLUMN "is_default" INTEGER NOT NULL DEFAULT 0;
```

No backfill needed — defaults handle existing rows correctly.

Drizzle schema (`apps/server/src/db/schema.ts`) adds:

```ts
order: integer('order').notNull().default(0),
isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
```

**`fields.type` enum expansion.** §9.1 inference returns 10 types (`boolean, datetime, date, number, multi_select, user_ref, url, document_ref, text, string`). The current `fields.type` enum has only 8 (`text, number, date, select, multi_select, user_ref, boolean, url`). SQLite stores enums as plain TEXT — Drizzle's `enum` is just a TypeScript-level check on insert/update. We extend the Drizzle enum to:

```ts
type: text('type', {
  enum: ['string', 'text', 'number', 'boolean', 'date', 'datetime',
         'select', 'multi_select', 'user_ref', 'url', 'document_ref'],
}).notNull(),
```

No SQL migration needed (TEXT column). Existing rows with `text` keep working — `text` stays in the enum.

---

## 12. Auth & role gating

| Action | Required role |
|---|---|
| Any read (`GET *`) | member |
| Document/status/field/view writes | member |
| `PATCH /workspaces/:wslug`, `DELETE /workspaces/:wslug` | owner |
| `DELETE /workspaces/:wslug/p/:pslug` | owner |

Role check pattern in handlers:

```ts
const role = getRole(c);
if (role !== 'owner') return jsonError(c, 'FORBIDDEN', 'owner only', 403);
```

Member management (invites, role changes) is out of Phase 1.

---

## 13. Tests

### 13.1 Layout

`*.test.ts` siblings to source files. Run via `bun test`.

| File | Coverage |
|---|---|
| `routes/workspaces.test.ts` | CRUD + role gating |
| `routes/projects.test.ts` | CRUD + default seeding (4 statuses + 2 views inserted on create) |
| `routes/documents.test.ts` | JSON + MD POST, PATCH merge semantics, `.md` round-trip, list with filters, cursor pagination, INVALID_STATUS, SLUG_CONFLICT |
| `routes/statuses.test.ts` | CRUD + rename cascade to documents, STATUS_IN_USE |
| `routes/fields.test.ts` | CRUD + type-change preserves data, options-required validation |
| `routes/views.test.ts` | CRUD + filter validation on POST/PATCH |
| `lib/events.test.ts` | events row written inside transaction, payload shape |
| `lib/slug-unique.test.ts` | base, base-2, base-3 sequence |
| `lib/filter-to-drizzle.test.ts` | column vs JSON-path branching, all operators |
| `shared/field-infer.test.ts` | rule ordering, all 10 rules |
| `shared/filter-compile.test.ts` | operators, error cases |
| `shared/slug.test.ts` | diacritics, length cap, edge cases |
| `__e2e__/phase-1-roundtrip.test.ts` | full happy path (see 13.3) |

### 13.2 Test harness (`apps/server/src/test/harness.ts`)

```ts
export async function makeTestApp(): Promise<{
  app: Hono;
  db: DB;
  seed: {
    user: User;
    workspace: Workspace;
    project: Project;
    sessionCookie: string;
  };
}>;
```

- Opens `:memory:` SQLite.
- Applies all migrations in order (via Drizzle's migrator pointed at the in-memory db).
- Inserts one user (`alice@test.local`), one owned workspace (`acme`), one project (`web`) with the 4 default statuses + 2 default views.
- Starts a session, returns the cookie value (caller passes it as `Cookie: folio_session=<cookie>`).

Each `describe` block opens a fresh harness via `beforeEach`. Test files do NOT share DB state.

### 13.3 Acceptance test (`__e2e__/phase-1-roundtrip.test.ts`)

The single end-to-end assertion that Phase 1 acceptance is met:

1. Register user → create workspace `acme` → create project `web` (asserts default statuses + views were seeded).
2. POST `text/markdown` document with frontmatter `{ type: work_item, status: in_progress, priority: high }` + body. Asserts slug derived from title, status validated.
3. PATCH (JSON) to change `frontmatter.priority = 'urgent'`. Asserts merge preserved other keys.
4. GET `:slug.md` and assert round-trip: parsed frontmatter and body equal the post-PATCH state.
5. Assert events table has `document.created` + `document.updated` rows with correct payloads.

### 13.4 Out of scope for Phase 1 tests

- Playwright / browser tests
- Load / perf tests
- Filter AST fuzz tests
- SSE channel tests (Phase 2)

---

## 14. Acceptance criteria

This spec is "done" when:

1. All URLs in §4 respond per the documented contracts.
2. The envelope in §5 is used everywhere — including migrated existing routes.
3. The events table has at least one row for every write through any of the Phase 1 routes.
4. `bun test` passes locally with all test files in §13.1 present and green.
5. The acceptance test in §13.3 passes.
6. PHASES.md Phase 1 boxes for Documents API, Statuses/fields/views, plus the Phase 0 carry-over rows for workspaces/projects routes, are checked.
7. Phase 1 frontend tasks (list view, kanban, slideover, editor, pages tree) remain unchecked — they're a separate spec.

---

## 15. Open questions deferred to implementation

- Cursor pagination: confirm Drizzle's `lt()` works cleanly with composite tuple comparison on SQLite. If not, fall back to `(updated_at < ?) OR (updated_at = ? AND id < ?)` shape — purely an implementation detail.
- Drizzle migrator harness for `:memory:` SQLite: verify the migrator API accepts an in-memory connection. If it doesn't, the harness runs `db.run(sql)` against the latest schema dump.

These don't change the contract — only how it's wired.
