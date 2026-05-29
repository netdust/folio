# Sub-phase D — Readiness Handoff (Routes + MCP parity + real tools)

**Branch:** `phase-3/agent-runner`
**HEAD at handoff:** `c8e0dc5` (STATE tick after the C.3 retro)
**Test baseline:** server **874 pass / 1 skip / 0 fail** · shared **53 / 0** · web 559/8/0 (untouched since C). tsc clean for touched files.
**`.last-integration`:** `cad6443` · **`.last-evaluate`:** `3bd6c57` (both advance at D close).

Sub-phase C (the agent runner core) is COMPLETE: A (foundation) ✅ · B (provider + AI keys) ✅ · C.1 (services) ✅ · C.2 (runner C-7/C-8/C-9) ✅ · C.3 (Reaction Plane C-10a/C-10b/C-11/C-12) ✅. **D wires HTTP routes + MCP parity + the REAL tools on top, and turns on the keystone demo.** This is a **readiness** handoff — D is NOT yet planned to executable depth. The next session's FIRST job is to expand the D task bodies (with reconciliation), not to dispatch them.

---

## ⛔ STOP — do these two things BEFORE any D code

### 1. Run the C-13 manual smoke first (it was never run — C.3 closed on unit gates only)

C.3's `/integration` + `/code-review` + `/evaluate` all passed on the **unit** suite. The C-13 plan lists a **manual dev-server smoke** ("the first 'agent does work' moment") that has NOT been executed — no UI/dev-server pass happened this session. Run it before building D, because it's the cheapest possible end-to-end proof that the Reaction Plane composes against a live server:

- Boot the dev server, configure an Anthropic key (Sub-phase B settings UI), assign a `work_item` to an agent.
- Watch: `agent.task.assigned` → dispatcher matches `builtin-on-assignment` → a `planning` run appears in the runs table → the poller claims it ~1s later → `runAgent` streams. **Only `__echo` is registered (C-7 skeleton), so the LOOP runs end-to-end but no real tool work happens** — that's expected; real tools are D-3.
- Autonomy-gate smoke: with `FOLIO_AGENT_CHAINS_ENABLED` unset (default false), an **agent-posted** @mention produces zero runs + one `agent.chain.suppressed`; set it true + restart → one run fires.
- (optional) Reactor-halt smoke: temporarily make the matcher throw on a seeded event → one `reactor.halted` on the bus, cursor stops advancing; revert → `reactor.recovered`.

If the smoke surfaces a wiring bug the unit tests didn't (boot order, interval not starting under `NODE_ENV !== 'test'`, an SSE-delivery gap), fix it as a C.3 follow-up BEFORE starting D. If it's clean, note that in STATE and proceed.

### 2. EXPAND + RECONCILE the Sub-phase D plan before dispatching (the recurring trap)

The Sub-phase D task bodies in `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` (§"Sub-phase D — Routes + MCP parity + admin stats", ~line 4486) are **OUTLINE-ONLY** — header + `Files:` + `Scope:`, NO `Steps`/`Tests`/`Commit`. Dispatching a subagent against an outline is the exact failure mode the C-section audit caught (handoff `8beec5e`). **A plan-correction commit must expand D-1..D-8 to executable bodies (same per-task format as C.1/C.2/C.3) BEFORE any subagent dispatch.**

**Stale-symbol reconciliation (MANDATORY — the D outlines predate C-7's rename).** The D outlines reference names that NO LONGER EXIST:
- `lib/mcp-dispatch.ts` → is now **`lib/agent-tools.ts`** (shipped C-7, commit `2825181`).
- `executeMcpTool(name, args, ctx)` → is now **`executeTool(token, actor, name, args, tx?)`** with a plain `{token, actor}` auth context (NO `McpAuthContext` type). Inside-agent === outside-agent: the runner calls `executeTool` directly; MCP is one *face* over it.
- `registerTool(def)` already exists in `agent-tools.ts` (C-7 Step 4) with the shape `{name, schema: ZodObject, requiredScope: Scope, handler}`. D-3 fills the real tool bodies via `registerTool`.
- Only `__echo` is registered today (gated on `NODE_ENV==='test'`). `routes/mcp.ts` is NOT yet refactored to route through `agent-tools.ts` — that IS D-3.

**Apply the project plan-freshness rule (now skill-codified):** `netdust-core:ntdst-execute-with-tests` **Step 2.5** requires the controller to ground-truth each D task's named dependencies against live source before writing its dispatch. For D specifically: read `lib/agent-tools.ts` (executeTool + registerTool + the `__echo` shape), `routes/mcp.ts` (the existing 20+ tool implementations to migrate + their per-tool guards), `services/agent-runs.ts` (transitionRun / createRun / getActiveRun / getPendingApprovalRun / rejectRun / runAgentResume), and the run-cancel path (`kind=cancel` comment, mitigation 44) BEFORE expanding the bodies. The spec is `docs/superpowers/specs/...` §4g/§4i (routes + MCP tool specs).

**D needs its own threat-model extension** (the plan says so at mega-plan line 421): "D's HTTP + MCP-parity surface gets a SEPARATE threat-model extension at D-plan-write time. The attack classes are different (DELETE /runs/:id auth, MCP run-tools scope, admin-stats PII)." Per CLAUDE.md rule 2, invoke `netdust-core:threat-modeling` when writing the D plan — it touches auth/token surfaces, untrusted tool-call args, and outbound-on-behalf-of-agent. The C threat model (mitigations 23–53) is the inheritance baseline; D extends with 54+.

---

## What Sub-phase D delivers (8 tasks, outline at mega-plan ~4486)

| Task | Outline scope | Watch-out |
|---|---|---|
| **D-1** | `routes/runs.ts` — list/get/create/cancel/retry + `GET /provider-health`. cancel → `transitionRun(failed, error_reason='cancelled')`; retry → `createRun(firedBy:'retry-of:<id>')` + 409 if `getActiveRun` non-null. | **C.1-R-1 lands here:** if D adds `DELETE /runs/:id`, decide the `events.document_id` FK cascade (FK `ON DELETE SET NULL` vs LEFT-JOIN guard in `checkProviderHealth`) — an individual run-delete currently orphans health events. cancel uses `kind=cancel` comment (mitigation 44) so the runner has ONE check path. |
| **D-2** | Migrate ALL existing MCP tools into the `agent-tools.ts` registry via `registerTool`. | This is the **real `TOOLS` extraction** deferred from C-7. Target is FEW GENERAL primitives (`read`/`query`/`write_document` on schemaless frontmatter) + skills-as-content, NOT 40 narrow verbs (`memory/project_folio-tools-as-primitives.md`). |
| **D-3** | Refactor `routes/mcp.ts` to a thin JSON-RPC wrapper over `executeTool`. Zero external behavior change. | **C.2-R-1 (mitigation 27) lands here:** the real per-tool agent-lifecycle guards (allow-list widening on create/update via `assertAgentAllowListWidening`; self-delete rejection anchored to `existing.id === token.agentId`; `get_agent_self` token-anchored) move into `agent-tools.ts`, anchored to `token.agentId` NOT a caller-supplied actor. The deferral comment in `executeTool` is the landing pad. **C.2-R-2 also lands here:** redesign tool-error handling — feed a tool error back to the model as a `{role:'tool'}` message instead of terminating the run; needs a plan-correction (diverges from the locked terminal-on-tool-error spec) + an infinite-retry guard + its own review loop. |
| **D-4** | 5 new MCP tools: `list_runs / get_run / run_agent / cancel_run / retry_run`. HTTP-twin parity. | One parity test per route×tool pair (Appendix B). |
| **D-5** | Wire `builtin-on-approval` / `builtin-on-rejection` to the runner. | Fills the matcher's `internal_action` STUBS (C-11 shipped log+no-op). resume_run → `getPendingApprovalRun` → new `planning` row with `frontmatter.resume_of` + inherited `chain_id` (poller picks it up). reject_run → `rejectRun(runId)`. Mitigation 43 (first-COMMIT-wins) race resolution already lives in `transitionRun` (C-9), works identically async. The matcher's `matchesFilter` already routes `{kind:'approval'|'rejection'}`; D-5 only fills the two handler bodies. |
| **D-6** | `routes/admin-runner-stats.ts` — `GET /admin/runner-stats` → `{pending_count, active_count, recovered_today}`. Admin-only, no MCP twin. | Threat-model: admin-stats PII — return counts only, no tenant content. |
| **D-7** | SSE filter params `?agent=` + `?table=` (AND-combined with existing `?parent=`/`?run=`). | Used by E-3/E-4 (web). |
| **D-8** | Integration gate: full suite + HTTP↔MCP parity per Appendix B + smoke (POST /runs → row → completes; cancel → exits; retry → new row, original preserved). | Then `/code-review --base=<C.3 close> --effort=medium` (name the D threat-model mitigations) → sibling-site audit → `/evaluate`. |

---

## Carried obligations landing in D (from `tasks/retro-follow-ups.md` — read it)

- **C.1-R-1** (D-1) — `events.document_id` FK cascade decision when `DELETE /runs/:id` lands.
- **C.2-R-1 / mitigation 27** (D-3) — real per-tool agent-lifecycle guards, token-anchored. MUST be carried explicitly in the D-3 task body + the D threat-model extension or it's lost between sub-phases.
- **C.2-R-2** (D-3) — tool-error-feedback redesign (diverges from locked spec; needs plan-correction + retry guard + review loop).
- **C.2-R-3** — RESOLVED by C.3 for trigger-created runs (owner = originating human via `event.actor`, or human PAT's `createdBy` per `ed0d009`). Remaining: the pre-export `transitionRun` null-materialization cleanup (`error_reason:null`/`worker_started_at:null` fail strict parse — housekeeping before the MD-export wedge).
- **C.3-R-1 / C.3-R-2** — autonomy-work obligations (suppressed-event idempotency; `isAgentOriginated` run_id false-positive). NOT D unless the autonomy flag is turned on in D. Both unreachable/low-harm in V1.
- **C.3-R-3 / C.3-R-4** — efficiency (per-event cursor persist; matcher N+1). Revisit under load, not D-blocking.
- **C.1-R-3** — housekeeping: `tasks/todo.md` C-section is stale; UPDATE or RETIRE.

## Mandatory skill activation order (D session)

1. `superpowers:using-superpowers` (explicit first turn).
2. **Plan-writing first** (D is not expanded): `superpowers:writing-plans` + `netdust-core:threat-modeling` (CLAUDE.md rule 2 — D hits auth/token/untrusted-args surfaces). Produce the expanded D-1..D-8 bodies + the D threat-model extension as a plan-correction commit. Reconcile stale symbols per §2 above.
3. THEN execution: `netdust-core:ntdst-execute-with-tests` (upstream = `superpowers:subagent-driven-development`). Step 2.5 (plan-freshness) per task. Two-stage review per task; re-run test counts yourself (`[[verify-subagent-test-counts]]`).
4. `netdust-core:testing-workflow` per task (subagent-invoked).
5. (controller, D-8) `netdust-core:integration` → `/code-review --base=<C.3 close, cad6443> --effort=medium` → `netdust-core:evaluate`.

## After D closes

**Sub-phase E** (web UI): runs table + link tiles + Cmd-K + the provider-degraded + **reactor-halt banners** (C.3 shipped the `reactor.halted`/`recovered` events + the bus rule; E renders the banner — see C.3 spec §4b "UI deferred to Sub-phase E") + body-editor wiki-links. Then **Sub-phase F** (shake-out + merge to main).

## First-turn checklist (D session)

1. `superpowers:using-superpowers`.
2. **Run the C-13 manual dev-server smoke** (§1) — fix any wiring bug as a C.3 follow-up before D.
3. Read this handoff + the mega-plan §"Sub-phase D" outline + the spec §4g/§4i + `tasks/retro-follow-ups.md`.
4. **Expand + reconcile the D plan** (`writing-plans` + `threat-modeling`) — stale symbols (`executeMcpTool`→`executeTool`, `mcp-dispatch.ts`→`agent-tools.ts`), carried obligations folded into D-1/D-3/D-5, D threat-model extension (54+). Plan-correction commit.
5. THEN dispatch via `ntdst-execute-with-tests`. D-1 first (routes are the spine D-4 parity-tests against).
6. D-8 controller gate.

If anything is stuck, STOP and reach for the user. Don't improvise around the discipline.
