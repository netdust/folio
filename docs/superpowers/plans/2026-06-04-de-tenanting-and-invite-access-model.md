# De-Tenanting + Invite-Based Access Model — Correction Plan

> **Status:** APPROACH plan for review (not yet broken to per-step TDD). Branch `claude/multi-tenancy-code-audit-m8R5G`. Authored 2026-06-04 from the multi-tenancy code audit + the file-by-file machinery inventory. When approved, each Phase below expands to a per-task TDD plan under `superpowers:executing-plans`.

## Why this plan exists

CLAUDE.md and `memory/DECISIONS.md` lock it: **"Multi-tenancy: out of scope. One instance = one team. Workspaces are inside an instance."** But Phases A–D + the operator-agent work (~135 commits) built a *de facto* multi-tenant **isolation** system on top of a product that contractually isn't multi-tenant:

- a reserved `__system` workspace treated as a tenant, with provenance/taint assertions (`SYSTEM_WORKSPACE_TAINTED`),
- cross-workspace agent execution (home-predicate, `agent_home_workspace_id`, run-token rebind, `agent ∩ caller-workspace` intersection),
- instance-reach tokens (nullable `api_tokens.workspace_id` + a separate reach boundary),
- cross-tenant redaction (`redactLibraryAgentForList`, the library/agent union strip).

The audit's conclusion: this is machinery for a threat that **doesn't exist in Folio's model** (separate untrusted customers on one deployment) and **can't even be exercised today** (there is no multi-user/user-creation flow — `memberships` only ever holds the registrant). Stefan's call: **all tenant code out.**

## The distinction this plan is built on

**Tenant isolation ≠ invite-based access.** They are different layers, and Folio wants the second with *zero* of the first.

| | Tenant isolation (DELETE) | Invite-based access (KEEP / BUILD) |
|---|---|---|
| Other side of the boundary | untrusted *separate customers* | *trusted teammates*, one team |
| Boundary means | a security wall; cross = attack surface | "should this teammate see this workspace?" — least-privilege filter |
| Shared/global resources | need a fake tenant (`__system`) to live in | live at instance level; nothing fake |
| Not-invited user | must be cryptographically isolated; a leak is a CVE | simply doesn't see it / gets a 403 |
| Threat model | "customer A must never reach customer B" | "don't show Bob a workspace he wasn't added to" |

The code built **column 1** to implement what the product wanted (**column 2**). The access *check* (`resolveWorkspace` membership gate) is roughly the right primitive for invite-only access — the problem is the **wall built around it**. We keep the check, delete the wall.

## Locked decisions (from the brainstorm with Stefan)

1. **Global resources → instance level, surfaced as a Settings page.** The operator agent, skills, and AI keys are instance-owned and edited in Settings — *not* hidden inside a fake `__system` workspace. (Stefan: a settings page "feels the most natural for users.")
2. **Run authority is caller-derived only.** A run's authority = `(caller, target workspace)`, full stop. An agent has **no "home workspace" to reconcile**. This single rule deletes the entire cross-workspace execution subsystem.
3. **Invite-only is the target access model** (default-closed): a user must be invited to a workspace/project; their **role there is their scope**. The `memberships` table is the surviving primitive (extended to project granularity later).
4. **Storage mechanism for instance docs: one internal storage row, de-tenanted** (the recommended low-friction path — see "The one real design decision" below). User-facing surface is still 100% a Settings page.

---

## Threat model

> This work touches multi-tenancy boundaries, auth/token surfaces, and agent run authority — the gate fires. But the *point* of the work is to **remove** an isolation model, so the threat model documents the **target** model and proves the removal doesn't open a real hole.

**The target access model is invite-based access within ONE trusted team — explicitly NOT tenant isolation.** The threat is "a teammate sees a workspace they weren't invited to" (least-privilege), not "customer A exfiltrates customer B" (there is no customer B).

Threats that **remain real** and MUST hold after the refactor:

- **TM-1 Secret hygiene (NOT tenancy).** Token hashes, encrypted AI keys, and `system_prompt`/`api_token_id` must never reach a client or a tool response. This survives as **hygiene**, independent of tenancy — `redactRunForApi`'s secret-strip stays; only its *cross-tenant* framing goes. The instance AI key is read server-side and injected into the provider call only (never a token/tool/response/frontmatter).
- **TM-2 Access check holds.** `resolveWorkspace` still 403s a non-member. De-tenanting must not turn the membership gate into "any authenticated user sees everything" *except* as the explicit interim (see Phase 6) until invites ship.
- **TM-3 Instance-admin gate.** Instance-level resources (operator/skills/AI keys, instance tokens) are writable only by an instance admin. The gate moves from "`__system` owner membership" to a first-class `users.is_instance_admin` flag — it must not silently become open.
- **TM-4 Run authority can't widen.** With caller-derived authority, a run acts with `agent ∩ caller-scope ∩ caller-projects` **in the target workspace**. Removing the home-predicate/token-rebind must not let a run act with authority the caller lacks. The `caller_scopes`/`caller_project_ids` snapshot (Phase-1 delegation) is the surviving ceiling and is UNCHANGED.
- **TM-5 Skill trust still bounded.** A `trusted` skill loads as trusted instructions into agent prompts. After skills move to instance level, `trusted` must remain settable only by the sanctioned mutator (instance-admin), and stripped on every other write surface. Invariant 11 is rewritten, not dropped.

Non-threats (explicitly retired): cross-tenant content leakage between workspaces, instance-reach token escalation across tenants, `__system` taint/adoption — all moot once there are no tenants.

## Architecture invariants touched

- **Inv 3 (project ceiling `agent ∩ token ∩ caller`)** — simplifies: the token-reach intersection term collapses (a token is pinned to its workspace; instance tokens are admin-only). The `agent ∩ caller` core stays.
- **Inv 4 (HTTP authz / `requireInstanceAdmin`)** — `requireInstanceAdmin` is re-pointed from `__system` membership to `users.is_instance_admin`.
- **Inv 5 (`txWithEvents`)** — unchanged; all surviving writes keep routing through it.
- **Inv 7 (`roleToScopes` ceiling)** — KEEP-CLEAN. This is the heart of invite-based access (your role in a workspace = your scope there) and is already compatible. Untouched except removing any `__system`-only scope special-casing.
- **Inv 10 (entity modeling — docs not tables)** — the instance store keeps agents/skills as `documents` (honored). Adding `users.is_instance_admin` is a genuine new column, justified (it's instance identity, not an attribute of a document type) — flag at review.
- **Inv 11 (skill trust)** — rewritten: trust attaches to instance-store skill pages, gated by instance-admin, no `__system` framing.
- **Deliberate exceptions** — the `loadAgentDefinition` `__system` read and the B6 AI-key exception are rewritten/removed.

---

## The one real design decision: where instance docs live

Operator agent + skills are `documents` rows. `documents.workspace_id` is `NOT NULL` and filtered on across the **entire** query layer. So "instance docs with no workspace at all" = making that column nullable everywhere (every list/get/scope path gains a null branch). High ripple, touches Inv 10's convergence point hard.

**Recommendation (lower friction, chosen): keep ONE internal storage row, fully de-tenanted.** Rename the concept from "system tenant" to **instance store**. It is:
- never exposed in the workspace switcher, never has `memberships`, never reached by slug navigation;
- reached only server-side, for instance-admin Settings reads/writes, gated by `users.is_instance_admin`;
- stripped of **every** tenant mechanism: no provenance/taint, no cross-workspace execution, no instance-reach tokens, no redaction-union, no reserved-slug defense-in-depth.

What made `__system` bad was never that it was a row — it was the tenant machinery bolted on. Strip that and it's just plumbing the user never sees, behind a Settings page. This keeps `documents.workspace_id NOT NULL` (zero query-layer ripple) and keeps agents/skills as documents (Inv 10 honored).

**Purist alternative (documented, not chosen): nullable `documents.workspace_id`** for instance-owned agent/skill docs. Conceptually cleanest ("truly no workspace") but forces a null-branch through every document query + scope path + the CHECK constraint. Higher cost for a difference the user never sees. Revisit only if the storage row proves leaky.

> **Open for Stefan to veto:** the storage-row recommendation. If you'd rather pay the nullable-column cost for conceptual purity, say so and Phase 3 swaps mechanism. Everything else in the plan is mechanism-independent.

---

## Phased breakdown (un-build order: reframe first, deletes fall out)

Ordering principle: **establish the new authority/admin model first**, which makes the tenant code *dead*, so removals are low-risk deletions rather than risky live rewrites. Each phase ends at a green gate (`cd apps/server && bun test`, `cd apps/web && npx vitest run`, tsc ×3) and an atomic commit set.

### Phase 0 — Instance-admin as a first-class concept
*Makes the admin gate independent of `__system` so `__system` can later vanish.*
- Add `users.is_instance_admin` (boolean, default false) + migration.
- Re-point `requireInstanceAdmin(db, userId)` to read the flag (drop the `__system` owner/admin membership lookup); keep the same throw/signature so callers are unchanged. (`lib/system-workspace.ts:282` → a small `lib/instance-admin.ts`.)
- Register flow: first bootstrap user sets `is_instance_admin = true` instead of `designateInstanceOwner` granting `__system` ownership. (`routes/auth.ts:54-82`.)
- **Gate / threat:** TM-3. Tests: first-user-becomes-admin; a second user is not admin; `requireInstanceAdmin` 403s a non-admin.

### Phase 1 — Caller-derived run authority (kill cross-workspace execution)
*The biggest deletion; decision #2.*
- `runner.ts`: `const home = run.workspaceId` (drop `fm.agent_home_workspace_id ?? …` and the `{ws, __system}` gate, `runner.ts:329-343`). Remove the run-token rebind to B (it existed only to let a `__system`-bound token act in B).
- `services/agent-runs.ts`: stop stamping `agent_home_workspace_id` (~204). `lib/agent-run-schema.ts`: delete the field.
- `lib/token-reach.ts`: collapse `effectiveReach`/`isInstanceReach` to the workspace-pinned case; keep `serializeApiToken` (hygiene).
- Keep UNCHANGED: `caller_scopes`/`caller_project_ids` snapshot + the `executeTool` scope/project ceiling (TM-4, Inv 3/7). This is the authority model that *replaces* the home-predicate.
- **Gate / threat:** TM-4. Tests: a run resolves its agent locally; a run acts with caller authority in its own workspace; an agent the caller can't reach in that workspace is unrunnable (no cross-workspace borrow).

### Phase 2 — Instance store (de-tenant `__system`)
*Turn the reserved tenant into invisible plumbing.*
- Replace `bootstrapSystemWorkspace` (provenance-asserting, `system-workspace.ts:181-207`) with a minimal `ensureInstanceStore(db)` that creates one row with NO membership, NO taint assertion, NO reserved-slug ceremony. Keep `getInstanceStoreId(db)` (the de-tenanted successor of `getSystemWorkspaceId`, ~25 callers).
- DELETE: `assertSystemProvenance`, `SYSTEM_WORKSPACE_TAINTED`, `grantOwner`, `findSystemOwnerId`, `withDesignationLock`, `designateInstanceOwner`, `isReservedSlug` + the workspace-create reserved-slug rejection, `services/workspaces.ts:isSystemMember`, the `listWorkspaces` `__system` exclusion filter, `SYSTEM_WORKSPACE_SLUG` (server + `@folio/shared`).
- **Gate / threat:** TM-2 (the membership gate on normal workspaces still holds). Tests: instance store is not in `listWorkspaces`; no membership grants access to it; normal workspace 403 intact.

### Phase 3 — Move operator agent + skills to the instance store, instance-admin-gated
*Decision #1 + #4; supersedes the not-yet-executed `2026-06-03-instance-ai-config-in-system` plan's `__system` anchoring.*
- Operator agent + skill pages live in the instance store; `ensureOperatorAgent`/operator-token logic stays but loses the `__system`-membership framing — provisioning is keyed to the instance store + instance-admin.
- `loadAgentDefinition` (`runner.ts:497-532`): resolve skills from the instance store (was the `__system` Skills project). Keep the narrow SYSTEM-auth read shape (Deliberate-exception rewrite), drop the cross-tenant framing.
- `resolveAgentForRun` (`system-workspace.ts:328`): a run resolves its agent locally, else falls back to the instance store (a plain lookup fallback — NOT a security boundary, no rebind, no taint). Members can *run* instance agents; only instance-admin *edits* them (normal scope distinction, not redaction).
- DELETE the redaction-union: `redactLibraryAgentForList`, `LIBRARY_AGENT_PUBLIC_FRONTMATTER_KEYS`, `unionSystemRows`, and the `__system` union block in `listWorkspaceDocuments` (`documents.ts:1280-1413`). (Secret-strip in `redactRunForApi` STAYS — TM-1.)
- Rewrite Inv 11 + `skill-trust.ts`: `trusted` attaches to instance-store skill pages, gated by instance-admin, stripped on all other write surfaces. Keep the `unattendedFloor` on `set_skill_trust`.
- **Gate / threat:** TM-1, TM-5. Tests: a member runs the operator in their workspace with their own authority; a member cannot edit an instance skill/agent; secrets never appear in any list/run response; `trusted` strip holds on every write surface.

### Phase 4 — AI keys → instance level (with the operator)
*Folds in the intent of the `instance-ai-config` plan, but instance-store / instance-admin native (no `__system`).*
- Drop `ai_keys.workspace_id` (migration, fail-loud if rows exist); unique `(provider, label)`.
- Runner resolves the key by `(provider, ai_key_label)` server-side, inject-only (TM-1). Snapshot `ai_key_label` on the run.
- Move AI-key CRUD from per-workspace `settings.ts` to an instance route gated `requireInstanceAdmin`.
- **Gate / threat:** TM-1, TM-3. Tests: instance key drives a run in any workspace; non-admin can't CRUD keys; key material never in messages/response; GET strips the secret.

### Phase 5 — Instance tokens & the token model
- A normal token is workspace-pinned (`api_tokens.workspace_id NOT NULL` again, or kept-nullable-but-admin-only — decide at task expand). Instance tokens (operator + admin) are the admin-gated exception, not a reach boundary.
- Simplify `middleware/scope.ts:resolveWorkspace` (drop the instance-reach branch, `:34-48`); simplify `bearer.ts` token hydration. Keep/retarget `routes/instance-tokens.ts` to the admin-gated instance-token surface.
- Migration `0022` (nullable token workspace) reconciled.
- **Gate / threat:** TM-3, Inv 3/4. Tests: a workspace token can't act outside its workspace; only instance-admin mints/holds an instance token.

### Phase 6 — Web surfaces + interim access posture
- Remove: `w.$wslug.settings.tsx` System Library section; `token-create-modal` instance-reach fieldset; `SYSTEM_WORKSPACE_SLUG` (web + shared).
- Rename: `useIsSystemMember()` → `useIsInstanceAdmin()`; `MeResponse.is_system_member` → `is_instance_admin` (server computes from the flag).
- Move AI/operator/skills config into instance **Settings** tabs gated by `useIsInstanceAdmin()`.
- **Interim posture (no multi-user yet):** the single registered user is the instance admin and a member of every workspace they create; the membership gate trivially passes. Keep the gate (don't collapse to "authenticated = everything") so invite-only is an additive build, not a re-introduction. (TM-2.)
- **Gate:** web suite + tsc; manual smoke of Settings.

### Phase 7 — Docs, invariants, memory, and the build-later stub
- Rewrite `ARCHITECTURE-INVARIANTS.md`: Inv 3/4/11 + the two Deliberate exceptions (`loadAgentDefinition`, B6 AI-key).
- Update `memory/STATE.md`, `memory/DECISIONS.md` (record: tenant isolation removed; invite-based access is the model), `memory/lessons.md` (the "built a tenant system for a non-tenant product" lesson).
- Archive/supersede the now-moot plans (Phases A–D, `instance-ai-config-in-system`, cross-workspace operator) with a pointer to this correction.
- **Stub `docs/superpowers/specs/` for the build-later feature:** the invite/user-creation flow + **project-level** membership (today membership is workspace-only). Default-closed, role-for-scope, within-one-team. Sketched, NOT built (no multi-user system exists, so nothing blocks).

---

## What survives (the clean core)

`memberships` (the invite primitive) · `roleToScopes` / Inv 7 (role = scope) · `resolveWorkspace`'s access check · `caller_scopes` delegation + `executeTool` ceiling · `txWithEvents` / Inv 5 · per-workspace `providerHealth` · secret-stripping hygiene. The result is **simpler and stronger**: fewer boundaries means fewer places to get a boundary wrong.

## Test impact

~500–800 lines of tenant-specific test code deleted/refactored (`system-workspace.test.ts` whole; home-predicate blocks in `runner.test.ts`; redaction tests in `documents.test.ts`; instance-reach token tests; `agent_home_workspace_id` stamp test). Authority/delegation/tool-execution/workspace-scoping tests survive.

## Estimated magnitude

~2,000+ LOC removed/simplified across ~50 files (server + web + shared); ~3 migrations (add `is_instance_admin`, drop `ai_keys.workspace_id`, reconcile token workspace). Primarily **deletion + simplification**; the only genuinely new logic is the `is_instance_admin` flag replacing `__system`-membership-as-admin.
