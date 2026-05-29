# Retro — phase-3 Sub-phase C.2

**Date:** 2026-05-29
**Commit range:** `3a4f56b..HEAD` (C.2 implementation scope: `2825181..2a2dca2`)
**Total commits (range):** 24 (12 substantive phase-3, 8 memory/STATE auto-captures, + the prior session's C.1-retro/expansion/handoff close-out commits at the head of the range)
**C.2 dev commits:** 3 implementation + 5 review-fix + 4 plan-correction/follow-up = 12
**Active dev time:** ~2h29m in one continuous session (`2825181` 23:58 → `2a2dca2` 02:27, no gap >90min). A separate pure-doc STATE tick (`6c7ebd4`) landed 08:46 next morning — excluded.

## Timing

| Session | Span | Commits | Avg gap | Dominant work |
|---|---|---|---|---|
| 1 (C.2 build) | 23:58 → 02:27 (~149 min) | 12 phase-3 + interspersed memory | ~12 min | C-7 → C-8 → C-9 each (impl + 2-stage review + fix + plan-correction), then `/code-review` fix-loop |
| 2 (doc) | 08:46 (single commit) | 1 | — | STATE tick only (not C.2 dev) |

**Per-commit (C.2 code commits, impl+fix):** smallest `481f8e8` (+90/-8), largest `ac6d3c7` (+1396, the C-8 landing). Implementation commits are large-but-paired (every one ships its test file in the same commit). Avg inter-commit gap ~12 min — tight, no stalls.

**Cleanup ratio: 62.5%** (5 review-fix / 8 implementer-side commits; plan-corrections excluded per spec). **Above the 40% threshold** — see Harness gap #1 for the nuanced read (it is NOT five missed bugs per task; it is one fix per task from the mandated two-stage review + a deliberate `/code-review` pass that caught a class the per-task reviews structurally couldn't).

**First-commit cold-start tax:** ~6 min (prior session's handoff close `340522f` 23:52 → first C.2 code `2825181` 23:58). Negligible — the readiness handoff did its job; the controller dispatched C-7 almost immediately.

## Plan vs. shipped

| Task | Plan vs shipped | Notes |
|---|---|---|
| C-7 (`agent-tools.ts` executeTool) | DIVERGED_DEFECT | Plan Step 5 specified a self-vs-peer lifecycle gate that contradicts the live per-tool guards in `routes/mcp.ts`. Gate removed (`dd9f736`), mitigation 27 re-scoped to D-3 (`79df93d`). Also: `token.agentSlug` doesn't exist (used `actor`); `Scope` type doesn't exist (plain `string`); `DBOrTx` not exported. All caught in controller pre-flight before dispatch. |
| C-8 (`runner.ts` runAgent) | DIVERGED_DEFECT | Plan assumed a Vercel-AI-SDK-shaped provider with `continueWithToolResult` + injectable `AbortController` — **neither exists**. Corrected to an outer round-loop over `provider.stream()` with message-history tool round-trip (`73a6ea4` + `ac6d3c7`). Plus 4 forced reconciliations: error_reason enum has no `mcp_invalid_args`/`mcp_tool_error`/`cancel_via_comment`/`chain_guard` (mapped to real members); `actor:'system:runner'` violates the `updated_by` FK (used `run.createdBy`); no `kind=cancel` comment kind (used `rejection`); `createComment` can't carry custom frontmatter; `transitionRun` sanitizes `errorDetail`. Review-fix `1716846` added the pure-text cancel path. |
| C-9 (`runner.ts` runAgentResume + rejectRun) | DIVERGED_DEFECT | Plan Step-1 signature (`runAgentLoop(runId, messages, abortController, tx?)`) stale — C-8 already factored `runLoop(ctx)`; reconciled to inject `messages` (`33a3b7b` + `4bda465`). `rejectRun` catches BOTH `RUN_TRANSITION_RACED` and `INVALID_RUN_TRANSITION` (running→rejected is an invalid transition → state-machine guard fires, not the WHERE race). Review-fix `c06f654` excluded the resume lineage row from the idempotency preflight. |

**All three tasks DIVERGED_DEFECT — but every defect was a plan-vs-reality drift caught at controller pre-flight or two-stage review and corrected in the plan BEFORE/at dispatch, not a silent ship.** The plan was an outline expanded 2026-05-28; it predated a ground-truth read of the Sub-phase B provider layer + the C.1 service signatures. This is the same drift class the C.1 retro flagged ("plan written before peer files were read"). The pre-flight audit + per-task plan-correction is the discipline that contained it — 3 plan-corrections landed inline before/at dispatch, plus the `/code-review` follow-up commit.

## Discipline compliance

| Commit | Test delta in msg | Migration+journal | Test:code ratio | DONE_WITH_CONCERNS |
|---|---|---|---|---|
| `2825181` C-7 | implied (821) | N/A (no .sql) | 1:1 | no |
| `dd9f736` C-7 fix | yes (819) | N/A | 1:1 | no |
| `ac6d3c7` C-8 | yes (835) | N/A | 1:1 | **yes** (4 divergences flagged honestly) |
| `1716846` C-8 fix | yes (835) | N/A | 1:1 | no |
| `4bda465` C-9 | yes (842) | N/A | 1:1 | no (1 divergence noted) |
| `c06f654` C-9 fix | yes (844) | N/A | 1:1 | no |
| `1486296` review-fix | yes (849) | N/A | 1:2 | no |
| `481f8e8` review-fix-2 | yes (851) | N/A | 1:1 | no |

**Test:code pairing: 8/8 commits ship a test file with their code.** No code-touching commit lacked tests. No migrations in C.2 (journal-pairing N/A). Test count monotonic: 810 → 851 (+41), no regressions or stagnation. C-8's `DONE_WITH_CONCERNS` with 4 documented divergences is the discipline working as designed — the implementer flagged rather than silently resolving.

**Reviewer-fix chaining:** every fix commit names its primary task (`C-7 review-fix`, `C-8 review-fix`, `C-9 review-fix`) or its review pass (`C.2 review-fix`). Clean audit chain. The `/code-review` fix-loop (`1486296` → re-review caught regression → `481f8e8`) is the strongest single signal this sub-phase: the two-stage per-task review passed all three tasks, yet a deliberate diff-wide `/code-review` found a **non-deterministic suite-breaking bug** (same-ms cancel boundary) that the per-task reviews had passed by timing luck — and the FIRST fix introduced a CRITICAL `done_reason:null` regression that the fix's own re-review caught.

## Harness gaps identified

1. **Cleanup ratio 62.5% (> 40% threshold).** Five review-fix commits across three tasks + one diff-wide review. **Disposition: MONITOR.** The ratio is inflated by the discipline working, not failing: the mandated two-stage review produced exactly one fix per task (the design intent), and the `/code-review` pass is a SEPARATE deliberate gate that caught a class the per-task reviews structurally can't see (cross-cutting, timing-dependent). Counting all of those as "cleanup" conflates caught-by-design with slipped-past-gates. The real slip-rate (bugs that reached the diff-wide review despite two-stage per-task review) is meaningful but small (1 suite-breaking + a handful of plausible silent-success holes). Re-evaluate at C.3 — if the ratio stays >50% with a clean per-task review, the per-task review depth needs attention.

2. **Plan predated a ground-truth read of its dependency surface (provider layer + C.1 service signatures), producing 3 DIVERGED_DEFECT tasks.** Same root cause as the C.1 retro's plan-freshness finding. The C.2 plan was expanded 2026-05-28 as an outline; the controller's pre-flight read of `provider.ts`/`agent-runs.ts`/`comments.ts` at dispatch time caught every drift, but only because the controller did the read manually. **Disposition: HUMAN_DECISION** (already an open item — the "plan-freshness check as a `writing-plans` skill rule" follow-up from the A and C.1 retros). C.2 is the third sub-phase to surface it. Re-flagged in `tasks/retro-follow-ups.md`.

3. **A suite-breaking, non-deterministic bug passed two-stage per-task review AND controller verification, caught only by the diff-wide `/code-review`.** The same-ms cancel boundary (`gt` vs `gte`) failed ~1/25 runs; the two-stage review on C-8 and my own verification runs passed by scheduling luck. **Disposition: SHOULD_FIX** (lightweight): the per-task verification should run the new/changed test file 3× (not 1×) when the task touches timing/ordering/concurrency, to surface non-determinism before the diff-wide review. The C-8 review-fix and the `/code-review` fix both already adopted a 5× determinism check after the fact — promoting "Nx re-run on timing-sensitive tests" into the testing-workflow close-out checklist would catch this at the per-task gate.

4. **`testing-workflow` Skill-invocation auditability.** Whether each subagent invoked `Skill("netdust-core:testing-workflow")` lives in transcripts, not commits — unverifiable from git alone. The wrapper's structured Test-evidence + STATUS blocks WERE present in every subagent report this sub-phase (the controller verified them inline), which is the audit anchor the wrapper intends. **Disposition: MONITOR** — discipline held via the structured-report requirement; the literal Skill-invocation question is the existing HUMAN_DECISION follow-up (#10 in the file), not re-litigated here.

## Recommendations

1. **Action:** Add a "re-run timing/ordering/concurrency-sensitive test files Nx (≥3) before reporting GREEN" item to the `netdust-core:testing-workflow` close-out checklist. **Why:** A non-deterministic suite-breaking bug (same-ms cancel boundary) passed single-run per-task review + controller verification and was caught only by the diff-wide `/code-review` — by luck, since it failed ~1/25. The fix-side already adopted 5× determinism checks reactively; making it a proactive close-out gate for timing-touching tasks catches the class at the cheapest point. **Cost:** ~seconds per timing-sensitive task; near-zero for tasks that don't touch time/ordering/concurrency (the checklist item is conditional on the task touching those surfaces — C-8/C-9's cancel + race code did).

## Follow-ups for human review

(Both re-flagged from prior retros — C.2 is additional evidence, not a new ask. Written to `tasks/retro-follow-ups.md`.)

1. **Plan-freshness check as a `superpowers:writing-plans` skill rule.** C.2 is the THIRD sub-phase (after A and C.1) where plan-vs-reality drift produced DIVERGED_DEFECT tasks — here, an entire assumed provider API (`continueWithToolResult`/`AbortController`) that didn't exist. A pre-dispatch "if plan mtime > N days, controller re-reads the plan's named dependency surface against live source before dispatching each task" rule would make the manual pre-flight a hard gate. **Decision:** YES → cross-project `writing-plans` skill addition. NO → keep as project-local controller discipline. (surfaced by `docs/superpowers/retros/2026-05-29-phase-3-sub-phase-C.2-retro.md`)

2. **Raise `/code-review` 15-finding cap for threat-modeling-predicate surfaces at `--effort=high`.** C.2's medium-effort review returned 10 (under cap), so the cap didn't bind THIS round — but the runner is exactly the threat-model-predicate surface the prior retros worried about, and a high-effort pass would have. Still open from the B + C.1 retros. **Decision:** YES → cap=30 when `--effort=high` + threat-model predicate matches. NO → accept multi-round trickle. (surfaced by `docs/superpowers/retros/2026-05-29-phase-3-sub-phase-C.2-retro.md`)

## Memory updates

- `+10 lines` to `~/.claude/plugins/cache/netdust-plugins/netdust-core/0.1.0/skills/testing-workflow/lessons.md` (timing-sensitive-tests Nx-rerun gap — SHOULD_FIX, Recommendation #1)
- `+9 lines` to `memory/lessons.md` (project-local: plan-vs-provider-interface drift — assumed Vercel-SDK shape; always ground-truth the dependency surface before expanding a runner/integration plan)
- Note: the two HUMAN_DECISION follow-ups are appended to `tasks/retro-follow-ups.md` (Step 10), not duplicated into auto-memory.
