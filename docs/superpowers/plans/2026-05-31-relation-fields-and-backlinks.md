# Relation Fields + Backlinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `relation` field type — typed links between documents with a pinned target (a table or the wiki) and single/multi cardinality — plus query-time backlinks, while keeping `[[slug]]` frontmatter as the source of truth.

**Architecture:** A relation field is a pinned `fields` row (no new `documents` columns, no link table). Target + cardinality live in the existing `fields.options` JSON. Links store as `"[[slug]]"` (single) or `["[[slug]]", ...]` (multi) — identical on-disk shape to today's `document_ref`. Backlinks are computed on read via SQLite `json_each`/`json_extract` over the frontmatter column — never stored, never drift. Work-item/page slugs become immutable so links can't silently break.

**Tech Stack:** Bun, Hono, Drizzle, SQLite (`json_each`/`json_extract`), React + TanStack Query, Vitest (web) / Bun test (server).

**Spec:** `docs/superpowers/specs/2026-05-31-relation-fields-and-backlinks-design.md`

---

## File map

**Server (`apps/server/src`):**
- `lib/field-type-change.ts` — source-of-truth `FIELD_TYPES` enum (add `relation`). MODIFY.
- `db/schema.ts` — Drizzle `fields.type` enum (add `relation`). MODIFY.
- `db/migrations/0019_relation_field_type.sql` — widen the `fields.type` CHECK constraint. CREATE.
- `db/migrations/meta/_journal.json` — add the 0019 journal entry. MODIFY.
- `routes/fields.ts` — `validateOptions` learns relation target+cardinality rules. MODIFY.
- `services/documents.ts` — remove `maybeRegenerateSlug` call (slug immutability). MODIFY.
- `services/backlinks.ts` — new query-time backlink resolver. CREATE.
- `routes/backlinks.ts` — new `GET …/documents/:slug/backlinks` endpoint. CREATE.
- `index.ts` (route mounting) — mount the backlinks route. MODIFY.

**Shared (`packages/shared/src`):**
- `index.ts` — add `relation` to the (currently stale) `FieldType` union. MODIFY.

**Web (`apps/web/src`):**
- `lib/api/fields.ts` — add `relation` to web `FieldType`. MODIFY.
- `components/table/table-add-column.tsx` — relation in the type list + target/cardinality inputs. MODIFY.
- `lib/api/backlinks.ts` — `useBacklinks` query hook. CREATE.
- `components/relations/relation-picker.tsx` — scoped doc picker (target-filtered). CREATE.
- `components/relations/relation-cell.tsx` — chip rendering for relation values. CREATE.
- `components/slideover/field-renderer.tsx` — relation case → picker/chips. MODIFY.
- `components/slideover/backlinks-panel.tsx` — "Linked from" panel. CREATE.

**Docs:**
- `memory/DECISIONS.md` — record the relation + slug-immutability decisions. MODIFY.

---

## Task 1: Add `relation` to the field-type enums + migration

**Files:**
- Modify: `apps/server/src/lib/field-type-change.ts:1-5`
- Modify: `apps/server/src/db/schema.ts:199-205`
- Modify: `packages/shared/src/index.ts:5-16`
- Modify: `apps/web/src/lib/api/fields.ts:4-16`
- Create: `apps/server/src/db/migrations/0019_relation_field_type.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Test: `apps/server/src/lib/field-type-change.test.ts` (existing — confirm or add)

- [ ] **Step 1: Write a failing test for the enum + a safe type change to text**

Add to `apps/server/src/lib/field-type-change.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { FIELD_TYPES, validateTypeChange } from './field-type-change.ts';

test('relation is a known field type', () => {
  expect(FIELD_TYPES).toContain('relation');
});

test('relation → text is always safe; relation → number is blocked', () => {
  expect(validateTypeChange('relation', 'text')).toEqual({ ok: true });
  expect(validateTypeChange('relation', 'number').ok).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/src/lib/field-type-change.test.ts`
Expected: FAIL — `FIELD_TYPES` does not contain `'relation'`.

- [ ] **Step 3: Add `relation` to the server source-of-truth enum**

In `apps/server/src/lib/field-type-change.ts`, change lines 1-5 to:

```typescript
export const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
  'currency', 'relation',
] as const;
```

(No change needed to `validateTypeChange` — `relation` is not in `COMPATIBLE_PAIRS`, so it falls through to "blocked except → text", which is the desired behavior.)

- [ ] **Step 4: Add `relation` to the Drizzle schema enum**

In `apps/server/src/db/schema.ts`, change the `fields.type` enum (lines 199-205) to include `'relation'`:

```typescript
    type: text('type', {
      enum: [
        'string', 'text', 'number', 'boolean', 'date', 'datetime',
        'select', 'multi_select', 'user_ref', 'url', 'document_ref',
        'currency', 'relation',
      ],
    }).notNull(),
```

- [ ] **Step 5: Add `relation` to the shared + web `FieldType` unions**

In `packages/shared/src/index.ts`, the `FieldType` union (lines 5-16) is stale (missing `currency`). Bring it current AND add `relation`:

```typescript
export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'user_ref'
  | 'url'
  | 'document_ref'
  | 'currency'
  | 'relation';
```

In `apps/web/src/lib/api/fields.ts`, change the `FieldType` union (lines 4-16) to add `| 'relation';` after `| 'currency'`.

- [ ] **Step 6: Write the migration widening the CHECK constraint**

The current constraint is in `0004_phase_2b_column_state.sql:7`. SQLite cannot `ALTER` a CHECK constraint in place — it requires the table-rebuild idiom (CREATE new / COPY / DROP / RENAME), the same pattern migration 0003 used for `fields`. Create `apps/server/src/db/migrations/0019_relation_field_type.sql`:

```sql
-- Widen fields.type CHECK to allow 'relation'. SQLite can't ALTER a CHECK
-- in place; rebuild the table (CREATE/COPY/DROP/RENAME) preserving every
-- column, FK, and the (table_id, key) unique index.
PRAGMA foreign_keys=OFF;

CREATE TABLE `fields_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`table_id` text NOT NULL REFERENCES `tables`(`id`) ON DELETE cascade,
	`key` text NOT NULL,
	`type` text NOT NULL CHECK (`type` IN ('string','text','number','boolean','date','datetime','select','multi_select','user_ref','url','document_ref','currency','relation')),
	`label` text,
	`options` text,
	`order` integer DEFAULT 0 NOT NULL
);

INSERT INTO `fields_new` (`id`,`project_id`,`table_id`,`key`,`type`,`label`,`options`,`order`)
	SELECT `id`,`project_id`,`table_id`,`key`,`type`,`label`,`options`,`order` FROM `fields`;

DROP TABLE `fields`;
ALTER TABLE `fields_new` RENAME TO `fields`;

CREATE UNIQUE INDEX `fields_table_key_idx` ON `fields` (`table_id`,`key`);

PRAGMA foreign_keys=ON;
```

> If the local `fields` table DDL differs from the snippet above, match the **current** column list exactly (run `bun --filter=server db:studio` or inspect `0004`/`0003` migrations) — the rebuild must preserve every column verbatim.

- [ ] **Step 7: Register the migration in the journal**

Per the `drizzle-migration-journal` rule, `migrate()` silently skips files not in the journal. Append to the `entries` array in `apps/server/src/db/migrations/meta/_journal.json` (after the `0018` entry):

```json
    ,{
      "idx": 20,
      "version": "6",
      "when": 1780940000000,
      "tag": "0019_relation_field_type",
      "breakpoints": true
    }
```

(Place the comma correctly — it joins the existing last entry. The final array element must have no trailing comma.)

- [ ] **Step 8: Run the migration + full server type-check + tests**

Run: `bun --filter=server db:migrate`
Expected: applies `0019_relation_field_type` with no error.

Run: `bun x tsc --noEmit` (from repo root) and `bun test apps/server/src/lib/field-type-change.test.ts`
Expected: type-check passes; both new tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/lib/field-type-change.ts apps/server/src/db/schema.ts packages/shared/src/index.ts apps/web/src/lib/api/fields.ts apps/server/src/db/migrations/0019_relation_field_type.sql apps/server/src/db/migrations/meta/_journal.json apps/server/src/lib/field-type-change.test.ts
git commit -m "phase-3.x: add relation field type to enums + CHECK migration"
```

---

## Task 2: Validate relation target + cardinality in the fields route

The relation config lives in `fields.options`: `options[0]` = `"table:<table_id>"` or `"wiki"`; `options[1]` = `"single"` or `"multi"`.

**Files:**
- Modify: `apps/server/src/routes/fields.ts:26-42` (`validateOptions`)
- Test: `apps/server/src/routes/fields.test.ts`

- [ ] **Step 1: Write failing tests for relation option validation**

Add to `apps/server/src/routes/fields.test.ts` (follow the existing harness in that file for app setup; these assert HTTP behavior on POST `…/fields`):

```typescript
test('relation requires options [target, cardinality]', async () => {
  // missing options → 422
  const r1 = await postField({ key: 'owner', type: 'relation' });
  expect(r1.status).toBe(422);

  // bad cardinality → 422
  const r2 = await postField({ key: 'owner', type: 'relation', options: ['wiki', 'lots'] });
  expect(r2.status).toBe(422);

  // valid wiki target → 201
  const r3 = await postField({ key: 'owner', type: 'relation', options: ['wiki', 'single'] });
  expect(r3.status).toBe(201);

  // valid table target → 201
  const r4 = await postField({ key: 'bugs', type: 'relation', options: ['table:tbl_abc', 'multi'] });
  expect(r4.status).toBe(201);
});
```

> `postField` is a thin helper around the test app's POST to the fields route; mirror how existing tests in `fields.test.ts` issue authenticated requests. If no helper exists, inline the `app.request(...)` call following the currency-field test in the same file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/server/src/routes/fields.test.ts`
Expected: FAIL — relation currently falls into the "does not allow options" branch and rejects the valid cases.

- [ ] **Step 3: Add the relation branch to `validateOptions`**

In `apps/server/src/routes/fields.ts`, insert before the final `if (options !== undefined)` guard (currently line 39):

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/server/src/routes/fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/fields.ts apps/server/src/routes/fields.test.ts
git commit -m "phase-3.x: validate relation target + cardinality on field create/patch"
```

---

## Task 3: Make work_item / page slugs immutable

Removes `maybeRegenerateSlug` from the update path so a retitle never moves the slug — the linchpin that keeps `[[slug]]` links durable. This task is independent of relations and can land on its own.

**Files:**
- Modify: `apps/server/src/services/documents.ts:875-880` (call site) and `:735-745` (function)
- Modify: `apps/server/src/routes/documents.ts` (PLAN CORRECTION 2026-05-31: a SECOND call site exists here — the markdown-PATCH path at `~:325` calls `maybeRegenerateSlug` independently of the service-layer JSON-PATCH path. Both must be replaced with `const nextSlug: string | null = null` and the now-dead import removed. The original plan only named `services/documents.ts`; grep ALL of `apps/server` for callers — `plan-server-source-audit` lesson.)
- Test: `apps/server/src/services/documents.test.ts`

- [ ] **Step 1: Write a failing pin test for slug immutability**

Add to `apps/server/src/services/documents.test.ts` (follow the existing create/update harness in that file):

```typescript
test('retitling a work_item does NOT change its slug (slugs are immutable)', async () => {
  const created = await createWorkItem({ title: 'Fix login bug' });
  expect(created.slug).toBe('fix-login-bug');

  const updated = await updateWorkItem(created, { title: 'Fix the login bug completely' });
  expect(updated.slug).toBe('fix-login-bug'); // unchanged
  expect(updated.title).toBe('Fix the login bug completely');
});
```

> `createWorkItem` / `updateWorkItem` are stand-ins for whatever the existing tests use to drive `createDocument` / `updateDocument`. Reuse the file's existing helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/src/services/documents.test.ts`
Expected: FAIL — the slug regenerates to `fix-the-login-bug-completely` (because the original slug was auto-derived).

- [ ] **Step 3: Remove the slug-regeneration call site**

In `apps/server/src/services/documents.ts`, replace the block at lines 875-880:

```typescript
  // Agents/triggers don't rename their slug on title change (URLs are sticky
  // and frontmatter references would break). Only project-scoped docs do.
  const nextSlug =
    patch.title !== undefined && p
      ? await maybeRegenerateSlug(p.id, existing, patch.title)
      : null;
```

with:

```typescript
  // Slugs are immutable for ALL document types (extends the table/agent/trigger
  // precedent). A retitle changes the title only — never the slug — so [[slug]]
  // relation links and backlinks stay valid forever. No rename cascade.
  const nextSlug: string | null = null;
```

(Leaving `nextSlug` as a typed `null` keeps the downstream `...(nextSlug ? { slug: nextSlug } : {})` and `...(nextSlug ? ['slug'] : [])` lines valid with zero further edits.)

- [ ] **Step 4: Remove the now-dead `maybeRegenerateSlug` + `isSlugAutoDerived`**

Check for other importers first:

Run: `grep -rn "maybeRegenerateSlug\|isSlugAutoDerived" apps/server/src packages`
Expected: only `documents.ts` (definition) and `documents.test.ts` references remain.

If a test asserts `maybeRegenerateSlug` behavior directly, delete that test (the behavior is intentionally gone). Then delete `isSlugAutoDerived` (lines 729-733) and `maybeRegenerateSlug` (lines 735-745) and the explanatory comment at 725-728 from `documents.ts`.

- [ ] **Step 5: Run the full documents test suite + type-check**

Run: `bun test apps/server/src/services/documents.test.ts` and `bun x tsc --noEmit`
Expected: the new pin test PASSES; no unused-symbol or type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/documents.ts apps/server/src/services/documents.test.ts
git commit -m "phase-3.x: make work_item/page slugs immutable (durable relation links)"
```

---

## Task 4: Query-time backlink resolver + endpoint

Resolves "which documents link to this slug" by scanning `relation`-typed frontmatter via `json_each`/`json_extract`. Handles both the single (`"[[slug]]"`) and multi (`["[[slug]]"]`) shapes.

**Files:**
- Create: `apps/server/src/services/backlinks.ts`
- Create: `apps/server/src/routes/backlinks.ts`
- Modify: the route-mounting file (find with `grep -rn "fieldsRoute\|\.route('" apps/server/src/index.ts apps/server/src/app.ts`)
- Test: `apps/server/src/services/backlinks.test.ts`

- [ ] **Step 1: Write a failing test for the resolver**

Create `apps/server/src/services/backlinks.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { findBacklinks } from './backlinks.ts';
// Reuse the project's test-db bootstrap (see documents.test.ts for the pattern).

test('finds single-link and multi-link sources, ignores non-matching slugs', async () => {
  const ctx = await seedProject(); // helper from existing tests
  const target = await createDoc(ctx, { title: 'People: Ada', slug: 'people-ada' });

  // single link
  await createDoc(ctx, { title: 'Bug A', frontmatter: { owner: '[[people-ada]]' } });
  // multi link
  await createDoc(ctx, { title: 'Bug B', frontmatter: { watchers: ['[[people-ada]]', '[[someone-else]]'] } });
  // non-matching
  await createDoc(ctx, { title: 'Bug C', frontmatter: { owner: '[[other-person]]' } });

  const results = await findBacklinks({ workspaceId: ctx.workspaceId, projectId: ctx.projectId, slug: 'people-ada' });
  const titles = results.map((r) => r.title).sort();
  expect(titles).toEqual(['Bug A', 'Bug B']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/src/services/backlinks.test.ts`
Expected: FAIL — `findBacklinks` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `apps/server/src/services/backlinks.ts`. The match must catch the slug whether it's a top-level string value (`"[[slug]]"`) or an element of an array value (`["[[slug]]"]`). `json_each` over each frontmatter value handles arrays; a direct `LIKE` over the serialized frontmatter handles the single-string case. Use the existing `sql` template style (see `lib/filter-to-drizzle.ts:22`):

```typescript
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';

export interface BacklinkRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  tableId: string | null;
}

export interface FindBacklinksArgs {
  workspaceId: string;
  projectId: string;
  slug: string;
}

/**
 * Query-time backlinks: documents in the workspace whose frontmatter contains
 * the wiki-link token `[[<slug>]]` in ANY value — a single relation string or
 * an element of a multi-relation array. Links live only in frontmatter (the
 * source of truth); nothing is stored in reverse, so this can't drift.
 */
export async function findBacklinks(args: FindBacklinksArgs): Promise<BacklinkRow[]> {
  const token = `[[${args.slug}]]`;
  // Match the token either as the whole frontmatter-value string OR as any
  // element of an array value. json_each flattens both: for a string value it
  // yields one row whose `value` is the string; for an array it yields one row
  // per element. So a single EXISTS over json_each(frontmatter)'s leaf values
  // covers both shapes when the value is a top-level key. For nested arrays we
  // walk one level via a correlated json_each on each value.
  const rows = await db.all<BacklinkRow>(sql`
    SELECT d.id AS id, d.slug AS slug, d.title AS title, d.type AS type, d.table_id AS tableId
    FROM ${documents} d
    WHERE d.workspace_id = ${args.workspaceId}
      AND d.type IN ('work_item','page')
      AND d.slug != ${args.slug}
      AND EXISTS (
        SELECT 1 FROM json_each(d.frontmatter) AS fm
        WHERE fm.value = ${token}
           OR (json_valid(fm.value) AND EXISTS (
                 SELECT 1 FROM json_each(fm.value) AS el WHERE el.value = ${token}
               ))
      )
    ORDER BY d.table_id, d.title
  `);
  return rows;
}
```

> `db.all` is the project's raw-SQL read helper (the same one used in the descendant-cascade query in `documents.ts` and the EXPLAIN tests in `agent-runs.test.ts`). If the codebase exposes it differently (e.g. `tx.all` / `sqlite.prepare`), match that call style.

- [ ] **Step 4: Run the resolver test to verify it passes**

Run: `bun test apps/server/src/services/backlinks.test.ts`
Expected: PASS — `['Bug A', 'Bug B']`.

- [ ] **Step 5: Write a failing test for the HTTP endpoint**

Add to `apps/server/src/routes/backlinks.test.ts` (new file; mirror the auth/app setup in `fields.test.ts`):

```typescript
test('GET .../documents/:slug/backlinks returns linking docs', async () => {
  // seed a target + a doc linking to it, then:
  const res = await app.request(`/api/v1/w/${ws}/p/${proj}/documents/people-ada/backlinks`, {
    headers: authHeaders,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.map((r: { slug: string }) => r.slug)).toContain('bug-a');
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test apps/server/src/routes/backlinks.test.ts`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 7: Implement + mount the route**

Create `apps/server/src/routes/backlinks.ts`:

```typescript
import { Hono } from 'hono';
import { jsonOk, HTTPError } from '../lib/http.ts';
import { findBacklinks } from '../services/backlinks.ts';
import { type AuthContext } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { getProject, getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { and, eq } from 'drizzle-orm';

const backlinksRoute = new Hono<AuthContext & ScopeContext>();

backlinksRoute.get('/:slug/backlinks', requireScope('documents:read'), async (c) => {
  const ws = getWorkspace(c);
  const p = getProject(c);
  const slug = c.req.param('slug');

  const target = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, p.id), eq(documents.slug, slug)),
  });
  if (!target) throw new HTTPError('DOCUMENT_NOT_FOUND', `document "${slug}" not found`, 404);

  const data = await findBacklinks({ workspaceId: ws.id, projectId: p.id, slug });
  return jsonOk(c, { data });
});

export { backlinksRoute };
```

Mount it alongside the documents routes. Find the existing mount (`grep -rn "documents'" apps/server/src/index.ts apps/server/src/app.ts apps/server/src/routes/index.ts`) and add, next to the project-scoped documents route mount:

```typescript
.route('/api/v1/w/:wslug/p/:pslug/documents', backlinksRoute)
```

> Mount it on the SAME base path the `:slug/backlinks` sub-path expects, under the same scope-resolution middleware that already attaches `getProject`/`getWorkspace` (the documents route does this). If documents are mounted under a table-scoped path too, mounting under the project-scoped `documents` base is sufficient for v1 — relations can point cross-table within the project.

- [ ] **Step 8: Run the route test + full server suite**

Run: `bun test apps/server/src/routes/backlinks.test.ts` then `bun test apps/server` (or the server test script)
Expected: PASS; no regressions.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/services/backlinks.ts apps/server/src/services/backlinks.test.ts apps/server/src/routes/backlinks.ts apps/server/src/routes/backlinks.test.ts apps/server/src/index.ts
git commit -m "phase-3.x: query-time backlink resolver + GET documents/:slug/backlinks"
```

---

## Task 5: Field-config UI — relation target + cardinality

**Files:**
- Modify: `apps/web/src/components/table/table-add-column.tsx`
- Test: `apps/web/src/components/table/table-add-column.test.tsx`

- [ ] **Step 1: Write a failing test for the relation config inputs**

Add to `apps/web/src/components/table/table-add-column.test.tsx` (RTL):

```tsx
test('relation type reveals target + cardinality and submits them as options', async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<TableAddColumn onSubmit={onSubmit} tables={[{ id: 'tbl_1', name: 'People' }]} />);
  await userEvent.click(screen.getByLabelText('Add column'));
  await userEvent.type(screen.getByLabelText(/key/i), 'owner');
  await userEvent.selectOptions(screen.getByLabelText(/type/i), 'relation');
  await userEvent.selectOptions(screen.getByLabelText(/links to/i), 'table:tbl_1');
  await userEvent.selectOptions(screen.getByLabelText(/cardinality/i), 'single');
  await userEvent.click(screen.getByRole('button', { name: /create/i }));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'owner', type: 'relation', options: ['table:tbl_1', 'single'] }),
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/src/components/table/table-add-column.test.tsx`
Expected: FAIL — `relation` not offered; no target/cardinality inputs; `tables` prop unknown.

- [ ] **Step 3: Add the relation entry + a `tables` prop + state**

In `apps/web/src/components/table/table-add-column.tsx`:

Add to the `FIELD_TYPES` list (after the `document_ref` entry, line 20):

```typescript
  { value: 'relation', label: 'Relation (link to docs)' },
```

Extend `Props` (line 41-43) and the component signature:

```typescript
interface Props {
  onSubmit: (payload: AddColumnPayload) => Promise<void> | void;
  tables?: { id: string; name: string }[];
}

export function TableAddColumn({ onSubmit, tables = [] }: Props) {
```

Add state next to the other `useState` calls (after line 51):

```typescript
  const [relTarget, setRelTarget] = useState('wiki');
  const [relCardinality, setRelCardinality] = useState<'single' | 'multi'>('single');
```

Reset them in `reset()` (after line 61):

```typescript
    setRelTarget('wiki');
    setRelCardinality('single');
```

- [ ] **Step 4: Build the relation options in `handleSubmit` + render the inputs**

In `handleSubmit`, after the `currency` branch (line 91), add:

```typescript
    } else if (type === 'relation') {
      options = [relTarget, relCardinality];
```

(Change the preceding `} else if (type === 'currency') {` chain so this is a sibling `else if`.)

Add the conditional inputs after the currency block (line 208):

```tsx
          {type === 'relation' ? (
            <>
              <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-rel-target">
                Links to
              </label>
              <select
                id="add-col-rel-target"
                aria-label="Links to"
                value={relTarget}
                onChange={(e) => setRelTarget(e.target.value)}
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              >
                <option value="wiki">Wiki / Pages</option>
                {tables.map((t) => (
                  <option key={t.id} value={`table:${t.id}`}>{t.name}</option>
                ))}
              </select>

              <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="add-col-rel-card">
                Cardinality
              </label>
              <select
                id="add-col-rel-card"
                aria-label="Cardinality"
                value={relCardinality}
                onChange={(e) => setRelCardinality(e.target.value as 'single' | 'multi')}
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              >
                <option value="single">Single link</option>
                <option value="multi">Multiple links</option>
              </select>
            </>
          ) : null}
```

- [ ] **Step 5: Pass `tables` from the caller**

Find where `<TableAddColumn` is rendered (`grep -rn "TableAddColumn" apps/web/src`) and pass the project's tables list (the rail/table data is already loaded in the table view). If the caller lacks the tables list, thread it from the existing tables query hook used by the rail.

- [ ] **Step 6: Run the test to verify it passes + type-check**

Run: `npx vitest run apps/web/src/components/table/table-add-column.test.tsx` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/table/table-add-column.tsx apps/web/src/components/table/table-add-column.test.tsx
git commit -m "phase-3.x: relation column config (target + cardinality) in add-column UI"
```

---

## Task 6: Scoped relation picker

A doc picker filtered to the relation field's pinned target (a specific table, or the wiki). Reuses the keyboard ergonomics of `WikiLinkPicker` but accepts a target filter and an `existing` set (for multi).

**Files:**
- Create: `apps/web/src/components/relations/relation-picker.tsx`
- Test: `apps/web/src/components/relations/relation-picker.test.tsx`

- [ ] **Step 1: Write a failing test**

Create `apps/web/src/components/relations/relation-picker.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { RelationPicker } from './relation-picker.tsx';

test('lists candidates filtered by target and calls onSelect with slug', async () => {
  const onSelect = vi.fn();
  render(
    <RelationPicker
      candidates={[
        { id: '1', slug: 'people-ada', title: 'Ada' },
        { id: '2', slug: 'people-bob', title: 'Bob' },
      ]}
      query=""
      excludeSlugs={['people-bob']}
      onSelect={onSelect}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.queryByText('Bob')).not.toBeInTheDocument(); // excluded (already linked)
  await userEvent.click(screen.getByText('Ada'));
  expect(onSelect).toHaveBeenCalledWith({ slug: 'people-ada', title: 'Ada' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/src/components/relations/relation-picker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the picker**

Create `apps/web/src/components/relations/relation-picker.tsx`. It takes a pre-resolved `candidates` array (the caller does the target-scoped fetch — keeps the picker pure and testable) plus an `excludeSlugs` set for multi-links already chosen:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../ui/cn.ts';

export interface RelationCandidate {
  id: string;
  slug: string;
  title: string;
}

interface RelationPickerProps {
  candidates: RelationCandidate[];
  query: string;
  excludeSlugs?: string[];
  onSelect: (target: { slug: string; title: string }) => void;
  onClose: () => void;
}

export function RelationPicker({
  candidates,
  query,
  excludeSlugs = [],
  onSelect,
  onClose,
}: RelationPickerProps) {
  const exclude = useMemo(() => new Set(excludeSlugs), [excludeSlugs]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      candidates
        .filter((d) => !exclude.has(d.slug))
        .filter((d) => (q ? d.title.toLowerCase().includes(q) : true)),
    [candidates, exclude, q],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => setSelectedIndex(0), [filtered.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (filtered.length > 0 ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (filtered.length > 0 ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const doc = filtered[selectedIndex];
      if (doc) onSelect({ slug: doc.slug, title: doc.title });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      role="listbox"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-border-light bg-content p-1 shadow-md w-[260px]"
    >
      {filtered.length === 0 ? (
        <div className="px-2 py-1 text-xs text-fg-3">No matching documents</div>
      ) : (
        filtered.map((d, i) => (
          <button
            key={d.id}
            type="button"
            role="option"
            aria-selected={selectedIndex === i}
            onClick={() => onSelect({ slug: d.slug, title: d.title })}
            className={cn(
              'block w-full rounded-md px-2 py-1.5 text-left text-sm',
              selectedIndex === i ? 'bg-card' : 'hover:bg-card',
            )}
          >
            <div className="font-medium">{d.title}</div>
            <div className="text-[10px] font-mono text-fg-3">{`[[${d.slug}]]`}</div>
          </button>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/web/src/components/relations/relation-picker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/relations/relation-picker.tsx apps/web/src/components/relations/relation-picker.test.tsx
git commit -m "phase-3.x: scoped relation picker component"
```

---

## Task 7: Relation cell rendering + slideover wiring + backlinks panel

Ties the pieces together: render relation values as chips (with unresolved styling), edit via the picker in the slideover, and show the "Linked from" panel.

**Files:**
- Create: `apps/web/src/components/relations/relation-cell.tsx`
- Create: `apps/web/src/lib/api/backlinks.ts`
- Create: `apps/web/src/components/slideover/backlinks-panel.tsx`
- Modify: `apps/web/src/components/slideover/field-renderer.tsx:20-32` (relation case)
- Test: `apps/web/src/components/relations/relation-cell.test.tsx`, `apps/web/src/components/slideover/backlinks-panel.test.tsx`

- [ ] **Step 1: Write a failing test for the relation cell (chips + unresolved)**

Create `apps/web/src/components/relations/relation-cell.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { RelationCell } from './relation-cell.tsx';

test('renders linked titles as chips, unresolved slug struck-through', () => {
  render(
    <RelationCell
      value={['[[people-ada]]', '[[ghost]]']}
      resolve={(slug) => (slug === 'people-ada' ? { slug, title: 'Ada' } : null)}
    />,
  );
  expect(screen.getByText('Ada')).toBeInTheDocument();
  const ghost = screen.getByText('[[ghost]]');
  expect(ghost).toHaveClass('line-through'); // unresolved
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/src/components/relations/relation-cell.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the relation cell**

Create `apps/web/src/components/relations/relation-cell.tsx`. Normalizes single (`string`) or multi (`string[]`) to an array, parses `[[slug]]`, resolves to a title via the injected `resolve` fn, renders unresolved as struck-through:

```tsx
import { cn } from '../ui/cn.ts';

const TOKEN_RE = /^\[\[([\w-]+)\]\]$/;

export interface RelationCellProps {
  value: unknown;
  resolve: (slug: string) => { slug: string; title: string } | null;
  onChipClick?: (slug: string) => void;
}

function toTokens(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

export function RelationCell({ value, resolve, onChipClick }: RelationCellProps) {
  const tokens = toTokens(value);
  if (tokens.length === 0) return <span className="text-fg-3">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tokens.map((tok) => {
        const m = TOKEN_RE.exec(tok);
        const slug = m?.[1];
        const resolved = slug ? resolve(slug) : null;
        if (!resolved) {
          return (
            <span key={tok} className="rounded-sm bg-card px-1.5 py-0.5 text-xs font-mono text-fg-3 line-through">
              {tok}
            </span>
          );
        }
        return (
          <button
            key={tok}
            type="button"
            onClick={() => onChipClick?.(resolved.slug)}
            className="rounded-sm bg-card px-1.5 py-0.5 text-xs hover:bg-border-light"
          >
            {resolved.title}
          </button>
        );
      })}
    </span>
  );
}
```

- [ ] **Step 4: Run the cell test to verify it passes**

Run: `npx vitest run apps/web/src/components/relations/relation-cell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the backlinks query hook**

Create `apps/web/src/lib/api/backlinks.ts` (mirror the shape of `lib/api/fields.ts`):

```typescript
import { useQuery } from '@tanstack/react-query';
import { client } from './client.ts';

export interface BacklinkRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  tableId: string | null;
}

export const backlinksKeys = {
  list: (wslug: string, pslug: string, slug: string) =>
    ['backlinks', wslug, pslug, slug] as const,
};

export function useBacklinks(wslug: string, pslug: string, slug: string) {
  return useQuery({
    queryKey: backlinksKeys.list(wslug, pslug, slug),
    queryFn: async (): Promise<BacklinkRow[]> => {
      const res = await client.get(`/w/${wslug}/p/${pslug}/documents/${slug}/backlinks`);
      return res.data.data as BacklinkRow[];
    },
  });
}
```

> Match the actual `client` call style in `lib/api/fields.ts` (it may be `client.get(...).then(...)` or a fetch wrapper). Use the same base-path convention the other hooks use.

- [ ] **Step 6: Write a failing test for the backlinks panel**

Create `apps/web/src/components/slideover/backlinks-panel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { BacklinksPanel } from './backlinks-panel.tsx';

test('renders linking docs grouped, empty state when none', () => {
  const { rerender } = render(
    <BacklinksPanel backlinks={[{ id: '1', slug: 'bug-a', title: 'Bug A', type: 'work_item', tableId: 't1' }]} onOpen={() => {}} />,
  );
  expect(screen.getByText('Bug A')).toBeInTheDocument();

  rerender(<BacklinksPanel backlinks={[]} onOpen={() => {}} />);
  expect(screen.getByText(/no documents link here/i)).toBeInTheDocument();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run apps/web/src/components/slideover/backlinks-panel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the backlinks panel (pure, takes resolved data)**

Create `apps/web/src/components/slideover/backlinks-panel.tsx`:

```tsx
import type { BacklinkRow } from '../../lib/api/backlinks.ts';

interface Props {
  backlinks: BacklinkRow[];
  onOpen: (slug: string) => void;
}

export function BacklinksPanel({ backlinks, onOpen }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-fg-3">Linked from</div>
      {backlinks.length === 0 ? (
        <p className="text-xs text-fg-3">No documents link here.</p>
      ) : (
        backlinks.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onOpen(b.slug)}
            className="block w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
          >
            {b.title}
          </button>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 9: Run the panel test to verify it passes**

Run: `npx vitest run apps/web/src/components/slideover/backlinks-panel.test.tsx`
Expected: PASS.

- [ ] **Step 10: Wire the relation case into FieldRenderer**

In `apps/web/src/components/slideover/field-renderer.tsx`, remove `case 'document_ref':` from the plain-text group at line 24 (it stays string-rendered only if unpinned — but pinned relation gets its own case). Add a dedicated `relation` case in the `switch` (after the `currency` case at line ~100). It renders chips + an "add link" affordance that opens the `RelationPicker`; the caller supplies the target-scoped `candidates` and a `resolve` map. Because `FieldRenderer` currently only receives `type`/`value`/`options`, thread two new optional props:

```typescript
interface Props {
  fieldKey: string;
  type: FieldType;
  value: unknown;
  options?: string[];
  onCommit: (next: unknown) => void;
  isPending?: boolean;
  // relation support:
  relationCandidates?: { id: string; slug: string; title: string }[];
  resolveSlug?: (slug: string) => { slug: string; title: string } | null;
}
```

Add the case:

```tsx
    case 'relation': {
      const cardinality = options?.[1] === 'multi' ? 'multi' : 'single';
      const tokens =
        typeof value === 'string' ? (value ? [value] : []) :
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      const excludeSlugs = tokens
        .map((t) => /^\[\[([\w-]+)\]\]$/.exec(t)?.[1])
        .filter((s): s is string => Boolean(s));
      const commitToken = (slug: string) => {
        const tok = `[[${slug}]]`;
        if (cardinality === 'single') onCommit(tok);
        else onCommit([...tokens, tok]);
      };
      const removeToken = (tok: string) => {
        if (cardinality === 'single') onCommit('');
        else onCommit(tokens.filter((t) => t !== tok));
      };
      return (
        <RelationField
          tokens={tokens}
          cardinality={cardinality}
          candidates={relationCandidates ?? []}
          excludeSlugs={excludeSlugs}
          resolve={resolveSlug ?? (() => null)}
          onAdd={commitToken}
          onRemove={removeToken}
          isPending={isPending}
        />
      );
    }
```

Implement a small local `RelationField` sub-component in the same file (popover wrapping `RelationPicker` for adding, `RelationCell`-style chips with a remove "×" for each token). Import `RelationPicker` and reuse the chip markup from `RelationCell` (or import `RelationCell` for the read display).

- [ ] **Step 11: Wire the cell into TableView + the panel + candidates into the slideover**

- In the TableView cell layer (find the per-type render with `grep -rn "field-renderer\|FieldRenderer\|document_ref\|col.type" apps/web/src/components/table`), route `relation`-typed columns to `RelationCell` with a `resolve` built from the already-loaded documents query.
- In the slideover container that renders `FieldRenderer`, fetch target-scoped candidates: parse `options[0]` (`wiki` → pages; `table:<id>` → that table's work_items) using the existing `useDocuments` hook, pass as `relationCandidates`, and build `resolveSlug` from the same data.
- Render `<BacklinksPanel>` in the slideover, fed by `useBacklinks(wslug, pslug, doc.slug)`, with `onOpen` navigating to / opening that doc's slideover.

- [ ] **Step 12: Run the web suite + type-check**

Run: `npx vitest run apps/web/src/components/relations apps/web/src/components/slideover/backlinks-panel.test.tsx apps/web/src/components/slideover/field-renderer.test.tsx` then `bun x tsc --noEmit`
Expected: PASS; no type errors. Update `field-renderer.test.tsx` if the `document_ref`-as-plain-text assertion changed (unpinned document_ref still renders as text; only pinned `relation` uses chips).

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/components/relations apps/web/src/lib/api/backlinks.ts apps/web/src/components/slideover/backlinks-panel.tsx apps/web/src/components/slideover/backlinks-panel.test.tsx apps/web/src/components/slideover/field-renderer.tsx apps/web/src/components/table
git commit -m "phase-3.x: relation cell + slideover picker/chips + Linked-from panel"
```

---

## Task 8: Record decisions + run the full gates

**Files:**
- Modify: `memory/DECISIONS.md`

- [ ] **Step 1: Append the decision record**

Add a `## Phase 3.x — Relation fields + backlinks (2026-05-31)` section to `memory/DECISIONS.md` capturing:
- `relation` is the pinned/targeted upgrade of `document_ref`; both store the same `[[slug]]` / `["[[slug]]"]` frontmatter shape. Target + cardinality in `fields.options` (`["wiki"|"table:<id>", "single"|"multi"]`).
- Backlinks are **query-time only** (`json_each` over frontmatter), never stored — can't drift, no reconciler.
- **work_item/page slugs are now immutable** (extends the table/agent/trigger precedent); `maybeRegenerateSlug` removed. Retitle changes title only.
- Dangling relations render unresolved and are never auto-stripped; frontmatter is source of truth.
- Adding a field type requires updating BOTH the Drizzle enum AND the SQL CHECK (precedent reaffirmed; migration 0019).

- [ ] **Step 2: Run the full gates**

Run, in order:
- `bun x tsc --noEmit` (repo root)
- `bun test` (server + shared)
- `npx vitest run` (web)

Expected: all green. Note any known flake (`list-view-create.test.tsx`) and rerun once before treating as a regression.

- [ ] **Step 3: Commit**

```bash
git add memory/DECISIONS.md
git commit -m "docs: record relation-fields + slug-immutability decisions"
```

---

## Self-review notes

- **Spec coverage:** data model (T1/T2), backlinks query-time (T4), slug immutability (T3), unresolved-link rendering (T7 cell), field config reuse (T5), scoped picker (T6), Linked-from panel (T7), CHECK-constraint migration + journal (T1), DECISIONS addendum (T8). Inference-unchanged pin test — covered implicitly (no change to `field-infer.ts`); add an explicit assertion in `field-infer.test.ts` if not already present.
- **Type consistency:** `findBacklinks`/`BacklinkRow`/`FindBacklinksArgs` (server) and `BacklinkRow`/`useBacklinks` (web) names align across T4↔T7. `RelationCandidate`/`RelationPicker` props consistent T6↔T7. `options` shape `[target, cardinality]` identical across T2 (server validate), T5 (UI submit), T7 (renderer read).
- **Known divergence to verify at execution:** three separate `FieldType` definitions exist (server `field-type-change.ts`, web `lib/api/fields.ts`, shared `index.ts`). T1 updates all three. The server enum is the validation source of truth; the shared one was stale (missing `currency`) and is brought current.
- **Branch note:** this is a separable feature — execute on a dedicated branch (e.g. `phase-3.x/relation-fields`) rather than `phase-3.x/board-view`.
