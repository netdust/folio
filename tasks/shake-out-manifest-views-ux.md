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
