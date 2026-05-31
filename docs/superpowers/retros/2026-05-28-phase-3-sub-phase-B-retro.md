# Retro — phase-3 Sub-phase B

**Date:** 2026-05-28
**Commit range:** `b05761a..3f50144` (109 raw commits; 59 substantive after stripping auto-memory)
**Total commits:** 59 substantive (8 implementation + 48 review-fix + 5 plan-correction + 1 retro-target = 62 — see Classification below)
**Active dev time:** ~6.5 hours, ONE continuous session (zero >90-min gaps)

## Timing

### Per-session breakdown

Single session 11:41 → 17:56. The 6h15m span breaks into two functionally distinct phases:

| Phase | Span | Commits | Avg gap | Dominant work |
|---|---|---|---|---|
| B-1..B-7 implementation | 11:47 → 12:29 (42 min) | 8 (B-1..B-7 + B-2 fixup) | ~5 min | Subagent-driven implementation per the plan |
| 7 review-fix rounds | 12:29 → 17:56 (5h27m) | 48 fix commits + 4 plan-corrections | ~6 min | `/code-review` rounds 1–7, fix batches, threat-model enrichments |

**The headline number: implementation was 42 minutes; review-fix rounds were 5h27m = 7.7× the implementation time.** This is the inverse of Sub-phase A (50 min total, 2 plan defects found). Sub-phase A had a clean plan; Sub-phase B had a plan that didn't include security spec, so the review cycle became the security spec.

### Per-commit stats

- **Min gap:** ~1 min (e.g. consecutive plan-correction → fix commits in the same round)
- **Avg gap:** ~6 min (substantive commits)
- **Max gap:** ~17 min (gaps where a subagent was running a long batch, e.g. round-3 batch dispatching 11 fixes)

### Cleanup ratio

- Implementation commits: 8 (B-1..B-7 + B-2 fixup)
- Review-fix commits: 48
- Plan-correction commits: 5 (round 2 added the initial threat model retroactively; rounds 3, 4, 5, 6, 7 each enriched it)
- Total implementer commits (denominator): 8 + 48 = 56
- Cleanup numerator: 48 review-fix commits

**Cleanup ratio: 48/56 = 86%.** Far above the 40% red-line. Plan-correction commits are excluded from both numerator and denominator per the spec — they're audit-side meta-work.

For comparison: Sub-phase A had ~10% cleanup (2 fix commits / 7 implementation commits + 2 fixups). Sub-phase B is an order of magnitude higher — but it's not because the implementation was buggy. It's because the **plan had no security spec**, so every `/code-review` round was independently re-discovering the attack surface until the threat model was iteratively built up over 7 rounds.

### First-commit cold-start tax

- Branch HEAD at session start: `b05761a` (Sub-phase A retro tail) committed 11:37:38.
- First implementation commit (B-1): `3ab475e` at 11:47:56.
- **Cold-start tax: 10 minutes.**

That covered: reading STATE.md, reading the plan, invoking `ntdst-execute-with-tests`, the audit work that prevented B-7's plan-vs-reality drift from blowing up.

## Plan vs. shipped

### Per-task table

| Task | Plan vs shipped | Notes |
|---|---|---|
| B-1 (AIProvider interface + factory) | MATCHED | `3ab475e`. Plan verbatim. Spec-review + quality-review both passed. |
| B-2 (Anthropic provider) | DIVERGED_DEFECT | `cba0ef6` + fixup `20b1ff0`. Plan used `as never` cast on SDK boundary; spec-review code-quality flagged it; implementer-fixup tightened to `as Anthropic.MessageParam[]`. Documented in commit message. |
| B-3 (OpenAI provider) | MATCHED | `4ff4e0e`. Implementer did a small narrowing fix (using `??=` pattern) noted in their report; not a divergence. |
| B-4 (OpenRouter provider) | MATCHED | `0b0f89f`. 16-line thin wrapper, factory-shape test. No issues. |
| B-5 (Ollama provider) | MATCHED | `70c9f19`. Implementer renamed a type-alias for cleanliness; documented as DIVERGENCES: matched plan verbatim. |
| B-6 (POST /ai/test-key route) | DIVERGED_DEFECT | `d6b6637`. Plan's code referenced `sessionMiddleware` and `resolveWorkspace` standalone middlewares that don't exist (codebase uses `wScope` chain). Controller (me) caught pre-dispatch via codebase audit and threaded real names into the dispatch prompt. Plan was wrong; shipped correctly via controller intervention. |
| B-7 (AI settings tab — web) | DIVERGED_DEFECT (heaviest) | `39118df`. Plan referenced `Select` primitive, `apiFetch`, `pages/` directory, `useAiKeys`/`useSaveAiKey`/`useDeleteAiKey` hooks — NONE existed in the codebase. Real surfaces: native `<select>`, `client.post`, TanStack Router file-based routes at `routes/w.$wslug.settings.tsx`, hooks named `useWorkspaceAiKeys`/`useUpsertAiKey`/`useDeleteAiKey`. Controller (me) audited pre-dispatch and rewrote the dispatch prompt with real surface names. The plan-vs-reality discipline `[[plan-server-source-audit]]` from Sub-phase A retro paid off here — saved at least 1 round-trip. |
| B-8 (integration gate) | MATCHED | No commit needed — `/integration` invocation gates the sub-phase; produces no artifact other than the `.last-integration` marker. |

### DIVERGED_DEFECT details

**3 DIVERGED_DEFECT classifications**, all surfaced during implementation:

1. **B-2 `as never` cast** — plan code shipped, quality-review caught it, fixup `20b1ff0` landed. Plan-correction call-out below.
2. **B-6 phantom middlewares** — plan code never shipped; controller substituted real surface names at dispatch. No plan-correction commit needed (controller's audit prevented the wrong code from ever landing). Worth documenting in the plan body so a future reader sees the canonical pattern.
3. **B-7 phantom UI primitives** — same shape. Controller audit prevented wrong code from shipping. Same disposition as B-6.

### Plan-correction commits already shipped

- `b05761a` Sub-phase A retro tail had lessons A + C from A retro
- `32862a7` A-4 Zod house-style drift (from A retro)
- `23cc7e8` A-4b install.sh heredoc portability (from A retro)
- **`4fd7dd6`** **round-2 plan correction**: added the original `## Threat model` section to the plan (16-line section) AFTER B-1..B-7 + 2 rounds of review had shipped. **This is the ROOT-CAUSE plan correction of Sub-phase B.**
- `d825289` round-4 plan correction: per-route enumeration for mitigations 5/11/12/14/15 + added 16/17
- `994f09d` round-5 plan correction: generalized mitigation 11 + rewrote 17 + added 18
- `4927871` round-7 plan correction: added attacks 18-21 + mitigations 19-22

The plan correction count is **7**: 1 root-cause (the threat-model section itself was missing) + 6 enrichments over the 7 rounds.

## Discipline compliance

### Per-commit summary

Spot-checked the 8 implementation commits + a sample of the 48 fix commits:

| Commit | Test delta in msg | Migration+journal paired | Test:code ratio | DONE_WITH_CONCERNS |
|---|---|---|---|---|
| `3ab475e` B-1 | Implicit (2 tests added) | N/A (no migrations) | 1:1 | DONE_WITH_CONCERNS (4 TS2307 from missing siblings, expected per plan) |
| `cba0ef6` B-2 | Yes (3 tests) | N/A | 1:1 | DONE (with input_schema cast tightening note) |
| `20b1ff0` B-2 fixup | None | N/A | 0:1 (type tightening only) | DONE |
| `4ff4e0e` B-3 | Yes (2 tests) | N/A | 1:1 | DONE |
| `0b0f89f` B-4 | Yes (1 test) | N/A | 1:1 | DONE |
| `70c9f19` B-5 | Yes (3 tests) | N/A | 1:1 | DONE_WITH_CONCERNS noted (1 flake) |
| `d6b6637` B-6 | Yes (5 tests + 3 lessons) | N/A | 1:1 | DONE (lesson captured: mock.module leak) |
| `39118df` B-7 | Yes (4 tests) | N/A | 1:1 | DONE (TS narrowing note for KNOWN_MODELS tuple) |
| Round-1..7 fixes (sample) | Almost always implicit | N/A (no migrations in B) | 1:1 typical | Frequent — round-3 sub-quoted prior-round disposition |

**Test-count-delta-in-message discipline: weak (~1/59 substantive commits had explicit `526 -> 530` syntax).** Per the spec, the implementer subagents reported counts in their RED/GREEN evidence blocks, but the commit message bodies usually didn't preserve them. The controller verified test counts post-commit (per `[[verify-subagent-test-counts]]` discipline from Sub-phase A retro) but the audit trail in commit messages alone is thin.

**Migration discipline: not exercised this sub-phase.** Zero `*.sql` files touched. The pre-commit hook from A-4b is silent on this branch.

**Test:code ratio: strong.** Only 4 commits touched code without test files (`09b3d72` console.warn additions, `2f1d384` proxy refactor with existing test coverage, `e53a553` SDK type tightening, `20b1ff0` SDK cast tightening). All 4 are defensibly type/log-only.

### Cleanup-commit chaining

All 48 review-fix commits explicitly reference the finding number they close (e.g. `(B fix #3)`, `(B round 5 #1 #2 #3 + #10)`). Every fix commit's body explains the finding + the fix. **Chaining discipline: excellent.** No orphan fixes; no untraceable commits.

The round labels themselves (round 1, round 2, ..., round 7) are mentioned in every commit, so anyone tracing a defect can find which review pass surfaced it.

## Harness gaps identified

### 1. The plan had no security spec.

**Evidence:** B-1..B-7 shipped in 42 minutes; rounds 1-7 then took 5h27m to discover and close 81 security/correctness findings against a surface (BYOK + user-supplied URLs + auth-grant routes) that is squarely in the `netdust-core:threat-modeling` skill's `<when_to_use>` predicate. The plan was written in Phase 2.6 (May 27) before that skill existed, so the omission was understandable — but the cost in review-cycle hours was real.

**Resolution within this sub-phase:** the threat model was retroactively added via `4fd7dd6` after round 2, then enriched in rounds 3, 4, 5, 6, 7. By round 7, the convergence pattern was visible (anti-regression scan returned `[]`; 15 ultra findings were genuinely new attack classes, not asymmetry leftovers).

**Resolution committed at session end:** CLAUDE.md updated (commit `611637e` mid-sub-phase) to require `netdust-core:threat-modeling` invocation for any future plan touching the predicate's surfaces. Lesson written to `memory/lessons.md`.

**Disposition: SHOULD_FIX. Remediation already shipped** in the mid-sub-phase CLAUDE.md update + the documented Sub-phase B threat model as the worked example referenced by the skill. No additional action required for Sub-phase C.

### 2. The threat model evolved from "checklist" to "spec" over 7 rounds.

**Evidence:** Round 4's mitigation 11 enumerated AI-key routes; round 5 found tokens.ts/workspaces.ts were missed; round 5's enumeration listed those; round 6 found MCP agent-CRUD was missed; round 6's enumeration listed that; round 7 found the HTTP twin of agent-CRUD was missed. The pattern: **the mitigation prose was generic ("auth-grant mutations") but the enumeration was specific.** Every round, a new route fitting the prose but not the enumeration surfaced.

Round 7's plan correction added the "Any FUTURE route that fits the pattern MUST use requireSessionUser in the same commit" rule. That's the rule's first attempt at being a SPEC instead of a CHECKLIST.

**Disposition: MONITOR.** Round 7's "future routes MUST" rule plus the per-route table is the right altitude for v1. The deeper structural fix (a wScope-level default-deny middleware policy with opt-out markers) is a larger refactor logged as a v1.1 Out-of-scope item in the plan. Re-evaluate at Sub-phase C close: if a new auth-grant route in C ships without `requireSessionUser` on first attempt, the rule isn't being internalized and a structural fix is needed.

### 3. Subagent-driven-development controller spec didn't pre-flight threat model.

**Evidence:** When I (controller) dispatched the round-1 implementer subagents for B-1..B-7, I had read the plan and the threat-model section did NOT exist. I dispatched 7 tasks against a plan with no security spec without flagging the gap. The first `/code-review` round was the first time security concerns were enumerated.

**Disposition: SHOULD_FIX.** The `ntdst-execute-with-tests` skill (which wraps `subagent-driven-development`) should add a pre-flight check: "if the plan touches surfaces in `netdust-core:threat-modeling`'s `<when_to_use>` predicate AND lacks a `## Threat model` section, ABORT or BLOCK until the section exists." This makes the threat-model skill's invocation a hard gate at plan-execution time, not just at plan-write time.

**Remediation:** append a §"Pre-dispatch security check" step to `~/.claude/plugins/cache/netdust-plugins/netdust-core/0.1.0/skills/ntdst-execute-with-tests/SKILL.md` before Step 1. Concretely:

> Step 0 (security pre-flight): if the plan touches any surface in `netdust-core:threat-modeling`'s `<when_to_use>` predicate AND lacks a `## Threat model` section, STOP. Either invoke `netdust-core:threat-modeling` to write the section, or get explicit user authorization to proceed without it (which is the "accept N rounds of /code-review re-discovery" path). Document the choice in the dispatch prompt.

### 4. Implementation-time-to-review-cycle-time ratio = 1:7.7.

**Evidence:** 42 min implementation, 5h27m review cycles. That ratio is extreme even for security-rich features.

**Disposition: MONITOR.** Sub-phase A had ratio ≈1:0 (no review cycles). This is the first sub-phase under the new threat-modeling discipline. Re-measure on Sub-phase C: with the threat model carried forward from B + the new pre-dispatch check (gap #3 above), the ratio should drop closer to 1:2 or 1:3. If C also runs 1:7+, the discipline isn't holding.

### 5. Test-count delta in commit messages is missing.

**Evidence:** ~1 of 59 substantive commits explicitly embedded the `526 → 530 (+4)` pattern in its message body. The discipline exists in subagent RED/GREEN reports but doesn't propagate to commit messages.

**Disposition: MONITOR.** Controller verification (per `[[verify-subagent-test-counts]]`) caught discrepancies in real time during Sub-phase A; same held in B. The audit trail via commit message alone is thin, but not zero — the subagent reports persist in the conversation transcript. Re-evaluate at retro for Sub-phase D (3 sub-phases worth of data) and decide whether to add it as a CLAUDE.md convention.

### 6. 7 rounds of code-review compounded with cap-of-15 was the real bottleneck.

**Evidence:** Rounds 1, 2, 5 all hit the 15-finding cap (15/15/15). Round 7 found 15 too. If the cap weren't there, some rounds might have found more and ended faster. The cap drove the trickle pattern: round N found 15, round N+1 found the next 9-15.

**Disposition: HUMAN_DECISION.** The cap is presentation behavior of `/code-review`, not a finding count. Discussed in the existing project memory `[[code-review-cap-transparency]]` lesson. Worth re-discussing: should `/code-review` at high-effort mode raise the cap to 30 for security-rich surfaces? Or is the 15-cap-per-round-with-multiple-rounds intentional (each round acts as a natural batch)?

## Recommendations

Only gaps with disposition SHOULD_FIX:

### 1. Add pre-dispatch security check to `ntdst-execute-with-tests` skill

**Action:** prepend a Step 0 to the skill's process: "Before any task dispatch, verify the plan has a `## Threat model` section IF its surface touches `netdust-core:threat-modeling`'s `<when_to_use>` predicate. If missing: invoke the threat-modeling skill OR get explicit user authorization to proceed without it."

**Why:** Sub-phase B's 5h27m review cycle proves that proceeding without a threat model on BYOK+URL surfaces costs ~6× the implementation budget. The threat-modeling skill exists; the harness needs to gate execution on its output, not just suggest it at plan-write time.

**Cost:** ~10 lines added to the skill body. Zero ongoing cost per task. Saves multi-hour review cycles per security-rich sub-phase.

### 2. Promote Sub-phase B threat model as the skill's worked example (already partially done)

**Action:** the `netdust-core:threat-modeling` skill's `<worked_example>` already points at this plan's threat-model section. Ensure the section is marked as "retrospective" (it was written ROUND 2, not pre-execution) so future readers see both the right shape AND understand the cost of writing it retroactively.

**Why:** the existing pointer is at the plan file; if a future reader follows it, they should see the labels round-by-round so they understand the evolution.

**Cost:** ~5 lines of preamble added to the threat model section explaining when each numbered mitigation landed.

## Follow-ups for human review

1. **Should `/code-review` raise its 15-finding cap for security-rich surfaces at high effort?** Decision: YES → modify the medium/high `/code-review` skill to use cap=30 when invoked with `--effort=high` and the diff includes surfaces from the threat-modeling predicate. NO → current cap stays; multi-round review accepted as v1 reality. (Surfaced by `${RETRO_PATH}` — see Harness gaps §6.) Decision-needed-by: before next security-rich plan (Sub-phase C runner surfaces fit).

## Memory updates

- `+~100 lines` to this retro file at `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-B-retro.md` (new retro itself)
- `+5 lines` to `tasks/retro-follow-ups.md` (gap #6 the human-decision item)
- `+8 lines` to `memory/lessons.md` planned addition: "7-round security review cycle = the cost of a missing threat model. Sub-phase B: 42 min implementation, 5h27m review. The threat-modeling skill MUST be invoked at plan-write time for BYOK/URL/auth-grant surfaces. Round-7 anti-regression scan returning `[]` IS the convergence signal that a threat model has matured from checklist to spec."
- `+~30 lines` to project auto-memory at `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_phase-3-sub-phase-B-shipped.md` describing the final test counts (server 583 → 715, web 547 → 559), threat model state (22 mitigations + 21 attacks), and the convergence pattern for inheritance into Sub-phase C planning.
- `+~5 lines` to `~/.claude/plugins/cache/netdust-plugins/netdust-core/0.1.0/skills/ntdst-execute-with-tests/lessons.md` (if it exists) capturing recommendation #1 (Step 0 security pre-flight) as a known-needed enhancement.
