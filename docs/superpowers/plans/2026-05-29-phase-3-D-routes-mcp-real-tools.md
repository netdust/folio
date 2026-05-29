# Phase 3 Sub-phase D — Routes + MCP parity + real tools (expanded + reconciled)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `netdust-core:ntdst-execute-with-tests` (wraps `superpowers:subagent-driven-development`) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Per-task: invoke `netdust-core:testing-workflow` at close; ground-truth each task's named dependencies (Step 2.5 plan-freshness) before dispatch.

**Goal:** Ship the HTTP `routes/runs.ts` verbs + `/provider-health` + admin runner-stats, migrate the real MCP tools into the shared `agent-tools.ts` registry, refactor `routes/mcp.ts` to a thin transport over `executeTool`, add the 5 run-management MCP tools (HTTP twins), wire the approval/rejection builtin triggers to the runner, and add SSE `?agent=`/`?table=` filters. Turns on the keystone "agent does real work" demo.

**Architecture:** D builds the *transport faces* (HTTP + MCP) over the C-layer services + runner that already exist. The central move is reconciling TWO tool-definition shapes — the live MCP route's `ToolDef` (`{name, description, inputSchema: JSONSchema, requiredScope, handler: (ctx, args)}`) and `agent-tools.ts`'s `ToolDef` (`{name, requiredScope, schema: ZodSchema, handler: (args, ctx)}`) — into ONE registry that both the runner (in-process) and the MCP route (JSON-RPC) call via `executeTool(token, actor, name, args, tx?)`. Inside-agent === outside-agent.

**Tech Stack:** Bun, Hono, Drizzle, SQLite, Zod, the hand-rolled JSON-RPC MCP server, the in-memory event bus + SSE.

**Supersedes:** the OUTLINE-ONLY D-1..D-8 section in `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` (~line 4486). That section references stale symbols (`lib/mcp-dispatch.ts`, `executeMcpTool`) and has no executable bodies. This file is the plan of record for Sub-phase D. The mega-plan's `## Threat model` + `## Threat model — Sub-phase C extension` (mitigations 1–53) remain the inheritance baseline; this file adds the **D extension (mitigations 54–63)** below.

---

## Ground-truth reconciliation (verified against live source 2026-05-29, HEAD `7d20d05`)

The D outlines predate C-7's rename + the C.2/C.3 work. These are the verified-true signatures + drift corrections that every D task builds against. **Do not build to the stale mega-plan outline.**

### Renamed / verified symbols

| Stale (mega-plan D outline) | LIVE (verified) | File |
|---|---|---|
| `lib/mcp-dispatch.ts` | **`lib/agent-tools.ts`** | `apps/server/src/lib/agent-tools.ts` |
| `executeMcpTool(name, args, ctx)` | **`executeTool(token: ApiToken, actor: string, name: string, args: unknown, tx?: DBOrTx): Promise<unknown>`** | agent-tools.ts:92 |
| `McpAuthContext` type | **`ToolContext = { token: ApiToken; actor: string; tx?: DBOrTx }`** | agent-tools.ts:25 |
| `{ name, scopes: string[], argsSchema, handler }` | **agent-tools `ToolDef` = `{ name: string; requiredScope: string; schema: z.ZodSchema; handler: (args, ctx) => Promise<unknown> }`** | agent-tools.ts:40 |
| — | **`registerTool(def: ToolDef): void`** — throws on dup name; registry is module-global | agent-tools.ts:79 |

### The two-ToolDef-shape reconciliation (D-2/D-3's central work)

The LIVE MCP route (`routes/mcp.ts`) has its OWN `ToolDef`:
```typescript
// routes/mcp.ts:100-106 (LIVE)
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object, NOT Zod
  requiredScope: string;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>; // ctx FIRST
}
// routes/mcp.ts handler ctx is { token, actor: { id: string } }  -- actor is an OBJECT
```
vs `agent-tools.ts`:
```typescript
// agent-tools.ts:40-46 (LIVE)
export interface ToolDef<TArgs = unknown, TOut = unknown> {
  name: string;
  requiredScope: string;
  schema: z.ZodSchema<TArgs>;          // Zod, NOT JSON Schema
  handler: (args: TArgs, ctx: ToolContext) => Promise<TOut>; // args FIRST
}
// ToolContext.actor is a STRING, not { id }
```
**Reconciliation decisions (locked):**
1. **`agent-tools.ts`'s `ToolDef` is the canonical shape.** Zod `schema` (`executeTool` already `.parse()`s it — mitigation 26), `requiredScope` string, `handler: (args, ctx)`, `ctx.actor: string`.
2. **`description` + `inputSchema` (JSON Schema for `tools/list`) are needed by the MCP transport but NOT by the runner.** Add them as OPTIONAL fields on the canonical `ToolDef` (`description?: string; inputSchema?: Record<string, unknown>`). `tools/list` reads them; `executeTool` ignores them. The runner never lists.
3. **`actor` is a string everywhere.** The MCP route currently passes `{ token, actor: { id: actor.id } }`; after D-3 it passes `actor.id` (string) into `executeTool`. The handler reads `ctx.actor` as a string. Existing handlers that read `ctx.actor.id` must change to `ctx.actor`.
4. **Migration is per-tool, not a bulk copy.** Each of the 20 live tools is rewritten as a `registerTool({...})` call with: Zod `schema` (derive from the current `inputSchema` JSON Schema — most are simple object shapes already validated inline today), `requiredScope` (unchanged), `handler` rewritten to `(args, ctx)` order reading `ctx.token`/`ctx.actor`/`ctx.tx`. Per-tool inline guards (mitigation 27 family) move with the tool.

### Verified service + runner signatures D depends on

| Function | Signature | File | D usage |
|---|---|---|---|
| `runAgent` | `async (args: { runId: string }): Promise<void>` — never throws; all failure → terminal transition | runner.ts:118 | D-5 resume path is `runAgentResume`, NOT this. NOT called by retry (retry uses `createRun` + poller). |
| `runAgentResume` | `async (args: { runId: string }): Promise<void>` — validates original at `awaiting_approval` via `fm.resume_of` | runner.ts:166 | D-5 `resume_run` handler. |
| `rejectRun` | `async (args: { runId: string; rejectionCommentId: string }): Promise<void>` — catches `RUN_TRANSITION_RACED` + `INVALID_RUN_TRANSITION` as benign no-op | runner.ts:916 | D-5 `reject_run` handler. |
| `executeTool` | `async (token, actor: string, name, args, tx?): Promise<unknown>` — throws `Error('method not found: …')`, `Error('forbidden: scope … missing')`, `Error('MCP_INVALID_ARGS')` (w/ `.issues`) | agent-tools.ts:92 | D-3/D-4 transport calls this. |
| `createRun` | `async (args: CreateRunArgs): Promise<{ document }>` — `CreateRunArgs = { workspace, project, runsTable, agent, actor, input: { parentDocumentId, firedBy, chainId, triggerId } }` | agent-runs.ts:97 | D-1 POST + retry; D-4 `run_agent`/`retry_run`. |
| `transitionRun` | `async (runId, args: TransitionRunArgs): Promise<Document>` — throws 404 `AGENT_RUN_NOT_FOUND`, 409 `INVALID_RUN_TRANSITION` (`.from`/`.to`), 409 `RUN_TRANSITION_RACED` (`.observedFrom`) | agent-runs.ts:220 | D-1 cancel. |
| `getActiveRun` | `async (args: { parentId, agentSlug, excludeRunId? }, tx?): Promise<Document \| null>` | agent-runs.ts:529 | D-1 retry 409 check; D-4 `retry_run`. |
| `getPendingApprovalRun` | `async (args: { parentId, agentSlug }, tx?): Promise<Document \| null>` | agent-runs.ts:552 | D-5 resume lookup. |
| `listRuns` | `async (filter: ListRunsFilter, tx?): Promise<Document[]>` — `callerAgentProjectsAllowList` narrows (mitigation 24); `[]` → empty; throws 422 `INVALID_QUERY` on bad `since` | agent-runs.ts:598 | D-1 GET list; D-4 `list_runs`. |
| `getProviderHealth` | `async (args: { workspaceId }, tx?): Promise<Record<ProviderName, ProviderHealthState>>` — `ProviderHealthState = { status: 'healthy'\|'degraded'; consecutive_failures: number }` | agent-runs.ts:1271 | D-1 `GET /provider-health`. |
| `countPendingPlanning` | `async (tx?): Promise<number>` | agent-runs.ts:887 | D-6 `pending_count`. |
| `ensureRunsTable` | `async (tx, args: { workspaceId, projectId }): Promise<TableEntity>` — REQUIRES a tx handle | agent-runs.ts:1452 | D-1 POST + retry + D-4 `run_agent`/`retry_run` (to satisfy `createRun`'s `runsTable` arg). |
| `nextChainId` | `(args: { firedBy: string }): string` — pure, sync | agent-runs.ts:1604 | D-1 POST/retry (new chain or inherited). |
| `handleInternalActionStub` | `(action: string, event: ReactorEvent): void` — console.log no-op stub | trigger-matcher.ts:119 | D-5 REPLACES this. `event` carries `{ kind, workspaceId, projectId, documentId, payload, actor, seq }`. |

### Other live facts D builds against

- **No `requireAdmin` middleware exists.** Admin checks are inline: `getRole(c)` (returns `'owner'|'admin'|'member'`, set by `resolveWorkspace` from the membership row). D-6 uses `getRole(c) !== 'owner' && getRole(c) !== 'admin'` → 403.
- **`requireSession` middleware exists** (`apps/server/src/middleware/auth.ts`, mitigation 11) — rejects when `authMethod === 'token'`. Run routes are bearer-OK (mitigation 11's "intentionally NOT session-only" list already names `runs`), so D-1 does NOT mount `requireSession`.
- **`requireScope(scope)`** (`middleware/bearer.ts:76`) — session callers bypass scope checks (membership is the gate); bearer callers need the scope. D-1 uses this per-verb.
- **Route mount pattern** (`app.ts`): project-scoped routes mount under `pScope` (which runs `resolveProject` + `requireResource()` — the latter enforces agent allow-list, mitigation 24's HTTP analog). Workspace-scoped under `wScope`. `GET list` is project-scoped (`pScope` → `/p/:pslug/runs`); the single-run/cancel/retry/POST/`provider-health` verbs are workspace-scoped (`wScope` → `/runs`, `/runs/:runId/...`, `/provider-health`). Admin stats is workspace-scoped under `wScope`.
- **SSE filters** (`routes/events.ts`): live params `?project=`, `?kinds=`, `?parent=`, `?run=`. Filtering reads `row.payload.parent_id` / `row.payload.run_id` in the replay loop AND passes `{kinds, projectId, parentId, runId}` to `eventBus.subscribe`. D-7 adds `?agent=` (reads `payload.agent` — the key createRun emits at agent-runs.ts:166) + `?table=` (reads `row.tableId`? — **see D-7 reconciliation note: events carry `documentId`+`projectId`, NOT `table_id`; `?table=` must filter on the agent_run's parent table via payload or be scoped differently**).
- **MCP error codes** (live): `-32700` parse, `-32601` unknown tool/method, `-32603` default + scope-fail (carries `data.required_scope`), `-32602` invalid params (via `mcpInvalidParams` w/ `data.reason`), `-32000` server-defined (human-PAT rejection). `executeTool` throws plain `Error`s; D-3's transport maps them: `method not found` → `-32601`, `forbidden: scope` → `-32603` + `data.required_scope`, `MCP_INVALID_ARGS` → `-32602` + `data.issues`, `mcpInvalidParams`-style (carries `.code`/`.data`) → pass through.
- **Spec drift on cancel error_reason:** spec §4g says cancel → `error_reason=cancelled`. The C threat model mitigation 40 enumerates `cancel_requested` (DELETE /runs/:id) vs `cancel_via_comment`. **Locked for D: HTTP cancel uses `error_reason = 'cancelled'`** (matches spec + the live `runErrorReasonSchema` enum value — verify the enum HAS `cancelled`; the C.2 STATE notes the enum value is `'cancelled'`). This plan does NOT add `cancel_requested`. **CORRECTION (verified at D-1 dispatch, 2026-05-29): the cancel comment kind is `rejection`, NOT `cancel`.** The comment schema (`comment-schema.ts`) has NO `cancel` kind; the runner's `wasCancelled` (`runner.ts:770-789`) detects a post-start `kind=rejection` comment on the parent as the cancel signal. A `kind=rejection` comment also REQUIRES a `target_agent` (schema refine), so the cancel route passes `agent:<run's agent_slug>`. So: the HTTP `POST /runs/:runId/cancel` route does a direct `transitionRun(failed, error_reason='cancelled')` on a non-running row, AND (for a `running` row) posts a `kind=rejection` comment (with `target_agent`) so the runner's in-loop check aborts the stream (ONE check path — mitigation 44). See D-1 Step notes.
- **Spec drift on retry:** spec §4g says retry "calls `runAgent` again." **Locked for D: retry does NOT call `runAgent` synchronously.** `runAgent({runId})` is the poller's fire-and-forget entry. Retry = `createRun({..., firedBy: 'retry-of:<oldId>', triggerId: null, chainId: <fresh or inherited>})` after a `getActiveRun` 409 guard; the poller claims the new planning row ~1s later. This matches the C architecture (runs are claimed, not called) and the mega-plan D-1 outline's `createRun(firedBy:'retry-of:<id>')` note.

---

## Threat model — Sub-phase D extension (HTTP routes + MCP parity + real tools)

> Added 2026-05-29 at D-plan-write time, per CLAUDE.md rule 2 (D touches auth/token surfaces, untrusted tool-call args, agent-lifecycle grants, admin PII). EXTENDS the Sub-phase B (mitigations 1–22) + Sub-phase C (23–47) + C.3 (48–53) threat models — does NOT re-litigate them. The inherited mitigations remain in force across all D code. D adds new surfaces: the **HTTP run routes** (a NEW write/cancel/retry path into the runner that bypasses the trigger system), the **MCP run tools** (HTTP twins reachable by bearer), the **real tool registry** (D-2/D-3 lift 20 tools — including the agent-lifecycle guards — out of the route into the shared layer), and the **admin stats endpoint** (aggregate counts that must not leak tenant content). Convergence target for `/code-review` on D.

### What we're defending (new in D)

- **The run-creation path as a NEW runner entry.** Pre-D, runs were born only from triggers (the matcher → `createRun`). D adds `POST /runs` + `run_agent` MCP + `retry_run` — direct human/bearer-initiated run creation. The asset: **run creation cannot be used to bypass the allow-list, autonomy gate, rate limits, or idempotency that the trigger path enforces.**
- **The migrated tool registry's per-tool guards.** D-2/D-3 move the agent-lifecycle guards (`mcpRejectHumanPat`, `assertAgentAllowListWidening`, `assertAgentToolsWidening`, self-delete check) from inline-in-`routes/mcp.ts` into `agent-tools.ts` handlers. The asset: **those guards must survive the migration byte-for-byte semantically — a guard dropped during the lift silently re-opens the privilege-escalation B/C closed (mitigations 18, 19, 27, 36).**
- **The admin runner-stats aggregate.** `GET /admin/runner-stats` returns counts across the workspace. The asset: **counts only — no run content, no tenant doc bodies, no per-agent breakdown that fingerprints another project's activity to a narrowed agent.**
- **Cancel/retry authorization.** A bearer that can `cancel_run`/`retry_run` on ANY run id (not just its own project's runs) can DoS or replay-bill peers. The asset: **run-id-addressed verbs are scope- AND ownership/allow-list-checked, not just scope-checked.**

### Who we're defending against (new in D)

The seven inherited actor classes carry forward. D emphasizes:
8. **A bearer with `agents:write` enumerating run ids.** Run slugs are `<agent>-<iso>-<nanoid8>`; the id is a nanoid. A bearer that guesses/harvests a run id from one project tries `cancel_run`/`get_run`/`retry_run` against it. IN scope — verb handlers must re-scope the target run to the caller's workspace + allow-list.
9. **A narrowed agent-bound bearer calling `run_agent`/`POST /runs` against a parent in a disallowed project.** IN scope — the `requireResource()` / `callerAgentProjectsAllowList` path must gate run creation the same way it gates the trigger matcher (mitigation 50).

### Attacks to defend against (Sub-phase D)

Numbered 54–63, continuing the sequence (B 1–22, C 23–47, C.3 48–53).

54. **`POST /runs` / `run_agent` bypasses the autonomy gate.** The C.3 matcher gates agent-ORIGINATED runs behind `FOLIO_AGENT_CHAINS_ENABLED` (mitigation 51). But `POST /runs` is a direct create. If an agent-bound bearer (acting under prompt injection) calls `run_agent` to spawn a peer run, it sidesteps the matcher entirely — the gate never sees it.
55. **`POST /runs` / `run_agent` bypasses the allow-list.** A narrowed agent-bound bearer creates a run with `parent_slug` in a project NOT in its allow-list. The trigger path enforces allow-list at match (mitigation 50); the direct-create path must too.
56. **`POST /runs` bypasses rate limits / idempotency.** A bearer floods `POST /runs` for the same (parent, agent), creating N concurrent `planning` rows that all get claimed — duplicate provider charges, the exact failure idempotency (mitigation 52 / `getActiveRun`) defends in the trigger path.
57. **Agent-lifecycle guard lost in the D-2/D-3 migration.** The `mcpRejectHumanPat` / `assertAgentAllowListWidening` / `assertAgentToolsWidening` / self-delete guards live inline in `routes/mcp.ts` today. Lifting the tools to `agent-tools.ts` handlers risks dropping a guard (re-opening B#18/#19, C#27/#36). The migration MUST carry every guard into the handler, anchored to `ctx.token.agentId`.
58. **Cancel/retry on a cross-workspace or cross-project run id.** `cancel_run`/`retry_run`/`get_run` take a raw `run_id`. Without re-scoping, a bearer cancels/replays/reads a run in another workspace or a disallowed project (cf. C#23/#24 read-side, now write-side).
59. **`run_agent` `input` injection into a peer's comment thread.** `POST /runs` with `input` posts a `kind=comment` from the caller's authContext to the parent BEFORE creating the run. If the parent is cross-project (attack 55), the comment lands on a doc the caller shouldn't write to — using the run-create path as a comment-injection primitive.
60. **Admin-stats leaks tenant content / cross-project counts to a narrowed caller.** `runner-stats` returning per-agent or per-project breakdowns lets a narrowed agent infer activity in projects it can't see. Counts must be workspace-aggregate, and the endpoint must be admin-only (owner/admin role), not bearer-reachable by narrowed agents.
61. **`executeTool` error leaks the bad arg VALUE through the MCP transport.** `executeTool` throws `MCP_INVALID_ARGS` with `.issues` = `[{path}]` (paths only — mitigation 26). D-3's transport mapping MUST serialize only `.issues` paths into `data`, never re-attach `params.arguments` to the error response.
62. **MCP `tools/list` enumerates run tools to a caller who can't use them.** `tools/list` is NOT scope-filtered today (it lists all 20+25 tools regardless of caller scope). Low-harm (scope is still enforced at call time), but a narrowed caller seeing `delete_agent` in the list is information disclosure. v1 policy decision required (see mitigation 62 — documented as accepted residual, matching the live behavior).
63. **Retry resurrects a terminal run into a new active run, racing a concurrent retry.** Two `retry_run` calls on the same terminal run both pass `getActiveRun === null` and both `createRun` — duplicate runs. The `getActiveRun` 409 guard must run inside the same tx as `createRun`, or accept the C-layer's existing idempotency (mitigation 52) as the backstop.

### Mitigations required (Sub-phase D)

Numbered 54–63 to match attacks. Each is code-checkable.

54. **`POST /runs` + `run_agent` apply the autonomy gate when the caller is agent-originated.** The route/tool checks: is the caller an agent-bound bearer (`token.agentId !== null`)? If so, this is an agent-originated run-create → gate behind `FOLIO_AGENT_CHAINS_ENABLED` (reuse the matcher's `isAgentOriginated` / flag check — extract the predicate to a shared helper if it lives inside trigger-matcher). When the flag is off and the caller is agent-bound, reject with 403 `AGENT_CHAINS_DISABLED` + emit `agent.chain.suppressed` (parity with the matcher's observability). Human/session callers and human PATs (`agentId === null`) are V1-allowed (mitigation 51's "human-initiated runs are V1-allowed"). Test (`runs.autonomy-gate.test.ts`): agent-bound bearer `POST /runs` with flag off → 403 + suppressed event + zero rows; same with flag on → 1 run; human PAT → 1 run regardless.
55. **Run-create resolves + scope-checks the parent through the allow-list path.** `POST /runs` mounts under `wScope` but resolves `parent_slug` → parent doc and verifies the parent's `projectId` is in the caller's allowed projects (the same `callerAgentProjectsAllowList` logic `listRuns` uses; for HTTP, derive the allow-list from the agent-bound token exactly as `requireResource()` does). Disallowed → 403 `FORBIDDEN_RESOURCE`. `run_agent` MCP does the same in its handler. Test (`runs.create-allowlist.test.ts`): agent allow-listed to `[p1]` creating a run on a `p2` parent → 403, zero rows.
56. **Run-create enforces idempotency via `getActiveRun` before `createRun`, in one tx.** `POST /runs` / `run_agent` call `getActiveRun({parentId, agentSlug}, tx)` inside the `createRun` tx (or immediately before, accepting mitigation 52 as backstop); non-null → 409 `RUN_ALREADY_ACTIVE`. Rate limits are NOT re-checked at create time (the poller's `checkRunRateLimits` at claim time is the enforcement point — mitigation 30); document that create is cheap and the claim gate gives back-pressure. Test (`runs.create-idempotency.test.ts`): two `POST /runs` for the same (parent, agent) → second is 409; only one planning row.
57. **The D-2/D-3 migration carries EVERY agent-lifecycle guard into the `agent-tools.ts` handler, anchored to `ctx.token.agentId`.** A reconciliation checklist (in D-3's task body) enumerates the live guards: `mcpRejectHumanPat` (create/update/delete_agent), `assertAgentAllowListWidening` (create/update), `assertAgentToolsWidening` (create/update), self-delete rejection (`existing.id === ctx.token.agentId`, delete), `get_agent_self` token-anchoring (`requires token.agentId set`). Each becomes a guard inside the corresponding handler, called before the mutation. The `executeTool` deferral comment (agent-tools.ts:115-119) is the landing pad — remove it; the guards now live in the handlers. Tests: the EXISTING `mcp.test.ts` agent-lifecycle cases must pass UNCHANGED post-migration (zero external behavior change — that's the D-3 contract), PLUS a new `agent-tools.lifecycle.test.ts` that calls `executeTool` directly (the runner's path) and asserts the same rejections fire.
58. **Run-id-addressed verbs (`get_run`/`cancel_run`/`retry_run` + HTTP twins) re-scope the target run.** After loading the run by id, the handler verifies `run.workspaceId === <caller's resolved workspace>` AND (for agent-bound bearers) `run.projectId ∈ allow-list`. Mismatch → 404 `AGENT_RUN_NOT_FOUND` (404 not 403, to avoid confirming the id exists in another tenant). Test (`runs.cross-scope.test.ts`): a bearer from workspace A calling `cancel_run`/`get_run`/`retry_run` on a workspace-B run id → 404; a narrowed agent on a disallowed-project run id → 404.
59. **`POST /runs` `input`-comment uses the SAME parent scope-check as run-create.** The `kind=comment` post happens AFTER mitigation 55's allow-list check passes (so a disallowed parent never receives the comment). The comment author is the caller's authContext (existing `services/comments.ts` create path, which already scope-checks). Test: covered by `runs.create-allowlist.test.ts` (a 403 on create produces zero comments AND zero runs).
60. **`GET /admin/runner-stats` is admin-only (owner/admin role) + returns workspace-aggregate counts only.** Inline check `const role = getRole(c); if (role !== 'owner' && role !== 'admin') throw 403 FORBIDDEN`. Body is exactly `{ pending_count, active_count, recovered_today }` — `pending_count` = `countPendingPlanning()`, `active_count` = count of `running`+`awaiting_approval` runs in the workspace, `recovered_today` = count of `agent.run.failed` events with `error_reason='worker_crash'` since UTC-midnight. No per-agent, no per-project, no run ids, no content. No MCP twin (UI/ops only). Test (`admin-runner-stats.test.ts`): member role → 403; owner → counts; body has exactly 3 keys; counts are workspace-scoped (a second workspace's runs don't leak in).
61. **D-3 transport maps `executeTool` errors to JSON-RPC, serializing PATHS only.** The mapping: `err.message.startsWith('method not found')` → `{code:-32601, message}`; `err.message.startsWith('forbidden: scope')` → `{code:-32603, message, data:{required_scope:<parsed>}}`; `err.message === 'MCP_INVALID_ARGS'` → `{code:-32602, message:'invalid arguments', data:{issues: err.issues /* [{path}] */}}`; errors carrying their own `.code`/`.data` (the `mcpInvalidParams` shape from the lifted guards) → pass `.code`/`.data` through. NEVER attach `params.arguments` to any error response. Test (`mcp.error-mapping.test.ts`): a tool call with a bad arg returns `-32602` with `data.issues` containing the path but NOT the value.
62. **`tools/list` remains unfiltered (accepted residual, documented).** v1 keeps the live behavior: `tools/list` returns all registered tools regardless of caller scope; scope is enforced at `tools/call`. Rationale: scope enforcement is at call time (no privilege leak), and a complete tool catalog aids legitimate agent reasoning. Reviewer should NOT surface "tools/list isn't scope-filtered" as a finding. v1.1 may filter. (No code change — this is a documented deferral.)
63. **`retry_run` / `POST retry` guards with `getActiveRun` before `createRun`.** Same shape as mitigation 56: load original run (re-scoped per mitigation 58), then `getActiveRun({parentId: original.parentId, agentSlug: original.fm.agent_slug})` non-null → 409 `RUN_ALREADY_ACTIVE`. `firedBy: 'retry-of:<oldId>'`, `triggerId: null`, `chainId: nextChainId({firedBy})` (fresh chain — a retry is a new top-of-thread, NOT a continuation of the failed chain's fan-out budget). Test (`runs.retry.test.ts`): retry of a `failed` run with no active peer → new planning row, original preserved; retry when an active run exists → 409.

### Out of scope (Sub-phase D explicit deferrals)

- **Per-run-id rate limiting on cancel/retry.** A bearer spamming retry on terminal runs is bounded by the `getActiveRun` 409 (only one active at a time) + the poller's claim-time rate limit (mitigation 30). No separate retry rate-limit in v1.
- **`tools/list` scope filtering** — documented residual (mitigation 62).
- **MCP twin for admin-stats** — admin-stats is UI/ops-only; no MCP tool. Not a gap.
- **DELETE `/runs/:id` (hard delete)** — D ships `cancel` (soft-terminal), NOT a destructive delete. The C.1-R-1 `events.document_id` FK cascade concern only triggers on a hard delete. **Since D does NOT add hard-delete, C.1-R-1 is NOT resolved in D — it stays parked** (retro-follow-up note updated). If a future v1.1 adds hard-delete, it must resolve the FK cascade then. (Reconciliation: the readiness handoff assumed D might add DELETE; it does not, per spec §4g which lists only cancel/retry.)
- **Tool-error-feedback redesign (C.2-R-2 / mitigation: feed tool errors back to the model instead of terminating).** The readiness handoff slated this for D-3. **Re-scoped OUT of the D-2/D-3 mechanical migration** — it's a behavioral change to the LOCKED terminal-on-tool-error runner spec, needs its own plan-correction + infinite-retry guard + review loop, and tangles refactor-correctness with behavior-change. Ship D-2/D-3 as a pure extraction (zero behavior change — that's the testable contract), then do tool-error-feedback as a SEPARATE task (proposed D-9, below) with its own threat-model touch + review. Documented so it's not lost.

### How to use this section

- **Inheritance.** B (1–22) + C (23–47) + C.3 (48–53) remain in force across all D code. D adds 54–63. Do NOT re-validate what the inherited layers validate; DO carry the migrated guards (mitigation 57) intact.
- **Controller pre-flight (Step 2.5).** Before dispatching each D task, ground-truth its named deps against live source (this file's reconciliation table is the starting point — re-verify if HEAD moved) and confirm the task body carries its bound mitigations.
- **`/code-review` (D-8).** Invoke with: "Verify code against the combined threat model in the plans: mega-plan `## Threat model` (1–22) + `## Threat model — Sub-phase C extension` (23–47) + the C.3 plan (48–53) + THIS file's Sub-phase D extension (54–63). Mitigations 1–53 are inherited and remain in force; 54–63 are new for D. Report which are in place, which missing, which out of scope per the deferrals."
- **`/evaluate` (D close).** Any unimplemented 54–63 mitigation is a plan-correction defect. New attack classes → add 64+.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/routes/runs.ts` (create) | The 6 HTTP verbs (list, get, POST, cancel, retry, provider-health). Thin — calls services + runner. | D-1 |
| `apps/server/src/routes/runs.test.ts` (create) | Route tests incl. mitigations 54–59, 63. | D-1 |
| `apps/server/src/app.ts` (modify) | Mount `runs` (list under `pScope`, rest under `wScope`) + admin-stats. | D-1, D-6 |
| `apps/server/src/lib/agent-tools.ts` (modify) | Add optional `description`/`inputSchema` to `ToolDef`; register the 20 real tools + the 5 run tools. | D-2, D-4 |
| `apps/server/src/lib/agent-tools.test.ts` (modify) | Direct-`executeTool` tests for migrated tools + lifecycle guards (mitigation 57) + run tools. | D-2, D-4 |
| `apps/server/src/routes/mcp.ts` (modify) | Shrink to JSON-RPC transport over `executeTool`; error mapping (mitigation 61). | D-3 |
| `apps/server/src/routes/mcp.test.ts` (verify/extend) | Existing cases pass UNCHANGED (D-3 contract) + error-mapping + run-tool parity. | D-3, D-4 |
| `apps/server/src/lib/agent-guards.ts` (verify) | The widening guards the lifted handlers call — unchanged, just new callers. | D-2/D-3 |
| `apps/server/src/lib/trigger-matcher.ts` (modify) | Replace `handleInternalActionStub` with real `resume_run`/`reject_run`. | D-5 |
| `apps/server/src/lib/trigger-matcher.test.ts` (modify) | resume_run → new planning row w/ `resume_of`; reject_run → `rejectRun`; races. | D-5 |
| `apps/server/src/routes/admin-runner-stats.ts` (create) | `GET /admin/runner-stats`, admin-only, aggregate counts (mitigation 60). | D-6 |
| `apps/server/src/routes/admin-runner-stats.test.ts` (create) | Role gate + count correctness + workspace scoping. | D-6 |
| `apps/server/src/routes/events.ts` (modify) | Add `?agent=`/`?table=` filters (replay loop + bus subscribe). | D-7 |
| `apps/server/src/routes/events.test.ts` (modify) | New filter params AND-combine with existing. | D-7 |

---

## Tasks

> Per-task close-out: invoke `Skill("netdust-core:testing-workflow")`, run the affected app's full suite from `apps/server`, run `bun x tsc --noEmit` from `apps/server`, end with the Test-evidence + STATUS blocks. Dispatch order: **D-1 → D-2 → D-3 → D-4 → D-5 → D-6 → D-7 → D-8**. D-2 before D-3 (registry must exist before the route routes through it). D-4 after D-3 (run tools register into the now-canonical registry). D-1 first (routes are the spine D-4 parity-tests against).

### Task D-1: `routes/runs.ts` — 6 HTTP verbs

**Files:**
- Create: `apps/server/src/routes/runs.ts`
- Create: `apps/server/src/routes/runs.test.ts`
- Modify: `apps/server/src/app.ts` (mount)

**Binds mitigations:** 54 (autonomy gate on create), 55 (allow-list on parent), 56 (idempotency), 58 (re-scope on id-addressed verbs), 59 (input-comment scope), 63 (retry guard). Inherits 23/24 (run read scope), 40 (`cancelled` enum), 11 (runs are bearer-OK, NOT session-only).

- [ ] **Step 1: Write failing tests for the happy paths + scope/auth.** In `runs.test.ts`, using `makeTestApp()` (real SQLite, per `[[mock-the-wire-not-the-response]]`): seed a workspace + project + agent + a parent work_item. Tests: (a) `POST /api/v1/w/:wslug/runs {agent_slug, parent_slug}` as session → 201 `{run_id, status:'planning'}` + a planning row exists; (b) `GET /api/v1/w/:wslug/p/:pslug/runs` → array incl. the new run; (c) `GET /api/v1/w/:wslug/runs/:runId` → the run; (d) `POST /runs/:runId/cancel` on a planning run → `{status:'failed'}` + `error_reason='cancelled'`; (e) `GET /api/v1/w/:wslug/provider-health` → `{anthropic:{status,consecutiveFailures}, openai, openrouter, ollama}`.

```typescript
// runs.test.ts (excerpt — adapt seeding helpers to the repo's existing test fixtures in routes/*.test.ts)
import { describe, it, expect, beforeEach } from 'bun:test';
import { makeTestApp, seedWorkspaceProjectAgentParent } from '../test/helpers.ts'; // VERIFY helper names against existing route tests

describe('routes/runs', () => {
  it('POST /runs creates a planning run', async () => {
    const { app, session, wslug, agentSlug, parentSlug } = await seedWorkspaceProjectAgentParent();
    const res = await app.request(`/api/v1/w/${wslug}/runs`, {
      method: 'POST',
      headers: { ...session, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_slug: agentSlug, parent_slug: parentSlug }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('planning');
    expect(body.run_id).toBeString();
  });
});
```

- [ ] **Step 2: Run the tests; verify they fail** (`cd apps/server && bun test src/routes/runs.test.ts`). Expected: FAIL — route file doesn't exist / 404.

- [ ] **Step 3: Implement `routes/runs.ts`.** A Hono router. Verbs:
  - `GET /` (list — mounted under `pScope` so `resolveProject` + `requireResource()` already ran): build `ListRunsFilter` from `?status`/`?agent`/`?since` + `projectId` from resolved project + `callerAgentProjectsAllowList` from the token (use the same helper `requireResource`/`listRuns` callers use to derive the allow-list); call `listRuns(filter)`; return `c.json(rows)`. `requireScope('documents:read')` for bearer.
  - `GET /runs/:runId` (under `wScope`): load run; **re-scope** (mitigation 58) — verify `run.workspaceId === resolvedWorkspace.id` and (agent-bound) `run.projectId ∈ allow-list`, else 404 `AGENT_RUN_NOT_FOUND`. `requireScope('documents:read')`.
  - `POST /runs` (under `wScope`): resolve `parent_slug` → parent doc; **autonomy gate** (mitigation 54) if `token?.agentId`; **allow-list** (mitigation 55) parent.projectId ∈ allow-list; resolve `agent_slug` → agent doc; **idempotency** (mitigation 56) `getActiveRun` non-null → 409 `RUN_ALREADY_ACTIVE`; if `input` provided, post `kind=comment` from authContext to parent (mitigation 59, after the checks); `ensureRunsTable(tx, {workspaceId, projectId})`; `createRun({workspace, project, runsTable, agent, actor, input:{parentDocumentId: parent.id, firedBy:'manual', chainId: nextChainId({firedBy:'manual'}), triggerId:null}})`; return 201 `{run_id: doc.id, status:'planning'}`. `requireScope('agents:write')`.
  - `POST /runs/:runId/cancel` (under `wScope`): load + re-scope (58); if status ∈ `planning|awaiting_approval` → `transitionRun(runId, {newStatus:'failed', actor, errorReason:'cancelled'})`; if status `running` → post a `kind=rejection` comment (with `target_agent='agent:<run's agent_slug>'`, required by the comment schema) on the parent (the runner's in-loop check aborts — mitigation 44, ONE check path) AND return `{run_id, status:'running'}` (cancel is async for a running row); if terminal → no-op return current. `requireScope('agents:write')`. **(Corrected from `kind=cancel` — no such kind exists; see the cancel reconciliation note above.)**
  - `POST /runs/:runId/retry` (under `wScope`): load original + re-scope (58); `getActiveRun({parentId: original.parentId, agentSlug: original.fm.agent_slug})` non-null → 409 `RUN_ALREADY_ACTIVE` (mitigation 63); resolve agent + parent + workspace + project; `ensureRunsTable`; `createRun({..., input:{parentDocumentId: original.parentId, firedBy:'retry-of:'+runId, chainId: nextChainId({firedBy:'retry-of:'+runId}), triggerId:null}})`; return 201 `{run_id: new.id, status:'planning'}`. `requireScope('agents:write')`.
  - `GET /provider-health` (under `wScope`): `getProviderHealth({workspaceId})` → map each provider's `{status, consecutive_failures}` to `{status, consecutiveFailures}` (camelCase per spec §4g). Session or `documents:read`.

  > **Reconcile at impl time:** verify `runErrorReasonSchema` includes `'cancelled'` (C.2 STATE says yes). Verify the allow-list-derivation helper name (`requireResource` uses one — reuse it, don't re-derive). Verify `getRole`/authContext accessors. The autonomy-gate predicate: if `isAgentOriginated`/the flag check is private to `trigger-matcher.ts`, EXTRACT it to a shared helper (e.g. `lib/autonomy-gate.ts`) so route + matcher share ONE source (per `[[plan-server-source-audit]]`).

- [ ] **Step 4: Mount in `app.ts`.** `pScope.route('/runs', runsListRoute)` for the list verb; `wScope.route('/runs', runsRoute)` for single/POST/cancel/retry; `wScope.route('/provider-health', providerHealthRoute)` (or fold all `wScope` verbs into one router mounted at `/`). Follow the existing mount pattern (e.g. how `events`/`tokens` mount under `wScope`). Run Step-1 tests → PASS.

- [ ] **Step 5: Write the mitigation tests** (54–59, 63). New `describe` blocks: autonomy gate (agent-bound bearer create with flag off → 403 + zero rows; flag on → 1 run; human PAT → 1 run); allow-list (narrowed agent on disallowed parent → 403); idempotency (double POST → 409); cross-scope (workspace-B run id → 404; disallowed-project → 404); input-comment (403 create → zero comments); retry (happy + 409 on active). Run → PASS.

- [ ] **Step 6: Close-out + commit.** Invoke `Skill("netdust-core:testing-workflow")`; full `apps/server` suite + `tsc --noEmit`. Commit:
```bash
git add apps/server/src/routes/runs.ts apps/server/src/routes/runs.test.ts apps/server/src/app.ts apps/server/src/lib/autonomy-gate.ts 2>/dev/null
git commit -m "phase-3: routes/runs.ts — 6 HTTP verbs (D-1; mitigations 54-59,63)"
```

### Task D-2: Migrate the 20 real tools into `agent-tools.ts`

**Files:**
- Modify: `apps/server/src/lib/agent-tools.ts`
- Modify: `apps/server/src/lib/agent-tools.test.ts`

**Binds mitigations:** 57 (carry every lifecycle guard), 26 (Zod re-validation — already in `executeTool`), 34 (`__echo` stays test-gated — unchanged).

- [ ] **Step 1: Extend `ToolDef` with optional transport metadata.** Add `description?: string; inputSchema?: Record<string, unknown>;` to the `ToolDef` interface (agent-tools.ts:40). `executeTool` ignores them; `tools/list` (D-3) reads them. No behavior change. Add a failing test that asserts a registered tool round-trips `description`/`inputSchema`.

- [ ] **Step 2: Write failing direct-`executeTool` tests for a representative migrated tool + the lifecycle guards.** In `agent-tools.test.ts`: register (or rely on D-2's registration) `list_documents`, `create_document`, and `delete_agent`; call `executeTool(token, actor, 'list_documents', args)` and assert it works; call `executeTool(<agent-A bearer>, 'agent:A', 'delete_agent', {slug:'B'})` and assert it rejects (mitigation 57 self-vs-peer / human-PAT). These fail until D-2 registers the tools.

- [ ] **Step 3: Migrate the 20 tools** (list below) as `registerTool({...})` calls, each:
  - `name` (unchanged), `requiredScope` (unchanged), `description` + `inputSchema` (carry the live JSON Schema), `schema` (Zod equivalent — derive from the inline validation each tool does today; `.strict()` per `[[zod-strict-house-style]]`), `handler: async (args, ctx) => {...}` rewritten from the live `(ctx, args)` handler with `ctx.actor` read as a STRING (was `ctx.actor.id`) and `ctx.token`/`ctx.tx` from `ToolContext`.
  - **Lifecycle guards (mitigation 57) move INTO the handlers:** `create_agent`/`update_agent` call `assertAgentAllowListWidening` + `assertAgentToolsWidening` + `mcpRejectHumanPat` (now reading `ctx.token.agentId`); `delete_agent` calls `mcpRejectHumanPat` + self-delete check (`existing.id === ctx.token.agentId`); `get_agent_self` requires `ctx.token.agentId` set. These helpers live in `lib/agent-guards.ts` (unchanged) — the handlers call them.

  **The 20 tools:** `list_workspaces`, `list_projects`, `list_documents`, `get_document`, `get_document_markdown`, `create_document`, `update_document`, `delete_document`, `list_statuses`, `list_fields`, `list_views`, `run_view`, `create_comment`, `list_comments`, `update_comment`, `delete_comment`, `create_agent`, `update_agent`, `delete_agent`, `get_agent_self`. (Verify the count + names against `routes/mcp.ts` TOOLS at impl time — the Explore report found exactly these 20.)

  > **Registration gating:** register these UNCONDITIONALLY (they're production tools), unlike `__echo` (test-gated). Guard against the module-global double-registration: D-2 registers at module load; the existing `__echo` test-teardown hook (`globalThis.__folioToolRegistry`) lets tests clean throwaway regs. Per `[[mock-module-leaks-across-bun-tests]]`, ensure no test registers a real tool name that would collide.

- [ ] **Step 4: Run tests → PASS.** The new direct-`executeTool` tests pass; the `__echo` tests still pass.

- [ ] **Step 5: Close-out + commit.** `Skill("netdust-core:testing-workflow")`; full suite + tsc. 
```bash
git add apps/server/src/lib/agent-tools.ts apps/server/src/lib/agent-tools.test.ts
git commit -m "phase-3: migrate 20 real tools into agent-tools registry (D-2; mitigation 57)"
```

### Task D-3: Refactor `routes/mcp.ts` to a thin transport over `executeTool`

**Files:**
- Modify: `apps/server/src/routes/mcp.ts`
- Verify/extend: `apps/server/src/routes/mcp.test.ts`

**Binds mitigations:** 61 (error mapping, paths-only), 62 (tools/list residual). **Contract: ZERO external behavior change** — every existing `mcp.test.ts` case passes unchanged.

- [ ] **Step 1: Confirm the existing `mcp.test.ts` suite is green** (`cd apps/server && bun test src/routes/mcp.test.ts`). This is the regression baseline — D-3 must not change any of these outcomes.

- [ ] **Step 2: Rewrite the `tools/call` dispatch** to delegate to `executeTool`. Replace the inline `TOOLS.find(...)` + scope-check + handler-call with: resolve `token` + `actor` (string id) from the bearer; `try { const result = await executeTool(token, actor.id, params.name, params.arguments ?? {}); return jsonRpcResult(result); } catch (err) { return mapToolErrorToJsonRpc(err, id); }`. Delete the now-dead inline `TOOLS` array (the tools live in `agent-tools.ts` after D-2) and the inline scope check (`executeTool` does it).

- [ ] **Step 3: Implement `mapToolErrorToJsonRpc`** (mitigation 61):
```typescript
function mapToolErrorToJsonRpc(err: unknown, id: JsonRpcId): JsonRpcResponse {
  const e = err as { message?: string; code?: number; data?: unknown; issues?: unknown };
  // Errors that already carry a JSON-RPC code/data (lifted mcpInvalidParams guards) pass through.
  if (typeof e.code === 'number') {
    return { jsonrpc: '2.0', id, error: e.data !== undefined ? { code: e.code, message: e.message ?? 'error', data: e.data } : { code: e.code, message: e.message ?? 'error' } };
  }
  const msg = e.message ?? String(err);
  if (msg.startsWith('method not found')) return { jsonrpc: '2.0', id, error: { code: -32601, message: msg } };
  if (msg.startsWith('forbidden: scope')) {
    const scope = msg.replace('forbidden: scope ', '').replace(' missing', '');
    return { jsonrpc: '2.0', id, error: { code: -32603, message: msg, data: { required_scope: scope } } };
  }
  if (msg === 'MCP_INVALID_ARGS') return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid arguments', data: { issues: e.issues } } }; // issues = [{path}] — paths only
  return { jsonrpc: '2.0', id, error: { code: -32603, message: msg } };
}
```

- [ ] **Step 4: Rewrite `tools/list`** to enumerate from the `agent-tools.ts` registry (expose a `listToolDefs()` accessor from agent-tools that returns `{name, description, inputSchema}[]`). Unfiltered (mitigation 62). Add a comment citing mitigation 62.

- [ ] **Step 5: Run the existing `mcp.test.ts` → all PASS unchanged** + add `mcp.error-mapping.test.ts` asserting `-32602` with `data.issues` (path, not value) on a bad arg, `-32601` on unknown tool, `-32603` + `data.required_scope` on scope fail. Run → PASS.

- [ ] **Step 6: Close-out + commit.** `Skill("netdust-core:testing-workflow")`; full suite + tsc.
```bash
git add apps/server/src/routes/mcp.ts apps/server/src/routes/mcp.test.ts apps/server/src/lib/agent-tools.ts
git commit -m "phase-3: mcp.ts is now thin transport over executeTool (D-3; mitigations 61,62)"
```

### Task D-4: Add the 5 run-management MCP tools

**Files:**
- Modify: `apps/server/src/lib/agent-tools.ts` (register 5 tools)
- Modify: `apps/server/src/lib/agent-tools.test.ts` + `apps/server/src/routes/mcp.test.ts` (parity)

**Binds mitigations:** 54, 55, 56, 58, 63 (HTTP twins enforce these — the MCP tools share the SAME service-layer enforcement). Spec §4i.

- [ ] **Step 1: Write failing tests** for each tool via `executeTool` AND via the MCP JSON-RPC route (parity, Appendix-B style): `list_runs`, `get_run`, `run_agent`, `cancel_run`, `retry_run`. Each test asserts the tool produces the SAME row mutation / response shape as its HTTP twin (D-1). Include the cross-scope rejection (mitigation 58) for `get_run`/`cancel_run`/`retry_run`.

- [ ] **Step 2: Register the 5 tools** in `agent-tools.ts`, each delegating to the SAME service/runner functions D-1's routes call (so enforcement is shared, not duplicated):
  - `list_runs` (`documents:read`): args `{workspace_slug, project_slug, status?, agent_slug?, since?}` → `listRuns({workspaceId, projectId, status, agentSlug, since, callerAgentProjectsAllowList: <from ctx.token>})`.
  - `get_run` (`documents:read`): `{workspace_slug, run_id}` → load + re-scope (58) → run.
  - `run_agent` (`agents:write`): `{workspace_slug, agent_slug, parent_slug, input?}` → the SAME create path as D-1 POST (autonomy 54 + allow-list 55 + idempotency 56 + input-comment 59). Extract D-1's create logic into a shared `services`/`lib` function (`createRunFromRequest(...)`) so route + tool share ONE implementation — do NOT re-implement.
  - `cancel_run` (`agents:write`): `{workspace_slug, run_id}` → same cancel path as D-1.
  - `retry_run` (`agents:write`): `{workspace_slug, run_id}` → same retry path as D-1 (mitigation 63).
  > **Reconcile:** the args use `workspace_slug`/`project_slug` (the tool's caller doesn't have a resolved-route context like the HTTP handler does). The tool handler must resolve slugs → ids itself + verify the token's workspace matches. Reuse the resolution helpers the route middleware uses.

- [ ] **Step 3: Run tests → PASS** (both direct `executeTool` + JSON-RPC route parity).

- [ ] **Step 4: Close-out + commit.** `Skill("netdust-core:testing-workflow")`; suite + tsc.
```bash
git add apps/server/src/lib/agent-tools.ts apps/server/src/lib/agent-tools.test.ts apps/server/src/routes/mcp.test.ts
git commit -m "phase-3: 5 run-management MCP tools (D-4; HTTP-twin parity, mitigations 54-58,63)"
```

### Task D-5: Wire `resume_run` / `reject_run` builtin triggers to the runner

**Files:**
- Modify: `apps/server/src/lib/trigger-matcher.ts` (replace `handleInternalActionStub`)
- Modify: `apps/server/src/lib/trigger-matcher.test.ts`

**Binds mitigations:** 43 (first-COMMIT-wins race — already in `transitionRun`/`rejectRun`), 52 (idempotency via `getActiveRun excludeRunId`). Fills the C-11 stubs.

- [ ] **Step 1: Write failing tests.** In `trigger-matcher.test.ts`: (a) a `kind=approval` comment event (or the builtin-on-approval trigger firing with `internal_action:'resume_run'`) on a parent with an `awaiting_approval` run → a NEW `planning` row appears with `frontmatter.resume_of` = original id + inherited `chain_id` (the poller would then claim it; `runAgentResume` runs against it); (b) a `kind=rejection` event with `internal_action:'reject_run'` → the `awaiting_approval` run transitions to `rejected` (via `rejectRun`); (c) a double-approval race → exactly one resume row (loser no-ops). These fail against the current stub (log-only).

- [ ] **Step 2: Replace `handleInternalActionStub`** with `handleInternalAction(action, event)`:
  - Resolve the parent doc id + agent slug from the `event` (the event carries `documentId` = the comment id for `comment.*` events; load the comment → its `documentId`/parent + `target_agent`/`frontmatter.run_id`; OR if the builtin trigger's event is the approval/rejection, the payload carries `run_id`/`parent_id` — VERIFY the exact payload shape the approval/rejection events emit at impl time by reading the comment-create emission path).
  - `resume_run`: `getPendingApprovalRun({parentId, agentSlug})` → if null, log + return (nothing to resume); else `createRun({..., input:{parentDocumentId: parentId, firedBy:'resume-of:'+original.id, chainId: original.fm.chain_id, triggerId:null}})` with `frontmatter.resume_of = original.id` (createRun must accept/set `resume_of` — VERIFY; if not, the resume row is created then patched, or createRun gains a `resumeOf?` input field — choose the minimal path). The poller claims it and `runAgentResume` runs. Catch `RUN_TRANSITION_RACED`/`INVALID_RUN_TRANSITION` as benign (mitigation 43).
  - `reject_run`: resolve the `awaiting_approval` run id + the rejection comment id → `rejectRun({runId, rejectionCommentId})` (it catches the races itself).

  > **Reconcile at impl time:** the resume path's exact mechanism — does `runAgentResume` expect a pre-created `running` row, or does the poller transition the new `planning` row → `running` then call `runAgentResume`? Read `runAgentResume` (runner.ts:166) + the poller's dispatch (which decides `runAgent` vs `runAgentResume` based on `frontmatter.resume_of`). The matcher's job is ONLY to create the right `planning` row with `resume_of` set; the poller routes it to `runAgentResume`. Confirm the poller already branches on `resume_of` (C.2 shipped `runAgentResume`; the poller branch may be a C.2/C.3 stub to verify).

- [ ] **Step 3: Run tests → PASS.**

- [ ] **Step 4: Close-out + commit.** `Skill("netdust-core:testing-workflow")`; suite + tsc.
```bash
git add apps/server/src/lib/trigger-matcher.ts apps/server/src/lib/trigger-matcher.test.ts
git commit -m "phase-3: wire resume_run/reject_run internal_actions to runner (D-5; mitigations 43,52)"
```

### Task D-6: `GET /admin/runner-stats`

**Files:**
- Create: `apps/server/src/routes/admin-runner-stats.ts`
- Create: `apps/server/src/routes/admin-runner-stats.test.ts`
- Modify: `apps/server/src/app.ts` (mount under `wScope`)

**Binds mitigations:** 60 (admin-only, aggregate counts only).

- [ ] **Step 1: Write failing tests.** member role → 403; owner/admin → `{pending_count, active_count, recovered_today}` (exactly 3 keys); counts are workspace-scoped (a second workspace's runs don't leak in).

- [ ] **Step 2: Implement.** `GET /admin/runner-stats` under `wScope` (so `resolveWorkspace` sets role). Inline: `const role = getRole(c); if (role !== 'owner' && role !== 'admin') throw new HTTPError('FORBIDDEN', 'admin only', 403);`. Body: `pending_count = await countPendingPlanning()` (verify it can be workspace-scoped — `countPendingPlanning` currently counts ALL planning rows; **reconcile**: either add an optional `workspaceId` filter to `countPendingPlanning` or count via `listRuns({workspaceId, status:'planning'}).length` — prefer a scoped count query for perf); `active_count` = workspace runs at `running`+`awaiting_approval`; `recovered_today` = `events` rows `kind='agent.run.failed'` + `payload.error_reason='worker_crash'` + `created_at >= <UTC midnight ms>` + `workspace_id`. No MCP twin.

- [ ] **Step 3: Mount + run tests → PASS.**

- [ ] **Step 4: Close-out + commit.** `Skill("netdust-core:testing-workflow")`; suite + tsc.
```bash
git add apps/server/src/routes/admin-runner-stats.ts apps/server/src/routes/admin-runner-stats.test.ts apps/server/src/app.ts apps/server/src/services/agent-runs.ts 2>/dev/null
git commit -m "phase-3: GET /admin/runner-stats — admin-only aggregate counts (D-6; mitigation 60)"
```

### Task D-7: SSE `?agent=` + `?table=` filters

**Files:**
- Modify: `apps/server/src/routes/events.ts`
- Modify: `apps/server/src/routes/events.test.ts`

**Binds mitigations:** inherits the existing F3 allow-list narrowing + subject-visibility on the SSE path (no new attack class; AND-combined filters).

- [ ] **Step 1: Write failing tests.** `?agent=<slug>` returns only events whose `payload.agent === slug` (createRun emits `payload.agent` at agent-runs.ts:166); `?table=<tableId>` returns only events for runs under that table; both AND-combine with existing `?parent=`/`?run=`/`?project=`.

  > **Reconcile (`?table=` semantics):** events carry `documentId` + `projectId` + `payload`, NOT `table_id`. An `agent_run` row HAS a `tableId` column (the lazy-seeded runs table). The SSE filter operates on EVENTS, not documents. Options: (a) `?table=` filters events whose `documentId`'s row has `tableId === param` (requires a doc lookup per event — expensive on the live path); (b) createRun ALSO emits `table_id` into the `agent.run.*` event payload, and `?table=` filters `payload.table_id` (cheap, symmetric with `?agent=`). **Prefer (b)** — add `table_id` to the createRun emission payload (one-line change, parity with how `?agent=` reads `payload.agent`), then `?table=` reads `payload.table_id`. Confirm this doesn't break the C.1 event-payload tests; if it does, that's a deliberate payload extension to note in the commit.

- [ ] **Step 2: Implement.** In `events.ts`: parse `?agent=`/`?table=` with the existing `trim() ? undefined` normalization. Replay loop: `if (agent !== undefined && (row.payload as any)?.agent !== agent) continue;` + `if (table !== undefined && (row.payload as any)?.table_id !== table) continue;`. Bus subscribe: pass `{..., agent, table}` to `eventBus.subscribe` (verify the bus filter shape accepts arbitrary payload-key filters, or filter in the subscriber callback like the replay loop does — match whichever pattern `parentId`/`runId` use). If (b) above: add `table_id` to createRun's emission payload.

- [ ] **Step 3: Run tests → PASS.**

- [ ] **Step 4: Close-out + commit.** `Skill("netdust-core:testing-workflow")`; suite + tsc.
```bash
git add apps/server/src/routes/events.ts apps/server/src/routes/events.test.ts apps/server/src/services/agent-runs.ts 2>/dev/null
git commit -m "phase-3: SSE ?agent= + ?table= filters (D-7)"
```

### Task D-8: Sub-phase D integration gate (controller, not a subagent)

- [ ] Full `apps/server` suite green (`cd apps/server && bun test`). Web + shared unchanged (D is server-only) — spot-check they still pass.
- [ ] `bun x tsc --noEmit` clean from `apps/server` for touched files.
- [ ] HTTP↔MCP parity: confirm each of the 5 run tools has a passing twin test against its HTTP verb (D-4 Step 1).
- [ ] Smoke (controller, manual or scripted): `POST /runs` → planning row → (with poller running) claims + transitions; `cancel` on a running run → kind=rejection comment → runner exits; `retry` of a failed run → new planning row, original preserved.
- [ ] `Skill("netdust-core:integration")`.
- [ ] `/code-review --base=cad6443 --effort=medium` with the combined-threat-model invocation contract (B 1–22 + C 23–47 + C.3 48–53 + D 54–63). Name the D mitigations in the reviewer prompt.
- [ ] Sibling-site audit on the D diff (the 5 lockstep classes: TS unions, JSON↔column predicates, event scopes, cross-route guards, closed-enum literals).
- [ ] `Skill("netdust-core:evaluate")` — D sub-phase retro.

### Task D-9 (DEFERRED — separate task, NOT part of the D-2/D-3 migration): tool-error feedback

> Per the D threat-model deferral: redesigning the runner to feed a tool error back to the model as a `{role:'tool'}` message (instead of terminating the run) is a BEHAVIORAL change to the locked terminal-on-tool-error spec (C.2-R-2). It needs its own plan-correction, an infinite-retry guard, a threat-model touch, and its own review loop. Do NOT bundle it into D-2/D-3 (which must be a pure, zero-behavior-change extraction). Schedule as a standalone task after D-8 closes, or defer to a later sub-phase. Tracked here so it's not lost.

---

## D execution outcomes + plan corrections (2026-05-29, post-build)

D-1..D-7 shipped + two-stage reviewed. Reconciliations discovered at build/review time, recorded so this plan matches reality:

- **D-1** (`2ecb1b4`): cancel-of-running posts `kind=rejection` (+`target_agent`), NOT `kind=cancel` (no such comment kind; runner's `wasCancelled` detects post-start rejections — corrected in the cancel reconciliation note above). The `createRunForParent` extraction (review #4) initially reordered idempotency-vs-input-comment; fixed by an early idempotency check on the create verb before the input-comment.
- **D-2** (`4f17050`): registration via explicit `registerRealTools()` (not bare side-effect import — ESM circular-init); 20 tools in sibling `lib/agent-tools-registry.ts`; the 3 MCP-error helpers extracted to `lib/mcp-errors.ts` (shared by registry + mcp.ts so D-3 left no dead copies).
- **D-3** (`f7db7a6`): `routes/mcp.ts` 1271→186 lines. Caught a D-2 latent behavior change — `create_document.type` strict enum masked the service's `COMMENT_REQUIRES_COMMENT_TOOL`; reverted to `z.string()` (handler + service + DB CHECK are the real type gates, matching legacy).
- **D-4** (`a316508`): `createRunForParent` exported + `loadRunScopedByToken` extracted from runs.ts as the shared seam (one impl, two faces). `cancel_run`'s `transitionRun` actor uses `ctx.actor` (the FK-valid `users.id` the MCP route resolves via `getUser`), NOT `token.id` — `documents.updated_by` FKs to `users.id`.
- **D-5** (`fe20e8a`): **plan-correction — `agent-run-schema.ts` `resume_of` was `z.string().uuid()`, which would REJECT a real run id (run ids are `nanoid()`, not UUIDs) at `createRun` parse time. Relaxed to `z.string().min(1)`.** `chain_id` correctly STAYS `.uuid()` (minted via `crypto.randomUUID`). `CreateRunInput` gained an optional `resumeOf?: string`. Owner resolution extracted to a shared `resolveOwnerUser` (no `system:` fabrication, FK-safe).
- **D-6** (`d32f78e`): uses the house `jsonOk` envelope (`{data:{...}}`) not bare `c.json`, matching sibling wScope routes; `data` holds exactly the 3 keys. Computes all 3 counts workspace-scoped (does NOT use the global `countPendingPlanning` — would leak cross-tenant, mit 60).
- **D-7** (`707f070`): Option A (payload enrichment), `?agent=` matches the agent SLUG via `payload.agent`, `?table=` matches `payload.table_id`. **plan-correction — enriched THREE lifecycle emitters (createRun + transitionRun + `recoverOrphanRuns`), not just the two named, so filtering is uniform across the full run lifecycle.** Filtered in the subscriber callback (the bus `SubFilter` only knows kinds/projectId/parentId/runId). Keys are purely additive — rate-limiter (`payload.agent`) + provider-health (`payload.error_reason`) consumers verified unaffected. `?agent=<doc_id>` (spec wording) → the E-phase web client passes the SLUG, which is what the events carry.

**Suite:** 877 (D start) → 942 (D-1..D-7) → **950 / 1 skip / 0 fail** after the D-8 review fixes, tsc clean throughout.

- **D-8 integration gate** (`ef26d47`): `/integration` GREEN — server 942/shared 53/web 559, tsc clean (2 pre-existing root-tsconfig errors in `scripts/`, untouched by D). HTTP↔MCP parity test present. Sibling-site audit spot-checks passed.
- **D-8 `/code-review`** (medium, 7 finder angles × 6 + verify, base `cad6443`, combined threat model 1–63): **4 findings fixed** (`9748a64`) — (1) HIGH: `target_agent` `agent:`-prefix mismatch silently no-op'd approval/rejection + defeated resume idempotency → `normalizeAgentSlug` + prefer `target_agent_id`; (2) HIGH: autonomy gate (mit 54) missing on BOTH retry faces (`POST /runs/:id/retry` + `retry_run`) → added + extracted shared `lib/autonomy-gate.ts::emitChainSuppressed` across all 5 gate sites; (3) MED: MCP `run_agent` left a stray comment on duplicate-active → early `getActiveRun` before the input-comment (HTTP-twin parity); (4) LOW/PLAUSIBLE: admin-runner-stats reachable by an admin-created agent bearer → `authMethod==='token'` 403 guard (session-only). +8 regression tests. Re-review CONFIRMED all 4 fixes correct + no regression (the 5-site gate refactor preserved every event shape + the matcher's distinct `isAgentOriginated` predicate). **1 finding REFUTED** (m54/m55 "existence oracle" — the autonomy gate fires workspace-globally on agent-identity, not per-parent-project, so no cross-project leak; only a workspace-scoped 403-vs-404 already within the agent's trust boundary).
- **DEFERRED cleanup/altitude findings** (real maintainability, non-blocking — recorded in `tasks/retro-follow-ups.md` as D-R-1..D-R-3): allow-list derivation triplicated (runs.ts ctx + registry token + events.ts — promote one `deriveAgentAllowList(token)` to `lib/agent-projects.ts`); cancel-of-running overloads `kind=rejection` as the cancel signal (a first-class `cancel` comment-kind or run-control event is the deeper fix); the create/cancel/retry verb bodies are near-duplicated between the HTTP route and the MCP tools (only `createRunForParent`/`loadRunScopedByToken` shared so far — `cancelRunCore`/`retryRunCore` would finish it).
- **D-8 remaining (user-run):** `/evaluate` (D sub-phase retro). **D-9 still deferred** (tool-error feedback).

---

## Self-review

- **Spec coverage:** §4g (6 routes) → D-1 ✓. §4i (5 MCP tools) → D-4 ✓. §4 shared dispatch → D-2/D-3 ✓. resume/reject wiring → D-5 ✓. admin-stats → D-6 ✓. SSE filters → D-7 ✓. Provider-health route → D-1 ✓.
- **Stale-symbol reconciliation:** every `executeMcpTool`/`mcp-dispatch.ts` reference replaced with `executeTool`/`agent-tools.ts` ✓. Two-ToolDef-shape reconciliation locked ✓. Cancel `error_reason='cancelled'` (not `cancel_requested`) ✓. Retry via `createRun` not `runAgent` ✓.
- **Carried obligations:** C.1-R-1 (FK cascade) → correctly NOT resolved (D adds no hard-delete); kept parked ✓. C.2-R-1/mitigation 27 → D-2/D-3 mitigation 57 ✓. C.2-R-2 (tool-error feedback) → re-scoped to deferred D-9 ✓. D-5 fills the matcher stubs ✓.
- **Type consistency:** `executeTool(token, actor: string, name, args, tx?)` used consistently; `ToolContext.actor` is string throughout; `createRun` always given the full `CreateRunArgs` incl. `runsTable` via `ensureRunsTable` ✓.
- **Placeholder scan:** every code step has concrete code or a named reconcile-at-impl note pointing at a specific file:line ✓.
