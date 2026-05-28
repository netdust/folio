# Sub-phase C Readiness — Handoff

**Date:** 2026-05-28 (end of Sub-phase B, before C starts)
**Branch:** `phase-3/agent-runner` at the round-7 + retro close
**Author:** Controller, post-`/evaluate`
**Status:** READY FOR HUMAN REVIEW before any code or planning starts

---

## Why this doc exists

Sub-phase B shipped in 6.5 hours: 42 min of implementation, 5h27m of review-fix cycles across 7 rounds. The retro pinned the root cause: **no threat model at plan-write time** for a BYOK/URL/auth-grant surface. Sub-phase C is larger and more error-prone:

- **13 tasks vs B's 7.**
- **Stateful**: state machine, recursion guards, crash recovery, token budget, concurrent claim race.
- **Cross-cutting**: services → dispatcher → runner → poller → trigger handlers, each consuming the previous.
- **New attack surface**: `agent_run` row data exfil (prompts + tool args can contain workspace secrets), runner outbound HTTP (chains and fan-out), MCP transaction boundaries (runner is the MCP tool dispatcher's main caller), token-budget bypass.

If we plan C the way we planned B, we will spend 12-15 hours in review cycles. If we plan it the way Sub-phase A was planned (clean plan, ~50 min total) we have to do the threat-modeling and the split-by-layer FIRST.

This doc decides the shape. It does NOT plan the tasks. Planning sessions consume it as input.

---

## Decisions made (per `/evaluate` follow-up + user confirmation)

### 1. Split into 3 sub-sub-phases by LAYER

| Sub-sub-phase | Tasks | Scope summary | Why this layer |
|---|---|---|---|
| **C.1 — Services** | C-1, C-2, C-3, C-4, C-5, C-6 | `services/agent-runs.ts` — createRun, transitionRun, getActiveRun, getPendingApprovalRun, listRuns, claimNextPlanningRun, recoverOrphanRuns, countPendingPlanning, checkRunRateLimits, checkChainGuards, checkProviderHealth, getProviderHealth, ensureRunsTable, chain_id helper. All pure functions over the DB. State machine validation lives here. No side effects beyond DB writes + event emission. | Most testable layer. Each function is independently unit-testable with `makeTestApp()`. The state machine + concurrency contracts (orphan recovery, atomic claim) are codified BEFORE the runner consumes them. If C.1 is bug-free, C.2 and C.3 are dramatically easier. |
| **C.2 — Runner + dispatcher** | C-7, C-8, C-9 | `lib/mcp-dispatch.ts` skeleton (with `__echo` test tool only), `lib/runner.ts` `runAgent` core loop, `runAgentResume`, `rejectRun`. Consumes C.1's services. The full execution loop with provider stream + tool dispatch + budget enforcement + cancel checks. | The stateful core. This is where most novel bugs live (recursion guards, mid-stream token budget, cancel-check timing). Separating from wiring means we can review the loop logic without conflating it with poller scheduling or trigger plumbing. |
| **C.3 — Wiring + triggers** | C-10, C-11, C-12, C-13 | `lib/poller.ts`, `index.ts` wire-in (skipped in test), trigger handlers (agent.task.assigned + comment.mentioned → insert agent_run row), integration gate + first end-to-end smoke. | Glue layer. Each piece is small but the END-TO-END behavior (PATCH assignee → row appears → poller claims → runner runs → result comment posts) is the celebration moment. Splitting it from C.2 means the runner is review-closed before we test wire-up. |

**Each sub-sub-phase has its own `/integration` + `/code-review` cycle.** Each commits independently. Each has its own retro at close.

**Each sub-sub-phase extends Sub-phase B's threat model with the attacks/mitigations that layer introduces** (see §3).

### 2. Standalone threat-modeling session FIRST, before any planning

Invoke `netdust-core:threat-modeling` against the **entire Sub-phase C runner surface end-to-end**, not per-sub-sub-phase. The threat model is one artifact covering:

- `agent_run` row content as a new asset (prompts, tool args, comment threads — workspace-sensitive data)
- Outbound HTTP from the runner (provider streams; the round-7 baseUrl-via-saved-row vector still applies because the runner reads what settings.ts persisted)
- MCP tool dispatch from the runner (`executeMcpTool` — Sub-phase B closed the routes/mcp.ts attack surface but the runner becomes a NEW caller path)
- Concurrent run claim race (two pollers racing on the same planning row — Sub-phase B never had concurrency)
- Crash recovery semantics (`worker_started_at` orphan + the `worker_crash` reason → are crashed runs distinguishable from canceled runs in the audit trail?)
- Token budget enforcement (chain-level + run-level + agent-level + workspace-level — overflow handling)
- Recursion / fan-out limits (chain_id-based: max depth, max chain duration, max chain tokens)
- Approval/rejection flow (kind=plan → human approves/rejects → resume_of chain — what's the auth model for approval comments?)
- Cancel semantics (a kind=cancel comment vs an explicit DELETE — does the runner check both?)
- Provider degraded-health flag emission (round-7 mitigation 5 covered error messages; C-5 adds health tracking — new metadata-emission surface)

Output: a single `## Threat model` extension to `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` covering Sub-phase C, sitting alongside the existing 22-mitigation Sub-phase B threat model. Sub-phase C inherits mitigations 1-22 from B and adds 23-N for runner-specific attacks.

**Commit the threat-model extension as a standalone plan-correction BEFORE any C task starts.** Per the new pre-dispatch security check (Sub-phase B retro Recommendation 1).

### 3. Action right now: this doc, then threat model, then plans

Order:
1. **Now**: this readiness handoff (you're reading it)
2. **Next**: user reviews + approves the split shape + threat-model scope
3. **Then**: standalone threat-modeling session → single plan-correction commit extending the plan
4. **Then**: planning session for C.1 (services layer) → plan-correction commit expanding C-1..C-6 into the full "Steps + Files + Tests" format (per the plan's existing convention from B-1..B-7 and A-0..A-4b)
5. **Then**: execute C.1 via `ntdst-execute-with-tests` per the existing harness convention
6. **`/integration` + `/code-review` + `/evaluate` between C.1 and C.2** — never start C.2 with C.1 unverified
7. Repeat 4-6 for C.2 (runner) and C.3 (wiring)
8. After C.3 closes, the entire Sub-phase C is done; the "first agent does work" smoke from C-13 fires; then Sub-phase D plan-writing begins (with another threat-modeling check for D's MCP-parity + admin-stats surfaces)

---

## Sub-phase B threat-model inheritance

The 22 mitigations from Sub-phase B carry forward unchanged. Sub-phase C must NOT re-litigate them. Specifically:

**Mitigations that bind on Sub-phase C code:**

- **#1 (validatePublicUrl)** — runner consuming a persisted ollama baseUrl reads from the same `aiKeys` table; the round-7 mitigation says POST /ai-keys validates baseUrl AND requires it for ollama. C MUST trust the persisted row's baseUrl already passed validation — no re-validation needed in the runner.
- **#5 (sanitized error messages)** — every provider stream error in the runner MUST route through `sanitizeProviderError`. Already covered for stream/testKey at the provider layer. The runner's error_reason field that lands in agent_run rows MUST NOT include raw SDK strings.
- **#6 (ProviderEvent.done.reason)** — agent_run_schema now accepts `refusal` and `pause_turn` (round-7 #2 widened it). Runner persists `done_reason` to distinguish refusal from clean completion.
- **#8 (JSON.parse hardened in providers)** — covered at the provider layer.
- **#9 (coerceTokenCount)** — covered at the provider layer for the stream → `tokens` event path. Runner only reads the event; doesn't need to re-validate.
- **#10 (proxy cache)** — covered at the provider layer.
- **#11 (requireSessionUser)** — agent_run is NOT an auth-grant mutation surface, so runner-created rows don't need this gate. BUT if Sub-phase C adds new routes (HTTP endpoints for cancel/retry — those are in D-1), those routes MUST use requireSessionUser. Defer to D.
- **#17 (web honest-toast)** — not applicable to C (no web changes in C).
- **#19 (HTTP agent-lifecycle gate)** — not applicable to C (no agent-CRUD routes change in C).
- **#22 (members PII narrowing)** — already shipped; runner reading members should call the existing narrowed endpoint, not re-implement.

**Mitigations that don't apply to C:**
- #2, #3, #4 (BYOK + persistence-symmetry baseUrl) — done.
- #7 (Sub-phase A specific).
- #12, #13, #14, #15 (URL allow-list specific).
- #16 (`__INTERNAL_TEST_ONLY__`) — applies if C adds new test escape hatches; otherwise stable.
- #18 (empty-host) — done.
- #20 (workspace POST session-only) — done.
- #21 (workspace PATCH/DELETE) — done.

---

## What the threat-modeling session MUST surface for Sub-phase C

Concrete attack/mitigation pairs the session should produce. This is NOT the threat model itself — it's the menu the threat-modeling skill should produce mitigations against:

### New asset: agent_run row content

**Attacks to consider:**

- **A23 Cross-workspace `agent_run` read** — workspace member of A reads agent_run from workspace B via a missing scope check. Today's documents scope check should cover this, but the runs table is a special-case (created via `ensureRunsTable` per project). Verify.
- **A24 Cross-project agent_run read by project-narrowed agent** — an agent with `frontmatter.projects: ['p1']` reads agent_run rows from `p2` via the documents API. F3 narrowing in events.ts is the precedent; runs need the same.
- **A25 Agent prompts include workspace secrets** — prompts can reference document content via `[[wiki-links]]`; if the runner inlines that content into the LLM request, secret docs end up in the LLM provider's logs. Threat: a prompt-injection that nudges the agent to include `[[secrets/api-keys]]` ends up exfiltrating.
- **A26 Tool-call args include user-controlled data** — agent calls `create_document(body=<user-controlled markdown>)`. Untrusted parsing. Already covered by docs:write Zod refines; verify chain.

### New asset: runner's outbound HTTP capacity

- **A27 Chain-level fan-out DoS** — an agent recursively spawns agents (each posts a comment that mentions another agent → new run). Without `chain_id` aggregation + max-fanout cap, one prompt detonates into thousands of provider calls.
- **A28 Token-budget bypass via chain-of-runs** — an agent's `max_tokens_per_run` cap is bypassed by spawning N child runs each at the cap. checkChainGuards covers this; verify the enforcement is at the right boundary.
- **A29 Provider-degraded amplification** — when a provider is degraded (3 consecutive failures), pending runs sitting in `planning` get claimed and re-fail, burning the rate-limit retry quota and worsening the degradation. `checkProviderHealth` is read at run-start; needs to be checked at poller-claim time too.

### New asset: MCP dispatch from runner

- **A30 MCP tool args path traversal / SQLi** — agent calls a tool with attacker-supplied args. Existing tool Zod schemas in routes/mcp.ts should cover this; the runner's `executeMcpTool` MUST use the same schemas, not bypass them.
- **A31 MCP tool privilege escalation** — agent-bound bearer calls a tool that mutates auth grants. Sub-phase B closed `create_agent`/`update_agent`/`delete_agent` to reject human PATs. Runner's MCP dispatcher reads the agent's bearer to dispatch; verify the rejection still fires when the dispatcher is the caller (not the route handler).

### Concurrency

- **A32 Two pollers claim the same planning row** — `claimNextPlanningRun` is supposed to be atomic. SQLite's `BEGIN IMMEDIATE` + the UPDATE-with-where-status-still-planning pattern should suffice. Verify the test actually exercises racing pollers (not just sequential).
- **A33 Orphan recovery races with active poller** — `recoverOrphanRuns` runs at boot; if a poller is mid-flight on a row with `worker_started_at` older than threshold, the recovery transitions it to `failed` while the poller's `runAgent` is still streaming. Need to define: what happens to the in-flight stream when the row's status flips? Cancel-check polling? Token budget side-effects?

### Crash recovery

- **A34 worker_started_at not cleared on graceful shutdown** — if Folio is stopped gracefully (SIGTERM), in-flight rows stay at `running` until the next boot's recovery runs. Operator sees them as "stuck." Better: graceful-shutdown handler transitions them to a distinguishable state OR clears worker_started_at + sets back to planning.
- **A35 worker_crash error_reason indistinguishable from provider_error** — both end up as `failed`. Distinct `error_reason` values needed.

### Approval flow

- **A36 Approval-comment auth** — a comment with `## Approved` flips a pending run to `running`. Who can write that comment? Currently any workspace member with `comments:write` on the parent. Should the approval be limited to members with a specific role? Or to the agent's allowed-approvers list? Defer the policy to v1.1 but document.
- **A37 Approval comment race with rejection comment** — what if both are posted concurrently? Need deterministic ordering.

### Cancel semantics

- **A38 Cancel via DELETE vs cancel via comment** — does the runner cancel-check both? Sub-phase D will add a DELETE /runs/:id route; runner needs to honor both signal sources without double-cancel.

---

## Known unknowns to resolve during threat-modeling

1. **Tool-call args parsing**: are tool-call argument schemas validated at runner-dispatch time, or only at the MCP tool's handler? If only at the handler, a malformed args object reaches the handler before validation. Could the runner short-circuit on Zod failure before dispatch?

2. **The `chain_id` data model**: the helper `nextChainId({firedBy})` extracts the prefix from `fired_by` if present, else mints. **What's the format?** UUID + suffix? Hierarchical (`<root-uuid>:<depth>`)? The chain guards aggregate on it. Verify the format is documented somewhere.

3. **Token accounting boundaries**: per-run, per-chain, per-agent-per-hour, per-workspace-per-hour. Four levels. Which checks happen where? `checkRunRateLimits` covers workspace+agent hourly. `checkChainGuards` covers chain. Per-run cap (`max_tokens_per_run` on agent frontmatter) — enforced in the runner loop after each `tokens` event. Where does the runner persist the budget? In agent_run frontmatter?

4. **Comment kind=cancel handling**: searched for it in trigger-matcher.ts — does it exist? Or only kind=approval and kind=rejection? The plan mentions cancel-check before each tool dispatch but doesn't define the cancel signal. Could be:
   - kind=cancel comment on the parent
   - DELETE /runs/:id route (Sub-phase D)
   - Explicit `agent_run.cancel_requested_at` column
   
   Decide before runner implementation.

5. **`worker_started_at` semantics**: cleared on terminal status (per C-1). But what if the runner errors after the row is `completed`? Is the cleanup atomic with the status transition? If `transitionRun(... completed)` writes BOTH `status='completed'` AND `worker_started_at=null` in one UPDATE, then yes. Verify.

6. **MCP dispatcher transaction scope**: `executeMcpTool` may need to do multi-statement DB work (e.g., `create_document` inserts a row + emits an event). Does the dispatcher own the transaction? Or does the runner pass one in? Pattern from B's services suggests tx-first signature.

7. **Provider stream + SSE delivery**: the runner consumes the provider stream. The events emitted to clients (kind=comment posted on parent) go through the existing event bus + SSE. Are SSE consumers backpressured? Can a slow consumer cause the runner's event-emission to block?

8. **Token budget overflow handling**: when the budget is exceeded mid-stream, does the runner:
   - Cancel the provider stream (abort the upstream connection — round-7 #8 finally-cleanup covers this)
   - Persist `error_reason='budget_exceeded'` AND `tokens_in/out` reflecting actual consumption
   - Emit a partial result comment so the user sees what the agent produced before hitting the cap

---

## Sub-phase C planning session deliverables (after threat model lands)

For each of C.1, C.2, C.3, the planning session produces:

1. **Expanded task bodies**: each C-N gets the full "Steps + Files + Tests + Commit" format that B-1..B-7 had. The plan currently has scope summaries only; planning expands them.
2. **Threat-model coverage section**: which mitigations from B + the new C mitigations does this sub-sub-phase implement or rely on? Per-task mitigation pointer.
3. **Subagent dispatch order**: which tasks run in parallel-safe groups, which are sequential (state machine ordering).
4. **Test count expectations**: from the plan's existing `~50 new tests for Sub-phase C` budget, allocate per task.
5. **`/integration` checkpoint**: confirms green before next sub-sub-phase plan-writing starts.
6. **Test fixtures shared across the sub-sub-phase**: `makeTestApp` already exists; do we need a `makeAgentRunFixture(seed, opts)` helper? Decide.

---

## What happens at each `/code-review` round

Given Sub-phase B's experience, expectations for C:

- **Round 1 (medium)**: 5-10 findings expected if threat model is solid. If 15+, the threat model has gaps; pause and extend it.
- **Round 2 (medium)**: ≤5 findings. If anti-regression scan returns `[]` AND no NEW attack-class findings, the sub-sub-phase converges.
- **Round 3 (high or ultra)**: ONLY run if rounds 1-2 trickled. If round 3 is needed, the threat model needs a deeper rewrite, not more fixes.

**Round budget per sub-sub-phase**: 2 medium-effort rounds. Beyond that, escalate to the user — don't loop indefinitely (Sub-phase B's 7-round cycle was driven by missing threat model; with a real one we should converge much faster).

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Concurrent claim race not actually atomic | HIGH | Two pollers running the same `agent_run` row twice → duplicate provider charges + duplicate comments | C-3 test MUST race two real pollers, not mock; use Bun's structured concurrency |
| `worker_crash` indistinguishable from `provider_error` | MEDIUM | Operators triage runner bugs as provider outages | Define distinct `error_reason` values in C-1's transitionRun |
| Token budget enforcement leaks tokens past the cap | MEDIUM | Workspace silently overruns budget | Enforce AFTER each `tokens` event (per plan), test with a budget-of-1 scenario |
| Recursion via comment.mentioned infinite loop | HIGH | One agent mentioning another → chain spawn → fan-out limit reached → DoS | C-4 checkChainGuards enforces fanout cap; test with deliberate 10-agent loop |
| Approval flow auth not gated on workspace role | MEDIUM | Any commenter can approve a critical agent action | Document policy as v1.1 deferral or implement role-gate in C-9 |
| SSE consumer backpressure blocks runner | LOW | Slow client → all agent runs hang | Test runner with a stalled SSE consumer; events should fire-and-forget |
| `executeMcpTool` skeleton doesn't enforce scope check | LOW | Test tool `__echo` bypasses scope → false-positive scope tests | Skeleton MUST run the same scope-check pipeline as routes/mcp.ts |
| Test count target wrong (plan estimates ~50 new tests) | LOW | Suite delta surprises us at integration gate | Per-task allocations during planning session |

---

## Out-of-scope for Sub-phase C readiness

These are real concerns but belong to D, F, or v1.1:

- HTTP routes for runs (list, get, cancel, retry) — Sub-phase D
- MCP tools for runs (list_runs, get_run, run_agent, cancel_run, retry_run) — Sub-phase D
- Web UI for runs (runs table view, link tile on agent slideover, Cmd-K) — Sub-phase E
- Real-Anthropic Playwright e2e — Sub-phase F
- Manual QA + shake-out + branch close — Sub-phase F
- Approval-flow role gating — v1.1
- Graceful-shutdown row-cleanup — v1.1
- Per-tenant token-bucket rate limiting (vs current hourly cap) — v1.1

---

## What I need from you next

Three things, in order:

1. **Confirm the 3-way split** (C.1 services / C.2 runner+dispatcher / C.3 wiring+triggers). If you want to subdivide further or merge any, tell me.
2. **Confirm the standalone threat-modeling order** (one session covering all of C end-to-end, before any planning). If you want it per-sub-sub-phase instead, tell me.
3. **Confirm the known-unknowns list above is the right pre-threat-model scoping**. If there's a runner concern I missed, add it; if any are out of scope for v1, mark them.

After you confirm: I run `netdust-core:threat-modeling` against the runner surface using the menu in this doc as the attack inventory + the known-unknowns as forcing functions, then commit the resulting `## Threat model` extension as a standalone plan-correction. THEN planning sessions for C.1, C.2, C.3 begin.

---

## Pointers

- **Sub-phase B retro**: `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-B-retro.md`
- **Plan**: `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` — Sub-phase C tasks at lines 2916-3050; existing `## Threat model` section at ~line 51
- **Sub-phase B threat model auto-memory**: `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_phase-3-sub-phase-B-shipped.md`
- **Threat-modeling skill**: `netdust-core:threat-modeling` (opt-in per CLAUDE.md)
- **Test harness**: `apps/server/src/test/harness.ts` `makeTestApp()`
- **State machine helper from A-4**: `apps/server/src/lib/agent-run-schema.ts` `isValidTransition`
- **Event kinds for runner**: `packages/shared/src/events.ts` (Phase 3 additions from A-1)
- **Migration 0012 + 0012a**: `apps/server/src/db/migrations/` — agent_run + flipped runner-bound builtins
- **Round-7 anti-regression baseline**: server 715/0-fail, web 559/0-fail, tsc clean, 22 mitigations enforced in code
