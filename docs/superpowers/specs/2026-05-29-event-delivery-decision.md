# Folio — Event Delivery & the Trigger-Matcher: Decision Briefing

**Date:** 2026-05-29
**Status:** OPEN — awaiting external evaluation before C.3 execution
**For:** an external AI evaluator pressure-testing the architecture decision below
**Branch:** `phase-3/agent-runner` (Phase 3, Sub-phase C.3 about to start)
**This is a decision brief, not a plan.** No code has been written for either option. The C.3 plan currently assumes Option A; the open question is whether to switch to Option B before building.

---

## 0. Context (one paragraph)

Folio is a self-hostable, agent-first project-management + wiki tool (Bun + Hono + Drizzle + SQLite, **single binary, no sidecar services** — no Redis, no separate worker, no Postgres-required). A locked product principle: **"everything is an event; agents subscribe to events and act on them; there is NO difference between an in-app agent and an external agent (Claude-Code-over-MCP) — same identity, tools, scopes, auth check."** We are in Phase 3 (the agent runner). The next sub-phase (C.3) must build the **trigger-matcher**: the component that turns "a human assigns a work-item to an agent" or "a human @-mentions an agent in a comment" into "an `agent_run` document gets created and then executed by the runner." The question on the table: **what delivery mechanism should reactions (creating a run in response to an event) use?**

---

## 1. The problem

Today the event system is **emit + observe**, not **emit + react**. Specifically:

- Every write calls `emitEvent(tx, ...)` which (a) **durably inserts a row** into the `events` table inside the writer's transaction, with a monotonic `seq` (UNIQUE-indexed), and (b) queues an in-memory bus publish that drains **after the transaction commits**.
- There is exactly **one** subscriber to the in-memory bus: the **SSE endpoint** (`routes/events.ts`), which forwards events to connected clients (the browser UI, or an external agent holding a stream open). It is **read-only fan-out** — it never performs an action.
- The in-memory bus (`event-bus.ts`) is **at-most-once, best-effort, only-while-connected**:
  - publish happens post-commit in a plain in-memory loop → **lost if the process dies between commit and publish**;
  - subscribers exist only for the life of a connection → **an event published while you are disconnected is gone from the live bus** (a pull-based Last-Event-Id replay from the durable `events` table partially covers reconnects);
  - **per-subscriber handler errors are swallowed** so one bad handler can't stall writes.

**This looseness is correct for observation.** A missed live UI update self-heals on the next state re-read; the SSE replay backfills on reconnect. **It is wrong for reaction.** If the "create a run" delivery is dropped, nothing ever re-derives "this task was assigned but no run exists" — the agent silently never runs. No error, no retry, no trace. Reaction has no self-healing.

**The realization that drove this discussion:** the looseness is **identical for inside and outside subscribers** — the bus has no concept of in/out; a dropped publish is dropped for everyone equally. It only *feels* like an "inside" problem because the only thing that needs to *react* (vs. observe) so far is the in-app trigger-matcher. The moment an **external** agent is given a must-not-lose reactive job, it hits the same wall. Therefore any design that makes only the *inside* reaction reliable **re-introduces the exact inside/outside asymmetry the product forbids** — it just relocates it.

A second framing of the same point: **observation that's missed self-heals (state is re-read); action that's missed does not (no reconcile loop re-derives the un-taken action).** The trigger-matcher is the first *action*, so it is the first time the bus's by-design looseness actually hurts — but it would hurt an external reactor identically.

---

## 2. The proposed solutions

### Option A — inline-in-tx matcher (no event-system change)

The trigger-matcher runs **synchronously inside the originating write's transaction** (the comment-insert tx for mention/approval/rejection; the assignee-PATCH tx for assignment). It reads enabled triggers, matches `on_event` + `event_filter`, and creates the `agent_run` row **in the same tx** — atomic with the write. It does NOT go through the lossy bus. The bus stays observation-only. A separate poller then claims the `planning` run row ~1s later and executes it.

- **Pro:** ships now on existing infra; durable for the inside matcher (atomic with the write); already aligns with an existing threat-model decision — the approval/rejection race resolution (mitigation 43) was already specified as in-tx ("first-COMMIT-wins, loser no-ops").
- **Con:** two different mechanisms — "subscribe to observe" (bus) vs. "react reliably" (inline-in-tx). The bus stays lossy. **The day an external agent must react reliably, it has no equivalent reliable path** → re-introduces the inside/outside asymmetry the product forbids.

### Option B (minimal) — make the durable log itself the reaction substrate

Generalize what the SSE replay already does (pull from the durable `events` table by `seq`) into a first-class **at-least-once, replayable delivery** that *any* reactor — inside or outside — consumes the same way:

- A **cursor-per-reactor** table (`reactor_id → last_processed_seq`).
- A **dispatch loop** (same family as the runner poller being built in C.3 task C-11) reads events with `seq > cursor`, hands each to the reactor; the reactor acts **idempotently**; the cursor advances **only on success** → a crash or error means the cursor did not move → the event is retried (at-least-once).
- The **trigger-matcher becomes the first reactor** on this substrate. A future external agent reacting to events is *the same pattern* — it reads a durable, acked, replayable stream, not a fire-hose it must be connected for.
- The **in-memory bus stays unchanged** for live SSE fan-out (low-latency, loss-tolerant observation). Two tiers on one event stream: **lossy-live for observation; durable-cursor for reaction.**

**Explicit anti-over-engineering constraints (part of the proposal — these define what "minimal" means):**

1. **At-least-once, never exactly-once** → reactors must be idempotent. This is already required: the run-creation guard `create-run-only-if-no-active-run-exists` (threat-model mitigation 52, via `getActiveRun(parentId, agentSlug)`) is naturally idempotent.
2. **No broker / no sidecar** → it is a SQLite table + a poll loop. Honors the one-binary rule.
3. **Per-reactor cursor, NOT a single shared cursor** → a single shared cursor cannot let two reactors process at independent speeds (it would either block the fast one or skip the slow one), which would betray the "any agent reacts independently" goal.
4. **Do NOT unify the UI onto the durable path** → the UI does not need durability; it re-reads state on reconnect. Collapsing both tiers into one durable path = reinventing a message broker = the over-engineering cliff. Keep the in-memory bus for live observation.

### The Folio author's current judgment (recorded for the evaluator to challenge)

**Build minimal-B, sequenced as the first task of C.3, before the matcher.** Reasoning:

- (a) It is the only option where "every agent reacts to events, inside == outside" is **literally true** rather than aspirational.
- (b) The expensive parts already exist: a durable `events` table with monotonic UNIQUE-indexed `seq`; an SSE replay that already pulls from it by `seq` (the precedent); a poll loop being built anyway (C-11); and an idempotency guard already specced (mitigation 52). So B is estimated **~1.2× the cost of A, not 3×.**
- (c) A is reversible (both options ultimately call the same `matchTriggers(event)` logic — only the *delivery* underneath differs), **but** shipping a known-lossy backbone on the system the product calls "core" is debt carried on the wrong foundation.

**Stated confidence: ~7/10.** The honest counter-arguments the author acknowledges:

1. **Scope-creep risk** on an already-long runner phase — turning "build the runner" into "also re-architect event delivery" risks the runner never shipping.
2. **Strict YAGNI** — there are **zero reactors in production today**, and V1 deliberately **gates autonomy OFF** (`FOLIO_AGENT_CHAINS_ENABLED` default false; agent-originated events create zero runs in V1, only human-initiated runs fire). So B's reliability advantages (crash-safety, replay, independent reactors) matter most under exactly the conditions V1 avoids (volume, crash pressure, agent→agent fan-out).
3. **A is reversible** — since both call the same matcher logic, A could ship now and the delivery layer be swapped to B later without rewriting the matcher.

The author's resolution of the tension: build **minimal**-B (not maximal) precisely because #3 cuts both ways — same matcher logic under either option means B's *marginal* cost is small and confined to the delivery layer, so "do the right thing now" is cheap relative to "ship lossy + carry a migration." The author would NOT build B if it were a 3× cost; at ~1.2× the principle wins.

---

## 3. The code this becomes part of (current state, verbatim)

All paths under `apps/server/src/`. Three files define the current event system; the new work slots in alongside them.

### 3a. The durable log already exists — `events` table (`db/schema.ts`)

The outbox is effectively already here: durable, monotonic `seq`, UNIQUE-indexed, **with a composite index already built for cursor replay**.

```ts
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  documentId: text('document_id'),
  kind: text('kind').notNull(),
  actor: text('actor'),                         // user_id or api_token_id
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull().default({}),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  // H3 — monotonic per-row sequence used as the canonical replay cursor.
  // emitEvent computes MAX(seq)+1 inside the same tx as the insert; SQLite's
  // writer lock serializes max()+insert so the value is unique + monotonic.
  // Migration 0009 added the column + backfilled from rowid.
  seq: integer('seq').notNull().default(0),
}, (t) => ({
  workspaceIdx: index('events_workspace_idx').on(t.workspaceId, t.createdAt),
  documentIdx: index('events_document_idx').on(t.documentId),
  seqIdx: uniqueIndex('events_seq_idx').on(t.seq),
  // B3: composite for the SSE replay paginated cursor — covers WHERE
  // (workspace_id + seq > ?) AND ORDER BY (seq ASC) in one index seek.
  workspaceSeqIdx: index('events_workspace_seq_idx').on(t.workspaceId, t.seq),
}));
```

**What minimal-B adds here:** a small `reactor_cursors` table (`reactor_id → last_processed_seq`). Nothing else schema-wise. The `events_workspace_seq_idx` already supports the `seq > cursor` scan.

### 3b. The emit path — `lib/events.ts` (key excerpts)

Every write goes through `emitEvent`: durable insert (with monotonic `seq`) + a post-commit in-memory bus drain. The `txWithEvents` wrapper drains the live bus in a plain loop **after** commit. There is even an existing comment (`G10`) acknowledging a durable-log-vs-live-bus divergence risk under a bun-sqlite rollback quirk — i.e. the team already knows the two paths can disagree. This is precisely where the "lossy for reaction" property lives.

```ts
export async function emitEvent(tx, args) {
  const id = nanoid();
  const createdAt = Date.now();
  // allocate next monotonic seq inside the writer's tx (cached per-tx; primes from MAX(seq))
  // ...
  await tx.insert(events).values({ id, ...args, createdAt: new Date(createdAt), seq });

  const busEvent = { id, ...args, createdAt };
  const pending = pendingByTx.get(tx);
  if (pending) pending.push(busEvent);   // deferred to post-commit drain
  else eventBus.publish(busEvent);        // inline (test-only path that bypasses txWithEvents)
}

export async function txWithEvents(db, fn) {
  const pending = [];
  try {
    const result = await db.transaction(async (tx) => { pendingByTx.set(tx, pending); return fn(tx); });
    // Tx committed — drain the queue onto the in-process bus.
    for (const e of pending) eventBus.publish(e);   // <-- in-memory, post-commit, LOST on crash here
    return result;
  } catch (err) {
    // Tx rolled back — bus publish suppressed; pending discarded.
    // G10: bun-sqlite + drizzle quirk where async throws inside db.transaction don't
    // always roll back the SQL row, leaving an events row with no matching bus publish.
    // A best-effort "scrub" deletes those rows; failures are logged + signaled to
    // operator listeners (the team already treats durable-vs-bus divergence as real).
    throw err;
  }
}
```

**Where B slots in:** the durable dispatcher reads from the `events` table (already written above), by `seq > cursor`, independent of the in-memory `pending` drain. **Where A slots in:** A instead calls `matchTriggers(tx, event)` *inside* `fn`, before commit, so the run row is created in the same transaction.

### 3c. The in-memory bus — `lib/event-bus.ts` (full file)

At-most-once, workspace-scoped, **swallows handler errors** — the property that makes it unsafe as a *reaction* substrate. Both options leave this file unchanged (B keeps it as the observation/SSE tier; A bypasses it).

```ts
import type { EventKind } from './events.ts';

export interface BusEvent {
  id?: string;             // optional; SSE assigns one on emit if absent
  workspaceId: string;
  projectId?: string | null;
  documentId?: string | null;
  kind: EventKind;
  actor?: string;
  payload?: unknown;
  createdAt?: number;      // unix ms; defaults to Date.now()
}

export interface SubFilter {
  kinds?: EventKind[];
  projectId?: string;
  parentId?: string;       // filter to events whose payload.parent_id equals this
  runId?: string;          // filter to events whose payload.run_id equals this
}

type Handler = (e: BusEvent) => void;
interface Sub { workspaceId: string; filter: SubFilter | undefined; handler: Handler; }

/** Single in-process bus. The instance is exported as `eventBus`. */
class EventBus {
  private subs = new Set<Sub>();

  subscribe(workspaceId, filter, handler): () => void {
    const sub = { workspaceId, filter, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(e: BusEvent): void {
    for (const sub of this.subs) {
      if (sub.workspaceId !== e.workspaceId) continue;       // <-- workspace-scoped; no global subscribe
      if (sub.filter?.kinds && !sub.filter.kinds.includes(e.kind)) continue;
      // workspace-level events (projectId=null) transcend project scope (BUG-021)
      if (sub.filter?.projectId !== undefined && e.projectId !== null && sub.filter.projectId !== e.projectId) continue;
      if (sub.filter?.parentId !== undefined) { /* payload.parent_id match */ }
      if (sub.filter?.runId !== undefined) { /* payload.run_id match */ }
      try { sub.handler(e); }
      catch { /* Swallow per-subscriber errors so one bad handler can't take down the bus. */ }
    }
  }

  __clear(): void { this.subs.clear(); }   // test-only
}

export const eventBus = new EventBus();
```

### 3d. The only consumer today — SSE endpoint (`routes/events.ts`, excerpt)

Read-only fan-out to a per-connection queue; applies allow-list + subject-visibility filters; forwards to the wire; never acts. (Above this, omitted here, is a **Last-Event-Id replay** loop that pulls missed events from the `events` table by `seq` on (re)connect — **the existing pull-based, durable-log-backed precedent that minimal-B generalizes into a reusable reactor substrate.**)

```ts
const unsub = eventBus.subscribe(
  ws.id,
  { kinds, projectId, parentId, runId },
  (e) => {
    // F3: drop project-scoped events outside the agent's allow-list.
    if (agentAllowList && e.projectId != null && !agentAllowList.includes(e.projectId)) return;
    // H1/H2: subject-based visibility (same check as the replay loop above).
    if (!isAgentEventVisible(agentEventCtx, { kind: e.kind, projectId: e.projectId ?? null, documentId: e.documentId ?? null, payload: e.payload })) return;
    queue.push(e);   // forward to the SSE wire — NO action taken
  },
);
```

### 3e. Where the new code lands (either option)

- **New (B):** `lib/event-dispatcher.ts` (the at-least-once cursor loop) + a `reactor_cursors` table + migration. `lib/trigger-matcher.ts` = the first reactor on it.
- **New (A):** `lib/trigger-matcher.ts` only, invoked inline from the emit sites in `services/comments.ts`, `services/documents.ts`, `routes/documents.ts`.
- **Shared by both options:** the matcher reads trigger documents (`lib/builtin-triggers.ts` — 4 builtin triggers already defined: on-assignment, on-mention, on-approval, on-rejection), creates runs via `services/agent-runs.ts::createRun` (which would gain an optional `tx?` parameter), and enforces three gates:
  - **allow-list** (the agent's `frontmatter.projects` must include the parent doc's project — mirrors Phase 2.5 access control);
  - **idempotency** (`getActiveRun` — at most one active run per (parent, agent); naturally makes the reactor at-least-once-safe);
  - **the autonomy gate** — `FOLIO_AGENT_CHAINS_ENABLED` (default **false**): when off, an agent-ORIGINATED trigger event creates **zero** runs and emits one `agent.chain.suppressed` signal; human-originated events fire normally. This is the V1↔autonomous boundary. The six per-run resource guards (token budget, depth, rate, chain, provider-health, idempotency) are orthogonal and stay live regardless of the flag.

---

## 4. The question(s) for the evaluator

1. **Primary:** Given the product principle ("everything is an event; agents react to events; inside agents === outside agents") and the existing infra (durable `events` table with monotonic UNIQUE-indexed `seq`; an SSE replay that already pulls from it by `seq`; a poll loop being built anyway; a naturally-idempotent run-creation guard) — **is minimal-B (durable, at-least-once, per-reactor-cursor delivery as the ONE reaction substrate for all agents) the right call, or does the reversibility of A + strict YAGNI (no reactors in prod, autonomy gated OFF in V1) justify shipping A now and migrating to B later?**

2. **If B:** are the four anti-over-engineering constraints (at-least-once not exactly-once; no broker/sidecar; per-reactor cursor; do NOT unify the UI onto the durable path) the right boundaries — or is even **per-reactor cursor** too much for V1, such that a single-cursor "one reactor for now" is the honest minimal and per-reactor cursors should wait until a second reactor actually exists?

3. **Cross-check the cost claim:** the author estimates B is ~1.2× A's cost because the durable log + seq + replay + poll-loop + idempotency guard already exist. **Is that estimate credible, or are there hidden costs** (e.g. cursor/replay interaction with the existing SSE Last-Event-Id replay; ordering across workspaces; reactor-failure isolation; the `G10` rollback-divergence quirk leaking into the dispatcher; cold-start replay-from-zero on first deploy) that push B materially higher?

4. **Reversibility audit:** the author claims A→B is a clean later migration because both call the same `matchTriggers(event)`. **Is that actually true**, or does choosing A bake in assumptions (in-tx atomicity semantics, the approval/rejection first-COMMIT-wins race resolution being tied to the originating tx) that make a later swap to an async at-least-once dispatcher genuinely hard (e.g. the race resolution that mitigation 43 specifies as in-tx would have to be redesigned for an async reactor)?

---

## 5. Pointers (if the evaluator wants to read more in-repo)

- Full Phase 3 plan + threat model (mitigations 23–52): `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md`. The C.3 expanded section (currently assuming Option A, inline-in-tx) is at the "Sub-phase C.3 — Wiring + triggers + autonomy gate" heading; the threat-model mitigations 49–52 there cover the matcher surface.
- Product thesis (agent-as-power-user, inside===outside): `memory/project_folio-agent-thesis.md`, `memory/project_folio-tools-as-primitives.md`.
- The V1↔autonomous decision (build the substrate, gate the exposure): `memory/STATE.md` "Next up" section + the `docs/PHASES.md` "Autonomy gate" block.
- Live code referenced above: `apps/server/src/lib/event-bus.ts`, `apps/server/src/lib/events.ts`, `apps/server/src/routes/events.ts`, `apps/server/src/db/schema.ts` (`events` table), `apps/server/src/lib/builtin-triggers.ts`, `apps/server/src/services/agent-runs.ts` (`createRun`, `getActiveRun`).
