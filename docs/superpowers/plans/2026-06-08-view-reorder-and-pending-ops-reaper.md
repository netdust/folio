# View-Reorder UI + pending_ops Reaper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two small, independent items from `tasks/retro-follow-ups.md` / `tasks/handoff-2026-06-09.md`: (A) a view-reorder UI in the rail (Move up / Move down), and (B) a `pending_ops` reaper that bounds the table's unbounded growth without ever touching a live confirmation.

**Architecture:**
- **(A)** Purely frontend. The data layer is complete: `views.order` (integer column), the views PATCH route (`config:write`) writes `order`, and the rail already sorts views by `order` (`apps/web/src/lib/rail-tree.ts:84-86`). Reorder = swap the `order` value of the dragged view with its adjacent neighbor via the existing `useUpdateView` mutation. No new endpoint, no new schema, no security surface.
- **(B)** A backend disk-hygiene sweep. `pending_ops` rows are status-flipped, never deleted (schema comment, `db/schema.ts:611`), so the table only grows. Add a `reapStalePendingOps(db)` service with a **provably safe** predicate (only terminal-and-old or long-abandoned-expired rows; never a live `pending`-within-TTL or `confirmed` row), wired as a boot-time fire-and-log sweep + a guarded interval — mirroring the existing `sweepOrphanedFolioApiTokens` / `reconcileAllowLists` conventions in `index.ts`.

**Tech Stack:** Bun + Hono + Drizzle (server), React + TanStack Query + dnd-kit-free menu actions (web), Vitest (web), bun test (server).

---

## Architecture invariants touched

- **Invariant 16 (board-view persistence).** Item A is a NEW view-state writer. The rule: group-by/sort/order are `views`-row attributes and persist via `useUpdateView` (the `views` writer), not via any other entity. Reorder writes `order` to the `views` row through `useUpdateView` — on-pattern. It does NOT re-introduce a `?view=`-pinned gate (reorder is an explicit user action on a specific view, always persisted). Cite this invariant; do not converge with the documents `board_position` writer.
- **Invariant 12 + Deliberate exceptions (lines 68-69, `pending_ops` is transient gate state for the irreversible-op confirm gate; bypasses `txWithEvents` by design).** Item B's reaper MUST NOT delete a row a live confirm-card still references. The whole safety case rests on the predicate excluding live rows. The reaper continues the existing exception (plain `db`, NO `emitEvent`) — it is internal hygiene, not a document mutation. Do not add events to it.

---

## Threat model (Item B — pending_ops reaper)

Item A has no threat surface (UI swap via an existing authed PATCH). Item B touches a security-adjacent table (`pending_ops` backs the irreversible-op confirm gate), so the gate fires here per harnessed-development 1a.

**Assets:**
- A *live* pending confirmation (`status='pending'`, `expiresAt > now`) — the row a human is about to click "Yes" on. Deleting it breaks an in-flight destructive-op confirmation (availability of the gate).
- A *confirmed* row (`status='confirmed'`) — recorded params about to be / being executed verbatim (M6 injection-proofing). Deleting it mid-flight could break replay.
- The audit trail on terminal rows (`executedAt`, `executedBy` on `executed` rows) — has forensic value.

**Attacks / failure modes:**
1. **Over-eager reap deletes a live `pending` row within its 5-min TTL** → the confirm-card's "Yes" finds no row → the user's destructive op silently fails or must be re-proposed. (Self-inflicted availability bug, not attacker-driven — but it would defeat the gate.)
2. **Reap deletes a `confirmed` row before/while the handler replays its params** → injection-proofing relies on matching the recorded params; deleting the record breaks the confirm-and-replay flow.
3. **Reap races a concurrent status flip** (a `pending` row being confirmed at the same instant the reaper evaluates it).
4. **Reaper failure crashes the server** (a sweep error taking down boot).
5. **Reaper deletes audit rows too aggressively**, destroying the `executed` forensic trail customers/ops may need.

**Mitigations:**
- **M1 (attacks 1+2+3):** the predicate reaps ONLY: (a) `status IN ('executed','rejected','expired')` AND `createdAt < now − RETENTION`; OR (b) `status='pending'` AND `expiresAt < now − RETENTION`. It NEVER matches `status='confirmed'`, and never a `pending` row whose `expiresAt` is recent. With `RETENTION = 7 days` (≫ the 5-min TTL), a row must be terminal/abandoned for a full week before it qualifies — there is no window in which a live row is reapable. A confirmed-then-executed row only becomes `executed` (terminal) so it is reapable only via branch (a), a week later. Branch (b) handles `pending` rows that were abandoned (never confirmed, never `confirmPendingOp`'d to flip to `expired`) — still only a week after they could no longer possibly be confirmed.
- **M1-race (attack 3):** a single `DELETE ... WHERE <predicate>` is atomic per-row in SQLite; a `pending` row being concurrently confirmed flips to `confirmed` (excluded from the predicate) — the DELETE's `WHERE` re-evaluates at execution, so a row that became `confirmed` is not deleted. No SELECT-then-DELETE TOCTOU.
- **M2 (attack 4):** the sweep is fire-and-log (`.catch(console.error)`), exactly like `sweepOrphanedFolioApiTokens` — a failure logs and never throws into boot. The interval is `NODE_ENV !== 'test'`-guarded to avoid timer leaks in tests.
- **M3 (attack 5):** RETENTION defaults to 7 days (env-overridable via `FOLIO_PENDING_OPS_RETENTION_MS`), preserving a week of audit history before reaping. This is hygiene, not immediate cleanup.

**Deferrals:** none. The predicate is fully closed; no residual.

---

## Acceptance flows (Item A — view reorder; user-facing)

Item B is a background sweep (not user-facing) → no acceptance matrix; covered by the Task-4 integration test. Item A is a user-facing menu action → matrix below. Driven at shake-out through the real browser.

| # | Flow | Steps | Edges (empty / denied / wrong-order / concurrent / boundary / mid-flow-fail) |
|---|------|-------|------------------------------------------------------------------------------|
| A1 | Move a view down | Open a table with ≥2 views in the rail → open a non-last view's `…` menu → click "Move down" | **Empty/boundary:** "Move down" absent/disabled on the LAST view; "Move up" absent/disabled on the FIRST view. **Denied:** a session without `config:write` (member viewing a project they can't edit) sees no reorder actions (same gate as Delete). **Wrong-order/re-entry:** moving down then up returns to the original order. **Concurrent:** two rapid Move-down clicks resolve to a consistent order (optimistic + invalidate). **Boundary:** a table with exactly 1 view shows no reorder actions. **Mid-flow fail:** PATCH 4xx → optimistic order rolls back + toast. |
| A2 | Move a view up | Open a non-first view's `…` menu → "Move up" | (same edge set as A1, mirrored) |
| A3 | Reorder persists across reload | Move a view → reload the page | The new order is reflected by the rail's `order`-sort on fresh load (invariant 16: persisted to the `views` row). |

---

## File Structure

**Item A (frontend):**
- Modify: `apps/web/src/lib/rail-tree.ts` — `buildViewMenu` gains Move-up/Move-down items; `RailTreeHandlers` gains `onMoveView`; `RailTreeView` already carries `order`. Pass each view's neighbor context so the menu knows first/last.
- Modify: `apps/web/src/routes/w.$wslug.tsx` — wire `onMoveView` handler that swaps `order` via `useUpdateView` for the two affected views.
- Test: `apps/web/src/lib/rail-tree.test.ts` — pure logic (menu items present/absent at boundaries; swap targets correct).

**Item B (backend):**
- Modify: `apps/server/src/services/pending-ops.ts` — add `reapStalePendingOps(db)` + `PENDING_OPS_RETENTION_MS`.
- Modify: `apps/server/src/env.ts` — add `FOLIO_PENDING_OPS_RETENTION_MS` (optional, default 7 days).
- Modify: `apps/server/src/index.ts` — boot fire-and-log sweep + `NODE_ENV !== 'test'`-guarded interval.
- Test: `apps/server/src/services/pending-ops.test.ts` (extend existing) — predicate correctness incl. the denial/live-row cases.

---

── REVIEW GATE 1 (Item B — backend reaper, security-adjacent) ──
Tasks 1–3. STOP after Task 3: `cd apps/server && bun test`, `bun x tsc --noEmit`, then `/integration` + `/code-review` (+ `/security-review`, since this touches the confirm-gate table) on the cluster diff before starting Item A.

---

## Task 1: pending_ops reaper — the safe predicate (service + RED test)

**Files:**
- Modify: `apps/server/src/services/pending-ops.ts`
- Modify: `apps/server/src/env.ts`
- Test: `apps/server/src/services/pending-ops.test.ts`

- [ ] **Step 1: Add the retention constant + env knob**

In `apps/server/src/env.ts`, add to the schema (near the other `FOLIO_*` knobs):

```ts
  // pending_ops reaper retention. A terminal (executed/rejected/expired) row, or a
  // long-abandoned pending row past its TTL, is reapable only after this window —
  // generous (7 days) so the executed-op audit trail survives a week before cleanup.
  FOLIO_PENDING_OPS_RETENTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),
```

- [ ] **Step 2: Write the failing test (predicate correctness, incl. live-row safety)**

Append to `apps/server/src/services/pending-ops.test.ts`. Use the same in-memory DB harness the existing tests use (mirror their `beforeEach` setup). Insert rows across every state and assert ONLY the safe ones are reaped:

```ts
import { reapStalePendingOps } from './pending-ops.ts';

describe('reapStalePendingOps', () => {
  const RETENTION = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const old = now - RETENTION - 60_000;   // safely past retention
  const recent = now - 60_000;            // within retention

  async function seed(db, rows) {
    for (const r of rows) {
      await db.insert(pendingOps).values({
        id: r.id,
        conversationId: 'c1',
        callerId: 'u1',
        op: 'update_document',
        params: '{}',
        target: 't',
        status: r.status,
        createdAt: new Date(r.createdAt),
        expiresAt: new Date(r.expiresAt),
        executedAt: null,
        executedBy: null,
      });
    }
  }

  it('reaps terminal rows older than retention, keeps everything live', async () => {
    await seed(db, [
      // REAPABLE — terminal + old
      { id: 'executed-old', status: 'executed', createdAt: old, expiresAt: old },
      { id: 'rejected-old', status: 'rejected', createdAt: old, expiresAt: old },
      { id: 'expired-old',  status: 'expired',  createdAt: old, expiresAt: old },
      // REAPABLE — pending but abandoned (TTL long past)
      { id: 'pending-abandoned', status: 'pending', createdAt: old, expiresAt: old },
      // KEEP — terminal but recent (audit window)
      { id: 'executed-recent', status: 'executed', createdAt: recent, expiresAt: recent },
      // KEEP — live pending within TTL (a confirm-card is showing!)
      { id: 'pending-live', status: 'pending', createdAt: now, expiresAt: now + 5 * 60 * 1000 },
      // KEEP — confirmed (about to execute) — NEVER reaped regardless of age
      { id: 'confirmed-old', status: 'confirmed', createdAt: old, expiresAt: old },
    ]);

    const reaped = await reapStalePendingOps(db, now);
    expect(reaped).toBe(4);

    const remaining = (await db.select().from(pendingOps)).map((r) => r.id).sort();
    expect(remaining).toEqual(['confirmed-old', 'executed-recent', 'pending-live'].sort());
  });

  it('never reaps a confirmed row even when ancient', async () => {
    await seed(db, [{ id: 'confirmed-ancient', status: 'confirmed', createdAt: old, expiresAt: old }]);
    const reaped = await reapStalePendingOps(db, now);
    expect(reaped).toBe(0);
    expect(await db.select().from(pendingOps)).toHaveLength(1);
  });
});
```

(Adjust the `db`/`pendingOps` imports + harness to match the existing test file's setup exactly — read the top of `pending-ops.test.ts` first and reuse its fixtures.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/server && bun test src/services/pending-ops.test.ts`
Expected: FAIL — `reapStalePendingOps is not a function` (not yet exported).

- [ ] **Step 4: Implement `reapStalePendingOps`**

Add to `apps/server/src/services/pending-ops.ts`. Import additions: `lt`, `or`, `inArray` from `drizzle-orm`; `env` from `../env.ts`.

```ts
export const PENDING_OPS_RETENTION_MS = env.FOLIO_PENDING_OPS_RETENTION_MS;

/**
 * Disk-hygiene reaper for `pending_ops`. Rows are status-flipped, never deleted by
 * the gate (schema), so the table only grows. This deletes rows that can no longer
 * be live, after a generous retention window that preserves the executed-op audit
 * trail. SAFETY (invariant 12): NEVER deletes a `confirmed` row (recorded params
 * about to be replayed) and NEVER a `pending` row whose TTL hasn't long expired (a
 * confirm-card may be showing). Atomic single DELETE — no SELECT-then-DELETE TOCTOU.
 *
 * @param at injectable "now" for deterministic tests; defaults to Date.now().
 * @returns number of rows reaped.
 */
export async function reapStalePendingOps(db: DBOrTx, at: number = Date.now()): Promise<number> {
  const cutoff = new Date(at - PENDING_OPS_RETENTION_MS);
  const result = await db
    .delete(pendingOps)
    .where(
      or(
        // (a) terminal rows older than retention — keep the audit trail a week.
        and(
          inArray(pendingOps.status, ['executed', 'rejected', 'expired']),
          lt(pendingOps.createdAt, cutoff),
        ),
        // (b) pending rows whose TTL expired more than retention ago — abandoned,
        //     un-confirmable (getConfirmedPendingOp requires status='confirmed').
        and(eq(pendingOps.status, 'pending'), lt(pendingOps.expiresAt, cutoff)),
      ),
    );
  // bun:sqlite drizzle delete returns { changes } via .run(); the query builder
  // result exposes rowsAffected/changes depending on driver — read the existing
  // delete call sites in this repo for the exact shape and return that count.
  return (result as { changes?: number; rowsAffected?: number }).changes
    ?? (result as { rowsAffected?: number }).rowsAffected
    ?? 0;
}
```

NOTE for implementer (Step 2.5 ground-truth): before finalizing the return-count line, grep an existing `db.delete(...)` call in the repo (e.g. `sweepOrphanedFolioApiTokens` in `lib/folio-api-tool.ts`) to confirm how a row-count is read from a Drizzle/bun:sqlite delete, and use that exact pattern. Do not guess.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/server && bun test src/services/pending-ops.test.ts`
Expected: PASS (both new `describe` cases green).

- [ ] **Step 6: Typecheck**

Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/pending-ops.ts apps/server/src/env.ts apps/server/src/services/pending-ops.test.ts
git commit -m "feat: pending_ops reaper predicate (terminal-old + abandoned-pending, never live)"
```

---

## Task 2: Wire the reaper into boot + interval

**Files:**
- Modify: `apps/server/src/index.ts`
- Test: covered by Task 1 (the predicate) + the boot path is glue (Tier B — mirrors existing sweeps, no bespoke test).

- [ ] **Step 1: Add the boot-time fire-and-log sweep**

In `apps/server/src/index.ts`, import `reapStalePendingOps` from `./services/pending-ops.ts`, then after the `recoverInterruptedConversations` block (~line 44) add:

```ts
// pending_ops disk hygiene: the confirm-gate flips status but never deletes, so the
// table only grows. Reap terminal/abandoned rows past the retention window. Live
// (pending-within-TTL / confirmed) rows are never touched. Fire-and-log like above.
void reapStalePendingOps(db)
  .then((n) => {
    if (n > 0) console.log(`[folio] reaped ${n} stale pending_ops row(s)`);
  })
  .catch((err) => console.error('[folio] pending_ops reap failed', err));
```

- [ ] **Step 2: Add the guarded periodic interval**

After the reconciler `setInterval` block (~line 62), add a sibling interval (reuse the existing reconciler interval knob, OR add a dedicated one — prefer reusing `FOLIO_RECONCILER_INTERVAL_MS` to avoid a new env var, since both are slow hygiene loops; state the choice in the commit):

```ts
// pending_ops reaper interval (slow hygiene loop). Skipped in test mode (timer leaks).
if (env.NODE_ENV !== 'test') {
  setInterval(() => {
    reapStalePendingOps(db).catch((err) =>
      console.error('[folio] pending_ops reaper error', err),
    );
  }, env.FOLIO_RECONCILER_INTERVAL_MS);
}
```

- [ ] **Step 3: Typecheck + full server suite**

Run: `cd apps/server && bun x tsc --noEmit && bun test`
Expected: clean typecheck; full suite green (count = prior 1665 + the Task-1 additions, 0 fails).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat: wire pending_ops reaper into boot sweep + hygiene interval"
```

---

## Task 3: Item-B review-cluster close

- [ ] **Step 1: Run the full server + shared suites from their own dirs**

Run: `cd apps/server && bun test` then `cd packages/shared && bun test`
Expected: server green (1665 + new), shared 70/0.

- [ ] **Step 2: Typecheck server**

Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 3: STOP — hand to human for review gate 1**

Run `/integration` on the cluster diff, then `/code-review` and `/security-review` (this cluster touches the confirm-gate's `pending_ops` table). Do NOT begin Item A until review is clear.

---

── REVIEW GATE 2 (Item A — frontend view reorder) ──
Tasks 4–5. STOP after Task 5: `cd apps/web && npx vitest run`, `bun x tsc --noEmit`, then `/integration` + `/code-review` on the cluster diff.

---

## Task 4: View-reorder menu logic (rail-tree, pure + tested)

**Files:**
- Modify: `apps/web/src/lib/rail-tree.ts`
- Test: `apps/web/src/lib/rail-tree.test.ts`

- [ ] **Step 1: Read the current rail-tree test + types**

Read `apps/web/src/lib/rail-tree.test.ts` and the `RailTreeHandlers` / `RailTreeView` / `buildViewMenu` definitions in `rail-tree.ts` so the new code matches the established shapes exactly.

- [ ] **Step 2: Write the failing test**

Append to `apps/web/src/lib/rail-tree.test.ts`. Build a tree with 3 views (orders 0, 10, 20) on one table and assert the menu items:

```ts
describe('view reorder menu', () => {
  const handlers = makeHandlers({ onMoveView: vi.fn() }); // extend the test's handler factory

  it('omits Move up on the first view and Move down on the last', () => {
    const tree = buildRailTree(threeViewInput(handlers));
    const views = viewNodesOf(tree); // helper: flatten to the 3 view NavItems, order-sorted
    const labels = (n) => (n.menuItems ?? []).map((m) => m.label);

    expect(labels(views[0])).not.toContain('Move up');
    expect(labels(views[0])).toContain('Move down');
    expect(labels(views[1])).toEqual(expect.arrayContaining(['Move up', 'Move down']));
    expect(labels(views[2])).toContain('Move up');
    expect(labels(views[2])).not.toContain('Move down');
  });

  it('Move down calls onMoveView with this view and its next neighbor', () => {
    const onMoveView = vi.fn();
    const tree = buildRailTree(threeViewInput(makeHandlers({ onMoveView })));
    const views = viewNodesOf(tree);
    const moveDown = (views[0].menuItems ?? []).find((m) => m.label === 'Move down');
    moveDown!.onSelect();
    // swap view[0] (order 0) with view[1] (order 10)
    expect(onMoveView).toHaveBeenCalledWith(
      'proj', 'tbl',
      { id: views[0].viewId, order: 0 },
      { id: views[1].viewId, order: 10 },
    );
  });

  it('omits all reorder items when the table has a single view', () => {
    const tree = buildRailTree(oneViewInput(handlers));
    const only = viewNodesOf(tree)[0];
    const labels = (only.menuItems ?? []).map((m) => m.label);
    expect(labels).not.toContain('Move up');
    expect(labels).not.toContain('Move down');
  });
});
```

(Match the existing test's input-builder + handler-factory style. If `viewNodesOf`/`threeViewInput` helpers don't exist, write small local ones — keep them in the test file. The exact `onMoveView` signature is whatever Step 3 defines; keep test + impl in lockstep.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/rail-tree.test.ts`
Expected: FAIL — `onMoveView` not on handlers / Move items absent.

- [ ] **Step 4: Implement the menu logic**

In `apps/web/src/lib/rail-tree.ts`:

1. Add to `RailTreeHandlers`:
```ts
  /** Swap two adjacent views' `order` (reorder in the rail). `a`/`b` are the two
   *  views to swap, each {id, order}; the handler persists both via useUpdateView. */
  onMoveView?: (
    pslug: string,
    tslug: string,
    a: { id: string; order: number },
    b: { id: string; order: number },
  ) => void;
```

2. `buildViewMenu` needs neighbor context. The cleanest place is in the `sortedViews.map(...)` in `buildRailTree` where index + array are available — pass them through. Change `buildViewMenu`'s signature to accept the sorted-view neighbors:

```ts
// in buildRailTree, inside sortedViews.map((view, idx, arr) => ({ ... }))
menuItems: buildViewMenu(handlers, project.slug, table.slug, view, arr[idx - 1], arr[idx + 1]),
```

3. Rewrite `buildViewMenu`:

```ts
function buildViewMenu(
  h: RailTreeHandlers,
  pslug: string,
  tslug: string,
  view: RailTreeView,
  prev: RailTreeView | undefined,
  next: RailTreeView | undefined,
): RowMenuItem[] | undefined {
  const items: RowMenuItem[] = [];
  if (h.onMoveView && prev) {
    items.push({
      label: 'Move up',
      onSelect: () =>
        h.onMoveView!(pslug, tslug, { id: view.id, order: view.order }, { id: prev.id, order: prev.order }),
    });
  }
  if (h.onMoveView && next) {
    items.push({
      label: 'Move down',
      onSelect: () =>
        h.onMoveView!(pslug, tslug, { id: view.id, order: view.order }, { id: next.id, order: next.order }),
    });
  }
  if (h.onDeleteView) {
    items.push({ label: 'Delete', destructive: true, onSelect: () => h.onDeleteView!(pslug, tslug, view.id, view.name) });
  }
  return items.length > 0 ? items : undefined;
}
```

(NOTE: `arr[idx-1]`/`arr[idx+1]` are computed AFTER the `sortedViews` sort — so prev/next reflect the displayed order, which is exactly first/last-correct. `RailTreeView` must expose `order`; it already does — confirm at Step 1.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/rail-tree.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/rail-tree.ts apps/web/src/lib/rail-tree.test.ts
git commit -m "feat: view-reorder Move up/down menu items in rail-tree (pure logic)"
```

---

## Task 5: Wire onMoveView in the route (swap order via useUpdateView)

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx`
- Test: seam — covered by Task 4 (pure logic) + shake-out browser drive (Tier B wiring; the swap-via-two-PATCHes is glue over the already-tested `useUpdateView`). Add ONE seam assertion if a lightweight handler test fits the route's existing test setup; otherwise rely on shake-out (state which in the report).

- [ ] **Step 1: Find where the other view handlers are wired**

In `apps/web/src/routes/w.$wslug.tsx`, locate where `onDeleteView` / `onRenameView` are passed into the rail-tree handlers (grep `onDeleteView` — ~line 254) and where `useUpdateView` is available (it's used elsewhere; confirm the hook is in scope for the workspace route, or instantiate it).

- [ ] **Step 2: Implement the handler**

**PLAN CORRECTION (Step 2.5 ground-truth, 2026-06-08):** the original plan said "swap via `useUpdateView`". That is WRONG for this route. `w.$wslug.tsx` deliberately does NOT use the per-project `useUpdateView` hook for rail mutations (see the comment at lines 109-114): those hooks bind `pslug` at render time, but the rail callbacks receive `pslug` at call time. The established pattern — used by `onRenameTable` (line 241) and `onRenameView` (line 248) — is **raw `client.patch` + `qc.invalidateQueries`**. The reorder handler MUST mirror `onRenameView`, doing two PATCHes (one per swapped view) then one invalidate. Do NOT call `useUpdateView` (hook-rules violation) and do NOT invent an endpoint.

Add `onMoveView` to the `handlers` useMemo object (next to `onDeleteView`, ~line 254), mirroring `onRenameView` exactly:

```ts
onMoveView: async (pslug, _tslug, a, b) => {
  try {
    // swap orders: a takes b's order, b takes a's. Two PATCHes to the views
    // endpoint, then one invalidate — same raw-client pattern as onRenameView.
    await client.patch(`/api/v1/w/${wslug}/p/${pslug}/views/${a.id}`, { order: b.order });
    await client.patch(`/api/v1/w/${wslug}/p/${pslug}/views/${b.id}`, { order: a.order });
    await qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
  } catch (err) {
    toast.error(formatApiError(err));
  }
},
```

The views PATCH route accepts `{ order: number }` (confirmed: `apps/server/src/routes/views.ts:99-123`, `baseSchema.partial()` with `order: z.number().int().optional()`). `viewsKeys`, `client`, `qc`, `toast`, `formatApiError` are all already imported + in scope in this file (used by the sibling handlers).

- [ ] **Step 3: Typecheck + full web suite**

Run: `cd apps/web && bun x tsc --noEmit && npx vitest run`
Expected: clean typecheck; web suite green (887 + Task-4 additions, 0 fails; known flake `list-view-create.test.tsx` — rerun once if it trips).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/w.$wslug.tsx
git commit -m "feat: wire view reorder — swap order via useUpdateView"
```

---

## Task 6: Spec-close — shake-out + finish

- [ ] **Step 1: Full gates**

Run from each dir: `cd apps/server && bun test && bun x tsc --noEmit`; `cd packages/shared && bun test`; `cd apps/web && npx vitest run && bun x tsc --noEmit`; root `bun run check:invariants`.
Expected: server (1665+), web (887+), shared 70 — all 0 fails; invariants 17/0-err.

- [ ] **Step 2: Drive the Acceptance flows matrix (Item A) through the real browser**

Per shake-out: A1 (move down, last-view disabled), A2 (move up, first-view disabled), A3 (persist across reload), plus the denied-actor edge (a `config:write`-less session shows no reorder items). Emit the pass/fail manifest.

- [ ] **Step 3: `/shakeout`** — spec-complete gate (re-runs integration, E2E, dispatches reviewer agents incl. invariant-auditor against the full branch diff).

- [ ] **Step 4: `/finish`** — `superpowers:finishing-a-development-branch`.

---

## Self-review (run by plan author)

**Spec coverage:** Item A (reorder UI) → Tasks 4+5; Item B (reaper) → Tasks 1+2. ✓ both covered.
**Placeholder scan:** the two `IMPLEMENTER (Step 2.5 ground-truth)` notes are deliberate — they point the implementer at a known repo pattern to confirm (delete-row-count shape; per-project useUpdateView wiring) rather than guessing. Not placeholders — explicit ground-truth obligations. All code steps carry real code.
**Type consistency:** `onMoveView(pslug, tslug, a:{id,order}, b:{id,order})` used identically in Task 4 (def + test) and Task 5 (wire). `reapStalePendingOps(db, at?)` consistent across Task 1 (def + test) and Task 2 (boot). `ViewPatch.order` confirmed against source. ✓
