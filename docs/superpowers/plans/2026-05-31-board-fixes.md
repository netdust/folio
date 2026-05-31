# Board view fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Fix three board issues from Stefan's QA: (1) Manual mode can't be selected on the default board; (2) short columns' tinted background doesn't grow to the board height; (3) move the group-by + sort controls into the project tab row (after a divider), out of the board's internal strip.

**Architecture:** A tiny module bus (`board-controls-bus.ts`, same pattern as `agent-panel-bus.ts`) holds the board's ad-hoc groupBy/sort overrides. `BoardToolbar` renders in the project layout's tab row (Board tab only) and writes to the bus; `KanbanView` subscribes and merges bus override > view value. This decouples the controls' location from the board component. The manual-mode bug is fixed by applying group-by/sort via the bus (ad-hoc) always, and ALSO persisting to the view when `?view=<id>` is open.

**Tech Stack:** React + TanStack Router + @dnd-kit + Tailwind, vitest (`npx vitest run` from apps/web), tsc via `bun x tsc --noEmit`.

**Verified source facts (2026-05-31):**
- `kanban-view.tsx`: `effectiveSort` derived from `activeView.sort` (`:48-57`); `listParams` uses it (`:59-65`); `groupBy` from `activeView.groupBy` (`:71`); `onGroupByChange`/`onSortChange` gated behind `isActiveViewUrlPinned = !!urlViewId && ...` (`:92-109`) — THE BUG: board is reached at `/board` with NO `?view=`, so `urlViewId` is undefined → both handlers early-return → Manual (and any group-by/sort change) silently does nothing. `<BoardToolbar>` currently renders inside the board (`:173-179`).
- `BoardToolbar` (`board-toolbar.tsx`): `{ groupBy, sort, fields, onGroupByChange, onSortChange }`.
- Project layout `w.$wslug.p.$pslug.tsx`: `TABS=[work-items(List), board(Columns3)]`; renders `<FrameTab>`s in `MainFrame`'s `tabs` slot (`:67-85`). `activeTab` computed from path (`:38`).
- `MainFrame` (`main-frame.tsx:41`): `{tabs ? <div className="flex gap-1 px-[22px] pt-3">{tabs}</div> : null}`.
- `KanbanColumn` (`kanban-column.tsx`): wrapper `div className="flex w-[280px] shrink-0 flex-col"` (`:28`); body `flex min-h-[200px] flex-1 flex-col ... rounded-lg` (`:52-57`). Board container in kanban-view: `div className="flex min-h-0 flex-1 gap-3 overflow-x-auto"` (`:236`). ISSUE 2: the column wrapper has no height, so `flex-1` on the body resolves against content height → short columns' bg stops at the last card instead of filling the board height. Flex default `items-stretch` on the row WOULD stretch wrappers to equal height, but the wrapper is `flex-col` with intrinsic height and the row is inside a `flex-col` parent (`:227 flex h-full min-h-0 flex-col`) — the columns row gets `flex-1 min-h-0` so it has height; the column WRAPPERS stretch via items-stretch, but the body needs `flex-1` AND the wrapper must actually receive the stretched height. Fix below.
- Bus pattern: `apps/web/src/lib/agent-panel-bus.ts` (module singleton: get/subscribe/emit).

## Task 1: Fix Manual mode — ad-hoc board controls via a bus (always apply; persist when pinned)

**Files:**
- Create: `apps/web/src/lib/board-controls-bus.ts` + `.test.ts`
- Modify: `apps/web/src/components/views/kanban-view.tsx`

The bus holds a per-(view id) override of `{ groupBy, sort }`. KanbanView merges: override (if present for the active view) wins over the view's stored value. Changing a control writes the override (immediate, ad-hoc) AND, when `?view=<id>` is open, persists to the view.

- [ ] **Step 1: Write failing bus test.** Create `apps/web/src/lib/board-controls-bus.test.ts`:
```ts
import { describe, expect, test, beforeEach } from 'vitest';
import { boardControlsBus } from './board-controls-bus.ts';

beforeEach(() => boardControlsBus.reset());

describe('boardControlsBus', () => {
  test('get returns undefined override for an unknown view', () => {
    expect(boardControlsBus.get('v1')).toBeUndefined();
  });
  test('setGroupBy stores an override and notifies', () => {
    let seen: unknown = 'unset';
    const off = boardControlsBus.subscribe(() => { seen = boardControlsBus.get('v1'); });
    boardControlsBus.setGroupBy('v1', 'assignee');
    expect(boardControlsBus.get('v1')).toEqual({ groupBy: 'assignee', sort: undefined });
    expect(seen).toEqual({ groupBy: 'assignee', sort: undefined });
    off();
  });
  test('setSort stores sort (null = manual) preserving groupBy', () => {
    boardControlsBus.setGroupBy('v1', 'assignee');
    boardControlsBus.setSort('v1', null);
    expect(boardControlsBus.get('v1')).toEqual({ groupBy: 'assignee', sort: null });
  });
  test('overrides are per view id', () => {
    boardControlsBus.setGroupBy('v1', 'assignee');
    expect(boardControlsBus.get('v2')).toBeUndefined();
  });
});
```

- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/board-controls-bus.test.ts` → FAIL.

- [ ] **Step 3: Implement the bus.** Create `apps/web/src/lib/board-controls-bus.ts`:
```ts
export interface BoardSort { key: string; dir: 'asc' | 'desc'; }
// An override for one view. `sort: null` = manual; `sort: undefined` = not overridden.
export interface BoardOverride { groupBy?: string; sort?: BoardSort | null; }

const overrides = new Map<string, BoardOverride>();
type Listener = () => void;
const listeners = new Set<Listener>();
function emit() { for (const l of listeners) l(); }

export const boardControlsBus = {
  get(viewId: string): BoardOverride | undefined {
    return overrides.get(viewId);
  },
  setGroupBy(viewId: string, groupBy: string) {
    overrides.set(viewId, { ...overrides.get(viewId), groupBy });
    emit();
  },
  setSort(viewId: string, sort: BoardSort | null) {
    overrides.set(viewId, { ...overrides.get(viewId), sort });
    emit();
  },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  reset() { overrides.clear(); emit(); },
};
```

- [ ] **Step 4:** `cd apps/web && npx vitest run src/lib/board-controls-bus.test.ts` → PASS.

- [ ] **Step 5: Wire KanbanView to the bus.** In `kanban-view.tsx`:
  - Subscribe to the bus with `useSyncExternalStore` (or a `useState`+`useEffect(subscribe)` if simpler): `const override = useBoardOverride(activeView?.id);` where the hook reads `boardControlsBus.get(id)` and re-renders on `subscribe`. Add a tiny `useBoardOverride` inline (or in the bus file) using `useSyncExternalStore(boardControlsBus.subscribe, () => activeView ? boardControlsBus.get(activeView.id) : undefined)`.
  - Effective groupBy: `const groupBy = override?.groupBy ?? (activeView?.groupBy ?? 'status') || 'status';` (override wins).
  - Effective sort: if `override` has the `sort` KEY present (including `null`), use it; else derive from `activeView.sort`. I.e. `const effectiveSort = override && 'sort' in override ? override.sort ?? null : <derive from activeView.sort>`. Keep the existing derivation as the fallback.
  - `onGroupByChange(gb)`: `if (activeView) boardControlsBus.setGroupBy(activeView.id, gb);` THEN, if `isActiveViewUrlPinned`, also `updateView.mutate(... groupBy ...)`. (Remove the early-return that blocks ad-hoc changes.)
  - `onSortChange(s)`: `if (activeView) boardControlsBus.setSort(activeView.id, s);` THEN if pinned, persist. (s null = manual.)
  - This makes Manual selectable on the default board (no `?view=` needed).

- [ ] **Step 6:** `cd apps/web && npx vitest run src/components/views/kanban-view.test.tsx` → PASS (update any test that asserted the old gated no-op behavior; the board now applies changes ad-hoc — note in DIVERGENCES). Add a test: selecting Manual via `onSortChange(null)` makes `listParams.sort === 'board_position'` (assert the board refetches in manual order — or at least that the toolbar reflects Manual). If asserting listParams is impractical, assert the BoardToolbar's sort label switches to Manual after the bus updates.

- [ ] **Step 7:** Full web suite + tsc. `npx vitest run` → green; `bun x tsc --noEmit` → clean.

- [ ] **Step 8: Commit:** `fix: board group-by/sort apply ad-hoc (Manual mode now selectable without ?view=)`

## Task 2: Columns stretch to full board height

**Files:** Modify `apps/web/src/components/kanban/kanban-column.tsx`, `apps/web/src/components/views/kanban-view.tsx`

The board row is `flex ... flex-1` (has height). Make each column wrapper stretch to the row height and its body fill the wrapper, so the tinted background grows regardless of card count.

- [ ] **Step 1: Implement.**
  - `kanban-column.tsx`: change the wrapper `div` (`:28`) from `flex w-[280px] shrink-0 flex-col` to `flex w-[280px] shrink-0 flex-col` + ensure it stretches: the parent row is `items-stretch` by flex default, so add `min-h-0` to the wrapper and keep the body `flex-1`. Concretely: wrapper `className="flex w-[280px] shrink-0 flex-col min-h-0"`; body already `flex min-h-[200px] flex-1 flex-col ...` — that `flex-1` now fills the stretched wrapper. The `min-h-[200px]` stays as a floor for empty boards.
  - `kanban-view.tsx` board row (`:236`): confirm it's `flex min-h-0 flex-1 gap-3 overflow-x-auto items-stretch` — add `items-stretch` explicitly (flex default, but be explicit so a future change doesn't regress it).
  - Net effect: every column's tinted body fills the full board height; a column with 1 card has the same background height as a column with 20.

- [ ] **Step 2: Visual check via a render test (light).** Append to `kanban-view.test.tsx` (or column test) a smoke assertion that the column body element carries `flex-1` (so the stretch contract is encoded). This is a guard, not a pixel test:
```tsx
// after rendering the board, the column body (the droppable) has class flex-1
// query a column body via its role/testid; assert className includes 'flex-1'.
```
If there's no easy handle, add a `data-testid="kanban-column-body"` to the body div and assert it has `flex-1` + a min-h class. (Adding the testid is fine.)

- [ ] **Step 3:** `cd apps/web && npx vitest run src/components/views/kanban-view.test.tsx src/components/kanban` → PASS. `bun x tsc --noEmit` → clean.

- [ ] **Step 4: Commit:** `fix: kanban columns stretch tinted background to full board height`

## Task 3: Move group-by + sort into the project tab row (after a divider, Board tab only)

**Files:** Modify `apps/web/src/components/views/kanban-view.tsx` (remove internal toolbar render; expose controls to the layout), `apps/web/src/routes/w.$wslug.p.$pslug.tsx` (render BoardToolbar in the tab row on the board tab), and a small `BoardControls` wrapper component so the layout doesn't duplicate KanbanView's data-loading.

Because the toolbar needs `useViews`/`useFields` + the bus (same data KanbanView uses), create a self-contained `BoardControls` component that loads its own data and renders `BoardToolbar`, writing to the bus. The layout renders `<BoardControls wslug pslug tslug="work-items" />` in the tab row when `activeTab === 'board'`, after a divider. KanbanView stops rendering its internal toolbar (it already subscribes to the bus from Task 1).

- [ ] **Step 1: Create `BoardControls`.** Create `apps/web/src/components/kanban/board-controls.tsx`:
```tsx
import { useViews } from '../../lib/api/views.ts';
import { useFields } from '../../lib/api/fields.ts';
import { useSearch } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { boardControlsBus, type BoardSort } from '../../lib/board-controls-bus.ts';
import { BoardToolbar } from './board-toolbar.tsx';
// resolve activeView the same way KanbanView does (extract a shared helper if
// you prefer; inline is fine here). Derive effective groupBy/sort = bus override
// (if present) else the view value. Render <BoardToolbar ... onGroupByChange={(gb)=>boardControlsBus.setGroupBy(view.id, gb)} onSortChange={(s)=>boardControlsBus.setSort(view.id, s)} />.
// Persist-to-view when ?view= is open (mirror KanbanView's pinned gate) — OR
// keep persistence solely in KanbanView. To avoid double-writes, do persistence
// in ONE place: move the persist-on-pinned logic here (BoardControls owns writes;
// KanbanView only reads the bus + view). Document the choice.
```
Keep it small. It must resolve `activeView` (prefer `?view=` id else default else [0]) and `tslug="work-items"`.

  DESIGN NOTE: To avoid two components both persisting, make BoardControls the SOLE writer (bus + optional view persist), and KanbanView a pure READER (subscribes to bus, derives effective groupBy/sort, never writes). Adjust Task 1's KanbanView wiring accordingly: KanbanView keeps `useBoardOverride` + effective derivation, and DROPS its own `onGroupByChange`/`onSortChange`/`updateView` writes (they move to BoardControls). Keep KanbanView's drag handlers (they patch documents, unrelated).

- [ ] **Step 2: Render in the tab row.** In `w.$wslug.p.$pslug.tsx`, in the `tabs` slot, after the `TABS.map(...)`, conditionally render a divider + BoardControls when `activeTab === 'board'`:
```tsx
tabs={
  <>
    {TABS.map((t) => ( <FrameTab .../> ))}
    {activeTab === 'board' ? (
      <>
        <div className="mx-1 h-5 w-px self-center bg-border-light" aria-hidden />
        <BoardControls wslug={wslug} pslug={pslug} tslug="work-items" />
      </>
    ) : null}
  </>
}
```
Import BoardControls. (The tab row is `flex gap-1 items-?` — ensure vertical alignment: the divider uses `self-center`; BoardControls' buttons should be sized to match FrameTab height. If alignment is off, wrap controls in a `flex items-center gap-1`.)

- [ ] **Step 3: Remove the internal toolbar from KanbanView.** Delete the `<BoardToolbar .../>` render block in `kanban-view.tsx` (the controls now live in the tab row). KanbanView keeps the columns + DndContext only (plus the bus subscription for effective groupBy/sort). Remove now-unused imports (`BoardToolbar`) if nothing else uses them.

- [ ] **Step 4:** `cd apps/web && npx vitest run` (full web) → PASS. Existing kanban-view tests that asserted the toolbar renders INSIDE the board must move/adjust (the toolbar is now in the layout) — update them (assert columns render; toolbar-in-row is covered by a layout test if practical). `bun x tsc --noEmit` → clean.

- [ ] **Step 5: Commit:** `feat: board group-by/sort controls live in the project tab row (after a divider)`

## Task 4: Integration + holistic review

- [ ] **Step 1:** Full web suite `npx vitest run` green; `bun x tsc --noEmit` clean; shared `bun test` green; server board-suites (isolated, per-file — full server suite is the known flake) green.
- [ ] **Step 2: Holistic review** of the diff, focused on: (a) Manual mode now actually changes `listParams.sort` to `board_position` and the board refetches in manual order (the original bug); (b) no double-persist (BoardControls is the sole writer); (c) bus override vs view value precedence is correct and per-view; (d) column stretch doesn't break the empty-board / single-column case; (e) the tab-row divider + alignment renders only on the board tab; (f) drag handlers still work (reorder + cross-column regroup) after the toolbar move.
- [ ] **Step 3:** Fix findings (TDD), re-verify.
- [ ] **Step 4:** Browser shake-out (Stefan): pick Manual → drag a card within a column → order persists on reload; switch group-by; columns' background fills height with uneven card counts; controls sit in the tab row after a divider, only on Board.
- [ ] **Step 5:** Update `memory/STATE.md`; finish the branch (merge on Stefan's OK).

## Self-review notes
- The Manual bug root cause (gate on `?view=`) → fixed by ad-hoc bus override (Task 1) with persistence moved to the sole writer BoardControls (Task 3).
- Issue 2 (bg height) → column wrapper stretch + body `flex-1` (Task 2).
- Issue 3 (controls placement) → BoardControls in the tab row after a divider, board-tab only (Task 3).
- Risk: double-persist / precedence — addressed by making BoardControls the sole writer and KanbanView a pure reader; Task 4 verifies.
- `BoardSort` type is shared via the bus module (`board-controls-bus.ts`) to avoid duplication between BoardToolbar/BoardControls/KanbanView.
