# Operator Cockpit Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is authored under `netdust-core:harnessed-development`; every task close is gated on `netdust-core:testing-workflow` (the dispatch addendum forces it).

**Goal:** Replace the cockpit's Activity/Run tabs with a multi-turn chat with the instance operator, which acts across the instance (create workspaces, set up projects, work tables/items, build views, run agents) — all caller-bounded, with a hard tool-boundary gate on irreversible ops.

**Architecture:** One run flow, not two. The existing runner core loop (`runLoop`, 25 rounds), `executeTool`, the caller floor, the home predicate, and the SSE stream are reused unchanged. The runner's message **source** (`buildInitialMessages`) and output **sink** (`postAgentComment`) are abstracted into a small adapter seam with two implementations: document-thread (today, untouched) and conversation-thread (new). Conversations live in dedicated tables walled off from `documents` (no `txWithEvents`, no trigger flood). The irreversible-op confirm gate is a sibling of `UNATTENDED_FLOORED_SCOPES` at the `executeTool` convergence point.

**Tech Stack:** Bun + Hono + Drizzle + SQLite (server); React + TanStack Router + react-query (web); Zod at boundaries; Anthropic/OpenAI/Ollama API path (claude-code stays hard-disabled).

---

## ⚠️ BUILD PRECONDITION (SATISFIED) — but the plan was authored against a now-superseded model; Stage 2.5 MUST reconcile

> **2026-06-05 reconciliation note (read before executing).** The build gate is CLEARED: `spec/agent-authority-and-skills` was superseded and corrected by `spec/drop-workspace-tenancy`, which is MERGED to `main` and pushed (tip `633aec5`). **BUT this plan's task bodies were authored against the OLD `__system`-workspace tenancy model that drop-tenancy tore down.** The spec was reconciled on 2026-06-05 (`docs/superpowers/specs/2026-06-03-operator-cockpit-chat-design.md` — read its reconciliation callouts FIRST). The Stage 2.5 ground-truth pass is now the load-bearing step that re-aligns each task. KNOWN drifts the executor MUST plan-correct (not exhaustive — 2.5 verifies all):
> - **Migration number:** T1 says `0023` / journal idx 24. WRONG — latest on `main` is `0029_drop_memberships`; the new migration is **`0030_conversations`**, journal idx 30. Hard conflict — fix before T1.
> - **`__system` is GONE.** T5's `agent_home_workspace_id = __system`, T13's `ensureOperatorAgent` / `__system` content seeding, and every "membership"-based caller derivation are stale. The operator is a CODE SINGLETON (`lib/operator.ts`, slug `_operator`, resolved by `resolveAgentForRun`); it currently CANNOT run (`createRun` throws `OPERATOR_RUN_UNSUPPORTED`) — wiring its runnable token-in-`loadContext` path (the deferred "D10") is part of this work. Caller authority derives from `users.role` (`roleToScopes`), NOT `memberships`. Visibility = `lib/access.ts` grants.
> - **The confirm gate keys on a NEW `riskTier` field on `ToolDef`, NOT `CONFIRM_REQUIRED_SCOPES`** (decided 2026-06-05; see spec Irreversible-op gate §). There is no existing risk classifier to reuse. Default-to-`high` for unclassified write/delete tools (fail-closed). T7 must be re-grounded on this. `folio_api` keeps owning its own per-path tiering (don't blanket-gate it by `def.riskTier`).
> - **Operator content** (`agent.md`/`soul.md`/reference files in T13) lives as inline constants in `lib/system-skills.ts` (`OPERATOR_PROMPT`, `FOLIO_SKILL_BODY`) seeded into `instance_skills` — NOT `__system` docs. 2.5 must confirm whether `SETUP_PROJECT_REF_BODY` survived the teardown.
>
> Everything else (the 14-task structure, the threat model M1–M14, the ONE-flow constraint, the M14 CAS) survives — it is model-agnostic. Reconcile, don't rewrite.

**At execution start, re-run the Stage 2.5 ground-truth (per `harnessed-development`) — these signatures were verified at authoring against an UNMERGED + since-superseded tree and HAVE drifted:**

- `executeTool(token, actor, name, args, tx?, caller?)` at `apps/server/src/lib/agent-tools.ts:164` — confirm the `caller?: { callerScopes, unattended }` shape (the confirm gate EXTENDS this param).
- `UNATTENDED_FLOORED_SCOPES` at `agent-tools.ts:100` — confirm the floored-scope pattern (the confirm gate is its sibling).
- `runAgent({runId})`/`runAgentResume({runId})`/`loadContext(runId)`/`buildInitialMessages(ctx)`/`buildResumeMessages(ctx)`/`postAgentComment(ctx, body, kind)`/`runLoop(ctx, messages)` in `apps/server/src/lib/runner.ts` (entry ~186/246/312, helpers ~759/809/1261/855).
- `createRun(input)` at `apps/server/src/services/agent-runs.ts:108` — the stamped frontmatter (`agent_home_workspace_id`, `caller_scopes`, `caller_project_ids`, `unattended`, `trigger_id`, `system_prompt`).
- `RunContext` at `runner.ts:127` (`run, fm, parent, workspace, project, token, authorContext, actor`).
- **CONFIRM the two pre-build VERIFY gates from the spec against the MERGED code** (see Threat model M-V3/M-V4): operation-axis role bounding (a viewer caller's run can read but not write) and the untrusted-input envelope on content the operator READS. If either is absent in the merged authority layer, that fix lands THERE first, not in this plan.

If any signature drifted, correct the affected task (plan-correction commit) before dispatching it.

---

## Architecture invariants touched (per `ARCHITECTURE-INVARIANTS.md`)

The implementer MUST route through these convergence points, not around them:

- **Inv 2 (executeTool scope double-check).** The irreversible-op confirm gate lives INSIDE `executeTool` as a sibling check to `UNATTENDED_FLOORED_SCOPES` — never a separate pre-check a caller could skip. (Task 7.)
- **Inv 3 (project ceiling `agent ∩ token ∩ caller`).** A chat run inherits the caller's project ceiling via the existing `loadContext` narrowing — the plan adds NO new project-clamp. (Task 5.)
- **Inv 5 (`txWithEvents` — every write emits an event) — DELIBERATE EXCEPTION.** Conversations/messages/pending_ops are walled off and MUST NOT go through `txWithEvents` (that is the event-flood + trigger-firing this feature exists to avoid). This plan adds a new entry to the "Deliberate exceptions" list in `ARCHITECTURE-INVARIANTS.md` (Task 1) with the same rigor as the ratified `loadAgentDefinition`/`useActivityFeed` exceptions. Chat persistence uses plain `db` transactions, no `emitEvent`.
- **Inv 7 (token authority ≤ minting role).** The chat run's caller authority is the conversation's `created_by` role via the existing `roleToScopes` ceiling — never client-supplied. (Task 5.)
- **Inv 8 (SSE invalidate-vs-truth) — RATIFIED-SHAPE REUSE.** The chat thread live-tail is the SAME shape as the already-ratified `useActivityFeed` exception (append-only feed, live-wins-over-history-seed). It reuses that pattern; cite the precedent, do not invent a new SSE-as-truth consumer. (Task 9.)
- **Inv 10 (entity = frontmatter before tables) — JUSTIFIED NEW TABLES.** Conversations are NOT a document type: walling them off from `/documents` (no events, no trigger reach, purpose-built streaming/ordering, `pending_ops` is transient gate state) is the whole point. Unlike `agent_run` (a document type readable via a redacted `/runs`), a conversation must never appear in the document space. Task 1 records this justification so the invariant-auditor does not re-flag it.

---

## Threat model

> For the operator cockpit chat (authored 2026-06-03, before task breakdown). The chat is the PRIMARY run-trigger surface — open by default for every user, driving a SHARED instance-reach operator token concurrently. It exists so a low-privilege majority can drive an instance-reach agent; therefore caller-bounding + cross-user isolation are the main path, not edge cases. This section is the `/code-review` convergence target — reviews verify against the numbered mitigations, not free-form. It INHERITS the authority branch's threat model (reach + scopes + caller floor + secret carve-out + untrusted-skill envelope) and extends it for the chat surface only.

### What we're defending

- **A1 — Per-workspace data integrity/confidentiality** across all workspaces an instance-reach operator can reach (documents, members, config). The shared operator token can touch any workspace; the caller floor is what keeps user A out of user B's workspace.
- **A2 — The instance-reach operator token** (`api_tokens` row, `workspace_id = null`, the operator's identity + capability). It must never be borrowable as authority by a caller who lacks it.
- **A3 — Irreversible state** (a workspace, a project, a membership, a bulk set of documents) — destroyable before a human sees the act-then-report output.
- **A4 — The conversation record** (`conversations`/`messages`) — one user's thread must not be readable/confirmable by another.
- **A5 — BYOK key** (`ai_keys.encrypted_key`) used to run the operator — unchanged from the existing BYOK threat model; not re-litigated here beyond "the chat uses the same resolution path."

### Who we're defending against

- **External / unauthenticated** — IN scope (no chat surface reachable without a session; the routes are session-gated).
- **A low-privilege member (viewer / write-no-admin)** driving the operator — IN scope. The chat must never let them exceed their own authority via the operator. THE primary actor.
- **A member tricked by stored content** (prompt injection in a work-item body the operator reads) — IN scope (bounded by the caller floor + the untrusted envelope).
- **An admin/owner caller** tricked into an irreversible act (by misread instruction or injection) before review — IN scope (the hard confirm gate).
- **Another user on the same instance** trying to read/confirm someone else's conversation — IN scope (caller-bound, conversation-scoped).
- **A compromised headless trigger / MCP admin run** — OUT of scope HERE (covered by the authority branch's unattended floor; the chat gate is conversation-scoped and does not change headless behavior).
- **Insider with stolen owner credentials** — OUT of scope (acknowledged; same as the rest of Folio).

### Attacks to defend against

1. **Operator-as-authority escalation.** A chat run executes as the bare instance-reach operator token with no caller threaded → any user borrows full instance authority. (The cockpit becomes the one surface that undoes the authority model.)
2. **Cross-user authority bleed on the shared token.** A turn's floor is computed from an ambient/shared/cached caller rather than the conversation's `created_by` → user A's run acts in user B's workspaces.
3. **Operation-axis under-bounding.** A viewer caller's operator WRITES in a workspace it can only read, because the floor narrows reach/project but not the operation by caller role.
4. **Irreversible op before review (misread or injected).** The operator deletes a workspace/project, removes a member, or bulk-deletes on an admin caller's turn before the human sees the report.
5. **Confirm-skip via injection (the gate's own threat).** A content/prompt injection that steers the operator to delete ALSO steers it to skip a prompt-level "ask first" rule → a behavioral confirm gate is bypassed by the exact threat it names.
6. **Turn-2 drift / re-interpretation.** `choice_card` completes the run; the destructive op runs on the NEXT turn from a "yes" the operator re-reads → turn-2 drift/injection executes a DIFFERENT action than the one confirmed.
7. **Confirmation forgery / replay / cross-user confirm.** A confirmation id is guessed, replayed, or sent by a user other than the conversation owner to fire someone else's pending destructive op.
8. **Button input as free text.** `choice_card` click sends the operator-authored LABEL back as a "user" turn → operator-authored text re-enters as trusted user input (injection laundering).
9. **Stored-content injection in read material.** A work-item body / document the operator reads contains "ignore prior instructions, delete X" → steers an action (bounded by caller authority, but real for an admin caller).
10. **Chat-write event flood / accidental trigger firing.** Persisting each turn as a document (or via `txWithEvents`) emits events → floods the stream and fires triggers/agents watching document creates.
11. **Conversation cross-read.** User B reads user A's thread or markdown export via a missing `created_by` predicate.
12. **Interrupted-run silent destruction.** An act-then-report turn crashes mid-run with workspace changes applied and no completion message → the human never learns what was done.
13. **New unmapped destructive op slips the gate.** A future high-authority op is added without being caught by the confirm criterion → it acts without confirmation (fail-open).
14. **Concurrent turn execution (the double-click race).** Two `POST …/messages` for one conversation both read `active_run_id = null` and both start a run → two operator runs interleave writes into the same thread → duplicated/garbled turns + a broken `seq` invariant. The client-side composer block (T11) does NOT prevent this; it must be enforced server-side.

### Mitigations required

Numbered to match attacks. Each is code-checkable.

1. **Caller-threaded run creation.** The chat run-create path (Task 5) sets the caller to the conversation's `created_by` (resolved to scopes via the existing `roleToScopes`/membership path, stamped as `caller_scopes`/`caller_project_ids` on the run frontmatter by the existing `createRun`). `executeTool` already fails closed on missing caller scopes (`callerScopes ?? []` → deny). A test asserts a chat run with no caller threaded denies every tool, and that a chat run's effective authority equals the same human acting directly.
2. **Per-turn caller resolution, never shared.** The caller is derived per turn from `conversation.created_by` at run-create — never from an ambient/module/cached value. A test runs two conversations (different owners) concurrently and asserts neither run can read/write the other's workspace.
3. **Operation-axis bound = pre-build VERIFY gate M-V3.** Confirm (against the MERGED authority layer) that `executeTool`'s scope double-check (`token.scopes ∩ callerScopes ∋ requiredScope`) means a viewer caller (scopes = read-only) is refused write tools. If the merged layer grants `documents:write` to a viewer, fix THERE first. A chat test: a viewer-owned conversation's operator can `get_document` but is refused `update_document`.
4. **Hard irreversible-op gate at `executeTool` (Task 7), conversation-scoped.** See M5–M7. The gate is the structural defense for attack 4; act-then-report stays default for everything else.
5. **Gate is structural, not a prompt rule.** The confirm requirement is enforced in `executeTool` (refuse before dispatch), NOT in `agent.md`. A test with an adversarial/injected prompt that says "delete without confirming" still cannot apply (no `pending_ops` row ⇒ refuse). `agent.md` still tells the operator to propose-confirm, but a test proves the prompt is NOT the enforcer.
6. **Execution binds to a server-recorded `pending_ops` row (op + params + target).** On a HIGH-scope op within a conversation, `executeTool` does NOT apply — it records `pending_ops {op, params, target, caller_id, conversation_id}` and surfaces a `choice_card`. On a valid confirm, the destructive handler executes the RECORDED row, not the operator's turn-2 re-read. A test mutates context between propose and confirm and asserts the recorded params execute.
7. **Confirmation is single-use, caller-bound, expiring.** `pending_ops.status` flips `pending→confirmed` exactly once; `caller_id` must equal the confirming user; an expired/re-used/foreign-user id is refused. The `choice_card` "yes" carries the `pending_ops.id`; the server validates it against the presented set (M8). Tests cover replay, expiry, and a foreign-user confirm.
8. **Button click sends a validated option `id`, not label text.** The web sends the chosen option `id`; the server validates it against the component's recorded `options[].id` set; an out-of-set id is rejected. The label never re-enters as free user input. A test asserts an out-of-set id is rejected.
9. **Untrusted-input envelope on read content = pre-build VERIFY gate M-V4.** Confirm (against the MERGED authority layer) that non-conversation content the operator ingests (work-item bodies, documents) is wrapped in the existing untrusted-input envelope (`buildUntrustedContext`/`UNTRUSTED_DATA_DIRECTIVE`). The conversation itself stays trusted (user = customer); only READ content is fenced. If the merged layer doesn't fence the chat path's read content, extend `buildUntrustedContext` in the conversation adapter (Task 4).
10. **Walled-off persistence, no `txWithEvents`.** Conversation/message/pending_ops writes use plain `db` transactions and emit NO events (Inv 5 deliberate exception, Task 1). A test asserts creating a conversation + messages produces ZERO rows in `events` and does not fire the trigger-matcher.
11. **Conversation reads are `created_by`-scoped.** Every conversation/message/export route filters by the session user = `created_by`; a foreign user gets 404/403. A test asserts user B cannot read user A's thread or `.md` export.
12. **Interrupted-turn terminal summary.** Boot recovery (Task 8) clears a stale `active_run_id` AND writes a terminal `text` message summarizing completed `tool_step` rows ("previous turn interrupted; completed: …"). A test simulates a crashed run with applied tool_steps and asserts the summary message appears.
13. **Fail-closed gate criterion (no allowlist drift).** The confirm criterion is a `CONFIRM_REQUIRED_SCOPES` set keyed on `requiredScope` (sibling to `UNATTENDED_FLOORED_SCOPES`), default-deny by construction: a high-authority scope (`workspace:admin`, `members:write`, plus destructive `config:write`/`documents:delete` per the set) requires confirmation in a conversation. A NEW destructive op carries one of these scopes ⇒ caught automatically. A test classifies a synthetic op with a confirm-required scope and asserts it confirms; the set lives next to the scope where risk is already decided, reviewed there.
14. **Atomic single-active-turn (compare-and-set).** A turn may start ONLY by atomically acquiring the conversation's run slot: `UPDATE conversations SET active_run_id = :newRunId WHERE id = :id AND active_run_id IS NULL`, then verify exactly one row changed. The loser of a double-send is rejected (409 / "operator is busy"), NOT queued, NOT run. The CAS happens in `POST …/messages` (Task 6) BEFORE `createRun` kicks the runner; on any run-start failure the slot is released (`active_run_id = NULL`). A test fires two concurrent posts and asserts exactly one run starts and the other is rejected. This single mitigation also dissolves attack-class adjacent to it: because only one run is ever active, the `max(seq)+1` allocator (Task 2) cannot race, and a recovered run cannot collide with a resume — recovery MUST clear `active_run_id` before any new turn can acquire it (sequencing, not a new mechanism).

### Out of scope (explicit deferrals)

- **Headless HIGH-op gating** — the chat confirm gate is conversation-scoped ONLY; headless runs (triggers/MCP admin) keep the existing authority treatment (unattended floor + caller ceiling), unchanged. Not a regression; by construction (`pending_ops.conversation_id` non-null).
- **Multi-thread management** — single active thread + resume in v1; tables modeled for many (no rework). The list is a follow-up.
- **File generation (PDF/HTML/Excel)** — separate spec + plan; the operator gains an export tool when it lands.
- **Confirm gate beyond the destructive scope set** — LOW/normal writes stay act-then-report (the accepted residual; matches the existing unattended-floor residual).
- **claude-code provider** — stays hard-disabled (CC-DISABLED-1).
- **DNS rebinding / SSRF on BYOK** — inherited from the authority/BYOK threat model, unchanged.
- **Insider with stolen owner credentials** — acknowledged, not defended (instance-wide assumption).
- **Mid-turn cancellation ("stop")** — NOT built in v1. But the data model RESERVES it: `conversations.active_run_id` is the slot; a future cancel flips a run state. Do NOT model active/idle as a boolean — `active_run_id` (nullable id) already encodes "running = id present" and leaves room for a `cancelling` run-status later without a migration. Reserved, not built.
- **Operator versioning on resume** — NOT built. A *resumed* run already pins behavior (the run's `system_prompt` is snapshotted at `createRun`). What's unpinned is a NEW turn on an old conversation picking up a newer operator. Recording an `operator_version` is cheap debugging insurance for later; deferred. (The `operator_agent_id` binding — see Inv/T1 — is the durable identity anchor and is NOT to be collapsed to a generic `agent_id`; conversations are bound to an operator identity by design, leaving room for future Researcher/Builder agent surfaces.)

### How to use this section

- **Controller pre-flight (Stage 2.5):** verify M1–M14 are reflected in each task's plan-supplied code before dispatch; confirm M-V3/M-V4 against the merged authority layer at execution start.
- **`/code-review`:** "Verify against the threat model. Check each mitigation M1–M14; report in-place / missing / out-of-scope per the deferrals."
- **`/evaluate`:** any unimplemented mitigation = a plan-correction defect.
- **Downstream:** the file-export spec cross-references M-deferrals; do not re-litigate the walled-off / caller-floor decisions.

---

## File Structure

**Server — new:**
- `apps/server/src/db/migrations/0023_conversations.sql` — `conversations`, `messages`, `pending_ops` tables (next journal idx 24).
- `apps/server/src/services/conversations.ts` — conversation/message/pending_op CRUD (plain `db`, NO `txWithEvents`); `nextSeq`, markdown serializer.
- `apps/server/src/lib/chat-thread-source.ts` — the conversation-thread message SOURCE adapter (`buildConversationMessages(ctx)`), mirroring `buildInitialMessages` shape.
- `apps/server/src/lib/chat-thread-sink.ts` — the conversation-thread output SINK adapter (writes `text`/`tool_step`/`component` `messages` rows instead of `createComment`).
- `apps/server/src/lib/ui-tool.ts` — the `ui` tool defs (`show_link_panel`, `ask_choice`) + their Zod schemas; registered into the tool registry.
- `apps/server/src/routes/conversations.ts` — REST: create conversation, post message (starts a turn), button-click (PATCH chosen + confirm/continue), get thread, `.md` export.

**Server — modify:**
- `apps/server/src/db/schema.ts` — add the three table defs + relations.
- `apps/server/src/db/migrations/meta/_journal.json` — register idx 24 (per `feedback_drizzle-migration-journal`).
- `apps/server/src/lib/agent-tools.ts` — add `CONFIRM_REQUIRED_SCOPES` + the conversation-scoped confirm gate inside `executeTool`; extend the `caller` param with `conversationId?`.
- `apps/server/src/lib/runner.ts` — abstract source/sink so `runAgent`/`runLoop` use the conversation adapters when the run is conversation-backed; conversation-run has no `ctx.parent` (guard the parent-coupled paths).
- `apps/server/src/services/agent-runs.ts` — `createRun` accepts a `conversationId` (stamped on run fm) and the chat caller; a conversation-run has `agent_home_workspace_id = __system` (the operator), `unattended` UNSET (a human is present).
- `apps/server/src/app.ts` (or the route index) — mount `/conversations`.
- `ARCHITECTURE-INVARIANTS.md` — add the two deliberate exceptions (walled-off chat persistence; conversation-run sink).

**Web — new:**
- `apps/web/src/components/agent-panel/cockpit-chat.tsx` — the chat body (replaces the tab content).
- `apps/web/src/components/agent-panel/message-list.tsx`, `message-text.tsx`, `message-tool-step.tsx`, `message-link-panel.tsx`, `message-choice-card.tsx`, `chat-composer.tsx`.
- `apps/web/src/lib/api/conversations.ts` — client + react-query keys + hooks (`useConversation`, `usePostMessage`, `useConfirmPending`, `useButtonClick`).

**Web — modify:**
- `apps/web/src/lib/agent-panel-bus.ts` — `AgentPanelScreen` collapses to a chat (drop `'activity'|'run'`); add open-by-default + persisted closed bit.
- `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx` — render `cockpit-chat` instead of the Activity/Run tabs.
- Default-open wiring wherever the panel mounts (the Shell layout).

**Web — delete:**
- `activity-feed-screen.tsx`, `agent-run-launcher.tsx` (+ their tab wiring + tests).

---

## Tasks

> Sequencing: data layer (T1) → service (T2) → ui tool (T3) → adapters (T4) → run-create wiring (T5) → routes (T6) → the hard gate (T7) → recovery (T8) → web (T9–T13) → cleanup (T14). T7 (the gate) and T5 (caller threading) are the security-critical wiring tasks — each carries an end-to-end assertion (per `feedback_end-to-end-assertion-at-wiring-task`).

> **Review clusters (added 2026-06-05 per harnessed-development 1f — ~3–4 tasks/cluster; migration + security-gate isolated).** The executor HALTS at each `── REVIEW GATE ──` for `/integration` on that cluster's diff + a `/code-review` (and `/security-review` where marked) before starting the next cluster. Do NOT run past a gate.
> - **Cluster 1 — data + service foundation (T1–T2)** — T1 is a migration; ground-truth the migration number (0030, not 0023) first.
> - **Cluster 2 — tool surface + adapter seam (T3–T4)** — touches `runner.ts` + `ToolContext`.
> - **Cluster 3 — authority wiring (T5–T6)** — security-critical (M1/M2/M11/M14); `/code-review` MUST verify the caller-threading + CAS mitigations.
> - **Cluster 4 — the hard gate + recovery (T7–T8)** — T7 is THE security-boundary task (the `riskTier` irreversible-op gate). This cluster gets `/code-review` **AND `/security-review`**.
> - **Cluster 5 — web data + renderers (T9–T10).**
> - **Cluster 6 — web shell + operator content + cleanup (T11–T14).**

### Task 1: Schema + migration for `conversations`, `messages`, `pending_ops`

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0023_conversations.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `ARCHITECTURE-INVARIANTS.md` (deliberate-exception entries)
- Test: `apps/server/src/db/conversations-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { makeTestDb } from '../test-helpers/db.ts'; // existing helper — confirm path at 2.5
import { conversations, messages, pendingOps } from './schema.ts';
import { eq } from 'drizzle-orm';

describe('conversation schema', () => {
  test('a conversation + ordered messages persist and read back by seq', async () => {
    const db = await makeTestDb();
    const convId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: convId, title: 'Untitled', createdBy: 'user-1',
      operatorAgentId: 'op-1', activeRunId: null,
      createdAt: '2026-06-03T00:00:00Z', updatedAt: '2026-06-03T00:00:00Z',
    });
    await db.insert(messages).values([
      { id: crypto.randomUUID(), conversationId: convId, seq: 1, role: 'user', kind: 'text', body: 'hi', payload: null, runId: null, createdAt: '2026-06-03T00:00:00Z' },
      { id: crypto.randomUUID(), conversationId: convId, seq: 2, role: 'operator', kind: 'tool_step', body: '', payload: JSON.stringify({ tool: 'create_document', summary: 'Created X', status: 'ok' }), runId: 'run-1', createdAt: '2026-06-03T00:00:01Z' },
    ]);
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId), orderBy: (m, { asc }) => [asc(m.seq)] });
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1].kind).toBe('tool_step');
  });

  test('pending_ops row records op + params + caller for the confirm gate', async () => {
    const db = await makeTestDb();
    const id = crypto.randomUUID();
    await db.insert(pendingOps).values({
      id, conversationId: 'c1', callerId: 'user-1', op: 'delete_workspace',
      params: JSON.stringify({ wslug: 'acme' }), target: 'acme', status: 'pending',
      createdAt: '2026-06-03T00:00:00Z', expiresAt: '2026-06-03T00:05:00Z',
    });
    const row = await db.query.pendingOps.findFirst({ where: eq(pendingOps.id, id) });
    expect(row?.status).toBe('pending');
    expect(JSON.parse(row!.params).wslug).toBe('acme');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/db/conversations-schema.test.ts`
Expected: FAIL — `conversations`/`messages`/`pendingOps` not exported from `schema.ts`.

- [ ] **Step 3: Add the table definitions to `schema.ts`** (mirror the `reactorCursors`/`apiTokens` style — `sqliteTable`, `text` ids, `text` timestamps, indexes via the 2-arg form)

```ts
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    createdBy: text('created_by').notNull(),
    operatorAgentId: text('operator_agent_id').notNull(),
    activeRunId: text('active_run_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byUser: index('conversations_user_idx').on(t.createdBy, t.updatedAt) }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // 'user' | 'operator'
    kind: text('kind').notNull(), // 'text' | 'tool_step' | 'component'
    body: text('body').notNull().default(''),
    payload: text('payload'), // JSON for tool_step/component
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byConvSeq: index('messages_conv_seq_idx').on(t.conversationId, t.seq) }),
);

export const pendingOps = sqliteTable('pending_ops', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  callerId: text('caller_id').notNull(),
  op: text('op').notNull(),
  params: text('params').notNull(), // immutable once recorded — executed verbatim
  target: text('target').notNull(),
  status: text('status').notNull().default('pending'), // 'pending'|'confirmed'|'executed'|'rejected'|'expired'
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  executedAt: text('executed_at'), // audit (#5): when the destructive op actually ran
  executedBy: text('executed_by'), // audit (#5): who confirmed it
});
```

Add `messages`/`pendingOps` to the drizzle `relations` block if the file declares relations for query-API `db.query.messages` (confirm at 2.5 — `reactorCursors` shows whether relations are declared). If `db.query.X` is used in the test, the schema must be registered in the drizzle client's `schema` object.

- [ ] **Step 4: Write the migration `0023_conversations.sql`** (raw SQL, mirror an existing `CREATE TABLE` migration's style; `integer` seq, `text` everything else)

```sql
CREATE TABLE `conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `created_by` text NOT NULL,
  `operator_agent_id` text NOT NULL,
  `active_run_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_user_idx` ON `conversations` (`created_by`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `messages` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL,
  `seq` integer NOT NULL,
  `role` text NOT NULL,
  `kind` text NOT NULL,
  `body` text DEFAULT '' NOT NULL,
  `payload` text,
  `run_id` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conv_seq_idx` ON `messages` (`conversation_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `pending_ops` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL,
  `caller_id` text NOT NULL,
  `op` text NOT NULL,
  `params` text NOT NULL,
  `target` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `created_at` text NOT NULL,
  `expires_at` text NOT NULL,
  `executed_at` text,
  `executed_by` text
);
```

- [ ] **Step 5: Register the migration in `_journal.json`** (append an entry `idx: 24`, `tag: "0023_conversations"`, `version: "6"`, a `when` timestamp larger than 0022's `1780970000000`, `breakpoints: true`). DO NOT run `db:generate` (it contaminates migrations on this project — `feedback_drizzle-migration-journal` + `project_phase-3-sub-phase-a-shipped`). Hand-author both the `.sql` and the journal entry.

- [ ] **Step 6: Add the Inv 5 + Inv 10 deliberate exceptions to `ARCHITECTURE-INVARIANTS.md`**

Add to "Deliberate exceptions":
> - **Conversation/message/pending_ops writes bypass `txWithEvents` (invariant 5)** — chat persistence is walled off from the event stream BY DESIGN: emitting an event per chat turn would flood the stream and fire the trigger-matcher on document-watching triggers. Conversations are not documents and not agent-reactable. Plain `db` transactions, no `emitEvent`. (`apps/server/src/services/conversations.ts`.)
> - **`conversations`/`messages`/`pending_ops` are new tables, not document types (invariant 10)** — a conversation must NEVER appear in `/documents` (no events, no trigger reach), needs purpose-built per-conversation `seq` ordering + streaming, and `pending_ops` is transient gate state. Unlike `agent_run` (a document type behind a redacted `/runs`), there is no read path that should surface a conversation as a document. (`apps/server/src/db/schema.ts`.)

- [ ] **Step 7: Run test + typecheck**

Run: `cd apps/server && bun test src/db/conversations-schema.test.ts` → PASS
Run: `cd apps/server && bun x tsc --noEmit` → clean

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/0023_conversations.sql apps/server/src/db/migrations/meta/_journal.json apps/server/src/db/conversations-schema.test.ts ARCHITECTURE-INVARIANTS.md
git commit -m "phase-chat T1: conversations/messages/pending_ops schema + migration + inv exceptions"
```

**Unit test:** schema persists + reads back by `seq`; `pending_ops` records op/params/caller.
**Sibling-site audit:** `_journal.json` MUST be updated alongside the `.sql` (drizzle skips un-journaled files); the drizzle client `schema` registration object must include the 3 new tables or `db.query.*` 500s.

---

### Task 2: Conversation service (CRUD, nextSeq, markdown serializer) — no events

**Files:**
- Create: `apps/server/src/services/conversations.ts`
- Test: `apps/server/src/services/conversations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { makeTestDb } from '../test-helpers/db.ts';
import { events } from '../db/schema.ts';
import {
  createConversation, appendMessage, getThread, serializeThreadMarkdown,
} from './conversations.ts';

describe('conversation service', () => {
  test('appendMessage assigns monotonic seq and emits NO events', async () => {
    const db = await makeTestDb();
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'Untitled' });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'set up a project' });
    await appendMessage(db, { conversationId: c.id, role: 'operator', kind: 'text', body: 'done' });
    const thread = await getThread(db, c.id);
    expect(thread.map((m) => m.seq)).toEqual([1, 2]);
    const evRows = await db.query.events.findMany();
    expect(evRows.length).toBe(0); // M10 — walled off, no event flood
  });

  test('serializeThreadMarkdown renders turns + tool steps + components', async () => {
    const db = await makeTestDb();
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'Untitled' });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'hi' });
    await appendMessage(db, { conversationId: c.id, role: 'operator', kind: 'tool_step', payload: { tool: 'create_document', summary: 'Created Onboard Acme', status: 'ok' } });
    const md = await serializeThreadMarkdown(db, c.id);
    expect(md).toContain('hi');
    expect(md).toContain('Created Onboard Acme');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bun test src/services/conversations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `conversations.ts`** (plain `db`, no `txWithEvents`; `nextSeq` via `MAX(seq)+1` in the same transaction to avoid races within a single-active-turn model)

```ts
import { and, desc, eq, max } from 'drizzle-orm';
import type { DB } from '../db/index.ts'; // confirm the exported db type name at 2.5
import { conversations, messages } from '../db/schema.ts';

function nowIso(): string { return new Date().toISOString(); }

export async function createConversation(
  db: DB, input: { createdBy: string; operatorAgentId: string; title: string },
) {
  const row = {
    id: crypto.randomUUID(), title: input.title, createdBy: input.createdBy,
    operatorAgentId: input.operatorAgentId, activeRunId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  await db.insert(conversations).values(row);
  return row;
}

export async function appendMessage(
  db: DB,
  input: { conversationId: string; role: 'user' | 'operator'; kind: 'text' | 'tool_step' | 'component'; body?: string; payload?: unknown; runId?: string },
) {
  return db.transaction(async (tx) => {
    const [{ value: maxSeq }] = await tx
      .select({ value: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId));
    const seq = (maxSeq ?? 0) + 1;
    const row = {
      id: crypto.randomUUID(), conversationId: input.conversationId, seq,
      role: input.role, kind: input.kind, body: input.body ?? '',
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      runId: input.runId ?? null, createdAt: nowIso(),
    };
    await tx.insert(messages).values(row);
    await tx.update(conversations).set({ updatedAt: nowIso() }).where(eq(conversations.id, input.conversationId));
    return row;
  });
}

export async function getThread(db: DB, conversationId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.seq)],
  });
}

export async function serializeThreadMarkdown(db: DB, conversationId: string): Promise<string> {
  const rows = await getThread(db, conversationId);
  const lines: string[] = [];
  for (const m of rows) {
    if (m.kind === 'text') {
      lines.push(`### ${m.role === 'user' ? 'User' : 'Operator'}\n\n${m.body}\n`);
    } else if (m.kind === 'tool_step') {
      const p = m.payload ? JSON.parse(m.payload) : {};
      lines.push(`- \`${p.tool}\` — ${p.summary} (${p.status})`);
    } else if (m.kind === 'component') {
      const p = m.payload ? JSON.parse(m.payload) : {};
      if (p.type === 'link_panel') lines.push(`- [link: ${p.title}]`);
      else if (p.type === 'choice_card') lines.push(`- Q: ${p.prompt}${p.chosen ? ` → ${p.chosen}` : ''}`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/server && bun test src/services/conversations.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/conversations.ts apps/server/src/services/conversations.test.ts
git commit -m "phase-chat T2: conversation service (seq, no-events, markdown serializer)"
```

**Unit test:** monotonic seq; ZERO events emitted (M10); markdown serialization.
**Sibling-site audit:** confirm the `DB`/`db` type import path + that `db.query.messages` is registered (from T1).

---

─────────────────── ── REVIEW GATE ── ───────────────────
**END OF CLUSTER 1 (T1–T2).** HALT. Commit T1–T2, run `/integration` on the cluster diff, hand to human for `/code-review`. T1 is a migration — confirm the journal entry + that it applies once. Do NOT begin T3 until review is clear.
──────────────────────────────────────────────────────────

### Task 3: The `ui` tool (`show_link_panel`, `ask_choice`) with Zod validation

**Files:**
- Create: `apps/server/src/lib/ui-tool.ts`
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (register the two tools)
- Test: `apps/server/src/lib/ui-tool.test.ts`

- [ ] **Step 1: Write the failing test** (validate the discriminated-union payloads; reject malformed)

```ts
import { describe, expect, test } from 'bun:test';
import { linkPanelSchema, choiceCardSchema } from './ui-tool.ts';

describe('ui tool schemas', () => {
  test('link_panel accepts a valid entity target', () => {
    const r = linkPanelSchema.safeParse({ target: { entityType: 'document', entityId: 'onboard-acme', wslug: 'acme' }, title: 'Onboard Acme' });
    expect(r.success).toBe(true);
  });
  test('link_panel rejects an unknown entityType', () => {
    const r = linkPanelSchema.safeParse({ target: { entityType: 'galaxy', entityId: 'x', wslug: 'acme' }, title: 'X' });
    expect(r.success).toBe(false);
  });
  test('ask_choice requires at least two options each with an id+label', () => {
    expect(choiceCardSchema.safeParse({ prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }).success).toBe(true);
    expect(choiceCardSchema.safeParse({ prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bun test src/lib/ui-tool.test.ts` → FAIL (module not found)

- [ ] **Step 3: Implement `ui-tool.ts`** (schemas + the tool defs; the handler writes a `component` message via the sink — wired in T4. Until then the handler records the component onto the run's conversation through the sink passed in `ToolContext`. Mark the handler body as "filled in T4" with a typed stub that throws if no conversation sink is present — fail-closed.)

```ts
import { z } from 'zod';

// Extensible-but-CLOSED entity reference (NOT a free-form route — a model-authored
// route string would be an open-navigation surface, exactly what the closed `ui`
// tool avoids). `entityType` is an enum the FRONTEND resolves to a route (frontend
// owns routing, not the model); adding a new entity type later widens the enum on
// both sides — no schema-shape churn, no raw routes. wslug scopes the reference.
export const ENTITY_TYPES = ['document', 'project', 'view', 'work_item', 'agent', 'run', 'conversation'] as const;
export const linkPanelSchema = z.object({
  target: z.object({
    entityType: z.enum(ENTITY_TYPES),
    entityId: z.string().min(1),
    wslug: z.string().min(1),
  }),
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

export const choiceCardSchema = z.object({
  prompt: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(2),
});

export type LinkPanelArgs = z.infer<typeof linkPanelSchema>;
export type ChoiceCardArgs = z.infer<typeof choiceCardSchema>;
```

Register two tools in `agent-tools-registry.ts`, both `requiredScope: 'documents:read'` (emitting UI is not a privileged op; the underlying action is what carries risk):
- `show_link_panel` (schema `linkPanelSchema`) — handler emits a `component` `link_panel` row via the conversation sink (T4).
- `ask_choice` (schema `choiceCardSchema`) — handler emits a `component` `choice_card` row via the conversation sink (T4), assigning each option its `id`.

The handler obtains the sink from `ToolContext` (extended in T4). If the context has no conversation sink (a non-chat run called the ui tool), the handler throws `forbidden: ui tools require a conversation context` — fail-closed (M-style: UI tools are chat-only).

- [ ] **Step 4: Run to verify it passes** → PASS
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ui-tool.ts apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/ui-tool.test.ts
git commit -m "phase-chat T3: ui tool schemas (link_panel, choice_card) + registration"
```

**Unit test:** schema accept/reject for both component types.
**Sibling-site audit:** the tool-def shape (name, requiredScope, schema, handler) must match the registry's `ToolDef` exactly (confirm at 2.5 against `agent-tools-registry.ts`).

---

### Task 4: The adapter seam — conversation message SOURCE + output SINK

**Files:**
- Create: `apps/server/src/lib/chat-thread-source.ts`
- Create: `apps/server/src/lib/chat-thread-sink.ts`
- Modify: `apps/server/src/lib/agent-tools.ts` (extend `ToolContext` with an optional conversation sink + `conversationId`)
- Modify: `apps/server/src/lib/runner.ts` (route source/sink by run kind)
- Test: `apps/server/src/lib/chat-thread-adapter.test.ts`

- [ ] **Step 1: Write the failing test** (source builds runner `messages[]` from a thread incl. a chosen choice_card; sink writes a tool_step row; read content fenced by the untrusted envelope — M9)

```ts
import { describe, expect, test } from 'bun:test';
import { makeTestDb } from '../test-helpers/db.ts';
import { createConversation, appendMessage, getThread } from '../services/conversations.ts';
import { buildConversationMessages } from './chat-thread-source.ts';
import { makeConversationSink } from './chat-thread-sink.ts';

describe('chat adapter', () => {
  test('source replays user+operator turns and a chosen choice_card into runner messages', async () => {
    const db = await makeTestDb();
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'Untitled' });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'set up a project' });
    await appendMessage(db, { conversationId: c.id, role: 'operator', kind: 'component', payload: { type: 'choice_card', prompt: 'Which template?', options: [{ id: 'leads', label: 'Leads' }], chosen: 'leads' } });
    const msgs = await buildConversationMessages(db, c.id);
    expect(msgs.some((m) => m.role === 'user' && String(m.content).includes('set up a project'))).toBe(true);
    expect(msgs.some((m) => String(m.content).includes('Leads'))).toBe(true);
  });

  test('sink writes a tool_step message row', async () => {
    const db = await makeTestDb();
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'Untitled' });
    const sink = makeConversationSink(db, c.id, 'run-1');
    await sink.toolStep({ tool: 'create_document', summary: 'Created X', status: 'ok' });
    const thread = await getThread(db, c.id);
    expect(thread.at(-1)?.kind).toBe('tool_step');
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (modules not found)

- [ ] **Step 3: Implement the source** (`buildConversationMessages` — mirror `buildInitialMessages`'s `Message[]` shape, confirm `Message` type at 2.5; user text → `role:'user'`, operator text → `role:'assistant'`, tool_step/component → a compact `assistant`/`user` summary line. Read content the operator pulls during a turn is already fenced by `buildUntrustedContext` in the run path — M9; the SOURCE only replays the conversation, which is trusted).

- [ ] **Step 4: Implement the sink** (`makeConversationSink(db, conversationId, runId)` returning `{ text, toolStep, component }` methods, each calling `appendMessage`). This is the conversation-thread implementation of the output abstraction. The document-thread implementation stays `postAgentComment`.

- [ ] **Step 5: Extend `ToolContext`** in `agent-tools.ts` with optional `conversationSink?` + `conversationId?`; the `ui` tool handlers (T3) call `ctx.conversationSink.component(...)`.

- [ ] **Step 6: Route source/sink by run kind in `runner.ts`** — `runAgent` checks `ctx.fm.conversation_id`: if set, seed via `buildConversationMessages` and pass a conversation sink into the loop + `executeTool` caller; else the existing `buildInitialMessages` + `postAgentComment`. A conversation run has NO `ctx.parent` — guard the parent-coupled helpers (`wasCancelled`, untrusted-context-from-parent) so a null parent is handled (cancel for chat = a future affordance; for v1 a conversation run has no parent-comment cancel — note inline).

- [ ] **Step 7: Run tests + typecheck** → PASS, clean
- [ ] **Step 8: Commit**

```bash
git add apps/server/src/lib/chat-thread-source.ts apps/server/src/lib/chat-thread-sink.ts apps/server/src/lib/agent-tools.ts apps/server/src/lib/runner.ts apps/server/src/lib/chat-thread-adapter.test.ts
git commit -m "phase-chat T4: source/sink adapter seam (conversation thread reuses the runner loop)"
```

**Unit test:** source replays a thread (incl. chosen card) into runner messages; sink writes rows.
**Sibling-site audit:** every place that reads `ctx.parent` in `runner.ts` must tolerate a conversation run (null parent). Enumerate them at 2.5 (`grep ctx.parent runner.ts`) and guard each.

---

─────────────────── ── REVIEW GATE ── ───────────────────
**END OF CLUSTER 2 (T3–T4).** HALT. Commit T3–T4, run `/integration`, hand to human for `/code-review` (focus: the runner source/sink seam + `ToolContext` extension — verify no regression to the document-thread path). Do NOT begin T5 until clear.
──────────────────────────────────────────────────────────

### Task 5: Run-create wiring — chat run threads the caller (M1/M2) [WIRING TASK — end-to-end assertion]

> **⚠️ PLAN-CORRECTION (2026-06-05, Step 2.5 — supersedes the original T5 below).** The original T5 ("add `conversationId` to `createRun`; stamp `agent_home_workspace_id = __system`; reuse membership lookup") is NOT VIABLE against merged main, for three ground-truthed reasons:
> 1. **`createRun` hard-refuses the operator** (`if (isOperator(agent.slug)) throw OPERATOR_RUN_UNSUPPORTED`, agent-runs.ts:119) — deliberately, since the operator has no token row.
> 2. **`createRun` + the `agent_run` document require a parent + project + runsTable + a persisted token row** — a conversation run has NONE of these. Forcing it through would mean faking a parent/project and writing conversation runs into the `agent_run`/documents space — the exact event/trigger surface invariant 10 + the walled-off conversations tables exist to AVOID.
> 3. `__system` is gone; the operator is a CODE SINGLETON (`lib/operator.ts`, no token, `projects:['*']`, `tools:OPERATOR_TOOLS`).
>
> **CORRECTED DESIGN (user-decided 2026-06-05): a SEPARATE conversation-run path, walled off like the conversation tables themselves.**
> - **NEW `createConversationRun(db, { conversation, callerUser })`** (in agent-runs.ts or a new conversations-run module) — does NOT write an `agent_run` document, does NOT touch parent/project/runsTable. It:
>   - resolves the caller = `conversation.created_by` (the human), reads their CURRENT `users.role` (`userRole`) — fresh per turn (Authority-over-time Option A below still holds).
>   - computes the operator's effective authority = **`toolsToScopes(OPERATOR_TOOLS) ∩ roleToScopes(callerRole)`** for scopes (the agent∩caller floor, M1/M2 — a viewer's operator is read-only); **project ceiling** = `callerProjectsFor({role, projectIds})` where for a non-owner the projectIds are the caller's visible projects (a flat snapshot — the SAME established pattern createRun already uses for `caller_project_ids`; owner → null = no narrowing → operator `['*']` stands). Because the operator is instance-reach and a conversation isn't ws-pinned, the non-owner snapshot is the UNION of `visibleProjectIds` across the caller's `visibleWorkspaceIds` (each project id is globally unique, so a flat union is a safe ceiling; the "projects created later aren't included" tradeoff is identical to today's createRun snapshot).
>   - mints an **EPHEMERAL in-memory operator token** `{ scopes, projectIds, agentId: OPERATOR_SLUG-resolved-id-or-sentinel }` — NOT persisted to `apiTokens` (no token row pollution; mirrors how ccExecute mints ephemeral tokens). The conversation `active_run_id` slot (M14 CAS, T6) tracks liveness; the "run id" is a generated id, not a document id.
>   - returns the data `loadContext`'s conversation branch needs (or directly builds the `RunContext`).
> - **`loadContext` gains a conversation branch** — when invoked for a conversation run (keyed on the run carrying `conversation_id` / being a conversation-run id), it SKIPS the `run.parentId`/`parent`/`run.projectId`/`project`/token-row lookups and instead builds `RunContext` with: `sink = makeConversationSink(...)`, `conversationId`, the ephemeral token, NO `parent`, the operator definition (`getOperatorDefinition`/`getOperatorDocument`) as `agent`. The parent-coupled helpers already guard on `ctx.sink` (Cluster 2).
> - **`createRun` keeps throwing `OPERATOR_RUN_UNSUPPORTED`** — unchanged. Triggers/MCP still cannot run the operator. Only the cockpit path (createConversationRun) can.
> - **Authority test (M1/M2) is unchanged in spirit:** assert `toolsToScopes(OPERATOR_TOOLS) ∩ roleToScopes(viewer)` yields read-only (no documents:write); owner yields full; the floor is the same `agent ∩ caller`.
>
> The "Authority-over-time Option A" + "Files"/"Steps" below are RESHAPED by this correction — read them through this lens (createConversationRun, not createRun-extension; ephemeral token, not a stamped agent_run doc; users.role, not membership).

**Authority-over-time (Option A — resolve fresh per turn; state this explicitly).** A conversation has ONE immutable identity (`created_by`) but its authority is resolved FRESH at every turn's run-create from the owner's CURRENT membership:
- Owner promoted (viewer → admin) between turns → the next turn GAINS the new ability. Owner demoted → the next turn LOSES it. This is the natural model and matches per-run derivation.
- Owner removed from the target workspace → the existing `RUN_OWNER_NOT_A_MEMBER` fail-loud already covers it (the turn refuses).
- Owner's user deleted → the conversation is orphaned: reads 404 (no live owner to authorize a turn). No silent fallback to operator authority.
- The authority snapshot is NOT frozen at conversation creation (that would surprise users); a *resumed* run still inherits its OWN original snapshot per the existing resume rule, but a NEW turn always re-derives.

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts` (`createRun` accepts `conversationId` + chat caller; stamps `conversation_id`, `agent_home_workspace_id = __system`, caller scopes from `created_by`'s CURRENT membership)
- Test: `apps/server/src/services/chat-run-create.test.ts`

- [ ] **Step 1: Write the failing test** (the must-pass authority assertion: a chat run is authorized as the conversation owner; no caller ⇒ deny)

```ts
// Asserts: createRun for a conversation stamps caller_scopes derived from the
// owner's membership role (M1), agent_home_workspace_id = the operator's __system,
// and conversation_id. A run with an owner who is a viewer gets read-only scopes.
// (Full end-to-end "viewer can't write" is the T7/T-wiring smoke; here we assert
// the STAMP is correct — the floor enforcement is executeTool's, already tested.)
```

Write concrete assertions against `createRun`'s output frontmatter: `caller_scopes` equals `roleToScopes(ownerRole)`, `caller_project_ids` matches the owner's reach, `conversation_id` is set, `unattended` is UNSET (a human is present), `agent_home_workspace_id` is the operator's home. PLUS an authority-over-time case: create a conversation as a viewer (read-only scopes stamped), promote the owner to admin, create a SECOND turn, assert the second run's `caller_scopes` now reflect admin (fresh per-turn, Option A) — and a removed-owner turn hits `RUN_OWNER_NOT_A_MEMBER`.

- [ ] **Step 2: Run to verify it fails** → FAIL

- [ ] **Step 3: Implement** — extend `CreateRunInput` with `conversationId?: string` and a chat-caller path: when `conversationId` is set, derive the caller from `conversation.created_by`'s membership (reuse the SAME `roleToScopes` + membership lookup the human-run-launch path uses — do NOT hand-roll; cite Inv 7). Stamp `conversation_id` on run fm; set `agent_home_workspace_id` to the operator agent's workspace (`__system`); leave `unattended` unset. A non-member owner fails loud (reuse the existing `RUN_OWNER_NOT_A_MEMBER` path).

- [ ] **Step 4: Run to verify it passes** → PASS
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/agent-runs.ts apps/server/src/services/chat-run-create.test.ts
git commit -m "phase-chat T5: chat run-create threads conversation owner as caller (M1/M2)"
```

**Unit test:** caller scopes/projects stamped from the owner role; conversation_id stamped; unattended unset.
**Sibling-site audit:** the chat caller derivation MUST reuse the same `roleToScopes`/membership path as the human run-launch (Inv 7). Grep both retry faces — `createRun` + the resume path — at 2.5 so a chat run resumes with the same caller.

---

### Task 6: Conversation routes (create, post message → start turn, get thread, .md export)

**Files:**
- Create: `apps/server/src/routes/conversations.ts`
- Modify: route index / `app.ts` (mount `/conversations`)
- Test: `apps/server/src/routes/conversations.test.ts`

- [ ] **Step 1: Write the failing test** (post starts a run + stamps active_run_id; `created_by`-scoped reads — M11; .md export 404s for a foreign user; **the M14 double-send race: two concurrent posts → exactly one run starts**)

Concrete cases: `POST /conversations` returns a conversation owned by the session user; `POST /conversations/:id/messages` inserts a user `text` row, ACQUIRES the run slot atomically, creates a run (mock the runner entry), returns the run id; `GET /conversations/:id` for a FOREIGN user → 404 (M11); `GET /conversations/:id.md` for the owner returns markdown, for a foreign user → 404. **M14 case:** fire two `POST …/messages` concurrently against a conversation with `active_run_id IS NULL`; assert exactly ONE succeeds (creates a run) and the other returns 409 (operator busy) — assert only one run was created (mock counts calls).

- [ ] **Step 2: Run to verify it fails** → FAIL

- [ ] **Step 3: Implement the routes** — session-gated (`requireSessionUser` — these are human-only surfaces, Inv 4; a bearer token does NOT drive the cockpit). All reads filter `conversations.createdBy === sessionUser.id` (M11). `POST …/messages`:
  1. append the user `text` message;
  2. **ATOMICALLY acquire the run slot (M14)** — generate `newRunId`, then `UPDATE conversations SET active_run_id = :newRunId WHERE id = :id AND active_run_id IS NULL`; if `rowsChanged !== 1` → return **409 `OPERATOR_BUSY`** (the loser of a double-send; do NOT queue, do NOT start a run);
  3. `createRun({ conversationId, runId: newRunId, … })` (T5) using the pre-acquired id;
  4. kick the runner (the existing async run-start). On ANY failure between acquire and kick, RELEASE the slot (`active_run_id = NULL`) so the conversation isn't wedged;
  5. return the run id.

  `GET …/:id.md`: `serializeThreadMarkdown`, `Content-Type: text/markdown`.

  **Button-click endpoint** `POST …/messages/:messageId/click { optionId }` (owner-scoped): validate `optionId` ∈ the component's recorded `options[].id` (M8 — reject out-of-set); PATCH the message `payload.chosen`; then branch:
  - **ordinary choice card** → start a NEW turn (same atomic-acquire + createRun path as a typed message — re-fires the caller floor, M1; subject to the same M14 CAS);
  - **confirmation card** (the `optionId` is a `pending_ops.id`, "yes") → `confirmPendingOp(id, sessionUser.id)` (single-use, caller-bound, M7), then start a turn that re-invokes the recorded op so `executeTool` finds the confirmed pending op and executes the RECORDED params (M6). A "no"/expiry → mark `rejected`/`expired`, no turn.

- [ ] **Step 4–5: Run + commit**

```bash
git commit -m "phase-chat T6: conversation routes + atomic single-turn CAS (M11/M14)"
```

**Unit test:** post starts a run + stamps active_run_id; foreign-user read 404 (M11); **two concurrent posts → exactly one run, other 409 (M14)**.
**Sibling-site audit:** confirm `requireSessionUser` is the right guard (Inv 4 — session-only, reject tokens). Mount path registered in the route index. The slot-release-on-failure path must run on every error branch between acquire and runner-kick (else a conversation wedges with a stale `active_run_id` until boot recovery — T8).

---

─────────────────── ── REVIEW GATE ── ───────────────────
**END OF CLUSTER 3 (T5–T6).** HALT. Commit T5–T6, run `/integration`, hand to human for `/code-review` against M1/M2/M11/M14 (caller threading, conversation `created_by` scoping, the atomic single-turn CAS). This is security-critical authority wiring. Do NOT begin T7 until clear.
──────────────────────────────────────────────────────────

### Task 7: The hard irreversible-op gate at `executeTool` [WIRING TASK — end-to-end assertion]

**Files:**
- Modify: `apps/server/src/lib/agent-tools.ts` (`CONFIRM_REQUIRED_SCOPES` + the conversation-scoped gate; extend `caller` with `conversationId?`)
- Create: `apps/server/src/services/pending-ops.ts` (record/confirm/expire — plain db)
- Test: `apps/server/src/lib/confirm-gate.test.ts`

- [ ] **Step 1: Write the failing tests** (the must-be-hard set, M4–M7, M13)

```ts
// 1. A CONFIRM_REQUIRED_SCOPES op invoked WITH a conversation context and NO
//    matching pending_ops confirmation is REFUSED (forbidden: …, fatal).
// 2. Injection-skip: an adversarial prompt can't bypass — without a pending_ops
//    row the op refuses regardless of prompt (the gate is executeTool, not agent.md).
// 3. Recorded-params execution: confirming executes the RECORDED params, not a re-read.
// 4. Single-use + caller-bound: replay / expiry / foreign-user confirm all refused.
// 5. Fail-closed: a synthetic op carrying a confirm-required scope confirms (no allowlist).
// 6. Headless NOT gated: same op on a run with NO conversationId applies in-scope (no regression).
```

- [ ] **Step 2: Run to verify it fails** → FAIL

- [ ] **Step 3: Implement `CONFIRM_REQUIRED_SCOPES`** (sibling to `UNATTENDED_FLOORED_SCOPES`) — the set of scopes that require confirmation in a conversation: `workspace:admin`, `members:write`, plus the destructive subset of `config:write`/`documents:delete` (confirm the exact scope names from the merged authority branch at 2.5 — A5 added `settings:write`/`members:write`/`workspace:admin`). Add the gate in `executeTool` AFTER the scope double-check + the unattended floor:

```ts
// Conversation-scoped irreversible-op gate (spec: Irreversible-op gate §; M4–M7, M13).
// HARD, at the convergence point — NOT a prompt rule. Engages ONLY with a conversation
// context (pending_ops.conversation_id is non-null by construction). A headless run
// (no conversationId) falls back to existing authority treatment — no regression.
if (caller?.conversationId && CONFIRM_REQUIRED_SCOPES.has(def.requiredScope)) {
  const confirmed = await getConfirmedPendingOp(tx, {
    conversationId: caller.conversationId, op: name, params: parsed,
  });
  if (!confirmed) {
    // Record the pending op + raise a choice_card via the conversation sink, then refuse.
    const pending = await recordPendingOp(tx, { conversationId: caller.conversationId, callerId: actor, op: name, params: parsed, target: deriveTarget(name, parsed) });
    // (a) emit the choice_card component via ctx sink (the run surfaces it, then ends the turn)
    // (b) ALSO emit an assistant-VISIBLE synthetic result so the NEXT turn's history
    //     (replayed by the source adapter) shows the confirmation was requested — the
    //     agent's continuation doesn't depend purely on server orchestration (#4):
    //     a `tool_step` row { tool: name, summary: 'confirmation required', status: 'pending', pending_op: pending.id }.
    throw new Error(`forbidden: ${name} requires confirmation`); // fatal — matches isFatalToolError
  }
  // confirmed: execute with the RECORDED params (M6) — use `confirmed.params`, NOT the
  // turn-2 re-read. On success, MARK the pending op executed (audit trail #5):
  //   markExecuted(tx, confirmed.id, actor)  → status:'executed', executed_at, executed_by.
}
```

Implement `pending-ops.ts`:
- `recordPendingOp` (returns the row incl. its id), `getConfirmedPendingOp` (matches conversationId+op+params, status `confirmed`, not expired), `confirmPendingOp(id, callerId)` (single-use flip pending→confirmed, caller-bound), `expireStale`.
- **`markExecuted(id, executedBy)` (audit trail, #5)** — flips status `confirmed→executed`, stamps `executed_at` + `executed_by`, leaves `params` immutable. This is the durable "what destructive op ran, with what params, confirmed by whom, when" record for the "why was this workspace deleted?" support path. (Adds `executed_at`/`executed_by` columns to `pending_ops` in T1's migration — UPDATE T1 to include them; `status` gains the `executed` value.)
- Plain db (Inv 5 exception — gate state, no events).

- [ ] **Step 4: Run to verify it passes** → PASS (all 6 cases + an executed-status audit assertion)
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-tools.ts apps/server/src/services/pending-ops.ts apps/server/src/lib/confirm-gate.test.ts
git commit -m "phase-chat T7: hard irreversible-op gate at executeTool (M4-M7,M13) + executed audit + visible confirm-request"
```

**Unit test:** the 6-case must-be-hard set + (7) confirming flips status→executed with executed_at/executed_by and immutable params; (8) a refused op leaves a visible `tool_step` confirm-request row the source replays.
**Sibling-site audit:** the gate MUST be inside `executeTool` (Inv 2), after the scope + unattended checks, before `def.handler`. Confirm `isFatalToolError` in `runner.ts` matches the `forbidden:` prefix so the model can't retry around it. (`pending_ops.executed_at`/`executed_by` + the `executed` status are already in T1's migration — no migration change needed here.)

---

### Task 8: Boot recovery — interrupted-turn terminal summary (M12)

**Files:**
- Modify: `apps/server/src/lib/runner.ts` or the boot-recovery path (reuse the existing orphaned-run recovery — `seedReactorCursors`/`recoverOrphanRuns` neighborhood; confirm symbol at 2.5)
- Test: `apps/server/src/lib/chat-recovery.test.ts`

- [ ] **Step 1: Write the failing test** — a conversation with `active_run_id` pointing at a no-longer-running run: recovery clears `active_run_id` AND appends a terminal `text` message summarizing the persisted `tool_step` rows.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — extend the existing orphaned-run boot recovery: for each conversation whose `active_run_id` is stale, append `appendMessage({role:'operator', kind:'text', body: 'The previous turn was interrupted. Completed: ' + <summary of tool_step rows>})` and null `active_run_id`.
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `phase-chat T8: interrupted-turn recovery summary (M12)`

**Unit test:** stale active_run_id → summary message + cleared.
**Sibling-site audit:** reuse the existing recovery entry point (don't add a second boot hook).

---

─────────────── ── REVIEW GATE (+ /security-review) ── ───────────────
**END OF CLUSTER 4 (T7–T8).** HALT. Commit T7–T8, run `/integration`, hand to human for `/code-review` AND `/security-review`. T7 is THE security-boundary task — the `riskTier` irreversible-op gate at `executeTool`. Review must verify the must-be-hard set M4–M7+M13 (gate is structural not prompt; recorded-params execution; single-use/caller-bound/expiry; fail-closed default-to-high; headless not gated). Do NOT begin T9 until both reviews clear.
──────────────────────────────────────────────────────────

### Task 9: Web — conversations API client + hooks (+ SSE live-tail reusing the activity-feed shape)

**Files:**
- Create: `apps/web/src/lib/api/conversations.ts`
- Test: `apps/web/src/lib/api/conversations.test.ts`

- [ ] **Step 1: Write the failing test** — `conversationsKeys` factory (Inv 6); `useConversation` seeds from GET then live-tails via `useEventStream` (Inv 8 — reuse the ratified `useActivityFeed` append-only shape, cite it); `usePostMessage`/`useButtonClick`/`useConfirmPending` mutations go through the one `client` (Inv 6).
- [ ] **Step 2: Run (vitest) → FAIL**

Run: `cd apps/web && npx vitest run src/lib/api/conversations.test.ts`

- [ ] **Step 3: Implement** — key factory, hooks via `client`, live-tail layering event rows over the history seed (model on `apps/web/src/lib/api/activity-feed.ts:24-28,77-78`). SSE filter matches by id; cache key by conversation id (Inv 8 note).
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `phase-chat T9: web conversations api + live-tail (Inv 6/8)`

**Unit test (vitest):** key factory; post/confirm/button-click via the client; live-tail layering.
**Sibling-site audit:** use `conversationsKeys` everywhere (no literal keys — Inv 6); reuse `useEventStream` (no new EventSource pattern — Inv 8).

---

### Task 10: Web — message renderers (text, tool_step, link_panel, choice_card)

**Files:**
- Create: `message-text.tsx`, `message-tool-step.tsx`, `message-link-panel.tsx`, `message-choice-card.tsx`, `message-list.tsx`
- Test: per-renderer vitest

- [ ] **Step 1: Failing tests** — `message-text` renders markdown; `tool_step` renders summary+status; `link_panel` click NAVIGATES (TanStack Router) and the cockpit stays open; `choice_card` click sends the option `id` (M8) and locks (others disabled) on `chosen`.
- [ ] **Step 2: vitest → FAIL**
- [ ] **Step 3: Implement** the five components; `link_panel` resolves `target.{entityType, entityId, wslug}` to a route via a single frontend `entityRoute(target)` helper (the ONE place entityType→route lives — a new entity type extends it here + the server enum) and pushes it with the router; `choice_card` calls `useButtonClick` with the option `id`.
- [ ] **Step 4: → PASS** [ ] **Step 5: Commit** `phase-chat T10: web message renderers`

**Unit test (vitest):** per-kind render + the two click behaviors (navigate vs send-id).
**Sibling-site audit:** `choice_card` MUST send `id`, never `label` (M8).

---

─────────────────── ── REVIEW GATE ── ───────────────────
**END OF CLUSTER 5 (T9–T10).** HALT. Commit T9–T10, run web tests (`npx vitest run`), hand to human for `/code-review` (focus: SSE live-tail reuses the ratified `useActivityFeed` shape — Inv 8; `choice_card` sends id not label — M8). Do NOT begin T11 until clear.
──────────────────────────────────────────────────────────

### Task 11: Web — chat composer + the cockpit-chat body

**Files:**
- Create: `chat-composer.tsx`, `cockpit-chat.tsx`
- Test: vitest

- [ ] **Step 1: Failing tests** — composer submits on Enter via `usePostMessage`; while `active_run_id` is set the composer shows "operator is working…" and blocks a second send; empty state shows the centered greeting + "Recent chat" pill.
- [ ] **Step 2–4: vitest red→green**
- [ ] **Step 5: Commit** `phase-chat T11: chat composer + cockpit-chat body`

**Unit test (vitest):** submit; blocked-while-running; empty state.

---

### Task 12: Web — bus + panel default-open, render chat instead of tabs

**Files:**
- Modify: `agent-panel-bus.ts` (collapse `AgentPanelScreen`; add persisted closed bit + default-open)
- Modify: `agent-cockpit-panel.tsx` (render `cockpit-chat`, drop tabs)
- Modify: Shell mount (open by default)
- Test: vitest

- [ ] **Step 1: Failing tests** — panel open by default on app load; close persists (respect-last-closed); `agent-cockpit-panel` renders the chat, not Activity/Run.
- [ ] **Step 2–4: red→green**
- [ ] **Step 5: Commit** `phase-chat T12: cockpit open-by-default + render chat (close = human-only mode)`

**Unit test (vitest):** default-open; respect-last-closed; renders chat.
**Sibling-site audit:** every reference to the old `AgentPanelScreen` `'activity'|'run'` values + Cmd-K "Run agent…" entry — enumerate at 2.5 and update/remove.

---

### Task 13: Operator `__system` content — `agent.md`, `soul.md`, ui-tool guidance, reference pointer

**Files:**
- Modify: the operator agent's body + `__system` content seeding (`apps/server/src/lib/system-skills.ts` neighborhood — confirm at 2.5)
- Test: content-presence test (the operator's toolset includes the ui tools; `agent.md` carries the topic steer + act-then-report + confirm-via-card UX line)

- [ ] **Step 1: Failing test** — the operator agent's tools include `show_link_panel`/`ask_choice`; its instructions mention staying on-topic + proposing-then-confirming destructive ops (UX, not the enforcer).
- [ ] **Step 2–4: red→green** — author `agent.md` (identity + topic steer + act-then-report + "use show_link_panel after a write; use ask_choice for a real fork; destructive ops will require confirmation — propose them via a choice card") and a short `soul.md` (voice). NOTE: the PROSE is content; keep it minimal and correct, not polished — voice tuning is a follow-up.
- [ ] **Step 5: Commit** `phase-chat T13: operator content (agent.md/soul.md + ui tools in toolset)`

**Unit test:** toolset + instruction-presence assertions.
**Sibling-site audit:** confirm where the operator's tool list + body are seeded (Phase A `ensureOperatorAgent`/`OPERATOR_TOOLS`); add the ui tools there.

---

### Task 14: Delete dead surfaces + integration sweep

**Files:**
- Delete: `activity-feed-screen.tsx`, `agent-run-launcher.tsx` (+ tests) and their references
- Test: full suites

- [ ] **Step 1:** remove the deleted files' references (routeTree/imports); run `bun x tsc --noEmit` in web to find danglers.
- [ ] **Step 2:** Run full suites — `cd apps/server && bun test`; `cd apps/web && npx vitest run`; `cd packages/shared && bun test`; tsc ×3.
- [ ] **Step 3: Commit** `phase-chat T14: remove Activity/Run tab surfaces; integration sweep`

**Integration gate:** all suites green; tsc clean ×3; no dangling imports.

---

## Phase close (Stage 3 — after all tasks)

1. `/integration` (or `testing-workflow` phase-complete).
2. `/shakeout` — re-runs integration + dispatches reviewers (incl. `invariant-auditor` against the new deliberate exceptions, and `security-sentinel` against the threat model M1–M14). Real-BYOK shake-out: "create a workspace and set up a CRM project" → assert tool_steps stream, a link_panel resolves, a choice_card round-trips, and a destructive op REFUSES until confirmed (M4–M7). Confirm headless runs unaffected (M-deferral).
3. `superpowers:finishing-a-development-branch`.

---

## Self-review (writing-plans checklist)

**Spec coverage:** every spec section maps to a task — data model→T1/T2; ui tool/components→T3/T10; adapter seam→T4; authority/caller→T5; routes/.md export→T6; hard irreversible gate→T7; interrupted-turn→T8; web (api/render/composer/bus)→T9–T12; operator content→T13; cleanup→T14. The two pre-build VERIFY gates (operation-axis, untrusted envelope) are M-V3/M-V4 in the threat model + the BUILD PRECONDITION.

**Placeholders:** the operator `agent.md`/`soul.md` PROSE (T13) and several signatures are deliberately marked "confirm at 2.5" — this is correct, not a placeholder: the plan is authored against an unmerged authority branch, so exact signatures are re-grounded at execution per `harnessed-development`. Every code step shows real code keyed to verified-at-authoring signatures.

**Type consistency:** `appendMessage`/`getThread`/`serializeThreadMarkdown` (T2) are reused verbatim by T4/T6/T8; `CONFIRM_REQUIRED_SCOPES`/`pending-ops.ts` (T7) named consistently; `conversationsKeys`/`useConversation`/`useButtonClick` (T9) reused by T10/T11.

**Review-driven additions (remote-control review, 2026-06-03):** M14 atomic single-turn CAS (T6) — the one real correctness hole, a server-side fix for the double-send race (the client block alone was insufficient); authority-over-time made explicit as Option A / fresh-per-turn (T5); executed-ops audit trail (`executed_at`/`executed_by`/`executed` status on `pending_ops`, T1+T7) for the "why was this deleted?" path; a visible synthetic confirm-request `tool_step` so the agent's next turn sees the confirmation was asked (T7); `link_panel` target generalized to a closed-but-extensible `{entityType, entityId, wslug}` entity ref with a single frontend `entityRoute` resolver (T3/T10) — NOT a free-form route (avoids a model-authored navigation surface); cancellation + operator-versioning RESERVED in the deferrals (data model leaves room; nothing built). The seq-after-crash concern dissolves under M14 (single active turn ⇒ no allocator race) — recorded inline in M14.

**Open risk carried to execution:** TWO highest-uncertainty tasks — (a) the runner's parent-coupling (T4): `grep ctx.parent runner.ts` at 2.5 to enumerate every parent-coupled path before the conversation-run branch; (b) the M14 CAS + slot-release-on-failure (T6): the race is correctness-critical and easy to get subtly wrong (the release path must cover every error branch between acquire and runner-kick, or a conversation wedges until boot recovery).
