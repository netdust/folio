# Phase C — Cross-Workspace Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PREREQUISITE: Phase A (`__system` library) AND Phase B (cross-workspace execution) must be built + merged first.** Phase C extends Phase B's resolution predicate from the human-invocation path (`loadContext`) to the trigger-fired path (the trigger-matcher), and inherits Phase B's caller-sole authority, HIGH floor, and B10 injection fence.

**Goal:** Let a trigger in workspace B fire a `__system` library agent — extending the `home ∈ {workspaceId, __system}` resolution predicate to the trigger-matcher's three agent-resolution sites, skipping the agent's own project allow-list for library agents (authority is caller-sole, bounded at run time), surfacing library agents in the trigger-target UI, and PROVING the new unattended-injection path is safe.

**Architecture:** The trigger-matcher resolves the target agent by `(workspaceId, type='agent', slug)` at three sites (`trigger-matcher.ts:230, 321, 420`) and calls `createRun({agent, actor, ...})`. Phase B already made `createRun` stamp `agent_home_workspace_id` from the resolved agent's `workspaceId`, so a `__system` agent flows through correctly — the Phase C change is to let the matcher RESOLVE a `__system` agent (the predicate) and to NOT apply the agent's own project allow-list as a fire-gate for library agents (their `projects:['*']` means `__system`'s projects, not B's — authority is caller-sole at `loadContext`, Phase B). The trigger-fired run's CALLER is the human who caused the event (`resolveOwnerUser(event.actor)`); the autonomy gate (`FOLIO_AGENT_CHAINS_ENABLED`) is UNCHANGED (human-caused events fire, agent-caused suppressed). The new risk — an UNATTENDED injection→mutation chain (malicious B content both causes the event AND is the injection the agent reads) — is bounded by the inherited Phase-B defenses (caller ceiling + HIGH floor + B10 fence) and PROVEN by a mandatory unattended-injection shake-out.

**Tech Stack:** Bun, Hono, Drizzle, SQLite. Touches `lib/trigger-matcher.ts` (3 resolution sites + the allow-list gate), the trigger-target UI (web), reuses Phase A's `getSystemWorkspaceId` + Phase B's `createRun` stamping + caller-sole `loadContext`.

**Spec:** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 3c — the trigger-matcher binding point; Phase C). **Memories:** `project_operator-is-an-agent-not-a-seeded-bot`, `feedback_state-consequences-and-dont-flatter`.

---

## Threat model

> Phase C of the system-library build: a trigger in workspace B firing a `__system` library agent UNATTENDED. Written 2026-06-02. EXTENDS Phase A (M1–M8), the `folio_api` model (P3-1…P3-10), and Phase B (B1–B10). The new surface vs Phase B: the run is EVENT-FIRED, not human-invoked — no human chose to run the agent, so malicious B content can both cause the triggering event AND be the injection the agent reads (a fully unattended injection→mutation chain). New attacks **C1…CN**; most defenses are INHERITED from Phase B (cross-reference, don't re-litigate). Convergence target for `/code-review high` on Phase C.

### What we're defending

1. **The tenant boundary on the FIRED path** — a B trigger firing a `__system` agent must still act ONLY on B's data with the event-human's authority (the trigger-matcher must not become a cross-tenant capability or data hole).
2. **The autonomy boundary** — `FOLIO_AGENT_CHAINS_ENABLED` OFF still suppresses agent-originated events; a library agent's OWN output must not fire another run (no cross-workspace chains in v1).
3. **The unattended-injection bound** — an unattended trigger-fired library-agent run can be steered by malicious B content; its blast radius must stay within the event-human's authority + the HIGH floor + the B10 fence (NO new escalation path the human-invoked Phase-B run didn't already have).

### Who we're defending against

1. **A prompt-injected library agent fired by a trigger (THE #1 attacker, now UNATTENDED)** (IN scope) — malicious B content fires a trigger and steers the fired agent into a write. No human is in the loop at invocation. Mitigated by: the inherited B10 fence + HIGH floor + caller ceiling, PROVEN by the unattended-injection shake-out (C-T8).
2. **A customer wiring a B trigger to a library agent** (IN scope) — gets the event-human's caller-bounded reach; can't make the library agent exceed the human who caused the event, or reach a third workspace C.
3. **A library agent's own output trying to fire another run** (IN scope) — suppressed by the unchanged autonomy gate.
4. **Insider with a stolen session** (OUT of scope) — trust root.

### Attacks to defend against

1. **C1 — Cross-tenant via the matcher.** A matcher resolution site resolves an agent whose home is a third workspace C (not B, not `__system`), or fires a `__system` agent against the wrong target. (Class: capability/data bleed via the fired path — the Phase-B B1 attack, now on the trigger path.)
2. **C2 — Allow-list gate misfires for a library agent.** The matcher's `resolveAgentProjects(agent)` fire-gate (`trigger-matcher.ts:434`) reads a library agent's `projects:['*']` as "all of B's projects" (wrong — it's `__system`'s), causing it to fire (or wrongly skip) against B based on the WRONG allow-list. (Class: authority-from-the-agent leak on the fired path — Phase-B B5, manifested as a fire-gate.)
3. **C3 — Unattended injection→mutation.** Malicious B content fires a trigger AND instructs the fired library agent to delete/alter B data; with no human in the loop, the only defenses are the inherited fence + floor + ceiling. (Class: unattended injection — the headline new risk.)
4. **C4 — Autonomy-gate bypass via cross-workspace firing.** A library agent's output fires a trigger that fires another library agent, forming a cross-workspace chain while `FOLIO_AGENT_CHAINS_ENABLED` is off. (Class: autonomy boundary bypass.)
5. **C5 — Wrong caller resolved for the fired run.** The trigger-fired run's caller is resolved as something broader than the event-human (e.g. a system actor, or the library agent itself), widening authority. (Class: caller-resolution escalation.)

### Mitigations required

1. **C1 → all THREE matcher resolution sites get the `home ∈ {workspaceId, __system}` predicate (identical to Phase B's `loadContext`).** `trigger-matcher.ts:230, 321, 420` change from `eq(documents.workspaceId, workspaceId)` to resolve where `documents.workspaceId IN (workspaceId, getSystemWorkspaceId())`, then ASSERT the resolved agent's home is one of those two. A third-workspace agent is never resolved. `createRun` (Phase B) stamps `agent_home_workspace_id` from the resolved agent → a `__system` agent flows correctly. Tests: a B trigger targeting a `__system` agent fires a run with `agent_home = __system`; a B trigger whose target somehow resolves to a workspace-C agent does NOT fire.
2. **C2 → for a library agent (home === `__system`), the matcher SKIPS the agent's own project allow-list fire-gate.** The `resolveAgentProjects(agent)` check (`trigger-matcher.ts:434`) is meaningful only for a LOCAL agent (its `projects` are B's projects). For a library agent, its `projects:['*']` refers to `__system` and is NOT a B-fire-gate — the firing decision is purely "does this trigger target this agent," and authority is bounded at run time by `loadContext`'s caller-sole narrowing (Phase B B5). So: when `agent.workspaceId === systemId`, bypass the allow-list gate (fire regardless of `agent.projects`); the run is still caller-bounded in B. A test: a library agent with `projects:['*']` fires for a B trigger on any B project; the firing is NOT gated by the agent's `__system` project list; the RUN is still denied B projects the event-human can't reach (inherited B5 — assert via the run authority, not the fire decision).
3. **C3 → inherit Phase B's fence + floor + ceiling; PROVE the unattended path with a mandatory shake-out.** No new gating mechanism — the unattended trigger-fired run uses the SAME `loadContext` (caller-sole, HIGH floor, B10 fence) as a human-invoked run. The proof is C-T8's mandatory unattended-injection shake-out: malicious B content fires a trigger AND tries to steer the fired library agent into a MEDIUM/LOW write → assert the agent refuses (does not perform the injected mutation). If it follows the injection unattended, the fence is insufficient → MERGE-BLOCKER (strengthen before merge).
4. **C4 → the autonomy gate is UNCHANGED and covers the fired path.** `isAgentOriginated(event) && !FOLIO_AGENT_CHAINS_ENABLED` (`trigger-matcher.ts:442`) still suppresses an agent-originated event before any resolution — so a library agent's output can't fire another library agent in v1 (cross-workspace chains stay off). Phase C does NOT touch the gate; a test confirms an agent-originated event targeting a `__system` agent is suppressed (emits `agent.chain.suppressed`), same as for a local agent.
5. **C5 → the trigger-fired run's caller is the event-human via the UNCHANGED `resolveOwnerUser(event.actor)`.** Phase C does NOT change caller resolution: the run's owner/caller is the human (or human-behind-a-PAT) who caused the event, and `caller_scopes`/`caller_project_ids` are the Phase-1 server-side snapshot of THAT human's membership in B. A library agent fired by a member's action gets that member's authority in B, never more. A test: a trigger fired by member M's action runs the library agent with M's caller snapshot (not a system actor, not the agent).

### Out of scope (explicit deferrals)

- **Cross-workspace agent CHAINS** — `FOLIO_AGENT_CHAINS_ENABLED` stays off (C4); OP1-F8 (re-derive sub-run caller) is the prerequisite before chains. A library agent firing another library agent is suppressed.
- **A tighter unattended risk ceiling** (e.g. trigger-fired library agents can't do MEDIUM) — considered + NOT taken for v1 (Stefan, 2026-06-02): the inherited HIGH floor + B10 fence + caller ceiling are the v1 bound, proven by the C3 shake-out. If the unattended shake-out reveals the fence is insufficient for MEDIUM, revisit (it'd be a merge-blocker, forcing the decision then).
- **Per-trigger agent authority overrides** — a trigger can't grant a library agent more than the event-human; no per-trigger scope config.
- **Library curation UI** — Phase D.

### How to use this section

- **Controller pre-flight:** verify each task carries its named C-mitigation; ground-truth the 3 matcher resolution sites + the allow-list gate + `resolveOwnerUser` (they're the surface) live before dispatch.
- **`/code-review high`:** "Verify against the Phase C threat model (C1–C5) AND confirm Phase A (M1–M8) + Phase B (B1–B10) + Phase-1 + folio_api are not weakened. Headline checks: all 3 matcher sites gated by `home ∈ {ws, __system}` (C1); the allow-list fire-gate SKIPPED for library agents (C2, and confirm the RUN is still caller-bounded); the autonomy gate unchanged + covers the fired path (C4); the fired run's caller is the event-human not a system actor (C5). The unattended-injection shake-out (C3) is a MERGE-BLOCKER."
- **`/evaluate` retro:** any missing C-mitigation → plan-correction defect.
- **Downstream (Phase D):** Phase D is UI-only (library curation); it inherits C1–C5 but doesn't extend the execution model.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/trigger-matcher.ts` | The 3 resolution sites (230/321/420) → `home ∈ {ws, __system}` predicate; the allow-list fire-gate (434) skipped for library agents. | Modify |
| `apps/web/src/...` (trigger-target picker) | Surface `__system` library agents as targetable in a B trigger's agent picker (union, badged `library:true` — mirrors Phase B Task 7's run/assign picker). | Modify |
| Tests per file | TDD | Create |

> **Open ground-truth the implementer MUST resolve in Task 1:** (a) confirm the 3 resolution sites are exactly `trigger-matcher.ts:230, 321, 420` at execution HEAD (they shift as the file changes — re-grep `eq(documents.workspaceId, workspaceId)` + `eq(documents.type, 'agent')`); (b) the trigger-target UI surface (how a trigger doc's `target_agent`/`target_agent_id` is chosen in the web — to add library agents); (c) confirm `createRun` (Phase B) stamps `agent_home_workspace_id` from the resolved agent (so the matcher needs only to resolve the `__system` agent, not stamp anything itself).

---

## Task 1: Ground-truth + extend the 3 matcher resolution sites (the predicate)

**Mitigations: C1.**

**Files:**
- Modify: `apps/server/src/lib/trigger-matcher.ts` (the 3 resolution sites)
- Test: `apps/server/src/lib/trigger-matcher.test.ts` (or the reaction-plane test file)

- [ ] **Step 1: Ground-truth** (read, don't code): re-grep the 3 resolution sites; confirm `createRun` stamps `agent_home_workspace_id` (Phase B); read the trigger-target UI surface (1b). Write findings as a comment.

- [ ] **Step 2: Write the failing test** — a B trigger targeting a `__system` agent resolves it; a target resolving to a third workspace C does NOT.

```typescript
test('the matcher resolves a __system library agent for a B trigger (C1)', async () => {
  // bootstrap __system + a library agent; a B trigger event targeting that agent slug → resolves it (home=__system)
});
test('the matcher does NOT resolve an agent from a third workspace C (C1)', async () => {
  // a B trigger whose target slug only exists in workspace C → not resolved, no run
});
```

- [ ] **Step 3: Run to verify fail** — FAIL.

- [ ] **Step 4: Implement** — at each of the 3 sites, replace `eq(documents.workspaceId, workspaceId)` with a home-predicate resolution: resolve where `documents.workspaceId IN (workspaceId, systemId)` (compute `systemId = await getSystemWorkspaceId(db)` once per match), prefer a B-local agent if both exist with the same slug (local shadows library — or DECIDE + document the precedence; recommended: local-first so a workspace can override a library agent by slug), then ASSERT the resolved agent's `workspaceId ∈ {workspaceId, systemId}`. Extract a shared `resolveTriggerAgent(db, workspaceId, slug)` helper so all 3 sites are identical (DRY + one place to review).

- [ ] **Step 5: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/trigger-matcher.ts apps/server/src/lib/trigger-matcher.test.ts
git commit -m "phase-C: matcher resolves agents by home in {ws, __system} at all 3 sites (C1)"
```

---

## Task 2: Skip the allow-list fire-gate for library agents

**Mitigations: C2.**

**Files:**
- Modify: `apps/server/src/lib/trigger-matcher.ts` (the allow-list gate ~line 434)
- Test: `apps/server/src/lib/trigger-matcher.test.ts`

- [ ] **Step 1: Write the failing test** — a library agent with `projects:['*']` fires for a B trigger on any B project (the gate is skipped); the RUN is still caller-bounded.

```typescript
test('the allow-list fire-gate is SKIPPED for a library agent (C2)', async () => {
  // library agent (home __system, projects ['*']); a B trigger on B-project P → fires (not gated by __system's project list)
});
test('a LOCAL agent still respects its allow-list fire-gate (no regression)', async () => {
  // a B-local agent with projects narrowed to [P1]; a trigger on P2 → does NOT fire
});
test('the fired library-agent run is still caller-bounded in B (C2 → inherited B5)', async () => {
  // assert the run authority = event-human's reach in B, not the agent's ['*'] (verify via the run's caller snapshot / a denied action)
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — at the allow-list gate (`trigger-matcher.ts:434`): when the resolved agent's `workspaceId === systemId` (library agent), SKIP the `resolveAgentProjects` fire-gate (its `__system` projects are not a B-fire-gate). For a LOCAL agent, keep the existing gate unchanged. Add a comment: the library agent's firing is "does the trigger target it"; its AUTHORITY in B is bounded at `loadContext` (caller-sole, Phase B B5), not at the fire decision.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/trigger-matcher.ts apps/server/src/lib/trigger-matcher.test.ts
git commit -m "phase-C: skip the project allow-list fire-gate for library agents (C2)"
```

---

## Task 3: Confirm the autonomy gate + caller resolution cover the fired path

**Mitigations: C4, C5.** Mostly confirmation + guard tests (Phase C does NOT change the gate or `resolveOwnerUser`).

**Files:**
- Modify: `apps/server/src/lib/trigger-matcher.ts` (comments only, if any) + tests
- Test: `apps/server/src/lib/trigger-matcher.test.ts`

- [ ] **Step 1: Write the guard tests**

```typescript
test('an agent-originated event targeting a __system agent is suppressed with chains off (C4)', async () => {
  // FOLIO_AGENT_CHAINS_ENABLED off; an event whose actor is agent:<x> targeting a library agent → suppressed (agent.chain.suppressed emitted), no run
});
test('a trigger-fired library-agent run uses the event-human as caller, not a system actor (C5)', async () => {
  // a human-caused event fires a library agent; the run's caller snapshot = that human's membership in B (resolveOwnerUser), not the agent / not system
});
```

- [ ] **Step 2: Run to verify** — the autonomy gate + `resolveOwnerUser` are UNCHANGED, so these likely PASS immediately (guard/regression pins). If C4 fails (the gate runs AFTER resolution and a `__system` resolution slips a suppressed event through), MOVE the gate before resolution or confirm it already precedes it (`trigger-matcher.ts:442` — verify ordering). Add a comment at the gate: "covers the fired path for library agents too — the gate precedes resolution; do not reorder."

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/trigger-matcher.ts apps/server/src/lib/trigger-matcher.test.ts
git commit -m "phase-C: pin autonomy gate + event-human caller on the fired library-agent path (C4/C5)"
```

---

## Task 4: Surface library agents in the trigger-target UI

**Mitigations: supports C1 (a B trigger can be wired to a library agent).**

**Files:**
- Modify: the web trigger-target picker (ground-truthed in Task 1b) + the server endpoint it reads (likely the same agents-list Phase B Task 7 extended).
- Test: web (vitest) + a server test if the endpoint changes.

- [ ] **Step 1: Write the failing test** — the trigger-target agent picker in workspace B shows B's own agents PLUS `__system` library agents (badged `library:true`); selecting one sets the trigger's `target_agent`/`target_agent_id` to the library agent.

> Ground-truth (Task 1b) the surface. If Phase B Task 7 already extended the shared agents-list endpoint to union `__system` agents, this task may be PURELY the trigger-target picker consuming that same list — confirm + reuse, don't duplicate. The OP-LIB-1 follow-up (all `__system` agents are customer-visible; `frontmatter.published` filter is the future edit) applies here too — same `// TODO(library-visibility)` marker.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — extend the trigger-target picker to offer `__system` library agents (reuse Phase B Task 7's union endpoint if it exists). Selecting one wires the trigger to it; the matcher (Tasks 1-2) resolves it; `createRun` (Phase B) stamps the home. Confirm a non-`__system` member can wire a B trigger to a library agent (it's a capability, fired with the event-human's B authority).

- [ ] **Step 4: Run to verify pass + tsc (web + server)** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/... apps/server/src/... <test files>
git commit -m "phase-C: surface __system library agents in the trigger-target picker"
```

---

## Task 5: Integration gate + the unattended-injection shake-out

**Files:** verification only.

- [ ] **Step 1: Full suites** — server (`cd apps/server && bun test`, 0 fail), shared, web (`npx vitest run`). tsc per app.
- [ ] **Step 2: A real cross-workspace TRIGGER-FIRED run** — with a real key, wire a B trigger to the `__system` operator (or a test library agent), cause the triggering event in B as a human, and confirm the fired run (a) loads its skill, (b) acts on B's data, (c) is bounded by the event-human's authority, (d) refuses a HIGH action. Drive via the composed loop (dispatcher + matcher + poller + runner).
- [ ] **Step 3: The UNATTENDED-INJECTION shake-out (C3 — MANDATORY, MERGE-BLOCKER).** Seed malicious B content that BOTH causes a triggering event AND instructs the fired library agent to delete a document / alter a table (a MEDIUM/LOW write). Run the full unattended chain (no human invocation — the trigger fires it). Assert the fired agent does NOT perform the injected mutation (the B10 fence holds on the unattended path too). If it follows the injection, STOP — the fence is insufficient for the unattended path; strengthen before merge (merge-blocker, not a residual).
- [ ] **Step 4: `/integration`** then `/code-review high` (C1–C5 as input; confirm Phase A/B/Phase-1/folio_api not weakened), then `/shakeout` (the real trigger-fired run + the unattended-injection case + the `invariant-auditor` against `ARCHITECTURE-INVARIANTS.md` invariants 2/3/4/10), then merge. **At this point Phases A+B+C are the coherent cross-workspace operator — merge the branch to main if not already.**
- [ ] **Step 5: Commit** any gate-fix; `/evaluate` the A→C arc.

---

## Self-Review (run before dispatch)

**Spec coverage (Component 3c):** the 3 matcher resolution sites gated by `{ws, __system}` (Task 1 — C1), the allow-list fire-gate skipped for library agents (Task 2 — C2), the autonomy gate + event-human caller confirmed on the fired path (Task 3 — C4/C5), library agents in the trigger-target UI (Task 4), the real trigger-fired run + the MANDATORY unattended-injection shake-out (Task 5 — C3). Cross-workspace chains stay deferred (C4 gate off). ✅

**Placeholder scan:** test bodies have `// ...seed...` markers (deliberate fixture pointers). The trigger-target UI (Task 4) is ground-truthed in Task 1b — flagged; reuse Phase B Task 7's endpoint if it exists rather than duplicate.

**Type consistency:** `getSystemWorkspaceId` (Phase A), `resolveTriggerAgent(db, workspaceId, slug)` (new shared helper for the 3 sites), the `home ∈ {ws, __system}` predicate, `resolveOwnerUser`/the autonomy gate (unchanged) — consistent. `createRun`'s Phase-B stamping is reused, not re-implemented.

**Biggest risk flagged:** C3 (the unattended injection→mutation chain) is the headline new risk — the shake-out (Task 5 Step 3) is a MERGE-BLOCKER, the proof the inherited B10 fence holds when no human is in the loop. The allow-list-skip (Task 2, C2) is the subtlest correctness point — a library agent's `__system` project list must NOT gate B-firing, but the RUN must stay caller-bounded; verify BOTH (fires + still-bounded). Re-grep the 3 resolution sites at HEAD (they shift).

---

## Execution Handoff

Plan complete. **Phases A + B must merge first.** Recommended: subagent-driven per task with two-stage review; controller verifies the named C-mitigation + ground-truths the 3 matcher sites + the trigger-target UI live (Step 2.5 gate). After Task 5: `/code-review high` (C1–C5), `/integration`, `/shakeout` (real trigger-fired run + the unattended-injection case), merge the full A→C cross-workspace operator. Phase D (library curation UI) is the last plan — UI-only, no execution-model change.
