# Board view — configurable grouping + in-column ordering — design

_2026-05-31. Second slice of the pre-Phase-4 UX round (after the TableView cleanup + sortable columns, merged to `main` at `eacc9bf`). Scope: the Board (kanban) view only._

## Context

The Board (`apps/web/src/components/views/kanban-view.tsx`) is hard-coded:
- **Grouping is always by `status`** — columns come from `useStatuses` (`kanban-view.tsx:67-77`). There's no way to group by assignee, priority, or any other field.
- **No in-column ordering** — cards render in the list's default `updated_at desc` order (`:21-24`); you can't sort within a column or hand-order cards. dnd is column→column only (drop on `col-<status>`, `:46-65`); there's no `SortableContext` and `documents` has no ordering column.

The `views` table **already has `groupBy text` ("field key for kanban grouping; defaults to status")** and a `sort json` column (`schema.ts`), and the client `View` type already exposes `groupBy: string | null` + `sort`. The board just ignores them. Server-side field sort (built-in + custom, type-aware, keyset-cursor) shipped in the prior slice and is reused here.

## Decisions (locked with Stefan, 2026-05-31)

- **Group-by:** board groups by a chosen field — status (default) or any groupable field (assignee/priority/select/text/boolean/number). Persisted in `views.groupBy`. Columns = distinct values (+ an "unset" column).
- **In-column ordering = BOTH:** field-sort (reuses the shipped server sort) is the active ordering when a sort field is chosen; **manual drag-order** is the fallback when sort = "Manual/None".
- **Manual order = ONE GLOBAL position.** A single new fractional-rank `board_position` column on `documents`. The same hand-order applies under any group-by.
- **Sort wins; manual is the default.** When `view.sort` names a field, columns order by it and **drag-to-reorder within a column is DISABLED** (cross-column drag to change group still works). Clearing the sort to "Manual" re-enables reorder.
- **Autosave gate:** group-by + sort persist to the view only when the user explicitly opened it via `?view=<id>` (same consent gate as the table's sort/columnOrder).
- Card-field picker is OUT of scope (cards keep their current chip set).

## Section 1 — Group-by any field

The board reads `activeView.groupBy` (default `'status'`).

- **`groupBy === 'status'`** (default / null): columns from the project `statuses` (current behavior; colored dots + "No status" parking lot preserved exactly).
- **`groupBy === <fieldKey>`**: columns are the field's values:
  - For a `select`-typed field: columns = the field's defined `options` (stable set even when a column is empty), in options order, + an "unset" column.
  - For other types (text/user_ref/boolean/number/etc.): columns = the distinct observed values across the loaded items, ordered (booleans `true`/`false`; numbers ascending; text alphabetical), + an "unset" column.
  - Grouping value read from `frontmatter[fieldKey]` (stringified for the column key; multi-value fields like `multi_select` are NOT groupable in v1 — exclude them from the group-by control).
- **Group-by control** on the board: a dropdown listing "Status" + each groupable field (from the table's `fields`, excluding `multi_select`). Selecting one PATCHes `view.groupBy` (autosave-gated on `?view=<id>`). With no `?view=`, the change is ad-hoc (URL/local state only).
- **Drag a card between columns** → sets the grouping value:
  - status group-by: PATCH `status = columnValue` (current behavior).
  - field group-by: PATCH `frontmatter[fieldKey] = columnValue`; dropping on "unset" clears it (sets the key to null/removes it).

## Section 2 — In-column ordering (field-sort + manual)

### Field-sort (active ordering when a sort is chosen)
- **Sort control** on the board: field (built-ins + custom, same set the table offers) + direction. Reuses the shipped server sort — the board's `useDocuments` call passes `sort`/`dir`, so items arrive pre-ordered and each column renders them in that order.
- Persisted in `view.sort` (autosave-gated). When a sort field is active, drag-reorder is disabled (see below).

### Manual order (fallback when sort = "Manual"/none)
- **New column on `documents`: `board_position TEXT`** — a fractional rank string (so a card can be inserted between two others without renumbering). Nullable; null = unranked.
- **Migration** adds the column. MUST update `apps/server/src/db/migrations/meta/_journal.json` (project rule — drizzle's `migrate()` silently skips files not in the journal). No backfill: null positions sort after ranked ones.
- **Ordering branch:** when manual mode is active, `listDocuments` orders by `board_position asc NULLS LAST`, tiebreak `updated_at desc, id`. Implemented as a new sort key (e.g. `sort: 'board_position'`) routed through the existing keyset machinery. `board_position` is **nullable text** — so it MUST follow the keyset-affinity discipline from the prior slice: coalesce null to the high sentinel `'￿'` and use consistent text affinity across ORDER BY + keyset predicate + cursor-encode (see `feedback_keyset-cursor-affinity`). A fractional-rank scheme that emits fixed-width comparable strings keeps text ordering correct.
- **Fractional rank generation:** between neighbors `a` and `b`, generate a string strictly between them (e.g. a base-N midpoint, or the `fractional-indexing` approach). At list ends, generate before the first / after the last. Keep it a small pure helper (`board-rank.ts`) with its own unit tests (midpoint, before-first, after-last, adjacent-keys-need-extra-digit).
- **Drag-to-reorder within a column:** each column becomes a `SortableContext`; cards use `useSortable`. On drop at index *i*, compute a rank between the neighbors' `board_position` and PATCH `board_position` on the dragged item only (one row per drag).
- **Cross-column drag** (Section 1) also computes a `board_position` for the drop slot, so a regrouped card lands where dropped.

### Sort wins; manual is default
- If `view.sort` names a field → columns order by it and **within-column drag-reorder is disabled**. Cross-column drag (change group) still works. Show a subtle affordance: "Sorted by <field> — clear to reorder". Selecting "Manual" in the sort control clears `view.sort` and re-enables reorder.

## Section 3 — Card fields, edge cases, testing

**Card content:** unchanged chip set (priority + due_date). The grouping field IS the column, so no per-card picker this round (out of scope, named below).

**Edge cases handled:**
- High-cardinality group-by (e.g. free-text assignee, 50 values) → 50 columns, ordered alphabetically. No artificial cap in v1; note "wide boards" inline.
- Boolean/number group-by → distinct-values path yields `true`/`false` / distinct numbers + unset.
- `board_position` tie under concurrent drags → last-write-wins (single-user assumption per locked decisions); rare tie falls back to `updated_at`/`id`.

**Testing (TDD):**
- _Server:_ migration applies + journal updated (assert the column exists post-migrate); `listDocuments` manual order = `board_position asc, nulls last, updated_at desc, id`; **keyset pagination under manual order drops/dupes nothing with a mix of ranked + null rows across a page boundary** (the affinity regression); group-by-field returns correct buckets incl. unset; cross-column drag patches status (status group) vs `frontmatter[field]` (field group). `board-rank.ts` pure-helper unit tests.
- _Web:_ group-by control switches columns + persists `groupBy` (gated on `?view=`); sort control persists `sort`; drag between columns patches the right field; drag within column (manual) patches `board_position`; **within-column reorder disabled when a sort is active**; columns render in computed order; select-field columns use options order.

**Out of scope (named, not silently dropped):**
- Per-card field picker (which fields show on a card).
- Per-grouping saved order (we chose ONE global `board_position`).
- High-cardinality column capping / virtualization.
- Real-time multi-user board sync (single-writer LWW per locked decisions).
- `multi_select` as a group-by field.

**Rollout:** branch `phase-3.x/board-view`; atomic commit per coherent unit; `bun test` (server/shared) + `npx vitest run` (web) green before each commit; holistic whole-diff review **primed on the `board_position` nullable-text keyset-affinity trap**; then merge on Stefan's OK after browser QA.

## Acceptance

- A group-by control changes the board's columns to status (default) or any chosen field; the choice persists to the view.
- Within a column, choosing a sort field orders cards by it (asc/desc); choosing "Manual" lets you drag cards into a hand-order that persists (one global `board_position`).
- Drag-reorder is disabled while a field-sort is active; cross-column drag (regroup) always works.
- Manual order survives a group-by change and pagination (no dropped/duped cards).
- Existing status board behavior (colored dots, "No status" lot, create-in-column, optimistic status drag) is unchanged when `groupBy = status` and no manual reorder is used.
