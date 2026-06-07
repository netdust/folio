# Retro follow-ups — items needing human judgment

Created 2026-05-28 by `/evaluate` after Phase 3 Sub-phase A. One bullet per item.

- **[2026-06-06, from Multica agent-layer study] BUG — the cockpit operator never receives the `folio` skill body. Fix it.**
  Source-verified root cause of "the operator doesn't know how to use Folio / skill not followed." The conversation/cockpit run forks at `runner.ts:288-290` to `buildConversationMessages`, which does NOT inject the skill. `buildSkillsPreamble` (`runner.ts:992`) is called only by `buildInitialMessages` (document path) and `ccExecute` (disabled). So the cockpit system channel is `OPERATOR_PROMPT` only (`runner.ts:1200`) — which falsely claims "your folio skill is provided to you in context" (`system-skills.ts:283`). `ctx.agentSkills` is loaded (`runner.ts:700`) then read by nobody. Bug of omission; the skill IS correctly `trusted:true` (not a fence/mislabel), and tool schemas are fine (da9ac23). The path/scope/dryRun grammar lives only in `FOLIO_SKILL_BODY`.
  **This is a bugfix, not a decision** — but flagged here because it touches the agent instruction channel + the untrusted-data fence, so it should go through the harness with a `## Threat model` note.
  **Fix (Step 1):** fold `buildSkillsPreamble(ctx)` into the system channel for conversation runs, mirroring `ccExecute` (`runner.ts:1579-1583`). **Step 2:** regression test asserting the folio skill body appears in the operator's first conversation turn (Tier A seam — the missing test that let prose & delivery diverge). **Step 3:** fail-loud if the operator's skill doesn't resolve (`runner.ts:700`).
  **Source:** `docs/superpowers/specs/2026-06-06-multica-agent-layer-gap-map.md` (full gap-map + punch-list).

- **[2026-06-06, from Multica study] Build a content-based output-secret redactor at the model-output seam?**
  Folio's secret defenses are all *structural* (BYOK keys encrypted + injected to provider call only; minted token revoked at run end; `redactRunForApi` strips `system_prompt`). Nothing scans what the model itself PRINTS. `runner.ts:1601` (`setRunBody`) and `:1636`/`:1693` (`postAgentComment`) persist + SSE-broadcast model output verbatim. Because `ccToken` is minted live (`:1528`) and revoked only in the `finally` (`:1614`), an agent that echoes its own `folio_pat_` token leaks a *usable* credential into a comment + the live stream.
  **Decision needed:** BUILD NOW / DEFER.
  **What changes if BUILD:** one small redactor placed AT THE LOADER (the `system_prompt`-leaked-3× lesson — not per-handler), wrapping `postAgentComment` + `setRunBody` before persist/broadcast. Scope tight: `folio_pat_[A-Za-z0-9_-]{40}` (best: the exact known minted-token string) + `Bearer <token>` + `sk-...` + DB conn strings → fixed sentinel. Do NOT port Multica's full AWS/GitHub/Slack/JWT bank (BYOK keys are structurally out of the message stream). Touches token + BYOK surfaces → **fire the threat-modeling gate** (`## Threat model` section in the plan).
  **Why MEDIUM not HIGH:** the cc path (where `cat .env` is most plausible) is disabled; the minted token is short-lived; BYOK keys never enter the message stream by construction. Live window = the API path echoing its own still-valid token into a comment.
  **Source:** `docs/superpowers/specs/2026-06-06-multica-architecture-study.md` §3.1.

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

- ~~**Should the writing-plans skill add a "plan freshness check"?**~~ **RESOLVED 2026-05-29 (Folio Phase 3 C.3 gate): PROMOTED to a skill rule.** Added as **Step 2.5 (plan-freshness gate)** in `netdust-core:ntdst-execute-with-tests` SKILL.md — a per-task controller obligation to ground-truth each task's named dependencies (signatures/enums/scopes/columns/payloads) against live source AFTER the upstream skill loads, before writing that task's dispatch. Homed in the netdust-core wrapper (NOT upstream `superpowers`, which is unwritable plugin-cache). Calibration cites A/C.2/C.3. **NOTE: the edit is live in the plugin cache but the cache is not git-backed — the same edit must be applied in the netdust-core plugin SOURCE repo to survive a plugin re-sync.** Original item retained below for trace.

- **(SUPERSEDED — see RESOLVED above) Should the writing-plans skill add a "plan freshness check" to its checklist (when plan mtime > 5 days, controller re-reads against live peer files before dispatching)?**
  Two of the four plan defects in Sub-phase A were *house-style drift* (the plan was written before Phase 2.6 codified the camelCase + .strict() patterns). A pre-flight checkpoint catches them at zero cost.
  **Decision needed:** YES / NO.
  **What changes if YES:** an addition to `superpowers:writing-plans/SKILL.md` listing the freshness check. Folio's `memory/lessons.md` already has the rule (2026-05-28 entry) — promoting it to skill-level makes it cross-project.
  **Source:** Phase 3 Sub-phase A retro, Harness Gap #1.
  **C.2 corroboration (2026-05-29):** THIRD sub-phase to hit this. C.2's plan assumed an entire provider API that didn't exist (`continueWithToolResult` + injectable `AbortController`) plus non-existent error_reason enum members, a FK-violating `system:runner` actor, and a `kind=cancel` that doesn't exist — all caught at controller pre-flight + corrected in 3 inline plan-corrections, but only because the controller manually read the dependency surface. A skill-level freshness gate would make that manual read a hard rule. (surfaced by `docs/superpowers/retros/2026-05-29-phase-3-sub-phase-C.2-retro.md`)

- **B-2 minor cast tightenings deferred from code-quality review:** (a) `input_schema as { type: 'object'; [k: string]: unknown }` could become `Tool.InputSchema` if exported; (b) `stream as AsyncIterable<Record<string, unknown>>` could be `MessageStreamEvent`. Both at the SDK boundary. Defer to next-touch — neither blocks B-3/4/5.

- ~~**Should `/code-review` raise its 15-finding cap for security-rich surfaces at `--effort=high`?**~~ **RESOLVED 2026-05-29 (Folio Phase 3 C.3 gate): KEEP CAP AT 15.** C.3's medium-effort review surfaced 5 findings (no trickle, well under cap); the cap only pinched during Sub-phase B's 7 rounds. Accepted as v1 reality — revisit only if it pinches again. (Surfaced by `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-B-retro.md` Harness gap §6.)

---

**From Phase 3 Sub-phase C.1 review (2026-05-28 evening — threat-model rounds 1+2):**

- **C.1-R-1 — `events.document_id` has no FK to `documents.id`. Surfaces in Sub-phase D when `DELETE /runs/:id` lands.** `checkProviderHealth`'s INNER JOIN at `apps/server/src/services/agent-runs.ts:947-958` drops events whose target document was individually deleted. Workspace-cascade deletes are fine (events.workspace_id cascade catches them); individual run-deletes — not yet possible in C.1 but planned for Sub-phase D — would orphan recently-failed events out of the health window, potentially making a degraded provider look healthy. Two fixes available: (a) FK-constrain `events.document_id` with `ON DELETE SET NULL` so the row remains discoverable; (b) LEFT JOIN with NULL guards in `checkProviderHealth`. Decision lives with whoever writes the `DELETE /runs/:id` route — they own the cascade design. Surfaced by /code-review round 2 OF-1. **STILL PARKED past D (2026-05-29 D-plan decision): Sub-phase D ships `cancel` (soft-terminal), NOT a hard `DELETE /runs/:id` (spec §4g lists only cancel/retry). No individual-document delete path exists, so the FK-orphan attack is unreachable. This stays parked until a future v1.1 hard-delete; that task must resolve the FK cascade then. See `docs/superpowers/plans/2026-05-29-phase-3-D-routes-mcp-real-tools.md` D threat-model deferrals.**

- ~~**C.1-R-2** — `ensureRunsTable` existence-check + INSERT race~~. **RESOLVED 2026-05-28 evening as F14** in freeform /code-review bundle 5 (`126a7b2`). Switched to `onConflictDoNothing` + post-insert re-fetch; loser short-circuits, lifecycle events emit exactly once across concurrent callers. Race test in place.

---

**From Phase 3 Sub-phase C.2 review (2026-05-29 — C-7 two-stage review):**

- **C.2-R-1 — Mitigation 27 (self-vs-peer agent-lifecycle gate) RE-SCOPED to D-3.** C-7's plan Step 5 specified a blanket `args.slug`-vs-`actor` gate over `{create_agent, update_agent, delete_agent, get_agent_self}` in the shared dispatcher. Code-quality review found it wrong on three counts vs the live per-tool guards in `routes/mcp.ts`: (a) `create_agent` has NO self-slug gate there (uses `assertAgentAllowListWidening`) — the blanket gate wrongly rejected legit agent→child spawn; (b) `delete_agent` rejects SELF-delete (`existing.id === token.agentId`), the OPPOSITE of the blanket gate, and anchored to **id** not slug; (c) `get_agent_self` takes no `slug` arg so the gate was a dead no-op; and the gate trusted the caller-supplied `actor` string instead of the trustworthy `token.agentId`. **Decision (human controller, 2026-05-29):** C-7's dispatcher enforces NO lifecycle gate — it is transport + scope + Zod-validation only. The real per-tool guards (allow-list widening on create/update, self-delete rejection on delete, token-anchored resolution on get_agent_self) move into `lib/agent-tools.ts` in D-3 when the real handlers move over, anchored to `token.agentId`. Gate removed in fix-commit `dd9f736`; code comment in `agent-tools.ts::executeTool` is the landing pad. **ACTION FOR D-3 PLANNING:** the D-3 task body + the C-extension threat model MUST carry mitigation 27 explicitly so it isn't lost between sub-phases — its enforcement currently lives only in the deferral comment. **STILL ACTIVE — Sub-phase D-3 obligation.**

- **C.1-R-3 — `tasks/todo.md` C-section section is stale.** It still lists Sub-phase A tasks as `[ ]` and doesn't track C.1's commits. Either update it to current state OR retire it (it's already superseded by per-phase plans + STATE.md's plan-expansion status). Trivial. Decision: UPDATE-IN-PLACE (one editor pass after C.1 closes) or RETIRE (delete + add a note to STATE.md that todo.md is no longer the active surface). **STILL ACTIVE — housekeeping.**

**From Phase 3 Sub-phase C.2 `/code-review` (2026-05-29 — medium-effort, 7 angles, 10 findings; 9 fixed across `1486296` + `481f8e8`, 1 deferred):**

- **C.2-R-2 — Feed tool errors back to the model for self-correction (runner tool-error contract).** Finding #6: today a tool error (invalid args / execution throw) TERMINATES the whole run (`failed`, `provider_error`) instead of feeding the error back as a `{role:'tool'}` message so the model can retry/adapt. Terminating matches the plan's LOCKED terminal-on-tool-error spec, and only matters once REAL errorable tools exist (D-3 — `__echo` can't error meaningfully). **Decision (human controller, 2026-05-29):** keep terminal-on-tool-error for C.2; redesign in D-3. The redesign DIVERGES from the current spec → needs a plan-correction + an infinite-retry guard (round cap + budget already bound it) + its own review loop. **RE-SCOPED 2026-05-29 (D-plan): NOT bundled into the D-2/D-3 migration (which must be a pure, zero-behavior-change extraction — that's its testable contract). Tracked as a standalone task D-9 in `docs/superpowers/plans/2026-05-29-phase-3-D-routes-mcp-real-tools.md` (deferred until after D-8, or a later sub-phase). **✅ RESOLVED 2026-05-30 as D-9** (`695330c` + `b8e6886`): recoverable tool errors (invalid-args + handler-throws) feed back as `{role:'tool'}` messages; fatal (scope/unknown) terminate; bounded by `MAX_CONSECUTIVE_TOOL_ERRORS=3` → new `tool_error` reason; fed-back content is leak-safe (paths-only / safe code-or-reason, never values). Threat-model mitigations 64-66. Plan: `docs/superpowers/plans/2026-05-29-phase-3-D9-tool-error-feedback.md`.**

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

---

**From Phase 3 Sub-phase C.3 `/code-review` (2026-05-29 — medium-effort, 7 angles + 2 verify passes; 5 findings, 3 fixed in `ed0d009`, 2 deferred):**

- **C.3 review-fix `ed0d009` (SHIPPED)** — 3 CONFIRMED findings fixed atomically: (1) `emitReactorHealth` now publishes `projectId: null` + `documentId: null` explicitly (system `reactor.halted`/`recovered` were dropped for any SSE subscriber on `?project=X` because `undefined !== null` fell through the BUG-021 projectId guard); (2) the trigger-matcher's hand-rolled `(fm.projects as string[]) ?? ['*']` replaced with the canonical `resolveAgentProjects(agent)` — closes the C-11 reviewer's Minor #1 (non-array/hand-edited `.md` allow-list now normalizes identically to the 6 other call sites); (3) run-owner resolution falls back from `users.findFirst(actor)` to `apiTokens.findFirst(actor)` → `createdBy` for human PATs (`agentId===null`), so a human posting a comment-mention via a personal bearer token no longer silently drops the run. +5 tests, server 869→874.

- **C.3-R-1 — `agent.chain.suppressed` not idempotent on at-least-once replay (DEFER).** The suppression `emitEvent` runs BEFORE the `getActiveRun` guard and the dispatcher only advances the cursor after a successful `react()`, so a crash between the suppressed-event commit and the cursor-write (or a sibling trigger throwing in the same `react()`) replays the event and re-emits the signal — violating "exactly one." **Low harm:** `agent.chain.suppressed` has NO reactor consumer (observability-only), and the path is DOUBLY gated off in V1 (`isAgentOriginated`'s reachable branch needs `actor='agent:<slug>'`, which only the autonomy flag enables). **Decision:** revisit when `FOLIO_AGENT_CHAINS_ENABLED` work lands — either move the suppressed-emit after an idempotency check, or dedupe on `(event seq, agent_slug)`. **STILL ACTIVE — autonomy-work obligation.**

- **C.3-R-2 — `isAgentOriginated` run_id false-positive (DEFER, latent).** Returns true if `payload.run_id` is a string; a human-originated event carrying a `run_id` would be misclassified → suppressed. **Unreachable in V1:** no emitter of a reacted kind (`agent.task.assigned`, `comment.mentioned`, `comment.created`) puts `run_id` in the event payload (verified — `run_id` lives in comment *frontmatter*, not the emit payload). Foot-gun the moment an emitter adds it. **Decision:** with the autonomy work, tighten to actor-based classification only, or add a regression test asserting no reacted-kind emitter carries payload.run_id. **STILL ACTIVE — autonomy-work obligation.**

- **C.3-R-3 — dispatcher per-event cursor persist (DEFER, efficiency).** `runDispatcherOnce` issues one `UPDATE reactor_cursors` per event (matched OR skipped) inside the drain loop; a batch of up to `FOLIO_DISPATCHER_BATCH` (100) events → up to 100 writes where one write of the final seq suffices (at-least-once already tolerates replay from the last persisted seq). Index-backed reads confirmed non-issue (`events_seq_idx`, `documents_runs_pending_idx`). **Decision:** persist once per drained batch (on the highest successful seq) when write-volume warrants — not load-bearing at one-team-per-instance scale. **STILL ACTIVE — efficiency, revisit under load.**

- **C.3-R-4 — trigger-matcher N+1 row re-resolution (DEFER, efficiency).** `react` re-resolves workspace/project/actor-user rows once per matching trigger inside the loop; for the builtin set (≤2 matching triggers/event) this is negligible, but a workspace with many user-authored triggers makes it 3·K reads/event. **Decision:** hoist workspace/project/user lookups out of the per-trigger loop if trigger-count-per-workspace grows. **STILL ACTIVE — efficiency, revisit under load.**

- **C.2-R-3 — PARTIALLY RESOLVED by C.3.** The "C.3's system/trigger-created runs may have no user owner" concern is now resolved: trigger-created runs are owned by the originating human resolved from `event.actor` (session user id, OR via `ed0d009` the human PAT's `createdBy`). No `system:` user, no nullable `updated_by`. The note about `transitionRun` materializing `error_reason:null`/`worker_started_at:null` (strict-parse-incompatible) remains open as pre-export housekeeping.

---

## Sub-phase D code-review (2026-05-29) — deferred cleanup/altitude findings

Surfaced by the D-8 `/code-review` (medium, 7 angles). NOT bugs — maintainability/altitude. The 4 correctness findings were fixed in `9748a64`; these 3 are deferred (non-blocking, revisit at next-touch or a dedicated cleanup pass).

- **D-R-1 — allow-list derivation triplicated.** The `intersectAgentProjects(resolveAgentProjects(agent), token.projectIds ?? null)` + wildcard-collapse logic is written 3× — `routes/runs.ts::resolveAgentAllowList(c)` (Context-based), `lib/agent-tools-registry.ts::resolveAgentAllowListForToken(token)` (token-based), and inline in `routes/events.ts` (SSE F3). A semantics change (new deny-list, different wildcard rule) must hit all 3 or the HTTP/MCP/SSE faces compute different effective allow-lists for the same agent — a security-relevant divergence. Fix: promote ONE `deriveAgentAllowList(token): Promise<string[]|null>` to `lib/agent-projects.ts` (where `resolveAgentProjects`/`intersectAgentProjects` already live); all 3 call it, each maps the error shape itself. Mirrors the `loadRunScopedByToken` consolidation D-4 already did for re-scope. **Revisit: next touch of any of the 3 sites, or a Sub-phase E/F cleanup pass.**

- **D-R-2 — cancel-of-running overloads `kind=rejection` as the cancel signal.** The comment schema has no `cancel` kind, so `POST /runs/:id/cancel` on a `running` run posts a `kind=rejection` comment (the runner's `wasCancelled` detects post-start rejections — mit 44). Costs: (a) operators/UI see a "rejection" comment that means "cancel" (the `runErrorReason` enum even has BOTH `cancelled` and `rejected`); (b) the cancel path silently depends on `wasCancelled` NOT honoring `target_agent` — a future hardening of `wasCancelled` would break cancel with no test naming the coupling. Deeper fix: a first-class `cancel` comment-kind (or a dedicated run-control event the runner polls). Documented V1 tradeoff for now. **Revisit: when cancel UX/observability matters, or before the MD-export wedge (rejection-comment-meaning-cancel will export confusingly).**

- **D-R-3 — create/cancel/retry verb bodies near-duplicated across HTTP route + MCP tools.** D-4 shared `createRunForParent` + `loadRunScopedByToken`, but the orchestration around them (the cancel 3-branch state machine, the retry re-resolve-then-create flow) is written twice — once in `routes/runs.ts` (Context), once in `lib/agent-tools-registry.ts` (token). A change to cancel/retry semantics must hit both or they diverge (finding #3 — the stray-comment bug — was exactly this drift, now fixed). Fix: extract `cancelRunCore(...)` + `retryRunCore(...)` next to `createRunForParent`; each face keeps only its error-mapping + identity-resolution wrapper. **Revisit: next touch of cancel/retry, or a cleanup pass.**

---

**From Phase 3 Sub-phase E brainstorm (2026-05-30 — runs surface redesign):**

- **E-FOLLOWUP-1 — Retrofit the document/work-item slideover to the shared NocoDB-style `PanelHeader`.** E builds `PanelHeader` (icon-tab header) as a drop-in shared component and uses it in the new agent side-panel. The existing document slideover keeps its text `TabStrip` for now (decided: "new panel now, retrofit slideover later"). Own follow-up task — accepts a temporary two-tab-style gap until done. Source: E agent-surface brainstorm.
- **E-FOLLOWUP-2 — Workspace-wide runs-list endpoint + full cross-project agent history.** v1 run history shows the agent's primary project only; the activity feed is SSE-driven (no "all runs ever" query). A workspace-wide `/runs` list (across projects) unlocks full cross-project history + an audit/filter view. Deferred. Source: E agent-surface brainstorm.

- **E-FOLLOWUP-3 — Extract a shared `<PickerListbox>` primitive.** `wiki-menu.tsx` (E-8) duplicates `slash-menu.tsx`'s listbox shell + keyboard-nav (Arrow/Enter/Escape) + active-index logic (~40 lines). Content differs legitimately (slash = registry+enabled-state; wiki = doc list), but the keyboard/a11y shell should share a render-prop primitive so a third picker doesn't copy it again. Source: E-8 code-quality review. Non-blocking.
- **E-FOLLOWUP-4 — comments-tab does not mount `useRunsLiveSync`.** E-6's approval-buttons muted run-state line refreshes only on `staleTime: 10_000`, not via SSE. The load-bearing approve→resolved-banner transition IS live (driven by the comment mutation), so this is secondary-status staleness only. Mount `useRunsLiveSync`/`?run=` in comments-tab if the muted line should track live. Source: E-6 code-quality review. Non-blocking.

**From Phase 3 Sub-phase E `/code-review` (2026-05-30 — medium, 7 angles, base cf5b2f6):**

5 findings survived verification; 4 fixed (`204cb66` ?tab=/fired_by/approval-guard + `11a4f6f` multi-project runs history). 2 deferred:
- **E-FOLLOWUP-5 (efficiency, PLAUSIBLE) — `useRunsLiveSync` over-invalidates `runsKeys.all`.** The SSE subscription is already server-filtered by `agent=<slug>`, but the handler invalidates the whole `['runs']` prefix on every event, refetching every MOUNTED runs list (not just the affected agent's). Scoping to `runsKeys.list(wslug, primary, {agent})` is feasible from the component's props (NOT the event payload — it carries projectId, not the slug react-query keys on). Modest payoff (react-query only refetches mounted queries → small real blast radius); awkward because the `detail` key needs separate handling. Deferred. Source: E code-review efficiency angle.
- **E-FOLLOWUP-6 (efficiency/altitude) — N SSE connections per workspace page (no multiplexing).** Each `useEventStream` consumer opens its OWN `EventSource` to `/events`: `useProviderHealth` + `useReactorHealth` (both always-mounted in the banners) = 2 baseline, +`useActivityFeed` (panel open) +`useRunsLiveSync` (per agent slideover/history) = up to 4 persistent SSE connections per tab, each with a server-side 30s heartbeat + eventBus subscriber. The deep fix is a workspace-level SSE provider opening ONE connection covering all needed kinds, fanning out via context. Explicitly v1-acceptable per the finder (small per-customer deploys, healthy banners render null); revisit if connection count bites. Source: E code-review efficiency+altitude angles.

REFUTED at verification (not bugs): wiki `[[`-multi-node (detection clamps within one text node, can't diverge from insertion); PanelHeader-vs-TabStrip (genuinely different component — icon segmented pill vs underlined text-tab bar).

**From Phase 3 Sub-phase F shake-out (2026-05-30 — 4 reviewer agents + live sweep):**

4 findings fixed before merge (C1 `7741b63`, I1 `a00a0d0`, I2+I3 `b7493b9`). Deferred (NOT merge-blocking; performance reviewer confirmed E-FOLLOWUP-5/6 correctly deferred):
- **F-D1 — reactor-halt has no durable read path.** `reactor.halted` is a live-only bus event (no events row, no SSE replay); a web tab mounting AFTER a halt fires shows healthy. Continuously-failing reactors self-signal (dispatcher re-fires next tick) but a fresh mid-halt page load misreports. Fix: expose cursor-lag (`MAX(events.seq) − reactor_cursors.last_seq`) via `admin-runner-stats` + seed `useReactorHealth` on mount. Ops-blindness on a self-hosted box — worth doing soon. Source: F architecture-strategist (I-1).
- **F-D2 — cancel/retry run-management logic duplicated HTTP ↔ MCP (~150 lines, security-critical lockstep).** `routes/runs.ts:282-478` vs `agent-tools-registry.ts:1482-1729` — autonomy-gate + allow-list + idempotency-ordering copy-pasted across both transports (the retry-gate fix had to be written twice). Partially tracked as D-R-3 but under-stated. Extract `cancelRunCore`/`retryRunCore` (+ a `prepareRunCreate` gate) into `services/agent-runs.ts`; transports map the neutral thrown error. **MANDATORY before `FOLIO_AGENT_CHAINS_ENABLED` is ever flipped on** (five gate sites must stay in lockstep until then). Source: F architecture-strategist (I-3) + code-simplicity (Finding 1), both flagged independently.
- **F-D3 — small YAGNI cuts:** `getProvider` sync-proxy-around-async-loader (both callers already async → collapse to `await loadProvider`); `executeTool` unused `tx?` param + re-declared `DBOrTx`; `assertAgentToolsWidening`'s dead `op` param; `loadContext` collapses 8 distinct failures into one `null`/"skipping" (split skip-vs-fail-with-reason). Source: F code-simplicity-reviewer.
- **F-D4 — layering inversion:** `agent-tools-registry.ts` imports `createRunForParent`/`loadRunScopedByToken` from `routes/runs.ts`; move them into `services/agent-runs.ts` (bundle with F-D2). Source: F architecture-strategist (M-3).

**From Phase 3 Sub-phase F-6 (/code-review --base=main, the correctness lens over the shake-out fixes):**

The headline F-6 finding was a real merge-blocker I caught against my OWN F-4 fix: seed-at-0 would have caused a historical-replay stampede on an existing instance's first upgrade boot (getActiveRun only no-ops *active* peers, so completed historical assignments re-run + bill). Fixed by eager-seed-at-MAX-at-boot (`f54df04`) — closes both the F-4 race and the F-6 stampede. Two deferred (non-blocking) findings:
- **F6-D1 — E-4b/E-6 ship INERT: nothing populates `frontmatter.run_id` on a `kind=plan` comment.** The schema→route→createComment plumbing (E-4b) + the E-6 approval-buttons `useRun(run_id)` branch all exist, but no producer SETS run_id: the runner's `postAgentComment` only authors result/comment kinds (never plan), and the MCP `add_comment` tool accepts `kind` but not `run_id`. So E-6's live-run-state branch ("approval no longer needed" when the run left awaiting_approval) is permanently dead code — every plan comment falls back to legacy comment-only resolution. Not a regression (E-6 gracefully no-ops when run_id absent), but the E-4b+E-6 feature pair doesn't actually function until a producer stamps run_id on plan comments (likely the model-initiated-approval / Phase 3.x work, where the agent posts the plan comment for approval). Source: F-6 cross-file + line-by-line finders, both independently. Verify + wire when 3.x lands.
- **F6-D2 (resolved-by-the-fix, noted) — the dispatcher "seen-and-skipped" path does one UPDATE per non-subscribed event.** Finder flagged this as a startup cost amplified by seed-at-0's full replay. MOOT after the eager-seed-at-MAX fix (`f54df04`): a fresh-but-existing instance no longer replays history, so there's no N-event drain at boot. No action.

REFUTED/clean at F-6: C1 (agent_run list reject — no caller regressed, defense-in-depth real), I1 (agent-token narrowing — session/human bypass intact), I2 latch (`.finally` releases, no deadlock), I3 env defaults (match old inline values), F-D5 idleTimeout (correct key+shape). The diag-revert (557a8f7) restored trigger-matcher byte-for-byte.

---

## Body-as-prompt (2026-05-31) — deferred follow-up

- **Create-time prompt guard missing on programmatic agent-create paths.** After body-as-prompt (an agent's prompt = its document body; runner snapshots `agent.body` and `createRun` rejects an empty one with `AGENT_PROMPT_EMPTY` 422), the WEB create path seeds a `# Prompt\n\n…` starter body — but the **MCP `create_agent`** tool (`agent-tools-registry.ts:1146-1207`, `body` optional, defaults `''`) and the **HTTP `POST /documents` type=agent** path (`services/documents.ts:384`, validates `agentFrontmatterSchema` only — `system_prompt` now optional, body never checked) do NOT. So a Claude-Code-over-MCP or scripted creator can create a body-less agent that looks healthy (200, token minted once) but is unrunnable until first run, where it fails far from its cause — and for MCP the one-time bearer grant is burned. Not a correctness/security defect (runtime guard catches it, message is actionable), and net-new scope beyond the body-as-prompt plan. **Decision needed:** add a body-non-empty check to the `create_agent` MCP handler + the HTTP agent-create path so the error fires at create time (co-located with cause)? OR document the deferred-validation behavior in `docs/API.md` for the agent-create endpoints? Files: `apps/server/src/lib/agent-tools-registry.ts:1146-1207`, `apps/server/src/services/documents.ts:384`. (surfaced by the body-as-prompt final holistic review, 2026-05-31)

---

## /code-review on cockpit-panel + body-as-prompt group (2026-05-31) — resolutions + deferrals

**Fixed in `fbaa02f` + `5748894`:** #1 reactor poison-pill (body-less agent halting trigger-matcher → now skip-and-advance), #2 deep-link tab stomp, #3 lost comment-count badge, #4a stale-allow-list-IDs perpetual "Loading runs…", #5 cockpit external-store tearing, #7 dead tab-strip.tsx deleted.

**Create-time empty-body guard — DECISION MADE (don't add it):** the earlier deferred follow-up asked whether to guard agent body non-empty at create (MCP/HTTP). Prototyped during this fix pass → it broke 37 agent-create test fixtures and over-restricts (scaffolding an agent to fill the prompt later via the editor is legitimate). REVERTED. The reactor-side skip (`fbaa02f`) + the run-time guard fully close the DoS, and the run-time error is actionable. So: NO create-time guard; the prior follow-up bullet is resolved as "won't-do".

**#4b — wildcard-agent Runs tab is always empty (PRE-EXISTING, deferred):** an agent with `projects: ['*']` (the schema default = all workspace projects) shows "No project scoped to this agent yet." on its Runs tab and never lists runs, because `runs-history-section.tsx` filters out `'*'` and treats the result as no-scope. Confirmed identical at `cba6062` — predates this group, NOT introduced here. **Decision needed:** resolve runs for a wildcard agent across ALL workspace projects (iterate the workspace's projects, query each), OR leave the Runs tab scoped to explicit allow-lists only? File: `apps/web/src/components/runs/runs-history-section.tsx:43`. (surfaced by /code-review 2026-05-31)

## Operator-Agent Phase 1 (caller-delegation) — deferred /code-review findings (2026-06-01)

Found by `/code-review high` on the delegation branch; deferred by Stefan (fix-6-now-defer-7/8). All confirmed against source.

- **OP1-F7 — retry re-derives caller authority.** The retry path (`routes/runs.ts` ~515, `createRunForParent` without `resumeOf`) re-derives the caller snapshot from the RETRYING actor's membership, not the original run's — unlike resume (D6 inherits). A member retrying an owner's failed run gets narrower authority (can fail mid-run); an owner retrying a member's run re-broadens. FIX: make retry inherit the original run's snapshot like resume does. Authority-consistency gap.
- **OP1-F8 — chain re-derives instead of inheriting parent.** `run_agent` → `createRunForParent` (resumeOf undefined) re-derives the sub-run's caller snapshot from `token.createdBy` rather than inheriting the parent run's. NOT weaponizable today (`agents:write` gates chaining to owner/admin, both → full scopes), but breaks the instant member-chaining or finer role→scope mapping lands. FIX with OP1-F7 (unify resume/retry/chain authority = inherit-from-origin). MANDATORY before agent-chains (`FOLIO_AGENT_CHAINS_ENABLED`) ships.
- **OP1-F9 (minor) — member project snapshot frozen at create-time.** A member-created run stamps `caller_project_ids` = ALL current workspace project ids (explicit list, not wildcard). A project added AFTER run-create is excluded though the member sees it in-UI (membership is workspace-level). Revisit member project semantics — possibly member should also map to a wildcard-equivalent given workspace-level membership, OR re-resolve at dispatch. Time-of-creation edge.
- **OP1-GAP — claude-code bypasses the SCOPE ceiling entirely.** `ccExecute` spawns the `claude` CLI; its CLI tool calls do NOT route through `executeTool`, so the scope intersect doesn't constrain claude-code runs. (The PROJECT clamp IS now inherited via the narrowed token the ephemeral MCP token copies — fixed in Task 9 — but only for CC's MCP-callback tools, not its native CLI tools.) Consistent with the spec's "existing 20 tools via executeTool" scope + the CLI-not-SDK choice. Track for a future phase if claude-code becomes a delegated customer surface.

## Phase-op-2 (token-scoped config write surface)
- **OP2-F1 — ✅ CLOSED `dffbb60` (2026-06-01).** Was: the token-create modal offered the 4 now-dead scopes + never offered `config:write`. `/code-review high` PROMOTED this from cleanup to CRITICAL (the mint-ceiling fix 403'd the dead scopes → owner couldn't mint a token at all). Fixed: modal offers `config:write` + drops the 4; `requireScope('config:write')` accepts the 4 legacy scopes as aliases (`CONFIG_WRITE_LEGACY_ALIASES` in `bearer.ts`) so existing tokens keep working — no migration. Security-reviewed: alias structurally confined to `config:write`, cannot leak to any other scope; mint stays strict (can't MINT the old scopes).
- **OP2-F2 (dryRun hygiene) — ✅ CLOSED `0b4747d` (2026-06-01).** `/code-review` findings: dryRun flag leaked into live PATCH response/event-changes; dryRun create resource shape diverged from live; DELETE bypassed the single reader. Fixed: strip `dryRun` before `.set()`/response/event; wrap create resource to match live; `isDryRunDelete(c)` helper across all 5 DELETE handlers. Reviewed APPROVED.

## Agent-onboarding DX (cold external-agent test, 2026-06-02)
A real cold external agent oriented on the live instance over MCP in **2 tool calls** (8/10). Full findings: `docs/superpowers/specs/2026-06-02-agent-onboarding-dx-findings.md`. Backlog (none blocking; #1/#3 feed the Phase-3 `folio` skill):
- **AGENT-DX-1** — `relation` field exposes raw target-table ID (`table:<id>`), not a slug; agent had to reverse-map. Resolve to a slug/name on the agent-facing surface (`list_fields` + frontmatter).
- **AGENT-DX-2** — `status: null` ambiguous (unset vs N/A); document semantics in the skill.
- **AGENT-DX-3** — no surfaced "who am I / what is this instance" entry; `get_agent_self` exists but nothing steers a cold agent to it. = the Phase-3 `folio` skill + memory job (+ a cheap description tweak).
- **AGENT-DX-4** — test/junk records indistinguishable from real (dev-DB hygiene + maybe a draft/archived convention).
- **AGENT-DX-5 (mild)** — `describe_workspace` lists the `runs` table but `list_documents` can't read it; description already steers correctly, optional annotation.

---

- **SSE event-stream connection fan-out — deliberate v1 simplicity tradeoff, revisit only if many live panels coexist.** (Logged 2026-06-01 from a frontend quality audit.) `useEventStream` (`apps/web/src/lib/api/event-stream.ts:62`) opens ONE `EventSource` per consuming hook — each with its own server-side `kinds`/`project`/`parent` filter (no client-side stream pool/demux). With the activity feed + provider-health banner + reactor banner + runs panel + document slideover + comments tab open at once, that's ~5+ concurrent connections to the same workspace. **This is BY DESIGN** (the hook docstring: "there is no unfiltered firehose by design") and fine at current scale — browsers multiplex over HTTP/2 to one origin. NOT a bug, NOT urgent.
  **The audit's "HIGH cache-key mismatch BUG" was a FALSE POSITIVE** — the id-for-SSE-filter / slug-for-cache-key split (`use-live-documents.ts:13-16`) is the *correct fix* (shipped this session as `bb6da69`), not a defect. Recorded here so it isn't re-raised as a bug.
  **Decision needed:** none now. Upgrade trigger = if a future view holds many simultaneous live panels (or hits browser per-origin connection limits), introduce a single shared workspace EventSource that fans out to subscribers by filter. Until then, leave as-is.
  **Two genuinely-real micro-follow-ups in the same file (≤2 lines each, next-touch):** (a) add an `es.onerror` handler — a dropped/failed stream is currently fully silent; (b) `console.warn` in the malformed-frame `catch {}` (`event-stream.ts:68`) instead of swallowing. Both minor; defer to next time that file is touched.
  **Source:** Frontend event/SSE audit, 2026-06-01. Routing/auth/shell + react-query data layer both audited CLEAN in the same pass (no action).

---

- **Invariant 6 soft spot — 3 web sites hand-build react-query keys instead of calling the factory.** (Logged 2026-06-02 by the invariant-auditor during the ARCHITECTURE-INVARIANTS.md authoring pass.) `apps/web/src/lib/api/documents.ts:190` (`['document-events',…]` → should be `documentEventsKeys.list(...)`; the line above even comments "shape mirrors documentEventsKeys.list()"), `apps/web/src/lib/api/projects.ts:78`, and `apps/web/src/routes/w.$wslug.tsx:301` (both `['documents', wslug, pslug, 'list']` → `documentsKeys.list(...)`). Risk: invalidation drift — if a factory's key prefix changes, these literals silently stop matching and live invalidation breaks (the same class as the SSE id-vs-slug bug). **Decision needed:** FIX NOW (one ~6-line commit replacing the literals with factory calls) or DEFER to next-touch of those files. **Recommendation:** DEFER — low severity, pre-existing, not on the current branch's surface; fold into the next web-data change in those files. Not a bug today, a drift risk. (surfaced during ARCHITECTURE-INVARIANTS.md authoring, 2026-06-02)

---

- **OP3-F1 — `folio_api` medium-tier config writes auto-apply with no dryRun default.** (Logged 2026-06-02 by the Task-5 code-quality reviewer.) The `folio_api` write tool dispatches medium-tier writes (tables/fields/views/statuses/projects, incl. config DELETEs like `DELETE …/views/:id`, `…/tables/:id`) immediately, without injecting `dryRun` — the doc comment frames medium as "auto-with-dryRun-as-undo" but the agent must opt into dryRun itself. So a prompt-injected operator could hard-delete a table/view/status definition in one un-confirmed call. **Mitigating:** requires a `config:write` (owner/admin-equivalent) token — members can't reach the write bridge at all; the caller-ceiling intersection still holds. **Decision needed:** when the approval-gate PAUSE side lands (Phase 3.x, the `TODO(approval-gate)` in `folio-api-tool.ts`), default destructive medium verbs (config DELETE) to dryRun-first or route them through `request_approval`. **Recommendation:** DEFER to the approval-gate phase — the scope wall bounds the blast radius for v1; tightening medium belongs with the pause-and-approve machinery, not a standalone change. (Source: Phase-op-3 Task 5 review.)

---

- **C3-CC-1 — the unattended MEDIUM floor (C3) does NOT cover the `claude-code` provider path.** (Logged 2026-06-02 by the Phase C Task 3.5 code-quality reviewer; verified against source by the controller.) The C3 fired-path MEDIUM floor (`folio_api` refuses MEDIUM config writes on an `unattended` run) is enforced in `runLoop` → `executeTool` with `ctx.unattended` — the **API-provider** path. A trigger-fired run on the **`claude-code`** provider executes via `ccExecute` (`runner.ts:1064`), whose `folio_api` tool calls round-trip through `routes/mcp.ts:172`, which has NO run context and passes `executeTool(... { callerScopes: token.scopes })` with **no `unattended` flag** → the call is treated as ATTENDED → a fired cc-run's MEDIUM config write would DISPATCH, not refuse. So the deterministic C3 bound is **incomplete on the cc path**. **Mitigating:** the cc backend is **OFF by default** (`FOLIO_CLAUDE_CODE_ENABLED=false`; `runner.ts:544` refuses cc runs when off), and the caller-ceiling (scopes ∩ callerScopes, projects ∩ caller) + the HIGH floor still hold on both paths — only the MEDIUM *fired-path* floor is bypassed, and only when cc is explicitly enabled. **Decision (Stefan 2026-06-02): ACCEPTED RESIDUAL / DEFER.** This task's threading is correct + complete for the API (default) path. cc-path recovery is a separate, non-trivial fix — `routes/mcp.ts` would have to resolve the `cc-run:<runId>` token back to its run frontmatter and thread `fm.unattended` into `executeTool` — and it benefits only a default-OFF provider with known v1 stateless-token gaps (see `project_claude-code-runner-cli-not-sdk`). **Fix trigger:** before `FOLIO_CLAUDE_CODE_ENABLED` is turned on for any customer running unattended triggers, OR alongside the approval-gate PAUSE work (Phase 3.x). Options: (a) recover `unattended` from the cc-run token in mcp.ts; (b) floor MEDIUM unconditionally for cc runs (over-refuses human-invoked cc too, but fail-safe). (Source: Phase C Task 3.5 review.)

---

- **C3-CC-1 SUPERSEDED → CC-DISABLED-1: claude-code HARD-DISABLED (Phase C shake-out, `a5d0966`).** The Phase C shake-out (security-sentinel) found the cc provider path bypassed BOTH the C3 unattended floor (S-1) AND the agent∩caller scope ceiling (S-2): cc spawns the `claude` CLI, which re-enters via `/mcp` (`routes/mcp.ts:185` passes `callerScopes: token.scopes` → a no-op intersect; no `unattended` flag), so a trigger-fired cc library agent runs unfloored + with the agent's FULL scopes (not caller-bounded). **Stefan's call: "claude-code doesn't work, hard-disable it."** FIXED by making `runner.ts` preflight refuse ANY `claude-code` run regardless of `FOLIO_CLAUDE_CODE_ENABLED` → `ccExecute` is unreachable from both `runAgent` + `runAgentResume` → S-1/S-2 unreachable BY CONSTRUCTION. `claude_code_enabled` is reported `false` to the UI always. The provider enum stays valid (historical rows parse; they fail at preflight). **REVIVAL GATE (do NOT re-enable cc until done):** thread run-derived authority (`unattended` + caller-narrowed scopes) onto the `cc-run:` minted token so the `/mcp` re-entry enforces the floor + the agent∩caller ceiling — OR keep cc dead. Re-enabling without this reopens S-1/S-2 (CRITICAL). The earlier accepted residual C3-CC-1 (cc-path MEDIUM floor gap) is rolled into this — the gap is no longer reachable, so C3-CC-1 is closed-by-disable. (Source: Phase C shake-out, 2026-06-02.)

## 2026-06-03 — Ollama provider setup (ad-hoc, no plan)

- **Finding:** Provider config (e.g. adding Ollama) has no operator path that works end-to-end. The Settings → AI UI can't express a keyless provider or a loopback base_url, so an AI/human asked to "add a provider" falls back to direct DB seeding.
  **Decision (YES/NO):** Do we scope a product fix so "add/remove a provider" is a routine UI (or agent-drivable API/MCP) operation — covering keyless-provider state, a loopback affordance gated on `FOLIO_ALLOW_LOOPBACK_AI`, and the provider→agent model binding?
  **Changes if YES:** `apps/web/src/components/settings/ai-tab.tsx` (keyless + conditional loopback help), a documented settings/`folio_api` route for agents, and a place that ties `ai_keys.provider` to an agent's `frontmatter.model`.
  (surfaced by docs/superpowers/retros/2026-06-03-ollama-provider-setup-retro.md)

- **Finding:** The AI tab hardcodes "Loopback addresses (localhost, 127.0.0.1, private ranges) are rejected" even on a self-hosted install where the env flag now permits loopback for Ollama — the UI lies to the operator.
  **Decision (YES/NO):** Make that help text conditional on `FOLIO_ALLOW_LOOPBACK_AI` (server-exposed to the client) instead of a hardcoded dead-end?
  **Changes if YES:** `apps/web/src/components/settings/ai-tab.tsx:233` + a small server-config endpoint exposing the flag.
  (surfaced by docs/superpowers/retros/2026-06-03-ollama-provider-setup-retro.md)

## 2026-06-03 — agent-authority+skills /shakeout deferred cleanups (SHOULD/NICE, non-blocking)

Reviewer pass (5 agents) on `8a6e79c..HEAD`. The one SECURITY finding (set_skill_trust
unattended-floor gap) was FIXED in `a20c882`. These remain, deferred with user OK:

- **Skill-resolution triplication** (simplicity + architecture, SHOULD): the
  `(__system, skills project, type=page)` resolve is hand-written in 3 places —
  `loadAgentDefinition` (runner.ts), `get_skill` (agent-tools-registry.ts),
  `setSkillTrust` (skill-trust.ts). Invariant 11's safety argument rests on them
  matching "exactly" — currently reviewer-enforced, not code. Extract
  `resolveSystemSkillDoc(db, slug)`. Promote the `'skills'` project slug to a const.
- **Operator agentId-under-null-reach carve-out not asserted** (security + arch, SHOULD):
  `(workspaceId null, agentId set, createdBy null)` holds by construction but no guard
  enforces it. Consider a boot-time/DB assertion `agentId NOT NULL AND workspace_id
  NULL ⟹ created_by NULL`. (Doc note added to invariant 11 area.)
- **markdown-PATCH duplicates trusted-preservation** (simplicity, SHOULD): the inline
  strip+re-carry in routes/documents.ts mirrors updateDocument's logic — drift hazard.
  Route markdown PATCH through updateDocument OR a shared mergeManagedSkillTrust helper.
- **pathToScope regex-shadow → dispatch-through-route** (the standing deferred refactor):
  when it lands, drop the dead members:write/settings:write branches rather than porting.
- **api_tokens.agent_id index** (perf, NICE): unindexed findFirst by agentId at boot +
  per operator-run. Trivial at single-team scale.
- **zod schema ↔ hand-written inputSchema duplication** (NICE): consider zod-to-json-schema.

## 2026-06-06 — Multica-evaluation security audit (ARCHITECTURE-INVARIANTS sharpening)

Triggered by an external architecture evaluation (Folio vs Multica). The evaluation's
security recommendations mostly described Folio's EXISTING model (scoped capability tokens,
per-agent identity, unified MCP↔REST authorization — all already enforced). An SSE+MCP
authorization audit narrowed it to two real residual items, both now NAMED in
ARCHITECTURE-INVARIANTS.md (invariant 12 + sharpened invariant 5; MCP-credential watch-item
in gaps). These are the close-tracking entries the doc points to:

- **Finding (invariant 12 — irreversible-op confirm gate is surface-coupled):** the Task-7
  confirmation gate (`effectiveRiskTier` + `pending_ops` + choice_card at `executeTool`)
  engages ONLY when `caller.conversationId` is set (cockpit chat). A headless MCP
  `tools/call` carries no conversationId → the gate is SKIPPED → high-risk ops fall back to
  scope-only authority (invariants 2 + 7). Acceptable for trusted first-party admin
  automation today; the property should be owned by the OPERATION's risk tier on every path.
  **Decision (YES/NO):** make `effectiveRiskTier` the sole decider on every path
  (conversation / headless MCP / trigger-fired), with a needed-but-impossible confirmation
  (no human present) becoming a fail-closed REFUSAL — the way `unattendedFloor` already
  refuses trust-elevation (invariant 11) — instead of a silent fall-through to scope-only?
  **Changes if YES:** `apps/server/src/lib/agent-tools.ts` Task-7 gate — decouple from
  `caller.conversationId`; add a no-human refusal branch for high-tier ops on headless/
  trigger paths; threat-model the change (security boundary). `routes/mcp.ts` carries no
  conversation context, so the refusal (not a fall-through) is the headless contract.
  (surfaced by the 2026-06-06 SSE+MCP authorization audit.)

- **Finding (invariant 5 — emit-label fidelity):** `emitEvent` trusts each mutation handler
  to pass the correct `workspaceId`/`projectId`. Subscription-time filtering (`routes/events.ts`)
  blocks the LEAK but a mislabeled event is durably stored + replayed under the wrong scope.
  Residual is LOW; the check belongs at every `emitEvent` call site, not only at subscription.
  **Decision (YES/NO):** audit all ~16 `emitEvent` call sites to confirm the emitted scope
  label is derived from the same `requireResource`/`canSeeProject` decision that authorized
  the write (not a re-supplied/stale/null value), and/or assert it structurally in
  `txWithEvents`?
  **Changes if YES:** grep every `emitEvent`/`txWithEvents` caller; where the label is a free
  variable, derive it from the authorized resource. Optionally a dev-mode invariant in
  `lib/events.ts` that the event's scope matches the row's scope.
  (surfaced by the 2026-06-06 SSE+MCP authorization audit.)

- **Watch-item (MCP credential lifecycle — NOT a fix-now):** MCP auth is a static long-lived
  bearer token; no OAuth-style / capability-handshake / short-lived-grant flow. Enforcement
  is fine (scopes route through `executeTool`); lifecycle is the gap. Revisit when MCP usage
  broadens beyond trusted first-party clients. Recorded as a gap in ARCHITECTURE-INVARIANTS.md,
  no decision pending.

- **[2026-06-06, from /code-review on operator fixes d35c067] HTTP-route autonomy-gate gap (PRE-EXISTING, design decision).**
  routes/documents.ts (JSON + markdown PATCH) and routes/workspace-documents.ts (PATCH/DELETE) call create/update/deleteDocument with `actor: user` and NO `eventActor`. These routes are agent-PAT-reachable; for a bearer agent token `attachUser` sets `user` = token.createdBy (a human), so the events emit a HUMAN actor → `isAgentOriginated` (trigger-matcher.ts:153, keys on `agent:` prefix) is FALSE → the autonomy gate does NOT suppress an agent's HTTP-driven write. NOT introduced by d35c067 (which only touched the runner/MCP plane); the HTTP plane has always had this shape. The markdown PATCH path open-codes the update + emitEvent (never hits the service layer), so threading eventActor into the service wouldn't even cover it.
  **Decision needed:** should HTTP agent-PAT writes be chain-suppressed at all? If YES → thread eventActor through these routes (and the markdown branch) OR reject agent PATs on them. If NO (agents are expected to drive via MCP only) → document the boundary. Same locked-`FOLIO_AGENT_CHAINS_ENABLED` question — don't fix blind.
  **Source:** /code-review (max effort) on d35c067, finding #4.

- **[2026-06-06, from /code-review] Structural: `eventActor` optional-with-human-default is a silent-omission trap.**
  The FK-actor vs event-actor split is an optional `eventActor?: string` defaulting to `actor.id`, threaded through 3 service signatures + 6 call sites + ~9 emitEvent lines with no enforcement. A FUTURE write service (or new call site) that forgets `eventActor` defaults to the FK-valid human → the autonomy gate silently stops firing for that agent path, no compile error. **Better shape:** a single richer actor object carrying both `fkId` and `eventIdentity`, derived once at the registry boundary, so omission is impossible. Worth doing before a 4th write service inherits the default.
  **Source:** /code-review finding #7.
  **RESOLVED 2026-06-07 (Cluster 1, `f1d98c8..HEAD` on `fix/operator-identity-cleanup`).** `eventActor` is now a REQUIRED param on `create`/`update`/`deleteDocument` (`apps/server/src/services/documents.ts:495/807/1102` — `eventActor: string`, not `?:`), so omitting it is a COMPILE error — the silent-omission trap is structurally closed. The "richer single actor object" remained unbuilt (not needed: required-param enforcement was sufficient to make omission impossible).

- **[2026-06-06, from /code-review] ROOT (architectural): the operator's synthetic identity lives in an FK-shaped field.**
  `OPERATOR_AGENT_ID` ('operator:_operator') is a non-UUID sentinel deliberately stored in `token.agentId` (FK-shaped), forcing every consumer to special-case it (d35c067's resolveAgentDocForToken) OR null it (dispatchAsCaller, 9a72162). TWO remediations for one design choice, in two files — the fork widens with every new `agentId` consumer. **Highest-leverage follow-up:** decide the operator's token identity in ONE place — either null the agentId everywhere + an explicit `isOperator`/operator-marker on the token, OR resolve the sentinel once at mint/loadContext so no downstream consumer ever sees a non-FK agentId. Collapses the whole class.
  **Source:** /code-review finding #8 (altitude).
  **RESOLVED 2026-06-07 (Cluster 2 "Shape B′", `f1d98c8..HEAD` on `fix/operator-identity-cleanup`).** Chose the explicit-marker path: the FK-shaped `OPERATOR_AGENT_ID`-in-`agentId` sentinel is GONE. The operator's ephemeral token now carries `agentId: null` + an explicit, **non-persistable** `isOperator: true` marker on a new `EphemeralToken = ApiToken & { isOperator?: true }` type (`apps/server/src/db/schema.ts`), set ONCE in `createConversationRun`. The `dispatchAsCaller` FK-null-hack was removed, and the two resolvers (`resolveAgentDocForToken`, `resolveCallingAgent`) both key on `token.isOperator` FIRST — one identity decision, no per-consumer sentinel handling. The seam (`RunContext.token`, `ToolContext.token`, `executeTool`) is now typed `EphemeralToken` so a future `{...token}` spread that drops the marker is a compile error. `OPERATOR_AGENT_ID` survives ONLY as the synthetic *document* id (`getOperatorDocument().id`, for author attribution) — never a token/FK value. **Key correction:** the original finding's Shape-B framing ("the operator's createdBy") was FALSE — the operator's `createdBy` is the real human CALLER (caller-bounded authority); the correct fix was the explicit non-persistable marker, NOT keying off createdBy (`isOperatorToken`, the createdBy-based helper, is unrelated and was explicitly NOT used for resolution).

- **[2026-06-06, /shakeout simplicity finding] Dedup the confirm-gate "propose" half across `agent-tools.ts` ⟷ `folio-api-tool.ts`.**
  The record-pending-op → emit confirmation `choice_card` → emit "confirmation required" `tool_step` → `throw forbidden` block (incl. the `if (!ctx.confirmerId) throw` guard + the two-option Yes/cancel card) is copy-pasted verbatim across the native-tool gate and the folio_api gate; only the prompt/op/target differ (already values). A future M7 hardening of the confirm card must be made twice and can drift. Extract one `proposePendingOp(sink, {conversationId, confirmerId, op, params, target, prompt})` helper returning the `forbidden:` throw; both sites call it. The *execute-recorded* half legitimately differs (handler vs HTTP re-dispatch) — leave it. Not done in the shake-out pass (it touches the confirm-gate trust flow → wants its own focused change + threat-model note).
  **Source:** /shakeout simplicity reviewer, SHOULD-FIX.

- **[2026-06-06, /shakeout perf finding] Add a reaper for terminal `pending_ops` rows.**
  The `pending_ops_lookup_idx` (added in the shake-out, migration 0032) closes the hot-path scan cost, but `expired`/`rejected`/`executed` rows still accumulate forever (only status-flipped, never deleted) — the table and disk grow unbounded. Add a boot-time or reconciler-piggybacked `DELETE FROM pending_ops WHERE status != 'pending' AND created_at < now()-Nd` (mirror `sweepOrphanedFolioApiTokens`). Deferred — the index alone keeps the lookup O(matching-conversation-rows) regardless of dead-row count, so this is disk-hygiene not a perf cliff.
  **Source:** /shakeout perf reviewer, NICE-TO-HAVE.

- **[2026-06-06, real-BYOK smoke] Confirm gate fails the run with `provider_error` instead of pausing cleanly for approval.**
  Drove "set up a CRM" through the cockpit on merged main (real Anthropic key). The operator oriented, then correctly fired the irreversible-op confirm gate for `POST /api/v1/w/qa/projects` (config:write = high-tier): recorded a `pending_ops` row (status: pending) + emitted the choice_card ("Yes, do it" / "Cancel"). The CRM project was correctly NOT created (gated). ✓ Security + gate work.
  **BUG (UX):** after emitting the card, the gate does `throw new Error('forbidden: … requires confirmation')` (folio-api-tool.ts:432 AND agent-tools.ts:445), which `isFatalToolError` (runner.ts:1843) classifies FATAL → `failRun(provider_error)`. So the turn ends as **"The operator could not finish this turn (provider_error)"** and the run is marked FAILED — right after asking the user to confirm. Expected: emit card → END THE TURN CLEANLY awaiting approval (the way `ask_choice` was fixed in 17cb41d / set askedChoice), NOT fail the run. The pending_op IS recorded so clicking Yes should still work, but the framing tells the user it failed.
  **Fix direction:** treat the confirm-gate `forbidden: … requires confirmation` throw like `ask_choice` (clean turn-end / awaiting_approval state), not like a fatal scope denial. Both gate sites (native dispatcher + folio_api self-tiered) need it.

- **[2026-06-06, real-BYOK smoke] Cockpit does NOT auto-resume an in-progress conversation on page reload.**
  cockpit-chat.tsx supports `conversationId` (resume), but a fresh load with none starts blank ("How can the operator help?"). So an in-progress conversation — e.g. one paused on a confirm card — is not restored on reload; the user can't get back to click the pending confirm card via a reloaded page. Lower priority, but it compounds the confirm-gate UX (a user who reloads loses the card). Consider auto-loading the most-recent active conversation on mount.
