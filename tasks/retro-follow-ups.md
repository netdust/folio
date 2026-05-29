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

**From Phase 3 Sub-phase C.1 review (2026-05-28 evening — threat-model rounds 1+2):**

- **C.1-R-1 — `events.document_id` has no FK to `documents.id`. Surfaces in Sub-phase D when `DELETE /runs/:id` lands.** `checkProviderHealth`'s INNER JOIN at `apps/server/src/services/agent-runs.ts:947-958` drops events whose target document was individually deleted. Workspace-cascade deletes are fine (events.workspace_id cascade catches them); individual run-deletes — not yet possible in C.1 but planned for Sub-phase D — would orphan recently-failed events out of the health window, potentially making a degraded provider look healthy. Two fixes available: (a) FK-constrain `events.document_id` with `ON DELETE SET NULL` so the row remains discoverable; (b) LEFT JOIN with NULL guards in `checkProviderHealth`. Decision lives with whoever writes the `DELETE /runs/:id` route — they own the cascade design. Surfaced by /code-review round 2 OF-1. **STILL ACTIVE — Sub-phase D follow-up.**

- ~~**C.1-R-2** — `ensureRunsTable` existence-check + INSERT race~~. **RESOLVED 2026-05-28 evening as F14** in freeform /code-review bundle 5 (`126a7b2`). Switched to `onConflictDoNothing` + post-insert re-fetch; loser short-circuits, lifecycle events emit exactly once across concurrent callers. Race test in place.

---

**From Phase 3 Sub-phase C.2 review (2026-05-29 — C-7 two-stage review):**

- **C.2-R-1 — Mitigation 27 (self-vs-peer agent-lifecycle gate) RE-SCOPED to D-3.** C-7's plan Step 5 specified a blanket `args.slug`-vs-`actor` gate over `{create_agent, update_agent, delete_agent, get_agent_self}` in the shared dispatcher. Code-quality review found it wrong on three counts vs the live per-tool guards in `routes/mcp.ts`: (a) `create_agent` has NO self-slug gate there (uses `assertAgentAllowListWidening`) — the blanket gate wrongly rejected legit agent→child spawn; (b) `delete_agent` rejects SELF-delete (`existing.id === token.agentId`), the OPPOSITE of the blanket gate, and anchored to **id** not slug; (c) `get_agent_self` takes no `slug` arg so the gate was a dead no-op; and the gate trusted the caller-supplied `actor` string instead of the trustworthy `token.agentId`. **Decision (human controller, 2026-05-29):** C-7's dispatcher enforces NO lifecycle gate — it is transport + scope + Zod-validation only. The real per-tool guards (allow-list widening on create/update, self-delete rejection on delete, token-anchored resolution on get_agent_self) move into `lib/agent-tools.ts` in D-3 when the real handlers move over, anchored to `token.agentId`. Gate removed in fix-commit `dd9f736`; code comment in `agent-tools.ts::executeTool` is the landing pad. **ACTION FOR D-3 PLANNING:** the D-3 task body + the C-extension threat model MUST carry mitigation 27 explicitly so it isn't lost between sub-phases — its enforcement currently lives only in the deferral comment. **STILL ACTIVE — Sub-phase D-3 obligation.**

- **C.1-R-3 — `tasks/todo.md` C-section section is stale.** It still lists Sub-phase A tasks as `[ ]` and doesn't track C.1's commits. Either update it to current state OR retire it (it's already superseded by per-phase plans + STATE.md's plan-expansion status). Trivial. Decision: UPDATE-IN-PLACE (one editor pass after C.1 closes) or RETIRE (delete + add a note to STATE.md that todo.md is no longer the active surface). **STILL ACTIVE — housekeeping.**

**From Phase 3 Sub-phase C.2 `/code-review` (2026-05-29 — medium-effort, 7 angles, 10 findings; 9 fixed across `1486296` + `481f8e8`, 1 deferred):**

- **C.2-R-2 — Feed tool errors back to the model for self-correction (runner tool-error contract).** Finding #6: today a tool error (invalid args / execution throw) TERMINATES the whole run (`failed`, `provider_error`) instead of feeding the error back as a `{role:'tool'}` message so the model can retry/adapt. Terminating matches the plan's LOCKED terminal-on-tool-error spec, and only matters once REAL errorable tools exist (D-3 — `__echo` can't error meaningfully). **Decision (human controller, 2026-05-29):** keep terminal-on-tool-error for C.2; redesign in D-3. The redesign DIVERGES from the current spec → needs a plan-correction + an infinite-retry guard (round cap + budget already bound it) + its own review loop. **STILL ACTIVE — Sub-phase D-3 (when real tools land).**

- **C.2-R-3 — `transitionActor` empty-string FK fallback (latent for C.3).** Finding #9: the runner resolved `transitionActor = run.createdBy ?? agent.createdBy ?? ''`; `documents.updated_by` FK→`users.id` rejects `''`, which would strand a run at `running`. Fixed in `1486296` to fail-loud / return instead of writing `''`. Latent in C.2 (`createRun` always sets `actor.id`), but **C.3's system/trigger-created runs may have no user owner** — when C.3 lands, decide the canonical system actor (seed a system user row, or make `updated_by` nullable, or always attribute to the triggering user). **STILL ACTIVE — Sub-phase C.3 / D obligation.**

  Note: the C.2 review also confirmed a pre-existing pattern (out of scope, not introduced by C.2): `transitionRun` materializes `error_reason: null` / `error_detail: null` / `worker_started_at: null` via `?? null` in its `json_set`, which fail a strict `agentRunFrontmatterSchema.parse()`. No read path strict-parses today, but the markdown-export wedge will eventually. Worth a dedicated cleanup pass on `transitionRun`'s frontmatter writes (make the optional-key writes conditional like `done_reason` now is). **NEW — housekeeping, pre-export.**

**From Phase 3 Sub-phase C.1 review-of-review (2026-05-28 night — 5 angles + 6 verifiers, 15 findings, all shipped):**

- **R1 (HIGH, RESOLVED)**: FE `apps/web/src/lib/api/documents.ts` + shared `packages/shared/src/document-schema.ts` widened to include `agent_run` lockstep with server. listDocuments default response no longer mis-routes agent_run rows through FE narrow union.
- **R2 (HIGH, RESOLVED)**: Read paths (GET /:slug, GET /:slug.md, MCP get_document, get_document_markdown) hardened against agent_run leakage. MCP list_documents enum enforced (was advisory).
- **R3 (MEDIUM, RESOLVED)**: `countPendingPlanning` predicate flipped to indexed `status` column — F6's missed 3rd site.
- **R4 (MEDIUM, RESOLVED)**: `checkProviderHealth` recency floor (24h default) — workspaces no longer locked in stale degraded; F7 no longer emits spurious recovered on empty window.
- **R5+R6 (MEDIUM+LOW, RESOLVED)**: F1's race-loser now throws `RUN_TRANSITION_RACED` (distinct from `INVALID_RUN_TRANSITION`) with `err.observedFrom` populated. Sub-phase D handlers can catch+ignore only the race code without masking real ABI bugs.
- **R7 (LOW, RESOLVED)**: recoverOrphanRuns 'failed'/'running' literals routed through `runStatusSchema.enum` — symmetric closed-enum hygiene with the A1 fix.
- **R8 (LOW, RESOLVED)**: Added a deterministic test (mock findFirst) that pins the F1 inner-throw path. 50-iter race test retained for defense-in-depth.
- **R9 (LOW, RESOLVED)**: `PRAGMA busy_timeout = 5000` added to db client + test harness. F14 + F1 race tests now serialize through the writer lock instead of SQLITE_BUSY-immediate.
- **R10 (LOW, RESOLVED)**: New `scripts/check-migration-drift.ts` linter scans .sql migrations for `DROP INDEX` against an allow-list of always-keep names. Wired into bun test.
- **R11 (LOW, RESOLVED)**: Migration 0014 adds CHECK constraint enforcing Z-suffix on `worker_started_at`. DB-level defense against future writers that bypass Zod.
- **R12 (INFO, doc-only)**: F2 COALESCE preserve-branch is dead code through current state machine; documented as forward-compatibility pin for a future `running → awaiting_approval` pause-for-approval transition.
- **R13 (INFO, refactor)**: checkProviderHealth's JS loop drops the redundant `r.error_reason === 'provider_error'` check (the SQL filter already guarantees it). Comment locks the SQL→JS contract.
- **R14 (INFO, doc-only)**: F7's idle-workspace edge case is indirectly resolved by R4's recency floor. Documented.
- **R15 (academic, deferred)**: F11 consecutive_failures cap. No pre-F5 data on this branch, so no cutover migration needed. If a future deploy carries `consecutive_failures > threshold` from before F5, a one-time normalization migration is the fix. Deferred — not yet load-bearing.

---

**From Phase 3 Sub-phase C.1 freeform code-review (2026-05-28 night — 9 angles + 10 verifiers, 15 findings):**

All 15 findings shipped as 5 atomic commits (bundles 1–5). Summary:
- **Bundle 1 (`799238f`)** — F8 ISO→ms-epoch in raw-SQL `updated_at`, F12 `tx.all<Document>` type lie, F6 `json_extract(...status)` → indexed `status` column.
- **Bundle 2 (`3ff4d8c`)** — F2 stamp `worker_started_at` on every →running transition, F1 `transitionRun` TOCTOU race fix.
- **Bundle 3 (`cb5ab5e`)** — F4 `workspace.provider.*` events emit with projectId:null, F5 `checkProviderHealth` filters to provider-relevant signals only, F7 `recoverOrphanRuns` flushes provider state per (workspace, provider), F11 (REFUTED — algorithm correct; counter capped at threshold by design).
- **Bundle 4 (`e505ae7`)** — F3+F9+F10 cross-route `agent_run` guards (PATCH md, PATCH json, DELETE, createDocument, DOCUMENT_TYPES).
- **Bundle 5 (`126a7b2`)** — F13 (REFUTED — schema already enforces Z-only via Zod's default `offset: false`), F14 `ensureRunsTable` race (resolves C.1-R-2), F15 partial-index drift surface (documented; Drizzle limitation).

Net suite delta: server **782 → 796** (+14 tests). Two threat-model findings were REFUTED on verification; locked in via code comments + tests.

---

**From external Phase-3 review feedback (2026-05-28 evening):**

> Context: a "keep / simplify / prepare" triage of the Phase 3 design was offered by a reviewer. Most of it is already in the plan or already shipped (state machine, atomic claims, threat-model discipline, MCP parity, audit/event design, provider sanitization, all six recursion guards; wiki-link expansion already dropped; provider health already minimal; fan-out already a flat count cap; cancellation already locked at mitigation 44). Two recommendations conflict with locked decisions and are NOT actioned: "split the runner into its own process" (violates one-binary / no-sidecar — handled in-process via `FOLIO_POLLER_CONCURRENCY` + boot crash-recovery instead) and "prepare Postgres migration now" (locked as v1.1 env-toggle; the only prep needed is keeping the two SQLite-specific atomicity patterns isolated — see EXT-2). The plan body was deliberately NOT edited; only the two items below need a decision. Full analysis lives in this session's transcript.

- **EXT-1 — Add a `ProviderCapabilities` descriptor to the `AIProvider` interface (Sub-phase B surface).** The plan caught provider-quirks one at a time as separate threat-model items: Anthropic ignores `baseUrl` (B attack 7 / mitigation 7), OpenRouter's `/models` is public so `models.list()` false-positives a key test (attack 13 / mitigation 13), Ollama has no auth-required key-test endpoint (mitigation 4), stop-reason union widening (attack 6 / mitigation 6). These are all instances of "this provider's shape differs" handled as one-offs. A small per-provider capability record (`supportsBaseUrl`, `keyTestEndpoint`, `streamShape`, `mappedStopReasons`) would centralize the differences so the NEXT provider quirk is a table row, not a fresh `/code-review` round. Low cost, fits cleanly inside the existing B interface, prevents future review churn. **Decision needed:** ADD-IN-B (fold into the C.2/B-revisit interface) or DEFER (accept one-off handling; revisit if a 5th provider is added). **Recommendation:** ADD-IN-B — it's the one genuinely additive item from the external review and it pays for itself the first time a provider is added. Decision lives with whoever revisits the `AIProvider` interface; nothing to do until then.

- **EXT-2 — Keep the two SQLite-specific atomicity patterns isolated so the v1.1 Postgres env-toggle is a 2-function swap, not a grep.** The runner's correctness leans on two SQLite-specific behaviors: (a) the claim race uses Drizzle's DEFERRED `db.transaction` + the load-bearing `AND status='planning'` predicate (`claimNextPlanningRun`, mitigation 36 / 37), and (b) atomic token accounting uses `json_set(... json_extract(...) + ?)` (mitigation 39 / attack 39). On Postgres these become `SELECT ... FOR UPDATE SKIP LOCKED` and `jsonb_set`. Both already live in `services/agent-runs.ts` (good — already isolated). This is NOT work for Phase 3; it's a v1.1 boundary marker. **Decision needed:** none now — just DON'T let the C.2 runner inline either pattern outside the services layer. Reviewer note for C.2: if the runner ever does a SELECT-then-UPDATE claim or increments tokens outside `incrementTokens`, that's a Postgres-portability regression. (Already partly covered by the plan's transaction-isolation note at mitigation 36; this bullet generalizes it to "the services layer is the DB-dialect seam.")

- **EXT-3 — Event-replay tooling maps to already-tracked debt, not new work.** The external review listed "event replay tooling" under "prepare immediately." v1 already has SSE replay via `Last-Event-Id` (Phase 2); operator-facing run triage is the `admin runner-stats endpoint` (Sub-phase D). The only real gap is **C.1-R-1 above** (the `events.document_id` FK). So EXT-3 is a duplicate pointer at C.1-R-1 + the D runner-stats endpoint — no separate tool. **Decision needed:** none — folded into C.1-R-1 (Sub-phase D). Listed here only so the external review's bullet is accounted for and not re-raised.

---

**From external Phase-3 review feedback — batch 2 (2026-05-28 evening, more technical reviewer):**

> Context: a per-task technical review (vulnerabilities, scalability, edge cases, "too complex" check, alternatives). Checked every claim against the plan + `apps/server/src/db/client.ts`. Triage below. Two items are GENUINELY NEW attack-surface gaps the threat model does not close — flagged for promotion to threat-model attacks 49/50 when C.2 is expanded. Three were already mitigated and the reviewer couldn't see it. The architecture recommendations (drop poller, BullMQ/Redis, separate runs.db, Effect-over-Zod, flatten guards) conflict with locked decisions — NOT actioned, rationale recorded. Plan body deliberately NOT edited. Full analysis in this session's transcript.

- **EXT-4 — Prompt-injection → tool-arg INTENT DRIFT (recommend new threat-model attack #49).** Best finding in the batch. Mitigation 26 re-runs the Zod schema on dispatched tool args, but Zod validates SHAPE, not INTENT. A doc the runner reads says "assign this to me and set priority to High"; the LLM emits a well-formed `update_document` call; the runner dispatches it with the agent's scopes; Zod passes it. Attack 27 / mitigation 27 only close AGENT-LIFECYCLE tools (`create_agent` etc.) — they do NOT cover injected mutations to ordinary documents within the agent's legitimate scope. No general "intent" check is possible (the prompt IS the intent), but a v1-sized scoped rule closes the worst case: the runner already knows the triggering run's `parent_id` + `chain_id`, so "an agent triggered on doc X may mutate doc X and its children, NOT arbitrary docs by id" blocks injected `update_document(id=<unrelated-doc>)`. **Decision needed:** PROMOTE to threat-model attack #49 + add a dispatcher scope-rule task in C.2/D, or ACCEPT-RESIDUAL (document that prompt-injected in-scope mutations are not defended in v1). **Recommendation:** PROMOTE — this is a real privilege-use gap, not an opinion. Decision lives with the C.2 plan-expansion author.

- **EXT-5 — Token-budget OVERSHOOT: enforcement is reactive, no mid-stream kill switch (recommend new threat-model attack #50).** `incrementTokens` (C-1) tallies AFTER tokens arrive. Budget is enforced at poller-claim time (mitigation 30 — a run at cap isn't claimed) and after `tokens` events, but a run claimed UNDER budget that then streams 100k tokens against a 10-token remainder blows the budget and bills the customer's BYOK key before anything stops it. On a per-customer BYOK product this is the expensive failure mode. Fix is small and uses parts that already exist: the runner already consumes `tokens` events for accounting — it should also check cumulative-vs-budget on each one and abort the stream at ~90%; the stream-abort machinery already exists (mitigation 44 cancel-via-comment aborts mid-stream). **Decision needed:** PROMOTE to threat-model attack #50 + add a "mid-stream budget kill switch" step to the C-8 runner task, or DEFER (accept overshoot-by-one-stream as v1 residual). **Recommendation:** PROMOTE — BYOK billing makes this customer-visible. Decision lives with the C.2 plan-expansion author.

- **EXT-6 — Zombie-runner UX gap (NOT a correctness bug).** The DATA race is closed (attack 38 + the load-bearing `status='running'` predicate). What's fair: a stalled run shows NOTHING to the user for up to the stale threshold (~5 min). Correctness is fine; it's a product paper-cut. Cheap fix lives in Sub-phase E (run slideover): render a "claimed, awaiting first output" state derived from `worker_started_at`. **Decision needed:** none for C; **Sub-phase E note** — add a claimed-but-no-output UI state. Not a threat-model item.

- **EXT-7 — Orphan-recovery false-positive on legitimately-slow runs (trivial fix).** Task C-3 flips runs older than 5 min to `failed worker_crash`. A slow Ollama instance or a long reasoning chain can legitimately exceed 5 min and get killed mid-work. The threshold is currently a constant. **Decision needed:** make it the env knob it should be — `FOLIO_RUN_STALE_THRESHOLD_MS` (default raised, e.g. 15 min) — wired in C-3/C-10. One-line plan note when C.2/C.3 expands. Low effort, removes a real false-positive.

- **EXT-8 — "Stale approval": parent doc edited while run is `awaiting_approval` (document as accepted residual).** If a human edits the parent doc between an agent posting its plan and the approval landing, the approved plan may now be wrong or dangerous. The threat model doesn't address it. Building invalidation logic (re-plan on parent change) is a v1.1 feature, not a v1 gate. The threat-model-honest move is to DOCUMENT it as accepted residual (same posture as the SIGTERM-drain residual at mitigation 42/41), so it's a deliberate decision rather than an oversight. **Decision needed:** ACCEPT-RESIDUAL (document in the C threat model) or PROMOTE (build awaiting_approval invalidation on `document.updated` of the parent). **Recommendation:** ACCEPT-RESIDUAL for v1.

- **EXT-9 — Items the reviewer flagged that are ALREADY MITIGATED (recorded so they are NOT re-raised):**
  - *Provider-health "thrashing" / event storm* — closed by mitigation 45 (strict tipping-edge: emit `degraded` only on `healthy → degraded`, cached on `workspaces.provider_health`; test asserts "5 consecutive failures emit exactly 1 degraded event") AND mitigation 47/48 (SSE emission is fire-and-forget; a slow consumer can't block or storm).
  - *SQLite write contention* — WAL mode is already ON (`apps/server/src/db/client.ts:16`, `synchronous=NORMAL`), which IS the reviewer's own "Alternatives" recommendation. Residual single-writer serialization is a 10x-concurrent-writer concern; Folio is one-team-per-instance, per-customer-deployed — that concurrency shape does not occur in the product's deployment model.
  - *SSE backpressure stalling the runner* — explicitly attack 48 / mitigation 47 (fire-and-forget bus, no new await points; dedicated `runner.sse-backpressure.test.ts`).

- **EXT-10 — Architecture recommendations NOT actioned (conflict with locked decisions; rationale recorded so they aren't re-litigated):**
  - *"Drop the poller for an EventEmitter / post-commit hook"* — REJECTED. An in-memory emitter loses the trigger on restart; the queue-is-the-table poller is durable BECAUSE it reads persisted rows. Claim logic is still needed the moment there's >1 concurrent run. Trades a durable design for a lossy one.
  - *"Message queue (BullMQ/Redis)"* — REJECTED. Direct violation of Architectural Rule #2 (no sidecar services) — kills the one-binary, one-command install the product is sold on.
  - *"Separate `runs.db` file"* — the ONE infra idea worth filing. Decouples runner write-churn from the documents table without adding a service, but complicates the "bulk-export the whole instance as one folder of .md" wedge and the single-SQLite-file install story. **v1.1 boundary marker at most**, not Phase 3.
  - *"Effect/Schema instead of Zod"* — REJECTED. Zod is the locked validation choice across the whole codebase (shared schemas, every route boundary). Swapping the runner to Effect mid-project fragments the stack for resilience already available via plain try/catch + the existing abort path.
  - *"Flatten guards to max_depth + token_budget only"* — REJECTED. Contradicts the other reviewer ("keep all guards") AND the threat model: fanout/duration/rate each close a SPECIFIC named DoS attack (29, 30, 33). They're paired to attacks, not speculative.
