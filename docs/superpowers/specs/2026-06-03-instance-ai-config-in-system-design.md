# Instance AI Config in `__system` — Design Spec

**Date:** 2026-06-03
**Status:** Design — corrections folded in (2026-06-03 handoff); ready for spec review → plan.
**Supersedes:** the run-time B6 rule ("a library agent uses the run-workspace's BYOK key, never `__system`") from the cross-workspace operator arc (`runner.ts` loadContext, ~line 444).
**Context:** `main` is local-only / pre-production; this migration runs ONCE, now, on a local DB that currently holds ZERO `ai_keys` rows (verified). The migration is therefore a pure schema change — see "Data model".

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

1. **Storage.** AI keys are **workspace-independent instance credentials** — a standalone `ai_keys` row with **no workspace tie at all**, identified by `(provider, label)`. The libsodium-encrypted secret lives once, never copied. (CORRECTED from the original "point `workspace_id` at `__system`" — see "Data model": the column is DROPPED, not sentineled. Conceptually these are instance-authority config under `__system`'s administration, but the *row* carries no `workspace_id`.)

2. **Agents reference, never copy.** Each agent's frontmatter carries `provider` + `model` + a reference to a `__system` key (by provider; `label` if multiple). The secret is never in frontmatter, never in a tool result, never in an API response.
   - **Admin agents** (operator/production + outside/MCP): use `__system` keys directly — they are instance-level actors.
   - **Worker agents**: at creation (the workspace agent-create form) pick **any** `__system` provider/key; the choice is pinned in the worker's frontmatter. The worker stays bound to its workspace (can't leave unless copied). No per-workspace allow-list — any `__system` key is selectable.

3. **Run key-resolution (REPLACES B6).** During `loadContext`, the runner resolves the agent's referenced key from **`__system`** (system authority), decrypts it, and injects it into the provider call **only**. For EVERY agent — admin and worker. The worker's own token still cannot read `__system` (the auth boundary is unchanged); the key read is a narrow, server-side, runner-only operation — exactly the pattern `loadAgentDefinition` uses to read `__system` skills. No tool exposes key material.

4. **Two edit surfaces, one data store.** The operator and the key store ARE `__system` documents/rows, so:
   - **Direct `__system` access** — System Library members edit the operator's provider/model via its agent slideover, and manage the key store via `__system` AI settings. (Reuses the hidden, member-gated System Library entry shipped in Phase D.)
   - **A dedicated Settings screen** — a friendlier front-end that **writes to the same `__system` docs/keys**. NOT a second data store; just a nicer surface over the same writes.

5. **Migration (trivial — one-time, local, empty table).** The local DB holds ZERO `ai_keys` rows (verified), and this runs once pre-production. So the migration is a **pure schema change**: rebuild `ai_keys` WITHOUT `workspace_id`, with unique `(provider, label)`. No consolidation, no validation, no network, no admin-prompt — there is nothing to migrate. Keep ONE dead-path guard purely for correctness if rows ever existed: newest-`created_at` wins on a `(provider, label)` collision, log every dropped row (provider, label, source workspace) — a path this run will never hit. (CORRECTED from the original validate/surface-to-admin tie-break, which solved a collision case that cannot occur here. `base_url` would be part of collision identity IF the guard ever fired.)

### Consequence (conscious, accepted)

**Billing shifts** from "the workspace that benefits pays" to "the instance owner's `__system` keys pay for all agent AI usage everywhere." Correct for one-instance-=-one-team; with Ollama (free/local) it is moot. Recorded so it is not re-surfaced as a surprise.

---

## Data model

`ai_keys` today: `(id, workspace_id NOT NULL → workspaces, provider, label, encrypted_key, base_url, created_at)`, unique `(workspace_id, provider, label)`.

**Decision (CORRECTED): DROP `workspace_id` (and its FK).** Keys are workspace-independent, so model that directly:
- Drop `workspace_id` + the FK to `workspaces`.
- New unique index: `(provider, label)`.
- Why drop, not sentinel: a `__system`-pointed `workspace_id` encodes a workspace coupling that no longer exists, forces every key read to resolve the `__system` id first, and leaves an invisible special case in a credentials table. Dropping makes the lookup pure `(provider, label)` — no workspace dimension at any call site — and the "instance resource" fact is enforced by the schema, not convention.
- Column-drop mechanics: **confirm the engine first** (modern `bun:sqlite` `ALTER TABLE DROP COLUMN` vs. a table-rebuild migration like the existing `0006`/`0022` rebuilds; trivial on Postgres). The table is empty, so a rebuild is cheap.

**`label` is load-bearing.** The unique key is `(provider, label)`, so `__system` MAY hold multiple keys per provider. The resolver, the worker-create form, AND the operator slideover must all disambiguate by `label`, never assume one-key-per-provider. Default `'default'`.

**Agent frontmatter:** `provider` + `model` stay as today; add a key reference (`ai_key_label`, default `'default'`). The resolver looks up `(provider, ai_key_label)`. Admin and worker agents reference identically. (Frontmatter-is-schema — invariant 10; no new table for the reference. The reference is a non-secret label — never the key.)

## Worker / admin split (the security boundary — do not blur)

`__system` homes **providers, keys, and admin/library agents ONLY** (operator/production + outside/MCP). **Worker agents are NOT moved into `__system`** — they stay in their own workspaces and merely *reference* a key by `(provider, label)` in frontmatter. Moving workers into `__system` would forfeit the workspace-pinning that stops a prompt-injected worker from reaching instance config. The key MATERIAL is read only by the runner (system authority); the worker token's reach is unchanged.

### Consumers to change (full blast radius, grepped)

- `apps/server/src/lib/runner.ts:447-448` — the key lookup. Change `eq(aiKeys.workspaceId, run.workspaceId)` → a pure `(provider, ai_key_label)` lookup with NO workspace predicate (no `__system` id resolution; the column is gone). **This is the B6 reversal.** Pre-flight `no_ai_key` semantics unchanged (no matching `(provider, label)` → no_ai_key).
- `apps/server/src/routes/settings.ts:31-32, 111-114, 135-136` — the AI-key CRUD (GET list, POST upsert, DELETE). DROP the `workspace_id` predicate; re-gate from per-workspace membership to `requireInstanceAdmin` (the shared instance-admin gate from the auth work). GET list is admin-only too — instance config, not per-workspace data. (The route path keeps `:workspaceId` for now or moves to an instance path — plan-time UI decision; either way the gate is `requireInstanceAdmin` and the query has no workspace predicate.)
- The web AI surfaces (`apps/web/src/components/settings/ai-tab.tsx`, `apps/web/src/lib/api/settings.ts`) — repoint at the global key store; add the dedicated production-agent Settings screen + the operator-slideover provider/model/`ai_key_label` assignment. (Two surfaces, one store — both write the same rows.)
- The agent-create form — offer the global `(provider, label)` list when creating a worker.

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
7. **Migration leaks/duplicates a key into a deletable place.** → The migration DROPS `workspace_id` entirely; after it, no row carries any workspace tie (the table is empty here regardless). A test asserts no `ai_keys` row has a `workspace_id` column post-migration.

8. **Denial-of-wallet / shared-credential abuse (NEW — introduced by consolidation).** All agents now draw on the shared `__system` keys, so a prompt-injected worker in ANY workspace can exhaust rate limits or run up spend across the whole instance (the per-workspace blast radius is gone). This is a CONSEQUENCE of consolidation, not a reason against it. → Mitigation: per-key usage metering + optional caps. **At minimum, meter usage per workspace for visibility** even though billing is consolidated, so abuse is attributable. If caps aren't built this phase, record as an EXPLICIT residual (it is currently free under Ollama, but a paid `__system` key makes it live). DECISION NEEDED at plan time: caps in-phase vs. metered-residual — note the worker "any key, no allow-list" choice (attack 5) sharpens this, since any worker can reach the expensive key.

### Out of scope (explicit)

- Per-workspace key allow-lists for workers (deferred; any `__system` key selectable — attack 5).
- Per-agent billing attribution (the instance owner pays all; accepted consequence).
- Rotating `FOLIO_MASTER_KEY` (operational, unchanged).
- Key material ever being readable by an agent/tool (never — by construction).

### How to use this section

- Controller pre-flight: verify each mitigation is in the plan's task code before dispatch.
- `/code-review` + `/shakeout` (invariant-auditor + security-sentinel): verify the diff against mitigations 1–8; the load-bearing checks are #1/#2 (no key leak path) and #4 (admin-only store); #8 (denial-of-wallet) is the consolidation-introduced residual to confirm metered-or-capped.
- `/evaluate` retro: any missing mitigation = a plan-correction defect.

---

## Architecture invariants touched

- **Invariant 4 (HTTP authz):** the AI-key routes move from per-workspace membership to `requireInstanceAdmin`.
- **Invariant 5 (every write through `txWithEvents`):** key CRUD continues to emit events.
- **The B6 run-resolution exception** (Deliberate exceptions list) is REPLACED — update ARCHITECTURE-INVARIANTS.md: the runner reads the `__system` key for all agents, a narrow server-side read mirroring `loadAgentDefinition` (already a ratified exception). Add the AI-key read to that exception entry.

## Out of scope for this phase

- The dedicated production-agent **Settings screen** may ship as a thin first cut (assign provider/model/key for the operator) with the direct-`__system` surfaces as the fallback; full UI polish can follow.
- No change to the provider SDKs, the streaming loop, or the run lifecycle.

## Tests to add / keep

- **Key string never appears** in the assembled run messages / system prompt / tool envelopes (mitigation 2).
- **Non-admin → 403** on EVERY key-store route, GET included (mitigation 4).
- **Post-migration:** no row carries `workspace_id` (column gone); unique is `(provider, label)`; (dead-guard) a synthetic collision logs + newest-wins.
- **Invert the B6 tests — do NOT delete them.** Find every test asserting the OLD rule ("library agent uses the run-workspace key, never `__system`") and FLIP it to assert the new `(provider, label)` resolution. A test left asserting the old rule will either fail or get silently "fixed" to assert the wrong thing (the verify-claims discipline). Grep: `runner.test.ts` B5/B6 key-resolution tests, the cross-workspace operator tests, `phase-gate-b.integration.test.ts`.
- **`label` disambiguation:** two `__system` keys for one provider (e.g. two ollama labels) resolve distinctly; an agent referencing `ai_key_label: 'X'` gets X's key, not the other.
- **T6 secret-refuse re-verified** on the re-scoped `/ai-keys` route (still SECRET → refused for every token after the move to `requireInstanceAdmin`).

## Non-goals / do not build

- **No multi-tenant / DB-per-tenant work.** Tenancy is a future instance-level concern (a separate database, not a workspace). Do NOT add a tenant router or connection routing here. Only constraint: don't introduce a NEW hardcoded global `db` singleton.
- **Provider/key split is OUT of scope** unless explicitly requested. Keep provider config + secret in the one `ai_keys` row this phase. (Splitting non-secret provider config from the secret is a clean future refinement, not part of this.)
- **Triggers are not part of this spec.** If encountered, apply the scope test (instance-level trigger → `__system`; workspace trigger → its workspace); do NOT blanket-home them into `__system`.

## Open detail to settle in the plan

- The exact frontmatter key for the reference — lean `ai_key_label` (default `'default'`); whether admin agents need it or just `provider` (single key per provider → `provider` alone resolves, label defaults). The `label` is load-bearing regardless (multi-key-per-provider is allowed).
- **Confirm the column-drop mechanic for `bun:sqlite`** (native `DROP COLUMN` vs. table-rebuild) before writing the migration — the table is empty so either is cheap, but the SQL differs.
- **Denial-of-wallet (attack 8):** caps in-phase vs. metered-residual.
