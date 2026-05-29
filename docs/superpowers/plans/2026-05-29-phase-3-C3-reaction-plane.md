# Phase 3 Sub-phase C.3 — Reaction Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repo additionally requires the `netdust-core:ntdst-execute-with-tests` wrapper (CLAUDE.md rule 1) — append its addendum to every implementer dispatch.

**Goal:** Build the durable Reaction Plane (an at-least-once event dispatcher) and make the trigger-matcher its first reactor, so assigning/@-mentioning an agent durably creates an `agent_run` that the runner poller then executes.

**Architecture:** Two delivery planes over the existing append-only `events` table. The **Observation Plane** (existing in-memory `eventBus`, lossy, SSE) is unchanged except for one additive `workspaceId: null` system-event broadcast rule. The new **Reaction Plane** (`lib/event-dispatcher.ts`) polls `events` by `seq`, fans out to reactors via per-reactor cursors, advances each cursor only on success (at-least-once; idempotent reactors absorb replays). The matcher reads trigger **documents** and honors them — document-as-trigger, now reached via the durable log instead of hand-wired emit sites.

**Tech Stack:** Bun, Hono, Drizzle, SQLite (`bun:sqlite`), Zod, `bun test`.

**Design spec:** `docs/superpowers/specs/2026-05-29-reaction-plane-design.md` (approved). **Decision brief:** `docs/superpowers/specs/2026-05-29-event-delivery-decision.md`. This plan SUPERSEDES the Option-A C.3 section in `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` (lines ~4257–4401).

---

## Pre-flight invariants (every task)

- `cd apps/server` for all server commands. **NEVER** run `bun test` from repo root (mixes Vitest into Bun's runner → false fails).
- Per-file test: `bun test src/lib/<file>.test.ts`. Full server suite: `bun test`. Typecheck: `bun x tsc --noEmit`. Lint touched files: `bunx biome check src/lib/<file>.ts`.
- **Baseline at C.3 start: server 851 pass / 1 skip / 0 fail.** Confirm before starting C-10a.
- **Sibling-site audit (5 lockstep classes)** before each task: closed-enum literals (event kinds from `KNOWN_EVENT_KINDS` + `EventKind` union, kept in sync — there is a test asserting they match); event scope (`workspaceId`/`projectId` null semantics); no FE-union widening (C.3 is server + shared-event-kinds only). Reactor `error_reason` writes (none here — the matcher reuses C.1/C.8 paths).
- **Timing-sensitive tests run ≥3× before GREEN** (per the C.2 testing-workflow lesson — the same-ms flake class). Applies to the dispatcher (fake timers, edge-trigger) and the matcher (idempotency/race).
- **Ground-truth before coding** (per the C.2 lesson): the call sites below were verified against live source on 2026-05-29; re-verify the exact signatures in your task's files before writing code samples — the plan's samples are faithful but the source is truth.

**Verified call surface (live, 2026-05-29):**
- `lib/event-bus.ts` — `class EventBus { subscribe(workspaceId, filter, handler): () => void; publish(e: BusEvent): void; __clear() }`, exported as `eventBus`. `publish` loops subscribers and `continue`s when `sub.workspaceId !== e.workspaceId`. `BusEvent = { id?, workspaceId, projectId?, documentId?, kind, actor?, payload?, createdAt? }`.
- `packages/shared/src/events.ts` — `EventKind` union + `KNOWN_EVENT_KINDS: readonly EventKind[]` (kept in sync; `events.test.ts` asserts membership).
- `lib/events.ts` — `emitEvent(tx, { workspaceId, projectId?, documentId?, kind, actor, payload? })`; `txWithEvents(db, fn)`. `emitEvent` inserts the durable row (monotonic `seq`) + queues the post-commit bus publish.
- `db/schema.ts` — `events` table has `seq: integer notNull` + `events_workspace_seq_idx` on `(workspaceId, seq)`; `events_seq_idx` UNIQUE on `seq`.
- `routes/events.ts:~115` — the SSE replay: `db.query.events.findMany({ where: and(eq(workspaceId,...), gt(events.seq, cursorSeq)), orderBy: asc(seq) })`. **The dispatcher mirrors this query, minus the workspace filter (cross-workspace).**
- `services/agent-runs.ts` — `createRun(args: CreateRunArgs): Promise<{document}>` where `CreateRunArgs = { workspace, project, runsTable, agent, actor: User, input: CreateRunInput }`; `getActiveRun(args, tx?)`; `nextChainId({firedBy})`; `ensureRunsTable(...)` (C-6); `claimNextPlanningRun(db)`, `recoverOrphanRuns(db)`, `countPendingPlanning(db)` (C-3); `runAgent({runId})`, `runAgentResume({runId})` (C-8/C-9).
- `lib/builtin-triggers.ts` — `BUILTIN_TRIGGER_DEFS` with frontmatter `{ on_event, event_filter?, agent?, internal_action?, enabled, builtin }`.
- `src/env.ts` — `envSchema = z.object({...})`; pattern: `FOLIO_X: z.coerce.number().int().min(...).default(...)`.
- `src/index.ts` — boot wiring pattern: `if (env.NODE_ENV !== 'test') { setInterval(() => fn(db).catch(...), env.FOLIO_X) }` after the reconciler block.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/shared/src/events.ts` | add `reactor.halted` + `reactor.recovered` (+ later `agent.chain.suppressed`) to `EventKind` + `KNOWN_EVENT_KINDS` | C-10a, C-11 |
| `apps/server/src/lib/event-bus.ts` | add the `workspaceId: null` → all-subscribers delivery rule | C-10a |
| `apps/server/src/db/schema.ts` + migration | `reactor_cursors` table | C-10b |
| `apps/server/src/env.ts` | `FOLIO_DISPATCHER_INTERVAL_MS`, `FOLIO_DISPATCHER_BATCH`, `FOLIO_POLLER_*`, `FOLIO_WORKER_STALE_MS`, `FOLIO_AGENT_CHAINS_ENABLED` | C-10b, C-11, C-12 |
| `apps/server/src/lib/event-dispatcher.ts` | the durable dispatch loop + `Reactor` interface + registry + cursor + edge-triggered halt emission | C-10b |
| `apps/server/src/lib/trigger-matcher.ts` | the first reactor — reads trigger documents, allow-list + autonomy gate + idempotency + createRun | C-11 |
| `apps/server/src/lib/poller.ts` | runner poller — claims `planning` runs → `runAgent`/`runAgentResume` | C-12 |
| `apps/server/src/index.ts` | boot wiring for dispatcher + poller | C-10b, C-12 |

---

## Task C-10a: system-event delivery rule (`event-bus.ts` + shared event kinds)

The ONE Observation-Plane change, isolated. Adds `workspaceId: null` → all-subscribers delivery + the two `reactor.*` event kinds. No dispatcher, no reactor.

**Mitigations:** 53 (system-event tenant isolation — delivery primitive).

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/src/events.test.ts`
- Modify: `apps/server/src/lib/event-bus.ts`
- Test: `apps/server/src/lib/event-bus.test.ts`

- [ ] **Step 1: Add the two event kinds to shared (failing test first).**

In `packages/shared/src/events.test.ts`, add:
```ts
test('includes reactor health system events', () => {
  expect(KNOWN_EVENT_KINDS).toContain('reactor.halted');
  expect(KNOWN_EVENT_KINDS).toContain('reactor.recovered');
});
```
Run: `cd packages/shared && bun test src/events.test.ts`
Expected: FAIL (`reactor.halted` not in the list).

- [ ] **Step 2: Add the kinds to the union + the array.**

In `packages/shared/src/events.ts`, append to the `EventKind` union (after `'workspace.provider.recovered'`):
```ts
  | 'workspace.provider.recovered'
  | 'reactor.halted'
  | 'reactor.recovered';
```
And to `KNOWN_EVENT_KINDS` (after `'workspace.provider.recovered',`):
```ts
  'workspace.provider.recovered',
  // Phase 3 C.3 — Reaction Plane system-level events (workspaceId: null):
  'reactor.halted',
  'reactor.recovered',
```
Run: `cd packages/shared && bun test src/events.test.ts`
Expected: PASS. Also `cd packages/shared && bun test` → all green (was 51).

- [ ] **Step 3: Write the failing bus test for the system-event rule.**

In `apps/server/src/lib/event-bus.test.ts`, add:
```ts
test('system event (workspaceId: null) is delivered to a subscriber whose workspace does not match', () => {
  const seen: string[] = [];
  const unsub = eventBus.subscribe('ws-A', undefined, (e) => seen.push(e.kind));
  eventBus.publish({ workspaceId: null as unknown as string, kind: 'reactor.halted', payload: { reactor_id: 'x', stuck_at_seq: 1 } });
  unsub();
  expect(seen).toEqual(['reactor.halted']);
});

test('a normal workspace-scoped event still does NOT cross workspaces', () => {
  const seen: string[] = [];
  const unsub = eventBus.subscribe('ws-A', undefined, (e) => seen.push(e.kind));
  eventBus.publish({ workspaceId: 'ws-B', kind: 'document.created' });
  unsub();
  expect(seen).toEqual([]); // ws-A subscriber must not see ws-B's event
});
```
(If `event-bus.test.ts` doesn't exist, create it; import `{ eventBus }` from `./event-bus.ts` and call `eventBus.__clear()` in `afterEach` to isolate tests — the bus is a module-global singleton.)
Run: `cd apps/server && bun test src/lib/event-bus.test.ts`
Expected: first test FAILS (system event dropped by the `sub.workspaceId !== e.workspaceId` check); second PASSES (existing behavior).

- [ ] **Step 4: Add the system-event delivery rule to `publish`.**

In `apps/server/src/lib/event-bus.ts`, change the `BusEvent.workspaceId` type to allow `null`, and add the broadcast case at the top of the per-sub loop:
```ts
export interface BusEvent {
  id?: string;
  workspaceId: string | null;   // null = system-level event (delivered to ALL subscribers)
  projectId?: string | null;
  // ... rest unchanged
}
```
Inside `publish`, replace the opening guard:
```ts
  publish(e: BusEvent): void {
    for (const sub of this.subs) {
      // System-level events (workspaceId === null) transcend workspace scope —
      // delivered to every subscriber. Generalizes the BUG-021 projectId-null
      // precedent by one notch. Used for reactor.halted/recovered (Reaction
      // Plane reporting its own health onto the Observation Plane). MUST be
      // tenant-data-free by construction (mitigation 53).
      if (e.workspaceId !== null && sub.workspaceId !== e.workspaceId) continue;
      // ... the rest of the filters (kinds / projectId / parentId / runId) unchanged ...
```
Note: the kind/projectId/parentId/runId filters below stay as-is — a system event with no `projectId`/`parent_id`/`run_id` passes them; a subscriber that filtered `kinds` to a set not including `reactor.*` correctly won't see it (that's fine — they opted out of those kinds).
Run: `cd apps/server && bun test src/lib/event-bus.test.ts`
Expected: both PASS.

- [ ] **Step 5: Full suites + typecheck + lint + commit.**

Run: `cd apps/server && bun test` (expect 851 → 853, +2 bus tests) ; `cd packages/shared && bun test` (51 → 52) ; `cd apps/server && bun x tsc --noEmit` (clean — the `workspaceId: string | null` widening may surface call sites that assumed non-null; fix any by allowing null only where a system event is emitted, else keep passing a string) ; `bunx biome check src/lib/event-bus.ts`.
Invoke `Skill("netdust-core:testing-workflow")`.
```bash
git add packages/shared/src/events.ts packages/shared/src/events.test.ts apps/server/src/lib/event-bus.ts apps/server/src/lib/event-bus.test.ts
git commit -m "phase-3: C-10a system-event delivery rule — workspaceId:null broadcast + reactor.* kinds"
```
**DONE_WITH_CONCERNS** if the `workspaceId: string | null` widening forces more than a handful of call-site changes — report the surface before proceeding (it may need a narrower approach, e.g. a separate `publishSystem` method instead of widening the type).

---

## Task C-10b: the durable dispatcher (`event-dispatcher.ts` + `reactor_cursors`)

**Mitigations:** 49 (reactor errors halt the cursor, never roll back the originating write; surface the halt). Edge-triggered halt observability (§3 contract + §4b).

**Files:**
- Modify: `apps/server/src/db/schema.ts` (add `reactorCursors`)
- Create: migration `apps/server/src/db/migrations/00NN_reactor_cursors.sql` + update `meta/_journal.json` (per `[[drizzle-migration-journal]]`)
- Modify: `apps/server/src/env.ts` (add `FOLIO_DISPATCHER_INTERVAL_MS`, `FOLIO_DISPATCHER_BATCH`)
- Create: `apps/server/src/lib/event-dispatcher.ts`
- Test: `apps/server/src/lib/event-dispatcher.test.ts`
- Modify: `apps/server/src/index.ts` (boot wiring)

- [ ] **Step 1: Add the `reactor_cursors` table to the schema.**

In `apps/server/src/db/schema.ts`:
```ts
export const reactorCursors = sqliteTable('reactor_cursors', {
  reactorId: text('reactor_id').primaryKey(),
  lastSeq: integer('last_seq').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
});
export type ReactorCursor = typeof reactorCursors.$inferSelect;
```

- [ ] **Step 2: Generate + journal the migration.**

Run: `cd apps/server && bun run db:generate` (creates the `.sql`). Open the generated file, confirm it creates `reactor_cursors`. **Verify `meta/_journal.json` gained the new entry** (the pre-commit hook checks this; `migrate()` silently skips un-journaled files). If `db:generate` didn't update the journal, add the entry manually.
Run: `cd apps/server && bun test src/db/` (migration tests still green).

- [ ] **Step 3: Add the dispatcher env vars.**

In `apps/server/src/env.ts`, inside `envSchema`:
```ts
  FOLIO_DISPATCHER_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  FOLIO_DISPATCHER_BATCH: z.coerce.number().int().min(1).default(100),
```

- [ ] **Step 4: Write failing tests for the dispatcher core (fake reactor, manual tick).**

Create `apps/server/src/lib/event-dispatcher.test.ts`. The dispatcher must be testable by driving one tick manually (export an internal `runOnce(db, reactors)` the timer calls, so tests don't need fake timers for the core logic). Inject reactors (do NOT use the module-global `REACTORS` in tests — per `[[mock-module-leaks-across-bun-tests]]`).

```ts
import { test, expect, afterEach } from 'bun:test';
import { runDispatcherOnce, type Reactor } from './event-dispatcher.ts';
import { eventBus } from './event-bus.ts';
// + test db setup helper (mirror agent-runs.test.ts / events.test.ts)

afterEach(() => eventBus.__clear());

test('seeds cursor at MAX(seq) on first registration and does not replay history', async () => {
  // seed 3 events into a fresh test db (via emitEvent or direct insert), seq 1..3
  const seen: number[] = [];
  const r: Reactor = { id: 'test-r', kinds: ['document.created'], react: async (e) => { seen.push(e.seq!); } };
  await runDispatcherOnce(db, [r]);          // first run: cursor absent → seed at MAX(seq)=3, no replay
  expect(seen).toEqual([]);                    // started "from now" — saw nothing historical
  // emit a 4th event, run again → reactor sees only seq 4
  // ... insert event seq 4 ...
  await runDispatcherOnce(db, [r]);
  expect(seen).toEqual([4]);
});

test('advances cursor only on success (at-least-once); a throwing react halts and retries next tick', async () => {
  // seed cursor at 0 for 'test-r' (so it processes from the start), insert events seq 1,2,3
  let attempts = 0;
  const r: Reactor = { id: 'test-r', kinds: ['document.created'], react: async (e) => {
    if (e.seq === 2) { attempts++; throw new Error('poison'); }
  }};
  await runDispatcherOnce(db, [r]);   // processes 1 (ok, cursor→1), 2 throws → halt, cursor stays 1
  // assert cursor row lastSeq === 1
  await runDispatcherOnce(db, [r]);   // retries from seq 2 → throws again
  expect(attempts).toBe(2);            // event 2 re-attempted (at-least-once retry), never skipped to 3
});

test('kind-filter advances the cursor past non-matching events (no infinite lag)', async () => {
  // insert event kind 'status.created' seq 1, 'document.created' seq 2; reactor.kinds = ['document.created']
  const seen: string[] = [];
  const r: Reactor = { id: 'test-r', kinds: ['document.created'], react: async (e) => { seen.push(e.kind); }};
  // seed cursor at 0
  await runDispatcherOnce(db, [r]);
  expect(seen).toEqual(['document.created']);  // skipped status.created
  // assert cursor row lastSeq === 2 (advanced PAST the skipped event)
});
```
Run: `cd apps/server && bun test src/lib/event-dispatcher.test.ts`
Expected: FAIL (module doesn't exist).

- [ ] **Step 5: Implement the dispatcher core.**

Create `apps/server/src/lib/event-dispatcher.ts`. Mirror the SSE replay query (`routes/events.ts`) minus the workspace filter:
```ts
import { and, gt, asc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { events, reactorCursors } from '../db/schema.ts';
import type { BusEvent } from './event-bus.ts';
import { emitEvent } from './events.ts';
import { env } from '../env.ts';

export interface Reactor {
  id: string;
  kinds: readonly string[];
  react(event: BusEvent & { seq: number }): Promise<void>;
}

// In-memory per-reactor health (healthy | halted). Reset on restart; re-derived
// from the next tick's outcome. Cursor-lag is the durable truth — see spec §4b.
const halted = new Set<string>();

async function loadOrSeedCursor(db: DB, reactorId: string): Promise<number> {
  const row = await db.query.reactorCursors.findFirst({ where: eq(reactorCursors.reactorId, reactorId) });
  if (row) return row.lastSeq;
  const [{ max } = { max: 0 }] = await db.select({ max: sql<number>`COALESCE(MAX(${events.seq}), 0)` }).from(events);
  const seed = max ?? 0;
  await db.insert(reactorCursors).values({ reactorId, lastSeq: seed, updatedAt: new Date() });
  return seed;
}

async function persistCursor(db: DB, reactorId: string, seq: number): Promise<void> {
  await db.update(reactorCursors).set({ lastSeq: seq, updatedAt: new Date() }).where(eq(reactorCursors.reactorId, reactorId));
}

/** One dispatch tick across all reactors. Exported for tests. */
export async function runDispatcherOnce(db: DB, reactors: readonly Reactor[]): Promise<void> {
  for (const r of reactors) {
    let cursor = await loadOrSeedCursor(db, r.id);
    const rows = await db.query.events.findMany({
      where: gt(events.seq, cursor),
      orderBy: asc(events.seq),
      limit: env.FOLIO_DISPATCHER_BATCH,
    });
    for (const row of rows) {
      const ev = { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, documentId: row.documentId, kind: row.kind, actor: row.actor ?? undefined, payload: row.payload, createdAt: row.createdAt.getTime(), seq: row.seq } as BusEvent & { seq: number };
      if (!r.kinds.includes(row.kind)) {
        cursor = row.seq;
        await persistCursor(db, r.id, cursor);   // seen-and-skipped; advance past it
        continue;
      }
      try {
        await r.react(ev);
        cursor = row.seq;
        await persistCursor(db, r.id, cursor);     // cursor-after: advance only on success
        if (halted.has(r.id)) {
          halted.delete(r.id);
          await emitReactorHealth(db, r.id, 'reactor.recovered', { reactor_id: r.id });
        }
      } catch (err) {
        console.error(`[dispatcher] reactor ${r.id} halted at seq ${row.seq}`, err);
        if (!halted.has(r.id)) {
          halted.add(r.id);
          await emitReactorHealth(db, r.id, 'reactor.halted', {
            reactor_id: r.id, stuck_at_seq: row.seq, error_summary: err instanceof Error ? err.message : 'unknown',
          });
        }
        break;   // halt this reactor's drain this tick; cursor unchanged → retry next tick
      }
    }
  }
}
```
Note `emitReactorHealth` is defined in Step 6 (it needs the system-event emit). For Step 5's tests (which don't assert health events), a temporary `async function emitReactorHealth() {}` no-op stub lets the core tests pass; Step 6 replaces it. Run the core tests:
Run: `cd apps/server && bun test src/lib/event-dispatcher.test.ts` (the 3 core tests) — **run 3× for determinism.**
Expected: 3 PASS each run.

- [ ] **Step 6: Implement `emitReactorHealth` (system-level emit) + failing edge-trigger test.**

Add the edge-trigger test to `event-dispatcher.test.ts`:
```ts
test('reactor.halted fires exactly ONCE across repeated retry ticks; recovered fires once on recovery', async () => {
  const seenSystemEvents: string[] = [];
  const unsub = eventBus.subscribe('any-ws', undefined, (e) => {
    if (e.kind === 'reactor.halted' || e.kind === 'reactor.recovered') seenSystemEvents.push(e.kind);
  });
  // seed cursor 0; events seq 1 (ok), seq 2 (poison until a flag flips)
  let poison = true;
  const r: Reactor = { id: 'edge-r', kinds: ['document.created'], react: async (e) => {
    if (e.seq === 2 && poison) throw new Error('boom');
  }};
  await runDispatcherOnce(db, [r]);   // halts at 2 → ONE reactor.halted
  await runDispatcherOnce(db, [r]);   // still poison → NO second halted (edge-triggered)
  poison = false;
  await runDispatcherOnce(db, [r]);   // 2 succeeds → ONE reactor.recovered
  unsub();
  expect(seenSystemEvents).toEqual(['reactor.halted', 'reactor.recovered']);
});
```
Replace the no-op stub with the real emit (system-level → `workspaceId: null`, wrapped in `txWithEvents` so it's durable + published):
```ts
import { txWithEvents } from './events.ts';
async function emitReactorHealth(db: DB, reactorId: string, kind: 'reactor.halted' | 'reactor.recovered', payload: Record<string, unknown>): Promise<void> {
  await txWithEvents(db, async (tx) => {
    await emitEvent(tx, { workspaceId: null as unknown as string, kind, actor: 'system:dispatcher', payload });
  });
}
```
(Confirm `emitEvent`/the `events` table accept a null `workspaceId`. The `events.workspace_id` column has a FK to `workspaces.id` and is `.notNull()` — **a system event cannot be inserted as a durable row with `workspaceId: null`.** Resolution: system events are **published to the bus only, NOT inserted into the `events` table** — they are live operational signals, not durable workspace history (consistent with spec §4b: the durable truth is cursor-lag, not a persisted health row). So `emitReactorHealth` calls `eventBus.publish({ workspaceId: null, kind, payload, createdAt: ... })` **directly**, bypassing `emitEvent`. Update the code sample accordingly and DELETE the `txWithEvents` import if unused.)

Corrected `emitReactorHealth`:
```ts
import { eventBus } from './event-bus.ts';
function emitReactorHealth(reactorId: string, kind: 'reactor.halted' | 'reactor.recovered', payload: Record<string, unknown>): void {
  // System events are live signals, not durable rows: events.workspace_id is a
  // NOT NULL FK, so a workspaceId:null event can't persist. Publish to the bus
  // only. The durable truth is cursor-lag (spec §4b). createdAt set explicitly.
  eventBus.publish({ workspaceId: null, kind, actor: 'system:dispatcher', payload, createdAt: Date.now() });
}
```
(Adjust the call sites in Step 5 to the sync `emitReactorHealth(r.id, ...)` — no `db`, no `await`.)
Run: `cd apps/server && bun test src/lib/event-dispatcher.test.ts` — **3×.**
Expected: 4 PASS each run.

- [ ] **Step 7: Boot wiring + the interval loop.**

Add the public `startEventDispatcher(db)` to `event-dispatcher.ts`:
```ts
import { REACTORS } from './reactors.ts';   // created in C-11; for C-10b use an empty array placeholder
export function startEventDispatcher(db: DB): () => void {
  const handle = setInterval(() => { void runDispatcherOnce(db, REACTORS).catch((err) => console.error('[dispatcher] tick error', err)); }, env.FOLIO_DISPATCHER_INTERVAL_MS);
  return () => clearInterval(handle);
}
```
For C-10b, `REACTORS` does not exist yet (C-11 creates `lib/reactors.ts`). Use a local `const REACTORS: readonly Reactor[] = [];` in `event-dispatcher.ts` for now; C-11 moves it to `reactors.ts` and registers the matcher. (Document this inline so C-11 knows to relocate it.)
In `apps/server/src/index.ts`, after the reconciler block:
```ts
import { startEventDispatcher } from './lib/event-dispatcher.ts';
if (env.NODE_ENV !== 'test') {
  console.log(`[folio] event dispatcher enabled (interval: ${env.FOLIO_DISPATCHER_INTERVAL_MS}ms)`);
  startEventDispatcher(db);
}
```

- [ ] **Step 8: Full suite + typecheck + lint + commit.**

Run: `cd apps/server && bun test` (expect 853 → ~860) ; `bun x tsc --noEmit` ; `bunx biome check src/lib/event-dispatcher.ts`.
Invoke `Skill("netdust-core:testing-workflow")`.
```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations apps/server/src/env.ts apps/server/src/lib/event-dispatcher.ts apps/server/src/lib/event-dispatcher.test.ts apps/server/src/index.ts
git commit -m "phase-3: C-10b durable event dispatcher — per-reactor cursor, at-least-once, edge-triggered halt"
```

---

## Task C-11: the trigger-matcher as first reactor (`trigger-matcher.ts`)

**Mitigations:** 49 (reads trigger documents as a reactor), 50 (allow-list at match), 51 (autonomy gate), 52 (idempotency — also absorbs at-least-once replay).

**Files:**
- Create: `apps/server/src/lib/trigger-matcher.ts`
- Create: `apps/server/src/lib/reactors.ts` (the static registry — relocate `REACTORS` here from C-10b)
- Test: `apps/server/src/lib/trigger-matcher.test.ts`
- Modify: `packages/shared/src/events.ts` (+ test) — add `agent.chain.suppressed`
- Modify: `apps/server/src/env.ts` — add `FOLIO_AGENT_CHAINS_ENABLED`

- [ ] **Step 1: Add `agent.chain.suppressed` event kind (failing test first).**

In `packages/shared/src/events.test.ts`:
```ts
test('includes agent.chain.suppressed', () => {
  expect(KNOWN_EVENT_KINDS).toContain('agent.chain.suppressed');
});
```
Run: `cd packages/shared && bun test src/events.test.ts` → FAIL.
Add `'agent.chain.suppressed'` to the `EventKind` union + `KNOWN_EVENT_KINDS` (group it near the agent events). Run → PASS.

- [ ] **Step 2: Add the autonomy-gate env var.**

In `apps/server/src/env.ts`:
```ts
  FOLIO_AGENT_CHAINS_ENABLED: z.coerce.boolean().default(false),
```
(Confirm `z.coerce.boolean()` behavior with string `'false'` — `z.coerce.boolean()` treats any non-empty string as `true`, so `'false'` coerces to `true`, which is WRONG. Use an explicit transform instead: `z.enum(['true','false']).default('false').transform((v) => v === 'true')` OR `z.string().default('false').transform((v) => v === 'true')`. Pick the explicit form; add a test in an env test if one exists, else verify manually that `FOLIO_AGENT_CHAINS_ENABLED=false` → `false`.)

- [ ] **Step 3: Failing tests for the matcher create-path (allow-list + idempotency).**

Create `apps/server/src/lib/trigger-matcher.test.ts`. Seed a workspace + project + agent (allow-listed to the project) + the enabled builtin triggers (via the existing `seedBuiltinTriggers` / `BUILTIN_TRIGGER_DEFS` path) + the runs table (`ensureRunsTable`). Build a `BusEvent & {seq}` for `agent.task.assigned` with `payload.agent = <slug>` and a human `actor`.

```ts
test('creates one planning agent_run for a human assignment matching builtin-on-assignment', async () => {
  await triggerMatcher.react(assignmentEvent);  // human actor, agent allow-listed
  // assert exactly one agent_run row at status=planning in the project's runs table
});
test('does NOT create a run when the agent allow-list excludes the project (mitigation 50)', async () => {
  // agent.frontmatter.projects = ['other-project']
  await triggerMatcher.react(assignmentEvent);
  // assert zero agent_run rows
});
test('does NOT create a duplicate when getActiveRun returns a non-terminal peer (mitigation 52)', async () => {
  // pre-seed a running run for (parent, agentSlug)
  await triggerMatcher.react(assignmentEvent);
  // assert no second row
});
```
Run: `cd apps/server && bun test src/lib/trigger-matcher.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement the matcher create-path.**

Create `apps/server/src/lib/trigger-matcher.ts`:
```ts
import type { BusEvent } from './event-bus.ts';
import type { Reactor } from './event-dispatcher.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { and, eq } from 'drizzle-orm';
import { createRun, getActiveRun, ensureRunsTable, nextChainId } from '../services/agent-runs.ts';
import { emitEvent, txWithEvents } from './events.ts';
import { env } from '../env.ts';

export const triggerMatcher: Reactor = {
  id: 'trigger-matcher',
  kinds: ['agent.task.assigned', 'comment.mentioned', 'comment.created'],
  async react(event) {
    if (!event.workspaceId) return;   // workspace-scoped triggers only
    // 1. Load enabled trigger documents for the workspace.
    const triggers = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, event.workspaceId), eq(documents.type, 'trigger')),
    });
    for (const trigger of triggers) {
      const fm = trigger.frontmatter as Record<string, unknown>;
      if (fm.enabled !== true) continue;
      if (fm.on_event !== event.kind) continue;
      // event_filter (e.g. {kind:'approval'}) matched against payload
      if (fm.event_filter && !matchesFilter(fm.event_filter, event.payload)) continue;

      if (fm.internal_action) {
        // resume_run / reject_run — D-5 fills these. C.3 ships the dispatch stub.
        await handleInternalActionStub(String(fm.internal_action), event);
        continue;
      }
      // agent trigger: resolve frontmatter.agent ($event.agent / $event.agent_slug)
      const agentSlug = resolveAgentPlaceholder(fm.agent, event.payload);
      if (!agentSlug) continue;
      await maybeCreateRun(event, agentSlug);
    }
  },
};
```
Implement the helpers `matchesFilter`, `resolveAgentPlaceholder` (`'$event.agent'` → `payload.agent`; `'$event.agent_slug'` → `payload.agent_slug`; literal slug otherwise), `handleInternalActionStub` (log + no-op, D-5 fills), and `maybeCreateRun`:
```ts
async function maybeCreateRun(event: BusEvent & { seq: number }, agentSlug: string): Promise<void> {
  // resolve agent doc, parent doc, workspace, project from event
  // mitigation 50 — allow-list:
  const projects = (agentFm.projects as string[]) ?? ['*'];
  if (!projects.includes('*') && !projects.includes(event.projectId!)) return;
  // mitigation 51 — autonomy gate:
  if (isAgentOriginated(event) && !env.FOLIO_AGENT_CHAINS_ENABLED) {
    await txWithEvents(db, async (tx) => {
      await emitEvent(tx, { workspaceId: event.workspaceId!, projectId: event.projectId, documentId: event.documentId, kind: 'agent.chain.suppressed', actor: event.actor ?? 'system', payload: { agent_slug: agentSlug, reason: 'autonomy_gate' } });
    });
    return;
  }
  // mitigation 52 — idempotency:
  const active = await getActiveRun({ parentId: event.documentId!, agentSlug });
  if (active) return;
  const runsTable = await ensureRunsTable(/* workspace, project */);
  await createRun({ workspace, project, runsTable, agent, actor: originatingUser, input: { triggerId: trigger.id, firedBy: event.kind, chainId: nextChainId({ firedBy: event.kind }) } });
}

function isAgentOriginated(event: BusEvent): boolean {
  if (typeof event.actor === 'string' && event.actor.startsWith('agent:')) return true;
  const p = event.payload as Record<string, unknown> | undefined;
  return typeof p?.run_id === 'string';
}
```
(Resolve the agent/parent/workspace/project/originatingUser from the event + db. The `actor: User` for `createRun` is the originating human — resolve from `event.actor` (a user id for human-originated events). Document: trigger-created runs are owned by the originating human; no system: user — closes C.2-R-3. Ground-truth `createRun`/`getActiveRun`/`ensureRunsTable` exact arg shapes before finalizing.)
Run: `cd apps/server && bun test src/lib/trigger-matcher.test.ts` → the 3 create-path tests PASS.

- [ ] **Step 5: Failing tests for the autonomy gate (mitigation 51).**

```ts
test('flag OFF + agent-originated @mention → ZERO runs + one agent.chain.suppressed', async () => {
  // env.FOLIO_AGENT_CHAINS_ENABLED = false (default); event.actor = 'agent:foo'
  const suppressed: string[] = [];
  const unsub = eventBus.subscribe(ws.id, undefined, (e) => { if (e.kind === 'agent.chain.suppressed') suppressed.push(e.kind); });
  await triggerMatcher.react(agentOriginatedMentionEvent);
  unsub();
  // assert zero new agent_run rows AND suppressed.length === 1
});
test('flag OFF + human @mention → exactly one run, no suppressed event', async () => { /* human actor → one row */ });
test('flag ON + agent-originated @mention → one run', async () => {
  // override env.FOLIO_AGENT_CHAINS_ENABLED = true for this test; restore after
});
```
(Toggling `env.FOLIO_AGENT_CHAINS_ENABLED` per-test: `env` is parsed once at import. Either inject the flag into the matcher, or mutate `(env as {FOLIO_AGENT_CHAINS_ENABLED: boolean}).FOLIO_AGENT_CHAINS_ENABLED` in the test + restore in a `finally`/`afterEach`. Prefer reading the flag through a tiny indirection the test can stub, to avoid env-mutation fragility — document the choice.)
Run → FAIL (gate not implemented if you stubbed it; or PASS if Step 4 already wired it — if so, these tests pin it). **Run 3× for determinism.**

- [ ] **Step 6: Create the registry + register the matcher.**

Create `apps/server/src/lib/reactors.ts`:
```ts
import type { Reactor } from './event-dispatcher.ts';
import { triggerMatcher } from './trigger-matcher.ts';
export const REACTORS: readonly Reactor[] = [triggerMatcher];
```
In `event-dispatcher.ts`, replace the local placeholder `const REACTORS = []` with `import { REACTORS } from './reactors.ts'` (relocate per the C-10b note).
Run: `cd apps/server && bun test src/lib/event-dispatcher.test.ts src/lib/trigger-matcher.test.ts` → all PASS (3×).

- [ ] **Step 7: Full suite + typecheck + lint + commit.**

Run: `cd apps/server && bun test` (expect ~860 → ~872) ; `cd packages/shared && bun test` ; `cd apps/server && bun x tsc --noEmit` ; `bunx biome check src/lib/trigger-matcher.ts src/lib/reactors.ts`.
Invoke `Skill("netdust-core:testing-workflow")`.
```bash
git add packages/shared/src/events.ts packages/shared/src/events.test.ts apps/server/src/env.ts apps/server/src/lib/trigger-matcher.ts apps/server/src/lib/reactors.ts apps/server/src/lib/trigger-matcher.test.ts apps/server/src/lib/event-dispatcher.ts
git commit -m "phase-3: C-11 trigger-matcher as first reactor — document-as-trigger + allow-list + autonomy gate + idempotency"
```

---

## Task C-12: runner poller (`poller.ts`)

**Mitigations:** 36/37 (claim-race + orphan recovery via C.1 services), 38 (orphan-vs-active recency floor — inherited).

**Files:**
- Create: `apps/server/src/lib/poller.ts`
- Test: `apps/server/src/lib/poller.test.ts`
- Modify: `apps/server/src/env.ts` (`FOLIO_POLLER_INTERVAL_MS`, `FOLIO_POLLER_CONCURRENCY`, `FOLIO_WORKER_STALE_MS`)
- Modify: `apps/server/src/index.ts` (boot wiring)

- [ ] **Step 1: Add poller env vars.**
```ts
  FOLIO_POLLER_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  FOLIO_POLLER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  FOLIO_WORKER_STALE_MS: z.coerce.number().int().min(10_000).default(300_000),
```

- [ ] **Step 2: Failing tests (inject runAgent/runAgentResume; manual tick).**

Create `apps/server/src/lib/poller.test.ts`. Export a `runPollerOnce(db, { runAgent, runAgentResume, maxConcurrent, inFlight })` so tests inject fakes (avoid `mock.module` — `[[mock-module-leaks-across-bun-tests]]`).
```ts
test('calls recoverOrphanRuns once on boot before the first claim', async () => { /* spy */ });
test('claims a planning row and dispatches runAgent', async () => {
  // seed one planning run; runPollerOnce → fake runAgent called with its id
});
test('dispatches runAgentResume when the claimed row has frontmatter.resume_of', async () => {
  // seed planning run with resume_of set → fake runAgentResume called, runAgent NOT
});
test('respects the concurrency cap (never more than N in-flight)', async () => {
  // seed N+2 planning rows, cap=N → only N dispatched this tick
});
test('a runAgent rejection does not crash the loop', async () => {
  // fake runAgent rejects → runPollerOnce resolves, next tick still claims
});
```
Run → FAIL. **Run 3× for determinism** (concurrency/claim timing).

- [ ] **Step 3: Implement the poller.**
```ts
import { claimNextPlanningRun, recoverOrphanRuns, countPendingPlanning, runAgent, runAgentResume } from '../services/agent-runs.ts';
// + runner.ts entry points
export async function runPollerOnce(db, deps): Promise<void> {
  // while inFlight < cap: const row = await claimNextPlanningRun(db); if (!row) break;
  // const fm = row.frontmatter; const run = fm.resume_of ? deps.runAgentResume : deps.runAgent;
  // inFlight++; void run({ runId: row.id }).catch(logErr).finally(() => inFlight--);
  // backpressure: if (await countPendingPlanning(db)) > 10) console.warn(...)
}
export function startRunnerPoller(db): () => void {
  void recoverOrphanRuns(db).catch((e) => console.error('[poller] boot recovery', e));   // boot recovery once
  const handle = setInterval(() => void runPollerOnce(db, {...}).catch(...), env.FOLIO_POLLER_INTERVAL_MS);
  return () => clearInterval(handle);
}
```
(Ground-truth `claimNextPlanningRun`/`recoverOrphanRuns`/`countPendingPlanning` signatures + return shapes before finalizing. `runAgent`/`runAgentResume` are from C-8/C-9 — `runner.ts`.)
Run → PASS (3×).

- [ ] **Step 4: Boot wiring in `index.ts`** (after the dispatcher block):
```ts
import { startRunnerPoller } from './lib/poller.ts';
if (env.NODE_ENV !== 'test') {
  console.log(`[folio] runner poller enabled (interval: ${env.FOLIO_POLLER_INTERVAL_MS}ms, concurrency: ${env.FOLIO_POLLER_CONCURRENCY})`);
  startRunnerPoller(db);
}
```

- [ ] **Step 5: Full suite + typecheck + lint + commit.**
Run: `cd apps/server && bun test` (expect ~872 → ~882) ; `bun x tsc --noEmit` ; `bunx biome check src/lib/poller.ts`.
Invoke `Skill("netdust-core:testing-workflow")`.
```bash
git add apps/server/src/env.ts apps/server/src/lib/poller.ts apps/server/src/lib/poller.test.ts apps/server/src/index.ts
git commit -m "phase-3: C-12 runner poller — claim loop + concurrency cap + boot recovery + wiring"
```

---

## Task C-13: Sub-phase C.3 integration gate (controller, not a subagent)

- [ ] `cd apps/server && bun test` → expect ~882 / 1-skip / 0-fail. `cd packages/shared && bun test` → green. Web unaffected. `bun x tsc --noEmit` clean (server). 
- [ ] **First "agent does work" smoke** (manual, dev server): configure an Anthropic key (Sub-phase B UI), assign a work_item to an agent → the dispatcher matches `builtin-on-assignment` against the trigger document → creates a `planning` run → the poller claims it ~1s later → `runAgent` streams (only `__echo` registered until D-3, so the LOOP runs end-to-end; real tool work waits for D) → a `kind=result` comment lands on the parent.
- [ ] **Autonomy-gate smoke:** with `FOLIO_AGENT_CHAINS_ENABLED` unset (default false), an agent-posted `@mention` produces zero runs + one `reactor`-independent `agent.chain.suppressed` signal. Set the env true, restart → one run fires.
- [ ] **Reactor-halt smoke (optional):** temporarily make the matcher throw on a seeded event → confirm one `reactor.halted` on the bus (an SSE client sees it), cursor stops advancing, lag grows; revert → `reactor.recovered`.
- [ ] `netdust-core:integration` → `/code-review --base=<C.2 close sha, 2a2dca2> --effort=medium` (reviewer prompt names mitigations 43, 49, 50, 51, 52, 53 + the dispatcher's at-least-once/idempotency + the system-event tenant-isolation rule) → sibling-site audit on the C.3 diff → `netdust-core:evaluate`.
- [ ] Sub-phase C complete. Next: **Sub-phase D** (routes + MCP parity + real tools in D-3 → mitigation 27 + tool-error-feedback land there; D-5 fills the `internal_action` resume/reject handlers the matcher stubs).

---

## Carried obligations (NOT for C.3 — Sub-phase D)

- **C.2-R-1 (mitigation 27):** real per-tool agent-lifecycle guards land in D-3 with the real `TOOLS`.
- **C.2-R-2:** feed tool errors back to the model vs. terminate — D-3+.
- **D-5:** fills the matcher's `internal_action` resume_run/reject_run stubs (resume → `runAgentResume` via a new planning row with `resume_of`; reject → `rejectRun`). Mitigation 43 race resolution lives in `transitionRun` (C-9), works identically async.
- **Pre-existing `transitionRun` null-materialization** cleanup before the MD-export wedge.
