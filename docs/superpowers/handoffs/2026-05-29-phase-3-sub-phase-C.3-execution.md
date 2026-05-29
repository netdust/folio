# Sub-phase C.3 — Execution Handoff (Reaction Plane)

**Branch:** `phase-3/agent-runner`
**HEAD at handoff:** `bcad736` (auto-capture on top of the plan commit `f003912`)
**Plan (EXECUTE THIS):** `docs/superpowers/plans/2026-05-29-phase-3-C3-reaction-plane.md` — fully expanded, 5 tasks, TDD steps with real code.
**Design spec:** `docs/superpowers/specs/2026-05-29-reaction-plane-design.md` (approved).
**Decision brief (why B, not A):** `docs/superpowers/specs/2026-05-29-event-delivery-decision.md`.
**Test baseline at handoff:** server **851 pass / 1 skip / 0 fail** · web 559/8/0 · shared 51/0.
**`.last-integration`:** `6dcfec8` · **`.last-evaluate`:** `6c7ebd4` (both advance at C.3 close).

This is an **execution** handoff — the design + spec + plan are DONE. The next session *builds* C.3; it does not re-plan it. The plan is self-contained (real code in every step); this handoff wires the session into the discipline and flags what to ground-truth first.

---

## Where C.3 sits in Phase 3 (so the goal is clear)

Phase 3 = the agent runner, shipped in sub-phases: **A** (foundation) ✅ · **B** (provider + AI keys) ✅ · **C.1** (services) ✅ · **C.2** (runner C-7/C-8/C-9) ✅ · **C.3** (Reaction Plane — THIS) · **D** (routes + MCP parity + real tools in D-3 + resume/reject handlers in D-5) · **E** (web UI incl. the deferred reactor-halt banner) · **F** (shake-out + merge). C.3 delivers the first "agent does work" moment (C-13 smoke) but real tools (D-3) and UI (E) come after.

---

## What C.3 is (one paragraph)

Two delivery planes over the existing append-only `events` table. The **Observation Plane** (existing in-memory `eventBus`, lossy, SSE) is unchanged except for ONE additive rule. The new **Reaction Plane** (`lib/event-dispatcher.ts`) polls `events` by `seq`, fans out to reactors via per-reactor cursors, advances each cursor only on success (at-least-once; idempotent reactors absorb replays). The **trigger-matcher becomes the first reactor** — it reads trigger **documents** and honors them (document-as-trigger, now reached via the durable log instead of hand-wired emit sites). A separate **runner poller** then claims the `planning` runs the matcher creates and executes them.

The five tasks: **C-10a** (system-event bus rule + `reactor.*` kinds) → **C-10b** (durable dispatcher) → **C-11** (trigger-matcher as first reactor) → **C-12** (runner poller) → **C-13** (integration gate). Sequential.

---

## Mandatory skill activation order (build session)

1. **`superpowers:using-superpowers`** — invoke explicitly first turn.
2. **`netdust-core:ntdst-execute-with-tests`** — the Folio wrapper (CLAUDE.md rule 1). Declare the wrapped upstream skill as **`superpowers:subagent-driven-development`**. The wrapper mandates `Skill("netdust-core:testing-workflow")` at each task close + the structured Test-evidence + STATUS report blocks.
3. **`superpowers:subagent-driven-development`** — fresh subagent per task, two-stage review (spec → quality) per task. Same flow that shipped C.2 cleanly (caught a real bug every task). The C.3 tasks are well-isolated (one new file each for C-10b/C-11/C-12; small additive edits for C-10a), so the subagent's failure mode (missing context) is rare — the plan bodies are self-contained.
4. **`netdust-core:testing-workflow`** — invoked PER TASK by each subagent.
5. (controller, C-13) **`netdust-core:integration`** → **`/code-review --base=2a2dca2 --effort=medium`** → **`netdust-core:evaluate`**.

Do NOT use `executing-plans` (solo) unless a subagent dispatch hits a wall.

---

## Read these FIRST (build session, in order)

1. **The plan** `docs/superpowers/plans/2026-05-29-phase-3-C3-reaction-plane.md` — its "Pre-flight invariants" + "Verified call surface" + "File structure" sections are the build map. Each task has real code.
2. **The spec** `docs/superpowers/specs/2026-05-29-reaction-plane-design.md` — §1 (two planes), §3 (dispatch contract), §4b (system events), §4 (matcher-as-reactor + document-as-trigger). Read §4b carefully — the system-event scope is the one genuinely new concept.
3. **`CLAUDE.md`** — rule 1 (the wrapper). The C threat model (mitigations 23–53) is already in the mega-plan + the spec; C.3 verifies against 49/50/51/52/53, no new threat-model pass needed.
4. **`memory/lessons.md`** 2026-05-29 entry — ground-truth the dependency surface before coding. **This already paid off twice while writing the plan** (see "Corrections already baked in" below); keep applying it per task.
5. **`~/.claude/.../testing-workflow/lessons.md`** 2026-05-29 entry — re-run timing/ordering/concurrency-sensitive test files **≥3×** before GREEN. C.3's dispatcher (fake-tick, edge-trigger) + matcher (idempotency/race) + poller (concurrency) are all this class. The plan already marks the ≥3× requirement on those steps.

---

## Corrections already baked into the plan (do NOT re-discover these)

Writing the plan against live source caught two real gotchas — they're resolved in the plan, don't trip on them again:

1. **System events can't be durable rows.** `events.workspace_id` is a `NOT NULL` FK to `workspaces.id`, so a `workspaceId: null` system event (`reactor.halted`/`recovered`) **cannot be inserted into `events`.** The plan publishes them **bus-only** (`eventBus.publish(...)` directly, NOT `emitEvent`) — they are live signals; the durable truth for reactor health is **cursor-lag** (`MAX(seq) − lastSeq`). Spec §4b is corrected to match. (C-10b Step 6.)
2. **`z.coerce.boolean()` mis-coerces `'false'` → `true`.** For `FOLIO_AGENT_CHAINS_ENABLED` use an explicit transform: `z.string().default('false').transform((v) => v === 'true')` (or the `z.enum(['true','false'])` form). The plan flags this in C-11 Step 2. Verify `FOLIO_AGENT_CHAINS_ENABLED=false` → `false`.

---

## Per-task watch-outs (beyond what the plan states)

- **C-10a — the bus type widening.** The plan widens `BusEvent.workspaceId` to `string | null`. That may surface call sites assuming non-null. If it forces more than a handful of changes, the plan says report **DONE_WITH_CONCERNS** and consider a separate `publishSystem()` method instead of widening the type. Watch `tsc` after the change.
- **C-10b — the `REACTORS` placeholder.** C-10b uses a local empty `const REACTORS = []` in `event-dispatcher.ts`; **C-11 relocates it to `lib/reactors.ts`** and registers the matcher. The plan documents this — don't leave a duplicate registry.
- **C-10b — export `runDispatcherOnce` for tests.** The loop must be drivable one tick at a time (no real timers in unit tests). Same pattern for C-12's `runPollerOnce`. Inject reactors/runAgent rather than `mock.module` (`[[mock-module-leaks-across-bun-tests]]`).
- **C-10b — migration journal.** New `reactor_cursors` migration MUST update `meta/_journal.json` (`[[drizzle-migration-journal]]`); the pre-commit hook checks it.
- **C-11 — the originating actor (closes C.2-R-3).** `createRun` needs `actor: User`. Trigger-created runs are owned by the **originating human** (resolve from `event.actor`, a user id for human-originated events). No `system:` user — that's the FK-safe resolution C-8 established. Document it inline.
- **C-11 — autonomy gate is the most consequential code.** Default OFF; agent-originated → 0 runs + 1 `agent.chain.suppressed`; human → fires. The boundary test (OFF/agent→0+suppressed, OFF/human→1, ON/agent→1) is the V1↔autonomous pin. Toggling the env per-test is fragile (env parsed once at import) — prefer reading the flag through a tiny indirection the test can stub.
- **C-12 — the two loops are separate.** Dispatcher (events → create runs) and poller (claim planning runs → execute) are different loops with different jobs. Don't merge them.

---

## After C.3 closes (C-13 + beyond)

- C-13: `/integration` (expect server ~882) → `/code-review --base=2a2dca2 --effort=medium` (name mitigations 43, 49, 50, 51, 52, 53 + the at-least-once/idempotency + system-event tenant-isolation) → sibling-site audit → `/evaluate`. Then write the C.3→D handoff.
- **Sub-phase D** is next: routes + MCP parity + **real tools in D-3** (mitigation 27 lands here per C.2-R-1; tool-error-feedback redesign per C.2-R-2) + **D-5 fills the matcher's `internal_action` resume_run/reject_run stubs** (resume → new planning row with `resume_of` → `runAgentResume`; reject → `rejectRun`; mitigation 43 race resolution already lives in `transitionRun`).

---

## Two HUMAN_DECISION items still open (from prior retros)

In `tasks/retro-follow-ups.md`, re-flagged across A/C.1/C.2 retros. They don't block C.3 building, but the first one keeps earning its keep:

1. **Plan-freshness check as a `superpowers:writing-plans` skill rule?** C.3's plan-writing caught two phantom-API gotchas (above) by ground-truthing — a skill-level rule would make that mandatory cross-project. Decision: promote to skill rule, or keep as project-local discipline?
2. **Raise `/code-review` 15-finding cap at `--effort=high` on threat-model surfaces?** The C.3 dispatcher + autonomy gate is such a surface; the C-13 review will hit it.

Surface both to the user at the C-13 review step if still unanswered.

---

## First-turn checklist (build session)

1. `superpowers:using-superpowers` (explicit).
2. Read the plan + spec §4b + this handoff.
3. `netdust-core:ntdst-execute-with-tests` (upstream = `superpowers:subagent-driven-development`).
4. Confirm baseline: `cd apps/server && bun test` → 851/1/0.
5. **Dispatch C-10a first** (system-event bus rule — smallest, isolated, Observation-Plane). Ground-truth `event-bus.ts` + `packages/shared/src/events.ts` before coding. Paste the `ntdst-execute-with-tests` addendum verbatim.
6. Two-stage review (spec → quality) per task; re-run the test command yourself (`[[verify-subagent-test-counts]]`); ≥3× on timing-sensitive files.
7. Then **C-10b → C-11 → C-12** in order (sequential; C-10b needs C-10a's kinds+rule; C-11 needs C-10b's `Reactor`; C-12 is independent of the matcher but after the dispatcher).
8. **C-13** controller gate.

If anything gets stuck, STOP and reach for the user. Don't improvise around the discipline.
