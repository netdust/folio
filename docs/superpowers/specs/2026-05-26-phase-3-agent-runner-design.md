# Phase 3 — Agent runner + provider abstraction + runs as documents — Design

**Status:** Draft, awaiting user review
**Date:** 2026-05-26
**Author:** Stefan + Claude (brainstorming session)
**Phase:** PHASES.md → Phase 3
**Companion specs:** Phase 2.6 (Comments + tabbed slideover) and Phase 2.7 (Templates) — same brainstorming session, separate spec docs.
**Related:** `docs/PHASES.md` Phase 3, Phase 2.6 design doc (built-in triggers, comments substrate), Phase 2.5 spec (workspace-scoped agents, `requireResource`), `docs/AGENTS.md`, `docs/TRIGGERS.md`.

## 1. Goal

Make agents alive. Phase 2 + 2.5 built the declarative surface — agents and triggers exist as documents but nothing executes them. Phase 2.6 built the conversation substrate — comments are how humans and agents talk. Phase 3 ships the **runner** that ties everything together:

- A provider abstraction with four BYOK providers (Anthropic, OpenAI, OpenRouter, Ollama), all streaming.
- A **runner** function (`runAgent`) invoked by the four built-in triggers from Phase 2.6 (now flipped on by migration).
- A new document type `agent_run` representing a single agent execution; lives in a per-project, lazy-seeded `runs` table.
- Runner posts `kind=plan / comment / result / error` comments on the parent doc as it progresses.
- Two-phase approval flow with persisted state — runner pauses on `kind=plan`, resumes on `kind=approval` (or stops on `kind=rejection`).
- Token budget enforcement, delegation depth, loop prevention, BYOK key check — all the runtime contracts PHASES.md Phase 3 requires.
- **Shared MCP/HTTP dispatch helper** that both surfaces use — same code path whether an agent calls Folio from outside or the runner calls it from inside.
- **HTTP↔MCP parity rule** locked: every new resource operation ships on both surfaces.
- `[[` wiki-link autocomplete extension also wires into the body editor (the comment composer already has it in Phase 2.6).

What does NOT land:
- Streaming token-by-token render in the Comments tab (batch-write per assistant message; live streaming is v1.1).
- Hard cancel (kill in-flight HTTP); soft cancel only (next iteration check).
- Concurrent runs on the same parent + agent (coalesced — second fire no-ops).
- Slash commands (`/draft`, etc.) — dropped per Phase 3 decision.
- A workspace-wide Runs page — runs are project-scoped, viewable via the runs table.

Phase 3 acceptance can be exercised end-to-end with a real Anthropic key and an Ollama-on-localhost test. Other providers are smoke-tested with mocked responses.

## 2. Architecture principles

### 2a. The runner is a polling worker, not a synchronous call

The runner does NOT run inside the HTTP request that triggered it. Instead:

- **Trigger handlers create `agent_run` rows at `status=planning` and return immediately.** The HTTP request that started the chain (e.g. a PATCH that set `assignee=agent:foo`) completes in milliseconds.
- **A long-lived poller in the same process** scans for `agent_run` rows at `status=planning` and claims them atomically. Once claimed, the poller invokes `runAgent(agentRunId)`.
- **The poller and the trigger handlers share the SQLite DB** — the `documents` table IS the work queue. No external queue, no Redis, no sidecar (single-binary commitment preserved).

This means: trigger fires → row inserted (fast) → response returned (fast) → poller picks up row within ~1s → runner executes asynchronously.

`runAgent` itself is `async (agentRunId): Promise<void>`. It owns the claimed row through its lifecycle, writing comments, transitioning status, calling the provider, dispatching tool calls. It exits on:
- Natural completion (provider returns `done: stop`).
- Awaiting approval (run state persisted; runner exits, will be re-invoked by `builtin-on-approval` via the same poller path).
- Failure (budget, depth, no_ai_key, provider_error, cancelled, rate_limited, fanout_exceeded, chain_duration_exceeded, chain_tokens_exceeded, worker_crash).
- Rejection (caught by `builtin-on-rejection`, internal-action `reject_run` transitions row to `rejected`).

The "create a row = invoke an agent" model becomes uniform regardless of who creates the row: trigger, Cmd-K, MCP, manual UI insert — all funnel through the same poller.

### 2b. Shared MCP/HTTP dispatch

Every MCP tool also exists as an HTTP route. Both call the same service layer. The scope-check, allow-list, and parameter validation logic is in a shared helper `executeMcpTool(name, args, authContext)` so the runner can invoke MCP-style tool calls without HTTP overhead AND without duplicating scope logic.

The pattern, project-wide rule going forward:

> **Every resource operation has parity on both HTTP and MCP, and both surfaces share a service layer.** New resource operations cannot ship on only one surface.

See `Appendix B` for the full HTTP↔MCP parity table.

### 2c. Runs are documents

`agent_run` is the sixth value on `documents.type`. Runs live in the project's auto-seeded `runs` table. The standard spreadsheet UI, saved views, and SSE live-update mechanisms all work for free. Creating an `agent_run` row with `frontmatter.assignee = agent:<slug>` is itself an invocation path — the `builtin-on-assignment` trigger fires when the row is created and the runner picks it up.

### 2d. Coalesce, don't queue

If `getActiveRun(parentId, agentId)` returns a non-null row (status in `planning|awaiting_approval|running`), a new trigger fire for the same `(parent, agent)` pair is **logged and ignored**. The second event does not queue. This is the simplest mental model: one agent at a time per parent. If a reviewer needs to give the agent a fresh prompt while one is running, they cancel the first run, then post a new request.

### 2e. Defense in depth against runaway loops

A single `max_delegation_depth` check is not enough. A misbehaving trigger (especially in a "Callcenter Pack" with multiple agents wired together) can amplify load in ways the depth guard doesn't catch — wide fanout, time-window floods, cycles through human action. Phase 3 ships **six layered guards**, each addressing a different failure mode:

| Guard | Defends against | Implementation |
|---|---|---|
| `max_delegation_depth` (existing) | Linear A→B→C→… chains | Walk `parent_agent` chain; reject when depth exceeded. |
| Same-slug `fired_by` rejection (existing) | Direct cycles A→A | Trigger matcher refuses to fire when the chain contains the slug about to fire. |
| **Per-workspace run rate cap** (new) | Total-load amplification | Env `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE` (default 200). Pre-flight check counts runs created in the last hour for this workspace. Excess → `rate_limited`. |
| **Per-agent run rate cap** (new) | One misbehaving agent | `agent.frontmatter.max_runs_per_hour` (default 60). Same pre-flight pattern. |
| **Fanout detector** (new) | Tree-shaped amplification (5×5 = 25 etc.) | Each agent_run carries a `chain_id` (uuid set at the root of a chain). Counting runs sharing the same `chain_id` and rejecting when count > `FOLIO_MAX_FANOUT_PER_CHAIN` (default 25). New `error_reason: fanout_exceeded`. |
| **Chain duration + token cap** (new) | Long-running chains | Sum wall time + tokens across all runs sharing a `chain_id`. Caps via `FOLIO_MAX_CHAIN_DURATION_MS` (default 30 min) + `FOLIO_MAX_CHAIN_TOKENS` (default 1M). New `error_reason: chain_duration_exceeded` / `chain_tokens_exceeded`. |

All caps are configurable per workspace by overriding the env var via a future settings UI (out of scope for v1; env-only). Documentation in `docs/AGENTS.md` explains each.

A new `chain_id` column on agent_runs (`text`, nullable for backwards-compat with any pre-Phase-3 data — but since Phase 3 introduces agent_run, in practice every row will have a chain_id from the start). The first run in a chain gets a fresh `crypto.randomUUID()`; subsequent runs in the chain inherit it. The `fired_by` string format is reformatted to start with the chain_id: `'<chain_id>:trigger:A → builtin:on-assignment → agent:B'`. The first segment uniquely identifies the chain across runs.

**Known limitation: per-workspace fair-sharing.** The poller processes `agent_run` rows FIFO by `created_at`. A workspace that enqueues 100 runs will be served before a workspace that enqueues 1. Round-robin per workspace would fix this — deferred to post-v1 unless a customer surfaces the problem.

## 3. Data model

### 3a. `agent_run` value on `documents.type`

Migration `0009_phase_3_agent_runs.sql` widens the `documents.type` enum to include `'agent_run'` via the SQLite table-rebuild idiom. The CHECK constraint adds:

```
CHECK (
  ...prior rules...
  OR (type = 'agent_run' AND workspace_id IS NOT NULL
                         AND project_id IS NOT NULL
                         AND table_id IS NOT NULL
                         AND parent_id IS NOT NULL)
)
```

`parent_id` on an agent_run points to the work_item or page the run acts on. `table_id` points to the project's lazy-seeded `runs` table.

New indexes:

```sql
CREATE INDEX documents_runs_by_parent_idx
  ON documents(parent_id, created_at DESC)
  WHERE type = 'agent_run';

CREATE INDEX documents_runs_by_status_idx
  ON documents(table_id, status, created_at DESC)
  WHERE type = 'agent_run';

CREATE INDEX documents_runs_pending_idx
  ON documents(created_at ASC)
  WHERE type = 'agent_run' AND status = 'planning';
```

The first covers "show me all runs for this work_item" (Comments tab links). The second covers the spreadsheet UI's status-filter + sort by recency on the runs table view. The third — `documents_runs_pending_idx` — is the **poller's claim index**: a small partial index of just the `planning` runs ordered FIFO. The poller's claim query hits this index every ~1s; without the partial index, the scan would touch the whole agent_run history.

Chain aggregation queries (for fanout / chain-duration / chain-tokens guards) use `frontmatter.chain_id` extracted via SQLite's `json_extract`. To make those queries fast at scale, also:

```sql
CREATE INDEX documents_runs_by_chain_idx
  ON documents(json_extract(frontmatter, '$.chain_id'), created_at DESC)
  WHERE type = 'agent_run';
```

This is an expression index on the JSON-extracted chain_id, indexed on chain_id + recency. The fanout/duration/token aggregation queries become single index scans.

Migration `0009a_flip_runner_builtins_to_enabled.sql` (shipped after 0009 in the same release): flips `builtin-on-assignment` and `builtin-on-mention` to `enabled: true` across all workspaces (Phase 2.6 shipped them `enabled: false`). Idempotent.

### 3b. agent_run frontmatter Zod

`apps/server/src/lib/agent-run-schema.ts`:

```ts
export const RunStatusSchema = z.enum([
  'planning',           // initial; provider call hasn't run yet OR has run but agent isn't yet acting
  'awaiting_approval',  // kind=plan posted; runner exited; waiting for kind=approval
  'running',            // approved (or no approval needed); runner executing
  'completed',
  'failed',
  'rejected',
]);

export const RunErrorReasonSchema = z.enum([
  'budget_exceeded',
  'depth_exceeded',
  'no_ai_key',
  'provider_error',
  'cancelled',
  'rejected',
  'idempotency_violation',
  // Recursion guards (Phase 3 defense-in-depth):
  'rate_limited',                  // workspace or agent run-rate cap hit
  'fanout_exceeded',               // > FOLIO_MAX_FANOUT_PER_CHAIN in this chain
  'chain_duration_exceeded',       // > FOLIO_MAX_CHAIN_DURATION_MS in this chain
  'chain_tokens_exceeded',         // > FOLIO_MAX_CHAIN_TOKENS in this chain
  // Operational:
  'worker_crash',                  // process died mid-run; recovered on next boot
]);

export const AgentRunFrontmatterSchema = z.object({
  assignee: z.string().regex(/^agent:.+$/),    // required; same shape as work_item assignment
  status: RunStatusSchema,                      // also stored in documents.status column; frontmatter is the source-of-truth for display

  // Snapshot at run start (immutable thereafter):
  agent_slug: z.string(),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  model: z.string(),
  system_prompt: z.string(),
  max_tokens: z.number().int().positive(),

  // Mutated during execution:
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),

  // Invocation provenance:
  trigger_id: z.string().nullable(),            // documents.id of the trigger that fired, or null for direct invocation
  chain_id: z.string().uuid(),                  // unique per chain; inherited by descendants; root run mints a fresh one
  fired_by: z.string(),                         // chain like '<chain_id>:trigger:A → builtin:on-assignment → agent:B'

  // Lifecycle timestamps:
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),

  // Worker-claim tracking (for crash recovery):
  worker_started_at: z.string().datetime().optional(),  // set when poller claims the row; cleared when run reaches terminal state

  // On terminal failure:
  error_reason: RunErrorReasonSchema.optional(),
  error_detail: z.string().optional(),          // free-form, surfaced in UI
});
```

The `assignee` field is the load-bearing primitive. When set to `agent:<slug>` and the row is created (via any path), the `builtin-on-assignment` trigger fires.

The `documents.status` column duplicates `frontmatter.status` for spreadsheet sorting/filtering — same pattern as work_items today. The service layer keeps them in sync; updates go through `transitionRun` which writes both.

### 3c. Runs table schema (lazy-seeded)

When the runner is invoked in a project that has no `runs` table, the runner creates it transactionally before inserting the run row:

1. Insert a new `tables` row: `slug='runs'`, `title='Runs'`, scoped to the project.
2. Insert 6 `statuses` rows for the runs table: `planning`, `awaiting_approval`, `running`, `completed`, `failed`, `rejected`. Match the state machine.
3. Insert 0 `fields` rows (the spreadsheet defaults are enough — title + status + updated_at builtins, no custom columns required).
4. Insert 3 `views` rows for the table:
   - `All runs` — no filter, default.
   - `Failures` — filter: `status in ['failed', 'rejected']`.
   - `Awaiting approval` — filter: `status = 'awaiting_approval'`.
5. Emit `table.created`, `status.created` (×6), `view.created` (×3).

Steps 1-5 happen inside the same transaction as the first `agent_run` row insert. If the user manually creates an `agent_run` via the UI before any trigger has fired, the same lazy-seed path runs there too — implementation lives in `services/agent-runs.ts::ensureRunsTable(projectId)` called before the insert.

### 3d. Built-in trigger flip (Phase 2.6 → 3 boundary)

Phase 2.6 ships the four built-in triggers with this state:

| Builtin | `enabled` at 2.6 ship | Reason |
|---|---|---|
| `builtin-on-assignment` | `false` | No runner exists in 2.6; firing it goes nowhere. |
| `builtin-on-mention` | `false` | Same. |
| `builtin-on-approval` | `true` | UI surface (post the approval comment) ships in 2.6; `internal_action: resume_run` handler is a Phase 3 stub but the trigger does fire. |
| `builtin-on-rejection` | `true` | Same as above for `reject_run`. |

Phase 3 migration `0009a_flip_runner_builtins_to_enabled.sql` flips the first two to `enabled: true` workspace-by-workspace. From this migration onward, assignment + mention reliably invoke the runner.

The `internal_action` field's `resume_run` and `reject_run` handlers are wired in Phase 3's runner code — they call `runAgentResume` and the cancel/reject path respectively. In Phase 2.6 they're no-op stubs that log "Phase 3 wires runner."

## 4. Services + routes

### 4a. `services/agent-runs.ts`

```ts
ensureRunsTable(tx, projectId): Promise<Table>
  // Lazy-seed: if project already has a 'runs' table, return it; else create + seed 3 views.

createRun(tx, {
  workspaceId, projectId, tableId, parentId,
  agentId, agentSlug, triggerId, firedBy,
  provider, model, systemPrompt, maxTokens
}): Promise<AgentRunDocument>
  // Inserts agent_run row with status='planning', emits agent.run.started.

transitionRun(tx, runId, {
  newStatus, completedAt?, errorReason?, errorDetail?
}): Promise<AgentRunDocument>
  // Validates the transition is legal per the state machine.
  // Updates frontmatter.status AND documents.status atomically.
  // Emits agent.run.<new_status> event.

incrementTokens(tx, runId, { inTokens, outTokens }): Promise<AgentRunDocument>
  // Atomic update of tokens_in + tokens_out. Returns the updated row.
  // Used by the runner per provider 'tokens' event.

getActiveRun(tx, parentId, agentId): Promise<AgentRunDocument | null>
  // SELECT WHERE parent_id=? AND frontmatter.assignee='agent:<slug>'
  //   AND status IN ('planning', 'awaiting_approval', 'running')
  // ORDER BY created_at DESC LIMIT 1
  // Uses the partial index documents_runs_by_status_idx.

getPendingApprovalRun(tx, parentId, agentId): Promise<AgentRunDocument | null>
  // Like getActiveRun but status='awaiting_approval' only. Used by builtin-on-approval handler.

listRuns(tx, filter: {
  workspaceId?, projectId?, parentId?, agentId?, status?, chainId?, since?
}): Promise<AgentRunDocument[]>
  // Standard listing; supports the same filter shape as documents list.

claimNextPlanningRun(tx): Promise<AgentRunDocument | null>
  // Atomic find-and-claim. Implementation:
  //   1. SELECT ... WHERE type='agent_run' AND status='planning' ORDER BY created_at ASC LIMIT 1
  //   2. If found: UPDATE ... SET status='running', worker_started_at=now WHERE id=? AND status='planning'
  //      (the WHERE-clause status check is the optimistic-lock guard; if the row was
  //       claimed by a concurrent poller, the UPDATE returns 0 rows affected and we
  //       loop back to step 1)
  //   3. Return the claimed row, or null if nothing pending.
  // Emits agent.run.running.

recoverOrphanRuns(tx, { staleThresholdMs }): Promise<number>
  // Boot-time recovery: find runs at status='running' with worker_started_at older than
  // staleThresholdMs (default: 5 minutes). Transition them to status='failed' with
  // error_reason='worker_crash'. Returns count of recovered runs. Logged at INFO.

checkRunRateLimits(tx, {
  workspaceId, agentId
}): Promise<{ ok: true } | { ok: false; reason: 'rate_limited'; detail: string }>
  // Pre-flight: counts runs in the last hour for this workspace + this agent.
  // Returns ok if both under their caps.
  // workspace cap: FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE (default 200)
  // agent cap: agent.frontmatter.max_runs_per_hour (default 60)

checkChainGuards(tx, { chainId }): Promise<{
  ok: true
} | {
  ok: false; reason: 'fanout_exceeded' | 'chain_duration_exceeded' | 'chain_tokens_exceeded';
  detail: string
}>
  // Pre-flight: aggregates over all runs with this chain_id.
  //   fanout: count(*) > FOLIO_MAX_FANOUT_PER_CHAIN (default 25)
  //   duration: max(completed_at) - min(started_at) > FOLIO_MAX_CHAIN_DURATION_MS (default 30 min)
  //   tokens: sum(tokens_in + tokens_out) > FOLIO_MAX_CHAIN_TOKENS (default 1M)
  // Single query via documents_runs_by_chain_idx.

countPendingPlanning(tx): Promise<number>
  // Backpressure visibility: count runs at status='planning'. Logged each poll cycle.
  // Exposed via GET /api/v1/admin/runner-stats.

checkProviderHealth(tx, { workspaceId, provider }): Promise<{
  status: 'healthy' | 'degraded';
  consecutiveFailures: number;
}>
  // Reads the last FOLIO_PROVIDER_DEGRADE_THRESHOLD (default 3) terminated runs
  // for (workspaceId, provider) from the events table. If all are
  // agent.run.failed with error_reason='provider_error', returns 'degraded'.
  // Called by transitionRun on terminal transitions; emits
  // workspace.provider.degraded on the tipping edge and
  // workspace.provider.recovered when the next completed run lands after a
  // degraded state. See §6g.

getProviderHealth(tx, { workspaceId }): Promise<Record<Provider, {
  status: 'healthy' | 'degraded';
  consecutiveFailures: number;
}>>
  // One-shot snapshot for all four providers — used by the workspace SSE hook
  // on mount, before the SSE stream takes over. Exposed via
  // GET /api/v1/w/:wslug/provider-health.
```

State machine validation:

```
planning → awaiting_approval | running | failed
awaiting_approval → running | rejected | failed
running → completed | failed
completed | failed | rejected → terminal (no transitions out)
```

Any invalid transition throws `INVALID_RUN_TRANSITION` with `{ from, to }` in the error.

### 4b. `lib/runner.ts`

The runner is invoked by the poller (§4c) with an already-claimed `agent_run` row at `status=running`. The runner does NOT do its own row creation or status claim — that's the poller's job. Trigger handlers (and other "create a row" invocation paths) just insert the row at `status=planning` and return.

```ts
async function runAgent(agentRunId: string): Promise<void>
  // Called by the poller after claimNextPlanningRun has transitioned the row to 'running'.
  // The runner reads the row, executes, transitions to a terminal state, clears worker_started_at.
```

**Execution loop** (rewritten for the polling model):

```
[INVARIANT entering runAgent]
- The agent_run row exists at status='running', with worker_started_at set to now.
- The poller has already done the atomic claim.
- The runner owns this row exclusively until it reaches a terminal state.

1. LOAD CONTEXT
   Read agent_run row by id.
   Read agent doc (via agent_run.frontmatter.agent_slug + workspace_id).
   Read parent doc (via agent_run.parent_id).
   Read last 20 comments on parent (oldest first).

2. PRE-FLIGHT CHECKS (all on the pre-claimed row; on failure, transitionRun(failed, ...) and return)
   a. AI key for the agent's provider configured on workspace?
      No → fail no_ai_key, post kind=error.
   b. Delegation depth (walk agent.frontmatter.parent_agent chain) <= agent.max_delegation_depth?
      No → fail depth_exceeded, post kind=error.
   c. fired_by chain contains the agent's own slug? (loop prevention)
      Yes → fail depth_exceeded, post kind=error.
   d. Per-workspace + per-agent run-rate caps (checkRunRateLimits)
      Excess → fail rate_limited, post kind=error.
   e. Chain-level guards (checkChainGuards by chain_id)
      Fanout → fail fanout_exceeded.
      Duration → fail chain_duration_exceeded.
      Tokens → fail chain_tokens_exceeded.
      All post kind=error.

3. BUILD CONTEXT
   system = agent.body
   tools = filter(MCP_TOOLS, t => t.name in agent.frontmatter.tools)
   messages = [
     { role: 'user', content: parent.body + render(recent comments) }
   ]

4. PLANNING-OR-EXECUTION DECISION
   If agent.frontmatter.requires_approval:
     Call provider in 'plan only' mode: instruct the agent to describe what it will do
     without executing tool calls.
     Stream response, accumulate text.
     On done:
       Post kind=plan comment with body=accumulated_text, run_id=this run's id, target_agent=agent_slug.
       transitionRun(awaiting_approval) — emits agent.run.awaiting_approval. Clear worker_started_at.
       Return. [Row persists at awaiting_approval. builtin-on-approval will eventually
                INSERT a new agent_run row at planning with chain_id inherited, and the
                poller will pick it up — runAgentResume re-uses this same code path
                with a flag indicating "resume from prior plan."]
   Else:
     Proceed directly to step 5.

5. EXECUTION LOOP
   loop:
     a. CANCEL CHECK
        Fetch the agent_run row's current status from DB.
        If status != 'running', log 'cancelled mid-flight' + clear worker_started_at + exit cleanly.
     b. CALL PROVIDER
        Stream response with current messages.
        Per 'text' event: accumulate.
        Per 'tool_call' event: hold (will dispatch after stream completes per message).
        Per 'tokens' event: incrementTokens(in, out). Check sum vs max_tokens.
          Over budget → fail budget_exceeded, post kind=error, return.
        Per 'done' event: break inner loop, proceed.
     c. WRITE MESSAGE
        Per the Phase 2.6 kind taxonomy, the runner posts:
          - `kind=result` if 'done' reason is 'stop' AND no tool calls are held. Final assistant message.
          - `kind=comment` if 'done' reason is 'tool_use' (tool calls held) AND narrative text is non-empty. Mid-flight progress note.
          - `kind=error` on provider error or any pre-flight check failure.
        All runner-written comments carry `frontmatter.run_id` so they can be correlated with the agent_run row.
     d. DISPATCH TOOL CALLS
        For each held tool_call:
          tool_result = await executeMcpTool(call.name, call.arguments, agentAuthContext)
          messages.push({ role: 'tool', content: tool_result, tool_use_id: call.id })
        Continue loop.
     e. NATURAL COMPLETION
        If no tool calls were held AND 'done' reason was 'stop':
          transitionRun(completed) — emit agent.run.completed. Clear worker_started_at.
          Return.

6. CLEAN UP
   On any terminal status (completed | failed | rejected), clear worker_started_at and emit the appropriate agent.run.<terminal> event. transitionRun handles this atomically.
```

```ts
async function runAgentResume(input: { runId: string }): Promise<void>
  // Invoked by the poller when a planning row's frontmatter.resume_of points at
  // an awaiting_approval run from the same chain (builtin-on-approval inserts such
  // a row when a kind=approval comment lands).
  // Loads both rows (the original awaiting_approval run + the new planning row).
  // The new row inherits chain_id, snapshot of provider/model/system_prompt/max_tokens
  // from the original. transitionRun(awaiting_approval → terminal: rejected) on the
  // original is NOT done; the original stays at awaiting_approval forever as
  // historical record. The new row runs through the standard loop, starting at
  // step 4 with the kind=plan + kind=approval comments included in messages.
```

```ts
async function rejectRun(input: { runId: string }): Promise<void>
  // Invoked by builtin-on-rejection's reject_run internal action.
  // Loads the persisted run.
  // If status not in ['planning', 'awaiting_approval'], log + return.
  // transitionRun(rejected). Posts kind=comment from the agent: "Run cancelled by reviewer."
  // Emits agent.run.rejected. Clears worker_started_at.
```

### 4c. `lib/poller.ts` — the polling worker

The poller is a long-lived async loop started in `apps/server/src/index.ts` once per process. It claims `planning` rows and dispatches them to `runAgent`. It does NOT run the agent in its own tick — it kicks off the run with `runAgent(...).catch(logError)` (fire-and-forget) and immediately loops back to claim the next row. The runner's lifecycle is independent of the poller's tick.

```ts
import { sleep } from './utils';
import { logError, logInfo } from './lib/log';
import { claimNextPlanningRun, countPendingPlanning, recoverOrphanRuns } from './services/agent-runs';
import { runAgent } from './lib/runner';

const POLL_INTERVAL_MS = Number(process.env.FOLIO_POLLER_INTERVAL_MS ?? 1000);
const STALE_THRESHOLD_MS = Number(process.env.FOLIO_WORKER_STALE_MS ?? 5 * 60 * 1000);
const BACKPRESSURE_WARN_THRESHOLD = 10;
const MAX_CONCURRENT_RUNS = Number(process.env.FOLIO_POLLER_CONCURRENCY ?? 5);

let activeRuns = 0;

export async function startRunnerPoller(db: Database) {
  // 1. Boot recovery: any rows left at 'running' from a prior crash get recovered.
  const recovered = await recoverOrphanRuns(db, { staleThresholdMs: STALE_THRESHOLD_MS });
  if (recovered > 0) logInfo(`runner-poller: recovered ${recovered} orphan run(s) on boot`);

  // 2. Main loop.
  while (true) {
    try {
      if (activeRuns >= MAX_CONCURRENT_RUNS) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const claimed = await claimNextPlanningRun(db);
      if (!claimed) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Backpressure visibility.
      const pending = await countPendingPlanning(db);
      if (pending > BACKPRESSURE_WARN_THRESHOLD) {
        logInfo(`runner-poller: ${pending} runs pending (activeRuns=${activeRuns})`);
      }

      // Fire-and-forget — runAgent owns the row's lifecycle.
      activeRuns += 1;
      runAgent(claimed.id)
        .catch(err => logError(`runAgent failed for ${claimed.id}`, err))
        .finally(() => { activeRuns -= 1; });
    } catch (err) {
      logError('runner-poller iteration failed', err);
      await sleep(POLL_INTERVAL_MS);  // back off briefly on unexpected errors
    }
  }
}
```

Behavior summary:
- **Concurrency.** Up to `FOLIO_POLLER_CONCURRENCY` (default 5) runs execute simultaneously in the same process. Each is a separate Promise; Bun's event loop handles fan-out. Limiting concurrency prevents one workspace from saturating the provider rate limits.
- **Crash recovery.** On boot, `recoverOrphanRuns` finds rows at `status=running` with `worker_started_at` older than `FOLIO_WORKER_STALE_MS` (default 5 min) and transitions them to `failed (worker_crash)`.
- **Backpressure visibility.** Pending count logged when above threshold. Exposed at `GET /api/v1/admin/runner-stats` for ops monitoring.
- **Polling latency.** Default 1s — invisible to humans (the runs table SSE shows the row appearing instantly; the runner starts within 1s; the first kind=comment appears as soon as the first provider chunk completes).
- **Graceful shutdown.** Not implemented in v1. On SIGTERM/SIGINT the process dies; the next boot recovers any in-flight runs as `worker_crash`. v1.1 could add a signal handler that waits for `activeRuns === 0` before exiting.

### 4d. `lib/mcp-dispatch.ts` — shared dispatcher

```ts
export type McpAuthContext = {
  type: 'user' | 'agent' | 'instance_admin';
  userId?: string;          // user only
  agentId?: string;         // agent only
  scopes: string[];         // resolved scopes (token scopes for bearer; full set for session)
  workspaceId: string;      // resolved scope context
  allowedProjectIds: string[] | ['*'];  // for agents: their projects allow-list intersected with token's project_ids
};

export async function executeMcpTool(
  name: string,
  args: unknown,
  authContext: McpAuthContext
): Promise<unknown>
```

`executeMcpTool` is the single dispatcher used by:
- `routes/mcp.ts` — JSON-RPC handler resolves bearer → authContext, calls.
- `lib/runner.ts` — runner resolves the agent's authContext at run start, calls per tool_call event.

The function does:
1. Look up the tool in the registry (`apps/server/src/lib/mcp-tools.ts` — the existing registry from Phase 2 + 2.5 + 2.6 + 2.7 + Phase 3 additions).
2. Validate args against the tool's Zod schema.
3. Check authContext.scopes against the tool's required scopes. Throw `MissingScopeError` if absent.
4. Resolve target resources (slugs to ids). Check `requireResource` semantics (project allow-list intersection).
5. Dispatch to the tool's handler in the right service.
6. Return the handler's return value.

The HTTP route `routes/mcp.ts` becomes a thin wrapper:

```ts
mcp.post('/', async (c) => {
  const body = await c.req.json();
  const { jsonrpc, method, params, id } = body;
  if (method === 'tools/call') {
    try {
      const authContext = await resolveAuthContext(c);
      const result = await executeMcpTool(params.name, params.arguments, authContext);
      return c.json({ jsonrpc: '2.0', id, result: { content: serialize(result) } });
    } catch (err) {
      return c.json({ jsonrpc: '2.0', id, error: toJsonRpcError(err) });
    }
  }
  // ... other methods ...
});
```

### 4e. `lib/ai/provider.ts` — provider abstraction

```ts
export interface AIProvider {
  // Streaming chat completion with tool calls.
  stream(opts: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    maxTokens: number;
    apiKey: string;
    model: string;
  }): AsyncIterable<ProviderEvent>;

  // Health check — does this key + model combo work?
  testKey(opts: { apiKey: string; model: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type ProviderEvent =
  | { type: 'text';      delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tokens';    in: number; out: number }
  | { type: 'done';      reason: 'stop' | 'tool_use' | 'max_tokens' };

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_use_id: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: JSONSchema;  // the tool's Zod schema serialized to JSON Schema
};

export function getProvider(name: 'anthropic' | 'openai' | 'openrouter' | 'ollama'): AIProvider;
```

Four implementations under `lib/ai/`:
- `anthropic.ts` — uses `@anthropic-ai/sdk` for the streaming + tool-call API.
- `openai.ts` — uses `openai` for chat completions with function-calling.
- `openrouter.ts` — wraps the OpenAI client pointed at OpenRouter's endpoint; passes the model name through verbatim.
- `ollama.ts` — uses Ollama's HTTP API directly (no SDK; small fetch wrapper). Tool calls supported via Ollama's function-calling endpoint (`/api/chat` with `tools: [...]`).

Each implementation normalizes its provider's streaming SSE/chunked format into the common `ProviderEvent` stream. Token counts are extracted from the provider's response payload (Anthropic returns `usage` in the final chunk; OpenAI returns it via `stream_options.include_usage: true`; OpenRouter forwards Anthropic/OpenAI counts; Ollama returns per-message timing + token counts).

### 4f. `routes/ai.ts`

```
POST /api/v1/w/:wslug/ai/test-key
```

Body: `{ provider, model, api_key }`. Validates by calling `getProvider(provider).testKey(...)`. Returns `{ ok: boolean, reason?: string }`. Does NOT store the key — that's a separate PATCH on `aiKeys` which already exists from Phase 0.

### 4g. `routes/runs.ts`

```
GET    /api/v1/w/:wslug/p/:pslug/runs?status=...&agent=...&since=...
GET    /api/v1/w/:wslug/runs/:runId
POST   /api/v1/w/:wslug/runs                    -- body: { agent_slug, parent_slug, input? }
POST   /api/v1/w/:wslug/runs/:runId/cancel
POST   /api/v1/w/:wslug/runs/:runId/retry
GET    /api/v1/w/:wslug/provider-health         -- snapshot of all four providers' degraded state
```

| Verb | Behavior |
|---|---|
| `GET list` | Lists runs in a project; filterable by status, agent, time range. Auth: session or `documents:read` bearer. |
| `GET single` | One run by id. |
| `POST` | Creates a new `agent_run` doc with `status: 'planning'`, `assignee: agent:<slug>`, `parent_id: <resolved>`. The on-assignment builtin then fires and the runner picks up. Returns `{ run_id, status }`. Auth: session or `agents:write` bearer. If `input` provided, server first posts a `kind=comment` from the caller's authContext to the parent with `input` body, then creates the run — so the run has explicit user-provided context. |
| `POST cancel` | Transitions row to `failed` with `error_reason=cancelled` IF status in `planning|awaiting_approval|running`. No-op on terminal. Auth: session (workspace member) or `agents:write` bearer. |
| `POST retry` | Loads the original run, calls `runAgent` again with same `agentId`, `parentId`, but `triggerId: null` and `firedBy: 'retry-of:<old_id>'`. Idempotency check still applies: if there's an active run on the parent already, returns 409 `RUN_ALREADY_ACTIVE`. |
| `GET provider-health` | One-shot per-provider degradation state for the workspace. Returns `{ anthropic, openai, openrouter, ollama }` each with `{ status, consecutiveFailures }`. Used by the shell's `useProviderHealth` hook on mount; live updates flow via SSE thereafter. Auth: session (workspace member). |

### 4h. New scopes

Phase 3 introduces no new scopes — `agents:write` from Phase 2.6 covers `run_agent`, `cancel_run`, `retry_run`; `documents:read` covers `get_run` / `list_runs`. The runner uses the agent's own bearer scopes when dispatching tool calls.

### 4i. New MCP tools (5)

Per the parity rule, every `routes/runs.ts` verb has a twin:

| Tool | Required scope | Args | Returns | HTTP twin |
|---|---|---|---|---|
| `list_runs` | `documents:read` | `{ workspace_slug, project_slug, status?, agent_slug?, since? }` | `AgentRun[]` | `GET /api/v1/w/:wslug/p/:pslug/runs` |
| `get_run` | `documents:read` | `{ workspace_slug, run_id }` | `AgentRun` | `GET /api/v1/w/:wslug/runs/:runId` |
| `run_agent` | `agents:write` | `{ workspace_slug, agent_slug, parent_slug, input? }` | `{ run_id, status }` | `POST /api/v1/w/:wslug/runs` |
| `cancel_run` | `agents:write` | `{ workspace_slug, run_id }` | `{ run_id, status }` | `POST /api/v1/w/:wslug/runs/:runId/cancel` |
| `retry_run` | `agents:write` | `{ workspace_slug, run_id }` | `{ run_id, status }` | `POST /api/v1/w/:wslug/runs/:runId/retry` |

All five route to the same service-layer functions in `services/agent-runs.ts` (or `lib/runner.ts` for `run_agent` / `retry_run`).

Total Phase 3 MCP additions: 5.

## 5. Events

New event kinds added to `KNOWN_EVENT_KINDS`:

| Kind | Payload | Fired when |
|---|---|---|
| `agent.run.started` | `{ run_id, agent_id, parent_id, trigger_id }` | createRun completes (status=planning row inserted). |
| `agent.run.awaiting_approval` | `{ run_id, agent_id, parent_id }` | Status flips to `awaiting_approval`. |
| `agent.run.running` | `{ run_id, agent_id, parent_id }` | Status flips to `running` (either from `planning` for no-approval agents, or from `awaiting_approval` after approval). |
| `agent.run.completed` | `{ run_id, agent_id, parent_id, tokens_in, tokens_out }` | Status flips to `completed`. |
| `agent.run.failed` | `{ run_id, agent_id, parent_id, error_reason, error_detail? }` | Status flips to `failed`. |
| `agent.run.rejected` | `{ run_id, agent_id, parent_id }` | Status flips to `rejected` (from kind=rejection comment). |
| `ai.action` | `{ run_id, actor_type: 'agent', actor_id, provider, model, tokens_in, tokens_out }` | Per individual provider call (a run may have many). Counts only, no content. |
| `runs_table.lazy_seeded` | `{ project_id, table_id }` | First run in a project triggers table creation. Fires once per project. |
| `workspace.provider.degraded` | `{ workspace_id, provider, consecutive_failures, last_error_detail? }` | The last N (default 3) runs against this workspace+provider all terminated with `error_reason: provider_error`. Drives the "Agent Offline" banner in §6g. |
| `workspace.provider.recovered` | `{ workspace_id, provider }` | After a degraded state, the next successful (`completed`) run against this workspace+provider clears the banner. |

All flow through the standard event bus + the workspace-scoped SSE endpoint. New SSE filter params from Phase 2.6 (`?parent=`, `?run=`) work for these events too. Phase 3 adds:

| Param | Filters to |
|---|---|
| `?agent=<doc_id>` | Events whose payload's `agent_id` matches. Used by the agent slideover's link-tile (count of runs). |
| `?table=<table_id>` | Events whose source document is in the given table. Used by the runs table view to live-update rows. |

## 6. UI surfaces

### 6a. AI settings tab in workspace settings

`/w/:wslug/settings` gets a new "AI" tab next to the existing "API tokens" tab.

```
┌─────────────────────────────────────────────────────────┐
│ Settings — Folio                                  [×]    │
│ ────────                                                 │
│ [API tokens]  [AI]                                       │
├─────────────────────────────────────────────────────────┤
│ AI Provider                                              │
│ Provider:  [Anthropic ▾]                                 │
│ Model:     [claude-opus-4-7 ▾]                           │
│ API Key:   [______________________________]  [Test]      │
│            ✓ Key validated 2s ago                        │
│            [Save key]                                    │
├─────────────────────────────────────────────────────────┤
│ Configured Keys                                          │
│ ✓ Anthropic · last updated 2d ago · [Edit] [Remove]     │
│ — OpenAI (not configured)                                │
│ — OpenRouter (not configured)                            │
│ — Ollama (not configured)                                │
└─────────────────────────────────────────────────────────┘
```

- Provider select shows all four. Model select is a textual field with a dropdown of known models (Anthropic: claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5; OpenAI: gpt-4o / gpt-4o-mini / etc; Ollama: free-text "model name on your Ollama server"; OpenRouter: any string).
- "Test" button calls `POST /api/v1/w/:wslug/ai/test-key`. Inline validation result.
- "Save key" PATCHes the existing `aiKeys` storage (libsodium-encrypted at rest, never returned).
- "Configured Keys" section shows which providers have a key set. Per-row Edit re-populates the form for that provider. Remove clears the encrypted blob.

A workspace can configure multiple provider keys — each agent picks its provider via frontmatter, the workspace key for that provider is used.

### 6b. Runs table view

The runs table is just a `tables` row with `slug='runs'` in each project. It renders through the existing TableView from Phase 1.5. The standard column set works out of the box:

- **Title** (auto-generated `<agent-slug> on <parent-slug> @ <iso>`).
- **Status** (the run state — sortable, filterable; auto-rendered with the status set seeded at lazy-init).
- **updated_at** (built-in).

Pinning additional fields (tokens_in, tokens_out, agent_slug, trigger_id, started_at, completed_at, error_reason) requires adding `fields` rows. Phase 3's lazy-seed creates the table with **zero pinned fields**; the spreadsheet UI's existing "Suggested columns from your data" picker (Phase 1.9) surfaces them as soon as the first run lands. Operators pin what they want.

Saved views — three auto-seeded at lazy-init:
- **All runs** (default; no filter).
- **Failures** (`status in ['failed', 'rejected']`).
- **Awaiting approval** (`status = 'awaiting_approval'`).

These appear in the rail under the project's `runs` table per Phase 1.6.

### 6c. Runs link tile on agent + trigger slideovers

The agent slideover's "Runs" tab (Phase 2.6) renders a link tile instead of an inline list:

```
┌─────────────────────────────────────────────────────────┐
│ 🤖 Runs                                                 │
│ ────────                                                 │
│ This agent has 12 runs across 3 projects:                │
│   • 8 completed                                          │
│   • 2 failed                                             │
│   • 2 awaiting approval                                  │
│                                                         │
│ [Open Runs table →]                                      │
└─────────────────────────────────────────────────────────┘
```

Counts come from `GET /api/v1/w/:wslug/runs?agent_slug=<this>&count=true` (a new query option that returns aggregated counts only — cheap). Live-updates via SSE `?agent=<doc_id>`.

The link opens `/w/:wslug/p/:pslug/t/runs?view=All+runs&filter.assignee=agent:<this>` if there's a single project the agent acts on, or a project picker if multiple.

Trigger slideover's Runs tab same pattern, filtered by `frontmatter.trigger_id`.

### 6d. Approval banner on plan comments (wired live)

In Phase 2.6 the approval buttons post `kind=approval` / `kind=rejection` comments but no run lifecycle exists. Phase 3 wires the live state:

- The plan comment row queries the linked run (via `frontmatter.run_id`) on render.
- If run status is `awaiting_approval`: buttons render and are interactive.
- If run status is `running | completed`: buttons hidden; muted line "Approved by @stefan · 3m later" rendered (looks up the most recent `kind=approval` comment with this `target_agent` to extract the user + delta).
- If run status is `rejected`: muted "Rejected by @stefan · 5m later" rendered.

SSE subscribes to `agent.run.*` with `?run=<this_run_id>` (Phase 2.6's filter; Phase 3 connects it to live data). Status transitions flip the button visibility live.

### 6e. Cmd-K commands

Per PHASES.md Phase 3:

- `Run agent...` — opens a two-step picker (agent → parent doc) + optional input textarea → POSTs `agent_run` doc with `assignee: agent:<slug>`. The on-assignment builtin picks it up.
- `Approve pending plan` — lists workspace-wide `awaiting_approval` runs (via `GET /api/v1/w/:wslug/runs?status=awaiting_approval`); selecting one navigates to the parent doc's slideover focused on the plan comment.

### 6f. `[[` wiki-link autocomplete in body editor

Phase 2.6 ships this in the comment composer. Phase 3 wires the same `WikiLinkPicker` component into the document body editor (Milkdown instance in `document-slideover.tsx`). Same fuzzy-search over workspace document titles, same insertion of `[[<slug>]]`.

This is the only "slash-command-style" UX shipping in Phase 3 — and it's not AI, it's plain search. The dropped slash commands (`/draft`, `/decompose`, `/summarize`, `/ai`) are replaced by the `@`-mention surface in the Comments tab (post a comment mentioning the agent — same outcome with proper attribution + audit trail).

### 6g. Provider-down "Agent Offline" surface

LLM providers fail. Anthropic has hiccups; Ollama-on-localhost dies; an expired API key 401s. Without a surface, every affected agent looks individually broken — the user opens slideover after slideover seeing `error_reason: provider_error` and assumes the agents are misconfigured. The right UX is a workspace-level banner that says *the provider is down*, not that the agents are.

**State model.** No new schema. Degradation is derived from event history per `(workspace_id, provider)`:

- A workspace+provider is **degraded** when the last N (`FOLIO_PROVIDER_DEGRADE_THRESHOLD`, default 3) terminated runs against it all have `error_reason: provider_error`. "Terminated" means runs in a terminal status (`completed`, `failed`, `rejected`) — `cancelled` runs are excluded so a user cancelling an in-flight run doesn't move the needle.
- A workspace+provider **recovers** the moment the next terminated run completes successfully (`status: completed`) — there's no cool-off window. One green run clears the banner.

The aggregation is a single query against the `events` table (already indexed by workspace + kind): "last N `agent.run.completed | agent.run.failed | agent.run.rejected` events with payload `provider = X` in workspace W." Two cases trigger the new events in §5:

1. **Tipping into degraded:** a fresh `agent.run.failed` (with `error_reason: provider_error`) arrives, and counting back from it, the last N terminated runs for that provider in this workspace are all `provider_error`. Emit `workspace.provider.degraded` exactly once on the tipping edge (compare against the run *before* the tipping one — if it was already degraded, skip).
2. **Recovering:** a fresh `agent.run.completed` arrives for a workspace+provider that was previously degraded. Emit `workspace.provider.recovered`.

Implementation lives in `services/agent-runs.ts::checkProviderHealth(workspaceId, provider)`, called by `transitionRun` immediately after it emits the run's own `agent.run.{completed|failed|rejected}` event, in the same transaction. The check is cheap — bounded by N (default 3) rows.

**UI placement.** Two surfaces, both passive (no action required from the user — the banner clears itself on recovery):

1. **Workspace-wide banner** in the shell layout (`apps/web/src/components/shell/`) — renders above the main frame when any provider in the current workspace is in the degraded state. Reads via a thin `useProviderHealth(wslug)` hook that subscribes to the workspace SSE for `workspace.provider.degraded` + `workspace.provider.recovered`, and on mount calls a one-shot `GET /api/v1/w/:wslug/provider-health` returning the current state for all providers.

   ```
   ┌─────────────────────────────────────────────────────────┐
   │ ⚠ Anthropic is unreachable — last 3 agent runs failed.   │
   │   Agents using Anthropic are paused until it recovers.  │
   │   [View runs] [Check key]                                │
   └─────────────────────────────────────────────────────────┘
   ```

2. **Agent slideover inline notice** — when opening an agent whose `frontmatter.provider` matches a currently-degraded provider in this workspace, render a small inline notice above the Fields tab body: "Provider currently offline. Runs will queue until it recovers." This is purely informational; the runner does NOT skip the run — pre-flight checks let it through to surface the actual failure if it happens again. We don't want to hide a real outage behind a "wait and see" pause.

The "Check key" link in the workspace banner navigates to `/w/:wslug/settings?tab=ai&provider=<provider>` and focuses the test-key affordance. Cheapest possible self-service path.

**What this is NOT.**

- Not a circuit breaker. The runner keeps trying. We do not skip pre-flight or fast-fail runs just because the banner is up — that would mask transient recovery (provider comes back, but no runs go through to detect it because we're holding them).
- Not a retry queue. Failed runs do not auto-retry on recovery. The user explicitly drag-drops `failed → planning` (the existing retry gesture in §5 of the runs table) or hits "Retry" in the slideover.
- Not per-agent. The unit is `(workspace, provider)` because that's the failure boundary — one bad API key breaks every agent using that provider, and per-agent surfacing would be N copies of the same banner.

**Threshold + tuning.** Default `FOLIO_PROVIDER_DEGRADE_THRESHOLD=3`. Env-only for v1 (no UI). If a workspace has zero traffic, no banner ever appears — degradation is derived from actual run history, not from a probe.

## 7. Testing strategy

### 7a. Unit tests

Server (Bun test):
- `services/agent-runs.ts::createRun` — happy path, idempotency check (concurrent rejects), proper event emission, chain_id minted on root run + inherited on descendants.
- `services/agent-runs.ts::transitionRun` — state machine: every valid transition succeeds + emits right event; every invalid transition throws `INVALID_RUN_TRANSITION`. Clears `worker_started_at` on terminal transitions.
- `services/agent-runs.ts::incrementTokens` — atomic update, correct event emission.
- `services/agent-runs.ts::getActiveRun` — returns most recent active run; null on no match; uses partial index (verify via EXPLAIN).
- `services/agent-runs.ts::ensureRunsTable` — creates table + 6 statuses + 3 views on first call; idempotent on subsequent calls.
- `services/agent-runs.ts::claimNextPlanningRun` — atomic claim-via-UPDATE; returns null on empty; concurrent pollers race safely (one wins, others get null). Verify the WHERE-clause status check is the lock.
- `services/agent-runs.ts::recoverOrphanRuns` — finds rows at status=running with stale worker_started_at; transitions them to failed (worker_crash); returns count.
- `services/agent-runs.ts::checkRunRateLimits` — workspace cap + agent cap; both enforced; reasonable defaults respected; per-agent override via frontmatter.max_runs_per_hour works.
- `services/agent-runs.ts::checkChainGuards` — fanout count, chain duration aggregation, chain token aggregation; uses documents_runs_by_chain_idx (verify via EXPLAIN); returns first-failing reason if multiple guards fail.
- `services/agent-runs.ts::countPendingPlanning` — accurate count; only counts status=planning.
- `services/agent-runs.ts::checkProviderHealth` — fewer than N runs in history → healthy. Last N all failed with `provider_error` → degraded. Mixed (one non-`provider_error` failure or one `completed` in the window) → healthy. Different providers tracked independently. Cancelled runs do NOT count toward the window. Tipping from healthy → degraded emits `workspace.provider.degraded` exactly once. The next completed run emits `workspace.provider.recovered` exactly once.
- `services/agent-runs.ts::getProviderHealth` — returns all four providers; providers with zero history return healthy.
- `lib/runner.ts::runAgent` (called with a pre-claimed row at status=running; mocked AIProvider, mocked executeMcpTool):
  - Invariant: row already at running. Runner reads it, executes loop.
  - No AI key: kind=error posted, run failed with no_ai_key, worker_started_at cleared.
  - Depth exceeded: kind=error, failed with depth_exceeded.
  - Rate limited (workspace): kind=error, failed with rate_limited (workspace cap).
  - Rate limited (agent): kind=error, failed with rate_limited (agent cap).
  - Fanout exceeded: kind=error, failed with fanout_exceeded.
  - Chain duration exceeded: kind=error, failed with chain_duration_exceeded.
  - Chain tokens exceeded: kind=error, failed with chain_tokens_exceeded.
  - `requires_approval=true`: posts kind=plan, transitions to awaiting_approval, exits.
  - `requires_approval=false`: proceeds directly to execution loop.
  - Budget exceeded mid-run: detected on next incrementTokens, posts kind=error, fails.
  - Cancel mid-run: status check before tool dispatch detects flip, runner exits cleanly.
  - Provider error: kind=error posted, run failed with provider_error.
  - Tool call success: dispatches via executeMcpTool, result fed back to provider, loop continues.
  - Natural completion: posts kind=result, transitions to completed, emits agent.run.completed.
- `lib/runner.ts::runAgentResume` — invoked when a planning row with frontmatter.resume_of is claimed; loads both rows, inherits chain context, runs with prior plan + approval as message history.
- `lib/runner.ts::rejectRun` — transitions to rejected, posts cancellation comment, clears worker_started_at.
- `lib/poller.ts::startRunnerPoller` (with fake timers and mocked claim queue):
  - Idle loop: no rows → polls every interval, no runs dispatched.
  - One row pending → claims, dispatches runAgent (fire-and-forget), continues polling.
  - Concurrency cap: with MAX_CONCURRENT_RUNS=2, 5 rows pending → only 2 in flight at a time.
  - Boot recovery: 3 orphan rows at status=running with stale worker_started_at → all transitioned to failed (worker_crash) before poll loop starts.
  - Backpressure log: count > threshold → log emitted.
  - Concurrent claim race: two pollers in same DB → only one wins the UPDATE for a given row.
- `lib/mcp-dispatch.ts::executeMcpTool` — scope checks, resource resolution, allow-list intersection, tool registry lookup. Same code path for runner-internal and HTTP-external callers.
- `lib/ai/anthropic.ts` (and openai, openrouter, ollama) — `stream()` happy path with mocked HTTP. Normalizes provider response into ProviderEvent stream. Token counts surface in `tokens` events. `testKey()` returns ok on valid; structured error on invalid.
- `routes/runs.ts` — all 5 verbs: shape, status codes, auth + scope enforcement, `requireResource` for project allow-list, RUN_ALREADY_ACTIVE on conflicting retries.
- `routes/ai.ts` — test-key for each provider returns the right shape; does NOT persist the key.
- `routes/mcp.ts` for new tools (`list_runs`, `get_run`, `run_agent`, `cancel_run`, `retry_run`) — JSON-RPC happy path + permission errors via the shared executeMcpTool.
- Migration `0009` — re-running idempotent, CHECK constraint enforces, indexes exist.
- Migration `0009a` — flips `enabled` only for the two runner-bound builtins; preserves user-modified state (if a user explicitly disabled `on-assignment` in 2.6 the migration leaves it alone — track via `last_modified_by`).

Web (Vitest):
- `pages/workspace-settings-ai.tsx` — provider dropdown, model dropdown per-provider, test-key button, save button. Live validation feedback.
- `components/runs/runs-link-tile.tsx` — counts render correctly, live-updates via mocked SSE, link navigates.
- `components/comments/approval-buttons.tsx` (modified from Phase 2.6) — now queries the linked run; renders buttons only on `awaiting_approval`; renders muted "Approved/Rejected by" once run leaves that status.
- `lib/api/runs.ts` hooks — `useRuns`, `useRun`, `useCreateRun`, `useCancelRun`, `useRetryRun`. Optimistic on create/cancel/retry.
- `components/cmd-k/run-agent.tsx` — two-step picker, optional input, POSTs to `/runs`.
- `lib/wiki-link-picker.ts` extension wired into the body editor — `[[` opens picker, insertion works.
- `components/shell/provider-health-banner.tsx` — renders when any provider degraded; cleared on `workspace.provider.recovered` SSE event; "Check key" link navigates to the AI settings tab with the right provider focused.
- `components/slideover/agent-slideover.tsx` (modified) — when opening an agent whose provider is degraded, renders the inline "Provider currently offline" notice above the body.
- `lib/api/provider-health.ts` — `useProviderHealth(wslug)` hook: one-shot GET on mount + SSE subscription for the two new event kinds.

### 7b. Integration tests

On real SQLite + real HTTP + mocked AIProvider (the provider abstraction is the test boundary):

1. **End-to-end run from assignment.** Workspace with Anthropic key. Create work_item. PATCH `frontmatter.assignee = agent:reply-drafter`. Assert: builtin-on-assignment fires, agent_run row inserted with status=planning, runner transitions through to completed, 2+ kind=comment comments + 1 kind=result on the parent.
2. **End-to-end run from @-mention.** Same setup. POST comment on work_item with `"@reply-drafter please draft"`. Assert: comment.mentioned fires, runner runs, comments appear under parent.
3. **End-to-end run from POST /runs.** Same setup. POST `/api/v1/w/x/runs` with `agent_slug, parent_slug`. Assert: row created with status=planning, runner picks up via on-assignment builtin, completes.
4. **Approval flow happy path.** Agent with `requires_approval=true` assigned. kind=plan posted, run at awaiting_approval. POST comment `"@drafter approved"` → builtin-on-approval fires, runAgentResume invoked, run completes.
5. **Approval flow reject.** Same but post `"@drafter rejected"` → builtin-on-rejection fires, rejectRun invoked, run transitions to rejected, agent's "Run cancelled" note posted.
6. **Approval via UI button.** Plan posted. POST comment with explicit `{ kind: 'approval', target_agent: 'drafter' }` (simulating button click). Same flow as keyword.
7. **Approval via MCP.** Plan posted. Bearer token with `agents:write` posts via MCP `create_comment { kind: 'approval', target_agent }`. Same flow.
8. **Token budget enforcement.** Mock provider returns 5000 tokens. Agent has `max_tokens_per_run: 1000`. Assert: runner detects on next incrementTokens, posts kind=error budget_exceeded, run failed.
9. **No AI key path.** Workspace has NO key for the agent's provider. Assign work item. Assert: runner inserts failed run with no_ai_key, posts kind=error.
10. **Delegation depth.** Agent A with `max_delegation_depth=1`. A creates child work_item assigned to agent B. B runs. B creates grandchild assigned to agent C. Assert: pre-flight depth check fails, kind=error depth_exceeded, run failed.
11. **Coalesce concurrent fires.** Trigger fires twice in quick succession (PATCH assignee twice). Assert: only one agent_run row created. Second fire logged but no-op.
12. **Cancel mid-flight.** Long-running mock provider (slow stream). POST `/runs/:id/cancel` while status=running. Assert: status flips to failed (cancelled), next runner iteration detects and exits, no further comments posted.
13. **Retry failed run.** Run failed with provider_error. POST `/runs/:id/retry`. Assert: new run row created with `firedBy: retry-of:<old>`, original row untouched, retry completes.
14. **Retry on active run rejects.** Original run still running. POST retry. Assert: 409 RUN_ALREADY_ACTIVE.
15. **Loop prevention.** Trigger T1 fires agent A. A's first action creates a comment that triggers T2 → fires agent A again. Assert: trigger matcher checks fired_by chain, detects A's slug already present, refuses to fire T2's invocation, no second run created.
16. **Lazy-seed runs table.** Fresh project with no agents. First runAgent invocation. Assert: runs table created with 6 statuses + 3 saved views in same transaction. Second run skips re-creation.
17. **Cron trigger.** Create cron trigger `* * * * *` pointing at agent. Wait ~70 seconds. Assert: agent_run row created, run completed.
18. **Event trigger with filter.** Create trigger on `document.updated` with `event_filter: { status: 'Done' }`. Flip work_item to Done. Assert: trigger fires exactly once, run completes. Flip to other statuses → no fires.
19. **MCP run_agent end-to-end.** Bearer with `agents:write` calls `run_agent { workspace_slug, agent_slug, parent_slug, input: "draft a reply" }`. Assert: input posted as kind=comment from caller; run dispatched; SSE stream shows transitions; tool calls dispatched via executeMcpTool with correct authContext.
20. **MCP cancel_run + retry_run via JSON-RPC.** Both work via the shared dispatcher.
21. **Shared dispatcher equivalence.** Call HTTP `POST /api/v1/w/x/p/y/documents/z/comments` and MCP `create_comment` with identical args + same agent token. Assert: same row created, same events emitted, identical error responses on permission failures.
22. **Provider parity smoke.** With mocked Anthropic, OpenAI, OpenRouter, Ollama. Configure key per provider. Same agent. Run. Assert: completes through each provider's mock; ai.action events have correct provider field.
23. **Run-rate cap — workspace.** Set FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE=3 via test env. Fire 4 assignments in succession. Assert: 3 runs execute; 4th run created at planning but fails with rate_limited on pre-flight check. kind=error comment posted with rate context.
24. **Run-rate cap — agent.** Set `agent.frontmatter.max_runs_per_hour=2`. Fire 3 assignments. Assert: 2 succeed; 3rd fails with rate_limited (per-agent cap).
25. **Fanout exceeded.** Manually insert 25 agent_run rows sharing the same chain_id, all at terminal status. Fire a 26th invocation with that chain_id. Assert: pre-flight checkChainGuards rejects with fanout_exceeded.
26. **Chain duration exceeded.** Manually insert agent_run rows spanning > 30 minutes wall time, same chain_id. New run in chain → chain_duration_exceeded.
27. **Chain tokens exceeded.** Sum > 1M tokens across chain. New run → chain_tokens_exceeded.
28. **Crash recovery.** Insert agent_run row at status=running with worker_started_at set to 10 minutes ago. Restart the test server (cycle the poller). Assert: recoverOrphanRuns finds the orphan, transitions to failed (worker_crash), emits agent.run.failed. Log line at INFO shows count.
29. **Poller concurrency.** MAX_CONCURRENT_RUNS=2. Insert 5 planning rows. Assert: at any moment, no more than 2 are at status=running; rows execute FIFO by created_at as workers free up.
30. **Backpressure stats endpoint.** GET /api/v1/admin/runner-stats → returns { pending_count, active_count, recovered_today }. Admin-only auth.
31. **Provider degradation tipping edge.** With `FOLIO_PROVIDER_DEGRADE_THRESHOLD=3` and a mocked provider stubbed to always return a network-level error: assign agent to work item three times in succession. Assert: after the 3rd `agent.run.failed` (error_reason=provider_error), exactly one `workspace.provider.degraded` event arrives; SSE stream shows it. A 4th failure does NOT emit a second degraded event (no banner thrash).
32. **Provider recovery.** Continue from #31. Flip the mock to return success. Assign agent again. Assert: run completes; exactly one `workspace.provider.recovered` event arrives; GET `/api/v1/w/:wslug/provider-health` returns healthy for that provider.
33. **Provider health is per-provider.** Workspace has two providers configured (Anthropic + OpenAI). Anthropic mock fails 3 times. Assert: `workspace.provider.degraded` with `provider: 'anthropic'` only; OpenAI agents still run unaffected; `/provider-health` shows anthropic degraded + openai healthy.
34. **Cancelled runs excluded from health window.** Configure provider to fail. Trigger 2 failures, then trigger a run and cancel it before completion (status=failed with `error_reason=cancelled`). Then trigger a 3rd provider-error failure. Assert: this counts as 3 consecutive provider_errors (cancelled excluded) → degraded fires. Without the cancelled-excluded rule the test would only count 2 → not degraded.

### 7c. Acceptance tests (Playwright)

With a real Anthropic key in the test environment (one Playwright test uses a real, very-low-budget Anthropic key + `claude-haiku-4-5`):

1. **Real Anthropic end-to-end.** Configure Anthropic key in workspace settings → assign work_item to a reply-drafter agent (system prompt: "Reply in one short sentence in English") → wait for run completion → verify kind=result comment exists on the parent, text is non-empty, runs table shows the row at status=completed.
2. **Approval gate via UI.** Agent with `requires_approval=true` (mocked provider for speed). Assign → kind=plan comment appears with Approve/Reject buttons. Click Approve → kind=approval comment posts → buttons disappear → "Approved by @stefan · Ns later" shows → run continues and posts kind=result.
3. **Cancel mid-run.** Long-running mock. Open runs table view → see row at status=running → click Cancel from the row's ⋯ menu → confirm dialog → status flips to failed within 1s.
4. **Run agent via Cmd-K.** Cmd+K → "Run agent" → pick agent → pick parent doc → optional input → submit → toast confirms → navigate to runs table view → row visible.
5. **Wiki link picker in body.** Open work_item slideover, click body editor, type `[[fix-` → picker opens → select a doc → `[[fix-login-bug]]` inserted as markdown. Save → reload → link is clickable.
6. **Agent Offline banner.** With a mocked Anthropic that always returns 503: assign three work items to an Anthropic agent → wait for the 3rd failure → assert workspace banner appears reading "Anthropic is unreachable — last 3 agent runs failed." Click "Check key" → AI settings tab opens focused on Anthropic. Flip the mock to success → assign a 4th work item → run completes → banner disappears.

### 7d. Manual QA

`apps/web/tests/manual-qa-phase-3.md`:
- AI settings tab visuals across all four providers.
- Real Anthropic key test-key flow with valid + invalid keys.
- Animation polish on the runs table row transitions (SSE-driven status flips).
- Approval banner re-render under flaky network (SSE reconnect with Last-Event-Id).
- Real Ollama on localhost: configure, assign, run completes.
- Dark mode parity on runs table + AI settings.
- One scenario per Phase 3 PHASES.md acceptance checkbox.

## 8. Dependencies + ordering

Phase 3 depends on:
- Phase 2.6 (Comments + tabbed slideover) — provides the kind=plan/result/error comments substrate, the four built-in triggers (defined + 2 disabled, 2 enabled), the approval-buttons UI surface, the mention-with-keyword infrastructure.
- Phase 2.5 — workspace-scoped agents, agent token cascade, `requireResource` middleware, `intersect()` helper.
- Phase 2 — bearer auth, scopes, MCP base, event bus, SSE base, agent + trigger document types.

Phase 3 does NOT depend on Phase 2.7 (Templates). Phase 2.7 can ship before or after.

Phase 3 unblocks:
- Phase 3.5 (script + webhook trigger actions) — already plans to extend the runner's invocation paths.
- Phase 4 (inbound webhooks) — webhook-created work items will fire the on-assignment builtin and run agents automatically.
- The callcenter flow design — Phase 3 ships everything the callcenter spec needs except its own custom agents.

## 9. Open questions (for the implementation plan)

- **Per-provider tool-call schema differences.** Anthropic's tool format differs from OpenAI's; OpenRouter normalizes; Ollama has its own. The provider abstraction's `ToolDef` shape needs to be a common denominator. Recommendation: use Anthropic's tool definition shape as canonical (since most agents will use Anthropic); each provider implementation translates on the way out and parses on the way back.
- **Token counting accuracy.** Anthropic returns counts in the message stream; OpenAI requires opt-in (`stream_options.include_usage: true`); Ollama returns counts in the final chunk. The runner trusts whatever each provider reports. If a provider lies about counts, budgets may be over- or under-enforced — Phase 3 doesn't try to count tokens client-side.
- **Tool list shape.** `agent.frontmatter.tools` is currently an array of MCP tool names. With template-driven schema, this could become richer (e.g. per-tool config — "this tool, but with default args"). v1 stays array-of-names; richer per-tool config is post-v1.
- **Concurrent SSE subscribers.** Multiple users opening the same work_item slideover means multiple SSE streams subscribed to `?parent=X`. The in-memory pub/sub from Phase 2 handles fan-out fine in single-process. Multi-process is post-v1.
- **Test fixture for real-Anthropic Playwright.** A real key is required for one acceptance test. Use a budget-limited test key + claude-haiku-4-5. Plan should specify where the key lives (env var; not committed).
- **Provider fallback.** If a workspace's primary provider is down (Anthropic 5xx), should the runner try a secondary? v1 says no — fail the run with provider_error. Fallback chains are post-v1.

## 10. Acceptance (mirrors PHASES.md Phase 3 acceptance)

A working Phase 3 is one where:

1. Migration `0009` widens `documents.type` to include `agent_run`; migration `0009a` flips the two runner-bound builtins to `enabled: true`. Indexes for partial pending + chain aggregation created.
2. AI settings tab in workspace settings allows configuring + testing keys for all four providers.
3. **Polling worker model.** Trigger handlers create `agent_run` rows at `status=planning` and return immediately. The poller claims them within ~1s and dispatches to the runner. Trigger-initiated HTTP requests do NOT block on LLM execution.
4. Assigning a work_item to an agent fires the runner; run row appears in the runs table; comments appear on the parent.
5. `@`-mentioning an agent in a comment fires the runner via builtin-on-mention.
6. Creating an `agent_run` document directly via UI / Cmd-K / MCP fires the runner via builtin-on-assignment + the poller.
7. `requires_approval=true` agent: kind=plan posted → run at awaiting_approval. Approve via button, @-mention keyword, or MCP — all three resume via a new planning row claimed by the poller. Reject via any of the three transitions the run to rejected.
8. **Six layered recursion guards** all enforced: max_delegation_depth, fired_by same-slug rejection, per-workspace run-rate cap, per-agent run-rate cap, per-chain fanout cap, chain duration + token caps. Each surface its own `error_reason` and kind=error comment.
9. Token budget exceeded → kind=error budget_exceeded, run failed.
10. No AI key → kind=error no_ai_key, run failed.
11. Cancel mid-run → run transitions to failed (cancelled), runner exits cleanly within ~1 provider iteration.
12. Retry failed run → new run row, original preserved, completes.
13. Coalesce: second assignment/mention while a run is active → no-op.
14. Cron trigger fires within ~60s → agent_run row created → poller picks up → run completes.
15. Event trigger with filter fires exactly once per matching event; loop prevention works.
16. **Crash recovery.** Server killed mid-run → next boot finds orphan running rows (older than 5 min via `worker_started_at`), transitions them to failed (worker_crash), emits agent.run.failed.
17. **Backpressure visible.** `GET /api/v1/admin/runner-stats` returns pending count, active count, recovered count. Log line emitted when pending > threshold.
18. **Concurrency.** Up to `FOLIO_POLLER_CONCURRENCY` (default 5) runs execute simultaneously. Race-safe claim (concurrent pollers cannot double-dispatch the same row).
19. Runs table lazy-seeds on first run; 3 default views visible in rail.
20. Spreadsheet UI for runs (sort by status, filter by agent, save view) works via existing Phase 1.5/1.6 machinery.
21. Shared `executeMcpTool` dispatcher used by both HTTP MCP route and runner; scope + allow-list checks once.
22. 5 new MCP tools work end-to-end; HTTP twins also work; identical behavior verified.
23. `ai.action` audit events emit per provider call with token counts (no content).
24. Wiki-link `[[` picker available in both comment composer and body editor.
25. **Chain_id tracking** present on every agent_run row; root run mints fresh uuid; descendants inherit. fired_by string format includes chain_id prefix.
26. **Provider-down banner.** When the last N (`FOLIO_PROVIDER_DEGRADE_THRESHOLD`, default 3) terminated runs for a `(workspace, provider)` all fail with `error_reason: provider_error`, `workspace.provider.degraded` fires exactly once and the workspace shell renders the "Agent Offline" banner. The next successful run fires `workspace.provider.recovered` exactly once and the banner clears. `GET /api/v1/w/:wslug/provider-health` returns the current state for all four providers. Cancelled runs are excluded from the consecutive-failure window. Per-provider tracking is independent (Anthropic degraded doesn't degrade OpenAI).
27. All existing user-flow tests still pass — no Phase 2 / 2.5 / 2.6 regression.
28. Commit: `phase-3: complete`.

---

## Appendix A: State machine

```
                                  ┌─────────────────┐
   runAgent invoked ─────────────►│   planning      │
                                  └─────┬───────────┘
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              │ agent.requires_approval=true                       │ agent.requires_approval=false
              ▼                                                    ▼
   ┌──────────────────────┐                          ┌──────────────────────┐
   │ awaiting_approval    │                          │     running          │
   └──┬──────┬───────┬────┘                          └──┬──────┬────┬──────┘
      │      │       │                                   │      │    │
      │      │       │ kind=rejection                    │      │    │ provider error
      │      │       ▼                                   │      │    │ budget exceeded
      │      │   ┌─────────┐                             │      │    │ depth exceeded
      │      │   │rejected │                             │      │    │ no_ai_key
      │      │   └─────────┘                             │      │    │ cancelled
      │      │                                           │      │    ▼
      │      │ kind=approval                             │      │  ┌────────┐
      │      ▼                                           │      │  │ failed │
      │  ┌─────────┐ (transition to running, then        │      │  └────────┘
      │  │ running │  continue same loop as direct)      │      │
      │  └─────────┘                                     │      │
      │                                                  │      │
      │ cancel via POST /runs/:id/cancel                 │      │ natural completion
      ▼                                                  │      ▼
   ┌─────────┐                                          │  ┌───────────┐
   │ failed  │ ◄────────────────────────────────────────┘  │ completed │
   └─────────┘                                              └───────────┘
```

State machine validation in `transitionRun` rejects:
- `planning → completed | rejected` (must go through running first).
- Any transition out of a terminal state (`completed | failed | rejected`).
- `awaiting_approval → completed` (must go through running).

## Appendix B: HTTP ↔ MCP parity

Every HTTP route in Folio has an MCP twin (or is documented as not needing one). Going forward, the rule is: new resource operations ship on both surfaces, sharing a service-layer function and `executeMcpTool`.

| HTTP route | MCP tool | Required scope | Phase shipped |
|---|---|---|---|
| `GET /api/v1/w/:wslug/p/:pslug/documents` | `list_documents` | `documents:read` | 2 |
| `GET /api/v1/w/:wslug/p/:pslug/documents/:slug` | `get_document` + `get_document_markdown` | `documents:read` | 2 |
| `POST /api/v1/w/:wslug/p/:pslug/documents` | `create_document` | `documents:write` | 2 |
| `PATCH /api/v1/w/:wslug/p/:pslug/documents/:slug` | `update_document` | `documents:write` | 2 |
| `DELETE /api/v1/w/:wslug/p/:pslug/documents/:slug` | `delete_document` | `documents:delete` | 2 |
| `POST .../documents/:slug/activity` | (HTTP-only — logging is human-facing) | session only | 1.7 |
| `GET /api/v1/w/:wslug/p/:pslug/.../comments/...` | `list_comments` / `get_comment` | `documents:read` | 2.6 |
| `POST .../comments` | `create_comment` | `documents:write` | 2.6 |
| `PATCH .../comments/:slug` | `update_comment` | `documents:write` | 2.6 |
| `DELETE .../comments/:slug` | `delete_comment` | `documents:delete` | 2.6 |
| `POST /api/v1/w/:wslug/documents` (agent-typed) | `create_agent` | `agents:write` | HTTP: 2.5 / MCP: 2.6 |
| `POST /api/v1/w/:wslug/documents` (trigger-typed) | `create_document` (with `type: 'trigger'`) | `documents:write` | 2.5 |
| `PATCH /api/v1/w/:wslug/documents/:slug` (agent) | `update_agent` | `agents:write` | HTTP: 2.5 / MCP: 2.6 |
| `DELETE /api/v1/w/:wslug/documents/:slug` (agent) | `delete_agent` | `agents:write` | HTTP: 2.5 / MCP: 2.6 |
| (introspection only) | `get_agent_self` | (none) | 2.6 |
| All template + group routes (15 verbs) | All 13 template MCP tools | `templates:admin` | 2.7 |
| `GET /api/v1/w/:wslug/p/:pslug/runs` | `list_runs` | `documents:read` | 3 |
| `GET /api/v1/w/:wslug/runs/:runId` | `get_run` | `documents:read` | 3 |
| `POST /api/v1/w/:wslug/runs` | `run_agent` | `agents:write` | 3 |
| `POST /api/v1/w/:wslug/runs/:runId/cancel` | `cancel_run` | `agents:write` | 3 |
| `POST /api/v1/w/:wslug/runs/:runId/retry` | `retry_run` | `agents:write` | 3 |
| `POST /api/v1/w/:wslug/ai/test-key` | (HTTP-only — provider key testing is admin-only and never agent-driven) | session | 3 |
| `GET /api/v1/w/:wslug/provider-health` | (HTTP-only — UI surface, derived from event history; agents don't query their own provider's status) | session | 3 |

Where an HTTP route does not have an MCP twin, the spec explicitly documents why. As of Phase 3, the exceptions are:
- Activity logging (`POST .../activity`) — human "I touched this thing" tracking; agents don't log this way (they emit `ai.action` automatically).
- AI key testing (`POST .../ai/test-key`) — keys are configured by workspace admins, not agents.
- Provider-health snapshot (`GET .../provider-health`) — purely a UI surface; agents don't query their own provider's degradation state. If a provider is degraded, runs fail with `provider_error` and the agent's existing `agent.run.failed` path is the agent-facing signal.

## Appendix C: Component inventory

New components (web):
- `pages/workspace-settings-ai.tsx` (new tab on existing `/w/:wslug/settings`).
- `components/runs/runs-link-tile.tsx` — count + link, on agent + trigger slideovers.
- `components/cmd-k/run-agent-picker.tsx` — two-step picker for Cmd-K Run agent.
- `components/cmd-k/approve-pending-plan.tsx` — list of awaiting_approval runs.
- `lib/api/runs.ts` — `useRuns`, `useRun`, `useCreateRun`, `useCancelRun`, `useRetryRun`.
- `components/shell/provider-health-banner.tsx` — workspace-level "Agent Offline" banner; renders when any provider degraded.
- `lib/api/provider-health.ts` — `useProviderHealth(wslug)` hook: one-shot GET + SSE subscription.

Modified components (web):
- `components/comments/approval-buttons.tsx` — Phase 2.6 stub becomes live; queries the linked run and renders button/muted-line based on status.
- `components/slideover/document-slideover.tsx` — wires `WikiLinkPicker` (from Phase 2.6's components/comments/wiki-link-picker.tsx) into the body editor.
- `components/shell/main-frame.tsx` (or wherever the shell renders workspace chrome) — mounts the `<ProviderHealthBanner />` above the main content area.
- `components/slideover/agent-slideover.tsx` — when the agent's provider matches a currently-degraded one, renders an inline "Provider currently offline" notice above the body.

New backend files:
- `apps/server/src/lib/agent-run-schema.ts` (Zod).
- `apps/server/src/services/agent-runs.ts` — including `claimNextPlanningRun`, `recoverOrphanRuns`, `checkRunRateLimits`, `checkChainGuards`, `countPendingPlanning`.
- `apps/server/src/lib/runner.ts`.
- `apps/server/src/lib/poller.ts` — `startRunnerPoller`.
- `apps/server/src/lib/mcp-dispatch.ts` — shared `executeMcpTool`.
- `apps/server/src/lib/ai/provider.ts` — interface + `getProvider` factory.
- `apps/server/src/lib/ai/anthropic.ts`.
- `apps/server/src/lib/ai/openai.ts`.
- `apps/server/src/lib/ai/openrouter.ts`.
- `apps/server/src/lib/ai/ollama.ts`.
- `apps/server/src/routes/runs.ts` — also hosts `GET /api/v1/w/:wslug/provider-health`.
- `apps/server/src/routes/ai.ts`.
- `apps/server/src/routes/admin-runner-stats.ts` — backpressure visibility endpoint.
- `apps/server/drizzle/0009_phase_3_agent_runs.sql` — type enum widening + indexes + `documents_runs_pending_idx` + `documents_runs_by_chain_idx` expression index.
- `apps/server/drizzle/0009a_flip_runner_builtins_to_enabled.sql` — flip the 2 builtins.

Modified backend files:
- `apps/server/src/db/schema.ts` — agent_run added to documents.type enum, new indexes.
- `apps/server/src/lib/trigger-schema.ts` — `agent.run.*` + `ai.action` + `runs_table.lazy_seeded` + `workspace.provider.degraded` + `workspace.provider.recovered` added to KNOWN_EVENT_KINDS.
- `apps/server/src/routes/mcp.ts` — 5 new tool dispatchers; ALL existing dispatchers refactored to route through `executeMcpTool` (consistency cleanup that lands with this phase).
- `apps/server/src/routes/events.ts` — `?agent=`, `?table=` filter params added.
- `apps/server/src/services/documents.ts` — when `type='agent_run'` with `status='planning'` is inserted (via any path), no synchronous runner invocation. The poller picks it up. The trigger-matcher's job is just to insert the row.
- `apps/server/src/lib/trigger-matcher.ts` — `internal_action: 'resume_run'` handler creates a new agent_run row at planning with `frontmatter.resume_of=<original_run_id>` and chain_id inherited from the kind=approval comment's frontmatter.run_id (which itself comes from the original run). `internal_action: 'reject_run'` handler invokes `rejectRun` synchronously (no run to dispatch — just transition the existing row + post the cancellation comment). The kind=approval / kind=rejection comment's `target_agent` field resolves the original run via `getPendingApprovalRun(parentId, targetAgentId)`.
- `apps/server/src/index.ts` — boots `startRunnerPoller(db)` once per process at server start. Catches and logs poller-fatal errors.
- Phase 2.6's `services/workspaces.ts::createWorkspace` builtin seed: no change; the migration `0009a` handles the existing-workspace flip.
