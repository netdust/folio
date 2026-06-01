# Retro — operator-agent Phase 2 (token-scoped config write surface + dryRun)

**Date:** 2026-06-02
**Commit range:** `40a9c88..0b4747d` (phase-op-2 scope; the `.last-evaluate` marker `5b527a0` was stale by several sub-phases — see Harness gap 1)
**Total commits in sub-phase:** 19 (14 implementation/cleanup, 1 plan-correction, 1 ceiling-proof test, 3 tracking/gate-record; memory-commits excluded)
**Active dev time:** ~1.4 hours implementation (22:39→00:02), after the plan was written at 20:54 (a ~105-min gap = session break between plan and execution)

## Timing

| Session | Span | Commits | Work type |
|---|---|---|---|
| Plan | 20:54 (single) | 1 (`40a9c88`) | plan + threat model |
| Execution | 22:39 → 00:02 (~83 min) | 17 impl/fix/track | scope const → shared dryRun envelope → 5 route guards → auth-ceiling fix → ceiling-proof → 2 review-fix passes |

- **Per-commit cadence:** ~5 min avg across the execution session; tight, steady. Largest commit `fa1fd02` (views, 163 ins); smallest the 2–3-line tracking/correction commits.
- **Cleanup ratio: 38.5%** (5 cleanup/review-fix of 13 implementer commits; plan-correction + tracking excluded per Step 3 rules). Just under the 40% flag line — see Harness gap 2.
- **Cold-start tax:** N/A — the plan and execution were the same calendar evening; the 105-min gap was think-time, not warm-up.

## Plan vs. shipped

| Task | Plan vs shipped | Notes |
|---|---|---|
| P2 scope const (`config:write`) | MATCHED | `763df41` — owner/admin-only via `roleToScopes`/`ALL_DOCUMENT_SCOPES` |
| P2-3/P2-8 shared dryRun envelope | MATCHED | `8f8be01` — one reader, all routes consume it |
| P2-2/4/6/8 tables route | MATCHED | `e7ff11f` |
| P2 fields route | MATCHED | `24c62a6` |
| P2 views route | MATCHED | `fa1fd02` |
| P2 statuses route | MATCHED | `a2069a5` |
| P2-5 project routes (+ workspace stays session-only) | MATCHED | `fcc9433` |
| P2-1/2 ceiling-proof | MATCHED | `a2821fb` — proves config:write inherits the Phase-1 delegate ceiling |
| dryRun DELETE-from-query | DIVERGED_DEFECT | `2a241e0` — plan assumed DELETE reads dryRun from body; DELETE has no body. Corrected to read from query; POST/PATCH from validated json. |
| OP2-F1 (token modal offers dead scopes) | DIVERGED_SCOPE | tracked `9f5b17a`, fixed `dffbb60` — UI surfaced scopes that didn't map; aliased legacy granular scopes. Server-side counterpart = the auth-ceiling fix below. |
| Token-mint role ceiling | DIVERGED_SCOPE (added) | `9f75c40` — NOT in the original plan; a CRITICAL privilege-escalation hole found mid-sub-phase via an auth audit (member could mint a `config:write` token). Pre-existing bug in the base token system, surfaced because Phase 2 made `config:write` real. Fixed TDD + 4 tests. |

**DIVERGED_DEFECT detail — dryRun DELETE source (`2a241e0`):** the plan's dryRun-flag-reader spec assumed every method reads `dryRun` from the JSON body. DELETE requests carry no body, so the flag was unreadable on delete paths. Shipped fix: a single `isDryRunDelete` reader that takes DELETE's flag from the query string, POST/PATCH from validated json. Plan-correction callout lands in the plan (Step 8).

## Discipline compliance

| Signal | Result |
|---|---|
| Test paired with every code commit | ✅ 9/9 code-touching commits shipped a `.test.ts` (route guards, envelope, auth fix, dryRun hygiene). Zero code-without-test commits. |
| Migration + journal paired | N/A — no `.sql` in this sub-phase (route/lib only). Correct. |
| Test-count delta in commit body (`N -> M`) | ❌ **0/13** — no commit carried the convention. Discipline held by the paired-test-file signal instead, but the count-delta line is absent. See Harness gap 3. |
| TDD on the CRITICAL fix | ✅ `9f75c40` — RED (member→config:write returned 201) → GREEN (403) → verified, per the session transcript. |
| Plan defect flagged honestly at commit time | ✅ `2a241e0` commit message names the divergence explicitly. |
| Review-fix commits chained to their finding | ✅ `1e37155` (Minor: 409), `dffbb60` (OP2-F1), `0b4747d` (dryRun hygiene review fixes) each name the finding they close. |

## Harness gaps identified

1. **`.last-evaluate` marker was stale by several sub-phases.** It pointed at `5b527a0` (pre-sub-phase-E-retro), so the raw range spanned 443 commits / 197 memory commits across phase-3 F-finishing + multiple phase-3.x merges + all three operator phases. I scoped to phase-op-2 by plan-mtime per Step 1's intent, but the marker should have been re-stamped at each intervening sub-phase close and wasn't (several sub-phases shipped without a `/evaluate`). **Disposition:** MONITOR — the scoping heuristic (most-recent-plan + retro-gap) recovered correctly this time; the real fix is running `/evaluate` per sub-phase, which is a usage-discipline issue, not a skill defect. Re-evaluate if the next run also finds a multi-sub-phase gap.

2. **Cleanup ratio 38.5% — just under the 40% flag.** 5 review-fix commits on 13 implementer commits. Not over the line, but two of the five (`9f75c40` auth-ceiling, `dffbb60` OP2-F1) were SECURITY findings the plan's threat model didn't name — config:write being a new owner-only scope had token-minting and UI consequences the threat model didn't trace. **Disposition:** MONITOR — the threat model caught the route-level surface (which is why the 5 routes were MATCHED with zero rework); it missed the *transitive* consequences of adding a privileged scope (who can mint it, what UI offers it). Sample size of one; watch whether "new privileged scope → mint + UI surfaces" recurs as a threat-model blind spot.

3. **Test-count-delta convention (`N -> M`) absent from all commit bodies.** The discipline that lets `/evaluate` verify test growth from git alone wasn't followed; I had to infer coverage from the test-file-pairing signal. **Disposition:** SHOULD_FIX — cheap, mechanical, and it's a stated convention. Remediation in §Recommendations.

## Recommendations

1. **Action:** Add the test-count-delta line (`Test count: <before> -> <after> server (+N)`) to the commit-message convention enforced by the implementer-prompt in `netdust-core:ntdst-execute-with-tests` / `testing-workflow`. **Why:** it's the signal `/evaluate` Step 2.4 reads to verify test growth without re-running suites; its absence this sub-phase forced manual inference. **Cost:** one line added to the implementer-prompt template + the testing-workflow skill's commit-shape section. Low.

## Follow-ups for human review

No human-decision items this sub-phase. (Gaps 1 and 2 are MONITOR; gap 3 is auto-actionable.)

## Memory updates

- `+1 entry` to `~/.claude/.../testing-workflow/lessons.md` (the absent test-count-delta convention — skill-lessons entry, see below).
- No project auto-memory write: the two security findings (token-mint ceiling, OP2-F1) and the SSE tradeoff are ALREADY captured in auto-memory from this session (`project_auth-audit-2026-06-01`, the `tasks/retro-follow-ups.md` SSE bullet, `project_folio-api-inprocess-no-token-mint`). Re-writing them would duplicate. This retro cross-references rather than re-records.
