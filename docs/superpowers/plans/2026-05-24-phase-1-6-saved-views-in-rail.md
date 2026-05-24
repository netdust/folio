# Phase 1.6 — Saved Views in Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task ends with running `cd apps/server && bun test` and `cd apps/web && bun run test` and reporting pass count.

**Goal:** Promote views from "URL query string state" to first-class objects with their own rail navigation. The left rail nests `Project → Table → Views`; clicking a view navigates to a URL that selects it and applies its filters + columnOrder + sort + visibleFields. Column/sort changes auto-save back to the active view (extending Phase 1.5b's `columnOrder` auto-save behavior). Filters stay URL-only with an explicit "Save filters to this view" action. A `+ New view` action under each table captures the current URL state as a new view.

**Architecture:** Views remain table-scoped (`/api/v1/w/:ws/p/:p/views` with `tableId` already on each row). Views are addressed in the URL by their **`id`** (`?view=<id>`), NOT by slug — the `views` table has no slug column and we are not adding one in this phase (decision 2026-05-24). IDs are `nanoid()` strings (~21 alphanumeric chars) — every server route uses `nanoid`, not UUIDv7 (CLAUDE.md's UUIDv7 line is aspirational, not implemented). The frontend `View.slug` field is removed because it has been a lie since Phase 1. Rail gets a nested `NavItem.children` extension plus per-item expand state in localStorage. The TableView reads `?view=` from URL, calls `useViews`, picks the matching view (or default), and applies its `filters / sort / visibleFields / columnOrder` to the current URL on first navigation.

**Tech Stack:** Existing — React + TanStack Router + Tailwind + shadcn/ui + dnd-kit + react-query + Vitest + Playwright. No new dependencies. No new server columns. CLAUDE.md rules hold: no `any`, kebab files, no default exports except routers + route components, Biome.

---

## File Structure

**Create (frontend):**
- `apps/web/src/components/shell/rail-tree.tsx` — pure recursive renderer for the new `NavItem.children` tree. Owns per-item expand state via `useExpanded(id)` (localStorage-backed). Separated from `rail.tsx` to keep the existing flat `NavList` untouched.
- `apps/web/src/components/shell/rail-tree.test.tsx` — RTL test for expand/collapse + nested click handlers.
- `apps/web/src/lib/rail-tree.ts` — pure builder: takes `(projects, tablesByProject, viewsByTable, currentRoute)` and returns the `NavItem` tree. Memoizable; no React.
- `apps/web/src/lib/rail-tree.test.ts` — Vitest unit tests for the builder.
- `apps/web/src/components/views/new-view-sheet.tsx` — sheet body for "+ New view": name field + checkbox "Use current filters / columns / sort". Calls `useCreateView`.
- `apps/web/src/components/views/new-view-sheet.test.tsx` — RTL test for sheet submit → mutation called with expected payload.
- `apps/web/src/components/views/save-filters-action.tsx` — button + confirm flow that PATCHes the active view's `filters` to whatever the URL currently has. Lives in the table header.
- `apps/web/src/components/views/save-filters-action.test.tsx`.

**Modify (frontend):**
- `apps/web/src/components/shell/rail.tsx` — extend `NavItem` with `children?: NavItem[]` and `expandable?: boolean`. The existing flat `NavList` keeps working when `children` is undefined. When `children` is set, defer rendering to `<RailTree>`.
- `apps/web/src/routes/w.$wslug.tsx` — change the per-workspace `primary` builder to fetch tables + views per project and pass a nested `NavItem` tree. Add the `useTables` + `useViews` calls (one per visible project).
- `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` — extend `validateSearch` to accept `view?: string` (UUIDv7) and propagate.
- `apps/web/src/components/table/table-view.tsx` — read `?view=` from URL; if set, resolve from `useViews`; if not, use default. On view change: apply view's `filters` → URL params, `sort`/`visibleFields`/`columnOrder` flow through existing render. Add the `<SaveFiltersAction>` next to the existing column-picker.
- `apps/web/src/lib/api/views.ts` — REMOVE the `slug: string` field from the `View` interface (it has been wrong since Phase 1). Add `useCreateView(wslug, pslug)` and `useDeleteView(wslug, pslug)` mutations. Existing `useUpdateView` stays — already covers the auto-save use case.
- `apps/web/src/lib/api/tables.ts` — verify a `useTables(wslug, pslug)` hook exists; if not, add it (read-only list).

**Create (backend):**
- None. The views API already supports full CRUD with filters/sort/visibleFields/columnOrder. No schema change. No migration.

**Modify (backend):**
- `apps/server/src/routes/views.ts` — verify POST accepts the full payload shape the frontend needs (`name`, `type`, `filters`, `sort`, `visibleFields`, `columnOrder`). It already does per Phase 1.5b. Add a regression test asserting POST returns the id (UUIDv7) the frontend will route on.

**Untouched:**
- Kanban / Board route — Phase 6 turns kanban into a render mode. In Phase 1.6 the Board tab continues to render the default kanban view and is NOT in the rail tree. (Saved kanban views are deferred to Phase 6.)
- Wiki tree — unrelated; uses its own tree component.
- The `views` DB table — no schema change.

---

## Pre-flight check (run before Task 1)

Before any code change, verify the baseline is green and surface any local drift:

- [ ] `cd /home/ntdst/Projects/folio && git status` — branch is `phase-1.6/saved-views` (create from `main` at `af3c0f1` if not already on it).
- [ ] `cd apps/server && bun test` → expect 112 / 112 pass.
- [ ] `cd apps/web && bun run test` → expect 154 / 154 pass + 1 skipped.
- [ ] `cd packages/shared && bun test` → expect 28 / 28 pass.
- [ ] Confirm `apps/web/src/lib/api/views.ts` lines 4–16 declare `slug: string` (the bug we will fix).
- [ ] Confirm `apps/server/src/db/schema.ts` `views` table has no `slug` column (lines ~246–270).

If the baseline isn't green, STOP and fix before continuing. Don't pile new work onto a broken main.

---

## Task 1: Backend — lock the POST id contract (regression test)

**Files:**
- Modify: `apps/server/src/routes/views.test.ts`

**Why:** The frontend will route on `view.id`. Phase 1.5b's tests assert POST creates a view and PATCH round-trips `columnOrder` — but no test asserts the POST response shape contains `id` as a non-empty string and that two sequential creates produce distinct ids. Lock the contract before the frontend depends on it.

Note: IDs are `nanoid()` strings, not UUIDv7. Existing POST tests assert `res.status === 201` but never reach into `data.view.id`. The actual response envelope is `{ data: { view } }` (see the existing PATCH and columnOrder tests in the same file — they extract via `data.view.id` or `data?.view ?? data ?? created.view`).

- [ ] **Step 1: Read the existing views POST tests** in `apps/server/src/routes/views.test.ts`. Note the response envelope shape from the PATCH test (`{ data: { view } }`) and the columnOrder test (`created.data?.view ?? created.data ?? created.view`).

- [ ] **Step 2: Add a regression test** asserting:
  - POST `/api/v1/w/acme/p/web/views` with `{ name: 'Id contract A', type: 'list', filters: {}, sort: [], visibleFields: ['title', 'status'], columnOrder: ['title', 'status'] }`
  - Response is `201`
  - Response body has `data.view.id` as a non-empty string (`typeof id === 'string' && id.length > 0`)
  - A second POST with `name: 'Id contract B'` returns a different `data.view.id`

- [ ] **Step 3: Run tests** — `cd apps/server && bun test`. Expect: 113 / 113 pass (was 112). Report pass count.

**Quality gate:** If the POST response doesn't include `data.view.id`, fix `apps/server/src/routes/views.ts` to include it. Do NOT proceed to Task 2 until this test passes.

---

## Task 2: Frontend API — delete `slug` lie, add `useCreateView` + `useDeleteView`

**Files:**
- Modify: `apps/web/src/lib/api/views.ts`
- Modify: any frontend file that references `view.slug` (run `grep -rn "view.slug\|view\.slug" apps/web/src` first; expected: zero or one accidental reference)

- [ ] **Step 1: Audit references to `view.slug`** — run `grep -rn "\.slug" apps/web/src/lib/api/views.ts apps/web/src/components/views apps/web/src/components/table apps/web/src/routes/w.\\$wslug 2>/dev/null`. Note any callers.

- [ ] **Step 2: Remove the `slug: string` field** from the `View` interface in `apps/web/src/lib/api/views.ts` (line 6). Update any caller found in step 1 to use `view.id` instead.

- [ ] **Step 3: Add `useCreateView`:**

```ts
export interface ViewCreate {
  name: string;
  type: 'list' | 'kanban';
  filters?: unknown;
  sort?: unknown;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  groupBy?: string | null;
  isDefault?: boolean;
  order?: number;
}

export function useCreateView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ViewCreate) =>
      client.post<View>(`/api/v1/w/${wslug}/p/${pslug}/views`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
    },
  });
}
```

- [ ] **Step 4: Add `useDeleteView`:**

```ts
export function useDeleteView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/views/${viewId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
    },
  });
}
```

- [ ] **Step 5: Run tests** — `cd apps/web && bun run test`. Expect: 154 / 154 pass + 1 skipped. Type errors from removing `.slug` will surface here; fix them. Report pass count.

---

## Task 3: Rail — extend `NavItem` with children + build `<RailTree>`

**Files:**
- Modify: `apps/web/src/components/shell/rail.tsx`
- Create: `apps/web/src/components/shell/rail-tree.tsx`
- Create: `apps/web/src/components/shell/rail-tree.test.tsx`

- [ ] **Step 1: Extend `NavItem`** in `apps/web/src/components/shell/rail.tsx`:

```ts
export interface NavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  lucideIcon?: LucideIcon;
  href?: string;
  kbd?: string;
  active?: boolean;
  onClick?: () => void;
  /** When set, the item renders as expandable in the rail tree. */
  children?: NavItem[];
  /** Optional trailing affordance, e.g. a `+ New view` button shown when expanded. */
  trailing?: ReactNode;
}
```

- [ ] **Step 2: Create `<RailTree>`** at `apps/web/src/components/shell/rail-tree.tsx`. Pure recursive renderer. Per-item expand state lives in localStorage under `folio:rail-expanded:<itemId>` (one entry per expandable item):

```tsx
import { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { cn } from '../ui/cn.ts';
import type { NavItem } from './rail.tsx';

function useExpanded(id: string, defaultOpen = false): [boolean, (v: boolean) => void] {
  const key = `folio:rail-expanded:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return defaultOpen;
    const v = localStorage.getItem(key);
    return v === null ? defaultOpen : v === '1';
  });
  useEffect(() => {
    localStorage.setItem(key, open ? '1' : '0');
  }, [key, open]);
  return [open, setOpen];
}

export function RailTree({ items, depth = 0 }: { items: NavItem[]; depth?: number }) {
  return (
    <ul className="flex flex-col gap-px">
      {items.map((item) => (
        <RailTreeNode key={item.id} item={item} depth={depth} />
      ))}
    </ul>
  );
}

function RailTreeNode({ item, depth }: { item: NavItem; depth: number }) {
  const hasChildren = !!item.children && item.children.length > 0;
  const expandableId = `${item.id}`;
  const [expanded, setExpanded] = useExpanded(expandableId, depth === 0);
  // ...render row with chevron when hasChildren, indent by depth*12px,
  // recursive <RailTree items={item.children} depth={depth+1}/> when expanded.
}
```

Match existing rail row styling (text size, hover bg, active state, icon size). Use `cn` for class merging.

- [ ] **Step 3: Update `NavList` in `rail.tsx`** so that when an item has `children`, it delegates to `<RailTree items={[item]} />`. The simplest path: filter `primary` into flat-items vs tree-items and render flat-items via the existing path, then render `<RailTree items={tree-items}/>` below.

- [ ] **Step 4: Write `rail-tree.test.tsx`** — three tests:
  1. Renders a flat item (no children) with no chevron.
  2. Renders an item with children; chevron click toggles expansion and persists to localStorage.
  3. Clicking a child invokes its `onClick`. (Test isolation: `localStorage.clear()` in `beforeEach`.)

- [ ] **Step 5: Run tests** — `cd apps/web && bun run test`. Expect: +3 passing = 157 / 157 + 1 skipped. Report pass count.

---

## Task 4: Pure builder — `buildRailTree(projects, tablesByProject, viewsByTable, currentRoute)`

**Files:**
- Create: `apps/web/src/lib/rail-tree.ts`
- Create: `apps/web/src/lib/rail-tree.test.ts`

**Why:** Keep the route file (`w.$wslug.tsx`) thin. The builder is pure, well-tested, and easy to extend later when triggers / agents / webhooks need their own nests.

- [ ] **Step 1: Define the builder signature and implement it:**

```ts
import type { NavItem } from '../components/shell/rail.tsx';

export interface RailTreeInput {
  projects: Array<{ slug: string; name: string; icon?: string | null }>;
  tablesByProject: Record<string, Array<{ id: string; slug: string; name: string; icon?: string | null }>>;
  viewsByTable: Record<string, Array<{ id: string; name: string; type: 'list' | 'kanban'; isDefault: boolean; order: number }>>;
  currentRoute: {
    wslug: string;
    pslug?: string;
    tslug?: string;
    viewId?: string;
  };
  handlers: {
    onProjectClick?: (pslug: string) => void;
    onTableClick?: (pslug: string, tslug: string) => void;
    onViewClick: (pslug: string, tslug: string, viewId: string) => void;
    onNewView: (pslug: string, tslug: string) => void;
  };
}

export function buildRailTree(input: RailTreeInput): NavItem[] {
  // For each project:
  //   children = (tablesByProject[project.slug] ?? []).map(table => ({
  //     id: `table:${project.slug}:${table.slug}`,
  //     label: table.name,
  //     children: (viewsByTable[table.id] ?? []).sort((a,b) => a.order - b.order).map(view => ({
  //       id: `view:${table.id}:${view.id}`,
  //       label: view.name,
  //       active: input.currentRoute.viewId === view.id && input.currentRoute.pslug === project.slug,
  //       onClick: () => input.handlers.onViewClick(project.slug, table.slug, view.id),
  //     })),
  //     trailing: <NewViewButton onClick={() => input.handlers.onNewView(project.slug, table.slug)} />,
  //   }));
  //   yield NavItem { id: `project:${slug}`, label: name, children }
}
```

Implementation rules:
- Filter out kanban views (Phase 1.6 ships list views only; Phase 6 brings kanban-in-rail).
- Sort views by `order` ascending, then `isDefault: true` first within the same order.
- Active flag: a view is active iff `pslug + viewId` match the current route.
- The `trailing` slot is rendered by `<RailTree>`; pass a React node, not a string. Use a tiny `+` `IconButton`.

- [ ] **Step 2: Write `rail-tree.test.ts`** — six tests:
  1. Empty projects → empty tree.
  2. One project + one table + one default view → 3-level tree with correct labels.
  3. Multiple views sort by `order`.
  4. Kanban views are filtered out.
  5. `active` flag set correctly when `currentRoute.viewId` matches.
  6. Handlers wired: clicking a leaf calls `handlers.onViewClick` with the right args.

- [ ] **Step 3: Run tests** — `cd apps/web && bun run test`. Expect: +6 = 163 / 163 + 1 skipped. Report pass count.

---

## Task 5: Wire the workspace route to build + pass the tree

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx`

- [ ] **Step 1: In `w.$wslug.tsx`**, replace the existing flat `primary` builder. Roughly:

```tsx
const { data: projects } = useProjects(wslug);
// For each project, fetch its tables. (one useTables per project — small N, fine for v1.)
// For each table, fetch its views.
// Then:
const tree = useMemo(() => buildRailTree({
  projects: projects ?? [],
  tablesByProject,
  viewsByTable,
  currentRoute: { wslug, pslug, tslug, viewId },
  handlers: {
    onViewClick: (ps, ts, vid) => navigate({ to: `/w/${wslug}/p/${ps}/work-items`, search: { view: vid } }),
    onNewView: (ps, ts) => openNewViewSheet({ wslug, pslug: ps, tslug: ts }),
  },
}), [projects, tablesByProject, viewsByTable, wslug, pslug, tslug, viewId]);
```

Then pass `primary={tree}` to `<Rail>`.

- [ ] **Step 2: Per-project useTables / useViews fetching.** v1 strategy: render-time fetches with react-query — `useTables(wslug, project.slug)` once per project, `useViews(wslug, project.slug)` once per project (the views endpoint is project-scoped; client filters by `tableId` for the tree). Accept the N+1 for now; the rail is loaded once per workspace switch and rarely refetched. Note this in a `// TODO Phase 7:` comment for the perf pass.

- [ ] **Step 3: Manual smoke** — run `bun dev`, sign in, navigate to a workspace with at least one project. Confirm the rail shows `Project → Table → Views` and clicking a view changes the URL. Click the `+` and observe the New View sheet open (it's wired in Task 6 — for now, just `console.log`).

- [ ] **Step 4: Run tests** — `cd apps/web && bun run test`. Expect no regressions; same 163 pass count. Report pass count.

---

## Task 6: New View sheet

**Files:**
- Create: `apps/web/src/components/views/new-view-sheet.tsx`
- Create: `apps/web/src/components/views/new-view-sheet.test.tsx`
- Modify: `apps/web/src/routes/w.$wslug.tsx` — open the sheet on `onNewView`.

- [ ] **Step 1: Build the sheet** using the existing `<Sheet>` primitive (the same one used by "Create workspace" — see `apps/web/src/components/shell/workspace-switcher.tsx` for the pattern). Body fields:

  - `<input>` — view name (required, max 100 chars)
  - `<Checkbox>` — "Use current URL filters / sort / columns" (default: checked)
  - Submit button labeled `Create view`

- [ ] **Step 2: On submit:**
  - If "use current" is checked: read `filters` / `sort` / `visibleFields` / `columnOrder` from the URL search params (use TanStack Router's `useSearch`).
  - Else: send empty `filters: {}`, no `sort`, empty `visibleFields`, no `columnOrder`.
  - Call `useCreateView` with the payload.
  - On success: close the sheet, navigate to `?view=<new.id>`, toast `View created`.
  - On failure: keep sheet open, render the API error inline.

- [ ] **Step 3: Write `new-view-sheet.test.tsx`** — four tests:
  1. Renders with checkbox checked by default.
  2. Submitting with "use current" unchecked sends the empty-payload shape.
  3. Submitting calls `useCreateView` with the URL search params when "use current" is checked.
  4. On mutation success, the navigation handler is invoked with the new view's id.

- [ ] **Step 4: Run tests** — `cd apps/web && bun run test`. Expect: +4 = 167 / 167 + 1 skipped. Report pass count.

---

## Task 7: TableView wires up `?view=`

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` — extend `validateSearch`.
- Modify: `apps/web/src/components/table/table-view.tsx`.

- [ ] **Step 1: Extend the route's `validateSearch`** to accept `view?: string` (server-side IDs are nanoid — short alphanumeric, not UUID. Validate as a non-empty string; the server is the source of truth for whether the id exists):

```ts
validateSearch: z.object({
  // ...existing...
  view: z.string().min(1).optional(),
}),
```

- [ ] **Step 2: In `table-view.tsx`**, replace the existing `activeView = default || first` line (lines 63–68 per the Explore agent's findings) with:

```ts
const { view: urlViewId } = Route.useSearch();
const { data: views } = useViews(wslug, pslug);
const activeView = useMemo(() => {
  if (urlViewId && views) {
    const found = views.find((v) => v.id === urlViewId);
    if (found) return found;
  }
  return views?.find((v) => v.isDefault) ?? views?.[0] ?? null;
}, [urlViewId, views]);
```

- [ ] **Step 3: On `activeView` change, hydrate URL filters from the view** (one-way, view → URL, only on initial mount per view). Pseudocode:

```ts
useEffect(() => {
  if (!activeView) return;
  const filters = activeView.filters as Record<string, unknown> | null;
  if (!filters) return;
  // Map activeView.filters into the same flat URL params the work-items route
  // already uses (?status=, ?priority=, ?assignee=, ?labels=, ?updated_since=).
  // Use navigate({ search: { ...current, ...mapped }, replace: true }).
}, [activeView?.id]);
```

The map from `views.filters` (the AST shape) to the flat URL params is already partly implemented for the default view in Phase 1 — extract that to `lib/view-filters-to-url.ts` if it's still inline, and reuse here.

- [ ] **Step 4: Auto-save column / sort / visibleFields changes** — find the existing column-reorder / column-picker / sort handlers in `table-header.tsx` (Phase 1.5b shipped these). Wire them to call `useUpdateView` with the changed field. Phase 1.5b already does this for `columnOrder`; extend the same handler shape to `sort` (today: writes to URL only) and `visibleFields` (today: writes to URL only).

- [ ] **Step 5: Write a test** in `apps/web/src/components/table/table-view.test.tsx`:
  - Given two views (default + one named "Triage" with `filters: { status: { $eq: 'In Progress' }}`)
  - Render `<TableView>` with `?view=<triage.id>` in the route search
  - Assert the URL gets `?status=In Progress` written within one effect tick.

- [ ] **Step 6: Run tests** — `cd apps/web && bun run test`. Expect: +1 = 168 / 168 + 1 skipped. Report pass count.

---

## Task 8: "Save filters to this view" action

**Files:**
- Create: `apps/web/src/components/views/save-filters-action.tsx`
- Create: `apps/web/src/components/views/save-filters-action.test.tsx`
- Modify: `apps/web/src/components/table/table-header.tsx` — render the action when the URL filters diverge from the active view's filters.

- [ ] **Step 1: Build a small `<SaveFiltersAction>`** component: a subtle "Save filters" button (matches `ChipAdd` styling from Phase 1.5). Props: `viewId`, `currentFilters` (from URL), `viewFilters` (from active view), `onSaved?`.

- [ ] **Step 2: Visibility rule:** only show the button when `JSON.stringify(currentFilters) !== JSON.stringify(viewFilters)`. (Cheap equality check — filters are small shallow objects.)

- [ ] **Step 3: Click → PATCH** the view's `filters` field via `useUpdateView`. Show a confirm dialog: "Save current filters to '<view name>'? This will overwrite the view's saved filters." (yes / cancel)

- [ ] **Step 4: Render the action** in the table header, next to the column-picker button. Place to the right of the filter chips.

- [ ] **Step 5: Write `save-filters-action.test.tsx`** — three tests:
  1. Hidden when filters match.
  2. Shown when filters differ.
  3. Click → mutation called with the URL filters.

- [ ] **Step 6: Run tests** — `cd apps/web && bun run test`. Expect: +3 = 171 / 171 + 1 skipped. Report pass count.

---

## Task 9: Auto-save sort + visibleFields (parity with 1.5b's columnOrder)

**Files:**
- Modify: `apps/web/src/components/table/table-header.tsx` (or wherever sort + column-picker handlers live).

**Why:** Decision was "always-on auto-save." Phase 1.5b auto-saves `columnOrder` to the active view but `sort` and `visibleFields` only write to URL. This task closes that gap.

- [ ] **Step 1: Find the sort handler** — search for where clicking a sortable header writes `?sort=` and `?dir=`. Today it likely calls `navigate({ search: ... })`.

- [ ] **Step 2: Extend the handler** to also call `useUpdateView` with `sort: [{ key, dir }]` (the DB shape — array of `{key, dir}` objects per Phase 1.5b's schema).

- [ ] **Step 3: Find the column-visibility handler** in `column-picker.tsx` — extend the same way to PATCH `visibleFields`.

- [ ] **Step 4: Reconcile the URL ↔ view sort shape** — URL has flat `?sort=<key>&dir=<dir>`, view has array `[{key, dir}]`. For v1, only single-column sort is supported; both shapes carry the same info. Document this in `apps/web/src/lib/sort-shape.md` (1 short paragraph) and add a TODO for multi-column sort.

- [ ] **Step 5: Write a regression test** in `table-view.test.tsx`: clicking a sortable column header fires both the URL change AND the `useUpdateView` mutation with the right `sort` array.

- [ ] **Step 6: Run tests** — `cd apps/web && bun run test`. Expect: +1 = 172 / 172 + 1 skipped. Report pass count.

---

## Task 10: Manual QA + Playwright

**Files:**
- Modify: `apps/web/tests/e2e/click-through.spec.ts` — add a new "saved views" journey.

- [ ] **Step 1: Boot the dev stack** (`bun dev`). Sign in as `stefan@netdust.be`. Do the following journey by hand and confirm nothing is broken:

  1. Rail shows `Acme Sales → Work Items → (All work items · Board · ...)`. (Board appears in default-view list iff Task 4's kanban filter is wrong — should be filtered out.)
  2. Click "All work items" → URL becomes `/w/acme/p/sales/work-items?view=<uuid>`.
  3. Click the `+` next to "Work Items" → New View sheet opens.
  4. Type "Triage", uncheck "use current", submit → toast appears, sheet closes, rail gets a new entry, URL navigates to it.
  5. With Triage active, add a filter chip `Status is In Progress`. The "Save filters" button appears.
  6. Click Save filters → confirm dialog → confirm → button disappears (filters now match the view).
  7. Refresh the page. Filter is still applied via the view, NOT via the URL persistence (URL still has `?status=In Progress` because step 3 of Task 7 writes it from view → URL).
  8. Click "All work items" → filter chip clears, sort resets.
  9. Drag a column header to reorder it. Click back to "Triage" then back to "All work items" — the reorder persisted to "All work items" (auto-save) and Triage has its own order.

- [ ] **Step 2: Add a Playwright spec** at the bottom of `apps/web/tests/e2e/click-through.spec.ts`: `saved views: create, navigate, save filters`. Steps mirror the manual journey above 1–6. Use `data-testid="rail-tree-item"` attributes added in Task 3.

- [ ] **Step 3: Run e2e** — `cd apps/web && bun run e2e`. Expect: +1 = 27 / 27 pass (allow the 1 known-flake from STATE.md). Report pass count + which spec, if any, flaked.

- [ ] **Step 4: Run the full suite one more time** — `cd apps/server && bun test && cd ../web && bun run test`. Expect: 113 server + 172 web (+1 skipped) all green.

---

## Phase 1.6 acceptance (mirrors PHASES.md §1.6)

- [ ] Three views can coexist on one table; switching between them updates the spreadsheet without page reload.
- [ ] Creating a view from "current state" captures filters + columns + sort accurately.
- [ ] Editing a view's filter via "Save filters" round-trips through the URL params correctly.
- [ ] Existing single-view tests still green.
- [ ] Kanban Board tab still works exactly as before (untouched).
- [ ] Server: 113 / 113 unit. Web: 172 / 172 + 1 skipped. Shared: 28 / 28. E2E: 27 / 27 (or 1 documented flake).
- [ ] Final commit: `phase-1.6: complete`.
- [ ] Update `memory/STATE.md` and `docs/PHASES.md` (check the 1.6 boxes).

---

## Out of scope for Phase 1.6

- Kanban views in the rail (Phase 6 turns kanban into a render mode).
- Calendar / timeline views (Phase 1.8 + Phase 6).
- Renaming or deleting a view from the rail context menu (Phase 7 polish).
- Drag-to-reorder views in the rail (Phase 7 polish).
- Per-view permissions (post-v1).
- Personal vs shared views (post-v1 — all views are project-scoped + shared in v1).
- Multi-column sort (TODO from Task 9).
