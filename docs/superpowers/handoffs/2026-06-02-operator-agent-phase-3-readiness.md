# Operator Agent — Phase 3 Readiness Handoff

_Written 2026-06-02, after Phase 2 (token-scoped config write surface + dryRun) was built, `/code-review high`'d (all findings fixed + re-reviewed), and `/integration`-gated green. Phase 2 lives on branch `fix/token-mint-scope-ceiling`, **NOT yet merged to main**._

---

## 🎯 READ FIRST

- **The Phase 3 plan to execute:** `docs/superpowers/plans/2026-06-01-operator-agent-phase-3-the-agent.md` (10 tasks, full threat model P3-1…P3-10, **already corrected** — see "Plan corrections baked in" below). It is build-ready.
- **The spec (the why):** `docs/superpowers/specs/2026-06-01-builtin-folio-operator-agent-design.md`.
- **The governing decisions:** `memory/DECISIONS.md` — "Operator agent runs on an API provider only", "Operator agent Phase 2 — one config:write scope", "Agent modes — the taxonomy + the v1 boundary".
- **Auto-memory to load:** `project_builtin-operator-agent`, `project_folio-tools-as-primitives`, `project_folio-agent-thesis`, `project_folio-api-inprocess-no-token-mint`, `project_phase-op-2-on-fix-branch`, `feedback_redact-at-the-loader-not-the-handler`.

---

## Where the 3-phase build stands

The built-in Folio operator agent ("the OS for Folio") is a 3-phase build:

- **✅ Phase 1 — Caller-identity delegation — DONE + merged to local main** (`c32daa5`). An agent run carries the caller's authority; `effective = agent ∩ caller`, fail-closed, enforced centrally in `executeTool` (scope) + `loadContext` (project).
- **✅ Phase 2 — Token-scoped config write surface + dryRun — BUILT + reviewed, on `fix/token-mint-scope-ceiling`, NOT merged.** Details below.
- **⬜ Phase 3 — The agent itself (`folio_api`/`folio_api_get` + `folio` skill + 2-layer memory + seeded operator) — NOT started.** This handoff readies it.

---

## What Phase 2 delivered (the surface Phase 3 stands on)

Branch `fix/token-mint-scope-ceiling` (43 commits ahead of main, local-only). Gates: server **1139**/1-skip/0, shared **63**/0, web **742**/8-skip/0, tsc clean ×3, **no migration**.

**The config-write surface is now real and token-reachable:**
- **One new canonical scope `config:write`** (in `ALL_DOCUMENT_SCOPES`, `agent-schema.ts`), owner/admin-only via `roleToScopes` (members get only `documents:read|write` — they CANNOT delegate config:write). It IS mintable (`POST /tokens` accepts it for owner/admin), and the future `folio_api` tool maps to it via `CONFIG_WRITE_TOOLS` in `toolsToScopes`.
- **Four formerly-dead route guards now live:** `tables.ts`/`fields.ts`/`views.ts`/`statuses.ts` mutation routes were guarded on `tables:write`/`fields:write`/`views:write`/`statuses:write` — scope strings NO token could ever hold. All four retargeted to `requireScope('config:write')`. **Legacy back-compat:** `requireScope('config:write')` ALSO accepts a token carrying any of those four old scopes (`CONFIG_WRITE_LEGACY_ALIASES` in `middleware/bearer.ts`) — so pre-existing PATs keep working; no migration. The alias is structurally confined to `config:write` (security-reviewed, can't leak to other scopes).
- **Project routes** (`projects.ts` POST/PATCH/DELETE) gained `requireScope('config:write')` (they were scope-less-but-bearer-OK before). Workspace create/rename/delete in `workspaces.ts` STAY `requireSessionUser` (session-only — untouched).
- **Universal `dryRun` preview** on every config mutation: `{ dry_run: true, would, resource }` with **zero inserts and zero events**. Helpers in `lib/dry-run.ts`: `dryRunResult(verb, resource)`, `isDryRun(validatedJson)` (POST/PATCH, from the validated body), `isDryRunDelete(c)` (DELETE, from `?dryRun=true` query — the web DELETE client sends no body). The dryRun `resource` matches the live success `data` shape exactly (create wraps `{view: row}` etc. where the live route wraps).
- **Companion auth hardening** (`9f75c40`, Stefan): `POST /tokens` validates requested scopes against `roleToScopes(role)` — a member can no longer MINT a `config:write`/`agents:write`/`documents:delete` PAT (closes the escalation the new owner-only scope created).

**Threat model P2-1…P2-8 all hold** (verified by `/code-review`). The 6 review findings were a web-client coordination gap (CRITICAL — the mint ceiling 403'd the scopes the token-create UI still sent; fixed) + dryRun hygiene (flag leak, shape divergence, DELETE reader) — all fixed + re-reviewed APPROVED.

### Phase 2 follow-ups (in `tasks/retro-follow-ups.md`)
- OP2-F1 + OP2-F2: ✅ CLOSED (the two `/code-review` fix bundles).
- Nothing from Phase 2 blocks Phase 3.

---

## The keystone Phase 3 architectural decision (corrected — do NOT re-litigate)

**`folio_api` dispatches in-process HTTP by seeding `ctx.token` directly into the Hono request context — NOT by minting an ephemeral token.** (`project_folio-api-inprocess-no-token-mint`, decided 2026-06-01.)

The Phase 3 plan was FIRST written around an ephemeral-token mint mirroring `ccExecute` (runner.ts:881-895). **That was reversed.** `ccExecute` mints a real DB token ONLY because the `claude` CLI is an *out-of-process subprocess* that can't reach Hono's context and must send a real `Authorization` header for `attachToken` to re-resolve. `folio_api` runs *in-process* and already holds `ctx.token` — so it seeds `{ token: ctx.token, user, authMethod: 'token' }` into `app.request(...)`'s env arg, bypassing `attachToken`, and `requireScope`/`requireResource` read `ctx.token` exactly as for an external bearer. **No token minted, no per-call DB insert/delete, no credential to leak/revoke.** This DISSOLVES the original P3-1/P3-2/P3-3 mitigations (no token = nothing to mis-scope, leak, or fail to revoke) — strictly stronger. The plan's threat model is already retargeted.

> ⚠️ **VERIFY at Phase-3 Task 3 (plan-freshness gate):** confirm `app.request(path, { ... }, env)` actually accepts seeded context vars (`c.set('token', ...)` equivalent via the env arg) in this Hono version. Read how `app.request` is called in existing tests + whether Hono's `Env`/context-var seeding via the 3rd arg works as the plan assumes. If it does NOT, the fallback is the ephemeral-token mint (the `ccExecute` pattern) — but try the no-mint path first. This is the single load-bearing unknown in Phase 3.

---

## Plan corrections already baked into the Phase 3 plan

The Phase 3 plan reflects these decisions (locked with Stefan 2026-06-01) — do not re-discover:
1. **`folio_api` is SPLIT:** `folio_api_get` (reads, GET-forced, ungated beyond the token's read scope) + `folio_api` (writes, gated). Cleaner auto-vs-plan boundary.
2. **Memory = documents with frontmatter, hidden from the wiki overview.** Two reserved-slug `page` docs per workspace flagged `folio_system: true`. `listDocuments` excludes them by default (`includeSystem: true` opt-in for the agent's own reads). NOT a new table. Surfaceable in the sidepanel on demand.
3. **High-risk → REFUSE, but surface the dryRun plan/diff** (not a bare decline). The agent computes the dryRun, returns/posts the proposed plan, declines to apply. A `// TODO(approval-gate)` marks the exact spot for the later "refuse → pause" swap.
4. **Provider: API only** (`provider: anthropic`), never `claude-code` — so every `folio_api` call routes through `executeTool` and the Phase-1 ceiling actually constrains it (OP1-DECIDED; `claude-code` natively bypasses `executeTool` — see OP1-GAP in retro-follow-ups).

---

## Phase 3 prerequisites + carried obligations

- **The `awaiting_approval` PAUSE side is NOT built** (only resume/reject exists, from Phase-3 D-5). Phase 3 ships low/medium tiers + high-risk-refuse-with-plan; it does NOT need the pause side. Plan: `docs/superpowers/plans/2026-05-30-phase-3.x-model-initiated-approval.md` (~1-2 days, Option A) — the later upgrade. The refuse-with-plan TODO marks where it slots in.
- **Carried from Phase 1 (`tasks/retro-follow-ups.md`):** OP1-F7 (retry authority), OP1-F8 (chain re-derives caller — MANDATORY before `FOLIO_AGENT_CHAINS_ENABLED`), OP1-F9 (member project snapshot), OP1-GAP (claude-code bypasses the scope ceiling — out of the operator's path by the API-provider-only decision). **Phase 3 is turn-based ("task, report, done") and does NOT introduce fan-out, so F7/F8 stay deferred** unless Phase 3 adds chaining (it shouldn't).
- **`roleToScopes` is the human scope policy** (`agent-schema.ts`). If any FUTURE phase adds write scopes (users/views/settings beyond config), extend `roleToScopes`' owner/admin tier — Phase 3 adds NO new scope (it rides `config:write` + the existing document scopes).

---

## Architecture-invariants note (new this session)

`CLAUDE.md` gained rule #3: when a plan touches a convergence point (authorization, data access, live updates, error handling, entity modeling), cite it against `ARCHITECTURE-INVARIANTS.md`, and `/code-review`/`/shakeout` flag bypasses. **`ARCHITECTURE-INVARIANTS.md` does NOT exist yet** — authoring it (`/architecture-invariants audit`) is a cheap, high-value pre-Phase-3 step: Phase 3's `folio_api` is the single biggest authorization-convergence event in the codebase (one tool reaches every route), so naming the convergence points first would make its `/code-review` converge faster. Consider running `netdust-core:architecture-invariants` before or alongside the Phase 3 plan execution.

---

## Recommended next-session sequence

1. **First: finish Phase 2's tail** — run `/shakeout` on `fix/token-mint-scope-ceiling` (boot + a real "config:write token sets up a table/view, dryRun-previews, then applies" exercise; the `invariant-auditor` runs if `ARCHITECTURE-INVARIANTS.md` exists). Then **merge `fix/token-mint-scope-ceiling` → local main** (`--no-ff`). Phase 3 depends on the Phase-2 routes being on main.
2. **(Optional, recommended) Author `ARCHITECTURE-INVARIANTS.md`** via `netdust-core:architecture-invariants` — names the auth/data/event convergence points Phase 3's `folio_api` must route through.
3. **Execute Phase 3** via `netdust-core:ntdst-execute-with-tests` (subagent-driven, two-stage review per task). The plan is build-ready; verify the `app.request` context-seeding assumption at Task 3 (the one load-bearing unknown). Then `/code-review high` (threat model P3-1…P3-10 as input), `/integration`, `/shakeout` with a real Anthropic key (drive an actual "set up a project for me" run), merge.

## Gates / commands reference (verified this session)
- Server: `cd apps/server && bun test` (1139; run from INSIDE apps/server — root cwd fakes a ~650 cascade).
- Shared: `cd packages/shared && bun test` (63).
- Web: `cd apps/web && npx vitest run` (742, NOT bun test).
- tsc: per-app `bun x tsc --noEmit` (no root tsconfig).
- New `.sql` migration → MUST add a `meta/_journal.json` entry (silent-skip footgun). Phase 3 adds a backfill migration (seed operator into existing workspaces) — Task 8.
- ⚠️ After each subagent task, re-verify the branch (`git rev-parse --abbrev-ref HEAD`) — the auto-memory hook moved HEAD twice this session (`feedback_auto-memory-hook-switches-to-main`, `project_phase-op-2-on-fix-branch`).
- Main is LOCAL-ONLY (unpushed) — the project convention.
