# Orchestration Layer — Whole-Layer Audit + A→D Integration Review

_2026-06-02. A 4-auditor holistic review of Folio's agent orchestration layer (~9,500 LOC, shipped) + whether the cross-workspace operator (Phases A→D) integrates with it. Requested by Stefan ("audit it as a whole; do A,B,C,D integrate well?")._

---

## Verdict

**The existing orchestration layer is SOUND and carries justified weight** — not over-built, not incoherent. **The A→D plans FIT-WITH-FRICTION** — two real defects would break the build if not corrected first.

### Existing layer (coherence + simplicity auditors)

- **"Inside === outside" is real in the code, at two layers.** `executeTool` (`agent-tools.ts:131`) has exactly 3 non-test importers: itself, `runner.ts:731`, `routes/mcp.ts:172`. Run creation funnels through one shared `createRunForParent` → `createRun` from the HTTP route AND the MCP `run_agent` tool. No transport re-derives auth.
- **Data model holds.** agent_run/agent/trigger are all `documents` rows; status/tokens/chain_id live in frontmatter JSON, mutated atomically in `txWithEvents`. The `runsTable` param exists only to satisfy the `documents` CHECK that agent_run rows carry a table_id — the model enforced, not bypassed.
- **Reaction plane is the strongest sub-system** — durable at-least-once, eager cursor-seed (closes F-4 boot race + F-6 replay stampede), re-entrancy latches, rollback-scrub for the bun-sqlite quirk. Failure-tested, not just specced.
- **Boot order is correct** (migrations → bootstrap → reconciler → dispatcher → poller). One benign nuance: `runBootTasks` is fire-and-forget so intervals can start before bootstrap completes (idempotent, harmless).
- **Seeded-bot reset is CLEAN** — grep for `seedOperator`/`folio_system`/`seedMemoryDocs`/`__folio_operator`/`0021`/`includeSystem` across the live tree returns ZERO. No remnants.
- **Chain/autonomy machinery is the one over-build, but JUSTIFIED.** `FOLIO_AGENT_CHAINS_ENABLED` defaults off, but the guards (`checkChainGuards`, depth, `emitChainSuppressed` at 5 sites) RUN on every v1 run (pass trivially at depth=1); they must exist + be tested before the flag flips, or flipping ships an unguarded fan-out. Keep all of it.

### A→D integration (runner-fit + trigger-fit auditors)

**Two MERGE-BLOCKER plan defects** (real, file:line-evidenced):

1. **Phase B: the run-CREATE agent resolution is never changed → a library agent is un-runnable (the seeded-bot failure mode again).** Phase B Task 3 changes `loadContext` resolution to `home ∈ {ws, __system}`, but the agent doc is gated EARLIER, at the create paths, which still hard-code `eq(documents.workspaceId, ws.id)`:
   - HTTP: `routes/runs.ts:362-368` → 404 `AGENT_NOT_FOUND` for a `__system` agent.
   - MCP: `agent-tools-registry.ts:1660-1664` → same 404.
   Phase B Task 7 wrongly assumes "the run-create path already resolves the agent." It does not. **Fix: add a Phase-B task (between T2 and T7) porting the home-predicate to BOTH create-path resolution sites** — the human-path analogue of Phase C's `resolveTriggerAgent`. Without it, an implementer ships green unit tests + a 404 at the real run (exactly the "10 green tasks that never ran the agent" trap).

2. **Phase C: Task 3.5 stamps `frontmatter.unattended` but omits the schema edit + the executeTool threading → every fired run 500s, and the floor can't be read.**
   - `createRun` runs `agentRunFrontmatterSchema.parse(runFm)` under `.strict()` (`agent-runs.ts:227`) — an unschema'd `unattended` key THROWS. Task 3.5's file list omits `agent-run-schema.ts`. **Fix: add `unattended: z.boolean().optional()` to the schema (mirror Phase B Task 1's `agent_home_workspace_id`).**
   - The `folio_api` write handler can't see `unattended`: `ToolContext` (`agent-tools.ts:25`) carries only token/actor/tx/callerScopes, NOT run frontmatter. The plan hand-waves "thread it through how ctx carries run state" — but ctx does NOT carry run state. **Fix: thread `unattended` the same way `caller_scopes` is threaded — extend `executeTool`'s caller param + `ToolContext`, pass `fm.unattended` at `runner.ts:389` (next to `fm.caller_scopes`), read in the handler. This touches the central executeTool gate (an invariant convergence point) — flag for /code-review.** Task 3.5's file list must add `agent-tools.ts` + `runner.ts`.
   - Minor: the `unattended` discriminator should key off `triggerId !== null && !resumeOf` (a clean signal already on `CreateRunInput`), NOT off `firedBy` (a free-form provenance string). The plan's stated derivation is imprecise.

**Clean fits (confirmed, no change needed):** `intersectAgentProjects(['*'], ...)` already supports "agent defers" (B5, zero change to agent-projects.ts); BYOK-by-run-workspace already resolves B's key (B6, zero change); the additive frontmatter fields are clean under `.strict()` once the schema edits land; Phase A's `ensureOperatorAgent` → `createDocument` auto-mints the agent token, directly closing the prior operator-can't-run bug; the trigger-matcher's 3 sites + autonomy-gate ordering are as Phase C's (corrected) plan says.

**One plan-framing correction:** Phase C's "3 parallel resolution sites" is really 2 patterns — `handleInternalAction` resolves a slug-for-run-lookup, not an agent doc; the shared `resolveTriggerAgent` is consumed two ways (doc for create, slug for lookup). Workable, but the framing oversimplifies.

---

## Punch list

### Plan-corrections (do BEFORE building B/C — they're merge-blockers)
- [ ] **PC-1 (Phase B):** add a task porting `home ∈ {ws, __system}` to the run-create agent resolution at `routes/runs.ts:362` + `agent-tools-registry.ts:1660` (the human-invocation analogue of `resolveTriggerAgent`). Without it the library operator 404s at run-create.
- [ ] **PC-2 (Phase C):** Task 3.5 — add `agent-run-schema.ts` (`unattended: z.boolean().optional()`) + `agent-tools.ts` (`ToolContext`/`executeTool` threading) + `runner.ts` (pass `fm.unattended`) to the file list; key the discriminator off `triggerId !== null && !resumeOf`.

### Cheap consolidations (optional, low-risk, NOT blocking)
- [ ] Provider enum literal redeclared 6× (drifts on `claude-code`) → derive from `providerSchema.options` (`agent-run-schema.ts:66`); kill 5 copies.
- [ ] Runner depth COUNT (`runner.ts:443`) duplicates fanout in `checkChainGuards` → one query.

### Deferred ergonomics (no debt, do at next-touch)
- [ ] Extract provider-health (`agent-runs.ts:1265-1545`) → `provider-health.ts` (the one clean seam in the run god-file).
- [ ] Optionally split agent-lifecycle/run tools out of `agent-tools-registry.ts`.

### Do NOT touch (justified weight)
- Chain/autonomy machinery (safety pre-commitment, partially live).
- `agent-runs.ts` beyond the provider-health extraction (cohesive single-table data layer).
- `openrouter.ts` (non-duplicate — auth-divergent `testKey`).
- `executeTool` (the mandated single dispatch/auth convergence point).

### Stale memory (non-architectural)
- [ ] `project_folio-api-inprocess-no-token-mint` already updated this session to the mint-and-revoke reality — confirm the note reads correctly (the code won that argument; the original no-mint claim is dead).

---

## Bottom line

The orchestration layer is a mature, coherent, well-tested system — the churn across Phase 3 A–F + operator OP-1/2 did NOT rot it. The cross-workspace operator A→D is the right shape and mostly integrates cleanly, BUT two plan defects (the un-runnable library agent at run-create, and the unattended-floor schema/threading gap) must be corrected before the B/C build sessions, or they reproduce the seeded-bot "green tests, 404 at the real run" failure. Both fixes are localized and named with file:line. With PC-1 + PC-2, A→D integrates well.
