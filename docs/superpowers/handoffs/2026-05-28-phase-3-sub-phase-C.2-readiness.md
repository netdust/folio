# Sub-phase C.2 — Readiness Handoff

**Branch**: `phase-3/agent-runner`
**HEAD at handoff**: `6741563`
**Plan**: `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md`
**C.2 expanded bodies**: plan lines 3818–4226 (do NOT use the historical outlines below line 4228)
**Test baseline at handoff**: server **810 pass / 1 skip / 0 fail** · web 559/8/0 · shared 51/0
**Last `/integration` marker**: `666635a` (advance to HEAD on first C.2 task close)
**Last `/evaluate` marker**: `3a4f56b` (workspace, gitignored)

This handoff exists to make the next session's first action **unambiguous**. C.2 ships the in-process tool dispatcher (`lib/agent-tools.ts`) + the runner loop (`lib/runner.ts`). Three tasks: C-7, C-8, C-9. Sequential.

---

## Read these FIRST (in order)

Each one is ~5 minutes. Skipping any of them costs hours.

1. **`CLAUDE.md`** — repo conventions. Specifically rule 1 ("load `ntdst-execute-with-tests` skill before plan execution") + the section on threat-modeling for plans that touch auth / untrusted parsing / outbound URLs. C.2 touches auth + untrusted parsing (tool args). The threat-model section is already in the plan; the skill activation is NOT optional.

2. **`memory/STATE.md`** — top section ("Next up"). Confirms C.2 plan-expansion is ✓ and lists what's still active for human decisions (plan-freshness check + `/code-review` cap raise are in `tasks/retro-follow-ups.md`).

3. **`tasks/retro-follow-ups.md`** — every item is open input to the next session's planning. Two items are HUMAN_DECISION (re-flagged from prior retros); the rest are RESOLVED markers showing what shipped this week.

4. **`memory/lessons.md`** — three 2026-05-28 entries land mid-C.1 retro and are immediately relevant:
   - **Sibling-site audit rule** (the rule the C.2 pre-flight implements).
   - **`tx.all<T>` runtime type lie** (every new `tx.all<>(sql\`...\`)` call audits for snake_case vs camelCase).
   - **Implementation:review ratio** (~1:1.5 to 1:2 in C.1; budget C.2 the same).

5. **`docs/superpowers/retros/2026-05-28-phase-3-sub-phase-C.1-retro.md`** — the meta-pattern finding (every primary fix has 1-2 sibling sites the freeform review caught). C.2 plan's pre-flight already encodes the audit; the retro is context for *why* it's encoded.

6. **C.2 plan section** at plan lines 3818–4226. This is the executable shape. **Do not read the historical outlines at lines 4228+ except for traceability** — they predate three 2026-05-28 reconciliation decisions and the C.1 retro's sibling-site rule.

---

## Mandatory skill activation order

Each skill activation is a Skill tool invocation, not just "I read the docs." The Skill tool is what loads the content into the current model's working set. If you don't invoke the skill, you don't have access to its rules — you only have access to a recollection of them.

### Step 1 — `superpowers:using-superpowers`

Auto-activates at session start via the system reminder; ALSO explicitly invoke on first turn. Reason: re-establishes the "if a skill applies, INVOKE IT, don't rationalize" rule. C.2 has at least 5 skill activations queued; the harness needs the discipline locked in before the first one fires.

### Step 2 — `netdust-core:ntdst-execute-with-tests`

This is the Folio-specific wrapper around the upstream execution skills. CLAUDE.md rule 1 says load it before any plan execution in this repo. The wrapper:

- Mandates a `Skill("netdust-core:testing-workflow")` invocation at every task close (this is the audit-trail anchor).
- Requires the structured `## Test evidence` + `## STATUS` blocks at the end of every subagent's report (verbatim format documented in the skill).
- Enforces the rule that the SUBAGENT is what completes the task, not the controller.

The wrapper takes one parameter: which upstream skill is being wrapped. For C.2, the answer is **`superpowers:subagent-driven-development`** (see Step 3) because each C.2 task is well-isolated and benefits from a fresh-context subagent per task.

### Step 3 — `superpowers:subagent-driven-development`

C-7, C-8, and C-9 each TOUCH a different file primarily (`lib/agent-tools.ts` for C-7; `lib/runner.ts` for both C-8 + C-9, but with C-9 refactoring C-8's loop into a helper, so order matters but they're separable). Subagent-driven keeps each task's context fresh + locks the implementer/reviewer two-stage discipline that caught real bugs in C.1 (the 3 `C-1 fixup` commits + the 2 quality follow-ups all came from the two-stage review pass).

Concrete reasons subagent-driven is the right choice for C.2 specifically:

- Each task body in the plan is large enough (~150 LOC of plan + ~300 LOC of implementation + ~250 LOC of tests = ~700 LOC of context per task) that running all three in the controller's context would burn ~25% of the budget on intermediate state.
- The two-stage review (spec compliance → code quality) per task caught 5 of the 31 C.1 review findings before the freeform code-review even ran. That's free defense against the "primary site fixed, sibling site missed" pattern the retro identified.
- The subagent's failure mode is "missing context" — but C.2's plan bodies are self-contained (Steps + Files + Tests + Commit are all inline), so missing context is rare.

Alternative: `superpowers:executing-plans` (solo execution in the controller). DO NOT use this for C.2 unless a subagent dispatch explicitly fails or hits a wall — the smaller-context discipline is what the plan was written to support.

### Step 4 — `netdust-core:testing-workflow` (invoked PER TASK, by the subagent, at close)

The subagent invokes this when it reports done. The wrapper's audit-trail requirement is what makes the invocation visible to the controller (and to the SubagentStop hook). Skipping the invocation = task not done, per the wrapper's `<addendum_for_dispatch>` rules.

### Step 5 (controller, end-of-C.2 only) — `netdust-core:integration`

Run after C-9 closes. Mirrors C.1's close-out: server + web + shared suites + per-workspace `tsc --noEmit`. Expected: server 810 → ~842.

---

## Per-task dispatch checklist (apply to C-7, C-8, C-9 each)

The C.2 plan's pre-flight invariants already encode most of this. The checklist below is what the CONTROLLER does before dispatching each subagent:

### Before dispatch

- [ ] **Sibling-site audit** (post-C.1 retro recommendation; pre-flight in the C.2 plan section). Scan the surface the task will touch for the 5 lockstep classes:
  1. **TS union/enum**: does any new exported type widen `apps/web/src/lib/api/*.ts` or `packages/shared/src/document-schema.ts`? C.2 should not — but C-7's `ToolDef` shape is shared between `agent-tools.ts` and `agent-tools.test.ts`; verify no FE consumer.
  2. **SQL JSON-extract↔column predicates**: C.2 doesn't add new queries against `documents.frontmatter.status`. But the runner reads `comments` for cancel-check — verify the comments service uses the indexed shape, not raw JSON.
  3. **Event scope (workspace-wide vs project-scoped)**: every `emitEvent` call in `lib/runner.ts`. C.1 R4 established the rule: workspace-wide events use `projectId: null`. C-8 emits `agent.run.<status>` — these are project-scoped (the run lives in a project). Verify any NEW event kinds introduced don't violate the rule.
  4. **Cross-route guards**: C.2 doesn't add HTTP routes (that's D). N/A.
  5. **Closed-enum literals**: every `error_reason` write must source from `runErrorReasonSchema.enum.X`. Same rule that R7 enforced in `recoverOrphanRuns`.

- [ ] **Pre-flight verification** from the C.2 plan section (lines 3833–3839): confirm the C.1 service surface exports + provider layer interface + agent-run-schema's `done_reason` + 12-value enum. One-time scan; valid for all three C.2 tasks.

- [ ] **Threat-model mitigations to verify after the task closes** (read these so the dispatch prompt names them):
  - C-7: 26, 27, 34, 35.
  - C-8: 25, 28, 30, 31, 40, 41, 44, 47.
  - C-9: 42, 43, 44.

### Dispatch prompt template

Copy this verbatim per task, fill in `<TASK>`:

```
You are implementing Phase 3 Sub-phase C.2 Task <TASK> per the plan at
docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md, expanded
section "Sub-phase C.2 — Runner + dispatcher (expanded task bodies —
written 2026-05-28)" starting at line 3818.

Find the task body for <TASK>:
- C-7: plan line 3844 ("Task C-7: lib/agent-tools.ts — executeTool
  shared tool-execution layer")
- C-8: plan line 4003 ("Task C-8: lib/runner.ts — runAgent core loop")
- C-9: plan line 4127 ("Task C-9: lib/runner.ts — runAgentResume +
  rejectRun")

Do NOT read the historical outlines below line 4228 — those predate
three reconciliation decisions documented in the expanded section
above. The expanded section IS the authoritative shape.

Implement strictly per the plan body's Steps, in order. Each Step's
test expectations are precise; do not skip ahead.

Pre-flight invariants (also in the plan section header, lines
3833–3839):
- cd apps/server before running tests
- Test runner: `bun test src/lib/<file>.test.ts` per-file, `bun test`
  full suite
- Typecheck: `bun x tsc --noEmit`
- Baseline at C.2 start: server 810 / 1-skip / 0-fail

Mitigations bound to this task:
- C-7: 26 (Zod re-validation), 27 (self-vs-peer agent-lifecycle gate),
  34 (NODE_ENV-gated __echo), 35 (tx-first signature).
- C-8: 25 (no wiki-link auto-expand), 28 (sanitize error_detail), 30
  (per-run + per-chain token-budget), 31 (provider circuit-breaker),
  40 (atomic single-UPDATE), 41 (terminal-status worker_started_at
  clear), 44 (cancel-via-comment), 47 (SSE fire-and-forget).
- C-9: 42 (SIGTERM v1.1 residual), 43 (approval+rejection race —
  loser no-op via RUN_TRANSITION_RACED catch), 44 (cancel-via-comment
  via the existing C-8 path).

(After implementing per the plan, copy the ntdst-execute-with-tests
addendum here verbatim — see Step 2 above.)
```

The addendum block from `netdust-core:ntdst-execute-with-tests` MUST be appended verbatim after the per-task prompt body. The wrapper skill prints it; copy from there.

### After the subagent reports

- [ ] Re-run the test command yourself per `[[verify-subagent-test-counts]]`. C.1 had 3+ misreports during sub-phase C — controllers must verify.
- [ ] Verify the subagent's report includes:
  - `## Test evidence` block (RED proof + GREEN proof + suite delta + typecheck)
  - `## STATUS` block (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED + COMMIT sha + FILES TOUCHED + DIVERGENCES FROM PLAN)
- [ ] Verify the commit message itself follows the plan's commit-template (e.g., C-7's commit shape: `phase-3: C-7 lib/agent-tools — executeTool shared dispatcher + self-vs-peer + Zod re-validation`).
- [ ] If `DONE_WITH_CONCERNS`, read the concerns BEFORE dispatching the next task — they may invalidate the next plan body.

---

## Things that bit C.1 + how C.2 should preempt them

Every entry below is documented in `memory/lessons.md` or the C.1 retro. They're listed here so the controller has a checklist of the highest-priority "watch out for this" items at C.2 start.

1. **Plan signatures with `tx` as first arg.** C.1 had 4 of these. Project convention is `(args, tx?)`. C.2 plan should already match, but DOUBLE-CHECK at each subagent's review stage. **Where to verify**: the plan body's signature samples for `executeTool(token, actor, name, args, tx?)` — `tx` is correctly last + optional.

2. **`tx.all<T>` with `RETURNING *` is a runtime type lie.** C.2 doesn't currently introduce new `tx.all<>` calls in agent-tools.ts. C-8's runner uses Drizzle's typed `.update().where().returning()` shape (via C.1's `transitionRun`). If a C-9 reviewer requests adding a raw-SQL fast path, the lesson from C.1 R6 applies.

3. **Cross-cutting changes need a sibling-site audit.** Already in the C.2 pre-flight. The 5 lockstep classes are listed above. Apply at task start, not at code-review time — the freeform code-review will catch what you missed, but at higher cost.

4. **`bun test` from repo root is FORBIDDEN.** This bit C.1 multiple times — mixes Vitest into Bun's runner → 440 false fails. ALWAYS `cd apps/server && bun test` or equivalent per-workspace.

5. **`mock.module` leaks across Bun tests.** From auto-memory `[[mock-module-leaks-across-bun-tests]]`. C-7's tests stub `__echo` in `NODE_ENV='test'`; verify the registry is reset between tests (the wrapper's `beforeEach`/`afterEach` shape). C-8's tests mock `provider.stream` via `provider.ts`'s `__INTERNAL_TEST_ONLY__.overrideRegistry` — verify reset between tests.

6. **PRAGMA busy_timeout is set.** C.1 R9 added `PRAGMA busy_timeout = 5000` to db client + test harness. C.2's race-prone code (`rejectRun` racing the approval-resume) relies on this being set. If a future db client refactor drops it, the C.2 race tests will flake.

7. **migration 0014's Z-suffix trigger.** C.1 R11 added a BEFORE INSERT / BEFORE UPDATE trigger that rejects non-Z timestamps in `agent_run.frontmatter.worker_started_at`. C-8's runner writes via `transitionRun` which uses Drizzle's `new Date().toISOString()` (always Z). If C-9's `rejectRun` ever writes worker_started_at directly via raw SQL, the trigger fires. C-9's body doesn't currently do this; verify at review.

---

## Decisions still HUMAN_DECISION (re-flagged from `tasks/retro-follow-ups.md`)

These don't block C.2 work but should be answered before C.3 planning starts. They've been in the file for two retros now and are starting to time-pressure C.3.

1. **Plan-freshness check as a `superpowers:writing-plans` skill addition?** YES → cross-project skill update. NO → keep as project-local memory. C.2's expanded section was written under the recommendation but never made it a hard skill rule. C-10..C-13 expansion would benefit from the rule being live before the next plan-correction commit.

2. **Raise `/code-review` 15-finding cap on threat-modeling-predicate surfaces?** YES → modify medium/high `/code-review` skill to cap=30 when `--effort=high` + threat-model predicate matches. NO → accept multi-round trickle. C.2 will hit `/code-review` in its close-out; the cap will matter again.

Both decisions live with Stefan. The retro re-flagged them at this session's close.

---

## Quick reference — what shipped in this session

For the next session's "what's been done lately" probe.

### C.1 services layer (C-1..C-6) — SHIPPED + DOUBLE-REVIEWED

| Task | Commit | Mitigations |
|---|---|---|
| C-1 | `07869cc` (+ 3 fixups + 1 quality) | 23, 28, 39, 40 |
| C-2 | `a8ad551` (+ `58fcd3b` quality) | 23, 24 |
| C-3 | `9e217ea` | 36, 37 |
| C-4 | `bc3aa67` | 29 (partial), 30 (helpers) |
| C-5 | `11f74a7` + migration 0013 | 45, 46, 47 |
| C-6 | `b4d84c1` | 23 inherited, 29 chain_id |

### Review-fix bundles (15 freeform-review findings)

| Bundle | Commit | Findings |
|---|---|---|
| 1 | `799238f` | F8 (ISO→ms-epoch), F12 (`tx.all<Document>` type), F6 (column predicate vs json_extract) |
| 2 | `3ff4d8c` | F2 (worker_started_at stamp on every →running), F1 (transitionRun TOCTOU race) |
| 3 | `cb5ab5e` | F4 (workspace.provider.* projectId:null), F5 (provider-relevant SQL filter), F7 (recoverOrphanRuns flush per (workspace, provider)), F11 (REFUTED → doc) |
| 4 | `e505ae7` | F3+F9+F10 (cross-route agent_run write guards) |
| 5 | `126a7b2` | F13 (REFUTED → doc), F14 (ensureRunsTable race), F15 (partial-index drift doc) |

### Review-of-review bundles (15 more findings)

| Bundle | Commit | Findings |
|---|---|---|
| 6 | `772b124` | R1 (FE/shared union widen), R2 (agent_run READ paths guard), R3 (countPendingPlanning predicate), R4 (F5 recency floor), R5+R6 (RUN_TRANSITION_RACED distinct code + observedFrom), R7 (recoverOrphanRuns enum hygiene), R8 (deterministic race test) |
| 7 | `2acbff2` | R9 (busy_timeout), R10 (migration drift guard), R11 (DB-level Z-suffix CHECK trigger), R13 (JS condition simplify) |
| 8 | `7807216` | STATE.md tick + meta-pattern doc |

### Plan/process work

| Commit | Content |
|---|---|
| `e148584` | Sub-phase C.1 retro |
| `bdf49d0` | C.2 plan expansion (this handoff is the wrapper for that expansion) |
| `6741563` | STATE.md tick post-expansion |

---

## Open at session boundary

- `.claude/.last-integration` = `666635a` (advance to HEAD when C-7 or C-9 closes).
- `.claude/.last-evaluate` = `3a4f56b` (advance to HEAD at the next /evaluate after C.2 closes).
- Untracked stray `apps/server/memory/STATE.md` exists (auto-memory artifact from a `cd apps/server && bun test` session). Safe to delete — auto-memory writes only to `memory/STATE.md` at repo root.
- Two HUMAN_DECISION items in `tasks/retro-follow-ups.md` are still open.

---

## First-turn checklist for the next session

In order:

1. **Skill: `superpowers:using-superpowers`** (auto-fires but invoke explicitly to lock the discipline).
2. **Read** `CLAUDE.md` + `memory/STATE.md` (the next-up section).
3. **Skill: `netdust-core:ntdst-execute-with-tests`** with the upstream choice declared as `superpowers:subagent-driven-development`.
4. **Read** the C.2 plan section at lines 3818–4226. Do NOT read the historical outlines below line 4228.
5. **Apply the per-task pre-flight checklist** to C-7 (this handoff's "Per-task dispatch checklist" section above).
6. **Dispatch C-7** using the prompt template above + the verbatim addendum from `ntdst-execute-with-tests`.
7. **Verify the subagent's report** per the post-dispatch checklist.
8. **Repeat for C-8 then C-9**, in order. C-9 depends on C-8's `runAgentLoop` refactor — don't dispatch them in parallel.
9. **Run `/integration`** after C-9 closes. Expected: server ~842 / 1-skip / 0-fail.
10. **Run `/code-review --base=<C.1 close sha> --effort=medium`** with the reviewer prompt naming the 13 bound mitigations (24, 25, 26, 27, 30, 31, 34, 35, 41, 42, 43, 44, 47).
11. **Run `/evaluate`** after the review fix-loop converges.
12. **Write the C.3 plan-correction commit** expanding C-10..C-13 — with the C-12 autonomy-gate critical reconciliation folded in.

If any step gets stuck, STOP and reach for the user. Don't improvise around the discipline.
