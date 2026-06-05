# Drop Workspace Tenancy — Design Spec

**Date:** 2026-06-04
**Branch (proposed):** `spec/drop-workspace-tenancy`
**Status:** Design — awaiting user review before plan.
**Author:** harnessed-development / brainstorming

---

## 1. The shift, in one sentence

Workspaces stop being a **security boundary** and become pure **organizational folders**. One instance = one team. Authority (roles) lives at the **instance** level; access to specific workspaces and projects is granted by **invitation**. The `__system` reserved workspace — which existed only to share agents *across* the boundary — is deleted, and its load-bearing contents are rehomed at instance level, surfaced through Settings.

This is **not** the deletion of workspaces. They remain in the URL (`/w/:wslug`), the rail, and the switcher, exactly as the briefing glossary intends ("a customer might have one workspace or several — 'Galleries', 'Stride', 'Operations'"). What dies is the *isolation* they enforced.

If multi-tenancy is ever wanted again, the model is **one database per tenant** (swap the DB) — never row-level tenancy. So no row-level tenancy code should remain after this.

---

## 2. Decisions locked in brainstorming

| # | Decision | Chosen |
|---|----------|--------|
| D1 | Workspace fate | **Keep as org-only grouping.** Drop membership-as-access-control. Switcher + `/w/:wslug` routing stay. |
| D2 | Roles | **Instance-level, built-in `owner \| admin \| member`, one per user.** Stored on `users.role`. No custom/user-defined roles. |
| D3 | Access model | **Invitation-based, two independent grant levels.** Owner sees all; admin + member need a grant. Workspace grant ⇒ all its projects; project grant ⇒ that one project. |
| D4 | Access store | **Two grant tables:** `workspace_access(user_id, workspace_id)` + `project_access(user_id, project_id)`. |
| D5 | `__system` fate | **Deleted.** Instance-owner/admin identity → `users.role`; folio skill → `instance_skills` table; operator agent → **rehomed at instance level (kept), home TBD (§9 OQ-1)**; all cross-workspace machinery removed. |
| D6 | Token scope | **Decided in the plan's threat model** (entangled with the new grant model + agent token-rebind). Mechanism (`api_tokens.workspace_id` nullable) survives; meaning re-derived. |
| D7 | Branch scope | **Both, sequenced in one branch.** Backend (schema → auth → routes → services → `__system` teardown) green at each step, then frontend. App never half-migrated. |
| D8 | Operator agent | **KEEP.** It is a *distinct kind* of agent — the conversational instance-operator users talk *to* (create workspace, build project, bulk-edit) — NOT a redundant shareable agent. Only its `__system` wrapping dies. *(User correction, 2026-06-04: the teardown analysis wrongly conflated "lives in `__system`" with "exists only for cross-ws sharing." The operator's prompt, tools, and token-provisioning survive.)* |
| D9 | Agent taxonomy | **Two distinct kinds (see §3.1).** (1) **Operator** — instance-scoped, conversational, one seeded, acts *across* workspaces/projects. (2) **Custom agents** — project-scoped, user-created, many, do work *inside a project on a work item* (research, write, SEO). *(User clarification, 2026-06-04.)* This split resolves OQ-1/OQ-4: only the operator needs an instance home, so `documents.workspace_id` stays `NOT NULL` and the operator gets a dedicated home rather than loosening the column for all agents. |
| D10 | Operator UI | **The cockpit chat (existing plan).** Operator's surface = the multi-turn cockpit chat already specced (`2026-06-03-operator-cockpit-chat-design.md`). This refactor is a *dependency* on that chat (keep it pointed at the rehomed operator), not a re-design. *(User, 2026-06-04.)* |
| D11 | Custom-agent invocation | **Three paths — trigger, assignment, @mention-in-comments — all keeping both ceilings.** Project allow-list (inv 3) + caller-bounded authority (inv 3/7) retained on every path. Comment @mention runs with the **commenter's** authority ∩ agent ceiling. Teardown removes the `__system` resolution detour, not the bounds. *(User, 2026-06-04.)* |

---

## 3. Target model

```
INSTANCE (one team)
 ├─ users
 │    role: owner | admin | member        ← NEW column (was memberships.role)
 │
 ├─ access grants (invitation)
 │    workspace_access (user_id, workspace_id)   ← NEW table
 │    project_access   (user_id, project_id)     ← NEW table
 │
 ├─ Workspaces  "Galleries", "Operations"  ← org folders, NOT a boundary
 │    └─ Projects
 │         └─ work_items / pages / tables / views / fields / statuses
 │
 ├─ Agents      ← instance-level, visible everywhere (incl. the operator)
 ├─ Triggers    ← instance-level
 ├─ AI keys     ← instance-level (already so since migration 0023)
 ├─ Providers   ← instance-level
 ├─ instance_skills (folio skill body)     ← NEW table (rehomed from __system)
 └─ Settings    ← the surface for roles, invitations, agents, keys, skills
```

### 3.1 Agent taxonomy (D9) — two distinct kinds

Removing the workspace boundary does **not** flatten all agents to one level. There are two kinds, and they sit at different scopes:

| | **Operator agent** | **Custom agents** |
|---|---|---|
| Interaction | user talks **to** it — via the **cockpit chat** (D10) | triggered, assigned to an item, or **@mentioned in a work item's comments** (D11) |
| Scope | **instance** — acts *across* workspaces & projects | **project** — acts *inside* one project, *on* a work item |
| Job | create a workspace, build a project, bulk-edit rows | research, write, SEO — domain work on an item |
| Cardinality | one, seeded on boot | many, user-created |
| Home | instance-level, no owning project (OQ-1) | a project (its `frontmatter.projects` allow-list bounds it) |

This is the **outside-agent vs inside-agent** distinction already in the codebase's model (`project_agent-modes-taxonomy`). It has a concrete schema consequence: **custom agents are genuinely project-scoped, so `documents.workspace_id` stays `NOT NULL` for them** (and the invariant-3 project ceiling `agent ∩ token ∩ caller` continues to bound them). Only the *single operator* needs an instance home with no project — handled as a dedicated home (OQ-1), not by loosening the column for every agent.

The operator's cross-workspace reach is exactly what the single-team model wants: it is the privileged conversational surface for *running the instance*, bounded by the **caller's** authority (a `member` talking to the operator can't make it exceed `member` — caller-bounded authority, invariants 3/7), not by a workspace wall.

**D10 — operator UI = the cockpit chat (existing plan).** The operator's user-facing surface is the multi-turn cockpit chat already specced (`docs/superpowers/specs/2026-06-03-operator-cockpit-chat-design.md`; memory `project_cockpit-chat-spec`). This refactor does **not** re-design that chat — it only ensures the chat still resolves the operator after `__system` is deleted and the operator is rehomed (OQ-1). **Dependency, not new design.** The cockpit-chat build is gated on the agent-authority work; this tenancy refactor must land the operator's new home in a way the chat can reference (see §8 sibling sites — the chat's operator-resolution).

**D11 — custom agents have THREE invocation paths, all preserving the two ceilings.** A custom agent can be:
  1. **Triggered** — a trigger fires it (Phase C reaction path, `handleTriggerFired`).
  2. **Assigned** — set as a work item's assignee; it does the item's work.
  3. **@mentioned in comments** — summoned in a work item's comment thread; replies in-thread (`handleCommentMentioned`).

All three currently route agent-resolution through the `__system` cross-workspace machinery (`resolveAgentForRun` + the `home ∈ {run-ws, __system}` gate). After teardown, resolution simplifies to a **single project-scoped query** — but **both ceilings are retained on every path** (user-confirmed 2026-06-04):
  - **Project ceiling (invariant 3):** the agent acts only in its `frontmatter.projects` allow-list. @mention in project X runs it only if X is allow-listed; otherwise refused. Removing the workspace wall does **not** widen this.
  - **Caller-bounded authority (invariants 3/7):** a comment @mention runs with **the commenter's** authority ∩ the agent's ceiling. A `member` @mentioning a `config:write` agent cannot make it exceed `member`. No privilege-escalation-by-summon.

So the teardown removes the `__system` *detour*, not the *bounds*: the security model is unchanged, the code is simpler.

**Visibility rules (the single authorization question this refactor answers):**

```
canSeeWorkspace(user, ws) :=
    user.role == 'owner'
 OR exists workspace_access(user.id, ws.id)
 OR exists project_access(user.id, p.id) for some p where p.workspace_id == ws.id
        -- TRAVERSE-ONLY: a project-only invitee may reach the workspace shell
        -- so they can navigate to their granted project. This does NOT grant
        -- them the other projects in the workspace (see canSeeProject + listProjects).

canSeeProject(user, proj) :=
    user.role == 'owner'
 OR exists workspace_access(user.id, proj.workspace_id)   -- inherited from the folder
 OR exists project_access(user.id, proj.id)               -- direct invite to one project
```

**Why the third `canSeeWorkspace` clause exists (fixes the §4.2 routing contradiction):** without it, a user invited to *one project* via `project_access` — but holding no `workspace_access` — would hit `/w/:wslug` → `resolveWorkspace` → **403**, and never reach the project they were granted. The grant level (chosen as independent in brainstorming) would be a dead feature. The clause lets them **traverse** the workspace shell; it is strictly weaker than `workspace_access`:

| Capability | `workspace_access` | `project_access` only (traverse) |
|---|---|---|
| Reach `/w/:wslug` (pass `resolveWorkspace`) | ✅ | ✅ (via the third clause) |
| See ALL projects in the workspace (`listProjects`) | ✅ | ❌ — `listProjects` filters by `canSeeProject`, so they see ONLY their granted project(s) |
| Open a non-granted project in the workspace | ✅ | ❌ — `resolveProject` runs `canSeeProject`, 403 on others |
| Receive events from a non-granted project (`/events`) | ✅ (all ws projects) | ❌ — `/events` filters by `canSeeProject`; they get events for their granted project(s) ONLY |
| See workspace metadata / member list (if any such surface exists) | ✅ | ⚠️ existence/name only — see §4.3 `canSeeWorkspace`-gated-surface audit |

So "independent levels" stays honest: workspace-traverse ≠ see-all-projects. **The traverse clause makes `canSeeWorkspace` a WEAKER gate than it looks: passing it means "may reach the ws shell," NOT "may see everything in the ws."** Therefore **every surface that returns workspace-wide *contents* MUST gate on `canSeeProject` per item, not merely `canSeeWorkspace`** — `listProjects` and `/events` are the two known ones (§4.3); the sibling-site sweep (§8) must find any other `canSeeWorkspace`-only content surface. Gating workspace *contents* on `canSeeWorkspace` alone now leaks to project-only invitees.

`admin` does **not** bypass grants for *content visibility* (only `owner` does — user's explicit choice). `admin` retains instance-management power (mint instance tokens, manage keys, invite users) via `users.role`, but to *see a workspace's contents* (projects, documents, events) they must be invited like anyone else.

**Existence vs. contents (fixes #5 — the invite surface is not a violation).** "admin can't see a workspace" means **can't see its contents** — NOT "can't know it exists." To invite a user to workspace B, an `admin` must be able to *pick* B in the invite UI, so **admins necessarily see the existence and names of all workspaces** (and projects), even ones whose contents they cannot open. This is intentional and must be encoded as two distinct surfaces:
- **Enumeration (existence + name + id):** available to `owner` + `admin` for the *invite/admin* surfaces — `admin` sees the full workspace/project list as *targets to grant*, not as *content to read*.
- **Contents (projects' documents, events, board state):** gated by `canSeeWorkspace`/`canSeeProject` as in §3 — `admin` with no grant gets the name in the picker but 403 on the contents.

So a future reviewer seeing "admin lists all workspaces in the invite dropdown" must read it as the enumeration surface, NOT a `canSeeWorkspace` bypass. The two surfaces are separate endpoints with separate gates.

---

## 4. What changes — backend

### 4.1 Schema (`apps/server/src/db/schema.ts` + migrations)

| Change | Detail |
|--------|--------|
| **Add** `users.role` | `text('role', { enum: ['owner','admin','member'] }).notNull().default('member')`. |
| **Add** `workspace_access` table | `(user_id FK→users CASCADE, workspace_id FK→workspaces CASCADE)`, composite PK, index on `workspace_id` for reverse lookup (who's in this ws). |
| **Add** `project_access` table | `(user_id FK→users CASCADE, project_id FK→projects CASCADE)`, composite PK, index on `project_id`. |
| **Add** `instance_skills` table | `(id PK, name UNIQUE, body text, frontmatter json, **`trusted` integer NOT NULL DEFAULT 0**, created_at)`. Seeded with the `folio` skill on boot. **`trusted` is a typed first-class column, NOT a frontmatter key** — see the security note below; this is what makes invariant 11 / T-E *enforceable* rather than aspirational. |
| **Drop** `memberships` table | Its `__system` role → `users.role`; its per-workspace rows → `workspace_access` grants (backfill). **Dropped LAST** (final migration in the branch, §10 step 4) — live code reads it until the auth rewrite lands. |
| **Keep** `api_tokens.workspace_id` (nullable) | Mechanism survives; meaning re-derived in the threat model (D6). |
| **Keep** `0022`, `0023` | Nullable token reach + instance AI keys are already correct-direction; not unwound. |

**Migration strategy — expand-contract.** The `memberships` table is *read by live code* until the auth rewrite (§4.2) lands. Therefore **the table is added-to and migrated-off first, and DROPPED LAST — the drop is the final migration authored, in sequence-step 4 (§10), not step 1.** Dropping a table the running code still references breaks the app between steps; "green at each step" requires the old table to survive until every reader is gone. Follows the `0023` table-rebuild precedent (incl. the `--> statement-breakpoint` split — a guard test using `sqlite.exec(wholeFile)` silently no-ops, per `feedback_bun-sqlite-exec-no-ops-migration-guard`).

**Phase 1 (expand) — additive only, no drops:**
1. **Add** `users.role`, `workspace_access`, `project_access`, `instance_skills`. The running code does not yet read them; nothing breaks.
2. **Data-preserving backfill** from `memberships` (the table stays):
   - **`users.role` ← the user's `__system` role if any, else `member`.** *(Fixes the privilege-escalation bug: instance authority was carried ONLY by `__system` membership, per D5. A per-workspace `owner`/`admin` is folder authority, NOT instance authority — it must NOT promote the user to instance-`owner`/`admin`, since instance-`owner` now bypasses every grant. Sourcing from "highest role across all workspaces" would silently escalate every folder-owner to instance-owner against data created under the old meaning.)*
   - **Per-workspace `owner`/`admin`/`member` rows → `workspace_access(user_id, workspace_id)` grants** — the folder authority becomes plain access. **Except** `__system` rows (those were instance-admin identity, now encoded in `users.role`; they do NOT become a `workspace_access` grant — `__system` is being deleted).

**Phase 2 (migrate-off) — happens as CODE, across sequence-steps 2–4 (§10):** every read/write of `memberships` is rewritten to `users.role` / `workspace_access` (§4.2, §4.3, §8 sibling-site sweep). No migration here — this is code, and it's where "split out" really completes.

**Phase 3 (contract) — the LAST migrations authored, in sequence-step 4:**
3. **`__system` teardown migration** — delete the `__system` workspace + its projects/documents + its memberships, idempotent (no-op if absent). Operator + folio skill are re-seeded at their new instance homes by boot tasks, not carried by SQL (§4.4).
4. **Drop `memberships`** — only after Phase 2 has removed every code reference. This is the final migration in the branch.

Each migration carries the empty-guard / row-count guard where it asserts a precondition, split on `--> statement-breakpoint`, and updates `meta/_journal.json` (per `feedback_drizzle-migration-journal` — `migrate()` silently skips files not in the journal).

**SECURITY NOTE — `instance_skills.trusted` MUST be a typed column, not a frontmatter key (T-E / invariant 11).** `trusted` is **load-bearing capability**: a `trusted:true` skill loads as TRUSTED INSTRUCTIONS into an agent's system prompt (`buildSkillsPreamble`); an untrusted one rides the untrusted DATA envelope. If `trusted` lived inside the `frontmatter` JSON blob, then **every wholesale-frontmatter write — a skill edit, a bulk import, a restore, a raw `.set({ frontmatter })` — could set `trusted:true`**, and `stripManagedSkillTrust` would degrade to "mutate the JSON and hope no import path overwrites it," which is **not enforceable**. As a typed column:
- The ONLY writer is `setSkillTrust` (gated by `canBlessSkill`), which flips the column + emits `skill.trust.changed` in one `txWithEvents`.
- Import / restore / clone / edit write `body` + `frontmatter` and **physically cannot touch `trusted`** (it is not a frontmatter key; there is no JSON path to it). `stripManagedSkillTrust` is no longer needed for `instance_skills` *because the column makes forging structurally impossible* — there is nothing to strip. (It is still needed wherever a `documents`-shaped skill could carry an incoming `trusted` frontmatter field, if any such surface survives — confirm in the sibling-site sweep.)
- This is the existing model's actual guarantee, preserved through the rehoming. T-E is satisfiable ONLY against this schema.

### 4.2 Auth / scope middleware

The heart of the change. Rewrites **invariant 1** (identity), **invariant 4** (HTTP authz), **invariant 7** (token ceiling).

**`middleware/scope.ts` — `resolveWorkspace`:** replace the `memberships` lookup with the new visibility rule.

```
// BEFORE: membership row decides access AND role
const m = memberships.findFirst(ws.id, user.id);  if (!m) 403;  role = m.role

// AFTER: role comes from the user; access comes from grants
role = user.role                                   // instance-level, from invariant-7 source
if (role !== 'owner'
    && !await canSeeWorkspace(user.id, ws.id))     // owner || ws_access || project_access-traverse
   throw 403                                        // (the 3-clause rule from §3 — incl. traverse)
c.set('role', role)
```

`canSeeWorkspace` here MUST be the full three-clause rule (§3), including the project-access traverse clause — otherwise project-only invitees 403 before reaching their project (the §3 contradiction). Passing `resolveWorkspace` is *traverse*, not *see-everything*: it does not imply visibility of the workspace's other projects.

**`resolveProject`:** add the project-level access check (today it only checks `project.workspace_id == ws.id`; now it must also enforce `canSeeProject` — owner OR `workspace_access` on the parent OR direct `project_access`). A traverse-only user (project grant, no workspace grant) passes `resolveWorkspace` but is 403'd by `resolveProject` on any project they were not granted. **`listProjects` (§4.3) must independently filter by `canSeeProject`** so the project list itself respects the boundary — `resolveProject` gates direct navigation, but the list endpoint is a separate read surface that the traverse clause would otherwise over-expose.

**Instance-reach token bypass:** `isInstanceReach(token)` (workspaceId null) still grants `role:'owner'` by capability — that path is unchanged in shape, but its *meaning* is re-examined in the threat model (D6), since "instance reach" and "owner sees all" now coincide.

**`requireInstanceAdmin` (today reads `__system` membership):** rewrite to read `users.role ∈ {owner, admin}`. This is a **REWORK**, not a delete — the gate survives, it just stops querying a workspace. Single consumer set: `instance-tokens.ts`, `instance-ai-keys.ts`, `tokens.ts` (reach-null mint), `auth.ts` (`/me` signals).

**`roleToScopes` (invariant 7):** unchanged in logic (owner/admin → all; member → read+write), but its input now comes from `users.role`, not `memberships.role`. The `ceilingRole` at token mint (`tokens.ts`) reads `users.role`.

### 4.3 Routes / services

| Surface | Change |
|---------|--------|
| `services/workspaces.ts` `listWorkspaces` | The user-facing "workspaces I can open" list — filter by `canSeeWorkspace` (owner → all; else `workspace_access`; plus project-only invitees see the ws shells they can traverse) instead of `memberships.userId`. **Distinct from** the invite-target *enumeration* endpoint (below), which returns names+ids of ALL workspaces to owner+admin — see the existence-vs-contents note (§3). |
| `services/projects.ts` `listProjects` | Filter by **`canSeeProject` per item** (NOT merely `canSeeWorkspace`) — a traverse-only user sees only their granted project(s). |
| **`routes/events.ts` `/events` (SSE)** | **MUST filter at `canSeeProject` granularity, not `canSeeWorkspace` (T-A / #2).** A project-only invitee who passes the `resolveWorkspace` traverse clause must receive events ONLY for projects they can see — never the workspace's other projects. If `/events` stays workspace-scoped and gated by `canSeeWorkspace`, the traverse clause leaks every other project's events to a one-project invitee. The stream's per-event filter must check `canSeeProject(user, event.project_id)` (or restrict the subscription to the caller's visible project set). Pinned by an §8.1 traverse-specific test. |
| `services/documents.ts` | Document queries currently filter by `workspace_id` as *isolation*. Re-frame: `workspace_id` is still the **scoping key** (which folder a doc is in) but no longer an isolation gate — the gate is the **per-item `canSeeProject`** access check at the route, NOT `canSeeWorkspace`. The `__system`-union + library badging (DEAD) is removed. |
| **Any `canSeeWorkspace`-only content surface** | The sibling-site sweep (§8) MUST enumerate every endpoint that returns workspace-wide *contents* gated only by `canSeeWorkspace` (cross-project views, activity feeds, member lists, run lists) and re-gate each on `canSeeProject` per item. The traverse clause made `canSeeWorkspace` insufficient for *contents*. |
| `routes/tokens.ts` | `ceilingRole` ← `users.role`; membership lookup removed; reach-null gate ← `requireInstanceAdmin` (reworked). |
| **NEW** invitation routes | `POST/DELETE /api/v1/instance/access` (or nested): grant/revoke `workspace_access` + `project_access`. Session-only, `requireInstanceAdmin` (owner/admin can invite — OQ-3). Exact shape in plan. |
| **NEW** enumeration surface (invite targets) | `GET` of workspace/project **names+ids** (NOT contents) for the invite picker, available to owner+admin regardless of grant — the existence-vs-contents split (§3). Separate endpoint + gate from the content-listing routes; returns no documents/events. Keeps the invite UI from being read as a `canSeeWorkspace` bypass. |
| **NEW/MOVED** roles route | `PATCH /api/v1/instance/users/:id/role` — set a user's instance role. Session-only, **owner-only** (stricter than `requireInstanceAdmin`; admins cannot change roles — OQ-3 decided). |
| `routes/auth.ts` `/me` | `is_instance_admin` ← `users.role ∈ {owner,admin}`; drop `is_system_member`. Add `role`. |

### 4.4 `__system` teardown (the intricate part)

Per the verified teardown map (2026-06-04 source read). Verdicts: **DEAD** = delete, **REWORK** = survives but detaches from `__system`, **MIGRATE** = content moves.

**DEAD — delete entirely:**
- `lib/system-workspace.ts`: `assertSystemProvenance`, `resolveSystemWorkspace`, `ensureSystemProject`, `ensureSystemPage`, `bootstrapSystemWorkspace`, `findSystemWorkspace`, `requireSystemWorkspace`, `getSystemWorkspaceId`, `findSystemWorkspaceId`, `resolveAgentForRun` (dual-workspace home lookup).
- `lib/runner.ts`: the home-predicate gate (`home ∈ {run-ws, __system}`), the library-agent branch of token rebind, the `__system`-Skills-project skill load (replaced — see MIGRATE).
- `routes/workspace-documents.ts`: library badging (B8). `services/documents.ts`: `unionSystemRows` + `__system` union.
- `lib/trigger-matcher.ts`: the three `resolveAgentForRun` call sites collapse to a single-workspace agent query; C2 library allow-list skip removed.
- `lib/token-reach.ts`: `isOperatorToken` — **RE-EXAMINE, do not blind-delete.** It identifies the system-origin operator principal (`workspaceId null AND createdBy null`). The operator *survives* (D8), so this identity check likely survives too, possibly reshaped. Plan resolves with OQ-1.

**REWORK — survives, detaches from `__system`:**
- `requireInstanceAdmin`, `getSystemRole`, `isInstanceAdmin`, `findSystemOwnerId` → read `users.role`.
- `grantOwner` → `designateInstanceOwner` sets `users.role='owner'` instead of inserting a `__system` membership.
- `isReservedSlug` → **keep as-is.** Still blocks user creation of `_`-prefixed workspace slugs (defense-in-depth; harmless to keep, and a future reserved name may want it).
- `effectiveReach` / token narrowing → **keep.** It is caller-authority intersection, not tenancy. Library-agent special case simplifies away, but the instance-reach narrowing (`effectiveReach(null, run.workspaceId)`) still applies to instance-level agents acting in a workspace.
- `runBootTasks` → drops the `bootstrapSystemWorkspace` call; **gains** the `instance_skills` seed + operator-agent seed at its new home; owner designation reconciled per the rule below.

**OWNER-DESIGNATION RECONCILIATION (fixes #3 — two paths must agree).** Two things can set the instance owner, and the spec must say which wins or they silently disagree about *who owns the instance*:
1. the **backfill** (§4.1): `users.role='owner'` from the historical `__system` owner — fires on a **migrated** instance.
2. the **boot task** `designateInstanceOwner` from `FOLIO_INSTANCE_OWNER` — fires on **every** boot.

Rule (must be implemented, not "first-wins"):
- **The backfill is authoritative for migrated instances.** If a `users.role='owner'` already exists (the migration set it), the boot task does **not** silently override it.
- **The boot task is the fresh-instance path.** On an instance with **no** owner yet (no `__system` history — a clean install), `designateInstanceOwner(FOLIO_INSTANCE_OWNER)` designates the first owner.
- **Disagreement fails loudly.** If `FOLIO_INSTANCE_OWNER` is set AND an owner already exists AND they reference **different** users, the boot task **throws** (`INSTANCE_OWNER_CONFLICT`) rather than silently ignore the env var. Operators who re-point `FOLIO_INSTANCE_OWNER` get an explicit error, not a silent no-op. *(Pin with a test: env var disagreeing with existing owner → boot fails; env var agreeing or owner-absent → succeeds.)*

**MIGRATE — content moves to instance level:**
- `system-skills.ts` `FOLIO_SKILL_BODY` + `FOLIO_SKILL_FRONTMATTER` + `FOLIO_SKILL_SLUG` → seeded into `instance_skills` on boot. `loadAgentDefinition` loads skills from `instance_skills` (by name), not the `__system` Skills project.
- `OPERATOR_PROMPT`, `OPERATOR_TOOLS`, `OPERATOR_AGENT_TITLE` → **KEEP (D8).** The operator agent is re-seeded at its instance home (OQ-1). Its prompt/tools survive verbatim.
- `SETUP_PROJECT_REF_BODY` → reference doc; seed into `instance_skills` or a Settings help surface, or drop if obsolete. Plan decides.

### 4.5 Agent execution after teardown

Agent resolution simplifies, but differs by kind (D9) and must hold across all three custom-agent paths (D11):

- **Custom agents (project-scoped):** `resolveAgentForRun` collapses to a single query that finds the agent by slug, then bounds it by `frontmatter.projects` (invariant 3). All three invocation paths — `handleTriggerFired`, assignment, `handleCommentMentioned` — call the same simplified resolver; none of them consult `__system` anymore. The `home ∈ {run-ws, __system}` gate and the local-shadows-library logic are **deleted**.
- **Operator (instance-scoped):** resolved by its dedicated instance home (OQ-1), not by a workspace query. Its reach is instance-wide *by design*, still clamped by caller authority. **The operator-identity predicate MUST be unspoofable (fixes #4):** no user-created agent may claim operator identity and inherit instance-wide reach. The old model guaranteed this via token origin (`workspaceId null AND createdBy null` — unforgeable because a user cannot mint a `createdBy`-null token). Under **OQ-1(d) runtime singleton**, the guarantee is **two-layered**: (a) `isReservedSlug` blocks a user from creating an agent whose slug collides with the operator's, AND (b) the operator is resolved **from code, never from a `documents` lookup** — so even if a user's row somehow bore the operator slug, it could never *be* the operator (the resolver returns the code singleton, never a queried row). A user-created agent named like the operator is therefore inert: blocked at creation, and structurally unable to be resolved as the operator. Under **OQ-1(a) reserved row**, the predicate is "the agent IS the single seeded reserved-home row" (id/home match), still backed by `isReservedSlug`. Either way the predicate is stated and unspoofable — not "matches a slug string."
- A run still records `run.workspaceId` (the folder it acts in). `effectiveReach` still narrows the run token to that workspace so writes land in the right folder and respect project reach (invariant 3 intact).
- **The two ceilings are retained on every path (the threat-model crux, T-C):**
  - *Project ceiling* (invariant 3, `agent ∩ token ∩ caller`) — a custom agent acts only in its allow-listed projects; an @mention in a non-allow-listed project is refused.
  - *Caller-bounded authority* (invariants 3/7) — a comment @mention runs with **the @mentioning user's** authority ∩ the agent ceiling; a low-privilege summoner cannot escalate a high-privilege agent.
- The threat model must confirm that removing the workspace wall did **not** widen either ceiling on any of the three paths — especially `handleCommentMentioned`, which is the human-summoned path most exposed to authority confusion.

---

## 5. What changes — frontend (`apps/web`)

| Surface | Change |
|---------|--------|
| Workspace switcher / picker | **KEEP** as folder navigation. Remove any per-workspace role display. |
| `/w.$wslug.settings.tsx` | Per-workspace member/role UI **removed** (roles are instance-level now). |
| **NEW** instance Settings | Roles (assign owner/admin/member to users) + Invitations (grant/revoke workspace + project access) + existing instance AI/agents tabs. Built on the existing `/settings` route from the instance-AI-config work. |
| `triggers/trigger-agent-field.tsx`, `lib/api/workspace-documents.ts` | Remove the `library` badge + its comment (DEAD). |
| Data fetching | `useWorkspaces` etc. now reflect grant-based visibility from the server; no client change needed beyond removing role-from-membership assumptions. |
| Operator chat (cockpit) | Unaffected in shape — the operator survives (D10). The chat's operator reference is re-pointed at the rehomed operator (OQ-1); if OQ-1 = (d) runtime singleton, the chat resolves the operator from the runtime singleton rather than a `documents` row. |

---

## 6. Architecture invariants touched

This refactor rewrites convergence points; per the project's `ARCHITECTURE-INVARIANTS.md` each must route through (not around) its convergence point, and any new bypass is flagged at `/shakeout`.

| Inv | Property | Impact |
|-----|----------|--------|
| **1** | Auth identity (`AuthContext`) | Setters unchanged; `attachToken`/`attachUser` still the only identity source. `users.role` read downstream, not re-derived. ✅ stays converged. |
| **4** | HTTP authz (`requireScope`, `requireSessionUser`, `requireInstanceAdmin`) | `requireInstanceAdmin` rewritten to read `users.role`; new invitation/role routes MUST be session-only + correctly gated. **Highest-risk surface.** |
| **7** | Token authority ≤ minting role (`roleToScopes`) | Input source changes (`users.role`), logic identical. The 2026-06-01 CRITICAL was a bypass here — re-verify the mint path end-to-end. |
| **10** | Entity modeling: data-before-tables | **Deliberate, justified exception.** `workspace_access`/`project_access` are genuine relational join tables (many-to-many user↔resource), NOT document attributes — they cannot live in frontmatter (no single owning document; need indexed reverse lookup; are authorization data, not content). `users.role` is a typed column on an existing table, the same shape as a status. This must be NOTED in the invariant-10 sense and accepted, not silently bypassed. |
| **11** | Skill trust (`setSkillTrust`, `__system` skills page) | **Re-pointed + STRUCTURALLY HARDENED, NOT simplified away.** Skills move from `__system` documents to `instance_skills`, where **`trusted` becomes a typed first-class column** (§4.1 security note) — `setSkillTrust`/`canBlessSkill` is re-pointed at it and **kept**. The column (not a frontmatter key) is what makes T-E *enforceable*: import/restore/edit write `body`+`frontmatter` and physically cannot set `trusted`, so forging is structurally impossible, not strip-and-hope. **`trusted` is capability-trust, NOT tenant-isolation** — orthogonal: `trusted` gates what a skill is *allowed to do* (blessed → TRUSTED INSTRUCTIONS in the agent system prompt; unblessed → untrusted DATA envelope). Within one team a `member` still must not bless a skill an owner-authority agent then executes. So "no cross-tenant exposure ⇒ simplify trust" is a **category error**, explicitly rejected. *(Revised 2026-06-04 after review: struck the "or simplify" parenthetical AND fixed the schema that would have made the strip unenforceable.)* Simplifying the trust model, if ever wanted, is a **separate explicit decision**. The two Deliberate-exception reads tied to `__system` (loadAgentDefinition skill read, runner AI-key read) get re-pointed and re-ratified. |
| 2, 3, 8 | tools authz / project ceiling / SSE | Touched at edges (agent resolution, event scoping). Project ceiling (3) must hold after the workspace boundary drops — explicit threat-model check. |

`ARCHITECTURE-INVARIANTS.md` itself needs updating at the end: the `__system`-specific language in invariants 11 + the two Deliberate exceptions (loadAgentDefinition, AI-key read) must be rewritten to their new instance homes.

---

## 7. Threat model — fires in the plan (Stage 1a)

This work squarely hits the trigger list: **auth/session/token surfaces**, the **multi-tenancy boundary** (being removed), **BYOK credentials**, and **untrusted parsing** (invitation payloads). The plan will carry a full `## Threat model` section *before* task breakdown. Adversarial questions it must answer (named here so the plan addresses them, not so they're answered now):

- **T-A (residual isolation leak — and the LOST SAFETY NET):** Every query that filtered by `workspace_id` for *isolation* — does demoting it to *scoping* leak data across the team in a way that matters? Within one team, cross-member visibility is by-design; but **agent-run authority**, **token reach**, and **`/events` SSE streams** stay real boundaries and need explicit re-derivation. Enumerate each `WHERE workspace_id` and classify isolation-vs-scoping.
  **The deeper hazard (raised in review):** under multi-tenancy, a *misclassified* `workspace_id` filter that should have stayed isolation would surface as **another tenant's data appearing** — visibly wrong, caught fast by eye. After this change, the same misclassification merely shows **a teammate's data**, which looks like a *feature*, not a bug. **The human eye will no longer catch a widened boundary.** Enumeration alone is necessary but NOT sufficient — it can't fail loudly. Therefore each of the boundaries that remain real (**agent-run authority, token reach, `/events` scope at PROJECT granularity, grant visibility**) MUST be pinned by an **explicit regression test that breaks if the boundary widens**. Note the events test must be the **project-granularity / traverse-leak** version (§8.1) — the naive "no grant to B → zero B events" test passes trivially for a project-only invitee (they *have* a grant) and does NOT catch the leak the traverse clause (#2) introduced. These tests are a **hard requirement of the relevant sequence steps (§10)**, not optional coverage — they are the *replacement* for the isolation safety net the multi-tenant model gave for free. See §8.1 for the full mandatory list.
- **T-B (invitation as new attack surface):** The grant routes are a NEW write surface creating authorization data. Can a `member` grant themselves access? Can an `admin` grant access to a workspace they can't see? Can a malformed `(user_id, resource_id)` reference a non-existent/foreign resource? Gate: session-only, role-checked, FK-validated.
- **T-C (agent over-reach across all three invocation paths, D11):** Confirm both ceilings hold after the `__system` detour is removed, on each of `handleTriggerFired`, assignment, and `handleCommentMentioned`: (i) the project ceiling (invariant 3, `agent ∩ token ∩ caller`) still bounds a custom agent to its allow-listed projects, and (ii) caller-bounded authority still clamps a comment @mention to the **commenter's** role ∩ agent ceiling. The operator's deliberate instance-wide reach is in-scope/by-design but must still be caller-clamped. The comment path is the highest-risk (human-summoned, authority-confusion prone) — verify it explicitly.
- **T-D (token meaning after demotion, D6):** Resolve the token scope model. With workspaces non-isolating, what does a `workspace_id`-pinned token mean vs. instance-reach? Does the operator's system-origin token (`createdBy null`) identity still hold?
- **T-E (skill-trust after rehoming, invariant 11):** After skills move to `instance_skills`, re-confirm `trusted` can only be set via the sanctioned mutator; no bulk-import/restore/raw-update path can forge it. Re-point `stripManagedSkillTrust`.
- **T-F (privilege collapse in data migration):** Verify the **corrected** backfill rule (§4.1) does NOT escalate: `users.role` must come ONLY from `__system` membership (else `member`); assert that a user who was a per-workspace `owner`/`admin` but held no `__system` role lands as instance-`member` with a `workspace_access` grant — NOT instance-`owner`. (This is the test that would have caught the original "highest role across all workspaces" bug. Pin it.)

---

## 8. Sibling-site audit surfaces (for the plan)

Cross-cutting changes whose every site must move together (per `feedback_plan-server-source-audit`):

- **`memberships` references** — every `db.query.memberships` / `memberships.findFirst` / import across `apps/server`. Each is either a role read (→ `users.role`) or an access read (→ `workspace_access`). None may be left pointing at the dropped table.
- **`workspace_id` filters** — every `eq(*.workspaceId, …)` in services/routes: classify isolation (→ access check) vs scoping (→ keep as folder key).
- **`__system` / `getSystemWorkspaceId` / `findSystemWorkspaceId` / `SYSTEM_WORKSPACE_SLUG` / `isReservedSlug` / `library`** — every consumer (server + web), verdict-tagged DEAD/REWORK/MIGRATE.
- **`requireInstanceAdmin` consumers** — all must work after it reads `users.role`.
- **`roleToScopes` callers** — confirm each now sources `users.role`.
- **The `role` type** (`'owner'|'admin'|'member'`) — every place it's read off a membership.
- **`resolveAgentForRun` call sites (D11)** — all three: `handleTriggerFired`, `handleCommentMentioned`, and the assignment/resume paths in `trigger-matcher.ts`/`runner.ts`. Each must collapse to the simplified single-query resolver and keep both ceilings. Do not leave one path still consulting `__system`.
- **Cockpit-chat operator resolution (D10)** — wherever the cockpit-chat spec/code references the operator (by `__system` membership or `OPERATOR_AGENT_TITLE` in `__system`), it must point at the rehomed operator (OQ-1). Cross-check `2026-06-03-operator-cockpit-chat-design.md` so this refactor doesn't strand the chat.
- **Tests** — `system-workspace.test.ts`, `runner.test.ts` (home-predicate + library-agent), `trigger-matcher.test.ts` (C1), `phase-gate-a/b.integration.test.ts`, `instance-tokens.test.ts`, `phase-aikeys.integration.test.ts`: each DELETE / REWORK per the teardown map.

### 8.1 Boundary-regression tests (MANDATORY — the replacement safety net, per T-A)

Because a widened boundary now looks like a feature (a teammate's data) rather than a bug (a stranger's data), the three boundaries that **stay real** after tenancy is removed must each be pinned by a test that **fails loudly if the boundary widens**. These are acceptance criteria of their sequence steps (§10), not optional coverage:

| Boundary | Regression test that must exist | Step |
|---|---|---|
| **`/events` SSE — no grant** | A user with **no grant** to workspace B subscribes to B's `/events` and receives **zero** B events. | 3 |
| **`/events` SSE — TRAVERSE leak (the #2 case the naive test misses)** | A user with `project_access` to **only project P in workspace B** (no `workspace_access`) subscribes to B's `/events`: receives events for **P** and **zero** events from B's *other* projects. ⚠️ The naive "no grant → zero events" test PASSES TRIVIALLY for this user (they *have* a grant), so it does NOT cover the traverse leak — this row is mandatory and distinct. | 3 |
| **Token reach** | A token minted by a `member` (or pinned/narrowed) **cannot** read/write a project the minter lacks access to — asserts `roleToScopes(users.role)` ∩ grant still bounds it. The 2026-06-01 CRITICAL lived here. | 3 |
| **Agent-run authority** | An agent run (all three D11 paths) **cannot** act outside `agent ∩ token ∩ caller`: a comment @mention by a `member` cannot exceed `member`; a run cannot touch a project off the agent's allow-list. Widening fails. | 4 |
| **Visibility — workspace grant** | A `member` with `workspace_access` to A but not B gets A in `listWorkspaces` and **404/403 on B**'s contents. | 3 |
| **Visibility — project-only traverse** | A `project_access`-only user (project P in B, no ws grant) **passes** `resolveWorkspace` for B (traverse), but `listProjects` returns **only P**, and `resolveProject` **403s** on any other project in B. Pins the §3 traverse boundary on the navigation surface. | 3 |
| **Skill-trust forging (T-E)** | An import / restore / raw-frontmatter write that carries `trusted:true` in its payload **cannot** set `instance_skills.trusted` — only `setSkillTrust` can. Asserts the typed-column guarantee (§4.1 security note). | 4 |

If any of these tests is hard to write against the new shape, that is a signal the boundary is unclear — resolve it in the plan, do not ship without the test.

---

## 9. Open questions (resolve before/within the plan)

**OQ-1 — Operator agent's new home.** The operator survives (D8) and is the *only* agent needing an instance home (D9 — custom agents stay project-scoped). The real fork is **"does the operator need a `documents` row at all?"** — because its prompt and tools are code constants (`OPERATOR_PROMPT`, `OPERATOR_TOOLS`), it is unique, and it is never user-edited. Candidates, best to worst:

  - **(d) Runtime singleton — no `documents` row (NEW, recommended candidate).** The operator is resolved directly from code constants; the cockpit chat (D10) and `resolveAgentForRun` special-case "is this the operator?" and materialize it at runtime. **Sidesteps OQ-1 *and* OQ-4 entirely** — no home, no schema question, no nullable column, no reserved row. *Cost:* breaks the "every agent is a `documents` row" uniformity, so `resolveAgentForRun` gains one branch (operator → constant; else → DB query). Given the operator is genuinely *sui generis* (instance-scoped, code-defined, singular), a branch is honest, not a hack. **Identity must be unspoofable (§4.5 operator predicate):** the resolve-from-code path (never a `documents` lookup) + `isReservedSlug` together guarantee no user-created agent can become the operator — this is the security condition that makes (d)'s one branch a safe seam, not an escalation seam.
  - **(a) Reserved instance home (one row, `NOT NULL` preserved).** A sentinel home row for the single operator that is explicitly NOT a tenancy boundary — surfaced only in Settings, never the switcher, no membership, no cross-ws machinery. Keeps `documents.workspace_id NOT NULL` everywhere, so the type system and every existing `eq(documents.workspaceId, …)` query keep working unchanged. *Cost:* reintroduces a reserved row right after deleting `__system` (but it is one inert row, not a workspace concept).
  - **(c) Seeded into a designated default workspace.** No schema change, but "instance operator" becomes a fiction (really a privileged-workspace agent), and "which workspace is default" is itself unresolved. Weak.
  - **(b) `documents.workspace_id` nullable for the operator row — LAST RESORT.** A nullable tenancy key is exactly the **row-level-tenancy smell §1 swears off** ("no row-level tenancy code should remain"). Worse, it makes **every** existing `eq(documents.workspaceId, ws)` silently exclude the operator (NULL never matches `=`), turning T-A's enumeration into a **correctness** dependency, not just an isolation audit. Only choose this if (d) and (a) are both rejected.

  **DECIDED 2026-06-04 → (d) runtime singleton.** The operator is resolved from code constants (`OPERATOR_PROMPT`/`OPERATOR_TOOLS`), never a `documents` row; `resolveAgentForRun` gains one operator branch. `documents.workspace_id` stays `NOT NULL` everywhere (OQ-4 dissolves). Identity is unspoofable per §4.5 (resolve-from-code + `isReservedSlug`). *(Recommendation (a) reserved-row was the fallback; (b) nullable-key explicitly avoided as the §1 row-tenancy smell.)*

**OQ-2 — ~~Role collapse rule~~ — REMOVED (was blessing a bug).** *Struck 2026-06-04 after review: this OQ asked whether to confirm "highest role across all workspaces → instance role," which is the privilege-escalation defect identified in §4.1. It is not an open question — it is a fixed rule: `users.role ← __system role if any, else member`; per-workspace owner/admin → `workspace_access` grants. No confirmation needed; the alternative was incorrect.*

**OQ-3 — Who can change roles / invite? DECIDED 2026-06-04.** **Owner + admin can invite** (grant/revoke `workspace_access` + `project_access`); **only owner can change instance roles** (`PATCH …/users/:id/role`). Rationale: inviting grants *access to content*, a delegable admin task; changing a *role* alters instance authority (an admin could promote a `member` to `admin`, or themselves toward owner) — that stays owner-only. The invitation route is gated `requireInstanceAdmin` (owner|admin); the role route is gated **owner-only** (a stricter check than `requireInstanceAdmin`). Pin both gates with tests (admin can invite ✓; admin changing a role → 403).

**OQ-4 — `documents.workspace_id` nullability.** Folded into OQ-1. If OQ-1 = **(d)** runtime singleton, this question disappears (the operator has no row) and `workspace_id` stays `NOT NULL` everywhere. If OQ-1 = **(a)** or **(c)**, also `NOT NULL`. Only OQ-1 = **(b)** (last resort) makes it nullable. So under the recommended path, `documents.workspace_id` stays `NOT NULL` and there is no independent OQ-4 to decide.

---

## 10. Sequence (plan will expand to tasked phases) — EXPAND-CONTRACT ordered

The ordering is constrained by #2 (the running code reads `memberships` until the auth rewrite lands). **No table is dropped while live code still references it.** Additive migrations first; the `memberships` drop is the **last** migration authored.

1. **EXPAND — additive schema + backfill (no drops).** Add `users.role`, `workspace_access`, `project_access`, `instance_skills`. Backfill from `memberships` with the **corrected rule** (§4.1): `users.role ← __system role else member`; per-ws roles → `workspace_access`. `memberships` **stays**. Suite green (old code still reads `memberships`, which still exists).
2. **Auth/scope rewrite (code).** `resolveWorkspace`/`resolveProject` → the 3-clause grant rule (incl. project-access traverse, §3/§4.2); `requireInstanceAdmin`/`grantOwner`/`getSystemRole` → `users.role`; `roleToScopes` source → `users.role`. Every `memberships` *read* migrated off. Suite green.
3. **Routes + services + MANDATORY boundary tests.** Visibility filters (`listWorkspaces`/`listProjects` → `canSee*`, with `listProjects` filtering by `canSeeProject`); NEW invitation + role routes (session-only, gated per OQ-3); `/me` signals; token mint ceiling. **Land the §8.1 regression tests for `/events` scope, token reach, and visibility here** — they are acceptance criteria, not follow-ups. Suite green.
4. **`__system` teardown — code, then the contract migrations.** Delete DEAD, rehome MIGRATE (`instance_skills` seed + operator per OQ-1), rework REWORK; collapse `resolveAgentForRun` (all 3 D11 paths) to the simplified resolver; re-point skill-trust at `instance_skills` (kept, not simplified — §6). **Land the §8.1 agent-run-authority regression test here.** THEN author the two **contract** migrations: `__system` teardown (idempotent) and finally **drop `memberships`** (now that no code references it). Suite green.
5. **Frontend.** Instance Settings (roles + invitations); remove per-workspace role UI + library badge; keep switcher/grouping; point cockpit-chat at the rehomed operator (D10). Suite green (web via `npx vitest run`).
6. **Invariants doc update.** Rewrite `__system` language in `ARCHITECTURE-INVARIANTS.md` (inv 11 + the two Deliberate exceptions — loadAgentDefinition, AI-key read) to instance homes; add the invariant-10 deliberate exception for the two access join-tables.
7. **Shake-out + finish.** `/shakeout` (re-run integration, E2E, reviewer agents incl. `invariant-auditor` + `security-sentinel`), then finish-branch.

Each step keeps the suite green (server from `apps/server`, web via `npx vitest run`, typecheck per-app). **"Green at each step" is real only because the `memberships` drop is deferred to step 4** — dropping it in step 1 (as an earlier draft did) would break steps 2–3, where live code still reads it. The threat model from the plan is the `/code-review` convergence target for steps 2–4.

---

## 11. Explicitly out of scope

- Custom/user-defined roles (D2 — built-in three only).
- Per-tenant databases (the future tenancy path — not built now, just kept architecturally open).
- Any new agent capability beyond rehoming the operator.
- Search, comments, attachments (already v1-deferred).
- Changing the document/frontmatter model. Under the recommended OQ-1 path (d/a), `documents.workspace_id` stays `NOT NULL` and the schema is untouched here; only the rejected last-resort (b) would alter it.
