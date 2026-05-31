# TableView UX cleanup — design

_2026-05-31. First slice of the pre-Phase-4 "serious UX cleaning" round. Scope: the work-items TableView only. Time-aware views (timeline + This Week dashboard) are the next, separate slice and are out of scope here._

## Context

`main` at `9a30322` (Phase 3 merged). The TableView (`apps/web/src/components/table/`) is the primary human surface for work items. Three concrete defects/asks, all confirmed against source:

1. **Sort is fully non-functional.** The client sends `sort`/`dir` URL params (`table-view.tsx:235` `onSortChange`), but the server route (`apps/server/src/routes/documents.ts:130`) never reads them, and `listDocuments` (`apps/server/src/services/documents.ts:250`) hard-codes `.orderBy(desc(documents.updatedAt), desc(documents.id))`. Clicking a header changes the URL and re-fetches, but the order never changes. Additionally, only `title`/`status`/`updated_at` headers are clickable (`table-header.tsx:15` `SORTABLE_BUILTIN_KEYS`) — custom field columns have no sort affordance.

2. **No pinned right-most column.** The column-picker (Settings2 icon) lives in a top bar next to the FilterBar (`table-view.tsx:404`). The ask: pin it as a fixed right-most column header, mirroring the sticky-left title column, with empty body cells underneath (see reference screenshot in the originating conversation).

3. **Project tab bar is wrong.** `TABS = [Work items, Board, Wiki]` (`w.$wslug.p.$pslug.tsx:18`), plain text. Work items + Board are *views* (the real view system lands in a later phase) and should get icons; Wiki should not be a top tab — it already exists as a left-rail node (`onWikiClick`/`isWiki` in `w.$wslug.tsx`).

## Decisions (locked with Stefan, 2026-05-31)

- **Sort:** server-side, **built-ins only** (`title`, `status`, `updated_at`). Custom-field sort deferred; their headers stay non-clickable (no false affordance). Default order unchanged: `updated_at desc`.
- **Wiki:** removed from the top tab bar. Stays reachable as the existing rail node (no rail change needed — it's already wired).
- **Pinned last column:** column-settings only. Header = sliders/settings icon (opens existing ColumnPicker popover). Row cells empty. `+ Add column` stays as the header `trailing` affordance, sitting just left of the pinned settings column.

## Section 1 — Server-side sort (built-ins only)

**Route** (`apps/server/src/routes/documents.ts`, list handler ~line 130):
- Read `sort = c.req.query('sort')` and `dir = c.req.query('dir')`.
- Validate against an allow-list: `sort ∈ {title, status, updated_at}`, `dir ∈ {asc, desc}`. Anything else → ignore both, fall back to default (`updated_at desc`). No error thrown for unknown keys — silent fallback (the UI only ever sends valid built-ins, but the API must not break on stale links).
- Pass `sort`/`dir` into `listDocuments`.

**Service** (`apps/server/src/services/documents.ts`, `listDocuments`):
- Accept optional `sort`/`dir`. Map `sort` to a Drizzle column: `title → documents.title`, `status → documents.status`, `updated_at → documents.updatedAt`. `dir` picks `asc`/`desc`.
- Default (no/invalid sort) = `updated_at desc` (current behavior, byte-for-byte).
- **Keyset cursor must follow the active sort.** The current cursor encodes `updatedAt:id` and the WHERE/ORDER BY are built around `updatedAt`. Generalize so the keyset predicate + ORDER BY + cursor all key off `(sortColumn, id)`:
  - ORDER BY `<sortColumn> <dir>, documents.id <dir>` (id tiebreak follows the same direction so the keyset comparison is monotonic).
  - Cursor encodes `(sortValue, id)` where `sortValue` is the sort column's value of the last row. For `updated_at` that's the epoch ms (current scheme); for `title`/`status` it's the string.
  - Keyset predicate for `asc`: `(col > v) OR (col = v AND id > lastId)`; for `desc`: the `<` mirror. This preserves the existing no-drop/no-dupe guarantee under any of the three sorts.
  - Encode the active sort key into the cursor (or re-derive it from the request) so a cursor minted under one sort isn't misread under another. Simplest: include the sort key in the cursor payload and, on decode, if it disagrees with the current request's sort, treat the cursor as absent (start from page 1). Document this.

**Client:** no change needed — `table-view.tsx` already sends `sort`/`dir`; `table-header.tsx` already gates clickability to the three built-ins.

### Threat / correctness notes (Section 1)
- The sort column is **never** interpolated from user input — it's selected from a fixed allow-list mapping string → Drizzle column object. No SQL injection surface.
- The risky spot is pagination correctness, not security: a keyset cursor that doesn't match the ORDER BY drops or duplicates rows silently. Covered by the cross-boundary pagination test below.

## Section 2 — Pinned right-most settings column

**Layout-only slot, not a data-model `Column`.** Rendered after the visible columns in both `TableHeader` and `TableRow`.

- Fixed width ~44px. Add the trailing width to the grid template so header and body rows stay aligned on horizontal scroll. `gridTemplate(columns)` in `columns.ts` gains an explicit trailing track (e.g. append `44px`), OR the pinned slot is rendered outside the grid as a sibling sticky element — implementer picks whichever keeps header/row alignment simplest; the existing sticky-left title cell is the pattern to mirror.
- `position: sticky; right: 0; z-[1]`, left border (`border-l border-border-light`), `bg-content` background (so rows scrolling under it don't bleed through — same treatment as the sticky-left cell).
- **Header cell** hosts the `ColumnPicker` trigger (Settings2 icon).
- **Row cells** render empty (just the sticky background slot).
- Move `ColumnPicker` out of the top bar (`table-view.tsx:404`); `FilterBar` then sits alone on the left of that row.
- `+ Add column` (`TableAddColumn`) stays as the header `trailing` slot, positioned just left of the pinned settings column. Visual order: `…last data column → + Add column → │ ⚙ (pinned)`.

## Section 3 — Project tab bar (icons + remove Wiki)

`apps/web/src/routes/w.$wslug.p.$pslug.tsx`:
- `TABS` becomes `[Work items, Board]` (drop Wiki).
- `FrameTab` (`components/shell/main-frame.tsx`) gains an optional leading `icon` prop (lucide line-icon, matching the cockpit tab-icon style from `2f94fe2`).
  - Work items → `List`
  - Board → `Columns3`
- `onCreate`: drop the `activeTab === 'wiki'` branch (Wiki no longer a top tab; the Wiki route owns its own create affordance). Always create a `work_item`; `actionLabel` is always "New work item".
- Wiki route stays mounted and reachable via the rail node — no route deletion.

## Section 4 — Testing & scope

**Tests (write first, TDD):**
- _Server sort_ (`services/documents.ts` unit): each built-in × asc/desc returns correct order; invalid sort key falls back to `updated_at desc`; **keyset pagination across a cursor boundary under a non-default sort drops no rows and dupes none** (seed > one page, page through, assert the full set is exactly the sorted set with no gaps/repeats). Route test: `sort`/`dir` query params reach the service and shape the response order.
- _Pinned column_ (web render): a sticky right column with the settings trigger exists; row cells render the trailing empty slot; grid template / layout includes the trailing width; ColumnPicker popover opens from its new home; FilterBar no longer shares its row with the picker.
- _Tab bar_ (web render): only Work items + Board tabs, each with an icon; no Wiki tab. (Existing rail test already covers `onWikiClick` reachability.)

**Out of scope (named, not silently dropped):**
- Custom frontmatter-field sorting (headers stay non-clickable).
- Per-row action menu in the pinned column (settings-only chosen).
- The full view system (Work items/Board as real saved-view render modes — later phase).
- Time-aware views (timeline + This Week dashboard) — the next, separate UX slice.

**Rollout:** branch off `main` (`phase-3.x/tableview-ux`), atomic commit per section, `bun test` green before each commit, shake-out pass in the browser (sort + pinned column + tabs) before merge.

## Acceptance

- Clicking the Title / Status / Updated header re-orders rows correctly (asc → desc → off), and the order is honored across pagination.
- Custom-field headers are not clickable for sort (no false affordance).
- The settings icon is a fixed right-most column header; rows have an empty cell beneath it; it stays pinned on horizontal scroll. `+ Add column` sits just left of it.
- The project top bar shows Work items + Board (with icons) and no Wiki tab; Wiki is reachable from the rail.
- All existing TableView behavior (inline edit, filters, column reorder/visibility, add row/column) still works.
