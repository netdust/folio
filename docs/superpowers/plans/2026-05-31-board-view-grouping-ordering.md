# Board View — Grouping + In-Column Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Board (kanban) view group by any field (not just status) and order cards within a column by a field-sort or a persisted manual drag-order.

**Architecture:** Grouping is client-side (the board buckets fetched docs by `view.groupBy`); the `views` table already has `groupBy`/`sort` columns and the PATCH route already accepts them. Field-sort reuses the shipped server sort. Manual order adds ONE global fractional-rank `board_position TEXT` column on `documents`, ordered server-side via a new `board_position` sort key (reusing the keyset-cursor machinery with the nullable-text affinity discipline). Sort wins; manual is the default and drag-reorder is disabled while a field-sort is active.

**Tech Stack:** Bun + Hono + Drizzle + SQLite (server, `bun test`), React + TanStack Router + @dnd-kit + Tailwind (web, `npx vitest run`). Typecheck `bun x tsc --noEmit` per app. Spec: `docs/superpowers/specs/2026-05-31-board-view-grouping-ordering-design.md`.

**Verified source facts (2026-05-31):**
- Latest migration `0017_...`, journal idx 18 (`apps/server/src/db/migrations/meta/_journal.json`). New migration = `0018_*`, journal idx 19. Project rule: a new `.sql` MUST be added to `_journal.json` or `migrate()` skips it.
- `documents` table (`schema.ts`): `status text` (nullable), `frontmatter json notNull default {}`, `updatedAt`, `id`. NO ordering column.
- `listDocuments` (`services/documents.ts`): `SORT_COLUMNS = {title,status,updated_at}`; `sortExpr(key)`; `fieldSortExpr(key,type)` (numeric→cast real+`9e18`, else→cast text+`'￿'`); `resolveSort`; `encodeCursor(sortKey,sortValue,id)`/`decodeCursor` (guard already loosened to any non-empty sortKey); keyset block routes non-updated_at through an `orderExpr`; cursor sortValue ladder at ~:360-372.
- `DocumentPatch` (`services/documents.ts:697-703`): `{title?, body?, status?, frontmatter?, parentId?}`. `updated` set object at ~:873-883. Add `board_position` to both.
- `DocumentSummary` (`apps/web/src/lib/api/documents.ts`): has `body` (added prior slice); add `boardPosition`.
- Views route PATCH (`routes/views.ts:80`) already accepts `groupBy` (`:23`) + `sort` (`:22`). `useUpdateView` (`apps/web/src/lib/api/views.ts:72`) exists; `ViewPatch` has `groupBy?`/`sort?`.
- Kanban: `kanban-view.tsx` (groups by status via `useStatuses`, dnd column-only), `kanban-column.tsx` (`useDroppable id=col-<status.key>`), `kanban-card.tsx` (`useDraggable id=doc.id data:{slug,currentStatus}`; shows priority/due/assignee/labels chips).
- `useFields(wslug, pslug, tslug)` exists (`apps/web/src/lib/api/fields.ts`) → `{ key, type, label, options }[]`.

---

## Task 1: Add `board_position` column (migration + schema + serializer)

**Files:**
- Create: `apps/server/src/db/migrations/0018_board_position.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/db/schema.ts` (documents table)
- Modify: `apps/web/src/lib/api/documents.ts` (`DocumentSummary`)
- Test: `apps/server/src/db/migrations/0018_board_position.test.ts` (create)

- [ ] **Step 1: Write the failing migration test.** Create `apps/server/src/db/migrations/0018_board_position.test.ts`. Follow the existing migration-test pattern (find one, e.g. a `00NN_*.test.ts`, and copy its harness: fresh in-memory `Database`, run the migrator). Assert the `documents` table has a `board_position` column after migrate:

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
// + the project's migrate runner (copy from a sibling migration test)

test('0018 adds board_position to documents', () => {
  const db = new Database(':memory:');
  // run all migrations via the project's runner (copy the exact call from a sibling test)
  const cols = db.query(`PRAGMA table_info(documents)`).all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).toContain('board_position');
});
```

- [ ] **Step 2: Run to verify it fails.** `cd apps/server && bun test src/db/migrations/0018_board_position.test.ts` → FAIL (no such column / migration missing).

- [ ] **Step 3: Write the migration.** Create `apps/server/src/db/migrations/0018_board_position.sql`:

```sql
ALTER TABLE `documents` ADD `board_position` text;
```

- [ ] **Step 4: Register it in the journal.** Append to the `entries` array in `apps/server/src/db/migrations/meta/_journal.json` (after the idx-18 entry):

```json
,
    {
      "idx": 19,
      "version": "6",
      "when": 1780930000000,
      "tag": "0018_board_position",
      "breakpoints": true
    }
```

(Place the leading comma correctly: the previous entry's closing `}` must be followed by this `,{...}`. Keep the array's closing `]}` intact.)

- [ ] **Step 5: Add the column to the Drizzle schema.** In `apps/server/src/db/schema.ts`, in the `documents` table, after `status` (or near `frontmatter`), add:

```ts
    boardPosition: text('board_position'), // fractional rank for manual kanban order; null = unranked
```

- [ ] **Step 6: Add to the client type.** In `apps/web/src/lib/api/documents.ts`, add to `DocumentSummary`:

```ts
  boardPosition: string | null;
```

- [ ] **Step 7: Run to verify it passes.** `cd apps/server && bun test src/db/migrations/0018_board_position.test.ts` → PASS. Then `cd apps/server && bun x tsc --noEmit` → clean (the schema column flows into the `Document` type the service returns).

- [ ] **Step 8: Run the server suite** for regressions: `cd apps/server && bun test` → PASS (was 995 pass / 1 skip).

- [ ] **Step 9: Commit.**

```bash
git add apps/server/src/db/migrations/0018_board_position.sql apps/server/src/db/migrations/meta/_journal.json apps/server/src/db/schema.ts apps/web/src/lib/api/documents.ts apps/server/src/db/migrations/0018_board_position.test.ts
git commit -m "phase-3.x: add board_position column to documents (manual kanban order)"
```

---

## Task 2: `board-rank.ts` — fractional rank helper (pure)

**Files:**
- Create: `packages/shared/src/board-rank.ts`
- Test: `packages/shared/src/board-rank.test.ts`
- Modify: `packages/shared/src/index.ts` (export it — check the file's export style first)

A fractional rank generates a string key strictly ordered between two neighbors so a card can be inserted without renumbering. Keys are compared lexically (matches the server's text-affinity ordering for `board_position`).

- [ ] **Step 1: Write failing tests.** Create `packages/shared/src/board-rank.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { rankBetween } from './board-rank.ts';

describe('rankBetween', () => {
  test('between null/null (empty list) returns a mid key', () => {
    const k = rankBetween(null, null);
    expect(typeof k).toBe('string');
    expect(k.length).toBeGreaterThan(0);
  });
  test('before-first: rankBetween(null, x) < x lexically', () => {
    const x = rankBetween(null, null);
    const before = rankBetween(null, x);
    expect(before < x).toBe(true);
  });
  test('after-last: rankBetween(x, null) > x lexically', () => {
    const x = rankBetween(null, null);
    const after = rankBetween(x, null);
    expect(after > x).toBe(true);
  });
  test('between two keys yields a key strictly between them', () => {
    const a = rankBetween(null, null);
    const c = rankBetween(a, null);
    const b = rankBetween(a, c);
    expect(a < b && b < c).toBe(true);
  });
  test('repeated midpoint insertions stay strictly ordered', () => {
    let lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    for (let i = 0; i < 20; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      hi = mid; // keep inserting just above lo
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `cd packages/shared && bun test src/board-rank.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement.** Create `packages/shared/src/board-rank.ts`. Use a base-62 fractional midpoint over a fixed digit alphabet, padding to find a midpoint when keys are adjacent:

```ts
// Fractional ranking for manual ordering. Keys are compared LEXICALLY (must
// match the server's text-affinity ordering of board_position). rankBetween
// returns a key strictly between `lo` and `hi`; null means "open end".
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const MID = DIGITS[Math.floor(BASE / 2)]; // a midpoint digit for empty/open cases

function digit(s: string, i: number): number {
  // Treat missing positions as 0 so we can extend short keys.
  return i < s.length ? DIGITS.indexOf(s[i]!) : 0;
}

export function rankBetween(lo: string | null, hi: string | null): string {
  // Empty list.
  if (lo === null && hi === null) return MID!;
  // Before first: produce a key < hi by going to its first digit's midpoint,
  // or prefixing a smaller digit.
  if (lo === null && hi !== null) {
    // Find a key strictly less than hi: recurse with an all-min lower bound.
    return rankBetween('', hi);
  }
  // After last: extend lo upward.
  if (lo !== null && hi === null) {
    return rankBetween(lo, '');
  }
  // Both present. `''` as hi means "no upper bound" (treat as +infinity);
  // `''` as lo means "no lower bound" (treat as the all-zero key).
  const a = lo as string;
  const b = hi as string;
  let i = 0;
  let prefix = '';
  // Walk the common prefix, accumulating it, until digits differ enough to fit
  // a value between them.
  for (;;) {
    const da = digit(a, i);
    const db = b === '' ? BASE : digit(b, i); // open upper bound = BASE (past last digit)
    if (da === db) {
      prefix += DIGITS[da];
      i++;
      continue;
    }
    // db > da. If there's a gap, pick the midpoint digit.
    if (db - da > 1) {
      const mid = da + Math.floor((db - da) / 2);
      return prefix + DIGITS[mid];
    }
    // Adjacent digits (db === da + 1): take a's digit, then append a digit
    // above a's continuation (descend into a's tail).
    prefix += DIGITS[da];
    i++;
    // Now we need a key > a's tail. Append a mid digit beyond a's remaining run
    // of max digits.
    for (;;) {
      const dat = digit(a, i);
      if (dat < BASE - 1) {
        return prefix + DIGITS[dat + Math.max(1, Math.floor((BASE - 1 - dat) / 2))];
      }
      prefix += DIGITS[dat];
      i++;
    }
  }
}
```

(If this midpoint logic proves fiddly, an acceptable alternative is to vendor the tiny `fractional-indexing` algorithm — but keep it dependency-free and lexically comparable. The tests above are the contract; make them pass.)

- [ ] **Step 4: Run to verify it passes.** `cd packages/shared && bun test src/board-rank.test.ts` → PASS (all 5).

- [ ] **Step 5: Export it.** In `packages/shared/src/index.ts`, add an export matching the file's existing style (e.g. `export { rankBetween } from './board-rank.ts';` or `export * from './board-rank.ts';` — match siblings).

- [ ] **Step 6: Run shared suite + typecheck.** `cd packages/shared && bun test` → PASS (was 53). `bun x tsc --noEmit` from packages/shared (or repo root if that's how shared typechecks — check) → clean.

- [ ] **Step 7: Commit.**

```bash
git add packages/shared/src/board-rank.ts packages/shared/src/board-rank.test.ts packages/shared/src/index.ts
git commit -m "phase-3.x: fractional rank helper for manual board ordering"
```

---

## Task 3: Server — manual-order sort key (`board_position`) + settable on PATCH

**Files:**
- Modify: `apps/server/src/services/documents.ts` (sort key + `DocumentPatch` + `updated` set)
- Test: `apps/server/src/services/documents.sort.test.ts` (append)

- [ ] **Step 1: Write failing tests.** Append to `documents.sort.test.ts`:

```ts
test('sort by board_position orders ranked rows asc, nulls last', async () => {
  // Seed 4 work items: 3 with board_position 'b','a','c' (text), 1 with null.
  // Set board_position directly (insert or update).
  const r = await listDocuments({ projectId: P, activeTableId: T, type: 'work_item', sort: 'board_position', dir: 'asc' });
  // 'a','b','c' first (text asc), null last
  const pos = r.data.map((d) => d.boardPosition ?? null);
  expect(pos.slice(0, 3)).toEqual(['a', 'b', 'c']);
  expect(pos[3]).toBeNull();
});

test('board_position keyset pagination with a null row across a boundary drops nothing', async () => {
  // 3 ranked ('a','b','c') + 1 null, limit 2, page through; assert union size 4.
  const opts = { projectId: P, activeTableId: T, type: 'work_item' as const, sort: 'board_position' as const, dir: 'asc' as const };
  const p1 = await listDocuments({ ...opts, limit: 2 });
  const p2 = p1.nextCursor ? await listDocuments({ ...opts, limit: 2, cursor: p1.nextCursor }) : { data: [], nextCursor: null };
  const p3 = p2.nextCursor ? await listDocuments({ ...opts, limit: 2, cursor: p2.nextCursor }) : { data: [], nextCursor: null };
  const all = [...p1.data, ...p2.data, ...p3.data].map((d) => d.id);
  expect(new Set(all).size).toBe(4);
});
```

(Adapt seeding to the harness; you may need to UPDATE `documents.board_position` directly after create since there's no create-time field for it yet — Step 3 adds the PATCH path but the test can set it via the db handle.)

- [ ] **Step 2: Run to verify it fails.** `cd apps/server && bun test src/services/documents.sort.test.ts` → FAIL (board_position not a known sort key → falls back to updated_at).

- [ ] **Step 3: Implement.** In `apps/server/src/services/documents.ts`:
  - Add `board_position` as a recognized BUILT-IN-ish sort over a real column. The cleanest path: extend `SORT_COLUMNS` with `board_position: documents.boardPosition`. Because it's nullable text, `sortExpr` must coalesce it to the text sentinel exactly like `status`:
    ```ts
    const SORT_COLUMNS = {
      title: documents.title,
      status: documents.status,
      updated_at: documents.updatedAt,
      board_position: documents.boardPosition,
    } as const;
    ```
    And in `sortExpr`:
    ```ts
    function sortExpr(key: SortKey): SQL {
      if (key === 'status') return sql`coalesce(${documents.status}, ${NULL_SENTINEL})`;
      if (key === 'board_position') return sql`coalesce(${documents.boardPosition}, ${NULL_SENTINEL})`;
      return sql`${SORT_COLUMNS[key]}`;
    }
    ```
  - In the cursor sortValue ladder (~:360-372), add a `board_position` branch (it's a real column, like status): `sortKey === 'board_position' ? String(last.boardPosition ?? NULL_SENTINEL) : ...`. Since `board_position` is now in `SORT_COLUMNS`, `resolveSort` accepts it and routes through the non-updated_at keyset branch automatically (which uses `sortExpr(sortKey)` as the comparison expr) — confirm the existing `else` branch uses `sortExpr(sortKey)` and that the cursor compares the coalesced text against `cursor.sortValue` (text) consistently. The default `dir` for `board_position` should be `asc` (resolveSort already defaults non-updated_at keys to asc).
  - Add `boardPosition` to `DocumentPatch` (`:697-703`): `boardPosition?: string | null;`
  - Add to the `updated` set object (`:873-883`): `...(patch.boardPosition !== undefined ? { boardPosition: patch.boardPosition } : {}),`
  - (No builtin-trigger / agent guard change needed — board_position is only patched on work_items by the board; but the generic guard already blocks comment/agent_run. Leave guards as-is.)

- [ ] **Step 4: Run to verify it passes.** `cd apps/server && bun test src/services/documents.sort.test.ts` → PASS (all, incl. the prior sort tests).

- [ ] **Step 5: Server suite + typecheck.** `cd apps/server && bun test` → PASS. `bun x tsc --noEmit` from apps/server → clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/services/documents.ts apps/server/src/services/documents.sort.test.ts
git commit -m "phase-3.x: board_position sort key (nulls-last, text affinity) + settable on PATCH"
```

---

## Task 4: Web — board reads `groupBy`, builds columns from any field

**Files:**
- Modify: `apps/web/src/components/views/kanban-view.tsx`
- Create: `apps/web/src/components/kanban/board-grouping.ts` (pure column-builder)
- Test: `apps/web/src/components/kanban/board-grouping.test.ts` (create), `apps/web/src/components/views/kanban-view.test.tsx` (append)

Grouping becomes config-driven. Extract the column-building into a pure, testable helper.

- [ ] **Step 1: Write failing tests for the pure helper.** Create `apps/web/src/components/kanban/board-grouping.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { buildColumns, type BoardColumn } from './board-grouping.ts';
import type { DocumentSummary } from '../../lib/api/documents.ts';

const doc = (id: string, fm: Record<string, unknown>, status: string | null = null): DocumentSummary =>
  ({ id, slug: id, type: 'work_item', title: id, status, parentId: null, frontmatter: fm, createdAt: '', updatedAt: '', lastTouchedAt: null, body: '', boardPosition: null });

describe('buildColumns', () => {
  test('group by a select field uses the field options as columns + unset', () => {
    const cols = buildColumns({
      docs: [doc('a', { priority: 'High' }), doc('b', {})],
      groupBy: 'priority',
      field: { key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'] },
      statuses: [],
    });
    expect(cols.map((c: BoardColumn) => c.value)).toEqual(['Low', 'High', null]); // null = unset column
    expect(cols.find((c) => c.value === 'High')!.docIds).toEqual(['a']);
    expect(cols.find((c) => c.value === null)!.docIds).toEqual(['b']);
  });

  test('group by a free-text field uses distinct observed values, alphabetical, + unset', () => {
    const cols = buildColumns({
      docs: [doc('a', { assignee: 'Zoe' }), doc('b', { assignee: 'Ann' }), doc('c', {})],
      groupBy: 'assignee',
      field: { key: 'assignee', type: 'user_ref', label: 'Assignee', options: null },
      statuses: [],
    });
    expect(cols.map((c) => c.value)).toEqual(['Ann', 'Zoe', null]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `cd apps/web && npx vitest run src/components/kanban/board-grouping.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the helper.** Create `apps/web/src/components/kanban/board-grouping.ts`:

```ts
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Field } from '../../lib/api/fields.ts';
import type { Status } from '../../lib/api/statuses.ts';

export interface BoardColumn {
  value: string | null;   // the grouping value; null = "unset" column
  label: string;
  color?: string;         // status dot color, when grouping by status
  docIds: string[];
}

interface Args {
  docs: DocumentSummary[];
  groupBy: string;             // 'status' or a field key
  field: Field | null;         // the field def when grouping by a field
  statuses: Status[];
}

/** Build ordered kanban columns + bucket doc ids. Pure. */
export function buildColumns({ docs, groupBy, field, statuses }: Args): BoardColumn[] {
  if (groupBy === 'status') {
    const cols: BoardColumn[] = statuses.map((s) => ({ value: s.key, label: s.name, color: s.color, docIds: [] }));
    const byKey = new Map(cols.map((c) => [c.value, c]));
    const unset: BoardColumn = { value: null, label: 'No status', docIds: [] };
    for (const d of docs) {
      const c = d.status && byKey.has(d.status) ? byKey.get(d.status)! : unset;
      c.docIds.push(d.id);
    }
    return unset.docIds.length > 0 ? [...cols, unset] : cols;
  }

  // Field grouping. Column set: select → field.options; else → distinct observed.
  const valueOf = (d: DocumentSummary): string | null => {
    const v = (d.frontmatter as Record<string, unknown>)[groupBy];
    if (v === null || v === undefined || v === '') return null;
    return String(v);
  };

  let values: string[];
  if (field && field.type === 'select' && field.options && field.options.length > 0) {
    values = [...field.options];
  } else {
    const seen = new Set<string>();
    for (const d of docs) {
      const v = valueOf(d);
      if (v !== null) seen.add(v);
    }
    values = [...seen].sort((a, b) => a.localeCompare(b));
  }

  const cols: BoardColumn[] = values.map((v) => ({ value: v, label: v, docIds: [] }));
  const byVal = new Map(cols.map((c) => [c.value, c]));
  const unset: BoardColumn = { value: null, label: 'Unset', docIds: [] };
  for (const d of docs) {
    const v = valueOf(d);
    const c = v !== null && byVal.has(v) ? byVal.get(v)! : unset;
    c.docIds.push(d.id);
  }
  return unset.docIds.length > 0 ? [...cols, unset] : cols;
}
```

- [ ] **Step 4: Run to verify it passes.** `cd apps/web && npx vitest run src/components/kanban/board-grouping.test.ts` → PASS.

- [ ] **Step 5: Wire it into `kanban-view.tsx`.** Read the active view + fields, compute columns via `buildColumns`, render columns generically. Specifically:
  - Add `tslug` to `KanbanView` Props (it needs `useFields(wslug, pslug, tslug)`). Update the caller (the board route — find it: `apps/web/src/routes/w.$wslug.p.$pslug.board.tsx`) to pass `tslug` (use the default table slug the same way the work-items route resolves it — check how `TableView` gets `tslug` there).
  - Read `useViews` + resolve `activeView` (mirror `table-view.tsx`'s `activeView` useMemo: `?view=` id else default). `const groupBy = (activeView?.groupBy ?? 'status') || 'status';`
  - `const { data: fields } = useFields(wslug, pslug, tslug); const groupField = groupBy === 'status' ? null : (fields ?? []).find((f) => f.key === groupBy) ?? null;`
  - `const columns = useMemo(() => buildColumns({ docs: page?.data ?? [], groupBy, field: groupField, statuses: statuses ?? [] }), [page, groupBy, groupField, statuses]);`
  - Render: map `columns` to `KanbanColumn` (Task 6 generalizes KanbanColumn to take `{value,label,color}`; for THIS task keep rendering status columns as today but sourced from `columns` — pass `column.label`, `column.color`, and look up docs by id from a `Map<id, DocumentSummary>`). The "No status"/"Unset" parking lot becomes just the `value === null` column.
  - Keep `onDragEnd` working for status group-by (drop on `col-<value>` → patch status). Field-group drag is Task 6; for now, when `groupBy !== 'status'`, dropping patches `frontmatter[groupBy] = value` (or null for unset). Generalize `onDragEnd`:
    ```ts
    const overId = String(over.id);
    if (!overId.startsWith('col-')) return;
    const colValue = overId.slice('col-'.length) === '__unset__' ? null : overId.slice('col-'.length);
    const slug = data?.slug;
    if (!slug) return;
    if (groupBy === 'status') {
      await update.mutateAsync({ slug, patch: { status: colValue } });
    } else {
      await update.mutateAsync({ slug, patch: { frontmatter: { [groupBy]: colValue } } });
    }
    ```
    Use a stable column id: `col-${c.value ?? '__unset__'}`. Update `KanbanColumn`/droppable id accordingly in Task 6; for this task, set the droppable id from the column value.
  - `onCreateInColumn`: for status group, patch status (today); for field group, patch `frontmatter[groupBy] = value`. Skip create button on the unset column when grouping by a non-status field (or allow it with value=null — keep simple: show add only when `value !== null`).

- [ ] **Step 6: Write a kanban-view integration test.** Append to `apps/web/src/components/views/kanban-view.test.tsx` (reuse harness): with `activeView.groupBy = 'priority'` and a select field `priority` (options Low/High), assert columns "Low" and "High" render and a card with `priority: 'High'` is under "High". Mirror the existing kanban test's mocking of `useDocuments`/`useStatuses`/`useViews`/`useFields`.

- [ ] **Step 7: Run.** `cd apps/web && npx vitest run src/components/views/kanban-view.test.tsx src/components/kanban/board-grouping.test.ts` → PASS. Then full web suite `npx vitest run` → PASS (was 653). `bun x tsc --noEmit` → clean.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/components/views/kanban-view.tsx apps/web/src/components/kanban/board-grouping.ts apps/web/src/components/kanban/board-grouping.test.ts apps/web/src/components/views/kanban-view.test.tsx "apps/web/src/routes/w.\$wslug.p.\$pslug.board.tsx"
git commit -m "phase-3.x: board groups by any field (status default), columns from field values"
```

---

## Task 5: Web — group-by + sort controls on the board (persist to view)

**Files:**
- Create: `apps/web/src/components/kanban/board-toolbar.tsx`
- Modify: `apps/web/src/components/views/kanban-view.tsx`
- Test: `apps/web/src/components/kanban/board-toolbar.test.tsx` (create)

- [ ] **Step 1: Write failing test.** Create `apps/web/src/components/kanban/board-toolbar.test.tsx`:

```tsx
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BoardToolbar } from './board-toolbar.tsx';

const fields = [{ id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'] }];

test('group-by select lists Status + groupable fields and fires onGroupByChange', () => {
  const onGroupByChange = vi.fn();
  render(<BoardToolbar groupBy="status" sort={null} fields={fields as never} onGroupByChange={onGroupByChange} onSortChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /group by/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /priority/i }));
  expect(onGroupByChange).toHaveBeenCalledWith('priority');
});

test('sort control offers Manual + fields and fires onSortChange', () => {
  const onSortChange = vi.fn();
  render(<BoardToolbar groupBy="status" sort={{ key: 'updated_at', dir: 'desc' }} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
  fireEvent.click(screen.getByRole('button', { name: /sort/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /manual/i }));
  expect(onSortChange).toHaveBeenCalledWith(null); // null = manual
});
```

- [ ] **Step 2: Run to verify it fails.** `cd apps/web && npx vitest run src/components/kanban/board-toolbar.test.tsx` → FAIL.

- [ ] **Step 3: Implement the toolbar.** Create `apps/web/src/components/kanban/board-toolbar.tsx`. Use the existing dropdown/popover primitive the codebase uses for such menus (check `column-menu.tsx` or `row-context-menu.tsx` for the pattern — reuse the same primitive). Props:

```tsx
import type { Field } from '../../lib/api/fields.ts';

export interface BoardSort { key: string; dir: 'asc' | 'desc'; }
interface Props {
  groupBy: string;                    // 'status' or field key
  sort: BoardSort | null;             // null = manual
  fields: Field[];
  onGroupByChange: (groupBy: string) => void;
  onSortChange: (sort: BoardSort | null) => void;
}
```

Render two menu buttons:
- **Group by:** "Status" + each field where `type !== 'multi_select'`. Selecting calls `onGroupByChange(key)` ('status' or the field key).
- **Sort:** "Manual" (→ `onSortChange(null)`) + each sortable field/built-in with asc/desc. Selecting a field calls `onSortChange({ key, dir })`. Show the current selection.

Match the visual weight of the existing table `FilterBar`/`ColumnPicker` controls (small, token classes). Use `role="menuitem"` items so the tests query by role.

- [ ] **Step 4: Run to verify it passes.** `cd apps/web && npx vitest run src/components/kanban/board-toolbar.test.tsx` → PASS.

- [ ] **Step 5: Wire into `kanban-view.tsx`.** Render `<BoardToolbar>` above the columns. Wire handlers to PATCH the active view (autosave-gated on `?view=<id>`, mirroring `table-view.tsx`'s `onSortChange`/`onClauseChange` consent gate):
  - `onGroupByChange(gb)` → set local/URL state + if `urlViewId === activeView?.id` `updateView.mutate({ id, patch: { groupBy: gb === 'status' ? null : gb } })`.
  - `onSortChange(s)` → drive the board's `listParams` sort (when `s` is null → `sort: 'board_position', dir: 'asc'` = manual mode; else `sort: s.key, dir: s.dir`) + autosave `{ sort: s ? [{ key: s.key, dir: s.dir }] : [] }` (empty array = manual).
  - Derive the board's effective sort from `activeView.sort` (first entry) like the table does; `[]`/absent → manual (`board_position`).

- [ ] **Step 6: Web suite + typecheck.** `cd apps/web && npx vitest run` → PASS. `bun x tsc --noEmit` → clean.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/components/kanban/board-toolbar.tsx apps/web/src/components/kanban/board-toolbar.test.tsx apps/web/src/components/views/kanban-view.tsx
git commit -m "phase-3.x: board toolbar — group-by + sort controls, persist to view"
```

---

## Task 6: Web — manual drag-reorder within a column (disabled while sorted)

**Files:**
- Modify: `apps/web/src/components/views/kanban-view.tsx`
- Modify: `apps/web/src/components/kanban/kanban-column.tsx` (SortableContext + generic column value/label/color)
- Modify: `apps/web/src/components/kanban/kanban-card.tsx` (useSortable when reorder enabled)
- Test: `apps/web/src/components/views/kanban-view.test.tsx` (append)

- [ ] **Step 1: Write failing tests.** Append to `kanban-view.test.tsx`:

```tsx
test('manual mode: dropping a card within a column patches board_position', async () => {
  // groupBy status, sort = manual (view.sort = []), 2 cards in one column.
  // Simulate a within-column reorder DragEnd (active=card B over card A).
  // Assert update.mutateAsync called with patch.boardPosition (a string).
  // Mirror the existing kanban dnd test's DragEnd simulation (kanban-view-dnd.test.tsx).
});

test('sorted mode: within-column reorder is disabled (no board_position patch)', async () => {
  // groupBy status, sort = {priority, asc}. Simulate the same within-column drop.
  // Assert update.mutateAsync was NOT called with boardPosition (reorder disabled).
});
```

(Read `apps/web/src/components/views/kanban-view-dnd.test.tsx` first — copy its DragEnd-simulation mechanism exactly; that's the established way this repo tests kanban dnd.)

- [ ] **Step 2: Run to verify it fails.** `cd apps/web && npx vitest run src/components/views/kanban-view.test.tsx` → FAIL.

- [ ] **Step 3: Generalize `KanbanColumn`.** Change its props from `status: Status` to a generic `{ value: string | null; label: string; color?: string }` (or add a `column: BoardColumn`-like prop). Droppable id = `col-${value ?? '__unset__'}`. Render the dot only when `color` is set (status mode); transparent placeholder otherwise (preserve the existing alignment). Wrap children in a `SortableContext` (items = the column's doc ids) ONLY when a `reorderEnabled` prop is true:

```tsx
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
// ...
{reorderEnabled ? (
  <SortableContext items={docIds} strategy={verticalListSortingStrategy}>{children}</SortableContext>
) : children}
```
Add `docIds: string[]` and `reorderEnabled: boolean` to props.

- [ ] **Step 4: Make `KanbanCard` sortable when enabled.** Add a `sortable?: boolean` prop. When true, use `useSortable({ id: doc.id, data: {...} })` instead of `useDraggable` (same data shape + `slug`/`currentStatus`/add `currentValue` for field group). When false, keep `useDraggable` (cross-column-only behavior, current). Keep the click-to-open guard. (dnd-kit's `useSortable` provides the same `attributes/listeners/setNodeRef/transform` surface, plus `transition`.)

- [ ] **Step 5: Handle within-column reorder in `kanban-view.tsx`.** Compute `reorderEnabled = sort === null` (manual mode). Pass it to columns/cards. In `onDragEnd`, when `reorderEnabled` and the drop is a card-over-card within the same column (over.id is a doc id, not `col-*`):
  - Find the target column's ordered doc list, compute the new index, get the `boardPosition` of the neighbors above/below the drop slot, `rankBetween(loPos, hiPos)`, and `update.mutateAsync({ slug, patch: { boardPosition: newRank } })`.
  - Import `rankBetween` from `@folio/shared` (Task 2).
  - When `reorderEnabled` is false, ignore card-over-card (no-op) — only `col-*` drops (cross-column regroup) act. This implements "drag-reorder disabled while sorted".
  - Cross-column drop in manual mode: also assign a `boardPosition` for the drop slot (rank at the end of the target column, or between neighbors if dropped on a card). Combine the status/field patch with a boardPosition patch in one `update.mutateAsync` call.

- [ ] **Step 6: Run to verify it passes.** `cd apps/web && npx vitest run src/components/views/kanban-view.test.tsx` → PASS.

- [ ] **Step 7: Full web suite + typecheck.** `npx vitest run` → PASS. `bun x tsc --noEmit` → clean. Watch for the existing `kanban-view-dnd.test.tsx` / `kanban-view.test.tsx` — if the KanbanColumn prop change breaks them, update to the new prop shape.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/components/views/kanban-view.tsx apps/web/src/components/kanban/kanban-column.tsx apps/web/src/components/kanban/kanban-card.tsx apps/web/src/components/views/kanban-view.test.tsx
git commit -m "phase-3.x: manual drag-reorder within board columns (disabled while a sort is active)"
```

---

## Task 7: Integration + holistic review

- [ ] **Step 1: Full suite.** `(cd apps/server && bun test)`, `(cd apps/web && npx vitest run)`, `(cd packages/shared && bun test)` — all green. Note the known flake (`list-view-create.test.tsx`) — rerun once in isolation before treating as a regression.

- [ ] **Step 2: Dispatch a holistic reviewer** on the whole branch diff, PRIMED on: (a) the `board_position` nullable-text keyset-affinity trap (same class that bit twice — verify ORDER BY + keyset predicate + cursor-encode all use the coalesced text sentinel consistently, with a null row across a page boundary); (b) `rankBetween` correctness (does it ever return a key equal to a neighbor, or out of order, after many midpoint inserts?); (c) field-group drag patches the right key and "unset" clears it; (d) reorder-disabled-while-sorted actually holds; (e) the KanbanColumn prop generalization didn't break the status-mode dot/parking-lot rendering.

- [ ] **Step 3: Fix any CRITICAL/IMPORTANT findings** (TDD), re-verify.

- [ ] **Step 4: Browser shake-out (Stefan).** `bun dev`: group by status/assignee/priority; switch sort field + Manual; drag cards within a column (manual) and confirm order persists on reload; confirm reorder is disabled when a sort is active; confirm cross-column drag regroups.

- [ ] **Step 5: Update `memory/STATE.md`** (board grouping + ordering shipped) and finish the branch (`superpowers:finishing-a-development-branch`) — merge only on Stefan's OK.

---

## Self-review notes

- **Spec coverage:** §1 group-by → Tasks 4 (+5 control). §2 field-sort → Task 5; manual order → Tasks 1 (column), 2 (rank), 3 (server sort), 6 (dnd); sort-wins/disable-reorder → Task 6. §3 edge cases → buildColumns (Task 4) + holistic review (Task 7). All covered.
- **Out-of-scope** (card-field picker, per-grouping order, column capping, multi-user, multi_select group-by) untouched; multi_select excluded from the group-by control (Task 5 Step 3).
- **Type consistency:** `BoardColumn {value,label,color?,docIds}` defined in Task 4, consumed in Tasks 4/6. `BoardSort {key,dir}` in Task 5, used in 5/6. `rankBetween(lo,hi)` signature consistent Task 2 ↔ Task 6. `board_position`/`boardPosition` (snake col ↔ camel field) consistent across Tasks 1/3/6. `DocumentPatch.boardPosition` (Task 3) matches the web patch call (Task 6).
- **Keyset risk:** `board_position` is nullable text — Task 3 routes it through the same coalesce-text-sentinel `sortExpr` branch as `status`, and Task 3 Step 1 includes the null-across-boundary pagination regression. Task 7 re-verifies.
- **The one genuine unknown is `rankBetween`'s midpoint math** — Task 2's tests are the contract; the impl may need iteration, and vendoring `fractional-indexing` is a named fallback.
