# View Column Inheritance + Table Full-Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two `apps/web`-only frontend issues: (T1) a new view should inherit the columns the source view is CURRENTLY SHOWING, not fall back to the 3 builtins; (T2) the spreadsheet table should fill the viewport width instead of leaving dead space on the right.

**Architecture:** T1 moves the "effective on-screen column" resolution to where the data already lives (`TableView` has `fields` + loaded `docs` + `activeView` and already computes `visibleColumns`); the resolved keys are published to a tiny module-level store that the rail's New-view sheet reads when it builds the create payload. T2 adds full-width fill at the scroll-container level (a `min-w-full` on the `w-max` inner wrapper) so the table grows to the viewport WITHOUT touching `gridTemplate` — the fixed-px column model and the Bug-E guarantees stay intact.

**Tech Stack:** React 18, Vite, TanStack Router + Query, Tailwind, shadcn/Radix. Tests: Vitest (`npx vitest run` from `apps/web`). Typecheck: `bun x tsc --noEmit` from `apps/web`. Lint: `bun run lint` from repo root.

## Global Constraints

- **TypeScript everywhere, `strict: true`. No `any`** (use `unknown` + narrow). `noExplicitAny` is `warn`, not a commit blocker — but don't introduce one.
- **No new plumbing beyond what's needed** (Stefan's standing directive: efficiency, no duplication, clean frontend). Reuse `mergeColumns` / `effectiveVisibleKeys` / `applyColumnOrder` — do NOT reimplement column resolution.
- **No default exports** except routers and React route components.
- **Imports absolute via `@/`-style relative `.ts`/`.tsx`** as the surrounding files already do (these files use explicit `./` + `../` with extensions — match them).
- **cwd discipline (CRITICAL):** bash cwd persists across tool calls and silently doubles paths. ALWAYS `cd` per command: vitest + tsc from `apps/web`; git + lint from the repo root. Never assume the previous command's cwd.
- **Run order before every commit:** `cd apps/web && npx vitest run <file>` (the touched specs) → `cd apps/web && bun x tsc --noEmit` → `cd <repo root> && bun run lint` (must exit 0; auto-fix formatter/import-order with `bunx biome check --write` from repo root). Web suite baseline: **1108 green** — do not regress.
- Branch: `phase-6/views`. Atomic commit per task, message `phase-6: <what>`.

---

## Classification & Gate Decisions (Class A)

**Class A** — two related user-facing changes, multi-task, gated plan. Stage 0 brainstorm skipped: both are well-specified with locked decisions; the only open questions were resolution-path tradeoffs, decided below.

| Gate | Fires? | One-line reason |
|---|---|---|
| **1a Threat-modeling** | **NO** | Pure presentational + a column-key-list copy of already-authed, already-loaded view data. No new untrusted input, no URL, no auth/token/parsing/BYOK/outbound surface. The column keys copied are the same keys the server already accepts on the existing `useUpdateView` PATCH path (`visibleFields`/`columnOrder`), validated server-side as they are today — T1 adds no new write surface, just better-populated values to an existing one. |
| **1b Architecture-invariants** | **YES (note only, no bypass)** | T1 creates a view via `useCreateView` → **invariant 6** (web data access: all HTTP through `client`, keys from `*Keys` factories). Confirmed respected — `useCreateView` already routes through `client` + `viewsKeys`; T1 changes only the *payload values*, not the data-access path. T2 is pure layout (touches no invariant). See `## Architecture invariants touched`. |
| **1g Feature-acceptance** | **YES** | Both are user-facing (view-creation flow + table layout). `## Acceptance flows` matrix embedded below; driven at `/shakeout`. |
| **1c Spec premise ground-truth** | **DONE** | All six named source files read before planning. Premises confirmed: see `## Ground-truth confirmations`. |

---

## Ground-truth confirmations (Stage 1c — verified against source)

1. **`new-view-sheet.tsx:127-128`** already copies `currentColumns.visibleFields`/`columnOrder` into the payload, gated on `!= null`. Machinery exists; confirmed.
2. **`w.$wslug.tsx:219-231`** `newViewCurrentColumns` returns the RAW `active.visibleFields`/`active.columnOrder`. The default/main view's `visibleFields` is almost always `null` → omitted → server defaults to 3 builtins. **Bug confirmed.**
3. **`columns.ts`**: `effectiveVisibleKeys(cols, view)` returns `DEFAULT_VISIBLE_KEYS = [title,status,updated_at]` when `view.visibleFields` is null/empty, else filters the saved list to valid columns. `mergeColumns(fields, view, docs)` synthesizes a field column for any frontmatter key present in `docs` **but only when `view.visibleFields` is non-empty** (line 55 guard). Confirmed — see the wrinkle below.
4. **`table-view.tsx:196-214`** already computes `allColumns` (mergeColumns), `orderedColumns` (applyColumnOrder), `visibleKeys` (effectiveVisibleKeys), and `visibleColumns` (the ordered, visible, on-screen set). This is exactly the resolved effective column set T1 needs. Confirmed.
5. **Component tree:** `w.$wslug.tsx` renders `<Rail …>` (holds `newViewSheet` state + the `NewViewSheet`) in `Shell.rail`, and `<Outlet/>` (where `TableView` mounts) in `Shell.main`. **They are SIBLINGS, not parent/child** (lines 408-467). The rail CANNOT read TableView's `visibleColumns` via props/context lift without a shared store. This decides the resolution path (Option A variant — module store — over a prop lift). Confirmed.
6. **`columns.ts:145-147`** `gridTemplate` returns only fixed-px tracks; the docstring records the `1fr` spacer was removed for Bug E. **`columns.test.ts:286-294`** asserts `gridTemplate(...).not.toContain('1fr')` and the exact `'280px 140px 220px'` string. Confirmed — T2 must NOT touch `gridTemplate`.
7. **`table-view.tsx:487-501`** scroll container is `folio-scroll -mx-[22px] … overflow-auto` wrapping `<div className="w-max pr-[22px]">`. `w-max` sizes to content (a Bug-E fix so borders extend on h-scroll). **This `w-max` div is the single full-width lever for T2.** Confirmed.
8. **`table-row.tsx:56-58`** and **`table-header.tsx:66`** BOTH use `grid flex-1` with `gridTemplateColumns: gridTemplate(columns)` — they share the template, so header/body stay aligned as long as `gridTemplate` is untouched. Confirmed.

### The T1 wrinkle (and its resolution)

`mergeColumns` only synthesizes data-driven columns when `view.visibleFields` is non-empty (the `&& view?.visibleFields && view.visibleFields.length > 0` guard at `columns.ts:55`). So for the default view (visibleFields = null), `mergeColumns` returns ONLY builtins + pinned `fields` — NOT the synthesized-from-data columns. **But** `TableView`'s `visibleColumns` is what's literally on screen: `orderedColumns.filter(c => visibleKeys.includes(c.key))`, where `visibleKeys = effectiveVisibleKeys(allColumns, activeView)` → for a null-visibleFields view that's `[title,status,updated_at]`. **So the default view currently shows ONLY builtins+pinned-fields that fall in DEFAULT_VISIBLE_KEYS — i.e. the on-screen set for a null view is just the 3 builtins (plus any pinned field whose key happens to be a default key — none do).**

This means: **"inherit what the source view CURRENTLY SHOWS" = inherit `TableView.visibleColumns` keys, in order.** That is the precise, already-computed set. There is no need to re-run mergeColumns elsewhere or to fabricate the synthesized columns — `visibleColumns` already encodes exactly what the user sees. T1's job is to get **`visibleColumns.map(c => c.key)`** from TableView to the New-view sheet.

> NOTE for the implementer: if Stefan's intent ("all the frontmatter columns currently visible") turns out to mean MORE than DEFAULT_VISIBLE_KEYS for a null-visibleFields view, that is a *separate* behavior change to `effectiveVisibleKeys`/the default view's on-screen set — OUT OF SCOPE here. T1 inherits *whatever is on screen*, faithfully. If the main view shows only 3 columns today, the new view inherits 3; if the user has toggled on `priority`/`assignee` (which persists `visibleFields` on that view), the new view inherits those. This is the locked decision: copy the live on-screen set, do not invent columns.

### Chosen resolution path for T1 — **Option A (module-store variant)**

Because the rail and TableView are SIBLINGS (ground-truth #5), a prop/context lift is not available without restructuring the route. The minimal, no-restructure path:

- A tiny module-level store (`apps/web/src/components/table/current-columns-store.ts`) holds the last-rendered on-screen column snapshot, keyed by `tslug`: `{ tslug, visibleFields: string[], columnOrder: string[] }`.
- `TableView` publishes its `visibleColumns` keys to the store (via a `useEffect` on `[tslug, visibleColumns, activeView]`).
- `w.$wslug.tsx`'s `newViewCurrentColumns` reads the store snapshot for `newViewSheet.tslug` (falling back to the existing raw-view read if the table the sheet opened on isn't the one currently rendered — e.g. creating a view from a rail row for a table not on screen).

**Why not Option B** (sheet fetches fields+docs itself): duplicates the entire mergeColumns/effectiveVisibleKeys pipeline + adds 2+ queries; violates "no duplication." **Why not Option C** (persist effective columns onto the default view): mutates the main view as a side effect of opening a sheet — riskiest, and an unwanted write. The module store is ~20 lines, behavior-preserving, and reuses the already-computed `visibleColumns`.

> **Rejected-alternative honesty:** the module store is a small escape hatch from React's data flow. It is acceptable here ONLY because (a) the producer (TableView) and consumer (rail sheet) are render-sibling subtrees with no common ancestor that holds both, and (b) the datum is a transient UI snapshot, not a source of truth (the source of truth is the saved view; this is "what's on screen right now"). It is NOT a react-query cache entry, so invariant 6 does not apply to it. Keep it dumb: a plain object + getter/setter, no subscription machinery.

### Chosen approach for T2 — **min-w-full on the `w-max` container (Option c)**

Change `table-view.tsx:501` from `className="w-max pr-[22px]"` to `className="w-max min-w-full pr-[22px]"`.

- `w-max` sizes the wrapper to its intrinsic content width (sum of column tracks) → borders extend full-width on horizontal scroll (the Bug-E guarantee, preserved).
- `min-w-full` raises the floor to 100% of the scroll container when content is NARROWER than the viewport → the wrapper (and the `border-b` rows inside, which are `w-full` relative to it) fills the dead right space.
- When content is WIDER than the viewport, `min-w-full` is satisfied by the larger `w-max` width → no effect on the h-scroll case. The two never conflict: `min-width` only ever raises, never caps.
- **`gridTemplate` is NOT touched** → no `1fr` reintroduced → **Bug E cannot regress** (the fixed-px tracks and flush borders are byte-for-byte unchanged). The filler space lands to the RIGHT of the last column's grid track (inside the wider wrapper), exactly where trailing whitespace already goes — it does not insert a gap between the last header label and its cells.

**Why not (a) trailing filler track** — that re-enters the `gridTemplate` string and risks the exact Bug-E gap (a track between content and edge); also needs header+body+columns.test.ts changes. **Why not (b) flex the last real column** — variable column widths break the fixed-px header/body alignment contract and the `columnWidth` model. Option c is one Tailwind class, zero logic, zero `gridTemplate` change.

---

## Architecture invariants touched

- **Invariant 6 (web data access).** Touched by **T1** via `useCreateView`. **Respected, no bypass:** `useCreateView` (`apps/web/src/lib/api/views.ts:79`) already routes through the shared `client` and `viewsKeys` factory. T1 changes only the *values* in the `ViewCreate` payload (`visibleFields`/`columnOrder`), not the data-access path. The new module store is plain UI state, NOT a react-query cache/key, so invariant 6 does not govern it (it is neither a `fetch` nor a query key).
- No other invariant is touched. T2 is pure CSS. T1 adds no SSE consumer (invariant 8), no token authority (invariant 7), no auth identity (invariant 1).

---

## Acceptance flows (1g — embedded; driven at `/shakeout`)

Layer legend: **BROWSER** = Stefan verifies in his logged-in browser at `/shakeout` (real dev server). **UNIT** = agent verifies the logic via Vitest. Each row enumerates all six edge classes (empty/zero, denied actor, wrong-order/re-entry, concurrent/double, boundary, mid-flow failure) — N/A entries say why.

### T1 — New view inherits the source view's on-screen columns

| Flow | Happy path | Edges (all six) | Layer |
|---|---|---|---|
| **F1 Inherit from a view showing N frontmatter columns** | Open a view whose `visibleFields` includes `priority`+`assignee` (toggled on), click "+ new view", create → new view's `visibleFields`/`columnOrder` equal the source's on-screen set + order. | empty/zero: source view shows only the 3 builtins (null visibleFields) → new view = those 3, order preserved. denied actor: a viewer with no create-view grant gets the server's existing 403 (unchanged path) → no client crash, toast. wrong-order/re-entry: open sheet, close without creating, re-open on a DIFFERENT table → reads that table's snapshot, not the stale one. concurrent/double: double-click "Create view" → existing `disabled={create.isPending}` guard prevents a 2nd POST (`new-view-sheet.tsx:239`). boundary: a view with a single visible column → new view inherits exactly that one. mid-flow failure: source table never rendered this session (store empty for that tslug) → fall back to the raw saved-view read (existing behavior), never crash. | BROWSER (column-set parity, re-entry) + UNIT (resolution logic, fallback) |
| **F2 Inherit from the bugs table, not work-items** | From the `bugs` rail row, "+ new view" → inherits bugs' on-screen columns, not work-items'. | empty/zero: bugs table empty (no docs) → builtins only. denied/wrong-order/concurrent/boundary: as F1. mid-flow failure: bugs table not currently on screen → store miss → raw-view fallback seeds bugs' saved view (existing `newViewSheet.tslug` seeding preserved). | BROWSER (cross-table correctness) + UNIT (store keyed by tslug) |

### T2 — Table fills viewport width

| Flow | Happy path | Edges (all six) | Layer |
|---|---|---|---|
| **F3 Narrow table fills width** | Table with few/narrow columns → no dead space on the right; rows + `border-b` extend to the viewport edge. | empty/zero: 0 rows (EmptyState) → container still fills, no layout break. denied actor: N/A (read-only layout, no actor gate). wrong-order/re-entry: resize viewport narrower→wider→narrower → fill re-flows, no stuck width. concurrent/double: N/A (no mutation). boundary: exactly one column / exactly viewport-width content → no double scrollbar, no 1px gap. mid-flow failure: N/A (pure CSS, no async). | BROWSER (Stefan eyeballs fill at his viewport) |
| **F4 Wide table h-scrolls, Bug E intact** | Many/wide columns exceeding viewport → horizontal scroll; the last column's borders + the row `border-b` extend full content width on scroll (no unbordered right edge). | boundary: scroll to the far right → last header label aligns with its cells, no gap between last column header and its cells (the Bug-E assertion). All other edges: N/A (deterministic CSS). | BROWSER (h-scroll borders) + UNIT (gridTemplate contract test asserts NO `1fr`) |

---

## File Structure

- **Create:** `apps/web/src/components/table/current-columns-store.ts` — module-level snapshot store for the on-screen column set, keyed by tslug. One responsibility: publish/read the live visible-column keys across the rail/outlet sibling boundary.
- **Create:** `apps/web/src/components/table/current-columns-store.test.ts` — unit tests for the store (Tier A logic).
- **Modify:** `apps/web/src/components/table/table-view.tsx` — publish `visibleColumns` keys to the store (T1).
- **Modify:** `apps/web/src/routes/w.$wslug.tsx:219-231` — `newViewCurrentColumns` reads the store, falls back to the raw-view read (T1).
- **Modify:** `apps/web/src/components/table/table-view.tsx:501` — `w-max` → `w-max min-w-full` (T2).
- **Modify:** `apps/web/src/components/table/columns.test.ts` — keep/extend the `gridTemplate` no-`1fr` contract test; add an explicit assertion documenting that full-width does NOT live in `gridTemplate` (T2 regression guard).

**T1 and T2 are INDEPENDENT** (T1 = view-create payload logic; T2 = one CSS class). They share no code and can ship in either order, each independently hot-reload-verifiable. Sequenced T1 → T2 only because T1 is the higher-value bug.

---

# TASK 1 — New view inherits the source view's on-screen columns

## Task 1a: The current-columns store (Tier A — real logic, the seam that crosses the sibling boundary)

**Test contract (Tier A):** the store round-trips a snapshot keyed by tslug; a read for an unknown tslug returns `null` (drives the fallback); a second publish for the same tslug overwrites; publishing for tslug B does not clobber tslug A's snapshot.

**Files:**
- Create: `apps/web/src/components/table/current-columns-store.ts`
- Test: `apps/web/src/components/table/current-columns-store.test.ts`

**Interfaces:**
- Produces:
  - `interface ColumnSnapshot { visibleFields: string[]; columnOrder: string[] }`
  - `function setColumnSnapshot(tslug: string, snapshot: ColumnSnapshot): void`
  - `function getColumnSnapshot(tslug: string): ColumnSnapshot | null`
- Consumed by: Task 1b (TableView publishes), Task 1c (rail reads).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/table/current-columns-store.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ColumnSnapshot,
  clearColumnSnapshots,
  getColumnSnapshot,
  setColumnSnapshot,
} from './current-columns-store.ts';

afterEach(() => clearColumnSnapshots());

describe('current-columns-store', () => {
  it('returns null for an unknown tslug (drives the raw-view fallback)', () => {
    expect(getColumnSnapshot('work-items')).toBeNull();
  });

  it('round-trips a snapshot keyed by tslug', () => {
    const snap: ColumnSnapshot = {
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'priority', 'status'],
    };
    setColumnSnapshot('work-items', snap);
    expect(getColumnSnapshot('work-items')).toEqual(snap);
  });

  it('overwrites a prior snapshot for the same tslug', () => {
    setColumnSnapshot('work-items', { visibleFields: ['title'], columnOrder: ['title'] });
    setColumnSnapshot('work-items', {
      visibleFields: ['title', 'status'],
      columnOrder: ['title', 'status'],
    });
    expect(getColumnSnapshot('work-items')?.visibleFields).toEqual(['title', 'status']);
  });

  it('keeps per-tslug snapshots isolated', () => {
    setColumnSnapshot('work-items', { visibleFields: ['title'], columnOrder: ['title'] });
    setColumnSnapshot('bugs', {
      visibleFields: ['title', 'severity'],
      columnOrder: ['title', 'severity'],
    });
    expect(getColumnSnapshot('work-items')?.visibleFields).toEqual(['title']);
    expect(getColumnSnapshot('bugs')?.visibleFields).toEqual(['title', 'severity']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/table/current-columns-store.test.ts`
Expected: FAIL — module `./current-columns-store.ts` not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
// apps/web/src/components/table/current-columns-store.ts

/**
 * A transient, module-level snapshot of the columns a table view is CURRENTLY
 * showing on screen, keyed by tslug. It exists to cross the render-sibling
 * boundary between TableView (in the route <Outlet/>) and the New-view sheet
 * (in the <Rail/>) — they have no common ancestor that holds both, so a plain
 * prop/context lift is unavailable without restructuring the route.
 *
 * This is UI state, NOT a source of truth (the saved view is) and NOT a
 * react-query cache (so invariant 6 does not govern it). TableView publishes
 * its resolved `visibleColumns` keys here; the New-view sheet reads them to
 * seed a created view as a copy of what the user is looking at. A read miss
 * (table never rendered this session) falls back to the raw saved-view read.
 */
export interface ColumnSnapshot {
  visibleFields: string[];
  columnOrder: string[];
}

const snapshots = new Map<string, ColumnSnapshot>();

export function setColumnSnapshot(tslug: string, snapshot: ColumnSnapshot): void {
  snapshots.set(tslug, snapshot);
}

export function getColumnSnapshot(tslug: string): ColumnSnapshot | null {
  return snapshots.get(tslug) ?? null;
}

/** Test-only: reset between cases (the Map is process-global). */
export function clearColumnSnapshots(): void {
  snapshots.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/table/current-columns-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd <repo-root>
git add apps/web/src/components/table/current-columns-store.ts apps/web/src/components/table/current-columns-store.test.ts
git commit -m "phase-6: add current-columns snapshot store for cross-tree view-create inheritance"
```

---

## Task 1b: TableView publishes its on-screen columns (Tier B — UI wiring/glue)

`no unit test: Tier B, a one-line effect that publishes already-tested derived state (visibleColumns) to the already-tested store; the seam is exercised by the F1/F2 browser flows at /shakeout and by 1c's resolution unit test which feeds a store snapshot.`

**Files:**
- Modify: `apps/web/src/components/table/table-view.tsx`

**Interfaces:**
- Consumes: `setColumnSnapshot`, `ColumnSnapshot` (Task 1a); `visibleColumns` (already computed at `table-view.tsx:211-214`); `tslug` (prop); `activeView` (already computed at `:182-189`).

- [ ] **Step 1: Add the import**

At the top of `table-view.tsx`, with the other `./` imports (near the `columns.ts` import on line 33), add:

```ts
import { setColumnSnapshot } from './current-columns-store.ts';
```

- [ ] **Step 2: Publish the on-screen columns to the store**

Immediately AFTER the `visibleColumns` useMemo (currently `table-view.tsx:211-214`), add the publish effect. `useEffect` is already imported? Check the React import line — it currently imports `useCallback, useMemo, useRef, useState`. ADD `useEffect` to that import:

Change line 4:
```ts
import { useCallback, useMemo, useRef, useState } from 'react';
```
to:
```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

Then add after the `visibleColumns` useMemo:

```ts
  // V2 (column-inheritance fix): publish the columns the user is CURRENTLY
  // looking at to the cross-tree snapshot store, so the New-view sheet (which
  // lives in the rail, a render sibling) can seed a created view as a copy of
  // this on-screen set — including columnOrder. Keyed by tslug so a view
  // created from a DIFFERENT table's rail row reads that table's snapshot.
  // visibleColumns already encodes exactly what's rendered (builtins + the
  // visible/synthesized field columns, in order), so no re-resolution here.
  useEffect(() => {
    setColumnSnapshot(tslug, {
      visibleFields: visibleColumns.map((c) => c.key),
      columnOrder: visibleColumns.map((c) => c.key),
    });
  }, [tslug, visibleColumns]);
```

> NOTE: `visibleFields` and `columnOrder` are the SAME array here on purpose — `visibleColumns` is already the ordered, filtered, on-screen set, so the visible set IS the order. The server stores both; the new view's order matches its visible set. This is intentional and correct for "copy what's on screen."

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full table suite to confirm no regression**

Run: `cd apps/web && npx vitest run src/components/table`
Expected: PASS (existing table tests still green; the effect is inert to them).

- [ ] **Step 5: Commit**

```bash
cd <repo-root>
git add apps/web/src/components/table/table-view.tsx
git commit -m "phase-6: TableView publishes on-screen columns to the snapshot store"
```

---

## Task 1c: Rail reads the snapshot to seed the new view (Tier A — the resolution logic, the actual bug fix)

**Test contract (Tier A):** the resolution prefers a store snapshot over the raw saved-view read; given a store snapshot with `visibleFields=[title,status,priority]`, the resolved `currentColumns` carries those (NOT the raw view's null); given NO snapshot for the tslug, it falls back to the raw `active.visibleFields`/`columnOrder` (existing behavior preserved). Because the resolution currently lives inline in a `useMemo` inside a large route component, **extract it to a pure exported helper** so it is unit-testable without mounting the route.

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx`
- Create: `apps/web/src/lib/resolve-new-view-columns.ts` (the extracted pure helper)
- Test: `apps/web/src/lib/resolve-new-view-columns.test.ts`

**Interfaces:**
- Consumes: `getColumnSnapshot` (Task 1a); the `View` type (`apps/web/src/lib/api/views.ts`).
- Produces:
  - `function resolveNewViewColumns(args: { tslug: string; activeView: { visibleFields: string[] | null; columnOrder: string[] | null } | null }): { visibleFields: string[] | null; columnOrder: string[] | null } | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/resolve-new-view-columns.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearColumnSnapshots,
  setColumnSnapshot,
} from '../components/table/current-columns-store.ts';
import { resolveNewViewColumns } from './resolve-new-view-columns.ts';

afterEach(() => clearColumnSnapshots());

describe('resolveNewViewColumns', () => {
  it('prefers the on-screen snapshot over the raw (null) saved view — THE BUG FIX', () => {
    setColumnSnapshot('work-items', {
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'status', 'priority'],
    });
    const out = resolveNewViewColumns({
      tslug: 'work-items',
      activeView: { visibleFields: null, columnOrder: null }, // the default view's reality
    });
    expect(out).toEqual({
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'status', 'priority'],
    });
  });

  it('falls back to the raw saved view when no snapshot exists for the tslug', () => {
    const out = resolveNewViewColumns({
      tslug: 'bugs',
      activeView: { visibleFields: ['title', 'severity'], columnOrder: ['severity', 'title'] },
    });
    expect(out).toEqual({
      visibleFields: ['title', 'severity'],
      columnOrder: ['severity', 'title'],
    });
  });

  it('keeps snapshots isolated per tslug (bugs reads bugs, not work-items)', () => {
    setColumnSnapshot('work-items', {
      visibleFields: ['title', 'status', 'updated_at'],
      columnOrder: ['title', 'status', 'updated_at'],
    });
    const out = resolveNewViewColumns({
      tslug: 'bugs',
      activeView: { visibleFields: null, columnOrder: null },
    });
    // No snapshot for bugs → falls back to bugs' raw view (null), not work-items'.
    expect(out).toEqual({ visibleFields: null, columnOrder: null });
  });

  it('returns undefined when there is no active view and no snapshot', () => {
    expect(resolveNewViewColumns({ tslug: 'work-items', activeView: null })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/resolve-new-view-columns.test.ts`
Expected: FAIL — module `./resolve-new-view-columns.ts` not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
// apps/web/src/lib/resolve-new-view-columns.ts
import { getColumnSnapshot } from '../components/table/current-columns-store.ts';

interface ActiveViewColumns {
  visibleFields: string[] | null;
  columnOrder: string[] | null;
}

/**
 * Resolve the columns a NEW view should inherit: the columns the source table
 * is CURRENTLY showing on screen. Prefers the live on-screen snapshot (which
 * TableView publishes) — this is the bug fix: the default view's saved
 * `visibleFields` is almost always null, so the raw read seeded nothing and the
 * server fell back to the 3 builtins. The snapshot carries the real on-screen
 * set (builtins + visible field columns + order).
 *
 * Falls back to the raw saved-view columns when the table wasn't rendered this
 * session (no snapshot) — e.g. creating a view from a rail row for a table not
 * on screen. Returns undefined when there's nothing to inherit at all.
 */
export function resolveNewViewColumns(args: {
  tslug: string;
  activeView: ActiveViewColumns | null;
}): { visibleFields: string[] | null; columnOrder: string[] | null } | undefined {
  const snapshot = getColumnSnapshot(args.tslug);
  if (snapshot) {
    return { visibleFields: snapshot.visibleFields, columnOrder: snapshot.columnOrder };
  }
  if (!args.activeView) return undefined;
  return {
    visibleFields: args.activeView.visibleFields,
    columnOrder: args.activeView.columnOrder,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/resolve-new-view-columns.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the helper into the route**

In `apps/web/src/routes/w.$wslug.tsx`, add the import (with the other `../` imports near line 27):

```ts
import { resolveNewViewColumns } from '../lib/resolve-new-view-columns.ts';
```

Replace the `newViewCurrentColumns` useMemo body (currently `:219-231`). Keep the existing table-seeding logic that finds the active view; just swap the final `return` to delegate to the helper:

```ts
  const newViewCurrentColumns = useMemo(() => {
    if (!newViewSheet) return undefined;
    const tables = tablesByProject[newViewSheet.pslug] ?? [];
    // Seed from the table the sheet was OPENED on (newViewSheet.tslug), not
    // tables[0] (the default/work-items table) — otherwise a view created from
    // the `bugs` rail row inherits work-items' columns.
    const activeTable = tables.find((t) => t.slug === newViewSheet.tslug) ?? tables[0];
    const views = viewsByTable[activeTable?.id ?? ''] ?? [];
    const active =
      views.find((v) => v.id === activeViewId) ?? views.find((v) => v.isDefault) ?? views[0];
    // Prefer the on-screen snapshot for the OPENED table (the bug fix): the
    // default view's saved visibleFields is usually null, so the raw read
    // seeded nothing → server defaulted to the 3 builtins. The snapshot carries
    // the real on-screen column set. Falls back to the raw saved view when the
    // table wasn't rendered this session.
    return resolveNewViewColumns({
      tslug: newViewSheet.tslug,
      activeView: active ? { visibleFields: active.visibleFields, columnOrder: active.columnOrder } : null,
    });
  }, [newViewSheet, tablesByProject, viewsByTable, activeViewId]);
```

> NOTE: the store read inside `resolveNewViewColumns` is NOT reactive — it reads the Map at render time. That is fine: `newViewCurrentColumns` recomputes when `newViewSheet` flips from null to a value (the sheet opening), and the snapshot is already populated by then because TableView has been mounted and its publish effect has run. The sheet is only ever opened AFTER a table has rendered.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the resolution test + any route-touching tests**

Run: `cd apps/web && npx vitest run src/lib/resolve-new-view-columns.test.ts src/components/table src/components/views`
Expected: PASS.

- [ ] **Step 8: Lint + commit**

```bash
cd <repo-root>
bun run lint            # must exit 0; if formatter/import-order errors: bunx biome check --write
git add apps/web/src/lib/resolve-new-view-columns.ts apps/web/src/lib/resolve-new-view-columns.test.ts apps/web/src/routes/w.\$wslug.tsx
git commit -m "phase-6: new view inherits the source view's on-screen columns (fix null-visibleFields fallback to builtins)"
```

**Integration gate (T1):** `cd apps/web && npx vitest run` (full web suite ≥ 1108 green) + `bun x tsc --noEmit` clean. Then the BROWSER half (F1/F2) is driven at `/shakeout`: in the logged-in app, open a view, create a new view, confirm the new view shows the SAME columns as the source — incl. a view with toggled-on frontmatter columns, and a create from the bugs table inheriting bugs' columns.

── REVIEW GATE ── (tier: STANDARD — multi-file UI behavior change to the view-create flow; touches invariant 6 but RESPECTS it via the existing useCreateView path, adds no 1a surface, no data-layer/migration. 2 finders + simplicity + the F1/F2 feature-acceptance browser pass; no security-sentinel. Escalate to FULL only if a finding shows the column-key copy reaches an unauthed/unvalidated write path — it does not.)

Cluster = Tasks 1a + 1b + 1c (3 tasks, within the ~3-4 sizing limit).

---

# TASK 2 — Table fills viewport width

## Task 2a: Full-width fill via `min-w-full`, with the gridTemplate contract guarded (Tier A — extend the contract test; the change itself is Tier B CSS)

The CSS change is one class (Tier B). But the RISK is a Bug-E regression, and the guard against it is the `gridTemplate` contract test. So this task's deliverable is: the CSS change PLUS an extended/strengthened `columns.test.ts` that locks in "full-width does NOT come from gridTemplate" (Tier A on the contract test).

**Test contract (Tier A, on the contract test):** `gridTemplate` still emits one fixed-px track per column with NO `1fr` and NO trailing flexible track — i.e. the full-width behavior must NOT have leaked into `gridTemplate`. The existing assertions stay; add one that documents the intent.

**Files:**
- Modify: `apps/web/src/components/table/table-view.tsx:501`
- Modify: `apps/web/src/components/table/columns.test.ts` (strengthen the gridTemplate contract block)

- [ ] **Step 1: Strengthen the failing-guard test FIRST (it should already pass — this is the regression lock)**

In `apps/web/src/components/table/columns.test.ts`, inside the existing `describe('gridTemplate', …)` block, ADD this case after the existing `'emits one track per column with NO 1fr spacer'` test:

```ts
  it('contains no flexible track — full-width fill must NOT live in gridTemplate (Bug E guard)', () => {
    // T2 (2026-06-17): the table fills the viewport via `min-w-full` on the
    // w-max scroll wrapper, NOT via a flexible grid track. Re-introducing a
    // `1fr` / `auto` / `minmax(...)` track here is the Bug-E regression: it puts
    // a gap between the last column header label and its cells. Lock it out.
    const tpl = gridTemplate([titleCol, statusCol, tagsCol]);
    expect(tpl).not.toMatch(/fr\b/);
    expect(tpl).not.toContain('auto');
    expect(tpl).not.toContain('minmax');
    // Every track is a literal px width.
    for (const track of tpl.split(' ')) {
      expect(track).toMatch(/^\d+px$/);
    }
  });
```

- [ ] **Step 2: Run it (expected: PASS — gridTemplate is currently fixed-px)**

Run: `cd apps/web && npx vitest run src/components/table/columns.test.ts`
Expected: PASS. This test now FAILS if a future edit sneaks a flexible track into `gridTemplate`.

- [ ] **Step 3: Apply the full-width CSS change**

In `apps/web/src/components/table/table-view.tsx`, the inner scroll wrapper (currently `:501`):

```tsx
        <div className="w-max pr-[22px]">
```
becomes:
```tsx
        {/* `w-max` sizes to content so borders extend on horizontal scroll
            (Bug E, 2026-05-26). `min-w-full` raises the floor to the scroll
            container's width when content is NARROWER than the viewport, so the
            table fills the dead right space — without touching gridTemplate, so
            the fixed-px tracks and flush column borders are unchanged. The two
            never conflict: min-width only raises, the wider w-max wins on
            overflow. */}
        <div className="w-max min-w-full pr-[22px]">
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the table suite**

Run: `cd apps/web && npx vitest run src/components/table`
Expected: PASS (gridTemplate contract intact; layout class change is inert to JSDOM tests).

- [ ] **Step 6: Lint + commit**

```bash
cd <repo-root>
bun run lint            # exit 0; auto-fix with bunx biome check --write if needed
git add apps/web/src/components/table/table-view.tsx apps/web/src/components/table/columns.test.ts
git commit -m "phase-6: table fills viewport width via min-w-full (no gridTemplate change, Bug E intact)"
```

**Integration gate (T2):** full web suite green + tsc clean. The BROWSER half (F3/F4) is driven at `/shakeout` / by Stefan in his logged-in browser: a narrow table fills the viewport with no dead right space; a wide table horizontally scrolls with the last column's borders + the row `border-b` extending to the full content width (Bug E NOT regressed); header and body columns stay aligned (they share the untouched `gridTemplate`).

── REVIEW GATE ── (tier: LIGHT — one Tailwind class + a test-only contract strengthening; no 1a surface, no invariant, no data layer, no behavior logic. Single generalist pass. The real verification is Stefan's browser eyeball of fill + h-scroll borders, which the LIGHT code pass cannot replace — it is captured as the F3/F4 BROWSER acceptance rows.)

Cluster = Task 2a (1 task).

---

## Self-Review (run against the spec)

1. **Spec coverage:** T1 (inherit on-screen columns) → Tasks 1a/1b/1c. T2 (full-width) → Task 2a. The T1 wrinkle (where to resolve effective columns) → resolved as Option A module-store, documented with the rejected alternatives. The T2 tension (full-width vs Bug E) → resolved as `min-w-full`, with the Bug-E non-regression argument + a contract test. Per-task tiers assigned. Acceptance matrix has all six edge classes per flow. Both gates evaluated with reasons. No gap.
2. **Placeholder scan:** none — every code step shows the actual code; every command is exact with expected output.
3. **Type consistency:** `ColumnSnapshot { visibleFields, columnOrder }` used identically in store (1a), TableView publish (1b), and resolver (1c). `resolveNewViewColumns` return shape matches `NewViewSheetProps.currentColumns` (`{ visibleFields: string[] | null; columnOrder: string[] | null }`) — confirmed against `new-view-sheet.tsx:34`. `setColumnSnapshot`/`getColumnSnapshot`/`clearColumnSnapshots` names consistent across store + both consumers.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-view-column-inheritance-and-full-width.md`. Hand off to the implementer agent for Stage 2 (subagent-driven-development recommended: fresh subagent per task, review at each `── REVIEW GATE ──`).
