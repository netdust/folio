# Sortable custom fields — spec + implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every visible column is sortable. Extend the (already-working, built-ins-only) server sort to also sort by custom frontmatter fields (priority, assignee, due_date, etc.) — type-aware ordering, validated against the table's registered `fields`, with the same no-drop/no-dupe keyset cursor guarantee.

**Context:** Follow-up to `phase-3.x/tableview-ux` (built-in sort + sort-aware keyset cursor + NULL-status coalesce sentinel already shipped on this branch). Stefan: "every column sortable would be the correct UX." Locked decisions (2026-05-31): (a) validate a field sort-key against the table's pinned `fields` rows before building any `json_extract` — never interpolate raw input into SQL; (b) type-aware ordering from the field's pinned `type`.

**Tech stack:** Bun + Hono + Drizzle + SQLite (server), React + Tailwind + vitest (web). NOTE: web tests run via `npx vitest run`, server tests via `bun test`.

**Key source facts (verified 2026-05-31):**
- `apps/server/src/services/documents.ts`: `SORT_COLUMNS = { title, status, updated_at }`; `sortExpr(key)` returns an `SQL` (status → `coalesce(status, '￿')`, others → `sql\`${col}\``); `resolveSort(sort, dir)` rejects unknown keys → `updated_at`; `encodeCursor(sortKey, sortValue, id)` / `decodeCursor` — **decodeCursor currently rejects any sortKey not in SORT_COLUMNS** (`:127`), which must be loosened. `NULL_SENTINEL = '￿'`. `listDocuments(opts)` has `projectId`, `activeTableId?`, `sort?`, `dir?`; has `db` + `documents` in scope; the query is `db.select().from(documents).where(and(...whereClauses)).orderBy(dirFn(sortExpr(sortKey)), dirFn(documents.id)).limit(limit+1)`.
- `fields` table (`schema.ts`): `{ id, projectId, tableId, key, type, label, options }`, unique index on `(tableId, key)`. `type` enum includes string/text/number/currency/boolean/date/datetime/select/multi_select/user_ref/url/document_ref.
- Client `Column` (`apps/web/src/components/table/columns.ts`) already carries `source` ('builtin'|'field') + `fieldType`.
- `apps/web/src/components/table/table-header.tsx:15`: `SORTABLE_BUILTIN_KEYS = ['title','status','updated_at']`; `:105-116` gates `sortable` on `source === 'builtin' && SORTABLE_BUILTIN_KEYS.includes(key)`. This gate must widen to "all columns sortable."

## Design

### Server — field-aware sort

`listDocuments` gains awareness of frontmatter-field sorting. A sort key is valid if it is a built-in (`title/status/updated_at`) OR a registered field `key` for `activeTableId`. Field validation happens by querying the `fields` table (cheap, indexed) — the matched row supplies BOTH the safe key (for the `json_extract` path) and the `type` (for ordering).

**Order expression for a field key `k` of type `t`:**
- numeric types (`number`, `currency`) → `coalesce(cast(json_extract(frontmatter, '$.<k>') as real), <numeric-sentinel>)`
- everything else (text/date/datetime/select/url/user_ref/etc.) → `coalesce(json_extract(frontmatter, '$.<k>'), '￿')` (lexical; ISO dates sort correctly lexically)

`<k>` is the matched field's `key` — allow-listed, never raw request input. Build the path with Drizzle's `sql` parameter binding for the value where possible; the JSON path string is assembled from the validated key. Because the key already passed an equality match against a DB row, it cannot carry injection — but STILL assemble the path via a constant template + the validated key, and add a defensive `^[a-zA-Z0-9_]+$` assertion on field keys (fields are created through a validated route, so this is belt-and-suspenders).

**Numeric sentinel:** use a very large number (e.g. `9e18`) so numeric NULLs sort last in asc, mirroring the text sentinel. Apply identically in ORDER BY + keyset predicate + cursor value (cursor stores the coalesced string form).

**Cursor:** `decodeCursor` must stop rejecting non-built-in sortKeys. Change the guard from `!(sortKey in SORT_COLUMNS)` to just `!sortKey` (any non-empty key is structurally valid; the sort-key MATCH against the current request's `sortKey` already protects cross-sort replay, and field validity is re-checked each request). The keyset predicate reuses the same `sortExpr`-style expression for field keys.

**resolveSort** becomes async or takes the field list: cleanest is to resolve the field set INSIDE `listDocuments` (it has `db` + `activeTableId`), then pass a resolved `{ key, dir, expr }` down. Refactor `sortExpr` to take an optional field descriptor.

### Client — all columns clickable

`table-header.tsx`: drop the `SORTABLE_BUILTIN_KEYS` restriction — every column is `sortable`. Keep the drag-to-reorder (the button already carries both; dnd activation distance 5 means a click still fires onClick). The `onSort` already sends `{ key: column.key, dir }`; `column.key` for a field IS its frontmatter key, which the server now accepts.

## Task 1: Server — sort by validated, type-aware frontmatter fields

**Files:**
- Modify: `apps/server/src/services/documents.ts`
- Test: `apps/server/src/services/documents.sort.test.ts` (append)

- [ ] **Step 1: Write failing tests.** Append to `documents.sort.test.ts`. Seed work items with a numeric `priority` and a `due_date` (ISO) in frontmatter, plus one row MISSING each field (null). Tests:
  - `sort by priority asc orders numerically (2 before 10, not lexical)` — seed priorities 2, 10, 1; expect `[1,2,10]`.
  - `sort by due_date asc orders chronologically` — seed ISO dates; expect ascending.
  - `sort by a field with missing values keeps NULL rows last (asc) and drops none across a page boundary` — seed ≥2 rows missing the field spanning a page boundary (limit 2), page through, assert all ids round-trip (set size == total).
  - `sort by an unregistered key falls back to updated_at desc` — pass `sort: 'not_a_field'`, expect default order.
  Adapt seeding/field-registration to the harness (you must insert `fields` rows for `priority`(number) + `due_date`(date) on the seeded table so validation passes — check how the harness seeds fields, or insert directly).

- [ ] **Step 2:** `cd apps/server && bun test src/services/documents.sort.test.ts` — expect FAIL (field sorts ignored → fallback order).

- [ ] **Step 3: Implement.** In `documents.ts`:
  - Add a `FieldType`-ish import or a local numeric-type set: `const NUMERIC_FIELD_TYPES = new Set(['number','currency']);`
  - Add `const NUMERIC_NULL_SENTINEL = 9e18;`
  - Resolve the field set inside `listDocuments` BEFORE building the sort: when `opts.sort` is not a built-in and `activeTableId` is set, query `db.select({ key: fields.key, type: fields.type }).from(fields).where(and(eq(fields.tableId, activeTableId), eq(fields.key, opts.sort)))` (import `fields` from schema). If a row matches AND its key passes `/^[a-zA-Z0-9_]+$/`, treat it as a valid field sort; else fall back to `updated_at`.
  - Generalize `resolveSort` → return `{ key, dir, field?: { key: string; type: string } }`. (Since it now needs a DB lookup, either make it async + await it, or inline the resolution in `listDocuments` and keep `resolveSort` for built-ins only. Inlining is simplest — do that.)
  - Generalize `sortExpr` to accept either a built-in key or a field descriptor and return the right `SQL`:
    ```ts
    function fieldSortExpr(key: string, type: string): SQL {
      const path = `$.${key}`; // key already /^[a-zA-Z0-9_]+$/-validated + matched to a fields row
      if (NUMERIC_FIELD_TYPES.has(type)) {
        return sql`coalesce(cast(json_extract(${documents.frontmatter}, ${path}) as real), ${NUMERIC_NULL_SENTINEL})`;
      }
      return sql`coalesce(json_extract(${documents.frontmatter}, ${path}), ${NULL_SENTINEL})`;
    }
    ```
  - Use this expr in BOTH the ORDER BY and the keyset predicate (the non-updated_at branch already compares against an expr — route field sorts through the same branch).
  - Cursor encode for a field sort: `String(extracted ?? sentinel)` — for numeric, coalesce missing to `String(NUMERIC_NULL_SENTINEL)`; for text, `?? NULL_SENTINEL`. Read the value off the row's frontmatter JSON (`(last.frontmatter as Record<string, unknown>)[key]`).
  - Loosen `decodeCursor`: change `!(sortKey in SORT_COLUMNS)` guard to just require a non-empty `sortKey`.

- [ ] **Step 4:** `cd apps/server && bun test src/services/documents.sort.test.ts` — expect PASS (all, incl. prior built-in + NULL-status tests).

- [ ] **Step 5:** `cd apps/server && bun test` — full server suite green (was 990 pass / 1 skip). Then `bun x tsc --noEmit` from apps/server — clean.

- [ ] **Step 6: Commit:** `phase-3.x: sort by validated, type-aware frontmatter fields`

## Task 2: Client — make every column header sortable

**Files:**
- Modify: `apps/web/src/components/table/table-header.tsx`
- Test: `apps/web/src/components/table/table-view.test.tsx` (append)

- [ ] **Step 1: Write failing test.** Append to `table-view.test.tsx` (reuse the render harness; the seeded view shows a custom field column, e.g. `priority`). Assert clicking the field header calls the sort path / sets `?sort=priority`:
  ```tsx
  test('clicking a custom field header sorts by that field', async () => {
    /* render with a visible custom-field column (priority) */
    const header = await screen.findByRole('button', { name: /sort by priority/i });
    fireEvent.click(header);
    /* assert navigate/search updated to sort=priority dir=asc — match how existing
       sort tests in this file assert (they click titleHeader at :523/:866) */
  });
  ```
  Mirror the existing title-header sort test's assertion mechanism exactly.

- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/table/table-view.test.tsx` — expect FAIL (field header has no sort title/handler; currently `title={... Drag to reorder ...}` only).

- [ ] **Step 3: Implement.** In `table-header.tsx`, change the `sortable` computation (`:115-116`) to make all columns sortable:
  ```ts
  const sortable = true; // every column is sortable; field sort is validated server-side
  ```
  Remove the now-unused `SORTABLE_BUILTIN_KEYS` const and its `import`/usage if nothing else references it (grep first). The `onClick`, `title` (now always "Sort by …"), and arrow rendering already handle the general case.

- [ ] **Step 4:** `cd apps/web && npx vitest run src/components/table/table-view.test.tsx` — expect PASS.

- [ ] **Step 5:** `cd apps/web && npx vitest run` — full web suite green (was 652 pass / 8 skip). Then `bun x tsc --noEmit` from apps/web — clean. (Watch for any test that asserted a field header was NOT sortable — update it.)

- [ ] **Step 6: Commit:** `phase-3.x: make every table column header sortable`

## Task 3: Integration + holistic review

- [ ] **Step 1:** Full suite: `(cd apps/server && bun test)`, `(cd apps/web && npx vitest run)`, `(cd packages/shared && bun test)` — all green.
- [ ] **Step 2:** Dispatch a holistic reviewer on the two-commit diff, focused on: field-sort SQL injection (path assembled only from validated+matched keys), numeric vs lexical ordering correctness, NULL/missing-field keyset no-drop across pages (the highest risk, mirroring the status bug), and cursor cross-sort replay still ignored.
- [ ] **Step 3:** Fix any CRITICAL/IMPORTANT findings (TDD), re-verify.
- [ ] **Step 4:** Update `memory/STATE.md` (every column now sortable) and report for Stefan's browser QA.

## Self-review notes
- Spec coverage: server field sort → Task 1; client all-clickable → Task 2; verify → Task 3.
- Injection: json_extract path built from a key that (a) matched a `fields` row for the table and (b) passed `^[a-zA-Z0-9_]+$`. Value comparisons use bound params.
- NULL/missing handling reuses the proven coalesce-sentinel pattern (text `'￿'`, numeric `9e18`) applied identically in ORDER BY + keyset + cursor.
- Type consistency: `fieldSortExpr(key, type)` returns `SQL`, matching the existing `sortExpr` return type used by `orderBy`/keyset.
