# Reaction Plane — Durable Event Reactions Design

**Date:** 2026-05-29
**Status:** APPROVED (brainstorm complete) — ready for implementation planning
**Phase:** 3, Sub-phase C.3 (reshuffles the C.3 plan written 2026-05-29 at `96accdd`)
**Supersedes:** the Option-A "inline-in-tx matcher" approach in the C.3 plan section. See the decision brief `docs/superpowers/specs/2026-05-29-event-delivery-decision.md` for the A-vs-B analysis; this document is the chosen design (Option B-minimal, confirmed by external evaluation).

---

## Goal

Formalize **durable, replayable reactions over the append-only SQLite event log**, so that any agent — in-app or external — reacts to events through one uniform, at-least-once mechanism. The trigger-matcher (the component that turns "a human assigns/@mentions an agent" into "an `agent_run` is created") becomes the first reactor on this substrate.

This is deliberately **not** a message broker, workflow engine, or distributed queue. No exactly-once, no DLQ, no orchestration graphs, no sidecar. One SQLite table + one poll loop.

---

## Background: the problem

Folio's product thesis: **"everything is an event; agents react to events; an in-app agent and an external (Claude-Code-over-MCP) agent are the same — same identity, tools, scopes, auth."** Behavior is authored as **content**: a user creates an **agent** (document) and a **trigger** (document) whose frontmatter says *"on event X matching filter F, run agent A"* (or run an `internal_action`).

The event system today is **emit + observe**, not **emit + react**:

- Every write calls `emitEvent(tx, ...)` → durably inserts an `events` row (with a monotonic, UNIQUE-indexed `seq`) inside the writer's transaction, then queues an in-memory bus publish drained **after commit**.
- The in-memory bus (`lib/event-bus.ts`) is **at-most-once, best-effort, only-while-connected**: a crash between commit and the post-commit drain loses the publish; subscribers exist only for the life of a connection; per-subscriber handler errors are swallowed.
- The only subscriber today is the **SSE endpoint** (`routes/events.ts`) — read-only fan-out to connected clients. Nothing server-side **acts** on an event.

That looseness is **correct for observation** (a missed live update self-heals on the next state re-read; SSE has Last-Event-Id replay). It is **wrong for reaction**: a dropped "create a run" is never re-derived — the agent silently never runs. And the looseness is **identical for inside and outside subscribers** — so making only the in-app reaction reliable would re-introduce the inside/outside asymmetry the product forbids.

**Decision (this document):** add a second delivery plane purpose-built for reactions, keep the existing bus untouched for observation, and name the two planes explicitly so the overloaded term "event system" stops hiding two different delivery contracts.

---

## Section 1 — The two planes

The event system has **two delivery planes over one append-only log** (the `events` table). Both planes read the same rows; neither is unified into the other.

| | **Observation Plane** | **Reaction Plane** |
|---|---|---|
| Purpose | tell live listeners what happened | make something happen because of an event |
| Mechanism | in-memory `eventBus` (existing, **one additive rule** — see §4b) | new `lib/event-dispatcher.ts` (polling) |
| Delivery | at-most-once, best-effort | at-least-once |
| Scope | per-connection, per-workspace | global, cross-workspace, server-owned |
| Loss behavior | self-heals (state re-read / SSE replay on reconnect) | retried until acked (reactors are idempotent) |
| Consumers | SSE clients (UI, external agents *observing*) | reactors (matcher = first; future: external-agent reactors, reconcilers) |
| Latency | low (live fan-out) | poll-interval bounded (~1s) |

The Observation Plane keeps the fast lossy path the UI relies on. The Reaction Plane polls the durable table by `seq`. **The UI is never unified onto the durable path** — it does not need durability; it re-reads state. Collapsing the two would be reinventing a broker (explicitly out of scope).

> **The one Observation-Plane change:** the Reaction Plane reports its *own health* (a halted reactor) back onto the Observation Plane as a **system-level event** so the operator/UI can see it live. This requires one narrow additive rule in the existing bus (`workspaceId: null` = system-level → delivered to all subscribers). See §4b. This is additive (a new `null`-workspace case), not a change to existing per-workspace delivery.

This naming is load-bearing: it prevents a future change from "fixing" one plane by conflating it with the other.

---

## Section 2 — Data model

One new table. The `events` table and its `seq` + `events_workspace_seq_idx` already exist and are sufficient (they back the existing SSE replay).

```ts
// new migration + apps/server/src/db/schema.ts
export const reactorCursors = sqliteTable('reactor_cursors', {
  reactorId: text('reactor_id').primaryKey(),   // stable id, matches the in-code registry, e.g. 'trigger-matcher'
  lastSeq:   integer('last_seq').notNull(),      // highest events.seq this reactor has processed (acked)
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
});
```

That is the entire durable footprint of the Reaction Plane — one integer per reactor.

- `reactorId` — primary key → one row per reactor. The id comes from the static registry (Section 3).
- `lastSeq` — advance-on-success, written **after** the handler resolves (Section 3, durability model). Absent row = reactor never registered → seed at `MAX(seq)` on first registration, persist, resume thereafter.
- `updatedAt` — observability only (when the reactor last made progress); not load-bearing.

**Health metric (free, no new table):** reactor lag = `MAX(events.seq) − reactorCursors.lastSeq`. A reactor halted on a poison event (Section 3) shows as growing lag — the operator signal. Recovery: bump `lastSeq` past the poison event (one `UPDATE`).

**Cascade safety:** `reactor_cursors` has **no FK** to `events` (it stores a `seq` value, not a row reference). `events` rows are workspace-cascade-deleted; that never orphans or breaks a cursor. The cursor is a global high-water mark, decoupled from any individual event row's lifecycle.

---

## Section 3 — The dispatch contract

### The reactor interface

```ts
interface Reactor {
  id: string;                              // stable; matches reactor_cursors.reactorId — e.g. 'trigger-matcher'
  kinds: readonly EventKind[];             // coarse kind-filter — EFFICIENCY, not security
  react(event: BusEvent): Promise<void>;   // idempotent; a throw = not-acked = retried next tick
}
```

### The static registry

```ts
const REACTORS: readonly Reactor[] = [triggerMatcher];  // matcher is element 0; adding reactor #2 is a code change
```

No runtime registration API (YAGNI — one reactor in V1; runtime registration adds cursor-seeding lifecycle complexity for an unbuilt need).

### The dispatch loop

One **global** timer (cross-workspace), per-reactor cursor drain. Per tick, for each reactor independently:

```
for each reactor R in REACTORS:
  cursor = load R.lastSeq
           (if the reactor_cursors row is ABSENT: seed cursor = SELECT COALESCE(MAX(seq),0) FROM events,
            persist the row, and use that — "start from now"; see Cold start below)
  rows = SELECT * FROM events WHERE seq > cursor ORDER BY seq ASC LIMIT FOLIO_DISPATCHER_BATCH
  for each event in rows (strict seq order):
    if event.kind ∉ R.kinds:
      persist R.lastSeq = event.seq        // seen-and-skipped — cursor advances past filtered events
      continue
    try:
      await R.react(event)                 // the reactor's own effect + its own idempotency
      persist R.lastSeq = event.seq         // CURSOR-AFTER: advance only on success
      if R was previously halted:           // edge-trigger: halted → healthy
        emit reactor.recovered (system-level, workspaceId=null); mark R healthy in-memory
    catch err:
      log(err)
      if R was NOT previously halted:       // edge-trigger: healthy → halted (fires ONCE, not per-tick)
        emit reactor.halted (system-level, workspaceId=null,
              payload: {reactor_id: R.id, stuck_at_seq: event.seq, error_summary: sanitize(err)})
        mark R halted in-memory
      BREAK this reactor's drain this tick  // halt; cursor unchanged → retried next tick
  // one reactor halting does NOT abort the other reactors' drains this tick (failure isolation)
```

### Contract properties

- **At-least-once (cursor-after).** The cursor advances only after `react()` resolves. A crash between the reactor's effect and the cursor write means the event is re-run next tick → the reactor's idempotency absorbs it. This is the only model an **external** reactor can also satisfy (an external agent cannot enlist in the server's SQLite transaction), so it keeps inside===outside true at the durability layer. The reaction effect and the cursor write are deliberately **not** in one transaction.
- **Strict in-order per reactor.** A reactor never sees `seq=N+1` before acking `seq=N`. A genuinely poison event **halts that reactor** (safe failure — never skip, e.g. never silently drop an assignment). Visible as cursor-lag; recoverable by bumping the integer. No DLQ, no skip-on-failure, no retry-counter (those edge toward broker semantics and are out of scope). Rationale: reactor handlers are *our* code, so a poison event is a bug to fix, not a steady-state condition; halt-and-surface beats drop-or-count.
- **Failure isolation.** Independent cursors + independent per-reactor drains within the shared tick → reactor A halting on a poison event does not stall reactor B.
- **Edge-triggered halt observability.** The dispatcher tracks each reactor's last-known health **in memory** (healthy | halted). A poison event is retried every tick (~1s), but `reactor.halted` fires **once** on the healthy→halted edge (not per-tick — no event-log spam, no flapping banner), and `reactor.recovered` fires once when the reactor next succeeds (cursor advances past the poison event). On process restart, in-memory health resets to "healthy" and is re-derived: if the poison event is still poison, the next failed tick re-fires `reactor.halted` (correct — a restart that didn't fix the bug is still halted). Mirrors the existing `workspace.provider.degraded`/`recovered` tipping-edge pattern (`maybeEmitProviderHealthEdge`, C.1 mitigation 45–47) — with one deliberate difference: provider-health edge state is **persisted** (a workspace stays durably `degraded`), whereas reactor health is held **in memory** and re-derived from cursor-lag on restart. Rationale: reactor health is a live operational signal, not durable workspace state; the durable truth is the cursor (lag = halted), so persisting a separate health flag would be redundant state to keep in sync. A double-emit across a fast restart is harmless (the banner is idempotent on `reactor_id`). These are **system-level** events (§4b). The error payload is **sanitized** (`sanitizeProviderError`-style — no raw internals/secrets) and carries no tenant data.
- **Kind-filter advances the cursor.** A reactor with a narrow filter still moves its cursor past events it does not handle, so it never falls infinitely behind `MAX(seq)`. The filter is an efficiency/clarity device, **not** a security boundary — the reactor still runs its own allow-list / visibility / autonomy checks on every event it does handle.
  - *Implementation note (cursor write batching):* the pseudocode persists `lastSeq` per event for clarity. The plan may batch the cursor write to once per drain-tick (persist the highest acked `seq` after the loop) to avoid a write-per-skipped-event on a busy log — provided it preserves the contract: the persisted cursor must never be ahead of an event whose `react()` has not yet succeeded. Batching the *skipped-event* advances is always safe; batching across a *handled* event is only safe up to the last successfully-reacted seq.

### Cold start / restart

- **First registration** (cursor row absent): seed `lastSeq = MAX(events.seq)` ("start from now"), persist. On a fresh install the log is empty → seeds at 0 → the reactor sees every real event. On an existing instance, a newly-added reactor does **not** retroactively react to all history (no stampede of runs for long-closed tasks).
- **Every subsequent boot** (cursor row present): resume from the stored cursor — the reactor processes the backlog that accumulated while the process was down. This is what makes at-least-once survive **restarts**, not just mid-tick crashes.
- No per-reactor seed-policy knob until two reactors genuinely disagree (a future backfill-from-history reactor would seed at 0 explicitly).

### Boot wiring

Mirrors the existing reconciler and the runner poller (C-12):

```ts
if (env.NODE_ENV !== 'test') {
  startEventDispatcher(db);
}
```

New env (in `src/env.ts`, Zod-coerced, alongside the existing `FOLIO_*` vars):
- `FOLIO_DISPATCHER_INTERVAL_MS` (default `1000`)
- `FOLIO_DISPATCHER_BATCH` (default `100`)

Not started in `NODE_ENV=test` (covered by unit tests that drive the loop manually with a fake reactor).

### Relationship to the runner poller (two separate loops, two jobs)

- **Event dispatcher** (this design): `events` → reactors → *create* `agent_run` rows (and other reactions).
- **Runner poller** (C-12, unchanged): claims `planning` `agent_run` rows → *executes* `runAgent`/`runAgentResume`.

The matcher (a reactor) creates a `planning` run; the poller later claims and runs it. Two stages, two loops.

---

## Section 4b — System-level events (reactor health on the Observation Plane)

A reactor's health is neither workspace-scoped nor project-scoped — the dispatcher is **one server-wide loop** reacting across all workspaces, so a halted reactor is an **instance-level** fact. `reactor.halted` / `reactor.recovered` are therefore the first **system-level** events: a genuine third scope alongside the existing workspace-scoped and project-scoped events.

**Delivery — one narrow additive bus rule.** The existing `eventBus.publish()` filters `sub.workspaceId === e.workspaceId` (a subscriber sees only its own workspace). System events carry `workspaceId: null` and are delivered to **all** subscribers regardless of their workspace filter. This generalizes, by exactly one notch, the precedent already in the bus (`BUG-021`: workspace-level events with `projectId: null` transcend *project* scope) — now `workspaceId: null` transcends *workspace* scope. It is **additive** (a new `null`-workspace case before the existing equality check); existing per-workspace delivery is unchanged.

**Scoping rules for system events:**
- `workspaceId: null` (and `projectId: null`, `documentId: null`) — a system event belongs to no tenant.
- **MUST be tenant-data-free by construction.** Because a system event reaches every connected subscriber across every workspace, its payload may contain ONLY instance-level, non-tenant data. `reactor.halted` carries `{reactor_id, stuck_at_seq, error_summary}` — a reactor id, a sequence integer, and a sanitized error string. No document content, no workspace identifiers, no agent slugs that would leak cross-tenant. This is a hard rule, enforced by review: any future system event MUST pass the "would I show this to an unrelated tenant?" test.
- **Live-only, NOT durable (corrected during planning).** `events.workspace_id` is a `NOT NULL` FK to `workspaces.id`, so a `workspaceId: null` system event **cannot be inserted as a durable `events` row.** System events are therefore **published to the in-memory bus only** (`eventBus.publish(...)` directly, bypassing `emitEvent`) — they are live operational signals, not durable workspace history. This is consistent with the rest of the design: the **durable truth for reactor health is cursor-lag** (`MAX(seq) − lastSeq`), re-derivable any time; a missed live `reactor.halted` self-heals because the *next* failed tick re-fires it (the reactor is still halted) and the lag is still visible. The Reaction Plane's own health signal flows through the Observation Plane — the planes compose — but as a live signal, matching the Observation Plane's own (lossy, live) contract. (A future durable `system_events` table is possible if instance-level audit history is ever needed; out of scope for V1.)
- **Not consumed by the Reaction Plane.** The matcher's `kinds` filter does not include `reactor.*` — reactors do not react to reactor-health events (no feedback loop). System events are observation-only in V1.

**UI (deferred to Sub-phase E):** the web UI subscribes to system events over SSE and renders a system-status banner — identical to the existing `workspace.provider.degraded` banner, just instance-level instead of workspace-level. C.3 ships the **event + edge-detection + the bus rule**; the **visual banner** lands in E alongside the provider-degraded banner. The event is the contract; the banner is downstream and free once the event exists.

**Event kinds added** (shared `KNOWN_EVENT_KINDS` + server `EventKind` union): `reactor.halted`, `reactor.recovered`.

---

## Section 4 — The matcher reads trigger documents, as the first reactor

**Core principle preserved and strengthened: behavior is authored as content.** A trigger is a **document** (`type='trigger'`) whose frontmatter wires events to an agent or an internal action. The matcher's whole job is to **read those trigger documents and honor them.** Option B does not touch that logic — it changes only the plumbing that carries events to it.

```ts
// apps/server/src/lib/trigger-matcher.ts
export const triggerMatcher: Reactor = {
  id: 'trigger-matcher',
  kinds: ['agent.task.assigned', 'comment.mentioned', 'comment.created'],
  async react(event) {
    // 1. Load the workspace's ENABLED trigger DOCUMENTS (type='trigger').
    //    Match each: frontmatter.on_event === event.kind
    //    AND frontmatter.event_filter (if present) matches the event payload.
    //    THE TRIGGER DOCUMENT IS THE SOURCE OF TRUTH — this is document-as-trigger.   [mit 49]
    // 2. For each matched trigger mapping to an agent (resolve frontmatter.agent,
    //    incl. the $event.agent / $event.agent_slug placeholders):
    //    - allow-list gate: agent.frontmatter.projects ∋ event.projectId (or '*')      [mit 50]
    //    - autonomy gate: if isAgentOriginated(event) && !FOLIO_AGENT_CHAINS_ENABLED
    //        → emit ONE agent.chain.suppressed, create ZERO runs, return                [mit 51]
    //    - idempotency: getActiveRun(parent, agentSlug) non-null → skip (no duplicate)  [mit 52]
    //        ← this guard is ALSO what absorbs the at-least-once replay window
    //    - createRun(...) at status=planning
    // 3. For internal_action triggers (frontmatter.internal_action: 'resume_run' | 'reject_run',
    //    i.e. builtin-on-approval / builtin-on-rejection): dispatch to a named handler stub
    //    that Sub-phase D-5 fills (resume_run → runAgentResume path; reject_run → rejectRun).
  },
};
```

`react()` is **idempotent by construction** — the `getActiveRun` guard (mitigation 52) makes a replayed event (crash between effect and cursor-write) a no-op. That guard was already in the plan; under the Reaction Plane it is *also* the at-least-once safety net.

### The clarification that matters: two separate concerns

1. **Matching LOGIC** — read trigger documents, honor `on_event` / `event_filter` / `agent` / `internal_action`. **Stays in full. It is the reactor's body.**
2. **Delivery MECHANISM** — how an event reaches that logic. This is the *only* thing the design changes. Option A would hard-wire a `matchTriggers(tx, event)` call into each emit site (`services/comments.ts`, `services/documents.ts`, `routes/documents.ts`). Option B deletes that hard-wiring: the dispatcher reads the **`events` table** — which **every** emit already writes to, unconditionally — and feeds every event to the matcher.

### Why the Reaction Plane is *more* faithful to document-as-trigger

| | Option A (hard-wired emit sites) | Option B (Reaction Plane) |
|---|---|---|
| Honors trigger documents | matcher logic — same | matcher logic — same |
| *When* matching runs | only at the ~3 emit sites a dev wired | on **every** event in the log, automatically |
| New event kind / new emitter | triggers silently don't fire until wired | triggers fire automatically, no wiring |
| User-authored trigger on a new event kind | works only if that emit site was wired | works the instant the trigger document is saved |
| document-as-trigger promise | "works where we remembered to wire it" | "works for every event, period" |

The full thesis delivered: a **user-authored** trigger document beyond the 4 builtins — e.g. *"on `document.updated` where `status: done`, run agent X"* — works the moment it is saved, with **zero new code**, because `document.updated` is already in the event log, the dispatcher already feeds it to the matcher, and the matcher already reads all enabled trigger documents.

### Approval / rejection race (mitigation 43) under the Reaction Plane

Two members approve/reject the same `awaiting_approval` run simultaneously. Both `internal_action` handlers (wired in D-5) call `transitionRun`; the state machine allows `awaiting_approval → running` OR `→ rejected` only from that one source state, so the loser gets `INVALID_RUN_TRANSITION` / `RUN_TRANSITION_RACED` and no-ops. C-9 already implements exactly this. It works identically whether the matcher runs in-tx (Option A) or as an async reactor (Option B) — the race is resolved at the `transitionRun` layer, not the delivery layer.

---

## C.3 plan reshuffle

Option B simplifies the previously-written C.3 section. **Deleted:**

- ~~C-12 "wire `matchTriggers` into the emit sites"~~ — the hand-wiring is gone. Not the matcher; only the per-emit-site calls. The matching logic lives in the reactor, reached by the dispatcher.
- ~~C-10a "`createRun` gains `tx?`"~~ — for the reaction path. The matcher does not share the originating write's tx (at-least-once, cursor-after); `createRun` runs in its own. (Retain `tx?` only if a non-trigger caller needs it — not this design.)

**Reshuffled task list:**

- **C-10a — system-event delivery rule** (`lib/event-bus.ts` + shared `KNOWN_EVENT_KINDS` + server `EventKind`): the **one Observation-Plane change**, quarantined in its own task + review. Adds the `workspaceId: null` → all-subscribers case to `eventBus.publish()` (one additive branch before the existing `sub.workspaceId === e.workspaceId` check, mirroring the `projectId: null` precedent), plus the two new event kinds `reactor.halted` + `reactor.recovered`. No dispatcher, no reactor — just the delivery primitive + the kinds. Tested against the bus directly: a `workspaceId: null` event reaches a subscriber whose workspace filter does NOT match; a normal workspace-scoped event still does NOT cross workspaces (existing behavior unbroken). This is the only task touching the Observation Plane — keeping it isolated means the cross-cutting bus change gets scrutinized on its own diff.

- **C-10b — `lib/event-dispatcher.ts`** (the durable dispatcher): `reactor_cursors` table + migration; the `Reactor` interface; the static `REACTORS` registry; the global poll loop (Section 3); seed-at-MAX + persist + resume; the `FOLIO_DISPATCHER_*` env vars; boot wiring; **edge-triggered `reactor.halted`/`reactor.recovered` emission with in-memory per-reactor health tracking** (§3 contract + §4b — consumes C-10a's event kinds + bus rule). Tested with a fake reactor driving the loop manually (fake timers; inject the reactor to avoid module-global mock leakage). Edge-trigger tests: a poison event fires `reactor.halted` exactly ONCE across N retry ticks; recovery fires `reactor.recovered` once; restart with the bug unfixed re-fires `halted` on the next failed tick.
- **C-11 — `lib/trigger-matcher.ts`** as `REACTORS[0]`: match against trigger documents + allow-list (50) + autonomy gate (51) + idempotency (52) + `createRun`; the `internal_action` dispatch stub for D-5. The autonomy-gate boundary test lives here (flag OFF + agent-originated → 0 runs + 1 suppressed; human-originated → 1 run; flag ON → fires). Also adds the `agent.chain.suppressed` event kind to shared `KNOWN_EVENT_KINDS` + the server `EventKind` union (the one shared-package touch; server-internal observability — no FE consumer).
- **C-12 — `lib/poller.ts`** (runner poller, unchanged from the prior plan): claims `planning` runs → `runAgent`/`runAgentResume` (dispatches resume when `frontmatter.resume_of` is set); concurrency cap; backpressure log; boot recovery via `recoverOrphanRuns`; boot wiring.
- **C-13 — integration gate (controller):** the first "agent does work" smoke — assign a work_item to an agent → the dispatcher matches the trigger document → creates a `planning` run → the poller claims and runs it → a `kind=result` comment lands on the parent (with only `__echo` registered until D-3, the LOOP runs end-to-end even though real tool work waits for D). Plus the autonomy-gate smoke (default-off agent mention → 0 runs + 1 `agent.chain.suppressed`; flip env → 1 run). Then `/integration` → `/code-review --base=<C.2 close sha> --effort=medium` (naming mitigations 43, 49, 50, 51, 52 + the dispatcher's at-least-once/idempotency contract) → sibling-site audit → `/evaluate`.

---

## Threat model delta (extends the Sub-phase C model, mitigations 23–47)

- **49 (REFRAMED)** — *was* "matcher runs in-tx; a matcher throw must roll back the originating write." *Now:* "the matcher reads trigger documents as a reactor on the durable log. A reactor throw **halts the reactor's cursor** (the event is retried next tick); it does **not** roll back the originating write — that write committed independently. The dispatcher must surface the halt (log + observability + visible cursor-lag), never silently skip." Distinct from mitigation 47 (SSE delivery, fire-and-forget by design): the Reaction Plane is at-least-once, not fire-and-forget.
- **50 (unchanged)** — allow-list enforcement at match time: a trigger naming an agent whose `frontmatter.projects` excludes the parent doc's project creates no run.
- **51 (unchanged)** — autonomy gate: `FOLIO_AGENT_CHAINS_ENABLED` (default false) + `isAgentOriginated(event)` short-circuit + one `agent.chain.suppressed`; the V1↔autonomous boundary. The six per-run runner guards are orthogonal (per-run resource caps vs. cross-run fan-out).
- **52 (unchanged, expanded role)** — match-time idempotency via `getActiveRun`: at most one active run per (parent, agent). Under the Reaction Plane this guard does **double duty** — it prevents duplicate runs from double-matching AND absorbs the at-least-once replay window. It is therefore **load-bearing for correctness**, not just a guard: a reactor MUST be idempotent, and this is the matcher's idempotency.
- **53 (NEW) — system-event tenant isolation.** `reactor.halted`/`reactor.recovered` (and any future `workspaceId: null` system event) are broadcast to **every** connected subscriber across **all** workspaces by the new bus rule (§4b). Therefore a system event's payload MUST be tenant-data-free: instance-level fields only (`reactor_id`, `stuck_at_seq`, sanitized `error_summary`). A system event that carried workspace content would leak it cross-tenant. Enforced by review ("would I show this to an unrelated tenant?") + the error_summary is sanitized at emit. The bus rule is delivery-only — it does NOT bypass the SSE layer's existing per-event visibility checks for *workspace*-scoped events; it adds a `null`-workspace broadcast case that applies ONLY to events explicitly emitted as system-level.

---

## Anti-scope (explicit — do NOT build)

Per the external evaluation and the product thesis, the Reaction Plane is "durable replayable reactions over an append-only SQLite event log" — and nothing more:

- **No** unifying SSE / the UI onto the durable path (the Observation Plane stays in-memory + lossy). *The one exception is additive and narrow:* the `workspaceId: null` system-event delivery rule (§4b), so the Reaction Plane can report its own health back onto the Observation Plane. Reactions are NOT delivered to the UI via the durable plane; only the reactor-health *signal* rides the in-memory bus, as an ordinary (system-scoped) event.
- **No** broker semantics, **no** exactly-once (at-least-once + idempotent reactors only).
- **No** dead-letter queue, **no** per-event retry counters (poison event → halt + surface + operator bumps the cursor).
- **No** orchestration, workflow graphs, or distributed infrastructure.
- **No** runtime reactor-registration API (static in-code registry).
- **No** per-reactor seed-policy knob (seed-at-MAX for all, until two reactors disagree).

"You are not building Kafka. You are not building Temporal."

---

## Testing strategy

- **Dispatcher (C-10):** unit tests drive the loop manually (fake timers; a fake reactor injected). Cover: seed-at-MAX on first registration + persist; resume-from-cursor on restart (backlog processed); strict in-order drain; cursor-after (advance only on success); poison-event halt (cursor unchanged, retried next tick, reactor B unaffected); kind-filter advances the cursor past skipped events. **Edge-trigger:** poison event fires `reactor.halted` exactly once across N retry ticks (not per-tick); recovery fires `reactor.recovered` once; restart with the bug unfixed re-fires `halted` on the next failed tick. **System-event delivery:** a `workspaceId: null` event reaches a subscriber whose workspace filter does not match (the new bus rule), while a normal workspace-scoped event still does NOT cross workspaces (existing behavior unbroken). Reset any module-global between tests (per the Bun `mock.module` leak lesson); prefer injecting reactors over `mock.module`.
- **Matcher (C-11):** match assignment/mention against seeded enabled trigger documents → one `planning` run; allow-list exclusion → zero runs; idempotency (active peer) → no duplicate; **autonomy-gate boundary** (flag OFF agent-originated → 0 + suppressed; human → 1; flag ON → 1); `internal_action` triggers reach the stub. Re-run the matcher's timing/ordering-sensitive tests ≥3× before GREEN (per the C.2 testing-workflow lesson — the same-ms flake class).
- **End-to-end (C-13):** assign → dispatcher → run → poller → result comment; autonomy-gate smoke.
- **No new exactly-once / crash-injection harness** beyond the cursor-after + idempotency unit coverage — the at-least-once contract is verified by "effect ran, cursor advanced only on success, replay is a no-op," not by a fault-injection framework.

---

## Open questions for D / beyond (carried, not for C.3)

- **C.2-R-1 (mitigation 27):** real per-tool agent-lifecycle guards land in D-3 when the real `TOOLS` move into `lib/agent-tools.ts`.
- **C.2-R-2:** feed tool errors back to the model (self-correct) vs. terminate — D-3+ when real errorable tools exist.
- **External-agent reactor:** the Reaction Plane is designed so an external agent can be a reactor on identical terms (at-least-once, idempotent, cursor) — but no external-reactor surface is built in Phase 3. The substrate is ready; the exposure is future work.
- **Pre-existing `transitionRun` null-materialization** (`error_reason`/`error_detail`/`worker_started_at` `?? null` fail a strict frontmatter parse) — cleanup before the markdown-export wedge needs strict read-time validation.
