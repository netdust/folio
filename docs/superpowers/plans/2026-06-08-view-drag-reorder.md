# View Drag-Reorder (rail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user **drag** views to reorder them in the rail (the primary UX Stefan expected), keeping the existing Move up/down menu items as a keyboard/fallback path.

**Architecture:** dnd-kit (already the repo's drag lib — see `kanban-view.tsx` + `wiki-tree.tsx`). The rail's generic `RailTree` gets a single `DndContext`; only **view** rows become sortable (scoped via a `sortableGroup` key = the owning table id, set in `buildRailTree`). On drop, reorder the affected table's view list and persist NEW spaced `order` values (0,10,20,…) in one pass via a new `onReorderViews` handler — robust to multi-slot moves, and it normalizes any drifted/colliding orders as a side effect. Reuses the existing `PATCH /views/:id { order }` route (`config:write`); no new endpoint, no schema change.

**Tech Stack:** React + @dnd-kit/core + @dnd-kit/sortable, TanStack Query, Vitest (web), Playwright (e2e).

---

## Architecture invariants touched

- **Invariant 16 (board-view persistence).** Drag-reorder is a view-state write to the **`views`** row (`order`), via the existing `config:write` PATCH — same convergence as the menu Move up/down. It does NOT touch `documents.board_position` and introduces no `?view=`-pinned gate. Persist whenever a drop resolves.
- **Invariant 4 (HTTP authorization) / 5 (write atomicity + event):** reuses the existing authed `PATCH /views/:id` route (each order write goes through `txWithEvents` + `view.updated` with the route's authorized scope). No new write surface.

## No threat model

No new attacker surface: drag is a client interaction persisting an integer `order` through an existing authed route with an existing Zod validator. (The 1a trigger list does not fire — no new URL, parse, token, or tenancy surface.)

## Acceptance flows (user-facing)

| # | Flow | Edges |
|---|------|-------|
| D1 | Drag a view DOWN past one neighbor → persists | **Empty:** single-view table → no drag (nothing to reorder). **Boundary:** drag to first / last position. **Concurrent:** the optimistic order shows immediately, settles after invalidate. **Mid-flow fail:** PATCH 4xx → toast + the list reverts on invalidate. |
| D2 | Drag a view UP several slots at once → lands in the dropped position | **Wrong-order:** multi-slot move (not just adjacent) lands correctly (the full-reseat handler, not ±1). |
| D3 | Reorder persists across reload | order lives on the views row (inv 16). |
| D4 | Drag does not break click/expand | a quick click still navigates (activation distance 5px); the chevron still toggles; projects/tables are NOT draggable. |

---

## File Structure

- Modify: `apps/web/src/components/shell/rail.tsx` — add optional `sortableGroup?: string` + `draggable?: boolean` to `NavItem`.
- Modify: `apps/web/src/lib/rail-tree.ts` — set `sortableGroup: table.id` + `draggable: true` on view NavItems; add `onReorderViews?(pslug, tslug, orderedViewIds: string[])` to `RailTreeHandlers`; thread `tslug`/group onto view nodes so onDragEnd can resolve them.
- Modify: `apps/web/src/components/shell/rail-tree.tsx` — wrap the root `RailTree` render in a `DndContext` (sensors, onDragEnd); wrap each node's view-children in a `SortableContext` (verticalListSortingStrategy); make a view `RailTreeNode` use `useSortable` when `item.draggable`. Pass an `onReorder` callback down.
- Modify: `apps/web/src/routes/w.$wslug.tsx` — implement `onReorderViews`: reassign spaced orders to the dropped order, PATCH each changed view, invalidate.
- Create: `apps/web/src/lib/view-reorder.ts` — pure `reorderViewIds(ids, activeId, overId)` + `spacedOrders(ids)` helpers (unit-tested).
- Test: `apps/web/src/lib/view-reorder.test.ts` (pure logic), extend `apps/web/src/lib/rail-tree.test.ts` (view nodes carry sortableGroup), `apps/web/tests/e2e/view-drag-reorder.spec.ts` (real-browser drag).

---

── REVIEW GATE 1 (pure reorder logic) ──
Task 1. STOP: `cd apps/web && npx vitest run src/lib/view-reorder.test.ts` + tsc, then `/code-review` on the logic.

## Task 1: Pure reorder helpers (RED-first)

**Files:**
- Create: `apps/web/src/lib/view-reorder.ts`
- Test: `apps/web/src/lib/view-reorder.test.ts`

- [ ] **Step 1: RED test** (`apps/web/src/lib/view-reorder.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { reorderViewIds, spacedOrders } from './view-reorder.ts';

describe('reorderViewIds', () => {
  it('moves active down past over (adjacent)', () => {
    expect(reorderViewIds(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c']);
  });
  it('moves active up several slots at once', () => {
    expect(reorderViewIds(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });
  it('no-op when active === over', () => {
    expect(reorderViewIds(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
  it('no-op when an id is absent', () => {
    expect(reorderViewIds(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });
});

describe('spacedOrders', () => {
  it('assigns 0,10,20 by position', () => {
    expect(spacedOrders(['a', 'b', 'c'])).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 10 },
      { id: 'c', order: 20 },
    ]);
  });
});
```

- [ ] **Step 2: verify RED** — `cd apps/web && npx vitest run src/lib/view-reorder.test.ts` → FAIL (module/exports missing).

- [ ] **Step 3: implement** (`apps/web/src/lib/view-reorder.ts`)

```ts
/** Move `activeId` to the slot of `overId` (insert-before semantics, like dnd-kit's
 *  arrayMove on the displayed order). Returns the new id order. No-op if either id
 *  is absent or they're equal. Pure — the single source of reorder truth. */
export function reorderViewIds(ids: string[], activeId: string, overId: string): string[] {
  if (activeId === overId) return ids;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Assign gap-spaced (0,10,20,…) orders by position. Reassigning ALL views on every
 *  reorder normalizes any drifted/colliding `order` values as a side effect. */
export function spacedOrders(ids: string[]): Array<{ id: string; order: number }> {
  return ids.map((id, i) => ({ id, order: i * 10 }));
}
```

- [ ] **Step 4: GREEN + tsc** — vitest passes; `bun x tsc --noEmit` clean.
- [ ] **Step 5: commit** — `git add apps/web/src/lib/view-reorder.ts apps/web/src/lib/view-reorder.test.ts && git commit -m "feat: pure view-reorder helpers (reorderViewIds + spacedOrders)"`

---

── REVIEW GATE 2 (rail dnd wiring + route) ──
Tasks 2–4. STOP: full web suite + tsc + e2e, then `/code-review`.

## Task 2: NavItem drag fields + buildRailTree wiring

**Files:**
- Modify: `apps/web/src/components/shell/rail.tsx` (NavItem type)
- Modify: `apps/web/src/lib/rail-tree.ts` (set fields on view nodes; add handler type)
- Test: extend `apps/web/src/lib/rail-tree.test.ts`

- [ ] **Step 1: read** `rail.tsx` `NavItem` interface + `rail-tree.ts` view-node map + `RailTreeHandlers`.

- [ ] **Step 2: RED test** — append to `rail-tree.test.ts`: a view node carries `sortableGroup === <table.id>` and `draggable === true`; project/table/wiki nodes do NOT. (Use the existing `viewNodesOf`/tree-walk helpers.)

- [ ] **Step 3: verify RED** — `npx vitest run src/lib/rail-tree.test.ts` → FAIL.

- [ ] **Step 4: implement**
  - In `rail.tsx` `NavItem`, add: `draggable?: boolean;` and `sortableGroup?: string;` (the group a sortable node belongs to — the owning table id).
  - In `rail-tree.ts`: add to `RailTreeHandlers`:
    ```ts
    /** Persist a drag-reorder: `orderedViewIds` is the table's full view list in its
     *  NEW order. The handler reassigns spaced orders + PATCHes the changed views. */
    onReorderViews?: (pslug: string, tslug: string, orderedViewIds: string[]) => void;
    ```
  - In the view-node map, set `draggable: true` and `sortableGroup: table.id` on each view NavItem (only when `handlers.onReorderViews` is provided — so it degrades gracefully). Keep the existing Move up/down menu items unchanged.

- [ ] **Step 5: GREEN + tsc.**
- [ ] **Step 6: commit** — `feat: NavItem drag fields + view nodes marked sortable in buildRailTree`

## Task 3: dnd-kit wiring in rail-tree.tsx

**Files:**
- Modify: `apps/web/src/components/shell/rail-tree.tsx`
- Test: Tier-B wiring — the reorder math is Task 1 (unit), the drag is Task 4 (e2e). NO bespoke unit test (jsdom can't drive dnd-kit — same rationale as kanban). State this in the report.

- [ ] **Step 1: read** `kanban-view.tsx` (DndContext + sensors + DragOverlay + MeasuringStrategy) and `wiki-tree.tsx` (useSortable-in-tree shape) to mirror conventions exactly.

- [ ] **Step 2: implement**
  - `RailTree` (root) accepts an optional `onReorder?: (group: string, activeId: string, overId: string) => void`. Wrap its `<ul>` in a `DndContext` with `sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))` (the 5px constraint preserves click/expand — D4). `onDragEnd`: read `active.id`/`over.id` + the dragged node's `sortableGroup` from `active.data.current`; if both share a group and differ, call `onReorder(group, activeId, overId)`. Use `closestCenter` collision (vertical list). Add a `DragOverlay` rendering the dragged row's label (portaled, like kanban) — optional but matches the polished kanban feel; if simplest, skip overlay and rely on the sortable transform.
  - Each table node wraps its view-children `<ul>` in a `SortableContext items={viewIds} strategy={verticalListSortingStrategy}`. View ids = the `view:`-prefixed NavItem ids (or a stable id field — use `item.id`).
  - A view `RailTreeNode` (when `item.draggable`) calls `useSortable({ id: item.id, data: { sortableGroup: item.sortableGroup } })` and applies `setNodeRef`, `transform`/`transition` style, and `{...attributes} {...listeners}` to a DRAG HANDLE on the row (NOT the whole row, so label-click still navigates — put listeners on the row container but rely on the 5px activation; mirror wiki-tree's TreeRow which spreads listeners on the row and still allows click). Non-draggable nodes render exactly as today.
  - Thread `onReorder` from `rail.tsx` (which gets it from the route handlers) down to `RailTree`.

- [ ] **Step 3: tsc clean + full web suite green** (`bun x tsc --noEmit`, `npx vitest run` — existing rail tests must still pass; the known `list-view-create` flake may need one rerun).
- [ ] **Step 4: commit** — `feat: dnd-kit drag-reorder wiring for view rows in the rail`

## Task 4: route handler onReorderViews

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx`
- Test: seam covered by Task 1 (math) + Task 5 (e2e). Tier B.

- [ ] **Step 1: read** the handlers useMemo (onMoveView / onRenameView) + how `viewsByTable` resolves a table's views (to map ids → current orders).

- [ ] **Step 2: implement** `onReorderViews` in the handlers object + thread `onReorder` into `<Rail>`:
  ```ts
  onReorderViews: async (pslug, _tslug, orderedViewIds) => {
    try {
      // Reassign spaced orders by position (normalizes drift/collisions), PATCH
      // only the views whose order actually changed.
      const next = spacedOrders(orderedViewIds); // from lib/view-reorder.ts
      const current = /* the table's views from viewsByTable, id → order */;
      await Promise.all(
        next
          .filter((n) => current.get(n.id) !== n.order)
          .map((n) => client.patch(`/api/v1/w/${wslug}/p/${pslug}/views/${n.id}`, { order: n.order })),
      );
      await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  },
  ```
  The `onReorder(group, activeId, overId)` passed to `<Rail>` resolves the table's current view-id order (from `viewsByTable`/the built tree), computes `reorderViewIds(ids, activeId, overId)`, and calls `onReorderViews(pslug, tslug, newIds)`. Resolve `pslug`/`tslug` from the `group` (table id) — the built tree already maps table→project; thread a small lookup. IMPLEMENTER: ground-truth how to get pslug+tslug+ordered view ids from a table id at this layer (viewsByTable is keyed by table id; project/table slugs come from projectList/tablesByProject). Build to the real shapes.

- [ ] **Step 3: tsc + full web suite.**
- [ ] **Step 4: commit** — `feat: wire view drag-reorder persistence (spaced-order reseat)`

---

## Task 5: e2e drag acceptance + finish

- [ ] **Step 1: write** `apps/web/tests/e2e/view-drag-reorder.spec.ts` mirroring `view-reorder.spec.ts`'s setup (signUpFresh/createWorkspace/createProject, createListView ×2-3), then drive a real drag. dnd-kit's PointerSensor needs dispatched **PointerEvents** (NOT page.mouse — see the kanban lesson in hardening-pass.spec.ts): pointerdown on the source view row, stepped pointermoves past the target (≥5px to clear activation), pointerup. Assert via wire truth (`GET .../views` sorted by order) that the dragged view moved, AND via rail DOM y-position. Cover D1 (down), D2 (multi-slot up), D3 (reload persist).
- [ ] **Step 2: run** `npx playwright test view-drag-reorder.spec.ts` → green. (Keep the existing `view-reorder.spec.ts` menu tests green too.)
- [ ] **Step 3: full gates** — server/shared/web suites, tsc ×3, `bun run check:invariants`.
- [ ] **Step 4: `/shakeout`** then `/finish`.

---

## Self-review

**Coverage:** D1/D2/D3 → Task 5 e2e + Task 1 math; D4 (click/expand survives) → 5px activation + handle scoping in Task 3. **Type consistency:** `reorderViewIds(ids, active, over): string[]` and `spacedOrders(ids): {id,order}[]` used identically in Task 1 (def+test), Task 4 (handler). `onReorderViews(pslug, tslug, orderedViewIds: string[])` consistent across Task 2 (type) + Task 4 (impl). `NavItem.sortableGroup`/`draggable` set in Task 2, read in Task 3. **No placeholders** except two explicit IMPLEMENTER ground-truth notes (pslug/tslug-from-table-id lookup; current-orders map) — pointers to confirm real shapes, not hand-waves.
