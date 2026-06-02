# Retro — Phase C (cross-workspace triggers)

**Date:** 2026-06-02
**Commit range:** `4e06b1f..07b002a` (Phase C scope; the marker `84a4d4a` was Phase B's last commit, so the range is filtered to Phase C impl, excluding the Phase B retro `6d09ceb` and the trailing Phase D commits `bd1e631`/`d36cb6f` that a parallel session began)
**Total commits (Phase C impl + meta):** 19 (1 plan-correction + 6 primary + 3 per-task review-followups + 4 /code-review fixes + 2 shake-out fixes + 4 doc/residual records; the 6 interleaved `memory(folio)` auto-commits are excluded from classification)
**Active dev time:** ~2.95 hours across 1 continuous session (16:50→19:47; largest inter-commit gap 32 min = `/code-review high` running its 7 finder angles + verifiers — no >90 min break)

## Timing

| Session | Span | Commits | Dominant work |
|---|---|---|---|
| 1 (16:50–19:47) | 2h57m wall / ~2.95h active | 19 | Build (C1–T4) → real-key harness → /code-review high (3 fixes) → /shakeout (cc hard-disable) → close-out |

Phasing within the session:
- **16:50–17:54 (~1h):** plan-correction + the 5 build tasks (C1·C2·C4-6·C3·T4) + their per-task review follow-ups. Tight RED→GREEN cadence, two-stage review per task.
- **18:17–18:20:** the real-key trigger-fired shake-out harness + its first assertion fix.
- **18:20–19:05 (~45m, incl. the 32-min /code-review run):** `/code-review high` → 3 fixes (the executeTool-floor altitude fix, the harness false-PASS fix, the stranded-approval fix) + a review nit.
- **19:32–19:47:** `/shakeout` → 2 CRITICALs found → cc hard-disable + manifest + close-out docs.

Per-commit stats (impl commits): min 1 file/1 line (`4897d07` dead-import removal), max 8 files/216 lines (`e99ff7c` C3 — the convergence-point threading touched schema+createRun+agent-tools+runner+folio-api), typical 1–4 files. The largest single commit (`60017a1`, 620 lines) is the diagnostic harness (a script, not product code).

**Cleanup ratio: 60%** (9 cleanup commits / 15 implementer commits; plan-correction `4e06b1f` and the 4 doc-only commits excluded per spec). ABOVE the 40% flag threshold — but see Harness gap #4 for why the raw number overstates implementer error: most "cleanups" were review-driven test-strengthening or a deliberate product decision, not defect-fixing.

**First-commit cold-start tax:** ~0 min — the first commit (`4e06b1f`, the plan-correction) landed at 16:50, immediately after the controller's Step-2.5 ground-truthing surfaced the C1 drift. No warm-up overhead; the prior session's context (Phase B just closed) carried over.

## Plan vs. shipped

| Task | Plan vs shipped | Notes |
|---|---|---|
| (pre-dispatch) C1 premise | **DIVERGED_DEFECT** | Plan resolved triggers by `target_agent_id`; ground-truth found triggers carry `fm.agent` (a slug), `target_agent_id` is comment-only. Corrected at Step 2.5 → `4e06b1f` BEFORE any code. The headline plan defect. |
| C1 (Task 1) | MATCHED (post-correction) | `28106d3` resolved via `resolveAgentForRun` at 3 sites per the corrected plan; `b41192d` added the id-handle home-assertion test (review-driven, a security boundary the plan's tests skipped). |
| C2 (Task 2) | MATCHED | `eee5468` skips the allow-list for library agents exactly as planned; `ceae68f` hardened the local-gate test to exercise the real discriminator (review-driven). |
| C4/C5/C6 (Task 3) | **DIVERGED_DEFECT** | `3bb9e30`. The plan's verbatim C6 snippet `if (isLibraryAgent)` placed before the autonomy gate would have swallowed the C4 `agent.chain.suppressed` signal for agent-originated library hops (an `agent:` actor never resolves to a human). The implementer correctly shipped `if (isLibraryAgent && !isAgentOriginated(event))`. A cross-mitigation interaction the plan's snippet missed. |
| C3 (Task 3.5) | MATCHED | `e99ff7c`. The plan's PC-2 self-correction (schema-first ordering, the executeTool threading) was accurate; shipped clean across all 5 files. |
| T4 (web picker) | MATCHED | `1e51098`; `4897d07` dropped a dead import (review nit). |
| Task 5 (harness) | DIVERGED_SCOPE | `60017a1` — the plan named a `target_agent_id`-wired trigger; reality uses the builtin-on-assignment trigger + `fm.agent`. Harness built against reality. Also: the plan's Task 5 was "verification-only"; in practice the controller had to WRITE a Phase C harness (the Phase B one only covered direct invocation). |

For each DIVERGED_DEFECT — the plan corrections already landed inline DURING execution (the C1 callouts are in the plan at 12 spots; the Task-3 divergence is documented in the commit + STATE.md). See Step 8: no NEW post-hoc plan corrections are needed — both defects were corrected in-flight, like Phase B.

## Discipline compliance

| Commit | Test delta in msg | Migration+journal | Test:code ratio | DONE_WITH_CONCERNS / divergence flagged |
|---|---|---|---|---|
| 28106d3 (C1) | implied (suite count in STATE) | n/a (no SQL) | 1:1 | divergence flagged (site-3 widening) |
| b41192d (C1 test) | y | n/a | test-only | — |
| eee5468 (C2) | y | n/a | 1:1 | — |
| ceae68f (C2 test) | y | n/a | test-only | — |
| 3bb9e30 (C4/5/6) | y | n/a | 1:1 | **YES — the `!isAgentOriginated` divergence explicitly flagged** |
| e99ff7c (C3) | y | n/a | 3:5 | — |
| 1e51098 (T4) | y | n/a | 2:2 | — |
| 60017a1 (harness) | n/a (script) | n/a | n/a | — |
| 49309c7 (cr-fix#1) | y | n/a | 2:2 | divergence flagged (runner.ts fatal-pattern broadening) |
| 2ef0414 (cr-fix#2) | n/a (script) | n/a | n/a | logic-walkthrough provided |
| 78b8feb (cr-fix#3) | y | n/a | 1:1 | — |
| a5d0966 (shakeout) | y | n/a | 2:2 | divergence flagged (TS no-overlap simplification + 6 cc tests updated) |

**No migration in the entire phase** (Phase C is all frontmatter/JSON + web — invariant 10 respected; the `unattended` field rides the frontmatter column). **Every code-touching commit carries test files** (no zero-test code commits). **Cleanup-commit chaining:** all 4 `/code-review` fixes + the 3 per-task follow-ups reference their primary task/finding number in the message; the 2 shake-out fixes reference S-1/S-2 + the manifest. Chaining is clean.

## Harness gaps identified

1. **The plan's headline C1 premise was wrong (built against an un-ground-truthed schema assumption).** The plan resolved triggers by `target_agent_id` and built an entire threat-attack (slug-shadow via id-round-trip) around it — but triggers carry `fm.agent`; `target_agent_id` is comment-only. This is a **`writing-plans` / `threat-modeling` gap**: the plan asserted a data-model fact without verifying it against the live schema. The harness *caught it* (the `ntdst-execute-with-tests` Step-2.5 ground-truth gate fired before dispatch), so nothing shipped wrong — but the plan-writing produced the defect. **Disposition: MONITOR.** The Step-2.5 gate is doing exactly its job (this is the 4th consecutive sub-phase it has caught plan-vs-source drift — A, C.2, C.3, now Phase C); the gap is in plan-writing, and the existing catch is sufficient. The project lesson `[[feedback_plan-server-source-audit]]` already names this. Re-evaluate if a future plan defect slips PAST Step 2.5.

2. **The threat model did not name the claude-code-path floor bypass; it claimed a "deterministic bound" that held only on the API path.** The C3 threat-model section asserted "the injection bound is DETERMINISTIC (HIGH+MEDIUM floor + caller ceiling)" without qualifying that the floor lives in the API-path `executeTool` threading and the cc provider re-enters via `/mcp` unfloored. Found at `/code-review` (C3-CC-1) then escalated at `/shakeout` (S-1/S-2: ALSO a caller-scope-ceiling collapse). **Disposition: MONITOR.** The threat-modeling skill produced a strong section (C1–C6, all held on the path it covered); the gap is "a per-provider execution fork wasn't enumerated as an attack surface." The downstream gates (code-review + shake-out) caught it, and the resolution (hard-disable cc) closes it by construction. The lesson belongs to the cc-runner story, not the threat-modeling skill broadly. Re-evaluate if a future plan's threat model again misses a provider/execution fork.

3. **The plan's Task-3 verbatim code snippet carried a cross-mitigation interaction bug.** The `if (isLibraryAgent)` C6 guard, as literally written, would have swallowed the C4 suppression signal. The implementer caught it. **Disposition: MONITOR.** This is the known tension in `writing-plans` between "give the implementer a concrete snippet" and "a too-literal snippet can bake in a bug." The implementer's TDD + the two-stage review caught it (the C4 suppression test would have failed). Acting on this would mean "plans should give intent not snippets," which is a larger philosophy call with tradeoffs — not worth a unilateral skill change on one instance.

4. **Cleanup ratio 60% — above the 40% flag — but the raw number overstates implementer error.** Of the 9 cleanup commits: 3 are per-task *review-driven test-strengthening* (a security-boundary test, a discriminator-hardening, a dead-import removal — quality additions, not defect fixes); 1 shake-out fix (`56a99f1`) was a *harness assertion bug* (diagnostic script, not product); 1 (`a5d0966`) was a *deliberate product decision* (hard-disable cc), not a defect. Only ~4 (the genuine `/code-review` findings) are true "a bug slipped past the per-task gate" cleanups — a real ratio of ~4/15 ≈ **27%**, BELOW the threshold. **Disposition: MONITOR.** The metric's denominator/numerator definitions don't distinguish "review-strengthening" from "defect-fix," inflating the apparent rate on a phase that did heavy quality work. Re-evaluate the metric's definition if it mis-flags again — but one phase isn't enough signal to re-spec the cleanup-ratio formula.

5. **`Skill("netdust-core:testing-workflow")` invocation not verifiable from git.** The subagents' transcripts (not commits) hold the invocation; the commit messages show RED→GREEN evidence + test-count deltas, which is the *outcome* the gate exists to produce. **Disposition: MONITOR** (unable to verify from git alone, per the command spec; the structured addendum + the subagent-stop hook are the backstops, and the RED/GREEN evidence in commits indicates discipline held).

## Recommendations

No SHOULD_FIX gaps this phase. Every gap above is MONITOR — the harness's downstream gates (Step-2.5 ground-truth, two-stage review, `/code-review`, `/shakeout`) caught every defect before it reached the final artifact, and the plan corrections landed in-flight. The discipline held; the gaps are in upstream plan/threat-model *authoring*, which the gates already compensate for, and one instance is insufficient to re-spec a skill.

## Follow-ups for human review

No human-decision items this sub-phase. (The one decision that arose during execution — how to dispose of the cc-path CRITICALs — was made live by Stefan: hard-disable claude-code. It is recorded as the `CC-DISABLED-1` revival gate in `tasks/retro-follow-ups.md`, not as a new follow-up here.)

## Memory updates

- `+6 lines` to `~/.claude/plugins/cache/netdust-plugins/netdust-core/0.1.0/skills/threat-modeling/lessons.md` (new: enumerate per-provider / per-execution-fork attack surfaces — a "deterministic bound" claim must name WHICH execution path enforces it; the cc-path fork went unmodeled in Phase C and surfaced 2 CRITICALs at shake-out).
- `+8 lines` to `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_retro_phase-C.md` (new auto-memory: Phase C process record — 2.95h, cc hard-disable, the in-flight plan corrections, the cleanup-ratio nuance).

(No project `memory/lessons.md` entry — the C1 plan-vs-source lesson is already captured by `[[feedback_plan-server-source-audit]]`; duplicating it would violate the don't-write-the-same-finding-twice rule.)
