# Retro — phase-3 Sub-phase E (Agent Surface / Web UI)

**Date:** 2026-05-30
**Commit range:** `efac862..HEAD` (Sub-phase E; the marker `3bd6c57` spanned D+D-9+E — see Harness gap #1)
**Total commits:** 28 implementation/meta (+ ~16 auto-memory, excluded from classification)
**Active dev time:** ~3.3 hours across 2 sessions

## Timing

| Session | Span | Commits | Dominant work |
|---|---|---|---|
| 1 — build | 13:37 → 16:49 (~3h12m) | 26 | plan-expand → redesign (brainstorm/spec/plan) → E-1..E-8 build + per-task two-stage review |
| 2 — code-review | 19:07 → 19:13 (~6m active) | 2 + tracking | `/code-review` fixes (4 findings) |

Session break: 16:49 → 19:07 (~2h18m gap) between the E-9 build close and the `/code-review` session.

**Per-commit:** 28 commits / ~3.3h ≈ one commit per ~7 min. The build session is dense because each task shipped as a primary commit + (usually) one review-follow-up commit in quick succession.

**Cleanup ratio: ~50%** (12 review-follow-up/code-review-fix commits ÷ ~24 implementer commits). This is HIGH by the >40% heuristic, BUT the cause is structurally different from the Sub-phase B cap-compounding problem: every one of the 12 cleanup commits is a *deliberate* product of the per-task two-stage review (spec → quality), where the quality reviewer surfaced a real-but-minor improvement (shared util reuse, a missing test, a cosmetic fix) that was fixed before closing the task. These are NOT bugs that slipped a gate — they are the gate working. Zero of the 12 were post-merge defects. See Harness gap #2.

**First-commit cold-start tax:** N/A — Session 1 opened with the plan-expansion (`efac862`), which was the prior session's pending work, not a cold start.

## Plan vs. shipped

The defining event of Sub-phase E is NOT in this table: **the plan itself was discarded mid-execution and rewritten.** The original E plan (`2026-05-30-phase-3-E-web-ui.md`, E-3..E-9) assumed "runs render through the existing TableView." Ground-truthing E-3/E-4 at dispatch proved that false on three layers (agent_run rows are walled off from the generic `/documents` endpoint; no multi-table web nav; TableView doesn't type-scope). Execution STOPPED, the surface was re-brainstormed (visual companion) into the agent-surface design (`4a1cd31`), re-planned (`a056186`), and rebuilt. E-1/E-2/E-2b (the data/realtime layer) survived the redesign unchanged — they were always going to be the foundation.

Against the FINAL plan (`2026-05-30-phase-3-E-agent-surface.md`):

| Task | Plan vs shipped | Notes |
|---|---|---|
| E-1 useEventStream | MATCHED | + review-follow-up tests (re-subscribe, malformed JSON) |
| E-2 runs hooks | DIVERGED_DEFECT | plan said list = "bare array"; jsonOk envelopes `{data}` — corrected `83ae780` |
| E-2b health hooks | DIVERGED_DEFECT (minor) | plan assumed reactor payload key `error_class`; real key is `error_summary` — corrected at dispatch (Step 2.5), not a plan-correction commit |
| E-3 RunStatusChip/RunRow | DIVERGED_SCOPE (good) | reused existing `Badge` + shared `relativeTime` instead of hand-rolling (review caught the relativeTime dup) |
| E-4 RunsHistorySection | MATCHED | + 4th file (slideover test) honestly updated for the new wiring |
| E-4b server run_id | DIVERGED_DEFECT | plan said "runner stamps run_id"; plan comments are API-posted, not runner-stamped — corrected in the plan body pre-dispatch; also relaxed schema `.uuid()`→`.min(1)` (run ids are nanoid) |
| E-5a panel shell | MATCHED | bus is a justified divergence from command-palette-bus (needs state) |
| E-5b launcher + Cmd-K | MATCHED | + shared formatApiError reuse (review) |
| E-5c activity feed | MATCHED | known limitation documented: feed → agent Runs tab, not parent doc (payload lacks parent slug) |
| E-6 approval live state | MATCHED | hooks-order fix applied; reviewer's "dead fallback" suggestion CORRECTLY REFUSED (status is nullable) |
| E-7 banners | MATCHED | + flex-column layout fix (review caught h-full overflow) |
| E-8 wiki-link | MATCHED | + double-bracket markdown-corruption bug FIXED at review |

**DIVERGED_DEFECT count: 1 plan-correction commit (jsonOk).** The other two drifts (error_summary, run_id-stamping-location) were caught at controller Step-2.5 ground-truthing and corrected in the dispatch/plan BEFORE the subagent built against them — exactly the plan-freshness gate working as designed.

## Discipline compliance

| Aspect | Result |
|---|---|
| Test-count delta tracked | Every task self-verified suite delta at the controller (per `[[verify-subagent-test-counts]]`); web 559 → 631 across E |
| Migration+journal pairing | N/A — E touched NO `.sql` migrations (web-only; E-4b relaxed a Zod schema, not a migration) |
| Test:code ratio | Every code-touching task shipped with tests; E-4b shipped service + route tests; only the doc-comment fix (`61a87b6`) and layout fix (`e7c93bd`) were test-light (justified: comment-only / CSS-only, verified by existing tests staying green) |
| Two-stage review | Every E task (E-1..E-8) got spec-review THEN quality-review; every quality review surfaced ≥1 finding, most fixed before close |
| `testing-workflow` invocation | Every dispatch carried the verbatim netdust addendum; subagents reported the structured Test-evidence + STATUS blocks (auditable from the transcript) |
| Modified-existing-tests scrutiny | 4 tasks modified pre-existing tests (E-4/E-5b/E-5c/E-7 added QueryClientProvider/EventSource stubs); each was spec-reviewed for honesty (verifier confirmed assertions unchanged, stubs load-bearing) |

Cleanup-commit chaining: every review-follow-up commit names its parent task in the message (e.g. "E-5b polish", "E-8 fixes"). Clean audit trail.

## Harness gaps identified

1. **D + D-9 `/evaluate` retros were never run** — the `.last-evaluate` marker sat at `3bd6c57` (the C.3 retro) while D, D-9, AND E all shipped. This `/evaluate` scoped to E only (the just-finished sub-phase) and advances the marker past all three, so D + D-9 will never get a dedicated retro. **Disposition:** MONITOR. The D + D-9 work was `/code-review`'d at the time (D-8: 4 findings fixed; D-9: two-stage reviewed), so correctness was gated; only the *process* retro is missing, and reconstructing it now from cold git would be low-signal. Accept the gap; note it here so the Phase-3 branch-close roll-up (`/evaluate-phase`, when built) knows D/D-9 have no sub-phase retro.

2. **Cleanup ratio ~50% — but it's the two-stage review working, not gate leakage.** Unlike Sub-phase B (where the 15-finding `/code-review` cap compounded across rounds because the plan lacked a threat model), E's cleanup commits are per-task quality-review fixes caught BEFORE task close, zero post-merge defects. The ratio is a measure of review *thoroughness*, not plan *defect rate*. **Disposition:** MONITOR. No action — the high ratio here is a positive signal (every quality review earned its keep). Re-evaluate only if a future sub-phase shows a high ratio driven by *re-opened* or *post-close* fixes.

3. **The plan's central premise was wrong (runs = TableView) and survived plan-write + plan-expansion + the readiness handoff — caught only at task-dispatch ground-truthing.** This is the most important finding. The "runs are just a table" framing was asserted in the spec, the mega-plan, AND the readiness handoff, and was only falsified when E-3/E-4's Step-2.5 ground-truthing actually read `routes/documents.ts` and found the agent_run wall. **Disposition:** SHOULD_FIX. **Remediation:** the plan-freshness gate (Step 2.5 of `ntdst-execute-with-tests`) already exists and is what caught it — but it caught it at TASK dispatch, two plan-documents too late. The cheap reinforcement: when a plan's premise rests on "reuse existing component/endpoint X for new data type Y," the *writing-plans* self-review (or the brainstorming spec) should ground-truth that X actually accepts Y before the plan ships — not defer it to task dispatch. Captured as a lesson (see Memory updates).

4. **`testing-workflow` Skill invocation still only verifiable from transcripts, not git.** Same standing gap as prior retros — the addendum forces the structured STATUS block (which subagents did produce), but the literal `Skill()` call lives in the subagent transcript. **Disposition:** MONITOR. The structured-block discipline held this sub-phase (every report carried it); no new action.

## Recommendations

1. **Action:** When a plan or spec's core approach is "reuse existing infrastructure X (component/endpoint/table) for new data-type Y," ground-truth that X actually supports Y *at spec/plan-write time*, not at task dispatch. **Why:** Sub-phase E's entire E-3..E-9 plan was built on a premise (`agent_run` flows through TableView) that one `grep` of `routes/documents.ts` would have falsified — instead it survived three documents and cost a mid-execution stop + redesign. **Cost:** one targeted source-read during writing-plans self-review; near-zero vs. the redesign it prevents. (Lesson captured to project memory; promoting to the writing-plans skill is a candidate but the existing Step-2.5 already covers task-level — this is the spec-level extension.)

## Follow-ups for human review

No human-decision items this sub-phase. (The redesign decision was already made WITH the user mid-execution via brainstorming; the two deferred code-review findings E-FOLLOWUP-5/6 are engineering judgment already recorded in `tasks/retro-follow-ups.md`, not open human decisions.)

## Memory updates

- `+~10 lines` to `memory/lessons.md` (project-local: ground-truth "reuse X for new type Y" premises at spec/plan-write time, not task dispatch — the runs-vs-TableView lesson)
- The runs-not-a-TableView fact is ALREADY captured in auto-memory (`project_runs-not-a-tableview.md`, written mid-execution) — not duplicated here.
