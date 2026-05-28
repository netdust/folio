# Retro follow-ups — items needing human judgment

Created 2026-05-28 by `/evaluate` after Phase 3 Sub-phase A. One bullet per item.

**Resolved:**
- 2026-05-28: `ProviderEvent.done.reason` widened to `'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn'`. Anthropic maps `refusal` + `pause_turn` explicitly; OpenAI `content_filter` → `refusal`. Shipped as B fix #10.

---

- **Should the implementer-prompt template in `superpowers:subagent-driven-development` require a literal `Skill('netdust-core:testing-workflow')` invocation in the subagent's report?**
  Today the discipline holds via prompt content (RED→GREEN cycle, test-count delta in every commit, full suite re-run after each task). The skill-tool invocation is honor-system. Adding it makes the invocation auditable via the SubagentStop hook but adds prompt overhead per task.
  **Decision needed:** YES / NO.
  **What changes if YES:** Updates to `subagent-driven-development`'s implementer-prompt template + the `ntdst-execute-with-tests` skill body. Subagents would need to invoke + paste the checklist into their report.
  **Source:** Phase 3 Sub-phase A retro, Harness Gap #5.

- **Should A-1's reviewer NICE-TO-HAVE suggestions (events.ts file-header "Phase 3 (Task A-1)" phase-rot marker, the sync-guard test comment precision, the describe-block name with "Phase 3 additions" suffix) be cleaned up now or deferred to next-touch?**
  Decision needed: NOW (one cleanup commit on this branch) or DEFER (handle at next-touch in B+).
  **What changes if NOW:** one ~5-line cleanup commit on phase-3/agent-runner before Sub-phase B starts.
  **What changes if DEFER:** the file collects phase markers until the next person touches it organically.
  **Recommendation:** DEFER. The comments aren't bugs and the convention "drop phase markers at next-touch" is already common in the codebase.
  **Source:** Phase 3 Sub-phase A retro, Recommendation #4.

- **Should the writing-plans skill add a "plan freshness check" to its checklist (when plan mtime > 5 days, controller re-reads against live peer files before dispatching)?**
  Two of the four plan defects in Sub-phase A were *house-style drift* (the plan was written before Phase 2.6 codified the camelCase + .strict() patterns). A pre-flight checkpoint catches them at zero cost.
  **Decision needed:** YES / NO.
  **What changes if YES:** an addition to `superpowers:writing-plans/SKILL.md` listing the freshness check. Folio's `memory/lessons.md` already has the rule (2026-05-28 entry) — promoting it to skill-level makes it cross-project.
  **Source:** Phase 3 Sub-phase A retro, Harness Gap #1.

- **B-2 minor cast tightenings deferred from code-quality review:** (a) `input_schema as { type: 'object'; [k: string]: unknown }` could become `Tool.InputSchema` if exported; (b) `stream as AsyncIterable<Record<string, unknown>>` could be `MessageStreamEvent`. Both at the SDK boundary. Defer to next-touch — neither blocks B-3/4/5.

- **Should `/code-review` raise its 15-finding cap for security-rich surfaces when invoked at `--effort=high`?** Sub-phase B's 7 rounds each hit the cap (15/15/9/9/11/7/15), driving a multi-round trickle pattern. Decision: YES → modify the medium/high `/code-review` skill to use cap=30 when invoked with `--effort=high` AND the diff includes surfaces from the `netdust-core:threat-modeling` predicate. NO → current cap stays; multi-round review accepted as v1 reality. (Surfaced by `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-B-retro.md` Harness gap §6.) Decision-needed-by: before Sub-phase C planning starts (runner surfaces fit the predicate).

---

**From Phase 3 Sub-phase C.1 review (2026-05-28 evening):**

- **C.1-R-1 — `events.document_id` has no FK to `documents.id`. Surfaces in Sub-phase D when `DELETE /runs/:id` lands.** `checkProviderHealth`'s INNER JOIN at `apps/server/src/services/agent-runs.ts:947-958` drops events whose target document was individually deleted. Workspace-cascade deletes are fine (events.workspace_id cascade catches them); individual run-deletes — not yet possible in C.1 but planned for Sub-phase D — would orphan recently-failed events out of the health window, potentially making a degraded provider look healthy. Two fixes available: (a) FK-constrain `events.document_id` with `ON DELETE SET NULL` so the row remains discoverable; (b) LEFT JOIN with NULL guards in `checkProviderHealth`. Decision lives with whoever writes the `DELETE /runs/:id` route — they own the cascade design. Surfaced by /code-review round 2 OF-1.

- **C.1-R-2 — `ensureRunsTable` existence-check + INSERT race in concurrent first-callers. Surfaces in Sub-phase C.2 runner-loop.** Two simultaneous "first run" callers in distinct transactions could both miss the existence row, both attempt the INSERT, and the second hits the unique index `tables_project_slug_idx (project_id, slug)`. The outer tx rolls back. Practical race window is the first-run-after-table-creation window for a given project; in C.2 the runner is the only caller path. Fix options: (a) catch the unique-constraint violation in `ensureRunsTable` and return the existing row instead of throwing; (b) serialize lazy-seed at the runner level (single async lock per project_id); (c) accept that the loser's first run fails and gets retried on the next poll tick. Decision lives with C.2 runner-loop author. Surfaced by /code-review round 2 OF-2.

- **C.1-R-3 — `tasks/todo.md` C-section section is stale.** It still lists Sub-phase A tasks as `[ ]` and doesn't track C.1's commits. Either update it to current state OR retire it (it's already superseded by per-phase plans + STATE.md's plan-expansion status). Trivial. Decision: UPDATE-IN-PLACE (one editor pass after C.1 closes) or RETIRE (delete + add a note to STATE.md that todo.md is no longer the active surface).

---

**From external Phase-3 review feedback (2026-05-28 evening):**

> Context: a "keep / simplify / prepare" triage of the Phase 3 design was offered by a reviewer. Most of it is already in the plan or already shipped (state machine, atomic claims, threat-model discipline, MCP parity, audit/event design, provider sanitization, all six recursion guards; wiki-link expansion already dropped; provider health already minimal; fan-out already a flat count cap; cancellation already locked at mitigation 44). Two recommendations conflict with locked decisions and are NOT actioned: "split the runner into its own process" (violates one-binary / no-sidecar — handled in-process via `FOLIO_POLLER_CONCURRENCY` + boot crash-recovery instead) and "prepare Postgres migration now" (locked as v1.1 env-toggle; the only prep needed is keeping the two SQLite-specific atomicity patterns isolated — see EXT-2). The plan body was deliberately NOT edited; only the two items below need a decision. Full analysis lives in this session's transcript.

- **EXT-1 — Add a `ProviderCapabilities` descriptor to the `AIProvider` interface (Sub-phase B surface).** The plan caught provider-quirks one at a time as separate threat-model items: Anthropic ignores `baseUrl` (B attack 7 / mitigation 7), OpenRouter's `/models` is public so `models.list()` false-positives a key test (attack 13 / mitigation 13), Ollama has no auth-required key-test endpoint (mitigation 4), stop-reason union widening (attack 6 / mitigation 6). These are all instances of "this provider's shape differs" handled as one-offs. A small per-provider capability record (`supportsBaseUrl`, `keyTestEndpoint`, `streamShape`, `mappedStopReasons`) would centralize the differences so the NEXT provider quirk is a table row, not a fresh `/code-review` round. Low cost, fits cleanly inside the existing B interface, prevents future review churn. **Decision needed:** ADD-IN-B (fold into the C.2/B-revisit interface) or DEFER (accept one-off handling; revisit if a 5th provider is added). **Recommendation:** ADD-IN-B — it's the one genuinely additive item from the external review and it pays for itself the first time a provider is added. Decision lives with whoever revisits the `AIProvider` interface; nothing to do until then.

- **EXT-2 — Keep the two SQLite-specific atomicity patterns isolated so the v1.1 Postgres env-toggle is a 2-function swap, not a grep.** The runner's correctness leans on two SQLite-specific behaviors: (a) the claim race uses Drizzle's DEFERRED `db.transaction` + the load-bearing `AND status='planning'` predicate (`claimNextPlanningRun`, mitigation 36 / 37), and (b) atomic token accounting uses `json_set(... json_extract(...) + ?)` (mitigation 39 / attack 39). On Postgres these become `SELECT ... FOR UPDATE SKIP LOCKED` and `jsonb_set`. Both already live in `services/agent-runs.ts` (good — already isolated). This is NOT work for Phase 3; it's a v1.1 boundary marker. **Decision needed:** none now — just DON'T let the C.2 runner inline either pattern outside the services layer. Reviewer note for C.2: if the runner ever does a SELECT-then-UPDATE claim or increments tokens outside `incrementTokens`, that's a Postgres-portability regression. (Already partly covered by the plan's transaction-isolation note at mitigation 36; this bullet generalizes it to "the services layer is the DB-dialect seam.")

- **EXT-3 — Event-replay tooling maps to already-tracked debt, not new work.** The external review listed "event replay tooling" under "prepare immediately." v1 already has SSE replay via `Last-Event-Id` (Phase 2); operator-facing run triage is the `admin runner-stats endpoint` (Sub-phase D). The only real gap is **C.1-R-1 above** (the `events.document_id` FK). So EXT-3 is a duplicate pointer at C.1-R-1 + the D runner-stats endpoint — no separate tool. **Decision needed:** none — folded into C.1-R-1 (Sub-phase D). Listed here only so the external review's bullet is accounted for and not re-raised.
