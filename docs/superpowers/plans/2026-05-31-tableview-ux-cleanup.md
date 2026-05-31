# TableView UX cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the work-items TableView fully usable by a human: working server-side sort on built-in columns, a pinned right-most settings column, a corrected project tab bar (icons + no Wiki), and a card-style wiki overview.

**Architecture:** Server sort is added to `listDocuments` with a sort-aware keyset cursor (built-ins only: title/status/updated_at). The pinned settings column is a layout-only sticky sibling rendered after the grid in both `TableHeader` and `TableRow` (mirrors the existing `trailing` slot + sticky-left title cell — no `gridTemplate` change). The tab bar drops Wiki and gains icons. The wiki overview renders root pages as cards (title + body excerpt + child count) while keeping the existing tree + drag-to-reparent underneath.

**Tech Stack:** Bun + Hono + Drizzle (server), React + TanStack Router + Tailwind (web), Bun test. Spec: `docs/superpowers/specs/2026-05-31-tableview-ux-cleanup-design.md`.

**Key source facts (verified 2026-05-31):**
- `listDocuments` (`apps/server/src/services/documents.ts:246-258`) does `.select()` (full rows incl. `body`), hard-codes `.orderBy(desc(documents.updatedAt), desc(documents.id))`, cursor = base64 `updatedAt:id` (`encodeCursor`/`decodeCursor` at :92-103).
- List route (`apps/server/src/routes/documents.ts:130-197`) reads `type/limit/cursor/filter/status/assignee/updated_since/stale_for` — **never `sort`/`dir`** — and returns `result.data` un-projected (so `body` already crosses the wire).
- Client `DocumentSummary` (`apps/web/src/lib/api/documents.ts:14-27`) under-declares the row: no `body` field, though the server sends it.
- `TableHeader` (`apps/web/src/components/table/table-header.tsx`): outer `flex … gap-2`; child 1 = the grid (`flex-1`, `gridTemplate`); optional `trailing` = `flex-shrink-0` sibling. `SORTABLE_BUILTIN_KEYS = ['title','status','updated_at']` (:15).
- `TableRow` (`apps/web/src/components/table/table-row.tsx`): outer `flex … gap-2`; child = grid (`flex-1`, `gridTemplate`). No trailing slot today.
- `ColumnPicker` (`apps/web/src/components/table/column-picker.tsx`): `IconButton` trigger (Settings2) → popover. Currently mounted in TableView's top bar (`table-view.tsx:404-410`).
- `FrameTab` (`apps/web/src/components/shell/main-frame.tsx:50-71`): `{active, onClick, children}`.
- Project tabs: `TABS` array in `apps/web/src/routes/w.$wslug.p.$pslug.tsx:18-22`; `onCreate` branches on `activeTab === 'wiki'` (:44).
- Wiki: `WikiTree` (`apps/web/src/components/views/wiki-tree.tsx`) — `buildTree` by parent_id, drag-to-reparent, root nodes rendered as `<TreeRow depth=0>` in a `<ul>`.

---

## Task 1: Server sort — `listDocuments` accepts sort/dir with a sort-aware keyset cursor

**Files:**
- Modify: `apps/server/src/services/documents.ts` (`ListDocumentsOpts`, `encodeCursor`/`decodeCursor`, query block ~:117-258)
- Test: `apps/server/src/services/documents.sort.test.ts` (create)

This is the core correctness task. The cursor must follow the sort or pagination silently drops/dupes rows.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/services/documents.sort.test.ts`. Follow the existing service-test setup pattern from `apps/server/src/services/documents.test.ts` (in-memory DB + migrate + seed a project/table). If that file exists, copy its `beforeEach` harness verbatim; otherwise use the harness from `apps/server/src/lib/filter-to-drizzle.test.ts`. Seed **5 work items** with distinct titles, statuses, and `updatedAt` values so every sort is unambiguous.

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { listDocuments } from './documents.ts';
// + the shared in-memory DB harness (copy from documents.test.ts beforeEach)

describe('listDocuments sort', () => {
  // beforeEach: migrate + seed project P with table T + 5 work_items:
  //   { title: 'Apple',  status: 'todo',        updatedAt: t+10 }
  //   { title: 'Cherry', status: 'in_progress', updatedAt: t+40 }
  //   { title: 'Banana', status: 'done',        updatedAt: t+20 }
  //   { title: 'Date',   status: 'backlog',     updatedAt: t+50 }
  //   { title: 'Elder',  status: 'todo',        updatedAt: t+30 }

  test('default sort is updated_at desc (unchanged)', async () => {
    const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item' });
    expect(r.data.map((d) => d.title)).toEqual(['Date', 'Cherry', 'Elder', 'Banana', 'Apple']);
  });

  test('sort by title asc', async () => {
    const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'title', dir: 'asc' });
    expect(r.data.map((d) => d.title)).toEqual(['Apple', 'Banana', 'Cherry', 'Date', 'Elder']);
  });

  test('sort by title desc', async () => {
    const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'title', dir: 'desc' });
    expect(r.data.map((d) => d.title)).toEqual(['Elder', 'Date', 'Cherry', 'Banana', 'Apple']);
  });

  test('sort by status asc orders by stored status string', async () => {
    const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'status', dir: 'asc' });
    // backlog < done < in_progress < todo (alpha on the stored value); 'todo' has two rows
    expect(r.data.map((d) => d.status)).toEqual(['backlog', 'done', 'in_progress', 'todo', 'todo']);
  });

  test('invalid sort key falls back to updated_at desc', async () => {
    const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'nonsense' as never, dir: 'asc' });
    expect(r.data.map((d) => d.title)).toEqual(['Date', 'Cherry', 'Elder', 'Banana', 'Apple']);
  });

  test('keyset pagination under title asc drops/dupes nothing across the boundary', async () => {
    const opts = { projectId: P, activeTableId: T, type: 'work_item' as const, sort: 'title' as const, dir: 'asc' as const };
    const page1 = await listDocuments({ ...opts, limit: 2 });
    expect(page1.data.map((d) => d.title)).toEqual(['Apple', 'Banana']);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listDocuments({ ...opts, limit: 2, cursor: page1.nextCursor! });
    expect(page2.data.map((d) => d.title)).toEqual(['Cherry', 'Date']);
    const page3 = await listDocuments({ ...opts, limit: 2, cursor: page2.nextCursor! });
    expect(page3.data.map((d) => d.title)).toEqual(['Elder']);
    expect(page3.nextCursor).toBeNull();
    // union is the full set, no repeats
    const all = [...page1.data, ...page2.data, ...page3.data].map((d) => d.title);
    expect(new Set(all).size).toBe(5);
  });

  test('a cursor minted under one sort is ignored under a different sort (restarts page 1)', async () => {
    const p1 = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'title', dir: 'asc', limit: 2 });
    // Reuse that cursor but request updated_at desc — cursor sort key mismatches → treated as absent.
    const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'updated_at', dir: 'desc', limit: 2, cursor: p1.nextCursor! });
    expect(r.data.map((d) => d.title)).toEqual(['Date', 'Cherry']); // page 1 of updated_at desc
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/services/documents.sort.test.ts`
Expected: FAIL — `listDocuments` doesn't accept `sort`/`dir`; all non-default cases return `updated_at desc`.

- [ ] **Step 3: Implement sort + sort-aware cursor**

In `apps/server/src/services/documents.ts`:

(a) Add an allow-list + types near the top of the file (after imports):

```ts
// Built-in sortable columns. The mapping string→column object is the ONLY
// way a sort key reaches Drizzle — never interpolate the raw string into SQL.
const SORT_COLUMNS = {
  title: documents.title,
  status: documents.status,
  updated_at: documents.updatedAt,
} as const;
export type SortKey = keyof typeof SORT_COLUMNS;
export type SortDir = 'asc' | 'desc';

function resolveSort(sort?: string, dir?: string): { key: SortKey; dir: SortDir } {
  const key = (sort && sort in SORT_COLUMNS ? sort : 'updated_at') as SortKey;
  const d: SortDir = dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : key === 'updated_at' ? 'desc' : 'asc';
  return { key, dir: d };
}
```

(b) Replace the cursor codec so it carries the sort key + a string-encoded sort value:

```ts
// Cursor payload: `${sortKey}:${b64(sortValue)}:${id}`. sortValue is the row's
// value for the active sort column, stringified (epoch ms for updated_at).
function encodeCursor(sortKey: SortKey, sortValue: string, id: string): string {
  return Buffer.from(`${sortKey}:${Buffer.from(sortValue).toString('base64')}:${id}`).toString('base64');
}
function decodeCursor(s: string): { sortKey: SortKey; sortValue: string; id: string } | null {
  try {
    const [sortKey, b64v, id] = Buffer.from(s, 'base64').toString().split(':');
    if (!sortKey || !(sortKey in SORT_COLUMNS) || b64v === undefined || !id) return null;
    return { sortKey: sortKey as SortKey, sortValue: Buffer.from(b64v, 'base64').toString(), id };
  } catch {
    return null;
  }
}
```

(c) Add `sort?: string; dir?: string;` to `ListDocumentsOpts` (the opts interface ~:117).

(d) Replace the query block (~:236-258). Import `asc`, `gt`, `lt` from `drizzle-orm` (alongside the existing `desc`, `lt` — check the import line :14 and add only what's missing):

```ts
  const { key: sortKey, dir: sortDir } = resolveSort(opts.sort, opts.dir);
  const sortCol = SORT_COLUMNS[sortKey];
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  // A cursor minted under a different sort is meaningless here — start from page 1.
  const cursor = decoded && decoded.sortKey === sortKey ? decoded : null;

  if (cursor) {
    // Reconstruct the comparable sort value. updated_at is stored as a Date;
    // compare on epoch ms. title/status compare as strings.
    const cmpGt = sortDir === 'asc' ? gt : lt;
    if (sortKey === 'updated_at') {
      const ts = new Date(Number(cursor.sortValue));
      whereClauses.push(
        or(
          cmpGt(documents.updatedAt, ts),
          and(eq(documents.updatedAt, ts), cmpGt(documents.id, cursor.id)),
        ) as never,
      );
    } else {
      whereClauses.push(
        or(
          cmpGt(sortCol, cursor.sortValue),
          and(eq(sortCol, cursor.sortValue), cmpGt(documents.id, cursor.id)),
        ) as never,
      );
    }
  }

  const dirFn = sortDir === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(documents)
    .where(and(...whereClauses))
    .orderBy(dirFn(sortCol), dirFn(documents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) {
    const sortValue =
      sortKey === 'updated_at' ? String(last.updatedAt.getTime()) : String((last as Record<string, unknown>)[sortKey] ?? '');
    nextCursor = encodeCursor(sortKey, sortValue, last.id);
  }
  return { data: page, nextCursor };
```

Delete the old `if (cursor) { … }` block and the old `.orderBy(desc(...))` + `nextCursor` lines this replaces.

> Note: keep the existing `updated_since`/`stale_for` filter clauses (~:201) intact — they're independent of sort and stay above this block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/services/documents.sort.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Run the full server suite for regressions**

Run: `bun test apps/server`
Expected: PASS. Pay attention to existing `documents.test.ts` pagination tests — the cursor format changed, so any test asserting the *literal* cursor string must be updated (they should assert behavior, not the opaque token; fix any that don't).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/documents.ts apps/server/src/services/documents.sort.test.ts
git commit -m "phase-3.x: listDocuments accepts built-in sort with a sort-aware keyset cursor"
```

---

## Task 2: Server sort — wire `sort`/`dir` query params through the list route

**Files:**
- Modify: `apps/server/src/routes/documents.ts:130-197` (list handler)
- Test: `apps/server/src/routes/documents.sort.test.ts` (create) — or append to an existing route test if the harness is already there.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/routes/documents.sort.test.ts`. Use the existing route-test harness (copy the app/auth/seed setup from `apps/server/src/routes/documents.test.ts`). Seed ≥3 work items with distinct titles.

```ts
test('GET /documents?sort=title&dir=asc orders by title ascending', async () => {
  const res = await app.request(`/api/v1/w/${ws}/p/${pj}/documents?type=work_item&sort=title&dir=asc`, { headers: authHeaders });
  expect(res.status).toBe(200);
  const body = await res.json();
  const titles = body.data.map((d: { title: string }) => d.title);
  expect(titles).toEqual([...titles].sort()); // ascending
});

test('GET /documents with no sort still defaults to updated_at desc', async () => {
  const res = await app.request(`/api/v1/w/${ws}/p/${pj}/documents?type=work_item`, { headers: authHeaders });
  const body = await res.json();
  // newest first — assert the most-recently-updated seed is index 0 (use the seed you created last)
  expect(body.data[0].title).toBe(/* last-updated seed title */);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/server/src/routes/documents.sort.test.ts`
Expected: FAIL — route ignores `sort`, returns `updated_at desc`.

- [ ] **Step 3: Wire the params**

In `apps/server/src/routes/documents.ts`, inside the list handler, add `sort`/`dir` to the `listDocuments` call:

```ts
  const result = await listDocuments({
    projectId: p.id,
    activeTableId,
    type,
    limit: limitRaw !== undefined ? Math.min(200, Number(limitRaw)) : 50,
    cursor: cursorRaw,
    filter,
    statusValues: c.req.queries('status') ?? [],
    assignee: c.req.query('assignee') ?? undefined,
    updatedSince: c.req.query('updated_since') ?? undefined,
    staleFor: c.req.query('stale_for') ?? undefined,
    sort: c.req.query('sort') ?? undefined,
    dir: c.req.query('dir') ?? undefined,
  });
```

No validation needed at the route — `resolveSort` (Task 1) silently coerces unknown keys to the default, which is the spec's "silent fallback, never error" behavior.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/server/src/routes/documents.sort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.sort.test.ts
git commit -m "phase-3.x: list route passes sort/dir query params to listDocuments"
```

> After this task: the client already sends `sort`/`dir` (`table-view.tsx:235`) and clickability is already gated to built-ins (`table-header.tsx:15`), so clicking Title/Status/Updated headers now reorders correctly. No web change needed for sort. Verify manually in the shake-out (Task 6).

---

## Task 3: Pinned right-most settings column (web, layout-only)

**Files:**
- Modify: `apps/web/src/components/table/table-header.tsx` (add a pinned settings slot after the grid)
- Modify: `apps/web/src/components/table/table-row.tsx` (add the matching empty pinned cell)
- Modify: `apps/web/src/components/table/table-view.tsx` (move ColumnPicker out of the top bar into the header's settings slot)
- Test: `apps/web/src/components/table/table-view.test.tsx` (append cases) — reuse the existing render harness in that file.

**Approach (locked):** the settings column is a sticky `flex-shrink-0` sibling rendered *after* the grid in both header and row — exactly how `TableHeader` already appends `trailing`. No `gridTemplate` change.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/components/table/table-view.test.tsx` (match its existing imports/render helper):

```tsx
test('renders a pinned settings column header that opens the column picker', async () => {
  renderTableView(/* existing helper args */);
  const settingsBtn = await screen.findByRole('button', { name: /columns/i });
  expect(settingsBtn).toBeInTheDocument();
  // it lives in the table header region, not a separate top bar
  expect(settingsBtn.closest('[data-testid="table-settings-col"]')).toBeTruthy();
});

test('the top filter bar no longer contains the column picker', async () => {
  renderTableView(/* existing helper args */);
  const filterBar = screen.getByTestId('filter-bar'); // add data-testid to FilterBar wrapper if absent
  expect(within(filterBar).queryByRole('button', { name: /columns/i })).toBeNull();
});
```

If `FilterBar` lacks a `data-testid`, add `data-testid="filter-bar"` to its root element in `apps/web/src/components/filter/filter-bar.tsx` as part of this task.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/components/table/table-view.test.tsx`
Expected: FAIL — no `table-settings-col`; picker still in the top bar.

- [ ] **Step 3: Add a `settings` slot to `TableHeader`**

In `apps/web/src/components/table/table-header.tsx`:
- Add `settings?: ReactNode;` to `Props`.
- Render it as a sticky-right sibling after `trailing`, inside the outer flex row:

```tsx
      {trailing ? <div className="flex-shrink-0">{trailing}</div> : null}
      {settings ? (
        <div
          data-testid="table-settings-col"
          className="sticky right-0 z-[1] flex h-full w-11 flex-shrink-0 items-center justify-center border-l border-border-light bg-content"
        >
          {settings}
        </div>
      ) : null}
```

(`w-11` = 44px.)

- [ ] **Step 4: Add the matching empty pinned cell to `TableRow`**

In `apps/web/src/components/table/table-row.tsx`, after the grid `<div>` (the `flex-1` block), add a sticky-right empty cell so rows align under the header settings column:

```tsx
        </div>
        <div
          aria-hidden
          className="sticky right-0 z-[1] w-11 flex-shrink-0 self-stretch border-l border-border-light bg-content group-hover/row:bg-card"
        />
      </div>
```

(The `group-hover/row:bg-card` keeps the pinned cell's background in sync with the row hover so it doesn't read as a seam.)

- [ ] **Step 5: Move `ColumnPicker` into the header's `settings` slot in `TableView`**

In `apps/web/src/components/table/table-view.tsx`:
- Remove the `<ColumnPicker .../>` from the top bar (`:404-410`); leave `<FilterBar .../>` as the sole child of that row. The wrapper `div` (`:397`) can keep `justify-between` (harmless with one child) or simplify to just the FilterBar — keep it minimal, leave the wrapper.
- Pass the picker into the header's new `settings` prop:

```tsx
          <TableHeader
            columns={visibleColumns}
            sort={sort}
            onSort={onSortChange}
            onReorder={onReorder}
            trailing={<TableAddColumn onSubmit={onAddColumn} />}
            settings={
              <ColumnPicker
                columns={allColumns}
                visibleKeys={visibleKeys}
                onChange={onVisibilityChange}
                suggestions={suggestions}
                onPinSuggestion={onPinSuggestion}
              />
            }
            renderColumnMenu={renderColumnMenu}
            renamingKey={renamingKey}
            onRenameCommit={onRenameCommit}
          />
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test apps/web/src/components/table/table-view.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the web suite for regressions**

Run: `bun test apps/web/src/components/table`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/table/table-header.tsx apps/web/src/components/table/table-row.tsx apps/web/src/components/table/table-view.tsx apps/web/src/components/filter/filter-bar.tsx apps/web/src/components/table/table-view.test.tsx
git commit -m "phase-3.x: pin the column-settings picker as a sticky right-most table column"
```

---

## Task 4: Project tab bar — icons + remove Wiki

**Files:**
- Modify: `apps/web/src/components/shell/main-frame.tsx:50-71` (`FrameTab` gains optional icon)
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.tsx:18-59` (TABS, render, onCreate)
- Test: `apps/web/src/routes/w.$wslug.p.$pslug.test.tsx` (create or append) — if no route test exists, create a focused render test for the tab list.

- [ ] **Step 1: Write the failing test**

Create/append `apps/web/src/routes/w.$wslug.p.$pslug.test.tsx`. Render `ProjectLayout` with the existing route-render harness used elsewhere in `apps/web/src/routes` tests (copy a sibling's `renderRoute` setup; mock `useProject`/`useDocuments` to return a loaded project + empty lists). Assert:

```tsx
test('project tab bar shows Work items and Board, with icons, and no Wiki tab', async () => {
  renderProjectLayout();
  expect(await screen.findByRole('tab', { name: /work items/i })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /board/i })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: /wiki/i })).toBeNull();
  // each tab carries an icon (lucide renders an <svg>)
  expect(within(screen.getByRole('tab', { name: /work items/i })).querySelector('svg')).toBeTruthy();
  expect(within(screen.getByRole('tab', { name: /board/i })).querySelector('svg')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test "apps/web/src/routes/w.\$wslug.p.\$pslug.test.tsx"`
Expected: FAIL — Wiki tab still present; no icons.

- [ ] **Step 3: Add an optional icon to `FrameTab`**

In `apps/web/src/components/shell/main-frame.tsx`:
- Import `Icon` and a lucide type: `import type { LucideIcon } from 'lucide-react';` and the existing `Icon` wrapper (`../ui/icon.tsx` — match the import style used by sibling shell components).
- Extend `TabProps` and render:

```tsx
interface TabProps {
  active?: boolean;
  onClick?: () => void;
  icon?: LucideIcon;
  children: ReactNode;
}

export function FrameTab({ active = false, onClick, icon, children }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[11px] transition-colors duration-fast',
        active ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:bg-card',
      )}
    >
      {icon ? <Icon icon={icon} size={13} /> : null}
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Update TABS + render + onCreate**

In `apps/web/src/routes/w.$wslug.p.$pslug.tsx`:
- Import icons: `import { Plus, Loader2, List, Columns3 } from 'lucide-react';`
- Replace `TABS`:

```tsx
const TABS = [
  { id: 'work-items', label: 'Work items', path: 'work-items' as const, icon: List },
  { id: 'board', label: 'Board', path: 'board' as const, icon: Columns3 },
];
```

- Pass the icon in the map (`:69-83`): `<FrameTab key={t.id} active={activeTab === t.id} icon={t.icon} onClick={...}>{t.label}</FrameTab>`
- Simplify `onCreate` (`:43-51`) — drop the wiki branch:

```tsx
  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title: 'Untitled' });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
```

- Replace `actionLabel` (`:53`) usage with the literal `"New work item"` in the button (`:57`). Remove the now-unused `actionLabel` const.

> The `/wiki` route and its rail node are untouched — Wiki stays reachable via the left rail.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test "apps/web/src/routes/w.\$wslug.p.\$pslug.test.tsx"`
Expected: PASS.

- [ ] **Step 6: Run web suite + typecheck**

Run: `bun test apps/web && bun --filter=web exec tsc --noEmit` (or the repo's web typecheck script — check `apps/web/package.json`)
Expected: PASS, no type errors (catches any dangling `actionLabel` reference).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/shell/main-frame.tsx "apps/web/src/routes/w.\$wslug.p.\$pslug.tsx" "apps/web/src/routes/w.\$wslug.p.\$pslug.test.tsx"
git commit -m "phase-3.x: project tab bar — icons on Work items/Board, drop the Wiki tab"
```

---

## Task 5: Wiki overview — root pages as cards (title + excerpt + child count), tree preserved inside

**Files:**
- Modify: `apps/web/src/lib/api/documents.ts:14-27` (widen `DocumentSummary` to include `body`)
- Create: `apps/web/src/lib/excerpt.ts` (pure body→excerpt helper)
- Create: `apps/web/src/components/views/wiki-card.tsx` (a single root-page card)
- Modify: `apps/web/src/components/views/wiki-tree.tsx` (render roots as a card grid; expand reveals the existing TreeRow subtree)
- Test: `apps/web/src/lib/excerpt.test.ts` (create), `apps/web/src/components/views/wiki-tree.test.tsx` (append)

**Key fact:** the list response already includes `body` over the wire (server `.select()` + un-projected `data`); the client type just doesn't declare it. So no server change is needed.

- [ ] **Step 1: Write the failing excerpt test**

Create `apps/web/src/lib/excerpt.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { bodyExcerpt } from './excerpt.ts';

describe('bodyExcerpt', () => {
  test('strips a leading H1 and returns the first prose line', () => {
    expect(bodyExcerpt('# Title\n\nFirst real line here.\n\nmore')).toBe('First real line here.');
  });
  test('strips common markdown markers', () => {
    expect(bodyExcerpt('- **bold** item')).toBe('bold item');
  });
  test('truncates to maxLen with an ellipsis', () => {
    expect(bodyExcerpt('a'.repeat(200), 20)).toBe(`${'a'.repeat(20)}…`);
  });
  test('empty / whitespace body returns empty string', () => {
    expect(bodyExcerpt('   \n\n')).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/lib/excerpt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bodyExcerpt`**

Create `apps/web/src/lib/excerpt.ts`:

```ts
/**
 * Plain-text excerpt from a markdown body for card previews. Skips a leading
 * H1 (it duplicates the title), takes the first non-empty line, strips the
 * common inline/line markers, and truncates. Intentionally cheap — not a full
 * markdown parser.
 */
export function bodyExcerpt(body: string, maxLen = 120): string {
  const lines = body.split('\n').map((l) => l.trim());
  for (const line of lines) {
    if (!line) continue;
    if (/^#\s/.test(line)) continue; // skip leading H1/heading
    const text = line
      .replace(/^[-*+]\s+/, '')        // list bullet
      .replace(/^>\s+/, '')            // blockquote
      .replace(/^#+\s+/, '')           // residual heading marks
      .replace(/\*\*(.*?)\*\*/g, '$1') // bold
      .replace(/\*(.*?)\*/g, '$1')     // italic
      .replace(/`(.*?)`/g, '$1')       // code
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // links → text
      .trim();
    if (!text) continue;
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  }
  return '';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/web/src/lib/excerpt.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen `DocumentSummary` to carry `body`**

In `apps/web/src/lib/api/documents.ts`, add `body: string;` to the `DocumentSummary` interface (`:14-27`). Since `Document extends DocumentSummary` and already redeclares `body: string` (`:30`), remove the now-redundant `body` line from `Document` to avoid a duplicate-member lint (or leave both — identical types, harmless; prefer removing for cleanliness).

> This is safe: the server already sends `body` in list rows. Other list consumers (TableView, kanban) ignore the extra field.

- [ ] **Step 6: Write the failing wiki-card test**

Append to `apps/web/src/components/views/wiki-tree.test.tsx` (match its existing render harness + query-mock pattern). Seed two root pages, one with a child:

```tsx
test('wiki overview renders root pages as cards with excerpt and child count', async () => {
  // mock useDocuments → pages: [{id:'r1',title:'Guide',body:'# Guide\n\nHow to start.',parentId:null},
  //                             {id:'r2',title:'FAQ',body:'Questions.',parentId:null},
  //                             {id:'c1',title:'Step 1',body:'',parentId:'r1'}]
  renderWiki();
  expect(await screen.findByText('Guide')).toBeInTheDocument();
  expect(screen.getByText('How to start.')).toBeInTheDocument();   // excerpt
  expect(screen.getByText(/1 page/i)).toBeInTheDocument();          // child count on r1
  expect(screen.getByText('FAQ')).toBeInTheDocument();
});

test('expanding a card reveals its child subtree', async () => {
  renderWiki();
  const card = (await screen.findByText('Guide')).closest('[data-testid^="wiki-card-"]')!;
  // expand affordance inside the card
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: /expand guide/i }));
  expect(await screen.findByText('Step 1')).toBeInTheDocument();
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `bun test apps/web/src/components/views/wiki-tree.test.tsx`
Expected: FAIL — roots still render as `TreeRow` list rows, no cards/excerpt/child-count.

- [ ] **Step 8: Implement `WikiCard`**

Create `apps/web/src/components/views/wiki-card.tsx`:

```tsx
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { bodyExcerpt } from '../../lib/excerpt.ts';
import type { TreeNode } from '../../lib/wiki-tree.ts';

interface Props {
  node: TreeNode;
  onOpen: (slug: string) => void;
  onAddChild: (parentId: string) => void;
  /** Render the expanded child subtree (the existing TreeRow list). */
  renderChildren: (node: TreeNode) => React.ReactNode;
}

export function WikiCard({ node, onOpen, onAddChild, renderChildren }: Props) {
  const [expanded, setExpanded] = useState(false);
  const childCount = node.children.length;
  const excerpt = bodyExcerpt(node.doc.body ?? '');

  return (
    <div
      data-testid={`wiki-card-${node.doc.slug}`}
      className="flex flex-col rounded-md border border-border-light bg-content p-3 transition-colors hover:border-border"
    >
      <div className="flex items-start gap-2">
        <Icon icon={FileText} size={15} className="mt-0.5 text-fg-3" />
        <button
          type="button"
          onClick={() => onOpen(node.doc.slug)}
          className="flex-1 truncate text-left text-sm font-medium text-fg"
        >
          {node.doc.title}
        </button>
        <button
          type="button"
          aria-label={`Add child page under ${node.doc.title}`}
          onClick={() => onAddChild(node.doc.id)}
          className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
        >
          <Icon icon={Plus} size={14} />
        </button>
      </div>
      {excerpt ? <p className="mt-2 line-clamp-2 text-xs text-fg-2">{excerpt}</p> : null}
      {childCount > 0 ? (
        <button
          type="button"
          aria-label={expanded ? `Collapse ${node.doc.title}` : `Expand ${node.doc.title}`}
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 inline-flex w-fit items-center gap-1 text-[11px] text-fg-3 hover:text-fg-2"
        >
          <Icon icon={expanded ? ChevronDown : ChevronRight} size={12} />
          {childCount} {childCount === 1 ? 'page' : 'pages'}
        </button>
      ) : null}
      {expanded && childCount > 0 ? <div className="mt-2 border-t border-border-light pt-2">{renderChildren(node)}</div> : null}
    </div>
  );
}
```

> Note: `TreeNode.doc` is the `DocumentSummary`-shaped page object built by `buildTree`. Confirm `body` is present on it after the Task-5 type widening; `buildTree` passes the raw doc through, so `node.doc.body` is populated.

- [ ] **Step 9: Render roots as a card grid in `WikiTree`**

In `apps/web/src/components/views/wiki-tree.tsx`, replace the root `<ul>` map (`:110-129`) with a responsive card grid. Keep the existing `TreeRow` for the expanded subtree (pass it via `renderChildren`). The `DndContext` for drag-to-reparent stays — cards are still droppable targets via the subtree rows; root-level reparenting via cards is out of scope for this slice (note it inline).

```tsx
  return (
    <div className="flex h-full flex-col gap-2">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tree.map((node) => (
            <WikiCard
              key={node.doc.id}
              node={node}
              onOpen={openDoc}
              onAddChild={onAddChild}
              renderChildren={(n) => (
                <ul className="flex flex-col">
                  {n.children.map((c) => (
                    <TreeRow
                      key={c.doc.id}
                      node={c}
                      depth={0}
                      expanded={expanded}
                      onToggle={(id) => setExpanded((p) => {
                        const s = new Set(p);
                        if (s.has(id)) s.delete(id); else s.add(id);
                        return s;
                      })}
                      onOpen={openDoc}
                      onAddChild={onAddChild}
                      pendingId={pendingId}
                      wslug={wslug}
                      pslug={pslug}
                    />
                  ))}
                </ul>
              )}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
```

Add the import: `import { WikiCard } from './wiki-card.tsx';`. The empty-state (`:94-103`) and skeleton/error branches stay unchanged.

- [ ] **Step 10: Run to verify it passes**

Run: `bun test apps/web/src/components/views/wiki-tree.test.tsx`
Expected: PASS.

- [ ] **Step 11: Run web suite + typecheck**

Run: `bun test apps/web && bun --filter=web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/lib/excerpt.ts apps/web/src/lib/excerpt.test.ts apps/web/src/lib/api/documents.ts apps/web/src/components/views/wiki-card.tsx apps/web/src/components/views/wiki-tree.tsx apps/web/src/components/views/wiki-tree.test.tsx
git commit -m "phase-3.x: wiki overview renders root pages as cards (title + excerpt + child count)"
```

---

## Task 6: Integration + shake-out

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run: `bun test`
Expected: PASS across server + web + shared. Note any pre-existing known flake (`list-view-create.test.tsx` — rerun once in isolation before treating as a regression, per project memory).

- [ ] **Step 2: Run the app and exercise the four changes**

Run: `bun dev`. In the browser:
1. **Sort** — open a project's Work items, click Title → rows reorder asc, click again → desc, click again → off (back to updated_at desc). Repeat for Status and Updated. Confirm a custom-field header is NOT clickable for sort.
2. **Pinned column** — confirm the settings icon is a fixed right-most column; rows have an empty cell under it; it stays pinned when you horizontally scroll a wide table; the popover opens and toggles columns. Confirm the top bar shows only the FilterBar.
3. **Tab bar** — confirm Work items + Board tabs with icons, no Wiki tab; Wiki still opens from the left rail.
4. **Wiki cards** — open Wiki: root pages render as cards with title + excerpt + child count; expanding a card reveals its children; clicking a card opens the slideover; "Add child" works.

- [ ] **Step 3: Update PHASES.md / STATE.md**

Append a short "TableView UX cleanup (2026-05-31)" note to `memory/STATE.md` recording what shipped and the branch. (No PHASES.md checkbox maps directly — this is pre-Phase-4 polish.)

- [ ] **Step 4: Finish the branch**

Use `superpowers:finishing-a-development-branch` to decide merge vs PR. Do NOT merge to `main` without explicit confirmation (project convention — see the Phase 3 F-8 pattern).

---

## Self-review notes

- **Spec coverage:** §1 sort → Tasks 1–2. §2 pinned column → Task 3. §3 tab bar → Task 4. The spec line "Wiki overview shows items as cards, not as a list" → Task 5. Testing/scope §4 → per-task tests + Task 6. All covered.
- **Out-of-scope items** (custom-field sort, per-row action menu, full view system, time-aware views) are deliberately untouched; custom-field headers stay non-clickable (existing `SORTABLE_BUILTIN_KEYS` gate, unchanged).
- **Type consistency:** `SortKey`/`SortDir` defined in Task 1, consumed by Task 2's route call (passes raw strings; `resolveSort` coerces). `bodyExcerpt(body, maxLen)` signature consistent between Task 5 test and impl. `FrameTab` `icon?: LucideIcon` consistent between main-frame and route usage. `WikiCard` props match its single call site.
- **Cursor risk** is the one genuine correctness hazard; Task 1 Step 1 includes the explicit cross-boundary + sort-mismatch pagination tests.
