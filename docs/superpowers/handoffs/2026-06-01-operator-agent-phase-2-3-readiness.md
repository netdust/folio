# Operator Agent — Phase 2 & 3 Readiness Handoff

_Written 2026-06-01, after Phase 1 (caller-identity delegation) merged to local main (`c32daa5`, `--no-ff`)._

## Where we are

The **built-in Folio operator agent** is a 3-phase build. The spec is `docs/superpowers/specs/2026-06-01-builtin-folio-operator-agent-design.md`. The governing decisions are in `memory/DECISIONS.md` ("Agent modes — the taxonomy + the v1 boundary") and auto-memory `project_builtin-operator-agent` / `project_agent-modes-taxonomy`.

- **✅ Phase 1 — Caller-identity delegation — DONE + merged to local main.** Plan: `docs/superpowers/plans/2026-06-01-operator-agent-phase-1-caller-delegation.md` (with 4 inline plan-corrections + the `/code-review` findings section). An agent run now carries the **caller's** authority; an agent can never exceed the human who started it (`effective = agent ∩ caller` for scopes AND projects, fail-closed). Built TDD, two-stage-reviewed per task, hardened by `/code-review high` (10 findings — real leaks fixed + re-reviewed FIX SOUND), integration-gated, shake-out clean. Gates at merge: server **1092/0**, shared **63/0**, web **725/+8-skip/0**, tsc clean ×3.
- **⬜ Phase 2 — API completion (token-scoped write surface + universal `dryRun`).** NOT started.
- **⬜ Phase 3 — The agent itself (`folio_api` tool + `folio` skill + 2-layer memory + seeded operator agent).** NOT started.

## What Phase 1 actually shipped (the foundation Phases 2/3 stand on)

The delegate ceiling is LIVE for the existing tool surface:
- `caller_scopes` + `caller_project_ids` are required run-frontmatter fields (`agent-run-schema.ts`), server-derived in `createRun` from the actor's membership role (`roleToScopes`: owner/admin → all 4 scopes `documents:read|write|delete` + `agents:write`; member → `documents:read|write`). NEVER client-supplied (D2).
- **Scope ceiling is central** — `executeTool` (`agent-tools.ts`) does the double-membership check `token.scopes ∩ callerScopes`, fail-closed.
- **Project ceiling is central** — `loadContext` (`runner.ts`) narrows `ctx.token.projectIds = intersectAgentProjects(token.projectIds ?? ['*'], fm.caller_project_ids)` ONCE, so every downstream `intersectAgentProjects(agentProjects, token.projectIds)` (the registry tools + the ccExecute ephemeral-token mint) automatically enforces agent∩token∩caller. **This is the altitude `/code-review` forced** — do NOT re-introduce per-call-site project clamping (that was the leak).
- Resume inherits the original run's snapshot (D6); non-member owner fails loud (`RUN_OWNER_NOT_A_MEMBER`, 403); migration `0020` backfills history fail-closed (`[]`/`null`).
- `roleToScopes` is the HUMAN scope policy (the human analog of `toolsToScopes`). It lives in `agent-schema.ts`. **Phase 2 will extend it** — new write scopes for views/users/settings must be added to `roleToScopes` (owner/admin tier) when those routes land, or the operator can't use them even as an owner-delegate.

## Carried obligations into Phase 2/3 (from `tasks/retro-follow-ups.md`)

- **OP1-F8 (MANDATORY before agent-chains):** chain via `run_agent` re-derives the sub-run's caller snapshot instead of inheriting the parent's. Not weaponizable today (agents:write gates chaining to owner/admin), but MUST be fixed before `FOLIO_AGENT_CHAINS_ENABLED` flips on. Phase 3 does not need chains (turn-based "task, report, done"), so this can stay deferred unless Phase 3 introduces fan-out.
- **OP1-F7:** retry re-derives caller authority from the retrying actor, not the original run (unlike resume). Authority-consistency gap; fix alongside F8 (unify resume/retry/chain = inherit-from-origin).
- **OP1-F9 (minor):** member project snapshot frozen at create-time (a project added after run-create is excluded though the member sees it in-UI). Revisit member project semantics — possibly member → wildcard given workspace-level membership.
- **OP1-DECIDED — the operator runs on an API provider ONLY (Stefan, 2026-06-01).** Folio has two runner backends: API-provider (in-process loop, every tool call goes through `executeTool` → the Phase-1 delegate ceiling APPLIES) and claude-code (spawns the `claude` CLI; its native CLI tools do NOT route through `executeTool` → the scope ceiling does NOT apply). **The built-in operator agent MUST run on an API provider** so the ceiling we built actually constrains it; claude-code is NOT a valid backend for the operator. Phase 3 seeds the operator agent with `provider: anthropic` (or another API provider), never `claude-code`. This closes what was an open gap — the claude-code scope bypass is a general property of that backend (`project_claude-code-runner-cli-not-sdk`), now simply OUT OF the operator's path by construction. (The bypass only matters for a USER who deliberately configures a claude-code agent — not the operator.)

---

## Phase 2 — API completion (the token-scoped write surface) — the heavier, riskier half

**Goal (from the spec):** the general `folio_api` primitive is only as capable as the routes it can call WITH A BEARER TOKEN AND A SCOPE. Phase 2 walks every instance resource the operator must operate and guarantees, per resource: (a) a REST route exists, (b) it accepts the agent's bearer token (not session-only), (c) it's behind a scope the delegate-authority check can mirror, (d) it re-asserts the tenant guard, (e) it emits an event on mutation, (f) it supports **`dryRun=true`** → returns `{would_create, would_update, ...}` without mutating.

**Resource inventory (the spec's table — each row = a route + scope audit + dryRun):**

| Resource | Operations | Current state (verify live before planning) | v1 gate default (coarse) |
|---|---|---|---|
| Views | create/update/delete | read-only (MCP `list_views`/`run_view`) | auto |
| Filters | author (view config) | via view config | auto |
| Fields | write (pin type/options) | read exists; write needs token-scoping | auto |
| Settings | read(redacted)/update; AI-key | **session-only** | plan→apply; AI key write-only |
| Users/memberships | invite/add/role-change | **session-only** | plan→apply (highest blast radius) |
| Workspaces/projects | create/configure | partial | create=plan→apply; configure=auto |

**The hard part of Phase 2 (flag at planning):**
1. **Opening session-only routes to token auth** is a real attack-surface change (users, settings). Mandatory `netdust-core:threat-modeling` pass — extend the D1–D10 model with D11+. The redact-at-the-loader discipline (`project_redact-at-the-loader-not-the-handler`) MUST cover the new GET paths (AI key never returned, even partially).
2. **`dryRun` is a route contract, not an afterthought** — every mutating route returns the diff without mutating, AND the dryRun call must not leak data the real call would redact (shares the loader/redaction path).
3. **New scopes** — adding `views:write`, `settings:write`, `users:write` (or however they're named) means extending `roleToScopes` (Phase 1) so owner/admin-delegates can actually use them. The delegate ceiling from Phase 1 protects these new routes FOR FREE once they're token-scoped — that's the payoff.
4. **The v1 gate is the resource-type coarse approximation** — the risk-SCORED gate (objects/reversibility/scope/permissions) is explicitly NOT v1 (spec's risk-gate section). Don't build the scorer; build the coarse per-resource default + the universal `dryRun` so the scorer drops in later.

**Before writing the Phase 2 plan:** invoke `superpowers:writing-plans` + `netdust-core:threat-modeling` together. Ground-truth EACH resource's current route + auth (grep all of `apps/server/src/routes` — `feedback_plan-server-source-audit`). Plan it as its own self-contained deliverable (it ships a usable token-scoped API even before the agent exists).

---

## Phase 3 — The agent itself — the smaller, content-heavy half

**Goal:** on top of Phase 2's surface, ship the operator. Net-new:
- **`folio_api(method, path, body, dryRun?)` tool** — the general primitive, registered in `lib/agent-tools-registry.ts` (the same registry Phase 1's `executeTool` dispatches). It's scoped at execution time by the delegate intersect Phase 1 built — so `folio_api` inherits the ceiling automatically. Mutating calls to high-risk resources route through the approval gate.
- **The `folio` skill** — workspace content (NOT hardcoded), the API/schema/conventions manual: the Phase 2 resource→route→scope table, frontmatter conventions, worked recipes ("set up a project", "author a view", "add a user"), the risk-gate protocol. **The governing principle (DECISIONS.md): the API is the source of truth; the skill merely documents it.**
- **2-layer memory** — volatile `memory.log` (recent timeline, decays) + curated `workspace_profile.md` (canonical truths). Rides the document primitive (reserved-slug docs). v1 = manual/agent-proposed promotion; auto-curation deferred. (Append-only memory rots by month 6 — that's why it's split.)
- **Seeded operator agent document** — every fresh instance born with it (body-as-prompt pointing at the skill + memory).

**Phase 3 prerequisites:**
- The **`awaiting_approval` gate** must be finished for the high-risk plan/apply tier. It's ~80% built (D-5 resume/reject half exists); the missing PAUSE side is `running → awaiting_approval` + a `request_approval` control tool. Plan: `docs/superpowers/plans/2026-05-30-phase-3.x-model-initiated-approval.md` (~1–2 days, Option A). **Only the high-risk tier needs it** — low/medium tiers (docs, reversible config) can ship without it by having the agent refuse high-risk actions until the gate lands.
- **Runner backend is DECIDED: API provider only** (see OP1-DECIDED above). Seed the operator with `provider: anthropic` (or another API provider), never `claude-code` — otherwise the Phase-1 ceiling is moot for it.

---

## Recommended next-session sequence

1. **Phase 2 first** (the agent is meaningless without the API surface). `writing-plans` + `threat-modeling`, ground-truth each resource, plan as a self-contained token-scoped-API deliverable. Extend `roleToScopes` with the new write scopes.
2. **Finish the approval-gate PAUSE side** (small, ~1–2 days) — needed for Phase 3's high-risk tier.
3. **Phase 3** — `folio_api` + skill + memory + seeded agent, riding everything Phase 1+2 built.

Each phase: `netdust-core:ntdst-execute-with-tests` (subagent-driven, two-stage review per task), then `/code-review high`, `/integration`, `/shakeout`, merge. Phase 1 proved the discipline catches real bugs late (the project-clamp leak survived green unit + two-stage review; only `/code-review` caught it) — do NOT skip the `/code-review` gate on these security-rich phases.

## Gates / commands reference (verified this session)
- Server tests: `cd apps/server && bun test` (1092 pass; run from INSIDE apps/server — root cwd fakes a ~650 cascade).
- Shared: `cd packages/shared && bun test` (63).
- Web: `cd apps/web && npx vitest run` (725, NOT bun test).
- tsc: per-app `bun x tsc --noEmit` (no root tsconfig).
- Migrations: new `.sql` MUST get a `meta/_journal.json` entry (silent-skip footgun).
- Main is LOCAL-ONLY (~784 ahead of origin, unpushed) — the project convention.
