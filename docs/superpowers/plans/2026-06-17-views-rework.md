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

### Task A.2: rebuild `GroupedListView` as a grouped table (Tier B shell)
**Files:** Rewrite `apps/web/src/components/views/grouped-list-view.tsx`; update its test. Keep `group-aggregate-header.tsx`/`distribution-bar.tsx` (reused by A.1). DELETE `grouped-list-row.tsx` (the card row — replaced by `TableRow`).
- Reuse TableView's column derivation: import `mergeColumns`/`effectiveVisibleKeys`/`Column` from `'../table/columns.ts'`, `TableHeader` from `'../table/table-header.tsx'`, `TableRow` from `'../table/table-row.tsx'`. Build `visibleColumns` the same way TableView does (Stage-2.5: read TableView lines ~420-460 for the exact derivation + the deps TableRow needs: `statuses`, `resolveRelation`, `onOpen`, `onUpdate`).
- Render: ONE `TableHeader` (the column headers) at the top, then for each `useGroupSummary` group → a `<GroupHeaderRow>` (A.1) + that group's loaded `TableRow`s (the rows whose `groupBy` value matches — client-side PLACEMENT only, like Cluster 2b). The `ungrouped` bucket last. Collapse/expand per group (local state).
- Rows come from `useInfiniteDocuments` (full pagination, kept from Cluster 2b) + "Load more". Headers from `useGroupSummary` (full-set). The SAME filter feeds both.
- EmptyState / skeleton / summary-error affordance (kept from Cluster 2b's fixes).
- **Test:** renders TableHeader + a group-header row per group + TableRows under each + the no-group bucket + the page-2 header-total guard (header count = endpoint, not loaded rows) + EmptyState. Mock the hooks like the current test.

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

# CHUNK B — Filter + per-view controls on every view (STANDARD)

> Every view gets a filter (server `?filter=`) + its own controls component (like BoardControls). Filter is universal; settings are per-view.

### Task B.1: `ViewFilterBar` — shared filter control (Tier A)
**Files:** Create `apps/web/src/components/views/view-filter-bar.tsx` + test.
- A filter control that reads/writes the URL `?filter=` (the existing `tableSearchSchema` already carries filter keys: status/priority/labels/assignee/updated_since + the generic frontmatter `filter=`). It offers add/remove filter conditions (field + operator + value), serializes to the `?filter=` param the server reads (the M3 path). Reuse the existing filter compiler's operator set (`@folio/shared` `OPERATORS`) so the UI can't build an op the server rejects (sibling-site, like the aggregate whitelist).
- **Tier-A slice:** a filter condition serializes to the exact `?filter=<JSON>` the server's `filterCompile` reads; the same filter object feeds `useDocuments`/`useInfiniteDocuments` AND `useGroupSummary` so rows + aggregates stay consistent. Assert the serialization round-trips.
- **Step 2.5 (controller, at dispatch):** ground-truth the EXACT current filter surface — how `tableSearchSchema` carries filter keys, how TableView already reads `?filter=` (M3's `useInfiniteDocuments(... params.filter)`), and the `OPERATORS` export — so the bar writes the format the server already accepts. (The table ALREADY filters via M3; this surfaces a UI for it + extends it to the other views.)

### Task B.2: per-view controls components (Tier B shells + Tier-A persistence slices)
**Files:** Create `table-controls.tsx`, `calendar-controls.tsx`, `timeline-controls.tsx`, `list-controls.tsx` (or fold list's into grouped-list-config); each renders `<ViewFilterBar>` + its view-specific settings. Wire each into its renderer's toolbar slot.
- **table** → ViewFilterBar + sort (TableHeader already does column sort; the controls add the filter; sort persists to `settings`/`sort` via useUpdateView — already wired).
- **list** → ViewFilterBar + group-by picker + aggregate builder (reuse `GroupedListConfig`'s group-by/aggregate UI as an EDIT affordance on the active view, persisting to `settings` via useUpdateView). 
- **calendar** → ViewFilterBar + date-field picker (persists `settings.dateField` via useUpdateView).
- **timeline** → ViewFilterBar + the zoom toggle (already exists in TimelineView — move/keep) + start/end date-field pickers (persist `settings.{startField,endField}`).
- **kanban** → BoardControls EXISTS; just add `<ViewFilterBar>` to it.
- **Tier-A slice per control:** the settings write targets the VIEW (`useUpdateView`, `settings`/`sort`/`groupBy`), NEVER the document (invariant 16). Assert each control's persist hits `/views/:id`, not `/documents/`.
- Each renderer renders its controls in a toolbar above the content. (Decide: the toolbar lives in each renderer, OR ViewRouter renders a controls slot — per D2 "per-view controls", each renderer owns its controls; the shared ViewFilterBar is the common piece they all include.)

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
