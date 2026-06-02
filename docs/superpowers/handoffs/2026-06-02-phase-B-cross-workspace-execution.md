# Phase B — Cross-Workspace Execution — Execution Handoff

_Written 2026-06-02. Phase B is the security-critical heart of the cross-workspace operator: a `__system`-defined agent acting on a customer workspace B. **Phase A must be built + merged before this runs.** Phase C is being planned in the originating session in parallel — check for its plan._

---

## 🎯 READ FIRST

- **The plan to execute:** `docs/superpowers/plans/2026-06-02-phase-B-cross-workspace-execution.md` — **now 9 tasks (a Task 2.5 was ADDED 2026-06-02 by the orchestration-layer audit)**, threat model **B1–B10** inline, four pre-dispatch review fixes baked in. Build-ready.
- **⚠️ AUDIT CORRECTION (PC-1, 2026-06-02 — read `docs/superpowers/retros/2026-06-02-orchestration-layer-audit.md`):** the plan originally MISSED that the run-CREATE agent resolution (`routes/runs.ts` + the MCP `run_agent` tool) hard-codes the run's workspace, so a `__system` library agent would 404 BEFORE `loadContext` — the operator would be un-runnable (the seeded-bot failure mode). **Task 2.5 now fixes this** (port the `home ∈ {ws, __system}` predicate to both create-path resolution sites). Do NOT skip it — it's the load-bearing fix that makes the library operator actually runnable via human invocation.
- **PREREQUISITE:** Phase A (`__system` library foundation) MUST be merged. Phase B resolves agents whose home is `__system` and reads skills from it — `getSystemWorkspaceId`, the `Skills` project, and the operator agent all come from Phase A.
- **The governing spec (the why):** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` — Components 3 + 4.
- **Auto-memory to load:** `project_operator-is-an-agent-not-a-seeded-bot` (WHY the model is what it is — read first), `feedback_state-consequences-and-dont-flatter` (how Stefan wants design questions), `project_folio-api-inprocess-no-token-mint` (the kept tool surface), `feedback_holistic-review-catches-cross-task-bugs` (the final review is what caught the seeded-bot operator being unrunnable — don't skip it), `feedback_verify-subagent-test-counts`.

---

## The one-paragraph model (don't re-derive)

The operator is an AGENT with the outside-agent's caller-bounded cross-workspace reach. An agent is a reusable DEFINITION in `__system`; a RUN carries the TARGET workspace B and acts on B's data. Phase B makes that real: resolve the agent by id gated by `home ∈ {run-ws, __system}` (the security boundary — no cross-tenant capability borrowing); materialize the agent's prompt + frontmatter-named skills via a NARROW definitional system-read (not caller-bounded, internal-only); derive the run's authority SOLELY from the caller in B (the agent side defers `['*']`); use B's BYOK key never `__system`'s; refuse HIGH actions regardless of caller; list library agents in every workspace's run/assign UI.

---

## What Phase B builds (8 tasks)

- **T1** — `getSystemWorkspaceId(db)` helper + `agent_home_workspace_id: z.string().optional()` on the run frontmatter + ground-truth (createRun signature, the web agent-listing surfaces, id-stability).
- **T2** — `createRun` stamps `agent_home_workspace_id` SERVER-SIDE (from where the agent resolved: B or `__system`), never from input (B2/B8).
- **T3** — `loadContext` resolves the agent by `home = fm.agent_home_workspace_id ?? run.workspaceId`, asserts `home ∈ {run.workspaceId, systemId}` (fail-closed), resolves by `(home, type='agent', slug)` (B1). **The security boundary.**
- **T4** — `loadAgentDefinition` (narrow definitional read: agent body + frontmatter-named Skills docs ONLY, internal-only, not a tool) (B3/B4/B9) **+ Step 0: verify/add the API-provider injection fence to parity with the cc path** (B10a — a dependency, not an assumption).
- **T5** — library-agent authority DEFERS to the caller (`intersectAgentProjects(['*'], callerProjectIds)` when home===systemId); BYOK = B's key, no `__system` fallback (B5/B6).
- **T6** — confirm + pin the interim HIGH-refuses-regardless-of-caller floor (B7) — mostly a guard test on the kept `folio_api`.
- **T7** — list `__system` library agents in every workspace's run/assign UI (badged `library:true`). **Least-specified — ground-truth the web surface in T1 first.**
- **T8** — integration gate + **MANDATORY real-key shake-out**: (Step 2) a real cross-workspace operator run, (Step 2b) the **MEDIUM/LOW prompt-injection shake-out** (merge-blocker), (Step 1b) the B8 direct-createRun membership test.

---

## Fixes baked in (do NOT re-discover — in the committed plan `aa03906`)

Stefan's pre-dispatch review caught 4; all corrected:

1. **Prompt-injection MEDIUM/LOW is B10.** The HIGH floor covers HIGH only; MEDIUM (config writes) + LOW (doc writes) are injection-reachable within the caller's authority. The operator runs on the API-provider path, whose injection defense is per-message role separation — the explicit BEGIN/END DATA fence is `ccExecute`-only (`runner.ts:905-918`). T4 Step 0 makes bringing the API path to fence PARITY a Phase-B dependency; T8 Step 2b is a mandatory adversarial injection shake-out (seed B content telling the operator to delete a doc/alter a table → must refuse) — a MERGE-BLOCKER if it fails.
2. **B8 is enforced SERVER-SIDE, not the UI.** `createRun` already fails loud if the caller has no membership in the run's workspace (Phase-1 "Finding 6", `agent-runs.ts:163-180`). T8 Step 1b pins it with a direct-createRun test. The UI listing (T7) is a convenience surface, NOT the boundary.
3. **`agent_home_workspace_id` is `.optional()` everywhere** (no schema-vs-task contradiction): existing runs validate; `loadContext` treats absent as `home = run.workspaceId` (local agent, backward-compatible). No migration.
4. **T7 documents that every `__system` agent is instantly customer-invokable on save** (fine for the single operator). A `frontmatter.published` filter is the marked one-edit future fix for a non-public agent (OP-LIB-1 follow-up). Don't add the flag now; do leave the `// TODO(library-visibility)` marker.

---

## Ground-truth verified this session (build to this, not assumptions)

- `loadContext` (`runner.ts:281+`) resolves the agent by `(run.workspaceId, type='agent', fm.agent_slug)` — the hard-coded workspace binding T3 replaces. It then resolves the agent token by `agentId`, narrows projects via `intersectAgentProjects(token.projectIds ?? ['*'], callerProjectIds)` (T5 changes the agent side to `['*']` for library agents), resolves BYOK by `run.workspaceId` (T5 confirms = B).
- `createRun` lives in `services/agent-runs.ts`; it already derives `caller_scopes`/`caller_project_ids` from the actor's membership in `workspace.id` and **fails loud if the actor isn't a member** (Finding 6, lines 163-180) — that IS the B8 control.
- The run frontmatter (`agent-run-schema.ts:74`) has `agent_slug: z.string().regex(/^[a-z0-9-]+$/)` + the Phase-1 caller snapshot. It does NOT yet have `agent_home_workspace_id` (T1 adds it, optional).
- The injection fence (`runner.ts:905-918`) is `ccExecute`/claude-code ONLY; the API-provider path relies on role separation — T4 Step 0 verifies/adds parity.
- The trigger-matcher (`trigger-matcher.ts:230,321`) resolves agents by `eq(documents.workspaceId, workspaceId)` — Phase B does NOT touch this (it's Phase C: cross-workspace triggers).

---

## How to execute

1. **Load `ntdst-execute-with-tests`** (CLAUDE.md rule #1). Subagent-driven, tasks 1→8 in order (they build a shared surface in `runner.ts`/`agent-runs.ts` — don't parallelize). Two-stage review per task; the threat model (B1–B10) is the `/code-review` convergence target.
2. **Per task:** ground-truth the dependency surface (Step 2.5 gate) before each dispatch — `loadContext`/`createRun`/`agent-projects`/the web surface have changed since Phase 1; read live. Append the netdust addendum verbatim.
3. **T4 Step 0 + T8 Step 2b are the load-bearing security work** — verify the injection fence + run the real adversarial injection shake-out. The seeded-bot attempt shipped 10 green tasks that NEVER ran the agent; the final holistic review caught that the operator couldn't even run. Do NOT repeat that — T8's real run + injection case are mandatory, not optional.
4. **After T8:** `/code-review high` (B1–B10 + confirm Phase-1/folio_api/Phase-A not weakened), `/integration`, `/shakeout` (the real run + injection case + the `invariant-auditor` against `ARCHITECTURE-INVARIANTS.md` invariants 2/3/4/10), merge.

## Gates / commands (verified this session)

- Server: `cd apps/server && bun test` (run from INSIDE apps/server — root cwd fakes a ~650 cascade). Shared: `cd packages/shared && bun test`. Web: `cd apps/web && npx vitest run` (NOT bun test).
- tsc: per-app `bun x tsc --noEmit`.
- A real-key shake-out needs an Anthropic key on a dev instance (the operator is `provider: anthropic`). Drive via the composed loop (poller + runner) or the `diagnose-http-chain.ts` harness pattern.
- ⚠️ Re-verify the branch after each subagent task (`git rev-parse --abbrev-ref HEAD`) — the auto-memory hook has moved HEAD to main before.
- Branch is `phase-op-3/the-agent` (kept surface + spec + Phase A/B plans). Main is LOCAL-ONLY. The cross-workspace build merges to main when coherent (after Phase B at the earliest; possibly after C).
- **Phase B adds NO `.sql` migration** (the run-frontmatter field is JSON, the optional schema field needs no migration; `__system` is from Phase A). If you reach for a migration, STOP and re-read.

## Pointers

- Plan: `docs/superpowers/plans/2026-06-02-phase-B-cross-workspace-execution.md`
- Spec: `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Components 3, 4)
- Phase A plan/handoff: `docs/superpowers/plans/2026-06-02-phase-A-system-library-foundation.md`, `docs/superpowers/handoffs/2026-06-02-phase-A-system-library-execution.md`
- Kept tool surface: `apps/server/src/lib/folio-api-tool.ts`
- Carried follow-ups (`tasks/retro-follow-ups.md`): OP3-F1 (medium-tier dryRun default — confirm at B's `/evaluate`), OP-LIB-1 (library-agent visibility flag — log at T7).
