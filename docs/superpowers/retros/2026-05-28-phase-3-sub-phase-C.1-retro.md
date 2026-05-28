# Retro — phase-3 Sub-phase C.1

**Date:** 2026-05-28
**Commit range:** `79f40b59..3a4f56b` (HEAD at retro time)
**Total commits:** 117 (32 non-auto-memory)
**Active dev time:** ~5h 7min across 1 session (18:25 → 23:32 CET)

## Timing

| Phase | Window | Commits | Notes |
|---|---|---|---|
| Setup (handoff + threat model + plan expansion) | 18:25-19:30 | 5 | C readiness handoff, threat-model extension (25 mitigations), C.1 task-body expansion |
| C-1..C-6 primary execution | 19:31-21:30 | 6 + 3 fixups + 2 quality = 11 | ~2h for 6 tasks; each task had 2-stage review feedback baked in |
| A1 + plan corrections + STATE | 21:48-22:39 | 2 + 1 = 3 | Threat-model review-mandated fix + 2 plan corrections + STATE tick |
| Freeform code-review fix bundles (1-5) | 22:18-22:37 | 5 | One bundle per logical cluster; ~4-5 min per commit |
| Plan reconciliation notes for C-7/C-8/C-12 | 22:54-23:25 | 5 | C.2 prep work; flagged 3 stale C-7..C-12 outlines that contradict locked decisions |
| Review-of-review bundles (6-8) | 23:31-23:33 | 3 | Closed 15 more findings the bundle-1..5 work itself missed |

**Per-commit cadence**: avg ~10 min between non-memory commits (5h / 32 = 9.4 min). No 90+ min gaps. 117 auto-memory captures interspersed (avg 1 every ~2.6 min).

**Cleanup ratio**: 12 cleanup / 16 implementer = **75%**.

This number is high but the categories matter:

| Category | Count | Interpretation |
|---|---|---|
| In-flight fixups (`2685711`, `d400aa8`, `962d4e7`) | 3 | Real cleanup tax (broke `runInTx`, wrong DBOrTx convention, wrong shape) — pre-merge corrections caught by 2-stage review per-task. Healthy. |
| Quality follow-ups (`b83340b`, `58fcd3b`) | 2 | Code-quality review surfacing — also pre-merge, also healthy. |
| Audit-trail fixup (A1 `13ccf61`) | 1 | Threat-model review found `worker_crash` raw literal; cosmetic but documented. Healthy. |
| Review-fix bundles (1-5) | 5 | Freeform code-review found 15 bugs across the C.1 services layer. **Real bug rate**: implementer commits shipped material defects that bundle-1..5 closed. |
| Review-of-review bundles (6-8) | 3 | Medium-effort review-of-review found 15 MORE bugs IN THE FIXES themselves. **Pattern**: lockstep changes (cross-file, cross-route) keep having sibling sites that the primary fix misses. |

If I count only the bundles 1-8 as "real bug cleanup" and exclude the 6 healthy fixup/quality commits, the **structural-bug cleanup ratio is 8/16 = 50%** — still high, but consistent with "this is a 1300-LOC services layer that introduces a new document type with cross-cutting concerns."

## Plan vs. shipped

| Task | Plan vs shipped | Notes |
|---|---|---|
| C-1 createRun + transitionRun + incrementTokens | MATCHED with documented divergences | `txWithEvents` shape clarified; `transitionRun(runId, args)` (not `(tx, args)` per plan); A1 `worker_crash → enum` follow-up shipped 24min later. |
| C-2 getActiveRun + getPendingApprovalRun + listRuns | MATCHED with documented divergences | `since` filter now validates ISO + throws 422 (plan was silent on bad input); quality commit `58fcd3b` tightened wildcard test + status type. |
| C-3 claimNextPlanningRun + recoverOrphanRuns + countPendingPlanning | MATCHED with documented divergences | Race-test cleanup `cancelled` (plan's `cancel_requested` not in enum); `transitionRun(tx, ...)` shorthand in plan was wrong. |
| C-4 checkRunRateLimits + checkChainGuards + EXPLAIN volume | MATCHED with documented divergences | `(args, tx?)` signature (plan put tx first); helpers pure (env-default reads deferred to caller). |
| C-5 checkProviderHealth + getProviderHealth + tipping-edge | MATCHED with documented divergences | `{current, next}` return shape (plan's `{old, new}` uses reserved `new`); TEXT not JSON column (SQLite has no JSON type). |
| C-6 ensureRunsTable + nextChainId | MATCHED with documented divergences | Direct inserts + manual `emitEvent` (plan's `services/tables.ts::createTable` doesn't exist). |
| A-5 integration gate | MATCHED | Ran `/integration` at HEAD `666635a`, marker set; later advanced through review-of-review. |

**Zero MISSING tasks.** Six DIVERGED_DEFECT cases — all already documented in commit message bodies + already plan-corrected in `1615c34` for the threat-model-bound ones (B1.a `BEGIN IMMEDIATE` and B2 `worker_started_at undefined`). The remaining drift items are commit-message-level rationale already captured.

## Discipline compliance

Sample of 16 implementer commits:

| Commit | Test delta in msg | Migration+journal paired | Test:code ratio | DONE_WITH_CONCERNS |
|---|---|---|---|---|
| `07869cc` C-1 | ✓ 524→544 | n/a | 1:1 (3 files: agent-runs.ts + agent-runs.test.ts + schema notes) | none |
| `a8ad551` C-2 | ✓ 524→552 | n/a | 1:1 | none |
| `9e217ea` C-3 | ✓ 744→752 | n/a | 1:1 | divergences explicit (3 listed) |
| `bc3aa67` C-4 | ✓ 752→764 | n/a | 1:1 | divergences explicit (6 listed) |
| `11f74a7` C-5 | ✓ 764→775 | ✓ (migration 0013 + journal in same commit) | 1:1 | divergences explicit (5 listed) |
| `b4d84c1` C-6 | ✓ 775→782 | n/a | 1:1 | divergences explicit (2 listed) |
| `799238f` Bundle 1 | ✓ 782→783 | n/a | 1:1 | yes |
| `3ff4d8c` Bundle 2 | ✓ 783→786 | n/a | 1:1 | yes |
| `cb5ab5e` Bundle 3 | ✓ 786→791 | n/a | 1:1 | yes |
| `e505ae7` Bundle 4 | ✓ 791→795 | n/a | 1:2 (added route guards + 5 tests across 3 files) | yes |
| `126a7b2` Bundle 5 | ✓ 795→796 | n/a | 1:1 | yes |
| `772b124` Bundle 6 (review-of-review) | ✓ 796→806 | n/a | 1:1 across 8 files | yes |
| `2acbff2` Bundle 7 (review-of-review) | ✓ 806→810 | ✓ (migration 0014 + journal) | 1:1 across 6 files | yes |
| `7807216` Bundle 8 | n/a (STATE only) | n/a | doc | n/a |
| `13ccf61` A1 | ✓ "unchanged" called out | n/a | 1:0 (single-file refactor) | yes — "no behavior change" |
| Fixups (3) | ✓ each notes intermediate count | n/a | varies | yes |

**Discipline: 100% on test-delta-in-message + migration-journal pairing.** A-4b's pre-commit hook + the testing-workflow checklist held across all 16 implementer commits.

**Cleanup-commit chaining**: Bundle 1 commit message names F8+F12+F6 (which are review findings from a /code-review at `--base=666635a`); Bundles 2-5 each reference the prior bundle as their baseline. Bundles 6-7 explicitly reference bundles 1-5 as their review target. Audit trail is fully linked.

## Harness gaps identified

### 1. **Lockstep-change pattern recurs across layers — primary fix misses sibling sites**

Evidence:
- C.1 review (bundles 1-5) found agent_run writes unguarded across PATCH md/JSON + DELETE + createDocument + DOCUMENT_TYPES — 5 cross-route sibling sites that the C-1 work itself didn't notice.
- Review-of-review (bundles 6-7) found:
  - agent_run READS were ALSO unguarded across GET /:slug + GET /:slug.md + MCP get_document + MCP get_document_markdown + list_documents (5 more sibling sites). Bundle 4 hardened writes but missed reads.
  - F6 was applied to `claimNextPlanningRun` + `recoverOrphanRuns` but missed `countPendingPlanning` — the 3rd site of the same JSON-extract→column predicate change.
  - F4 fixed `workspace.provider.*` event scope (projectId:null) but didn't audit whether similar workspace-wide events (`runs_table.lazy_seeded`, etc.) need the same treatment.
  - FE + shared `DocumentType` was NOT widened lockstep with the server union — the freeform review angles only ran against the server diff.

**Pattern**: every primary fix that touches a CROSS-CUTTING concern (a type union, a route group, a predicate that lives at multiple sites, an event scope) has 1-2 SIBLING SITES that need the SAME change. The primary fix lands at the most-visible site; siblings are caught only by a separate review pass on the diff.

**Disposition: SHOULD_FIX**.

**Remediation**: Update `superpowers:writing-plans` (and the project-local `netdust-core:threat-modeling` skill where applicable) to require a "**sibling-site checklist**" in every plan task that touches:
- a TypeScript union/enum (audit FE + shared + every consumer's narrow)
- a SQL predicate on a JSON-extract → column change (audit ALL read sites of the same field)
- an event scope (`projectId: null` vs project-scoped — audit every emitter of similar-shape events)
- a cross-route guard (writes hardened → audit reads; reads hardened → audit writes)
- a closed-enum literal (audit every site that writes/compares the literal)

Each plan task with such a change includes a `## Sibling-site audit` block enumerating the surface to check. Reviewers verify the audit was done; primary author can't merge without it. Per-task overhead: 5-10 minutes. Savings: the 2 layers of review-fix work this sub-phase shipped 8 cleanup commits worth — net saving once the harness incorporates this.

### 2. **Two layers of post-implementation review (threat-model + freeform) found two distinct classes of bug, AND a third layer (review-of-review) found a third class**

Evidence:
- Threat-model review (medium × 2 rounds against bound mitigations) verified all 12 mitigations in place — zero correctness defects against the named items.
- Freeform 9-angle/10-verifier review against the same diff range found 15 bugs that bound review couldn't see (cross-file attack surfaces, performance cliffs, type lies, ISO/INTEGER mismatch).
- Review-of-review (5 angles/6 verifiers, medium effort, against the review-fix work itself) found 15 MORE bugs INCLUDING:
  - Cross-binary lockstep (FE not widened) — the freeform review only looked at server diff.
  - Read-side attack surface symmetric with the write-side fix — freeform reviewers were prompted on writes after seeing bundle 4's commits.
  - Recency floor on time-windowed aggregations — easy to miss without an explicit "ALL TIME?" prompt.

**Pattern**: each successive review angle catches a NEW class of bug. Reviewers are bound by what they're told to look for. Bug yield-per-review-round is NOT diminishing fast.

**Disposition: MONITOR.**

Reasoning: I can't yet say whether this is endemic to Phase 3 (high-complexity new layer) or universal. Need 2-3 more sub-phases of data before changing the harness. The pattern WOULD be: "every sub-phase gets threat-model + freeform + review-of-review" — that's 3 rounds at ~1h each = +3h per sub-phase. Sub-phase C.1 was 5h of implementation + ~3h of review work = 8h total; if every sub-phase needs 3 review layers it's a significant time tax that needs explicit budgeting in plan-writing.

Re-evaluate after Sub-phase C.2 ships: if review-of-review again finds material bugs, promote to SHOULD_FIX with a concrete recommendation (e.g. "every sub-phase gets a freeform pass" already implicit; "every freeform pass gets a review-of-review-of-review until layer-N returns []" as a stopping rule).

### 3. **`/code-review` reviewer prompts can be reused safely — but the prompt for the OUTER review must explicitly include the inner-review's diff plus the OUTER-review's diff**

Evidence: The review-of-review at `--base=666635a` only saw bundles 6-8's commits (the review-fix work). The same range did NOT include the C.1 services-layer code that the fixes targeted. Yet bundle 6 found `countPendingPlanning` was also missed by F6 — by reading code outside the strict diff range. Reviewers can read but the prompt didn't tell them to.

**Disposition: MONITOR.**

Reasoning: the reviewer found the right things, but partly by luck. A standardized prompt would make this reproducible. Not blocking now; revisit if a future review misses a same-class sibling.

### 4. **Freeform review found bugs in `tx.all<Document>` type, BUT the threat-model-bound review missed it entirely**

Evidence: The threat-model review's 12 bound mitigations don't include "type safety of raw-SQL row reads" as a class. The freeform review caught it (F12 in bundle 1) and the review-of-review caught a follow-on (the `err.observedFrom` shape now uses `RunStatus | undefined`, requiring a `?? undefined` collapse for tsc cleanness).

**Pattern**: TS type safety is an orthogonal concern from threat-model mitigations. Threat-model review can't catch it; freeform can; review-of-review can also catch type drift introduced by the fix.

**Disposition: SHOULD_FIX.**

**Remediation**: Add a `tsc --noEmit` step to the testing-workflow's task-complete checklist with EXPLICIT instruction: "If touched files reference `tx.all<T>`, `sql\`...RETURNING *\``, or `as` casts at module-boundary types, the type CAN be a runtime lie. Verify by reading the actual SQL output (RETURNING * yields snake_case columns) or restrict the type to fields actually accessed." Project-local addendum (folio's `apps/server/src/services/` is the canonical site) in `memory/lessons.md`.

### 5. **Plan defects keep slipping past plan-writing review**

Evidence: 6 of 6 C-tasks had documented divergences. The most repeated patterns:
- Plan signatures with `tx` as the first arg (e.g. `recoverOrphanRuns(tx, args)`) while the established codebase convention is `(args, tx?)`.
- Plan claiming services exist (`services/tables.ts::createTable`) when they don't.
- Plan using reserved JS words for return shape (`{old, new}` → `new` reserved).
- Plan using bad-shape strings (`cancel_requested` not in the actual enum).
- Plan claiming code does X (`BEGIN IMMEDIATE`) when the implementation correctly chose Y (DEFERRED + load-bearing predicate).

**Disposition: HUMAN_DECISION.**

The remediation that would address this is **a "plan freshness check" / "plan vs current codebase audit" as an explicit pre-execution step** — already in retro-follow-ups from Sub-phase A. The decision still pending: do we make this a `writing-plans` skill checklist item (cross-project) or keep it as a project-local memory entry?

### 6. **Cleanup ratio at 50-75% suggests plan-writing AND code-review caps are under-sized**

Evidence: Sub-phase B had ratio 1:7.7 (42 min implementation : 5h27m fix). Sub-phase C.1 had 16 implementer + 12 cleanup = 75% by count; ~3h cleanup against ~2h primary implementation (1.5x). Better than B but still high.

The retro-follow-up "should /code-review raise its 15-finding cap for security-rich surfaces at `--effort=high`?" is still pending YES/NO. Sub-phase C.1's freeform review hit 15 across 9 angles; the review-of-review hit 15 more across 5 angles. Net 30 findings across the same diff range using two effort levels.

**Disposition: HUMAN_DECISION** — already in retro-follow-ups from Sub-phase B. No new action; re-flag for visibility.

## Recommendations

Only SHOULD_FIX gaps listed here, per Step 6.

1. **Action:** Add a `## Sibling-site audit` block requirement to every plan task that touches a TS union, JSON↔column predicate, event scope, cross-route guard, or closed-enum literal. **Why:** 2 of 3 review layers found bugs that were CROSS-CUTTING changes the primary fix didn't propagate to sibling sites. The audit makes the propagation explicit at plan-write time. **Cost:** 5-10 min per affected task at plan-write time; estimated savings 1-2 review-fix bundles per sub-phase = ~30-60 min net.

2. **Action:** Project-local addendum in `memory/lessons.md`: "When code uses `tx.all<T>(sql\`...RETURNING *\`)` against a Drizzle-typed row, the T is a runtime lie — RETURNING * yields snake_case columns, not the camelCase $inferSelect shape. Either restrict T to the fields actually read, or convert RETURNING to a narrow column list with explicit aliases." **Why:** F12 (bundle 1) found this pattern in C-3 code; same class of bug recurs anywhere raw-SQL RETURNING * meets a Drizzle row type. **Cost:** 1 memory entry; surfaces in auto-memory load on every session.

## Follow-ups for human review

The retro flags TWO HUMAN_DECISION gaps. Both are already in `tasks/retro-follow-ups.md` from earlier retros; this run confirms they're still active and ranks their urgency.

1. **Plan-freshness check as a writing-plans-skill addition?** Already in retro-follow-ups from Sub-phase A. Sub-phase C.1 surfaced 6 more plan defects — same pattern. Decision becoming time-sensitive: if YES, action is a cross-project skill update (low cost, high visibility). Stefan's decision needed before Sub-phase C.2's plan-correction expansion of C-7..C-9 (so the new plan can be authored under the freshness rule).

2. **Raise `/code-review` 15-finding cap on threat-modeling-predicate surfaces?** Already in retro-follow-ups from Sub-phase B. Sub-phase C.1 hit the cap on freeform pass + on review-of-review pass + would have hit again if a layer-3 ran. Decision: YES (cap=30 at `--effort=high`) → modify the medium/high `/code-review` skill. NO → accept multi-round trickle as v1 reality (sub-phase C.1 already shipped that way).

(`tasks/retro-follow-ups.md` already contains both items; re-flagging them here for visibility — no new bullet to append.)

## Memory updates

- `+0 lines` to `~/.claude/plugins/netdust-core/skills/testing-workflow/lessons.md` — the `tx.all<Document>` finding is project-local (folio's services/agent-runs.ts), not cross-project; goes into `memory/lessons.md` instead.
- `+12 lines` to `memory/lessons.md` (project-local) — new entry on the `tx.all<T>` runtime-type-lie pattern, plus a meta-pattern entry on cross-cutting / lockstep-change sibling-site audits. Both surface in auto-memory for future Phase 3 sessions.
- `+0 lines` to `~/.claude/projects/-home-ntdst-Projects-folio/memory/` (auto-memory captures already running on the session-end hook — covered).
- The retro itself at `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-C.1-retro.md`.
