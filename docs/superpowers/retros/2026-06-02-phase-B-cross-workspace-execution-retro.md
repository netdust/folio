# Retro — Phase B (cross-workspace execution)

**Date:** 2026-06-02
**Commit range:** `74ad079^..84a4d4a` (Phase B implementation; excludes the 2 trailing auto-memory commits + the 2 `phase-C:` commits that started the next phase)
**Total commits:** 17 (9 primary implementer + 6 cleanup/review-fix + 1 plan-correction + 1 docs/invariant; auto-memory excluded)
**Active dev time:** ~2.05 hours, 1 continuous session (14:41 → 16:45, max inter-commit gap 16.8 min — no session break)

> Sub-phase id note: this plan is structured as TASKS (T1, T2, T2.5, T3–T8), not lettered sub-phases. Treated as one sub-phase ("Phase B") for this retro. `.last-evaluate` held a stale prior-session SHA (`4bcd4e3d`, not in this branch's recent line); scoped manually to the Phase B implementation range.

## Timing

| Session | Span | Commits | Avg gap | Dominant work |
|---|---|---|---|---|
| 1 (only) | 14:41–16:45 (~2h03m) | 17 | ~7.5 min | TDD implementation + two-stage-review fixes + holistic-review merge-blocker fixes + real-key harness |

Per-commit cadence: min ~2 min (review-nit fixes), avg ~7.5 min, max ~16.8 min (T4 `0fe08ad`, the largest task: schema + seed + prompt + loadAgentDefinition + fence across 6 files, +287). No cold-start tax — first commit landed 0 min into the session after the controller's pre-flight (the controller did Step-2.5 ground-truthing inline before dispatching T1, so the warm-up was absorbed into reading, not idle time).

**Cleanup ratio: 40%** (6 cleanup commits / 15 implementer+cleanup commits; plan-correction `43798c7` and the docs/invariant commit excluded per spec). The 6: `cda32fb` (T2.5 dedupe nicety), `7757c16` (T3 comment nit), `6a56b4f` (T4 cc-path trust fix — a real Important finding, not cosmetic), `6717679` (T5 comment nit), `0f14b6a` (the 2 holistic merge-blockers), `84a4d4a` (harness assertion-shape fix). See Harness gap #1 — the 40% is inflated by 3 comment-only nits; the substantive cleanup (cc-fix + 2 merge-blockers) is the signal that matters.

## Plan vs. shipped

| Task | Plan vs shipped | Notes |
|---|---|---|
| T1 (`74ad079`) | MATCHED | getSystemWorkspaceId + optional run field; chose no-memoize (plan permitted "if simpler/safe"). |
| T2 (`8a02387`) | MATCHED | createRun stamps `agent.workspaceId`; spec review confirmed source is the agent's ws not the run's. |
| T2.5 (`e6c4ebf`) | DIVERGED_DEFECT (corrected at dispatch) | Plan's `resolveAgentForRun` opened with the THROWING `getSystemWorkspaceId` → would 500 every local run on a non-bootstrapped instance + broke 12 existing tests. Shipped a SOFT `findSystemWorkspace` resolve. Spec review confirmed B1-preserving. **Plan-correction was committed inline (the divergence is documented in the commit + STATE), not retroactively.** |
| T3 (`4bd8071`) | MATCHED | Home-predicate gate; the short-circuit (skip the throwing getter when home===run-ws) was specified in the dispatch, built as-is. |
| T4 (`0fe08ad`) | DIVERGED_DEFECT → PC-2 (corrected at dispatch) | Ground-truth found the shipped operator used a RUNTIME `get_document` skill read with NO `skills` frontmatter field (`.strict()`), while the plan assumed load-time materialization. Surfaced to Stefan WITH consequence; he chose definitional load. **PC-2 was committed as a plan-correction (`43798c7`) BEFORE the implementer dispatch** — the model the discipline wants. |
| T5 (`e03b802`) | MATCHED | Library project-defer + BYOK confirm. RED test proved the `__system`-token deny-all bug. |
| T6 (`b4493b0`) | MATCHED | HIGH-floor guard-pin (comment + test, no logic change). |
| T7 (`7240114`) | MATCHED (least-specified, ground-truthed first) | Web surface deferred to ground-truth per plan; an Explore agent mapped the 2 server query points + 3 pickers before dispatch. |
| T8 (`f289f4c`) | DIVERGED_SCOPE (intended) | Step 1b (B8 membership) was found ALREADY tested (agent-runs.test.ts:443) — no new test needed. Step 2/2b shipped as a USER-RUN harness (real-key), not an automated test — exactly the plan's intent. |

**Two DIVERGED_DEFECTs, both corrected DURING execution (not after).** This is the target behavior: PC-1 (T2.5, the un-runnable-at-create fix) was added by the orchestration-layer audit before the build; PC-2 (T4 skill model) was caught at Step-2.5 ground-truthing, surfaced to the human with the consequence, decided, and committed as a plan-correction before dispatch. **Step 8 of this retro has NO new plan corrections to commit — both defects were already corrected in-flight.** That is the discipline working as designed.

## Discipline compliance

| Commit | Test delta in msg | Migration+journal | Test:code ratio | Concerns flagged |
|---|---|---|---|---|
| 74ad079 T1 | implied (suite 1206) | n/a (no SQL) | 2 test files / 2 src | — |
| 8a02387 T2 | suite 1206→1207 | n/a | 1/1 | — |
| e6c4ebf T2.5 | 1207→1211 | n/a | 2/3 | DONE_WITH_CONCERNS (the soft-resolve divergence — honestly flagged) |
| 4bd8071 T3 | 1211→1214 | n/a | 1/1 | — |
| 0fe08ad T4 | 1214→1221 | n/a (frontmatter field, NO migration) | 2/4 | divergences listed (projectsTable alias, DB import, .code seam) |
| 6a56b4f T4-fix | suite green | n/a | 1/1 | — |
| e03b802 T5 | 1222→1226 | n/a | 1/1 | — |
| b4493b0 T6 | 1226→1227 | n/a | 1/1 (guard-pin) | — |
| 7240114 T7 | server 1228→1232 / web 740→745 | n/a | 5 test / 8 src | divergences listed (tx-query in comments.ts) |
| 0f14b6a holistic-fix | 1233→1236 | n/a | 3 test / 3 src | — |
| f289f4c harness | n/a (script) | n/a | n/a (user-run diagnostic) | — |
| 84a4d4a harness-fix | n/a | n/a | n/a | — |

**No migration in the entire phase** (all state is frontmatter/JSON per architectural rule 3) — the migration-journal discipline gate was correctly never triggered. Every code-touching task carried tests; the only test-less commits are the 2 comment-nit fixes + the harness script (a user-run diagnostic, intentionally not a unit test) + the docs commit. **Cleanup-fix chaining: all 6 cleanup commits explicitly name the task they remediate** (`T2.5 quality nicety`, `T3 review nit`, `T4 review`, `T5`, `holistic review merge-blockers`, `shakeout S2`). Audit trail is intact.

## Harness gaps identified

1. **Per-task tests never dispatched a tool as a library agent into B — the 2 merge-blockers (token-workspace-bind CRITICAL + retry-404) survived all 7 per-task two-stage reviews and were only caught by the whole-diff holistic review.** Evidence: `0f14b6a`'s RED proof (`ctx.token.workspaceId === __system` not B; retry 404). Every per-task test asserted a SEAM (resolution returns the agent, narrowedToken.projectIds, etc.) but none exercised the full chain "library agent → executeTool/dispatchAsCaller → resolve B route". **Disposition: SHOULD_FIX.** **Remediation:** for a cross-tenant/capability feature, the per-task acceptance criteria should include AT LEAST ONE end-to-end "act in the target" assertion per the task that wires the capability (here T4/T5 should each have dispatched one tool into B), not only seam assertions. The holistic review is the backstop, but it caught a feature-nullifying bug late — cheaper to catch at T5. This is already partly encoded in the project lesson `holistic-review-catches-cross-task-bugs`; the NEW delta is "for capability/authority features, add an end-to-end act-in-target assertion at the wiring task, don't defer the only real-dispatch test to the final shake-out."

2. **The real-key shake-out harness shipped with an assertion-shape bug (`S2-home-is-system` stored a descriptive string → always rendered ❌ even though the value was correct).** Evidence: `84a4d4a`. The harness was committed WITHOUT a dry-run (it's a real-credit script, so I can't unit-test it cheaply), and the bug only surfaced when Stefan ran it. The product was correct; the harness's own check was wrong. **Disposition: MONITOR.** Sample size 1; the bug was cosmetic (the VERDICT line keyed off the real merge-blockers and correctly said PASS). A diagnostic harness that itself needs testing is a known cost of real-key scripts; not worth a process change yet. Re-evaluate if a second harness ships a false-verdict bug.

3. **Cleanup ratio 40% is at the spec's >40% "plan/review discipline" threshold — but 3 of 6 cleanup commits are comment-only nits surfaced by the code-quality reviewer.** Evidence: `7757c16`, `6717679` (comment precision), `cda32fb` (a dedupe nicety). **Disposition: MONITOR.** The substantive cleanup (the cc-trust fix + 2 merge-blockers) is 3 commits = 20% — healthy. The reviewer correctly surfaced comment-accuracy nits and the controller fixed them in-line rather than batching, which inflates the COUNT but is good hygiene. The metric over-counts comment nits as "cleanup"; not a real discipline gap this phase. Monitor whether comment-nit-as-separate-commit becomes a pattern worth batching.

4. **`Skill("netdust-core:testing-workflow")` invocation not verifiable from git** (lives in subagent transcripts, not commits). Per the spec, flag as unable-to-verify. **Disposition: MONITOR.** The structured Test-evidence blocks WERE present in every implementer report this session (the controller required them via the verbatim addendum and gated on them), so the discipline held by the addendum mechanism even though the Skill-invocation itself isn't git-visible. The `subagent-stop.py` backstop is the safety net. No action.

## Recommendations

1. **Action:** For capability/authority features (anything that lets an actor ACT in a new scope/tenant), require the WIRING task's acceptance tests to include at least one end-to-end "perform a real action in the target" assertion — not only resolution/seam assertions. **Why:** Phase B's 2 merge-blockers were feature-nullifying (the operator literally couldn't act in B) yet passed 7 per-task reviews because every test stopped at a seam; the holistic review caught them late. **Cost:** one extra integration-style test per wiring task (~10 min); far cheaper than a late holistic catch or a post-merge field failure. (Encode as a dispatch-prompt acceptance-criterion checklist item; complements the existing `holistic-review-catches-cross-task-bugs` lesson.)

## Follow-ups for human review

No human-decision items this sub-phase. (OP-LIB-1 library-`published` flag and OP3-F1 medium-tier dryRun default were already logged in `tasks/retro-follow-ups.md` during Phase B execution — not re-surfaced here.)

## Memory updates

- `+8 lines` to `~/.claude/plugins/cache/superpowers-marketplace/superpowers/.../subagent-driven-development` is NOT writable from here; instead the lesson lands in project auto-memory below.
- `+6 lines` to `~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_end-to-end-assertion-at-wiring-task.md` (NEW — the Recommendation #1 lesson: seam tests miss feature-nullifying capability bugs; add an act-in-target assertion at the wiring task).
- (Phase B completion itself was already captured in `project_phase-B-cross-workspace-execution-shipped.md` + `MEMORY.md` + `memory/STATE.md` during execution — not re-written here.)
