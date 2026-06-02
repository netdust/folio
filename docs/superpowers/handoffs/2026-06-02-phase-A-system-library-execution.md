# Phase A — System Library Foundation — Execution Handoff

_Written 2026-06-02. The operator-agent work was REBUILT on a corrected model this session (the per-workspace "seeded bot" was wrong, reset + archived). This handoff readies the FIRST phase of the new model for a fresh execution session. Phase B is being written in the originating session in parallel — check for its plan before assuming A is the only plan._

---

## 🎯 READ FIRST

- **The plan to execute:** `docs/superpowers/plans/2026-06-02-phase-A-system-library-foundation.md` — 8 tasks, threat model M1–M8 inline, **five pre-dispatch review fixes already baked in** (see "Fixes baked in" below). Build-ready.
- **The governing spec (the why):** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` — the whole cross-workspace model (Components 1–4, phasing A→D). Phase A implements Components 1 + 2 only.
- **Auto-memory to load:** `project_operator-is-an-agent-not-a-seeded-bot` (WHY the reset happened — read this first), `project_folio-api-inprocess-no-token-mint` (mint-and-revoke, the kept tool surface), `feedback_state-consequences-and-dont-flatter` (how Stefan wants design questions framed), `feedback_drizzle-migration-journal`, `project_server-fullsuite-init-cascade` (run server tests from INSIDE apps/server).

---

## Where the build stands

The cross-workspace operator is a **4-phase** build (spec phasing A→D):

- **✅ KEPT — the `folio_api` tool surface** (the operator's CAPABILITIES). On branch `phase-op-3/the-agent`, green: `folio_api`/`folio_api_get` + `validateApiPath` + `classifyRisk` + `dispatchAsCaller` (mint-and-revoke, caller-bounded). 1171 server tests, 0 fail, tsc clean. This is what a library agent USES; it already spans workspaces if the caller can.
- **⬜ Phase A — System library foundation — NOT started.** This handoff. Bootstrap `__system`, owner designation, Skills/Reference projects, the `folio` skill + reference docs, the operator agent. NO cross-workspace execution change.
- **⬜ Phase B — Cross-workspace execution.** Being planned in the originating session now.
- **⬜ Phase C — Cross-workspace triggers. ⬜ Phase D — Library curation UI.**

**What was DROPPED (archived at tag `archive/phase-op-3-seeded-bot`):** the per-workspace `seedOperator` + hidden `folio_system` memory pages + the first-project hack + the TOCTOU race + the SQL backfill (migration 0021) + the parity test + the standing-token mint. All the wrong "seeded bot" model. Do NOT resurrect any of it. The `folio` skill BODY + `OPERATOR_PROMPT` from that work are a reusable STARTING POINT for Phase A Task 3 (the content was reviewed; the delivery mechanism was wrong).

---

## The model in one paragraph (so you don't re-derive it)

The operator is an AGENT with the outside-agent's caller-bounded cross-workspace reach + skills + reference docs — NOT a seeded bot. One `__system` library workspace holds skills/agents/triggers as ordinary documents. An agent is a reusable DEFINITION; a run carries the TARGET workspace and acts on its data (that's Phase B). Phase A just stands up the library + its owner + the seeded content/operator, all behind normal membership (the cross-workspace execution + the definitional skill-load exemption are Phase B).

---

## Phase A scope (what this plan builds)

1. **`__system` reserved workspace** — underscore-prefixed slug (a reserved namespace users can't create: the workspace create/rename regex `^[a-z0-9-]+$` already blocks underscores; the plan adds an explicit `isReservedSlug` reject as defense-in-depth). Created once at boot, idempotent, **provenance-asserting** (fails loud on a tainted pre-existing `__system`).
2. **Instance-owner = `__system` membership.** Designated on ANY install age: fresh-install gated first-registration (`FOLIO_ALLOW_BOOTSTRAP_REGISTRATION`) OR existing-install `FOLIO_INSTANCE_OWNER=<email>` promote. Both idempotent.
3. **`Skills` + `Reference` projects** in `__system`; the `folio` skill + "set up a project" reference seeded as `page` docs.
4. **The operator agent** — a normal `type='agent'` doc in `__system` (provider `anthropic`, the kept tool whitelist), seeded at OWNER-DESIGNATION (it needs a user actor for its auto-minted token's `createdBy`), NOT at pure boot.

**NOT in Phase A (explicitly Phase B):** cross-workspace agent resolution, the definitional skill-load exemption, library agents listed in other workspaces' UI, the interim HIGH-tier-refuses-regardless-of-caller rule.

---

## Fixes baked in (do NOT re-discover — they're in the plan already)

Stefan's pre-dispatch review caught 5 gaps; all are corrected in the committed plan (`3e5165a`):

1. **Reserved-slug guard asserts the FINAL resolved slug, BOTH branches** (explicit + auto-slugify), not just the explicit path. Doesn't rest on "slugify never makes underscores."
2. **`grantOwner` + `ensureOperatorAgent` are split, each independently idempotent** — a mid-failure re-run repairs the missing piece instead of the agent-seed being stranded behind the owner no-op. `designateInstanceOwner` is a thin orchestrator calling both.
3. **Bootstrap FAILS LOUD (`SYSTEM_WORKSPACE_TAINTED`) on a pre-existing `__system` carrying ANY membership** — never adopts-and-repairs (an adopted foreign membership = silent instance-admin escalation). Matches threat model M4 exactly.
4. **Operator agent uses a DERIVED slug via `createDocument`** (`slugify(title)` → `folio-operator`; no caller slug, underscores stripped) — identified by `(workspace=__system, type='agent')`, NOT a `__`-prefixed doc slug. Keeps the auto-minted-token path (no hand-rolled token — that was the seeded-bot bug).
5. **Lean on the `workspaces.slug` UNIQUE constraint** as the real bootstrap idempotency backstop, not just the TOCTOU-racy findFirst guard.

Ground-truth verified this session: `workspaces.slug` is `.notNull().unique()`; `slugify` does `.replace(/[^a-z0-9]+/g, '-')` (can't emit `_`); `createDocument` derives the doc slug from `slugify(title)` (does NOT accept a caller slug); `requireResource` early-returns for `!token.agentId` (human PAT bypass); workspace create/rename are `requireSessionUser` (agents can't reach them).

---

## How to execute

1. **Load `ntdst-execute-with-tests`** (CLAUDE.md rule #1). Choose `subagent-driven-development` (the tasks are mostly sequential on `system-workspace.ts` but two-stage review per task is the point). Dispatch tasks 1→8 in order — they build a shared file (`system-workspace.ts`) so DON'T parallelize.
2. **Per task:** ground-truth the dependency surface (Step 2.5 gate) before each dispatch, append the netdust addendum verbatim, two-stage review (spec then quality). The threat model (M1–M8) is the `/code-review` convergence target.
3. **The one real implementation decision** (already resolved in the plan, just confirm): the boot-time actor for the operator agent's token. Resolution: structure + content at boot (`createdBy: null` — confirm `documents.created_by` is nullable, it is), operator AGENT at owner-designation (real actor). The plan's Task 4/5 split encodes this.
4. **After Task 8:** `/code-review high` (M1–M8 as input), `/integration`, merge to the branch tip. NO `/shakeout` for Phase A (no real-key agent run yet — that's Phase B).

## Gates / commands (verified this session)

- Server: `cd apps/server && bun test` (1171 currently; run from INSIDE apps/server — root cwd fakes a ~650 cascade).
- Shared: `cd packages/shared && bun test` (63). Web: `cd apps/web && npx vitest run` (742, NOT bun test).
- tsc: per-app `bun x tsc --noEmit`.
- ⚠️ After each subagent task, re-verify the branch (`git rev-parse --abbrev-ref HEAD`) — the auto-memory hook has moved HEAD to main before (`feedback_auto-memory-hook-switches-to-main`).
- Branch is `phase-op-3/the-agent` (the kept tool surface + the spec + the Phase A plan live here). Main is LOCAL-ONLY (unpushed) — project convention. The branch is NOT merged to main yet (the whole cross-workspace build merges when it's coherent — likely after Phase B at the earliest).
- Phase A adds NO `.sql` migration (no schema change — `__system` is a normal workspace row, instance-owner is a normal membership). If you find yourself writing a migration, STOP — re-read the model (reserved-slug-not-marker-column was a deliberate decision).

## Pointers

- Spec: `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md`
- Plan: `docs/superpowers/plans/2026-06-02-phase-A-system-library-foundation.md`
- DECISIONS: `memory/DECISIONS.md` ("Operator agent Phase 3 …" entry — note the no-mint reversal; the cross-workspace model supersedes the seeded-bot entry, capture it at Phase A `/evaluate`).
- The kept tool surface: `apps/server/src/lib/folio-api-tool.ts` (+ its test).
