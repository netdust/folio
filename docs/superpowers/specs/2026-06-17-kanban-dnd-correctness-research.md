# Kanban DnD correctness — research findings (2026-06-17)

**Context:** "kanban DnD not smooth" came up 3× and prior fixes failed. Stefan reframed: it's NOT jank/perf — it's DROP-CORRECTNESS bugs. Three independent research agents cross-validated against re-fetched library source (dnd-kit, Atlassian Pragmatic, rbd/hello-pangea). Keep @dnd-kit; steal the good libraries' patterns.

## The 3 bugs share ONE missing primitive: closest-EDGE (pointer vs over-card MIDPOINT)

Our board: `apps/web/src/components/views/kanban-view.tsx` (DndContext + onDragEnd), `apps/web/src/components/kanban/board-drag.ts` (`dropSlotPosition` = index→rank), `board-reorder.ts` (`computeReorderPosition`→`rankBetween`). It has NO `onDragOver`; resolves slot only at drop; derives before/after from ARRAY INDICES + `closestCorners`.

### Bug 1 — "drop at bottom → lands second"
Index-derivation bug, not collision. `closestCorners` reports the over-card but not which SIDE. dnd-kit's own example uses a fragile "active top clears over bottom" heuristic; at the bottom `closestCorners` often returns the 2nd-to-last card so `overIdx+1` lands mid-list. Our `dropSlotPosition` derives `movingDown` from array indices (board-drag.ts:82-86) — same fragility.
- **Proven fix (Pragmatic `attachClosestEdge` + `getReorderDestinationIndex`):** before/after = pointer-Y vs over-card vertical MIDPOINT (`Math.abs(client.y-rect.top)` vs `Math.abs(rect.bottom-client.y)`), independent of drag distance, with `-1` adjustment for the removed dragged item when moving FORWARD in the same list → bottom-half of last card always yields `index===length` = true append. rbd/hello-pangea use the same midpoint rule.
- **Adopt:** pass a `closestEdge:'top'|'bottom'` into `dropSlotPosition`; replace `movingDown` index logic with: cross-col → `edge==='bottom'?overIdx+1:overIdx`; same-col forward (activeOrigIdx<overIdx) → `edge==='bottom'?overIdx:overIdx-1`; else → `edge==='bottom'?overIdx+1:overIdx`. Feeds existing `computeReorderPosition`→`rankBetween` unchanged. ~15 lines, unit-testable (regression: bottom-half of last card → index===length).

### Bug 2 — no gap opens / can't aim / cross-column flaky (NO onDragOver)
Two schools:
- ❌ **move-items-in-onDragOver** (dnd-kit MultipleContainers): mutates column arrays during drag for a real gap. Documented bug family: re-render storms (#1421 — reporter concluded onDragEnd-only is safest), boundary oscillation (#1263), drop flicker (#1522). WORSE for us: it mutates the array before drop, so `rankBetween(lo,hi)` computes against a visually-mutated state racing the server.
- ✅ **drop-indicator LINE** (Pragmatic/rbd/Trello/Jira): card never leaves its array; render a 2px line between cards via closest-edge; bg-highlight for empty columns. No live mutation, no oscillation. The line position IS the (prev,next) neighbor pair `rankBetween` needs — structural fit for fractional-rank-at-drop.
- **DECISION: line school.** Add `onDragOver` that sets `{overId, edge}` indicator state ONLY (never setItems); render absolutely-positioned line on the over-card top/bottom (no sibling reflow → no oscillation). Reuses Bug 1's edge calc. Keep `closestCorners` for picking the over-card (bug was never collision).

### Bug 3 — just-moved card can't be repositioned until you drag something else
`MeasuringStrategy.Always` covers DROPPABLES only. `@dnd-kit/core@6.3.1`: no `strategy`/`frequency` under draggable; the dragged rect is memoized by `activeNode` ELEMENT IDENTITY (`useInitialRect`→`useInitialValue`→`useLazyMemo`). Our `key={doc.id}` (kanban-view.tsx:365) REUSES the element across a cross-column move → returns the old-column rect. Our existing `droppable:{strategy:Always}` + reassuring comment (lines 329-336) CANNOT fix this — wrong half of the measuring system.
- **Fix:** card key → `` `${doc.id}:${col.value ?? '__unset__'}` `` so a cross-column move REMOUNTS the moved card, busting the identity-keyed cache. Optionally `measuring.draggable.measure: getClientRect` (belt-and-suspenders; does NOT fix alone). MUST verify in real browser — jsdom zeroes rects and masks it.

## Bottom line: smallest coherent change set (line school, stay on dnd-kit)
1. `getClosestEdge(pointerY, over.rect)` helper (~5 lines) — shared by Bug 1 + Bug 2.
2. Bug 1: rewrite `dropSlotPosition` direction logic to use edge + Pragmatic's index formula. Pure, RED-first.
3. Bug 2: `onDragOver` → `{overId, edge}` state; render drop-line on over-card (bg-highlight empty cols). NOT move-items.
4. Bug 3: card key → `${doc.id}:${columnValue}`; keep droppable Always.

**Caveats:** Bugs 2 & 3 are pointer/collision-dependent → jsdom masks them → MUST browser-verify (Stefan, logged in). Keep `closestCorners`. rbd "lazy-collect no cache" claim is architectural (rbd archived), not re-quoted; all dnd-kit/Atlassian claims are re-fetched verbatim source (accessed 2026-06-17).
