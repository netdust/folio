# Phase 6 — Views Rework Plan (2026-06-17)

> Branch `phase-6/views` (continuing). Corrects the Phase-6 views after Stefan's screenshot-grounded review. **Gallery (old Cluster 6) is HELD** until this lands. Delivered as **2 review clusters** (Chunk A → gate → Chunk B → gate).

**Why:** after Clusters 1–5, three things are wrong/missing:
1. The `list` view renders composed CARDS — but it should be the **TableView/spreadsheet WITH group-by** (aligned columns + collapsible group sections + group-header rows carrying the per-group aggregates inline). The Cluster-2a group-summary endpoint already computes the aggregates correctly; only the RENDERER is wrong.
2. **No view is filterable** (table/list/kanban/calendar/timeline). Every view needs a filter.
3. **Only kanban has inline settings** (BoardControls). Every view needs its own controls.

## Locked decisions (Stefan, 2026-06-17)
- **D1: `list` = grouped TableView.** Reuse `TableHeader`/`TableRow`/`columns.ts` (already separate, reusable components — Stage-1c verified); insert group-header rows between groups; the header carries the aggregates from `useGroupSummary`. NOT cards.
- **D2: per-view controls** (one component per type, like `BoardControls`). All get the filter.
- **D3: server-side `?filter=`** reused across all views (the M3 path table + group-summary already use). NOT client-side (page-2 bug).
- **D4: sequence** Chunk A (rebuild list) FIRST → gate → Chunk B (filter + controls) → gate.

## Classification & gates (harnessed-development)
- **Class A** — multi-task feature rework. Stage-0 brainstorm DONE (the 4 decisions). Stage-1 plan = this doc.
- **1a threat-model: NOT FIRED.** No new server surface — the `?filter=` path + group-summary endpoint already exist and are hardened (Cluster 2a FULL review). Filter reuse is the EXISTING `filterCompile`/`compileFilterToWhere` with its caps. Controls write `settings`/`sort`/`groupBy` to the VIEW via the tested `useUpdateView` (invariant 16) or `?filter=` to the URL. No untrusted-parse→SQL surface added.
- **1b architecture-invariants: invariant 16** (view-owned config: group-by/sort/filter/settings → the VIEW via useUpdateView; the date stays on the DOCUMENT) + **invariant 18** (the ViewRouter renderer map — unchanged; we rebuild a renderer's internals, not the map). **invariant 4a** unchanged (filter rides the existing scoped read path).
- **1g feature-acceptance: FIRED** — both chunks are user-facing. Acceptance flows below; DRIVEN at each gate via the real browser (the dev server + a seeded grouped dataset, as in the Cluster-2b browser pass).
- **1f/1h: 2 review clusters, both STANDARD** (UI features consuming hardened endpoints; no 1a surface). One-way escalation if a finding touches a 1a surface.

## Architecture invariants touched
- **Invariant 16 (view-owned config):** the filter, group-by, sort, and per-view settings all persist to the ACTIVE VIEW via `useUpdateView` (or the URL `?filter=` for transient filter state) — NEVER the document. The ONLY document write in these views is the calendar/timeline date drag (already shipped, already invariant-16-correct). A control that writes a document attribute is a bug.
- **Invariant 18 (renderer convergence):** unchanged. We rebuild `GroupedListView`'s internals; the `viewRendererFor` map still routes `list → GroupedListView`. No second `switch(view.type)`.

---

# CHUNK A — Rebuild `list` as a grouped TableView (STANDARD)

> Replace the card renderer with a grouped table. Reuse TableView's `TableHeader`/`TableRow`/`columns.ts`. The group-header row carries the aggregates from the (already-built, already-hardened) `useGroupSummary`.

### Task A.1: `group-header-row.tsx` — the group section header (Tier B + 1 Tier-A slice)
**Files:** Create `apps/web/src/components/views/group-header-row.tsx` + test.
- A row spanning the table columns: a left cell with the group label (`<GroupByLabel> · <value> · N items`) + a collapse chevron, and the aggregates rendered on the RIGHT (reuse `GroupAggregateHeader`/`DistributionBar` from Cluster 2b — those are correct, keep them). Takes `{ groupValue, count, aggregates, collapsed, onToggle, colSpan }`.
- **Tier-A slice:** the count + aggregates come from the `useGroupSummary` row (full-set), NOT a client count of loaded rows (the page-2 guard, preserved from Cluster 2b). Assert header shows the endpoint count even when fewer rows are loaded.
- Tier B for the rest (presentational). Test: renders label + count + an aggregate + the distribution bar; collapse toggle fires `onToggle`.

### Task A.2: make TableView GROUP-AWARE; route `list` → grouped TableView (Tier B + Tier-A slice)
**ARCHITECTURE REVISION (Stefan, 2026-06-17):** rather than rebuild a parallel `GroupedListView` (which would DUPLICATE TableView's ~150 lines of inline-edit / relations / create / column-menu / onUpdate wiring), make **TableView itself group-aware**. One renderer; inline-edit + relations + column-menu work in the grouped view for free; zero duplication.

**Files:** Modify `apps/web/src/components/table/table-view.tsx`; modify `apps/web/src/components/views/view-router.tsx` (route `list` → TableView with grouping); DELETE `apps/web/src/components/views/grouped-list-view.tsx` + `grouped-list-row.tsx` (the card renderer) + their tests; keep `group-aggregate-header.tsx`/`distribution-bar.tsx` (reused by A.1's GroupHeaderRow); update `view-router.test.tsx`.

- **Grouping trigger:** TableView reads `activeView` (line 152). When `activeView.type === 'list'` AND a groupBy is configured (`settings.groupBy`, default `'status'`), grouping is ON; `type === 'table'` → flat (today's behavior, unchanged).
- **Grouped render:** replace the `filteredDocs.map(TableRow)` block (line ~560) — when grouping, partition `filteredDocs` by each row's `groupBy` value (client-side PLACEMENT only), and render: for each group (ordered by the `useGroupSummary` group order) a `<GroupHeaderRow>` (A.1) carrying the group's count + aggregates FROM `useGroupSummary` (full-set — the page-2 guard), then that group's `TableRow`s; the `ungrouped` bucket last; collapse/expand per group (local `Set<string>` state). When NOT grouping, the existing flat map is unchanged.
- **The aggregates:** `useGroupSummary(wslug, pslug, tslug, { groupBy, aggregates, filter })` — read `aggregates` from `settings.aggregates` (default `[{op:'count'}]`); pass the SAME `listParams.filter` so headers + rows stay consistent. Only call it when grouping is on (`enabled`).
- `TableHeader` stays at the top (one set of column headers for the whole grouped table). `TableAddRow` + "Load more" stay (Load more already exists in TableView).
- **Tier-A slice (the page-2 guard, preserved):** with N loaded rows in a group but a `useGroupSummary` count of M (M>N), the GroupHeaderRow shows M (endpoint full-set), never N. Assert it.
- **Test (table-view.test.tsx):** the EXISTING flat-table tests stay green (grouping OFF for `type:'table'`). Add: a `type:'list'` active view with a groupBy → renders GroupHeaderRows + grouped TableRows + the page-2 guard + collapse. The existing grouped-list-view.test.tsx is deleted (its renderer is gone); its meaningful assertions (page-2 guard, no-group bucket, summary-error) migrate into the table-view grouped tests.
- **Router:** `viewRendererFor.list` = `(p) => <TableView {...p} />` (TableView decides grouping from the active view's type). Remove the `GroupedListView` import. The `view-router.test.tsx` `list → ...` assertion updates to expect the TableView marker (or a grouped-table marker).

### Task A.3: row-layout config cleanup
**Files:** `apps/web/src/components/views/grouped-list-config.tsx` (the new-view config).
- The grouped TABLE uses the table's columns (visibleFields), NOT the card `rowLayout`. So the config's `rowLayout` picker (primary/subtitle/fields) is now meaningless for a table. Keep group-by + the aggregate builder (those still apply); REMOVE the rowLayout picker (or repurpose to "visible columns" — but the table already has a column picker, so just remove rowLayout from the list config). Update `GroupedListSettings` if `rowLayout` is dropped (keep it optional for back-compat; the renderer ignores it). Update the config test.

**Integration gate (Chunk A):** full web suite + tsc. **Browser feature-acceptance:** seed a grouped dataset (as in the Cluster-2b pass), create a `list` view grouped by status, see ALIGNED COLUMNS with group-header rows carrying the aggregates on the right; header count = full-set; collapse a group; Load more reaches other groups.

## Acceptance flows — Chunk A (grouped table, browser)
| Flow | Empty | Wrong-order/re-entry | Concurrent/double | Boundary | Mid-flow failure |
|---|---|---|---|---|---|
| **Render grouped table** | 0 docs → EmptyState (no empty group shells) | change group-by → re-groups, columns stable | two tabs, one edits a cell → both reflect after refetch | 247 rows paginated → group HEADER totals = full set, rows page-1 + Load more | useGroupSummary errors → header error affordance, rows still render |
| **Collapse/expand** | — | collapse all then expand → state correct | — | a group with 1 item collapses cleanly | — |

`── REVIEW GATE ── (STANDARD)` **STOP. 2 finders + simplicity + browser feature-acceptance (the grouped-table shape vs the screenshot). Stefan sign-off.**

---

# CHUNK B — ONE unified ViewControls (filter + per-type settings) for every view (STANDARD)

> **ARCHITECTURE (Stefan, 2026-06-17): "use the same system as the board — board had everything, settings + filter."** Build ONE `ViewControls` component (the board's `BoardControls` model GENERALIZED), mounted ONCE in the project header for EVERY view type. SAME component / SAME look / SAME source for the filter on all views; the SETTINGS + FILTER VALUES are PER-VIEW (saved on the active view, loaded on view-switch).

**Decisions (Stefan, 2026-06-17):**
- (D-B1) ONE `ViewControls` — shared `FilterBar` (same component+look everywhere) + a `switch(view.type)` settings slot. Mounted once in `w.$wslug.p.$pslug.tsx`'s `tabs` slot, REPLACING the kanban-only `BoardControls` conditional, for ALL view types.
- (D-B2) FilterBar on ALL views (calendar + timeline included).
- (D-B3) **Filter is PER-VIEW and SAVED on the view** (`view.filters` via `useUpdateView`), exactly like the board persists group-by/sort. Switch saved views → that view's own filter + settings load. NOT URL-transient.

**KEY GROUND-TRUTH (controller, 2026-06-17) — most of this is ALREADY HALF-BUILT:**
- `FilterBar({ clauses, statuses, pinnedFields, onChange })` (`components/filter/filter-bar.tsx`) EXISTS, used by TableView. Speaks `FilterClauseUrl[]`.
- TableView ALREADY **hydrates the URL filter FROM `activeView.filters` once per view** (`table-view.tsx:209-251`, the `hydratedViewId` ref + the FILTER_KEYS merge, URL-wins precedence) — its own comment says "*until they explicitly save filters back to the view (Task 8)*". So loading a view's saved filter already works for table/list; **the UNBUILT piece is the save-back ("Task 8")** — FilterBar's `onChange` writes only the URL today, not `view.filters`.
- `BoardControls` (`components/kanban/board-controls.tsx`) is the live-edit pattern: resolves activeView, renders settings pickers, persists to the view via `useUpdateView`.
- `view.filters` is the saved per-view filter (populated at create by the new-view sheet); `view.settings`/`groupBy`/`sort` are the per-view settings.
- B.2 (committed `6ff7a651`) built `ListControls` + a shared `AggregateBuilder` — these become the `list` settings slot inside ViewControls (reused, not wasted).
- DEAD CODE deleted in B.1 (`333af2a8`): the old `list-view.tsx` + 3 tests.

### Task B.6: `ViewControls` — the unified toolbar (filter + per-type settings + save-back)
**Files:** Create `apps/web/src/components/views/view-controls.tsx` + test. Modify `w.$wslug.p.$pslug.tsx` (mount it for every view, replacing the kanban-only `BoardControls` line). Move the hydrate-from-view filter logic to a shared hook so ALL views (not just TableView) load their saved filter. Re-home `ListControls`/`BoardControls`/zoom as the per-type settings slots.
- **Shared FilterBar** (same component+look): `ViewControls` resolves `activeView`, renders `<FilterBar clauses={...} statuses={useStatuses} pinnedFields={useFields} onChange={onFilterChange} />`. `onFilterChange` does BOTH: writes the URL search (live render) AND persists the clauses to `view.filters` via `useUpdateView` (the "Task 8" save-back — so the filter is per-view-saved). Reuse the FILTER_KEYS clause↔filters mapping that the hydration block already uses (clauses → the `{status,priority,...}` shape stored in `view.filters`).
- **Hydrate-on-switch for ALL views:** extract TableView's `hydratedViewId`/`activeView.filters`→URL effect into a shared `useViewFilterHydration(activeView)` hook; ViewControls (or the route) runs it so switching to ANY view loads that view's saved filter. (TableView keeps working; calendar/timeline/kanban gain it.)
- **Per-type settings slot** — `switch(activeView.type)`:
  - `kanban` → the existing `BoardControls` content (group-by + sort via BoardToolbar) — re-home it as the kanban slot.
  - `list` → the B.2 `ListControls` content (group-by + AggregateBuilder) — re-home as the list slot.
  - `table` → no extra settings (columns/sort already in TableHeader) — filter only.
  - `calendar` → a date-field `<select>` → `useUpdateView` `settings.dateField`.
  - `timeline` → zoom toggle (move from TimelineView) + start/end date-field selects → `settings.{zoom,startField,endField}`.
- **Mount:** in `w.$wslug.p.$pslug.tsx`, replace `activeView?.type === 'kanban' ? <BoardControls/> : null` with `activeView ? <ViewControls wslug pslug tslug/> : null` — one mount, every view.
- **Each renderer drops its own filter/zoom toolbar bits** (timeline's zoom moves into ViewControls; calendar/kanban/list don't add their own — ViewControls owns the toolbar). The renderers just read the active filter (from the URL, hydrated) + settings and render.
- **Tier-A slices (invariant 16):** (1) a FILTER change persists to `view.filters` via `useUpdateView` (PATCH `/views/:id`), NEVER a document; (2) each SETTINGS change persists to the VIEW (`settings`/`groupBy`/`sort`), NEVER a document; (3) the filter clauses feed the active view's `useDocuments`/`useInfiniteDocuments`/`useGroupSummary` so the view's items narrow.
- **Step 2.5 (controller, at dispatch):** the hydration block is `table-view.tsx:209-251`; extract it carefully (URL-wins precedence, the `$eq`/`$in` AST handling, the FILTER_KEYS set) so the save-back is its inverse. Confirm FilterBar's `onChange(next: FilterClauseUrl[])` shape + the clause→search serialization (find it near TableView's `onClauseChange`).

### Task B.3: wire the filter through every renderer's data hooks
**Files:** the 5 renderers.
- Each renderer reads the active filter (from `?filter=` / the ViewFilterBar) and passes it to its `useDocuments`/`useInfiniteDocuments` AND (for list) `useGroupSummary`. The table already does this (M3); extend to kanban/calendar/timeline/list. So filtering narrows EVERY view's rows (and the list's aggregates) consistently.

**Integration gate (Chunk B):** full web suite + tsc. **Browser feature-acceptance:** on EACH view type, apply a filter → rows narrow (and list aggregates recompute); change a per-view setting (group-by/date-field/zoom) → persists on reload; confirm no document write fires for a settings/filter change (invariant 16).

## Acceptance flows — Chunk B (filter + controls, browser)
| Flow | Empty | Wrong-order/re-entry | Concurrent/double | Boundary | Mid-flow failure |
|---|---|---|---|---|---|
| **Filter any view** | filter matches 0 → empty state, not stale rows | add then clear filter → full set returns | two filter edits race → last applied | a filter on a frontmatter key with no values → empty, no crash | bad filter → server 422 → toast, prior rows kept |
| **Change a view setting** | — | change group-by then back → re-groups both times | rapid setting toggles → last persists to the VIEW | — | useUpdateView fails → toast + rollback |
| **Invariant 16** | — | — | — | — | a settings/filter change writes the VIEW (`/views/:id`), NEVER a document |

`── REVIEW GATE ── (STANDARD)` **STOP. 2 finders + simplicity + invariant-auditor (filter/settings → view, not document) + browser feature-acceptance (filter + controls on all 5 views). Stefan sign-off.**

---

## After this rework
- Cluster 6 (gallery + G3) resumes — gallery reuses the image-field safe-URL guard (Cluster 3) + gets the ViewFilterBar.
- Then Stage-3 spec-close shake-out over the whole `phase-6/views` branch + finish-branch.
