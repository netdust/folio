# Retro — phase-3 Sub-phase C.3 (Reaction Plane)

**Date:** 2026-05-29
**Commit range:** `6c7ebd4..HEAD` (implementation subset: `770fcac..817e5d0`)
**Total commits:** 5 implementation/fix + 2 follow-up/meta (the rest of the range is C.2 retro, C.3 docs/plan, and auto-memory commits — excluded from implementer classification)
**Active dev time:** ~1.0 hour, 1 session (770fcac 10:26 → 817e5d0 11:26; no gap > 90 min)

This sub-phase shipped the **Reaction Plane**: a durable, at-least-once event dispatcher over the append-only `events` table, with the trigger-matcher as its first reactor and a runner poller draining the runs it creates. It is the first "agent does work" wiring of Phase 3.

## Timing

| Session | Span | Impl commits | Avg gap | Dominant work |
|---|---|---|---|---|
| 1 | 10:26–11:26 (60 min) | 4 impl + 1 review-fix + 2 meta | ~10 min | Build (C-10a→C-12), then review-fix + gate |

Per-commit (5 code commits): min 38 insertions (C-10a), max 749 (C-11, incl. 410-line test file), avg ~397. C-11 was the largest by design (matcher + registry + helpers + 3 test concerns).

**Cleanup ratio:** 1 review-fix commit (`ed0d009`) / 4 implementer commits = **25%**. Below the 40% flag threshold. The single review-fix bundled 3 confirmed `/code-review` findings — no per-task rework was needed (every task passed two-stage review on first or near-first pass).

**First-commit cold-start tax:** ~13 min (branch HEAD `15ae999` at session open → first impl commit `770fcac` at 10:26). Spent on: reading STATE + the execution handoff + the plan + spec §4b, confirming the 851-baseline, and loading the skill chain. Within tolerance (< 30 min) and entirely accounted-for orientation, not warmup waste.

## Plan vs. shipped

| Task | Plan vs shipped | Notes |
|---|---|---|
| C-10a | MATCHED | system-event bus rule + 2 reactor.* kinds; widening forced zero call-site changes |
| C-10b | DIVERGED_DEFECT | `db:generate` produced a contaminated migration (Drizzle snapshot drift); hand-wrote clean `0015_reactor_cursors.sql` matching the 0007+ raw convention |
| C-11 | MATCHED (with plan-sanctioned choices) | parent-resolution-per-event-kind, autonomy gate, idempotency, `resolveAgentProjects` deferred to review-fix; flag-toggle + import-cycle handled per plan's offered options |
| C-12 | MATCHED (with plan-sanctioned choice) | injectable `recover` dep on `startRunnerPoller` (plan's own recommended DB-state-assertion approach); `recoverOrphanRuns({staleThresholdMs})` signature corrected at dispatch |

**DIVERGED_DEFECT — C-10b migration generation.** The plan's Step 2 said "run `bun run db:generate`". On a project that has hand-written raw migrations since 0007 (no Drizzle snapshot maintained), `db:generate` re-emitted unrelated DDL (`events.seq`, seq indexes, `workspaces.provider_health`) because the snapshot has drifted from the raw migrations. The implementer correctly discarded the generated file and hand-wrote `0015_reactor_cursors.sql` + the manual journal entry. This is a **plan defect** (the generate step is wrong for this project's migration convention) and gets a plan-correction callout.

Two further plan-vs-source signature corrections were caught at **controller ground-truthing before dispatch** (the new Step 2.5 in action) and never reached a subagent as drift: `recoverOrphanRuns({staleThresholdMs})` (plan sketch showed `recoverOrphanRuns(db)`), and `ensureRunsTable(tx, …)` requiring a transaction. These are not DIVERGED_DEFECT (the plan was corrected in the dispatch prompt, not after the fact) but they are the same plan-freshness class that drove the promoted skill rule.

## Discipline compliance

| Commit | Test delta in msg | Migration+journal paired | Test:code ratio | Concerns flagged |
|---|---|---|---|---|
| 770fcac (C-10a) | implied (suite counts in report) | n/a | 2:2 | divergences documented |
| 8c7655d (C-10b) | implied | ✅ `0015` + `_journal.json` | 1:4 | divergences documented |
| 2520214 (C-11) | implied | n/a | 3:5 | divergences documented |
| 17fa1f9 (C-12) | implied | n/a | 1:3 | divergences documented |
| ed0d009 (review-fix) | implied | n/a | 3:2 | divergence (event-bus.ts no prod change) documented |

Every code-touching commit carried test files (zero test-free code commits). Migration discipline held (C-10b paired the journal — the A-4b pre-commit hook backstops this). Two-stage review (spec → quality) ran on all 4 implementation tasks; the review-fix bundle was controller-verified directly. Test counts: server **851 → 874** (+23 across C.3: +2 C-10a, +4 C-10b, +7 C-11, +5 C-12, +5 review-fix), shared **51 → 53** (+2), 0 fail throughout.

**Cleanup-commit chaining:** `ed0d009` explicitly references the 3 findings it fixes and links to the originating C-10b/C-11 work in its message and the follow-ups file.

## Harness gaps identified

1. **`db:generate` is the wrong migration step for this project.** C-10b's only DIVERGED_DEFECT: the plan (and every prior migration-touching task body) tells the implementer to run `bun run db:generate`, but this project maintains hand-written raw migrations from 0007 onward with no live Drizzle snapshot, so `generate` emits contaminated DDL. The implementer recovered correctly, but the plan instruction is a repeatable trap. **Disposition:** SHOULD_FIX. **Remediation:** plan-correction callout on C-10b Step 2 (landed this retro) noting the raw-migration convention; the lesson is captured in project memory so future migration task bodies say "hand-write the `.sql` + journal entry, do NOT trust `db:generate`."

2. **Plan-freshness drift — third consecutive sub-phase.** A (Zod/columns), C.2 (whole provider API), C.3 (`recoverOrphanRuns` signature + the migration trap). **Disposition:** RESOLVED THIS GATE. The HUMAN_DECISION was answered "promote to skill rule" and the rule shipped as **Step 2.5 (plan-freshness gate)** in `netdust-core:ntdst-execute-with-tests`. No longer a standing gap.

3. **`/code-review` 15-finding cap.** **Disposition:** RESOLVED THIS GATE (HUMAN_DECISION answered KEEP-15). C.3's medium review surfaced 5 findings, no trickle — the cap didn't pinch. Closed.

4. **System-event delivery semantics (`projectId` null vs undefined) were a latent correctness gap the per-task reviews missed.** The C-10b spec+quality reviews both passed, but the `/code-review` cross-file pass found that `emitReactorHealth` omitted `projectId` (→ `undefined`), which falls through the BUG-021 `=== null` guard and drops system events for project-filtered SSE subscribers. The per-task reviews are scoped to one file's diff; this needed the bus's filter logic + the dispatcher's emit + the SSE route read together. **Disposition:** MONITOR. The two-stage-per-task + a cross-file `/code-review` at the gate IS the layered defense that caught it; this is the system working, not a gap to fix. Re-evaluate only if cross-file findings start slipping past the gate review too.

5. **`Skill("netdust-core:testing-workflow")` invocation not verifiable from git.** As in every prior sub-phase, the subagent invocations live in transcripts, not commits. **Disposition:** MONITOR. The structured Test-evidence + STATUS blocks were present in every implementer report this session (controller observed them live), so the addendum held. Unchanged posture.

## Recommendations

1. **Action:** Land the C-10b plan-correction callout (`db:generate` → hand-write raw migration) — done in this retro's Step 8 commit. **Why:** it's the one repeatable trap that cost recovery time this sub-phase and will recur on every future migration task. **Cost:** one plan-correction commit + one project-memory line.

## Follow-ups for human review

No NEW human-decision items this sub-phase. The two standing HUMAN_DECISIONs earmarked for this gate (plan-freshness skill rule; `/code-review` cap) were both **answered and resolved at the gate** (`817e5d0`) — promoted and kept-at-15 respectively. The deferred `/code-review` findings (C.3-R-1..R-4) and carried obligations (C.2-R-1 mit-27, C.2-R-2 tool-error feedback, C.1-R-1 events FK) are engineering follow-ups already tracked in `tasks/retro-follow-ups.md` for Sub-phase D / the autonomy work — not human-decision items.

## Memory updates

- `+1 entry` to `memory/lessons.md` (project-local: `db:generate` contaminates migrations on this project — hand-write raw `.sql` + journal; reinforces `[[drizzle-migration-journal]]`)
- `+1 file` to `~/.claude/projects/-home-ntdst-Projects-folio/memory/` (`project_phase-3-sub-phase-C.3-shipped.md` — Reaction Plane shipped, what's wired, the autonomy gate, deferred items)
- Skill edit (not memory, logged here for trace): `netdust-core:ntdst-execute-with-tests` SKILL.md gained **Step 2.5 (plan-freshness gate)** per the resolved HUMAN_DECISION. Live in the plugin cache; the netdust-core plugin SOURCE repo needs the same edit to survive a re-sync.
