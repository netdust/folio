# Views UX shake-out manifest — `fix/views-ux-shakeout`

Date: 2026-06-07. Driving the REAL UI in the browser (feature-acceptance, situation
B/C) against a fresh-reseeded DB (server :3001, Vite :5173, owner-logged-in, QA/Demo
project with the seeded `All work items` + `Board` views). Triggered by the user's
report: "issues with creating views — columns not shown, views duplicated."

## Acceptance flows (intended-use) + the six edge classes

| # | Flow | Edges to drive |
|---|------|----------------|
| F1 | Create a view (name → Create) | empty name; duplicate name; rapid double-submit (dup?); create from a filtered/sorted/column-tweaked table (capture); create Nth view (ordering) |
| F2 | Open / switch views | open a view with empty visibleFields (columns?); switch between views (state bleed?); the active-view URL `?view=` round-trip |
| F3 | View ordering in the rail | create several (stable order?); reload (persisted order?); drag-reorder views |
| F4 | Edit a view (rename, auto-save filters/columns) | rename; change filter/sort/columns → auto-saves to active view; does it bleed to other views |
| F5 | Delete a view | delete active view (where does it land?); delete the default; last view |
| F6 | Drag / reorder WORK ITEMS in a view | drag a row; reorder; (board) drag between columns |

## Verified so far (driven in browser)

### ❌ BUG V1 — new views are created with `order: 0` (collision)  [confirmed, DB + UI]
Creating "My Todos" then "In Progress Only" → BOTH get `order: 0`, same as the default
`All work items` (also `order: 0`). Three list views at `order: 0`. The rail sort is
`a.order - b.order` then `isDefault` tiebreak (`rail-tree.ts:83-86`) → among the three
custom-order-0 views the order is UNSTABLE (insertion / refetch dependent). This is the
likely root of the user's "views duplicated" perception: with optimistic-add + refetch
(`useCreateView` invalidates) racing, equal-order views re-sort inconsistently and look
like they jump / duplicate. ROOT: the create path doesn't assign a unique/incrementing
`order` (server default or `max(order)+10`). FIX TBD.

### ❌ BUG V2 — new view captures `visibleFields: []` (empty), not the current columns  [confirmed, DB]
The New-view sheet promises "Captures the current filters, sort, and columns." But a
created view persists `visibleFields: []` (empty array) — it does NOT capture the
table's current columns (the default view has the full 6-field list). Opening such a
view falls back to default columns in the table today (so not a literal blank table),
but the persisted state is wrong and the promise is broken — and an empty visibleFields
is the kind of value that renders "no columns" depending on the consumer. ROOT: the
sheet's create payload sends `visibleFields: []` / doesn't read the current view's
fields. FIX TBD.

### 🟡 BUG V3 — a freshly-created view is HIDDEN (discoverability)  [confirmed, UI]
After creating a view, it does NOT appear — because the rail TABLE node defaults to
COLLAPSED (`useExpanded(item.id, depth === 0)` — only depth-0/project auto-expands;
the table is depth-1). The user must expand the table chevron to see views. So a
just-created view "vanishes" → reads as "create didn't work." Candidate fix: auto-expand
the table node on view-create (or default table nodes expanded). FIX TBD.

## Still to drive
- F1 rapid double-submit (the literal duplication repro)
- F1 create-from-filtered-table (does it capture the filter?)
- F3 drag-reorder views
- F6 drag/reorder work items + board drag-between-columns
- F4 auto-save bleed; F5 delete-active-view landing

## More driven (2026-06-07 cont.)

### ✅ F6 board drag-to-regroup WORKS — NOT a bug (but UNTESTED e2e)
Dragging "Demo task 3" Todo→In Progress fired `PATCH .../demo-task-3 → 200` and the
status changed in the DB. (First attempt via an XPath selector didn't land — a CDP
drag-sim artifact, not a product bug; a coordinate-targeted drag worked.) **Gap, not
bug:** NO e2e exercises the actual drag interaction (only `resolveDrop` unit tests +
kanban per-column-create e2e). A real drag regression would ship silently — worth one
Playwright drag spec. List view has NO row-drag by design (sort-driven); only board
drags.

### ✅ List view has no row-reorder by design
`list-view.tsx` has no dnd — list ordering is sort-driven; manual drag is a board-only
affordance (`board_position`). If a user expects to drag list rows, there's no
affordance telling them it's board-only (minor UX gap, not a bug).

## ROOT CAUSES (source-confirmed) + fix directions

All three bugs root-caused at source. Drag works (false alarm); double-submit is
guarded (`new-view-sheet.tsx:97` disables on isPending) — so duplication = V1.

### V1 — `order: 0` collision  →  ROOT: `routes/views.ts:69` `order: input.order ?? 0`
The New-view sheet never sends `order`, so the server defaults it to 0 — colliding
with the default view + every other custom view. Unstable rail sort = the "duplication"
the user sees. **FIX:** in `POST /views`, when `order` is omitted, assign
`max(existing order for this table) + 10` (a `SELECT max(order)` in the same tx).
Server-side is the right home (atomic, no client race). ~5 lines.

### V2 — empty `visibleFields`  →  ROOT: `new-view-sheet.tsx:48` buildPayload omits it
`buildPayload()` returns `{name, type, filters, sort}` — NO `visibleFields`/`columnOrder`,
so the server stores `[]`. The sheet's promise "Captures the current … columns" is false.
**FIX (choose):** (a) the sheet reads the CURRENT view's `visibleFields`/`columnOrder`
(from the active view / `useViews`) and includes them in the payload — true "capture";
OR (b) server inherits the table's default view's `visibleFields` when omitted. (a) is
more faithful to the promise (captures YOUR current columns, not the default's). ~10 lines.

### V3 — created view hidden (table node collapsed)  →  ROOT: `rail-tree.tsx:33` `useExpanded(item.id, depth===0)`
Table nodes (depth 1) default collapsed, so a just-created view is invisible until you
expand the table → reads as "create failed." **FIX (choose):** (a) on view-create,
auto-expand the table node (set its `folio:rail-expanded:<id>` key / lift expand state);
OR (b) default table nodes to expanded. (a) is more surgical (only expands on the
relevant action). ~a few lines.

### Non-bugs (verified, do NOT "fix")
- Board drag-to-regroup works (PATCH fires, status changes).
- Double-submit is guarded.
- List view has no row-drag BY DESIGN (sort-driven).

### Test gaps worth closing alongside the fixes
- No e2e drives the actual board drag interaction (only unit `resolveDrop` + per-column-create).
- No test asserts a created view gets a unique `order` (V1 would've been caught).
- No test asserts the created view captures the current columns (V2 would've been caught).

## ✅ FIXED + VERIFIED LIVE (2026-06-07)

All 3 bugs fixed (RED→GREEN) + re-driven in the browser on the fix branch:
- **V1** `routes/views.ts`: omitted `order` → `max(order for table)+10`. Live: "Fixed View" got order=20 (not 0); unique orders, no collision. Test `views.test.ts` "POST … UNIQUE order".
- **V2** `new-view-sheet.tsx` + `w.$wslug.tsx`: sheet takes `currentColumns` (active view's visibleFields/columnOrder) and includes them. Live: "Fixed View" captured the full 6-field set (not []). Tests `new-view-sheet.test.tsx` capture + omit-when-none.
- **V3** `rail-tree.tsx`: `table:`-prefixed nodes default expanded. Live: created view is visible in the rail immediately (was hidden under a collapsed table). Test `rail-tree.test.tsx` "table:-prefixed node defaults EXPANDED".

Gates: server 1611/0, web 810/0 (+3 view tests), tsc x3 clean. The dryRun-parity
test was corrected (order is now state-dependent, excluded from the shape compare).

REMAINING (logged, not fixed): the test gaps (an e2e drag spec for board regroup;
the unique-order + column-capture regressions are NOW covered). Edges not yet driven:
create-from-filtered-table (V2 should capture filters too — already did per buildPayload),
drag-reorder VIEWS, delete-active-view landing, auto-save bleed between views — candidates
for a follow-up acceptance pass if more view UX work is wanted.

## ROUND 2 — `fix/views-ux-round2` (2026-06-07): the remaining edges

Drove the leftover F4/F5/F3 edges in the browser. The **auto-save bleed** edge surfaced
a real DATA-LOSS bug (V4) as a side effect — the others are clean.

### ❌ BUG V4 — toggling one column silently DESTROYS unpinned visible fields  [confirmed, DB + UI; FIXED]
**Repro (browser, View B):** View B's `visibleFields` =
`["title","status","priority","assignee","due_date","updated_at"]`. Open the Columns
picker → uncheck *Status* only → DB persists `["title","updated_at"]`. Three keys
(`priority`,`assignee`,`due_date`) vanished from one unrelated toggle.

**ROOT (`columns.ts` `effectiveVisibleKeys` + `mergeColumns`):** `allColumns` = built-ins
+ *pinned* Fields (the `fields` table). The `fields` table is **empty** in a normal
install — `priority`/`assignee`/`due_date` live only in document frontmatter, never pinned.
`effectiveVisibleKeys` **intersects** `visibleFields` down to `allColumns` keys → drops the
3 unpinned keys → the picker only ever sees the 3 built-ins. `ColumnPicker.toggle` then
recomputes from that already-truncated set and `onVisibilityChange` **persists the truncated
list**, permanently destroying the unpinned keys. Same root cause as the user's "columns are
not shown" report: an unpinned visible key has no Column → renders blank (`table-cell.tsx:98`
returns null without a `fieldType`) AND can't round-trip.

**FIX (`columns.ts` `mergeColumns` now takes `docs?`):** synthesize a `source:'field'` Column
for any `visibleFields` key that is (a) not already a built-in/pinned column AND (b) present
in the sampled docs' frontmatter — inferring its `fieldType` (reused `inferType` from
`column-suggestions.ts`) so the cell renders. A key absent from BOTH fields and data is a
genuinely deleted field → still dropped (existing `GONE`-drop test preserved). Wired
`page?.data` into the `allColumns` memo (`table-view.tsx:194`). **Live verify:** toggling
*Priority* off on View B now persists `["title","status","updated_at"]` (only priority
removed; status/title/updated_at preserved); View A UNCHANGED (no bleed). Tests:
`columns.test.ts` "synthetic columns for unpinned visible fields" (6 cases, RED→GREEN).

### ❌ BUG V4b — synthesized column ALSO appeared as a "Suggested from your data" row (duplicate)  [confirmed, UI; FIXED]
Once `priority` synthesized as a column, the picker's "Suggested from your data" section
STILL listed `priority` — a duplicate you could "pin" onto a key that's already a column.
`columnSuggestions` excludes only *pinned Fields*, not synthesized columns. **FIX
(`table-view.tsx:356`):** filter suggestions against `allColumns` keys (the real predicate is
"already a column", which now covers built-ins + pinned + synthesized). Live: priority no
longer appears as a suggestion once it's a column.

### ✅ F4 auto-save does NOT bleed across views — NOT a bug
Changing View B's columns auto-saves to View B's row only (gated on `?view=<id>` ===
`activeView.id`, `table-view.tsx:240/263/290/298`). View A / default / Board all stayed
byte-identical through the toggle. Confirmed in DB.

### ✅ F5 delete-active-view lands cleanly — NOT a bug
`w.$wslug.tsx:338-341` drops `?view=` on delete of the active view → TableView's
`activeView` fallback picks the default. (Source-confirmed; the seeded default is never
deletable-to-zero in this flow.)

### 🟡 F3 drag-reorder VIEWS — NO UI EXISTS (capability gap, not a bug)
`buildViewMenu` (rail) has only **Delete** — no reorder affordance, and the rail tree has no
view-level drag. Views order by `order` (now unique post-V1) but the user **cannot reorder
them** from the UI. Not a regression (never existed); flag for a product decision: do we want
view-reorder (drag in rail, or up/down in the `…` menu)? Deferred — needs user sign-off
before building an unprompted feature.

### Follow-up (logged, not fixed)
`newViewCurrentColumns` (`w.$wslug.tsx:177`) captures the active view's **raw** stored
`visibleFields`, not the `effectiveVisibleKeys`-resolved (data-backed) set — so a new view
can inherit stale dataless keys. Harmless now (V4 fix makes them round-trip if data exists,
drop cleanly if not), but capturing the *effective* set would birth new views cleaner. Minor.

## ✅ ROUND 2 FIXED + VERIFIED LIVE (2026-06-07)
- **V4** column data-loss: `columns.ts` synthesizes columns for data-backed unpinned visible
  keys; `table-view.tsx` feeds docs in. Live-verified no-loss + no-bleed.
- **V4b** suggestion duplicate: `table-view.tsx` filters suggestions by existing column keys.
Gates: web 816/0 (+6 synthetic-column cases), tsc clean. No import cycle (columns←suggestions
one-way). F4/F5 verified non-bugs; F3 view-reorder = a flagged capability gap (await user).
