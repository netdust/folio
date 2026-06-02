# Cross-Workspace Agents + the System Library — Design

_Written 2026-06-02. Supersedes the per-workspace "seeded operator bot" model (reset from branch `phase-op-3/the-agent`; the seeded-bot commits are archived at tag `archive/phase-op-3-seeded-bot`). The `folio_api`/`folio_api_get` tool surface from that work is KEPT and underpins this design._

---

## Problem

Folio's agents and triggers are bound to a single workspace. To reuse one elsewhere you copy/paste it. There is no shared home for agent-related content (skills, reference docs, reusable agents/triggers) that isn't tied to a customer workspace. The built-in "operator" agent — an agent that should be able to do everything the **outside** agent (Claude Code over MCP) can do, across all workspaces, securely — has nowhere coherent to live.

The first attempt modeled the operator as a per-workspace **seeded bot**: an agent doc + hidden `folio_system` memory pages seeded into *every* workspace, with a SQL backfill, a TOCTOU-prone first-project hack, and a parity test. It was the wrong model (duplication, hiding hacks, a leak surface) and it produced an operator that — caught only at the final whole-implementation review — could not run at all. See `memory/project_operator-is-an-agent-not-a-seeded-bot.md`.

## The model (north star)

**The operator is just an AGENT** with the outside agent's caller-bounded cross-workspace reach + skills + reference docs. It is not a new principal type, not seeded per workspace, not hidden-memory machinery.

Two ideas carry the whole design:

1. **One `__system` library workspace** holds the agent substrate — skills, reference docs, reusable agents, reusable triggers — as **ordinary documents**. No new doc types, no hiding flag, no per-workspace seeding. Created once at instance bootstrap.
2. **An agent is a reusable DEFINITION; a run carries the TARGET workspace.** Today `run.workspaceId` == the agent's workspace (assumed identical everywhere). We split them: a run records both where the agent is **defined** (its home workspace: the run's own workspace for a local agent, or `__system` for a library agent) and where it **acts** (the target workspace). The agent reads/writes the target's data.

## What is KEPT from the prior work (already built, green)

The capability surface — unchanged, caller-bounded, on the branch at `cde8845`:

- `folio_api` — write any token-scoped `/api/v1/...` route in-process (POST/PATCH/PUT/DELETE), `config:write`-gated, risk-classified.
- `folio_api_get` — read any route (GET-forced, `documents:read`).
- `validateApiPath` — rejects scheme/traversal/protocol-relative/control-chars/SSE `/events`; relative `/api/v1/...` only.
- `classifyRisk(method, path, body)` → `low | medium | high` (low = document writes; medium = config writes tables/fields/views/statuses/projects; high = token mint/revoke, ai-keys, workspace delete/rename, members, bulk).
- `dispatchAsCaller` — mint-and-revoke a short-lived bearer mirroring the run's token (scopes/agentId/projectIds verbatim), send it as an `Authorization` header to `app.request`, revoke in a `finally`; boot sweep `sweepOrphanedFolioApiTokens` backstops a crash. (The no-mint seeded-ctx path is infeasible in Hono 4.6.12 — see `memory/project_folio-api-inprocess-no-token-mint.md`.)

A library agent acting in workspace B uses these exactly as a local agent does. They already span workspaces **if the caller can** — so the cross-workspace work in this spec is the **definition/execution** model, not the tool surface.

---

## Architecture

### Component 1 — The `__system` library workspace

- **Identity:** a normal workspace at the reserved slug `__system`, created once at instance bootstrap. No schema change; marked only by its reserved slug. Idempotent (create only if absent).
- **Internal structure:**
  - A **`Skills` project** — one `page` document per skill, slug = the skill name (`folio`; later `seo`, `research`, `thinking`). The body is the skill content (markdown).
  - A **`Reference` project** — the "set up a project" guide, the API manual, as pages.
  - **Agents + triggers** live at the workspace level (they are already `project_id = NULL`): the operator agent and any reusable custom agents/triggers exist in `__system` the normal way.
- **Why normal projects/docs:** zero new concepts. Skills/refs are listable, editable, versioned exactly like any content; an admin curates them in the normal UI. A "skill" is a page-by-convention (a slug in a known project), not a first-class type — consistent with binding skills by slug (Component 4). If `list_skills` discovery is wanted later, the `Skills` project is its clean home with no restructuring.

### Component 2 — Who curates the library (instance-admin = `__system` membership)

- **Membership in `__system` IS the instance-admin definition.** Folio has no separate instance-admin role today; we reuse per-workspace membership on a special workspace. Whoever is a member of `__system` may curate the library; everyone else cannot see it.

- **The `__system` workspace is created at boot (idempotent), but its first MEMBER is designated separately** — because a fresh install has no users at boot, and an existing install already has users (so "first registration" never fires). The two paths:
  - **Fresh install:** the first `__system` membership is seeded when the **first user registers** (first account created → `__system` member = instance owner). **Precondition (fix #2 — registration race):** on a self-hostable deploy, "first registration wins" is a race — anyone who reaches the open registration endpoint first becomes instance owner. So the deploy MUST do ONE of: (a) gate/disable open registration until the owner account is created (the installer creates the first account), OR (b) set the owner at deploy time via env/CLI (below). The spec REQUIRES the deploy story to close this race; "first user = owner" is only safe behind a gated first-registration. This is a documented install precondition, not an assumption.
  - **Existing install (fix #1 — the stranding bug):** first-registration already fired long ago, so it can never seed `__system`. Without a separate path, `__system` would have **no member**, nobody could curate it, and Phase A would strand the operator there. So Phase A MUST ship a **one-time owner-designation path** that works regardless of install age: a CLI command / env var (e.g. `FOLIO_INSTANCE_OWNER=<email>`) / an idempotent "promote this existing user to `__system` member" operation, run once by the operator-of-the-server. Idempotent: re-running is a no-op if `__system` already has a member.

- **Reserved-slug protection + ownership verification (fix #3 — slug hijack).** `__system` is a creation-protected reserved slug:
  - **Workspace creation REJECTS the slug `__system`** (and any reserved-prefix slug we standardize) for ALL non-bootstrap callers — a normal user/admin/agent cannot create or rename a workspace to `__system`. Enforced at the workspace-create/rename route (the same `requireSessionUser` surface), not just by convention.
  - **Bootstrap VERIFIES, not just "creates if absent."** If `__system` already exists at boot, bootstrap asserts it is **system-owned** (created by the bootstrap path / carries the system marker), and fails loud / refuses to treat a user-created `__system` as the library. "Create if absent" alone lets an attacker who reached an ungated install claim the slug first and have the library bootstrap ONTO their workspace — so the existence check must confirm provenance, not just name. (Implementation detail for the plan: a system marker on the workspace row or a guaranteed-system creation path; the invariant is *bootstrap never adopts a workspace it didn't create*.)

- **Visibility:** `__system` is NOT in the normal workspace switcher. It is surfaced via a **Settings → System Library** entry, visible only to `__system` members.

### Component 3 — Cross-workspace execution (the run model)

Three workspace-bound points in today's code must change. All three are in this spec; the phasing (below) decides build order.

**(a) Agent resolution — `loadContext` (`apps/server/src/lib/runner.ts`).**
Today the agent is resolved by `(run.workspaceId + slug)`, so a run can only use an agent in its own workspace. The change: the run carries the agent's **document id** (globally unique; today it effectively re-derives the agent from `run.workspaceId + agent_slug`), and `loadContext` resolves the agent by that id **gated by a home-workspace predicate** — the resolved agent's `workspaceId` (its home) must be in `{the run's own workspace, __system}`. *(Encoding note for the plan: the run already references its agent; the load-bearing change is that resolution keys on the agent id + checks the home predicate, rather than keying on `run.workspaceId`. Whether this needs a new run column or rides existing run fields is a plan detail — the invariant is: resolve-by-id, then assert home ∈ {run-ws, `__system`}.)*
- **The predicate is the security boundary, not the global lookup.** Bare global-id resolution would let a run in B reference a *private* agent in workspace C; because an agent contributes **capability** (its prompt body + its tool set), that would leak C's prompt and graft C's tools onto a B run — cross-tenant **capability** borrowing (even though caller-bound authority keeps C's *data* safe). The `{run workspace, __system}` predicate forecloses it: a run may use its own workspace's agents or the shared library, nothing else.
- Backward-compatible: a local agent's home == the run's workspace, so existing runs are unaffected.

**(b) Authority — caller is the sole authority (`loadContext` + `agent-projects.ts`).**
A run's effective authority is the **caller's** scopes + projects **in the target workspace B** (the existing `agent ∩ caller` machinery). For a library agent the agent side of the intersection is effectively `*`/defer — the agent's own `projects` allow-list is **not consulted** (a library agent has no projects in B; `resolveAgentProjects`' `'*'` = "my workspace's projects" is meaningless cross-workspace).
- **Consequence:** a member-invoked run gets member reach in B; an admin-invoked run gets admin reach in B. The agent contributes **capability** (tools + skill), **zero authority**. No new "which workspaces may this agent act in" allow-list dimension.
- This is *simpler* than today's per-agent project allow-list for library agents (authority = caller, full stop).

**(c) The trigger-matcher (`apps/server/src/lib/trigger-matcher.ts`).**
Today a trigger fires only agents whose `workspaceId` matches the trigger's workspace. For a B trigger to fire a library agent, the matcher must resolve agent targets against the same `{B, __system}` predicate as run resolution.
- **Consequence:** a customer can wire a B trigger to a shared library agent (e.g. "on new lead → run the SEO agent"); the run executes against B with B-caller authority. Without this, library agents are human-invoke-only.
- This is the largest single surface and is a **later phase** (human invocation is the foundation; trigger-firing builds on it).

### Component 4 — Skill binding + definitional loading (NOT caller-bounded)

- **Binding by slug:** an agent's frontmatter lists the skills it uses (`skills: ['folio']`). The operator references `folio`; a future SEO agent references `['seo', 'research']`.
- **Loading a skill is a DEFINITIONAL act, not an authority act on data.** The agent's prompt body + its bound-skill docs are **materialized into the run by the runner, server-side, from `__system`, at load time** — they are part of *what the agent is*. They are **NOT** fetched through `folio_api_get`/`get_document` (those are caller-bounded and would 403/404 for a customer admin who is not a `__system` member).
- **Why this is necessary + consistent:** a customer admin in B is not a `__system` member, so a caller-bounded skill read would fail, and granting every customer read on `__system` would leak the whole library and contradict Component 2. The definitional exemption resolves it: **"authority = caller, sole" applies ONLY to acting on the target workspace's data** (its documents/tables), never to loading the agent's own definition.
- **The exemption is narrowly scoped (the security boundary):** the runner's system-authority read may touch EXACTLY (1) the agent doc's own body, and (2) the specific skill docs named in the agent's frontmatter, by slug, from `__system`. **Nothing else in `__system` is reachable through a run.** The exemption cannot be used to enumerate or read arbitrary library content. (Chosen over "whole `__system` readable by any library agent's run," whose blast radius would be the entire library for every customer who can invoke any library agent.)

---

## Data flow — a library agent run end-to-end

1. A caller C in workspace B starts a run (assign / @-mention / Cmd-K / run UI) targeting a library agent (e.g. `__system`/`operator`). Library agents are **listed in every workspace's** run/assign surfaces alongside B's own agents (selecting one creates a run recording `target workspace = B`, `agent home = __system`, `agent slug`).
2. The poller claims the run; `loadContext` resolves the agent **by id where home ∈ {B, __system}** (Component 3a). If the agent's home is neither B nor `__system`, resolution fails (no cross-tenant capability borrowing).
3. The runner materializes the agent's **definition** — prompt body + the frontmatter-named skill docs — via the **narrow definitional system-read** from `__system` (Component 4). No caller membership in `__system` is required or used for this.
4. The run token is built from **C's authority in B** (scopes + projects), agent side = defer (Component 3b). 
5. The agent acts: `folio_api`/`folio_api_get`/the narrow tools all operate on **B's** data, caller-bounded, risk-classified. It can never exceed what C can do in B.
6. Every write emits an event (unchanged invariant). The run's transcript/result land on B.

## Error handling

- Agent resolution miss (home ∉ {B, `__system`}, or no such slug) → `loadContext` returns null → run skipped/failed-loud (existing behavior).
- Skill slug named in frontmatter but absent in `__system` → the definitional load surfaces a clear "missing skill `<slug>`" error on the run (fail-loud, not silent).
- Caller lacks authority in B for an action → the existing `executeTool` / `requireScope` denial (`forbidden: scope ...`), surfaced to the model as a recoverable tool error.
- `__system` not yet bootstrapped (pre-first-user) → no library agents are listed; local agents unaffected.

## Testing

- Unit: the resolution predicate (home ∈ {run-ws, `__system`} accepted; a third workspace C rejected). The definitional-read allow-list (agent body + named skills readable; an arbitrary other `__system` doc NOT readable through a run). Authority = caller (member-invoked library-agent run denied a `config:write` action in B; admin-invoked allowed — modulo the OPEN risk-gate item).
- Integration: a full library-agent run against a target workspace via the real composed loop (poller + runner), asserting it reads/writes B's data and loads its skill without `__system` membership.
- Trigger phase: a B trigger fires a `__system` agent; the run executes against B.

---

## Phasing (one spec, phased plans)

Each phase is a separate implementation plan sized for review.

- **Phase A — Library foundation.** Bootstrap `__system` (reserved slug, idempotent, **creation-protected + ownership-verified per Component 2 fix #3**); the **owner-designation path** (Component 2: fresh-install gated first-registration AND the existing-install one-time promote — fix #1/#2); create the `Skills` + `Reference` projects; seed the `folio` skill + reference docs as documents; place the operator agent in `__system`. (No execution-model change yet — the operator is reachable to `__system` members.)
- **Phase B — Cross-workspace execution.** The agent-resolution predicate (`{run workspace, __system}`); the narrow definitional skill-load exemption; authority = caller-sole; library agents listed in every workspace's run/assign UI; skill binding by slug materialized at load. **INTERIM HIGH-tier rule (fix #4 — binding, not open): until the approval-gate ships, `classifyRisk` HIGH refuses-with-plan REGARDLESS of caller** (no silent auto-apply of a HIGH action, even for an admin). Phase B does NOT ship everywhere-invokable + HIGH-open together — making the operator invokable in every workspace while HIGH could silently auto-apply would put destructive cross-tenant actions one prompt-injection away. The interim default is the safe floor; the OPEN item below is only about *relaxing* it later, never about shipping B without it.
- **Phase C — Cross-workspace triggers.** The trigger-matcher predicate so B triggers can fire library agents; the trigger-target UI surfaces library agents.
- **Phase D — Library curation UI.** The Settings → System Library surface (visible to `__system` members) for curating skills/agents/triggers.

## OPEN decisions (resolve before/within the phase that forces them)

- **Relaxing the HIGH-tier gate for trusted callers (the interim default is already SET).** Phase B ships the safe floor: HIGH refuses-with-plan regardless of caller (above). The OPEN question is only whether, once the approval-gate ships, a sufficiently-privileged caller (e.g. an admin, or a `__system` member) may get confirm-then-apply instead of hard-refuse for HIGH actions — i.e. how much to *relax* the floor. Interacts with the deferred approval-gate (Phase 3.x, `// TODO(approval-gate)` in `folio-api-tool.ts`). We are NOT cementing "admin = silent auto reach"; the floor holds until a deliberate relaxation lands.
- **Instance-admin beyond `__system` membership.** This spec defines instance-admin AS `__system` membership. If a richer instance-admin model is later needed (e.g. multiple tiers, a queryable flag), it would supersede Component 2 — flagged so the simple model isn't mistaken for permanent.

## Threat model pointer

Phase B touches authorization convergence points (the `executeTool` scope ceiling, the `loadContext` project clamp, the new agent-resolution predicate, the definitional-read exemption) and crosses the multi-tenancy boundary. The implementing plan(s) for Phase B and Phase C MUST invoke `netdust-core:threat-modeling` and cite `ARCHITECTURE-INVARIANTS.md` (invariants 2, 3, 4, 10) — the cross-tenant capability-borrowing risk (Component 3a) and the definitional-read exemption (Component 4) are the headline attack surfaces.

## Non-goals (v1)

- A first-class `skill` document type or registry (slug-by-convention suffices).
- `list_skills` runtime discovery (deferred; the `Skills` project leaves room).
- A general instance-admin role system (membership in `__system` is the definition).
- Managed-copy/template instantiation of agents (rejected in favor of the definition-acts-on-target model).
- Cross-workspace agent **chains** (`FOLIO_AGENT_CHAINS_ENABLED` stays off; OP1-F8 remains the prerequisite).
