# Instance AI Config in `__system` — Design Spec

**Date:** 2026-06-03
**Status:** Design — approved in brainstorming, pending spec review → plan.
**Supersedes:** the run-time B6 rule ("a library agent uses the run-workspace's BYOK key, never `__system`") from the cross-workspace operator arc (`runner.ts` loadContext, ~line 444).

---

## The problem

AI keys live **per-workspace** today (`ai_keys.workspace_id NOT NULL`; a run resolves its key from `run.workspaceId` — the "B6" rule). But the **admin agents are instance-level actors**:

- the **outside / MCP agent** (Claude Code over `/mcp`) is cross-workspace, uses one identity;
- the **production / operator agent** (`__system` library agent) runs cross-workspace, in any customer workspace.

So their AI key is looked up from the *workspace they happen to act in*. **Delete that workspace and the admin agents stop working — even though the instance is healthy and other workspaces exist.** Keys for instance-level actors must not live in a deletable workspace.

**Multi-tenant ≠ multi-workspace.** Folio is "one instance = one team" (CLAUDE.md). A human has many workspaces in one instance. AI keys are an **instance** resource, not a workspace resource — the per-workspace `ai_keys` scoping was an over-scoping.

## The solution

**All providers + keys live in `__system`** — the already-existing, non-deletable, reserved, hidden instance workspace (Phase A). Every agent **references** a `__system` key; the secret never leaves `__system`. The runner reads it server-side at run time. This kills the deletion problem and gives one instance-level AI config store, consistent with "one instance = one team."

### Core model

1. **Storage.** `ai_keys` rows belong to `__system`. The libsodium-encrypted secret lives there only, never copied into a normal (deletable) workspace. (Mechanically: route all key reads/writes at `__system`; `workspace_id` continues to point at the `__system` workspace id. No nullable-column change is required — `__system` IS the instance scope expressed as a workspace. See "Data model" for why this beats a nullable column.)

2. **Agents reference, never copy.** Each agent's frontmatter carries `provider` + `model` + a reference to a `__system` key (by provider; `label` if multiple). The secret is never in frontmatter, never in a tool result, never in an API response.
   - **Admin agents** (operator/production + outside/MCP): use `__system` keys directly — they are instance-level actors.
   - **Worker agents**: at creation (the workspace agent-create form) pick **any** `__system` provider/key; the choice is pinned in the worker's frontmatter. The worker stays bound to its workspace (can't leave unless copied). No per-workspace allow-list — any `__system` key is selectable.

3. **Run key-resolution (REPLACES B6).** During `loadContext`, the runner resolves the agent's referenced key from **`__system`** (system authority), decrypts it, and injects it into the provider call **only**. For EVERY agent — admin and worker. The worker's own token still cannot read `__system` (the auth boundary is unchanged); the key read is a narrow, server-side, runner-only operation — exactly the pattern `loadAgentDefinition` uses to read `__system` skills. No tool exposes key material.

4. **Two edit surfaces, one data store.** The operator and the key store ARE `__system` documents/rows, so:
   - **Direct `__system` access** — System Library members edit the operator's provider/model via its agent slideover, and manage the key store via `__system` AI settings. (Reuses the hidden, member-gated System Library entry shipped in Phase D.)
   - **A dedicated Settings screen** — a friendlier front-end that **writes to the same `__system` docs/keys**. NOT a second data store; just a nicer surface over the same writes.

5. **Migration.** Existing per-workspace `ai_keys` rows consolidate into `__system`. Tie-break when two workspaces hold a key for the same provider: **newest-`created_at` wins** (deterministic, no prompt); the losers are dropped with a one-line migration log naming what was dropped (no silent truncation — see `[[feedback_mock-the-wire-not-the-response]]`/no-silent-caps discipline). On a fresh install there are no keys to migrate.

### Consequence (conscious, accepted)

**Billing shifts** from "the workspace that benefits pays" to "the instance owner's `__system` keys pay for all agent AI usage everywhere." Correct for one-instance-=-one-team; with Ollama (free/local) it is moot. Recorded so it is not re-surfaced as a surprise.

---

## Data model

`ai_keys` today: `(id, workspace_id NOT NULL → workspaces, provider, label, encrypted_key, base_url, created_at)`, unique `(workspace_id, provider, label)`.

**Decision: keep `workspace_id NOT NULL` and point it at the `__system` workspace id** — do NOT make it nullable. Rationale: `__system` already exists as the instance-scope-as-a-workspace; pointing keys at it needs no schema change to the column, no nullable-handling across consumers, and reuses the existing FK + unique index unchanged. (Contrast the api_tokens nullable-reach pattern: tokens needed nullable because an instance token must reach ANY workspace; an AI key needs only to LIVE at the instance, which `__system` already models. Reuse the existing scope concept rather than add a second one.)

**Agent frontmatter:** `provider` + `model` stay as today. A worker that picks a non-default key adds a key reference (e.g. `ai_key_label`, default `'default'`); the resolver uses `(provider, label)` against `__system`. Admin agents reference `(provider, label)` the same way. (Frontmatter-is-schema — invariant 10; no new table for the reference.)

### Consumers to change (full blast radius, grepped)

- `apps/server/src/lib/runner.ts:447-448` — the key lookup. Change `eq(aiKeys.workspaceId, run.workspaceId)` → resolve the `__system` workspace id and look up `(systemId, provider, label)`. **This is the B6 reversal.** Pre-flight `no_ai_key` semantics unchanged (missing `__system` key → no_ai_key).
- `apps/server/src/routes/settings.ts:31-32, 111-114, 135-136` — the AI-key CRUD (GET list, POST upsert, DELETE). Re-scope to `__system` + gate to System Library admin (the instance-admin boundary, `requireInstanceAdmin` from the auth work). Today these are keyed to the URL workspace + that workspace's membership; they move to the `__system` store.
- The web AI surfaces (`apps/web/src/components/settings/ai-tab.tsx`, `apps/web/src/lib/api/settings.ts`) — repoint at the `__system` store; add the dedicated production-agent Settings screen + the operator-slideover provider/model assignment.
- The agent-create form — offer the `__system` provider/key list when creating a worker.

---

## Threat model

> This feature touches BYOK credentials, the multi-tenancy/auth boundary, and REVERSES a shipped security rule (B6). Written at design time so `/code-review` + `/shakeout` verify against named mitigations. Inherits the Phase A/B threat model (T1–T8) and the auth invariants (1–11, esp. 11 — skill trust — as a sibling pattern).

### What we're defending

- **The decrypted AI key material** — libsodium-encrypted in `__system.ai_keys`, decryptable only with `FOLIO_MASTER_KEY`. Must never reach a worker token, a tool result, an API response, frontmatter, or a log.
- **The `__system` key store** — only an instance admin may CRUD it; a normal workspace member/owner must not read or write it.
- **The auth boundary** — a worker token is workspace-pinned and CANNOT read `__system` documents/keys (Phase A/B). The new key read must not punch a hole in that.

### Who we're defending against

- A **prompt-injected worker agent** (runs over attacker-supplied document/comment content) trying to exfiltrate the `__system` key or read keys it wasn't assigned — IN scope.
- A **non-admin workspace member** trying to read/modify the `__system` key store via the re-scoped routes — IN scope.
- An **MCP PAT / outside agent** trying to read key material via a tool — IN scope.
- The **instance owner** (trusted; their key pays for usage) — OUT of scope.

### Attacks → mitigations (code-checkable, numbered)

1. **Worker reads `__system` key via a tool.** → No tool returns key material. The key is read ONLY by the runner in `loadContext` (system authority) and injected into the provider call. There is no `get_key`/`get_ai_key` tool, and `folio_api`/`folio_api_get` cannot reach the `__system` ai-keys route (T6 secret-refuse already classifies `/ai-keys` as SECRET → refused for every token; re-verify it still holds with the `__system` re-scope).
2. **Key leaks into the run context / model prompt / response.** → The decrypted key is passed to the provider call argument only — never into `agentSkills`, the system prompt, a comment, the run body, or a tool envelope. A test asserts the key string never appears in the assembled run messages.
3. **Key leaks into frontmatter.** → Agent frontmatter holds a key *reference* (`provider` + `label`), never the secret. The existing `system_prompt`/`api_token_id` redaction-at-the-loader pattern (`redactLibraryAgentForList`, `serializeApiToken`) covers agent docs; confirm the key reference is not sensitive (it is not — it's a label) and the secret has no frontmatter path.
4. **Non-admin reads/writes the `__system` key store.** → The re-scoped AI-key routes gate on `requireInstanceAdmin` (the shared instance-admin gate from the auth work) — session user who is owner/admin of `__system`. A normal workspace owner is refused (403). The GET list is admin-only too (the store is instance-level config, not per-workspace data).
5. **Worker references a key it shouldn't (no allow-list by design).** → ACCEPTED RESIDUAL: any `__system` key is selectable at worker creation (the agreed model). Mitigation is that creation is itself an `agents:write` op (gated) and the reference is just a label — the worker still never sees the secret. If per-workspace key restriction is wanted later, add an allow-list (out of scope here).
6. **B6 reversal opens a cross-tenant key path.** → The runner reads the key from `__system` for ALL agents now. Confirm this does NOT let a worker's RUN read another *workspace's* data — the key is instance config, not workspace data; the run's document reach is still bounded by the narrowed token (T4) + project ceiling (invariant 3). The key change is orthogonal to document authority.
7. **Migration leaks/duplicates a key into a deletable place.** → The migration MOVES per-workspace rows into `__system` (re-points `workspace_id`), it does not copy. After migration no normal workspace holds an `ai_keys` row. Newest-wins on provider collision; dropped rows are logged.

### Out of scope (explicit)

- Per-workspace key allow-lists for workers (deferred; any `__system` key selectable — attack 5).
- Per-agent billing attribution (the instance owner pays all; accepted consequence).
- Rotating `FOLIO_MASTER_KEY` (operational, unchanged).
- Key material ever being readable by an agent/tool (never — by construction).

### How to use this section

- Controller pre-flight: verify each mitigation is in the plan's task code before dispatch.
- `/code-review` + `/shakeout` (invariant-auditor + security-sentinel): verify the diff against mitigations 1–7; the load-bearing checks are #1/#2 (no key leak path) and #4 (admin-only store).
- `/evaluate` retro: any missing mitigation = a plan-correction defect.

---

## Architecture invariants touched

- **Invariant 4 (HTTP authz):** the AI-key routes move from per-workspace membership to `requireInstanceAdmin`.
- **Invariant 5 (every write through `txWithEvents`):** key CRUD continues to emit events.
- **The B6 run-resolution exception** (Deliberate exceptions list) is REPLACED — update ARCHITECTURE-INVARIANTS.md: the runner reads the `__system` key for all agents, a narrow server-side read mirroring `loadAgentDefinition` (already a ratified exception). Add the AI-key read to that exception entry.

## Out of scope for this phase

- The dedicated production-agent **Settings screen** may ship as a thin first cut (assign provider/model/key for the operator) with the direct-`__system` surfaces as the fallback; full UI polish can follow.
- No change to the provider SDKs, the streaming loop, or the run lifecycle.

## Open detail to settle in the plan

- The exact frontmatter key for the reference (`ai_key_label` vs reusing `label`), and whether admin agents need a reference at all or just `provider` (if `__system` has one key per provider, `provider` alone resolves it). Lean: `provider` + optional `label` (default `'default'`), so single-key-per-provider needs no extra field.
