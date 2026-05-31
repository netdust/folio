# Sub-phase C.3 — Readiness Handoff

**Branch**: `phase-3/agent-runner`
**HEAD at handoff**: `96accdd` (C.3 plan expansion; `5954281` is a memory auto-capture on top — harmless)
**Plan**: `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md`
**C.3 expanded bodies**: plan lines **4257–4401** (the "Sub-phase C.3 — Wiring + triggers + autonomy gate" section). Do NOT use the historical outlines at line 4402+ (`### Original Sub-phase C task outlines — DO NOT execute against these`).
**Test baseline at handoff**: server **851 pass / 1 skip / 0 fail** · web 559/8/0 · shared 51/0
**Last `/integration` marker**: `6dcfec8` (advance to HEAD when C-10a or C-13 closes)
**Last `/evaluate` marker**: `6c7ebd4` (workspace, gitignored; advance at the next /evaluate after C.3 closes)

This handoff makes the next session's first action unambiguous. C.3 ships the **inline-in-tx trigger-matcher + the runner poller + the autonomy gate** — the wiring that makes "assign a work_item to an agent → the agent runs" actually happen. Five tasks: C-10a, C-10, C-11, C-12, C-13. Sequential.

---

## ⛔ Two HUMAN_DECISION items gate C.3 planning — answer BEFORE dispatching

Both are in `tasks/retro-follow-ups.md`, re-flagged across three retros (A, C.1, C.2). They don't block the *first* task mechanically but they shape C.3 discipline:

1. **Plan-freshness check as a `superpowers:writing-plans` skill rule?** C.2 (and now the C.3 expansion) BOTH caught phantom dependencies by ground-truthing the live code before dispatch — C.3's expansion found `trigger-matcher.ts` doesn't exist and the event bus is the wrong surface. The controller did this manually. **Decision:** promote to a hard skill rule (cross-project) or keep as project-local controller discipline?
2. **Raise `/code-review` 15-finding cap at `--effort=high` on threat-model surfaces?** C.3's matcher + autonomy gate is exactly such a surface. The C.2 medium review returned 10 (under cap) but a high-effort pass on the gate could exceed it.

If the user hasn't answered, ASK before the C-13 review step at minimum. The first 4 tasks can proceed regardless.

---

## Read these FIRST (in order)

1. **`CLAUDE.md`** — repo conventions. Rule 1 (load `ntdst-execute-with-tests` before plan execution); rule 2 (threat-modeling for plans touching auth/untrusted-parsing/multi-tenancy — C.3's matcher touches the trigger-event surface, but the threat model is ALREADY extended in the plan with mitigations 49–52, so no new threat-model pass is needed — verify against the named mitigations).

2. **`memory/STATE.md`** top section — confirms C.2 shipped + code-review-closed (851 pass), C.3 is next. The locked decisions still in force: the **V1 autonomy gate** (build the substrate, gate the exposure) and the **build-decision** (hand-roll on `provider.stream()`).

3. **`docs/superpowers/retros/2026-05-29-phase-3-sub-phase-C.2-retro.md`** — the C.2 retro. The headline lesson C.3 MUST apply: **ground-truth the dependency surface before expanding/dispatching** (a non-existent provider API shipped 3 DIVERGED_DEFECT tasks in C.2). The C.3 expansion already applied this (caught the phantom `trigger-matcher.ts`), but each subagent dispatch must re-verify its task's specific call sites.

4. **`memory/lessons.md`** — the 2026-05-29 entry (ground-truth the dependency surface) + the sibling-site audit rule (5 lockstep classes).

5. **`~/.claude/.../testing-workflow/lessons.md`** — the 2026-05-29 entry: **re-run timing/ordering/concurrency-sensitive test files ≥3× before GREEN.** C.3's poller (fake timers, concurrency cap) and the approval/rejection race path are exactly this class. The same-ms cancel boundary bug in C.2 is why this rule exists.

6. **C.3 plan section** at plan lines **4257–4401**. The architecture decision block (lines ~4263–4280) is load-bearing — read it before C-10.

---

## Mandatory skill activation order

Each is a Skill tool invocation (loads content into the working set), not "I read the docs."

1. **`superpowers:using-superpowers`** — re-establishes "if a skill applies, invoke it." Auto-fires at session start; invoke explicitly on first turn.
2. **`netdust-core:ntdst-execute-with-tests`** — the Folio wrapper. Mandates `Skill("netdust-core:testing-workflow")` at every task close + the structured Test-evidence + STATUS blocks. Declare the wrapped upstream skill as **`superpowers:subagent-driven-development`** (see below).
3. **`superpowers:subagent-driven-development`** — C.3's five tasks are well-isolated (one new file each for C-10/C-11; small service edits for C-10a/C-12), each ~400–700 LOC of context, and the two-stage review (spec → quality) caught real bugs every task in C.1/C.2. Same rationale as C.2.
4. **`netdust-core:testing-workflow`** — invoked PER TASK by each subagent at close.
5. (controller, end-of-C.3) **`netdust-core:integration`** then **`/code-review --base=<C.2 close sha>`** then **`netdust-core:evaluate`**.

---

## The C.3 architecture in one paragraph (so you don't re-derive it)

There is **no trigger-matcher yet** — C.3 builds it. The 4 builtin triggers (`lib/builtin-triggers.ts`) are defined as documents but nothing consumes their events. The matcher is **INLINE-IN-TX**: invoked synchronously inside the emitting write's transaction (the comment-insert tx for mention/approval/rejection; the assignee-PATCH tx for assignment), NOT a detached bus subscriber (the event bus is workspace-scoped + swallows handler errors → would silently drop triggers). This is what threat-model mitigation 43 already mandated for the approval/rejection race. Because `createRun` owns its own tx today, **C-10a** first adds an optional `tx?` so the matcher creates the run row atomically with the originating write. The matcher (**C-10**) reads enabled triggers, matches `on_event` + `event_filter`, enforces allow-list (mit 50) + idempotency (mit 52) + the **autonomy gate** (mit 51), then `createRun(args, tx)` at `planning`. The **poller** (C-11) claims `planning` rows ~1s later and dispatches `runAgent`/`runAgentResume`. **C-12** wires the matcher call into the emit sites. **C-13** is the integration gate + the first "agent does work" smoke.

---

## Per-task dispatch checklist (apply to each)

### Before dispatch (controller)
- [ ] **Ground-truth the task's call sites** (the C.2 lesson). For each task, the subagent prompt must name the REAL signatures it builds on — verify they still exist:
  - C-10a: `createRun(args)` + `CreateRunArgs` + `txWithEvents` in `services/agent-runs.ts`; the `DBOrTx` shape.
  - C-10: `eventBus` (`lib/event-bus.ts`), the 4 builtin trigger frontmatter shapes (`lib/builtin-triggers.ts`), `getActiveRun(args, tx?)` (gained `excludeRunId` in C-9), `nextChainId({firedBy})`, `createRun(args, tx?)` (from C-10a), `env` (`src/env.ts`), `KNOWN_EVENT_KINDS` (`packages/shared`).
  - C-11: `claimNextPlanningRun`, `recoverOrphanRuns`, `countPendingPlanning` (C.1), `runAgent`/`runAgentResume` (C-8/C-9), the reconciler boot pattern in `src/index.ts`.
  - C-12: the emit sites — `services/comments.ts` (~426, ~567), `services/documents.ts` (~540, ~780), `routes/documents.ts` (~347). Confirm each is inside a tx.
- [ ] **Sibling-site audit (5 lockstep classes):** C.3's only shared-package touch is adding `agent.chain.suppressed` to `KNOWN_EVENT_KINDS` (C-10 Step 1) + the server `EventKind` union — keep them in lockstep. All `error_reason`/event-kind literals from their schema enum. Workspace-wide events `projectId: null`.
- [ ] **Mitigations to verify after close** (name them in the dispatch prompt): C-10a→49; C-10→49,50,51,52; C-11→36,37,38; C-12→49,43.

### Dispatch prompt
Use the C.2 prompt template (the C.2 readiness handoff has it verbatim): point the subagent at the plan task body by line number, tell it to ground-truth before coding, paste the `ntdst-execute-with-tests` addendum verbatim, and for the poller (C-11) + race-path (C-12) tasks **add the timing-test rule: re-run the new test file ≥3× before reporting GREEN** (per the testing-workflow 2026-05-29 lesson).

### After the subagent reports (controller)
- [ ] Re-run the test command yourself (`[[verify-subagent-test-counts]]` — C.1 had 3 misreports).
- [ ] For C-11 + C-12: re-run the timing/race test file ≥3× to confirm determinism (the C.2 same-ms flake passed single-run review by luck).
- [ ] Verify the `## Test evidence` + `## STATUS` blocks are present + `Skill("netdust-core:testing-workflow")` was invoked.
- [ ] Two-stage review (spec → quality) per task. If `DONE_WITH_CONCERNS`, read concerns before the next task.

---

## Watch-outs specific to C.3

1. **The autonomy gate (C-10, mitigation 51) is the most consequential code in C.3.** `FOLIO_AGENT_CHAINS_ENABLED` default **false**; agent-originated trigger → ZERO rows + ONE `agent.chain.suppressed`; human-originated → fires. The boundary test (flag OFF agent-mention → 0 rows + suppressed; human-mention → 1 row; flag ON agent-mention → 1 row) is the V1↔autonomous pin. Don't conflate the gate (cross-run fan-out) with the six runner guards (per-run resource caps) — orthogonal.

2. **In-tx, not fire-and-forget (mitigation 49).** The matcher MUST let its errors propagate (rolling back the originating write) — the OPPOSITE of `eventBus.publish` which swallows. A `createRun` failure inside the matcher must roll back the comment/assignment. Document the distinction; don't copy the bus's swallow pattern.

3. **`createRun` nesting.** Without C-10a's `tx?`, calling `createRun` from inside a tx nests `db.transaction` (createRun opens its own `txWithEvents(db,...)`). C-10a is the prerequisite — do it FIRST, in order.

4. **System-actor (C.2-R-3, resolved in C-10a).** Trigger-created runs are owned by the **originating human** (`actor.id` → `created_by`). There is no `system:` user (the `documents.updated_by`/`created_by` FK → `users.id` rejects free-form strings — this bit C-8). The runner's `transitionActor` already uses `run.createdBy`, so it inherits the FK-valid owner.

5. **Poller fake-timers + mock hygiene (C-11).** Prefer injecting `runAgent`/`runAgentResume` over `mock.module` (`[[mock-module-leaks-across-bun-tests]]`). Reset any module-global between tests. The poller dispatches `runAgentResume` when the claimed row has `frontmatter.resume_of`, else `runAgent`.

6. **`bun test` from repo root is FORBIDDEN** (mixes Vitest into Bun → false fails). Always `cd apps/server && bun test`.

7. **Don't double-fire (C-12).** A single comment-create can emit both `comment.created` and `comment.mentioned`. The matcher's idempotency guard (mit 52, `getActiveRun`) backstops a duplicate run, but avoid invoking the matcher twice for the same logical event at the source.

---

## Carried obligations beyond C.3 (Sub-phase D — do NOT try to do in C.3)

- **C.2-R-1 (mitigation 27):** the real per-tool agent-lifecycle guards (allow-list widening on create/update, self-delete rejection, token-anchored resolution) land in **D-3** when the real `TOOLS` move into `lib/agent-tools.ts`. C-7's dispatcher is transport+scope+Zod only. The D-3 task body + threat model MUST carry mitigation 27 explicitly.
- **C.2-R-2 (tool-error feedback):** redesign so a tool error feeds back to the model (self-correct) vs. terminating the run — **D-3+**, when real errorable tools exist. Needs a plan-correction + retry-loop guard + re-review. C.2 keeps terminal-on-tool-error (locked spec).
- **Pre-existing `transitionRun` null-materialization** (`error_reason`/`error_detail`/`worker_started_at` `?? null` fail a strict frontmatter parse) — cleanup before the markdown-export wedge needs strict read-time validation. Noted in `tasks/retro-follow-ups.md`.

---

## First-turn checklist for the next session

1. **Skill: `superpowers:using-superpowers`** (invoke explicitly).
2. **Read** `CLAUDE.md` + `memory/STATE.md` (next-up) + the C.2 retro + this handoff.
3. **Surface the 2 HUMAN_DECISION items** to the user if unanswered (plan-freshness rule; /code-review cap) — they gate the C-13 review step.
4. **Skill: `netdust-core:ntdst-execute-with-tests`**, wrapped upstream = `superpowers:subagent-driven-development`.
5. **Read** the C.3 plan section (lines 4257–4401), especially the architecture-decision block.
6. **Dispatch C-10a FIRST** (the `createRun` tx prerequisite) — ground-truth `createRun` + `CreateRunArgs`, paste the addendum.
7. **Verify** per the post-dispatch checklist; two-stage review.
8. **Then C-10 → C-11 → C-12 in order** (sequential; C-10 needs C-10a's tx, C-12 needs C-10's matcher). Add the ≥3× timing-test rule to C-11 + C-12 dispatches.
9. **C-13** controller gate: `/integration` → `/code-review --base=<C.2 close sha, e.g. 2a2dca2> --effort=medium` (name mitigations 43, 49, 50, 51, 52 + 36/37/38) → sibling-site audit → `/evaluate`.
10. After C.3 closes: **Sub-phase D** (routes + MCP parity + real tools in D-3 → mitigation 27 + tool-error-feedback land there).

If any step gets stuck, STOP and reach for the user. Don't improvise around the discipline.
