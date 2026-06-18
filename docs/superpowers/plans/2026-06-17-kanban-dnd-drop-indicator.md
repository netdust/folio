# Kanban DnD correctness — drop-indicator-line fix (2026-06-17)

**Classification: Class A** (multi-task fix bundle with new interaction logic, sequenced, gated).
**Branch:** `phase-6/views` (current). Frontend-only — every changed file is under `apps/web`.
**Source of truth for the APPROACH:** `docs/superpowers/specs/2026-06-17-kanban-dnd-correctness-research.md` (three cross-validated research agents; library source re-fetched 2026-06-17). This plan is the executable derivation; the research doc is the WHY.

> **Restate the load-bearing decisions up front (do not re-litigate):**
> - **LINE school, NOT move-items.** `onDragOver` sets indicator STATE only (`{overId, edge}`). It NEVER mutates a column array / calls setItems. A 2px absolutely-positioned drop-line renders between cards. The move-items school is rejected (research §Bug 2: re-render storms #1421, oscillation #1263, drop flicker #1522, and it races `rankBetween` against a visually-mutated array).
> - **Keep `closestCorners`.** The bug was never collision detection; it was index-derivation (Bug 1) and the missing onDragOver (Bug 2). `collisionDetection={closestCorners}` stays as-is — an existing test asserts it.
> - **Browser-only verification boundary.** Bugs 2 & 3 and the drop-line are pointer/collision/layout-dependent. **jsdom returns ZEROED rects** and masks them entirely. Only the PURE index math (Bug 1's `dropSlotPosition` + the new `getClosestEdge`) is unit-coverable. Everything else is Stefan-in-the-real-browser at shake-out. This is the `test-effectiveness` "jsdom ≠ real-DOM" failure mode, stated explicitly per-task.

---

## Gate decisions (each evaluated, one-line reason)

| Gate | Fires? | Reason |
|------|--------|--------|
| **1a Threat-modeling** | **NO** | Pure client-side interaction logic. No user-controlled URL, no auth/session/token surface, no untrusted parsing, no BYOK, no multi-tenancy boundary, no server outbound. The ONLY write is the pre-existing `boardPosition`/`status`/frontmatter PATCH via the unchanged `update.mutateAsync` path — its payload shape and authorization are untouched. Ran the trigger list literally, not by gut: every trigger is absent. |
| **1b Architecture-invariants** | **CITE (respected, unchanged)** | Touches the **invariant 18(d)** convergence surface (`viewRendererFor`/KanbanView is the kanban renderer) and rides **invariant 5/6** (every write through `txWithEvents`/the document service emits an event) and **invariant 8** (SSE→react-query invalidate, optimistic write). This change writes NO new convergence point and bypasses none: the drop still commits via the existing `useUpdateDocument().mutateAsync` (server-side `txWithEvents` + event unchanged). The plan must NOT add a second write path. Confirmed against `ARCHITECTURE-INVARIANTS.md`. |
| **1g Feature-acceptance** | **YES** | The kanban board is a user-driven interactive feature; drop behavior is the literal thing being fixed. `## Acceptance flows` matrix embedded below. |
| **API/boundary design** | NO | No new endpoint, module surface, or shared type crosses a boundary. `getClosestEdge` is an internal helper; the `{overId, edge}` state is component-local. |
| **Stage 0 brainstorm** | NO | Approach already converged in the research doc (Stefan designated it the source of truth). No open design question remains. |

### Stage 1c — premise ground-truth (DONE during planning; corrections baked in)

Three premises were verified against current source before this plan shipped:

1. **`dropSlotPosition` derives direction from array indices** — CONFIRMED, `board-drag.ts:82-86` (`movingDown = activeOrigIdx < overOrigIdx`). Bug 1 fix replaces exactly this block.
2. **No `onDragOver` on the board** — CONFIRMED, `kanban-view.tsx` `<DndContext>` (lines 321-340) wires only `onDragStart`/`onDragEnd`/`onDragCancel`. Bug 2 adds `onDragOver`.
3. **Card key is `key={doc.id}`** — CONFIRMED, `kanban-view.tsx:365`. Bug 3 changes it to `` `${doc.id}:${col.value ?? '__unset__'}` ``.

4. **dnd-kit 6.3.1 event API — CORRECTION to the research doc's pointer-Y assumption.** Verified `@dnd-kit/core@6.3.1` `dist/types/events.d.ts` + `store/types.d.ts`:
   - `DragOverEvent extends DragMoveEvent extends DragEvent`; `DragEndEvent extends DragEvent`. `DragEvent` exposes: `activatorEvent: Event`, `active: Active`, `collisions: Collision[] | null`, `delta: Translate` (`{x, y}`), `over: Over | null`.
   - `Over` carries **`rect: ClientRect`** (`{ width, height, top, left, right, bottom }`) — the over-card's geometry. This is the over-card midpoint source: `over.rect.top + over.rect.height / 2`.
   - **There is NO live `client.y` / pointer-Y on the drag event.** The research doc's `Math.abs(client.y - rect.top)` formula assumed a pointer coordinate that dnd-kit does not hand to `onDragOver`/`onDragEnd`. `activatorEvent` is the *start* pointer (static); `delta` is cumulative movement.
   - **The faithful "where is the dragged card now" is the active card's live center**, read from `active.rect.current.translated` (the live, moved rect; `store/types.d.ts:30` — `rect: MutableRefObject<{ initial; translated }>`). So the edge comparison is **dragged-card-center-Y vs over-card-midpoint-Y**, not pointer-vs-midpoint.
   - **Therefore `getClosestEdge` takes two numbers** — `activeCenterY` and the over-card `rect` — and is decoupled from "where does Y come from." The CALLER (onDragEnd/onDragOver) is responsible for computing `activeCenterY = active.rect.current.translated.top + height/2`, with a documented fallback to `over.rect` midpoint if `translated` is null (drag just started). This keeps the helper pure + unit-testable and quarantines the one dnd-kit-API-shaped line to the call sites. **This is the single most important plan-correction: the implementer must NOT reach for `event.client.y` — it does not exist in 6.3.1.**

---

## Threat model

**Not applicable** — gate 1a does not fire (see table above; trigger list ran literally, all absent). No `## Threat model` section is authored, by design, not by omission.

---

## Acceptance flows

User-facing feature → `feature-acceptance` matrix. **Layer column is the verification boundary.** Per Stage 1c-4 and the research doc: pointer/collision/layout behavior is jsdom-masked, so those rows are **browser-only** (Stefan, logged in, at shake-out). Only the pure index math is **unit**.

| # | Flow (intended use) | Actor | Layer | Steps | Expected | Edges to drive (six classes) |
|---|---------------------|-------|-------|-------|----------|------------------------------|
| F1 | **Drop a card at the BOTTOM of a column** (Bug 1) | member | **unit** (math) + **browser** (gesture) | grab card → drag past the last card → release in the bottom half of the last card | Card lands **LAST**, not second | **empty**: drop into an empty column → appends (index 0 / true append); **denied**: viewer with no drag handle — n/a (board has no role-gated drag in v1, single-team, documented exclusion); **wrong-order/re-entry**: drop on the card's OWN current slot → no-op (no PATCH); **concurrent/double**: two rapid drops before the first PATCH resolves → second computes against optimistic state, last-write-wins by `rankBetween` (pre-existing pendingSlugs behavior, must not regress); **boundary**: bottom-half of the LAST card MUST yield `index === length` (the regression assertion); top-half of the FIRST card → `index === 0`; **mid-flow fail**: PATCH 500s → existing toast + the existing optimistic path (no NEW rollback logic added) |
| F2 | **Reorder within a column up/down by one slot** (Bug 1 regression guard) | member | **unit** + **browser** | drag a middle card up one / down one, release in the target card's near half | Lands exactly one slot up / one slot down (not "only moves when you jump 2+") | **boundary**: down-by-one onto the next card → lands AFTER it (`'c' < pos < 'e'` style, the existing test); up-by-one onto the previous card → lands BEFORE it; **wrong-order**: drop on own slot → no-op; the other four classes inherit F1 |
| F3 | **Drag a card to a DIFFERENT column at a specific slot** (cross-column) | member | **browser** | drag a card into another column, hover between two cards, release | Lands in the target column at the hovered slot; status/group updates | **empty**: drop into an empty target column → column highlights, card appends; **boundary**: drop above the first / below the last card of the target column; **concurrent**: cross-column move while a prior PATCH is pending; **mid-flow fail**: PATCH 500s → toast; **wrong-order/re-entry**: covered by F4; **denied**: n/a (as F1) |
| F4 | **Immediately re-drag a just-moved card to a correct slot** (Bug 3) | member | **browser ONLY** | move a card to column B → WITHOUT touching anything else, immediately grab it again and reorder it within B | Second drag works on the FIRST try (no "I have to move another card first") | **wrong-order/re-entry** IS the headline edge here (re-drag immediately = the bug); **boundary**: re-drag to the bottom slot of B (Bug 1 + Bug 3 interaction); **concurrent**: re-drag before the first move's PATCH resolves; **empty/denied/mid-flow**: inherit F3. **jsdom CANNOT see this** — it's element-identity-cache + real-rect dependent. |
| F5 | **Drop-line appears between cards on hover and the card lands where the line was** (Bug 2) | member | **browser ONLY** | drag a card, hover slowly over a column; watch the 2px line track the nearest edge; release | A thin line shows on the over-card's top or bottom edge per pointer half; releasing lands the card exactly where the line sat | **empty**: hover an empty column → background highlight (no line, the column-`isOver` path); **boundary**: hover the very top of the first card → line on its TOP; very bottom of the last → line on its BOTTOM; **wrong-order/re-entry**: drag-cancel (Esc) → line clears, no PATCH; drag away then back → line re-appears correctly; **concurrent**: line must NOT cause sibling reflow/oscillation (the reason it's absolutely-positioned, not an inserted gap); **mid-flow fail**: PATCH 500s after a lined drop → toast, line already cleared on dragEnd; **denied**: n/a |
| F6 | **Sorted-mode card-over-card → auto-switch-to-Manual still works** (regression guard) | member | **unit** (resolveDrop) + **browser** | with a field sort active (e.g. title asc), drop a card on another card in the SAME column | View flips Sort→Manual (bus + persisted `sort: []`) AND the reorder lands; toolbar label reads "Manual" | **wrong-order/re-entry**: cross-column card drop in sorted mode → plain regroup (no board_position, no auto-switch) — the existing negative case; **boundary**: the auto-switched reorder must use the NEW edge-aware index (Bug 1 flows into `auto-manual-reorder`'s `slotPosition` too); the other classes inherit F1. **Existing tests cover the resolveDrop + persist seam; do NOT regress them.** |

**Manifest expectation at shake-out:** F1/F2's MATH rows + F6's resolveDrop row → `pass` via vitest. F1/F2's gesture rows, F3, F4, F5, F6's browser row → driven by Stefan in the real browser; any not driven are recorded `unverified-no-browser` (residual risk), never laundered to `pass`. No UI row is `pass` without a browser driving it.

---

## Task breakdown

Sequenced per the research doc: pure edge+index math FIRST (independently shippable + unit-verifiable), then the tiny key change, then the largest browser-verified piece (onDragOver + line). Tier per `testing-workflow` (that skill owns the rule).

### Phase 1 — Bug 1: closest-edge math + edge-aware drop index (PURE, the only unit-bitable part)

**Task 1.1 — `getClosestEdge` helper (the ONE shared edge primitive)**
- New file `apps/web/src/components/kanban/closest-edge.ts` (sits beside `board-drag.ts`, imported by both the pure logic and the view).
- Signature: `getClosestEdge(activeCenterY: number, overRect: { top: number; height: number }): 'top' | 'bottom'`. Pure, no dnd-kit import. Compares `activeCenterY` to `overRect.top + overRect.height / 2`: above midpoint → `'top'`, at-or-below → `'bottom'` (document the tie-break direction).
- **Tier A, RED-first.** Test contract: assert `activeCenterY` above the over-card midpoint → `'top'`; at-or-below → `'bottom'`; exactly-at-midpoint → the documented tie value. New file `apps/web/src/components/kanban/closest-edge.test.ts`.
- **No bloat:** this is the SOLE midpoint primitive. Tasks 1.2 and 3.1 import it; neither re-implements the comparison.

**Task 1.2 — rewrite `dropSlotPosition` direction logic to be edge-aware (Bug 1 core)**
- `apps/web/src/components/kanban/board-drag.ts`: add a `closestEdge: 'top' | 'bottom'` parameter to `dropSlotPosition`. Replace the `movingDown`/`targetIndex` block (lines 82-86) with the Pragmatic `getReorderDestinationIndex` formula:
  - cross-column (active not in this column's ordered ids) → `edge === 'bottom' ? overIdx + 1 : overIdx`
  - same-column forward (`activeOrigIdx !== -1 && activeOrigIdx < overIdx`) → `edge === 'bottom' ? overIdx : overIdx - 1`
  - else (same-column backward / not-forward) → `edge === 'bottom' ? overIdx + 1 : overIdx`
  - `overIdx` continues to be computed from `idsWithoutActive` (the active-removed array), exactly as today, so it feeds `computeReorderPosition` unchanged. `activeOrigIdx` is read from the active-removed array's relationship — re-derive carefully: today it reads `orderedDocIds.indexOf(activeId)` BEFORE filtering; keep that, but the forward/backward decision now also keys on edge. **`computeReorderPosition` → `rankBetween` is NOT touched** (the index just flows in).
- **Tier A, RED-first.** Test contract (extend `board-drag.test.ts` `describe('dropSlotPosition')`):
  - **MANDATORY regression — bottom-half of last card → true append:** dragging onto the last card with `edge='bottom'` yields a position **greater than the last remaining card's** (i.e. effective `index === length`). This is the literal "lands second" bug; it MUST go RED against the current code first.
  - same-column **down-by-one** with `edge='bottom'` onto the next card → lands AFTER it (preserve the existing `'c' < pos < 'e'` assertion intent, now edge-driven).
  - same-column **up-by-one** with `edge='top'` onto the previous card → lands BEFORE it.
  - cross-column drop with `edge='top'` → before the over-card; `edge='bottom'` → after.
  - top-half of the first card (`edge='top'`) → `index === 0` (rank before all).
- **Existing-test reconciliation (call out the bug-encoded assertions):** the current `dropSlotPosition` tests pass an `overDocId` only and infer direction from array order. They now need an `edge` argument. Where an OLD assertion encoded the *direction-from-index* behavior (the `movingDown` heuristic), update it to pass the explicit edge that reproduces the SAME intended outcome — and annotate in the test WHY (the old call relied on the index heuristic that Bug 1 removed). Do NOT silently flip an assertion to match new output: if an old assertion's *expected outcome* was correct (e.g. "down-by-one lands after"), keep the outcome and feed the edge that produces it; only the input shape changed, not the truth.

**Task 1.3 — thread `closestEdge` from the view's `slotPosition` wrapper into the call (onDragEnd side)**
- `apps/web/src/components/kanban/kanban-view.tsx`: the `slotPosition(col, activeId, overDocId)` wrapper (lines 219-229) gains a `closestEdge` param and passes it to `dropSlotPosition`. In `onDragEnd`, compute `activeCenterY` from `active.rect.current?.translated` (fallback to `over.rect` midpoint when `translated` is null) and call `getClosestEdge(activeCenterY, over.rect)` to get the edge — for the `reorder`, `auto-manual-reorder`, and `regroup-reorder` branches that currently call `slotPosition`. The `null` overDocId (whitespace append) path needs no edge (append is append).
- **Tier B — `no unit test: Tier B, dnd-kit-event-glue`.** This wires the real dnd-kit `over.rect`/`active.rect` (zeroed in jsdom) into the pure helper. The pure math is covered by 1.1/1.2; the wiring is browser-verified (F1/F2/F6 gesture rows). The existing `kanban-view-dnd.test.tsx` drives a synthetic `onDragEnd` with a hand-built event that has NO `over.rect`/`active.rect` — so the fallback path must be safe under that test (it currently passes `{ over: { id: 'd1' } }` only). **Reconciliation requirement:** the existing synthetic events in `kanban-view-dnd.test.tsx` omit `over.rect` and `active.rect`; the new code MUST default gracefully (treat missing rect as `'bottom'` or as append, documented) so the four existing synthetic-drag tests stay green WITHOUT being rewritten to fabricate rects. If a test legitimately must assert the edge, that belongs in the browser pass, not jsdom.

> **── REVIEW GATE ── (tier: STANDARD — pure interaction-logic + one glue wiring; no 1a surface, no invariant convergence point rewritten, no data layer)**
> Cluster = Tasks 1.1, 1.2, 1.3 (3 tasks). Reviewer holds: the edge primitive, the index formula, the one wiring seam. Verify: the Bug-1 regression test is RED-first then GREEN; the existing `board-drag.test.ts` + `kanban-view-dnd.test.tsx` are green (with the documented input-shape-only updates); no second midpoint implementation exists; `computeReorderPosition`/`rankBetween` untouched.
> **Integration gate:** `cd apps/web && npx vitest run src/components/kanban/closest-edge.test.ts src/components/kanban/board-drag.test.ts src/components/views/kanban-view-dnd.test.tsx` all green; `cd apps/web && bun x tsc --noEmit` clean.
> **Independently shippable:** Bug 1 is a complete, verifiable fix on its own (the "lands second" bug is gone). Could merge here if Stefan wants Bug 1 alone first.

### Phase 2 — Bug 3: card key remount (TINY)

**Task 2.1 — change the card key to bust the identity-cached rect**
- `apps/web/src/components/views/kanban-view.tsx:365`: `key={doc.id}` → `` key={`${doc.id}:${col.value ?? '__unset__'}`} ``. So a cross-column move REMOUNTS the moved card, busting dnd-kit's `useInitialRect`→`useInitialValue` element-identity-keyed cache (the half `MeasuringStrategy.Always` cannot reach — it covers droppables, this is the draggable rect).
- Keep the existing `measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}` (an existing test asserts it; it's the droppable half and still correct). Do NOT remove it.
- The research doc notes `measuring.draggable.measure: getClientRect` as optional belt-and-suspenders that does NOT fix alone — **omit it** (no bloat; the key change is the actual fix). If the browser pass (F4) shows residual staleness, add it then as a documented follow-up, not speculatively now.
- **Tier B — `no unit test: Tier B, remount-key change verified only by real-DOM rect identity`.** jsdom zeroes rects → the stale-rect bug is invisible there, so a jsdom test would be a false-green theater. The existing `configures Always droppable measuring` test must STAY green (the measuring config is unchanged). Verification is F4 in the browser. State this explicitly in the commit.

> **── REVIEW GATE ── (tier: LIGHT — single one-line key change, no logic, no new surface)**
> Cluster = Task 2.1 (1 task). Reviewer holds: confirm the key uses the SAME column-value stringification as `KanbanColumn`'s `colId` (`col.value ?? '__unset__'`) so keys are consistent; confirm `measuring.droppable.Always` is untouched; confirm no test was forced green by fabricating rects.
> **Integration gate:** `cd apps/web && npx vitest run src/components/views/kanban-view-dnd.test.tsx` green (the measuring-config test still passes); `bun x tsc --noEmit` clean.

### Phase 3 — Bug 2: onDragOver indicator state + drop-line render (LARGEST, browser-verified)

**Task 3.1 — add `onDragOver` that sets `{overId, edge}` indicator state (STATE ONLY — never setItems)**
- `apps/web/src/components/views/kanban-view.tsx`: add `const [dropIndicator, setDropIndicator] = useState<{ overId: string; edge: 'top' | 'bottom' } | null>(null);`. Add an `onDragOver(event: DragOverEvent)` handler wired on `<DndContext>`:
  - if `!over` → `setDropIndicator(null)` and return.
  - if `over.id` is a `col-*` droppable (empty/whitespace) → `setDropIndicator(null)` (the column's existing `isOver` background highlight handles empty columns — F5 empty edge; do NOT draw a line for a column).
  - else compute `activeCenterY` (same `active.rect.current?.translated` center, fallback to `over.rect` midpoint) and `edge = getClosestEdge(activeCenterY, over.rect)`; `setDropIndicator({ overId: String(over.id), edge })`.
  - **NEVER mutate `columns` / call any setItems-equivalent.** The indicator is presentational state only; ranks are still computed at drop from `rankBetween`.
- Clear the indicator in BOTH `onDragEnd` and `onDragCancel`: `setDropIndicator(null)` (alongside the existing `setActiveId(null)`).
- Reuse `getClosestEdge` from Task 1.1 — **no duplicated midpoint math** (Stefan's no-duplication directive; the helper is the one primitive shared by onDragEnd and onDragOver).
- **Tier B — `no unit test: Tier B, dnd-kit onDragOver fires only under a real pointer drag`.** onDragOver never fires in jsdom (no pointer movement, no collision, zeroed rects). The edge MATH is already Tier-A covered (1.1). The seam (state set on a real hover) is F5 in the browser. Optionally extend `kanban-view-dnd.test.tsx` to assert `onDragOver` is WIRED (`captured.props?.onDragOver` is a function) — that mirrors the existing `wires a collisionDetection algorithm` test and is a cheap wiring assertion, not a behavior test; include it as a Tier-B wiring check (it bites if someone deletes the handler).

**Task 3.2 — render the drop-line on the over-card (absolutely-positioned, no reflow)**
- Thread `dropIndicator` down so each card knows whether to show a line and on which edge. Cleanest seam (decide at implementation, prefer the smallest prop surface):
  - Pass to `KanbanColumn` (already maps the cards) a per-card `indicatorEdge: 'top' | 'bottom' | null` derived as `dropIndicator?.overId === id ? dropIndicator.edge : null`, OR pass the whole `dropIndicator` and let the card compare its own id. Prefer passing a resolved `indicatorEdge` to `KanbanCard` so the card stays dumb.
- `apps/web/src/components/kanban/kanban-card.tsx`: in `CardBody` (or the `SortableCard` wrapper that owns the positioned container), when `indicatorEdge` is set, render a **2px absolutely-positioned line** on the card's top or bottom edge. Requirements:
  - The card wrapper must be `relative` (it currently is not explicitly — add `relative` to the card's className so the absolutely-positioned line anchors to it).
  - The line is `absolute left-0 right-0 h-[2px]` at `-top-[1px]` (edge `'top'`) or `-bottom-[1px]` (edge `'bottom'`), a visible accent color (reuse an existing token, e.g. `bg-primary`), `pointer-events-none`, sits in the 1.5-gap between cards. **Absolutely positioned so it adds ZERO layout height → no sibling reflow → no oscillation** (the explicit reason the line school beats move-items; research §Bug 2).
  - The `OverlayCard` (drag clone) NEVER shows a line (`indicatorEdge` is not passed to the overlay path).
  - The dragged card's own in-place node (opacity 0 while dragging) should not show its own line (guard: don't render the line on the card whose id === activeId, or simply rely on onDragOver setting `overId` to the OVER card, not the active one — `over.id` is never the active card during a drag).
- **Tier B — `no unit test: Tier B, presentational line + absolute positioning is a real-DOM/CSS contract jsdom can't measure`.** jsdom has no layout; the "no reflow / no oscillation / line sits in the gap" contract is only real in the browser (F5). A jsdom test could at most assert the line ELEMENT renders when a prop is set — include that as a cheap Tier-B render assertion in `kanban-card.test.tsx` (prop `indicatorEdge='top'` → a `[data-testid="drop-line"]` element with the top class is present; `null` → absent). That bites on "someone deletes the line element" but NOT on the positioning/oscillation contract — say so.
- **`## Sibling-site audit`:** the `'top' | 'bottom'` edge union is introduced in `getClosestEdge` (1.1) and consumed in `dropSlotPosition` (1.2), `onDragOver` state (3.1), the `indicatorEdge` prop (3.2), and the line render (3.2). Audit all five sites use the SAME union (no stray `'above'`/`'below'` synonym) — a single exported `type CardEdge = 'top' | 'bottom'` from `closest-edge.ts`, imported everywhere, makes a missing case a compile error. This is the one cross-cutting type; do not let it fork.

> **── REVIEW GATE ── (tier: STANDARD — multi-file UI behavior change, the indicator state + render; no 1a surface, no invariant convergence rewrite, no data layer; STANDARD ⇒ 2 finders + simplicity + a feature-acceptance browser pass, no security-sentinel)**
> Cluster = Tasks 3.1, 3.2 (2 tasks). Reviewer holds: the onDragOver-state-only discipline (assert NO array mutation / no setItems anywhere in the diff — this is the move-items-school rejection, the single most important review check here), the shared-edge-helper reuse (no duplicated midpoint), the absolutely-positioned-line-no-reflow contract, the indicator cleared on end+cancel, the `CardEdge` union used uniformly (sibling-site audit), the overlay never showing a line.
> **Integration gate:** `cd apps/web && npx vitest run src/components/kanban` (full kanban dir) green; `bun x tsc --noEmit` clean; `cd /home/ntdst/Projects/folio && bun run lint` exits 0 (warnings OK, only error-severity blocks; auto-fix import/format via `bunx biome check --write` from repo root).
> **Browser-verification gate (the real one for this cluster):** Stefan drives F3, F4, F5 (and re-confirms F1/F2 gestures) logged-in against the dev server. jsdom CANNOT verify these — they are recorded `unverified-no-browser` until Stefan drives them. This is the shake-out feature-acceptance pass; do NOT mark the cluster done on green vitest alone.

---

## Sequencing & shippability summary

1. **Phase 1 (Bug 1)** — pure math, unit-tested RED-first, **independently shippable & verifiable** (the "lands second" bug is fully fixed and proven by vitest alone).
2. **Phase 2 (Bug 3)** — one-line key change, browser-verified (F4).
3. **Phase 3 (Bug 2)** — onDragOver + drop-line, the largest piece, browser-verified (F5).

## Behavior-preservation checklist (must all still hold after the change)

- All five `resolveDrop` action kinds intact: `reorder` / `regroup` / `regroup-reorder` / `auto-manual-reorder` / `none` (no change to `resolveDrop` itself).
- Auto-switch Sort→Manual on a sorted-mode same-column card drop (`auto-manual-reorder` → `persistManualSort()` + reorder) — the reorder now uses the edge-aware index, outcome preserved (F6).
- Optimistic update + `pendingSlugs` set/clear around `update.mutateAsync` — untouched.
- `<DragOverlay dropAnimation={null}>` clone — untouched.
- `animateLayoutChanges: () => false` on the dragged `SortableCard` — untouched.
- `collisionDetection={closestCorners}` — kept (test asserts it).
- `measuring.droppable.strategy = Always` — kept (test asserts it).
- The single write path `update.mutateAsync` (invariant 5/6 via server `txWithEvents`) — no new write path added.
- Existing tests `board-drag.test.ts` (`dropSlotPosition` block gains an edge arg; outcomes preserved) and `kanban-view-dnd.test.tsx` (synthetic-drag tests stay green via the missing-rect fallback) — green, with only the documented input-shape updates, each annotated as "old call relied on the index-direction heuristic Bug 1 removed; same outcome, edge now explicit."

## Commands (CWD discipline — bash cwd persists & doubles paths; cd per command)

```bash
cd /home/ntdst/Projects/folio/apps/web && npx vitest run src/components/kanban        # kanban unit suite
cd /home/ntdst/Projects/folio/apps/web && npx vitest run src/components/views/kanban-view-dnd.test.tsx
cd /home/ntdst/Projects/folio/apps/web && bun x tsc --noEmit                            # typecheck (per-app; no root tsconfig)
cd /home/ntdst/Projects/folio && bun run lint                                           # exit 0 = pass (warnings OK)
cd /home/ntdst/Projects/folio && bunx biome check --write apps/web/src/components/kanban # auto-fix import/format only
```

## Handoff to Stage 2 (implementer)

Execute Phase 1 → REVIEW GATE → Phase 2 → REVIEW GATE → Phase 3 → REVIEW GATE → shake-out (Stefan drives the browser-only acceptance rows). Bug 1 is RED-first Tier A; Bugs 2 & 3 are Tier B with the explicit jsdom-can't-see-it rationale recorded at each task and re-stated at the Phase-3 browser-verification gate.
