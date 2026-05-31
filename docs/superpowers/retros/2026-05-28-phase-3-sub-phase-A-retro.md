# Retro — phase-3 Sub-phase A

**Date:** 2026-05-28
**Commit range:** `9e27fda..13e5954` — first `/evaluate` on this branch, so the marker is the merge-base with main. Scope filtered to Sub-phase A implementation: `edeff54..13e5954` (9 substantive commits).
**Total substantive commits:** 9 (6 implementation + 2 review-fixups + 1 plan-correction)
**Active dev time:** 50 minutes across 1 session (09:51–10:41 local)

## Timing

| Commit | Time | Δ prior | Task | Type |
|---|---|---|---|---|
| `edeff54` | 09:51 | — | A-0 | impl |
| `52439c6` | 09:55 | 4 min | A-1 | impl |
| `13c76d8` | 10:03 | 8 min | A-2 | impl (migration + journal) |
| `d6fd994` | 10:13 | 10 min | A-3 | impl (migration + journal + consequential test) |
| `02c4564` | 10:24 | 11 min | A-4 | impl |
| `a9b3ae8` | 10:25 | 1 min | meta | plan correction (folded controller pre-flights) |
| `bc4b5ee` | 10:32 | 7 min | A-4 | review-fixup (2 BLOCKER + 2 IMPORTANT) |
| `24d96c7` | 10:36 | 4 min | A-4b | impl (pre-commit hook) |
| `13e5954` | 10:41 | 5 min | A-4b | review-fixup (1 IMPORTANT installer portability) |

**Per-commit avg:** ~5.5 min including dispatch + Stage-1 spec review + Stage-2 quality review + verify.
**Cleanup ratio:** 3/9 = **33%** (2 review-fixups + 1 plan-correction). Under the 40% gap threshold; all caught at review time, none at runtime.
**Cold-start tax:** ~8 min (session-start memory load + STATE.md read + plan exploration). Well under the 30-min threshold.

## Plan vs. shipped

| Task | Verdict | Notes |
|---|---|---|
| A-0 | DIVERGED_SCOPE (minor) | Plan test used `expect(row).toBeUndefined()`; sqlite `.get()` returns `null` not `undefined`. 1-line subagent fix during RED→GREEN. |
| A-1 | MATCHED | Shipped verbatim. |
| A-2 | **DIVERGED_DEFECT** | Plan's CREATE TABLE declared phantom columns `author_id` + `target_agent_id` (those are JSON frontmatter fields, not real columns). Controller pre-flight caught it; corrected SQL handed to subagent. Subagent surfaced a 3rd plan defect: `tables.title` → real schema is `tables.name`. Shipped at `13c76d8`. |
| A-3 | **DIVERGED_DEFECT** | Plan's test design used double `migrate()` expecting re-application; Drizzle's migrator is journal-idempotent so the seed-then-flip flow was broken. Controller pre-flight caught it; test rewritten to `sqlite.exec(readFlipSql())`. Subagent also surfaced a consequential `workspaces.test.ts` update (5th file) — flagged as DONE_WITH_CONCERNS, correctly. Shipped at `d6fd994`. |
| A-4 | MATCHED → REVIEW-FIXED | Shipped verbatim from plan. Code-review Stage 2 caught 2 BLOCKERs + 2 IMPORTANTs: PascalCase Zod consts vs house camelCase, missing `.strict()`, loose `assignee` regex, bare `resume_of`. All are **plan-vs-house-style drifts**, not bugs in the implementer's transcription — the plan reproduced the 2.6-era spec which predated those conventions. Fixed at `bc4b5ee`. |
| A-4b | MATCHED → REVIEW-FIXED | Shipped verbatim from plan. Code-review Stage 2 caught 1 IMPORTANT: `install.sh` used unquoted `<<EOF` heredoc, baking the installer-machine's absolute path into `.git/hooks/pre-commit`. Plan defect. Fixed at `13e5954` with `<<'EOF'` + runtime `$(git rev-parse --show-toplevel)`. |

### Defect summary

Three real plan defects shipped to corrections:

1. **A-2: phantom columns + tables.name** — already corrected in `a9b3ae8`. ✅
2. **A-3: migrator-idempotency test pattern** — already corrected in `a9b3ae8`. ✅
3. **A-4: house-style drift (camelCase/.strict()/regex)** — NEW. Captured in this retro.
4. **A-4b: install.sh portability (unquoted heredoc)** — NEW. Captured in this retro.

Defects 3 and 4 get plan-correction commits in Step 8.

## Discipline compliance

| Commit | Test delta in msg | Migration+journal paired | Test:code ratio | DONE_WITH_CONCERNS |
|---|---|---|---|---|
| `edeff54` (A-0) | ✅ 524→526 | n/a | 1:1 | no |
| `52439c6` (A-1) | ✅ 46→51 shared | n/a | 1:1 | no |
| `13c76d8` (A-2) | ✅ 526→530 | ✅ idx 12 | 1:3 (incl. SQL + journal + schema) | no |
| `d6fd994` (A-3) | ✅ 530→532 | ✅ idx 13 | 1:4 (incl. consequential test edit) | yes (5th file) |
| `02c4564` (A-4) | ✅ 532→544 | n/a | 1:1 | no |
| `a9b3ae8` (plan) | n/a (docs) | n/a | 0:0 | no |
| `bc4b5ee` (A-4 fix) | ✅ unchanged | n/a | 1:1 | no |
| `24d96c7` (A-4b) | ✅ unchanged | n/a | 1:3 (hook+harness+installer+CLAUDE.md) | no |
| `13e5954` (A-4b fix) | ✅ unchanged | n/a | 0:1 (installer only) | no |

**Findings:**
- 100% of code-touching commits declared test-count deltas in their message body — strong discipline against the `[[verify-subagent-test-counts]]` failure mode.
- 100% of migrations paired with `_journal.json` updates. A-2 and A-3 shipped *before* A-4b's pre-commit hook existed — they paired by discipline alone. A-4b's hook now makes this an enforced property.
- Fixup commits explicitly named their parent task in the message body (`(A-4)`, `A-4b fixup`). Clean audit trail.
- 1 DONE_WITH_CONCERNS (A-3, `workspaces.test.ts` 5th file) was correctly flagged as a consequential update, not scope creep.
- No commit message used hyperbolic claims ("comprehensive", "robust"). Counts and SHAs only.

## Harness gaps identified

1. **Plan-vs-house-style drift (Zod naming, `.strict()`, slug regex).**
   Evidence: A-4 Stage-2 review found 2 BLOCKERs + 2 IMPORTANTs that were all violations of the 2.6-era patterns. The Phase 3 plan was authored 2026-05-26, capturing conventions as of *its* baseline, but Phase 2.6's reviewer pass codified the camelCase + `.strict()` patterns afterwards and the plan was never re-read against the post-2.6 codebase.
   **Remediation:** add a `writing-plans` skill checkpoint: "before finalizing a plan that introduces a new Zod schema, grep `apps/server/src/lib/*-schema.ts` for the const-naming convention used by peer schemas, and require `.strict()` on frontmatter schemas." Stage 2 reviewer caught these, but at fixup cost.

2. **Plan SQL references columns that don't exist in the live schema.**
   Evidence: A-2's plan declared phantom `author_id` + `target_agent_id`; A-2's test referenced `tables.title` instead of `tables.name`. Caught by controller pre-flight + by the implementer subagent.
   **Remediation:** reinforce `[[plan-server-source-audit]]` — "when a plan includes a CREATE TABLE for an existing table, the controller must grep the actual `schema.ts` to verify the column list before dispatching."

3. **Plan test scaffolds assume Drizzle semantics it doesn't have.**
   Evidence: A-3's plan called `migrate()` twice expecting the second call to re-apply 0012a. Drizzle's migrator is journal-idempotent.
   **Remediation:** add a memory entry — "to test a single migration's UPDATE against pre-seeded rows, exec the .sql directly via `sqlite.exec(readFileSync(...))` after the migrator runs once." Capture as `feedback_drizzle-migrate-is-idempotent`.

4. **Plan-supplied shell-script generators used unquoted heredocs.**
   Evidence: A-4b's `install.sh` used `<<EOF` (unquoted) which interpolates `$HOOK_SRC_DIR` at install time. The generated hook hardcoded the installer-machine's absolute path.
   **Remediation:** add a `writing-plans` checkpoint for any plan that generates a script: "use `<<'EOF'` (single-quoted heredoc) for any generated artifact that should NOT inherit installer-time state. Prefer runtime path resolution via `$(git rev-parse --show-toplevel)`."

5. **Skill-tool invocation gap.** The wrapping `ntdst-execute-with-tests` skill says "every task ends with `Skill('netdust-core:testing-workflow')` invocation." I invoked it once after A-0 directly, but for A-1..A-4b the subagents enforced TDD via prompt discipline, not by literally invoking the skill tool. The discipline held (RED→GREEN cycle, test-count delta in every commit, full suite re-run after each task), but the *skill-invocation contract* was bypassed.
   **Remediation:** update the implementer-prompt template to include "before reporting STATUS: DONE, invoke `Skill('netdust-core:testing-workflow')` and paste its checklist into your report." This makes the invocation auditable. Severity: medium — discipline held by other means.

## Recommendations

1. **Action:** Add the four planning-skill checkpoints above (Zod naming, schema-vs-plan column audit, migrator-idempotency test pattern, generated-script heredoc quoting) to `superpowers:writing-plans/lessons.md`. **Why:** all four caused fix-up cycles this sub-phase; codifying them prevents recurrence. **Cost:** ~10 min, one PR to plugin lessons.

2. **Action:** Capture `feedback_drizzle-migrate-is-idempotent` in project auto-memory. **Why:** the test pattern will recur in B/C/D/E migrations; one memory line saves controller pre-flight time on every future migration test. **Cost:** ~2 min.

3. **Action:** Update the implementer-prompt template in `superpowers:subagent-driven-development` to require literal `Skill('netdust-core:testing-workflow')` invocation in the subagent's report. **Why:** without this, the skill-invocation contract is honor-system; with it, the hook can audit. **Cost:** ~5 min in the prompt template.

4. **Action:** Adopt the 4 NICE-TO-HAVE suggestions from A-1's review at next-touch time (Phase 3 file header phase-rot comments, sync-guard test comment precision, describe block name without "Phase 3 additions" suffix, `as const satisfies` strengthening). **Why:** they're noise/clarity wins, not bugs. **Cost:** ~5 min when the file gets touched in Sub-phase B or later.

## Follow-ups for human review

1. **Should we drop the Stage 2 code-review agent given low blocker rate?** Evidence: 6 task reviews, 2 produced BLOCKERs (A-4 PascalCase/.strict() — house-style drift, A-4b heredoc — real defect). That's 33% blocker hit rate, which IS load-bearing. **Decision:** keep both stages. **What changes if NO:** revisit at Sub-phase F close.

2. **Should A-1's reviewer suggestion (file-header phase-rot, sync-guard comment precision) be addressed now or deferred?** **Decision:** defer to next-touch in Sub-phase B+. **Files affected:** `packages/shared/src/events.ts`.

3. **Should we tighten the implementer-prompt to require `Skill('netdust-core:testing-workflow')` invocation explicitly?** **Decision needed from human.** **What changes if YES:** updates to `subagent-driven-development` prompt template + `ntdst-execute-with-tests` skill.
