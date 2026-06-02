# Phase C — Cross-Workspace Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PREREQUISITE: Phase A (`__system` library) AND Phase B (cross-workspace execution) must be built + merged first.** Phase C extends Phase B's resolution predicate from the human-invocation path (`loadContext`) to the trigger-fired path (the trigger-matcher), and inherits Phase B's caller-sole authority, HIGH floor, and B10 injection fence.

**Goal:** Let a trigger in workspace B fire a `__system` library agent — extending the `home ∈ {workspaceId, __system}` resolution predicate to the trigger-matcher's three agent-resolution sites, skipping the agent's own project allow-list for library agents (authority is caller-sole, bounded at run time), surfacing library agents in the trigger-target UI, and PROVING the new unattended-injection path is safe.

**Architecture:** The trigger-matcher resolves the target agent and calls `createRun({agent, actor, ...})`. Phase B already made `createRun` stamp `agent_home_workspace_id` from the resolved agent's `workspaceId`, so a `__system` agent flows through correctly. The Phase C changes: (1) the matcher RESOLVES the target agent **by its immutable `target_agent_id` (which carries the home workspace) when present**, asserting `home ∈ {workspaceId, __system}` — NOT by slug-then-local-first (which would let a later same-slug local agent silently shadow a trigger wired by id to a library agent); (2) it does NOT apply the agent's own project allow-list as a fire-gate for library agents (their `projects:['*']` means `__system`'s projects, not B's — authority is caller-sole at `loadContext`, Phase B); (3) **the FIRED path floors MEDIUM** — a trigger-fired library-agent run is capped at reads + LOW, and MEDIUM (config writes) refuses-with-plan like HIGH, because no human is in the loop to catch an injected config change. The trigger-fired run's CALLER is the human who caused the event (`resolveOwnerUser(event.actor)`); a NON-human-caused trigger (e.g. a scheduled trigger, whose `schedule` field exists in the trigger schema) has NO event-human, so **library targets are FORBIDDEN for non-human-caused triggers** (or pinned to a least-privilege actor — see C5). The autonomy gate (`FOLIO_AGENT_CHAINS_ENABLED`) is UNCHANGED (human-caused fires, agent-caused suppressed); note its ordering is resolve→allow-list→gate (the gate runs AFTER resolution — it suppresses, it doesn't pre-filter). **The injection bound is DETERMINISTIC** (HIGH+MEDIUM floor on the fired path + caller ceiling), with the B10 fence as a best-effort additional layer for LOW — NOT "proven safe by one shake-out payload."

**Tech Stack:** Bun, Hono, Drizzle, SQLite. Touches `lib/trigger-matcher.ts` (3 resolution sites + the allow-list gate), the trigger-target UI (web), reuses Phase A's `getSystemWorkspaceId` + Phase B's `createRun` stamping + caller-sole `loadContext`.

**Spec:** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 3c — the trigger-matcher binding point; Phase C). **Memories:** `project_operator-is-an-agent-not-a-seeded-bot`, `feedback_state-consequences-and-dont-flatter`.

---

## Threat model

> Phase C of the system-library build: a trigger in workspace B firing a `__system` library agent UNATTENDED. Written 2026-06-02. EXTENDS Phase A (M1–M8), the `folio_api` model (P3-1…P3-10), and Phase B (B1–B10). The new surface vs Phase B: the run is EVENT-FIRED, not human-invoked — no human chose to run the agent, so malicious B content can both cause the triggering event AND be the injection the agent reads (a fully unattended injection→mutation chain). New attacks **C1…CN**; most defenses are INHERITED from Phase B (cross-reference, don't re-litigate). Convergence target for `/code-review high` on Phase C.

### What we're defending

1. **The tenant boundary on the FIRED path** — a B trigger firing a `__system` agent must still act ONLY on B's data with the event-human's authority (the trigger-matcher must not become a cross-tenant capability or data hole).
2. **The autonomy boundary** — `FOLIO_AGENT_CHAINS_ENABLED` OFF still suppresses agent-originated events; a library agent's OWN output must not fire another run (no cross-workspace chains in v1).
3. **The unattended-injection bound** — an unattended trigger-fired library-agent run can be steered by malicious B content. Its blast radius must stay within a DETERMINISTIC bound: the event-human's authority (caller ceiling) AND the fired-path HIGH+MEDIUM floor (config writes refuse on the fired path). The B10 fence is a best-effort additional layer for LOW writes — NOT the bound. (The honest framing: injection is not "beaten" by a passing test; it's BOUNDED by the floor + ceiling, which hold regardless of whether the fence is bypassed.)

### Who we're defending against

1. **A prompt-injected library agent fired by a trigger (THE #1 attacker, now UNATTENDED)** (IN scope) — malicious B content fires a trigger and steers the fired agent into a write. No human is in the loop at invocation. Bounded DETERMINISTICALLY by: the caller ceiling (can't exceed the event-human) + the fired-path HIGH+MEDIUM floor (config writes refuse). The B10 fence is best-effort for LOW. The unattended-injection shake-out (C-T5) is a SMOKE TEST of the fence on the LOW path, NOT a proof that injection is beaten — the floor + ceiling are what make the residual acceptable.
2. **A customer wiring a B trigger to a library agent** (IN scope) — gets the event-human's caller-bounded reach; can't make the library agent exceed the human who caused the event, or reach a third workspace C.
3. **A library agent's own output trying to fire another run** (IN scope) — suppressed by the unchanged autonomy gate.
4. **Insider with a stolen session** (OUT of scope) — trust root.

### Attacks to defend against

1. **C1 — Cross-tenant via the matcher + slug-shadow.** A matcher resolution site resolves an agent whose home is a third workspace C; OR a trigger wired (by immutable id) to a library agent is later SILENTLY SHADOWED by a same-slug LOCAL agent created in B (because the matcher round-trips id→slug→local-first re-resolution — `resolveTargetAgentSlug` converts `target_agent_id` to a slug, then downstream re-resolves by slug). (Class: capability/data bleed + identity-shadow on the fired path — Phase-B B1, plus a slug-precedence bug the id-resolution closes.)
2. **C2 — Allow-list gate misfires for a library agent.** The matcher's `resolveAgentProjects(agent)` fire-gate (`maybeCreateRun`, ~`trigger-matcher.ts:434`) reads a library agent's `projects:['*']` as "all of B's projects" (wrong — it's `__system`'s), causing it to fire (or wrongly skip) against B based on the WRONG allow-list. (Class: authority-from-the-agent leak on the fired path — Phase-B B5, manifested as a fire-gate.)
3. **C3 — Unattended injection→mutation.** Malicious B content fires a trigger AND instructs the fired library agent to delete/alter B data; with no human in the loop, the B10 fence is best-effort and a single passing shake-out payload does NOT prove injection is beaten. (Class: unattended injection — the headline new risk; bounded deterministically, not "proven safe.")
4. **C4 — Autonomy-gate bypass via cross-workspace firing.** A library agent's output fires a trigger that fires another library agent, forming a cross-workspace chain while `FOLIO_AGENT_CHAINS_ENABLED` is off. NOTE the real ordering: the gate runs AFTER resolution (resolve→allow-list→gate, `maybeCreateRun`), so a library→library agent-originated event IS resolved, then SUPPRESSED by the gate (no run). The suppression is the control, not a pre-resolution filter. (Class: autonomy boundary bypass.)
5. **C5 — Wrong caller resolved for the fired run.** The trigger-fired run's caller is resolved as something broader than the event-human (a system actor, or the library agent itself), widening authority. (Class: caller-resolution escalation.)
6. **C6 — A NON-human-caused trigger fires a library agent with no event-human.** A scheduled/time trigger (the trigger schema has a `schedule` field) or any trigger whose event has no human actor fires a library agent — `resolveOwnerUser(event.actor)` returns null, so there is no caller to bound the run. If the run then proceeds with a fallback/system actor, it's unbounded by any human's authority. (Class: caller-less unattended escalation.)

### Mitigations required

1. **C1 → resolve by IMMUTABLE ID (which carries home), assert `home ∈ {workspaceId, __system}`, drop slug-then-local-first re-resolution.** When a trigger carries `target_agent_id`, resolve the agent doc BY THAT ID directly (`findFirst(eq(documents.id, target_agent_id), eq(type,'agent'))`), then ASSERT its `workspaceId ∈ {event.workspaceId, getSystemWorkspaceId()}`. Do NOT convert id→slug and re-resolve by slug (the current `resolveTargetAgentSlug` does `return agentDoc.slug`, after which downstream re-resolves by slug with workspace-local precedence — letting a LATER same-slug local agent silently shadow a trigger wired by id to a library agent). The slug path is the FALLBACK only when no `target_agent_id` is present (legacy/typed targets), and there it resolves with the home predicate too. Extract a shared `resolveTriggerAgent(db, event.workspaceId, payload)` returning the agent DOC (not a slug) used by all sites. Tests: a trigger wired by id to a `__system` agent fires THAT agent even when a same-slug local agent later exists in B (no shadow — C1); a target resolving to a workspace-C agent does NOT fire.
2. **C2 → for a library agent (home === `__system`), the matcher SKIPS the agent's own project allow-list fire-gate.** The `resolveAgentProjects(agent)` check (`maybeCreateRun`, ~`trigger-matcher.ts:434`) is meaningful only for a LOCAL agent (its `projects` are B's projects). For a library agent, its `projects:['*']` refers to `__system` and is NOT a B-fire-gate — the firing decision is purely "does this trigger target this agent," and authority is bounded at run time by `loadContext`'s caller-sole narrowing (Phase B B5). So: when the resolved agent's `workspaceId === systemId`, bypass the allow-list gate; the run is still caller-bounded in B. A test: a library agent with `projects:['*']` fires for a B trigger on any B project; the firing is NOT gated by the agent's `__system` project list; the RUN is still denied B projects the event-human can't reach (inherited B5 — assert via the run authority, not the fire decision).
3. **C3 → FLOOR MEDIUM on the fired path (deterministic bound); the B10 fence is best-effort for LOW; the shake-out is a SMOKE TEST, not a proof.** A trigger-fired library-agent run is capped at reads + LOW: **MEDIUM (config writes) refuses-with-plan on the fired path**, exactly like HIGH — because no human is in the loop to catch an injected config change. Mechanism: the run carries a "fired/unattended" marker (e.g. `frontmatter.unattended: true`, stamped by `createRun` when the actor is a trigger-fired event rather than a direct human invocation), and `classifyRisk`/the `folio_api` write tool treats MEDIUM as refuse-with-plan when `unattended` is set. So the unattended injection→mutation chain is BOUNDED DETERMINISTICALLY: caller ceiling (event-human's authority) + HIGH+MEDIUM floor. The B10 fence remains as a best-effort layer for LOW writes (doc writes — the only auto-applied tier on the fired path). C-T5's unattended-injection shake-out is a SMOKE TEST of the fence on the LOW path (does a LOW-write injection get refused?) — a useful signal, NOT a proof that injection is beaten. Framing in the plan: "unattended MEDIUM/HIGH is floored; unattended LOW is bounded by caller authority + best-effort fence — accepted residual." A test: a trigger-fired library-agent run attempting a MEDIUM config write (e.g. create a table) is REFUSED-with-plan; the same action by a HUMAN-invoked Phase-B run is allowed (the floor is fired-path-only).
4. **C4 → the autonomy gate is UNCHANGED; note its REAL ordering (resolve→allow-list→gate) and test library→library suppression.** In `maybeCreateRun` the order is resolve (418-425) → allow-list (434) → `isAgentOriginated(event) && !FOLIO_AGENT_CHAINS_ENABLED` gate (442): the gate runs AFTER resolution and SUPPRESSES (emits `agent.chain.suppressed`, creates zero runs) — it is NOT a pre-resolution filter. That is functionally correct (no run is created), so Phase C does NOT reorder it. A test: a LIBRARY agent's OWN output (an agent-originated event) targeting ANOTHER library agent is SUPPRESSED with chains off (no run, `agent.chain.suppressed` emitted) — proving the gate covers the library→library cross-workspace chain. (Do NOT write a comment claiming "gate precedes resolution" — it does not; the comment must state "resolve→gate; the gate suppresses post-resolution.")
5. **C5 → the trigger-fired run's caller is the event-human via the UNCHANGED `resolveOwnerUser(event.actor)`.** Phase C does NOT change caller resolution: the run's owner/caller is the human (or human-behind-a-PAT) who caused the event; `caller_scopes`/`caller_project_ids` are the Phase-1 server-side snapshot of THAT human's membership in B. A test: a trigger fired by member M's action runs the library agent with M's caller snapshot (not a system actor, not the agent).
6. **C6 → a library agent can be targeted ONLY by a trigger whose event has a resolvable human caller; non-human-caused triggers (scheduled, or any with no event-human) REFUSE to fire a library agent.** When the matcher resolves a `__system` (library) target, it asserts `resolveOwnerUser(event.actor)` returns a non-null human; if null (e.g. a scheduled trigger with no event-human, or an unresolvable actor), it does NOT fire the library agent (logs + skips — a library agent with no caller has no authority bound). LOCAL agents fired by such triggers are unaffected (out of Phase C scope — that's the existing behavior). A test: a scheduled/actor-less trigger event targeting a library agent does NOT create a run (no caller to bound it); the same trigger targeting a LOCAL agent is unchanged. (Rationale: "authority = caller, sole" REQUIRES a caller; a caller-less library run would be unbounded — forbid it rather than invent a system-actor authority.)

### Out of scope (explicit deferrals)

- **Cross-workspace agent CHAINS** — `FOLIO_AGENT_CHAINS_ENABLED` stays off (C4); OP1-F8 (re-derive sub-run caller) is the prerequisite before chains. A library agent firing another library agent is suppressed.
- **Unattended LOW writes** — a trigger-fired library agent CAN do LOW (doc) writes within the event-human's authority; an injected LOW mutation is bounded by the caller ceiling + the best-effort B10 fence. This is the ACCEPTED RESIDUAL (MEDIUM+HIGH are floored on the fired path, C3; LOW is the only auto tier left). Documented so it isn't re-surfaced as a finding.
- **Per-trigger agent authority overrides** — a trigger can't grant a library agent more than the event-human; no per-trigger scope config.
- **Scheduled-trigger library agents with a pinned least-privilege actor** — Phase C FORBIDS library targets for caller-less triggers (C6) rather than inventing a system actor; a future "scheduled library agent with an explicit owner" model is deferred (it'd need a deliberate owner-designation per scheduled trigger).
- **Library curation UI** — Phase D.

### How to use this section

- **Controller pre-flight:** verify each task carries its named C-mitigation; ground-truth the matcher resolution sites + `resolveTargetAgentSlug`/`target_agent_id` path + the allow-list gate + the autonomy-gate ORDERING + `resolveOwnerUser` (they're the surface) live before dispatch.
- **`/code-review high`:** "Verify against the Phase C threat model (C1–C6) AND confirm Phase A (M1–M8) + Phase B (B1–B10) + Phase-1 + folio_api are not weakened. Headline checks: resolution by IMMUTABLE ID with the home predicate, NO slug-shadow (C1); the allow-list fire-gate SKIPPED for library agents but the RUN still caller-bounded (C2); **MEDIUM floored on the fired path** so an unattended config write refuses (C3); the autonomy gate's real ordering is resolve→gate and library→library is suppressed (C4); the fired caller is the event-human (C5); a caller-less (scheduled) trigger does NOT fire a library agent (C6). The unattended-LOW-injection shake-out is a SMOKE TEST (not a proof); the DETERMINISTIC bound is the MEDIUM+HIGH floor + caller ceiling."
- **`/evaluate` retro:** any missing C-mitigation → plan-correction defect.
- **Downstream (Phase D):** Phase D is UI-only (library curation); it inherits C1–C6 but doesn't extend the execution model.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/trigger-matcher.ts` | Resolve target agent BY ID (home-predicate, no slug-shadow) via a shared `resolveTriggerAgent` doc-returning helper across all sites; skip the allow-list fire-gate for library agents; forbid library targets for caller-less (scheduled) triggers (C6); the autonomy-gate ordering comment corrected. | Modify |
| `apps/server/src/services/agent-runs.ts` | `createRun` stamps `frontmatter.unattended: true` when the run is trigger-fired (vs a direct human invocation), so the fired-path MEDIUM floor can key on it. | Modify |
| `apps/server/src/lib/folio-api-tool.ts` | The write tool floors MEDIUM (refuse-with-plan, like HIGH) when the run is `unattended` (C3). | Modify |
| `apps/web/src/...` (trigger-target picker) | Surface `__system` library agents as targetable in a B trigger's agent picker (union, badged `library:true` — reuse Phase B Task 7's endpoint). | Modify |
| Tests per file | TDD | Create |

> **Open ground-truth the implementer MUST resolve in Task 1:** (a) re-grep the matcher resolution sites at HEAD (`eq(documents.workspaceId, workspaceId)` + `eq(documents.type, 'agent')`) — they were at 230/321/420 + `resolveTargetAgentSlug` at 220, but they SHIFT; (b) `resolveTargetAgentSlug`'s id→slug round-trip (it does `return agentDoc.slug` for a `target_agent_id`, then downstream re-resolves by slug — the slug-shadow bug C1 closes); (c) how `createRun` distinguishes a trigger-fired run from a human-invoked one (the matcher's `createRun({actor, firedBy, ...})` — `firedBy`/the actor likely already discriminates; confirm so the `unattended` stamp is derivable, not invented); (d) the autonomy-gate ORDERING (resolve→allow-list→gate in `maybeCreateRun` — confirm, the comment must be accurate); (e) the trigger-target UI surface (reuse Phase B Task 7's union endpoint).

---

## Task 1: Ground-truth + `resolveTriggerAgent` — resolve by ID (home-predicate, no slug-shadow)

**Mitigations: C1.**

**Files:**
- Modify: `apps/server/src/lib/trigger-matcher.ts` (a shared `resolveTriggerAgent`; replace the 3 by-slug sites + `resolveTargetAgentSlug`)
- Test: `apps/server/src/lib/trigger-matcher.test.ts` (or the reaction-plane test file)

- [ ] **Step 1: Ground-truth** (read, don't code) the 5 items in the File-Structure ground-truth note (resolution sites, the id→slug round-trip, the trigger-fired-vs-human discriminator, the autonomy-gate ordering, the UI surface). Write findings as a comment.

- [ ] **Step 2: Write the failing test** — id-resolution wins over a same-slug local shadow; third-workspace rejected.

```typescript
test('a trigger wired by target_agent_id to a __system agent fires THAT agent, not a same-slug local shadow (C1)', async () => {
  // bootstrap __system + library agent slug 'ops' (id = L). A B trigger carries target_agent_id = L.
  // LATER create a B-local agent ALSO slug 'ops' (id = X). The trigger must still resolve L (the library
  // agent it was wired to), NOT X — resolution is by the immutable id, not by slug + local-first.
});
test('the matcher resolves a __system library agent for a B trigger (C1)', async () => {
  // a B trigger targeting (by id) a library agent → resolves it (home=__system)
});
test('the matcher does NOT resolve an agent from a third workspace C (C1)', async () => {
  // a target_agent_id pointing at a workspace-C agent → home predicate rejects → not resolved, no run
});
```

- [ ] **Step 3: Run to verify fail** — FAIL.

- [ ] **Step 4: Implement** — add `resolveTriggerAgent(db, eventWorkspaceId, payload)` returning the agent **document** (not a slug):
  - `const systemId = await getSystemWorkspaceId(db);`
  - **If `payload.target_agent_id` present:** `findFirst(eq(documents.id, target_agent_id), eq(documents.type,'agent'))`; if found, ASSERT `agent.workspaceId === eventWorkspaceId || agent.workspaceId === systemId` (else return undefined — third-workspace rejected, C1); return the agent doc. **Do NOT convert to slug + re-resolve** (that's the shadow bug).
  - **Else (slug fallback, legacy/typed `target_agent`):** resolve by `(workspaceId IN {eventWorkspaceId, systemId}, type='agent', slug)`; if BOTH a local and a library agent share the slug, prefer the LOCAL (a workspace can override a library agent by slug for the slug-only path) — document this; the id path has no such ambiguity.
  - Replace the 3 by-slug resolution sites (`handleInternalAction`, `handleResumeRun`, `maybeCreateRun`) + `resolveTargetAgentSlug`'s id→slug conversion with calls to `resolveTriggerAgent`, threading the agent DOC through (downstream code that needs the slug uses `agent.slug`). One helper, one review surface.

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

## Task 3: Autonomy gate (library→library suppression) + caller resolution + forbid caller-less library targets

**Mitigations: C4, C5, C6.** The gate + `resolveOwnerUser` are UNCHANGED; C6 ADDS a guard.

**Files:**
- Modify: `apps/server/src/lib/trigger-matcher.ts` (the C6 caller-less guard + an accurate ordering comment)
- Test: `apps/server/src/lib/trigger-matcher.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
test('a LIBRARY agent output firing ANOTHER library agent is suppressed with chains off (C4)', async () => {
  // FOLIO_AGENT_CHAINS_ENABLED off; an AGENT-ORIGINATED event (actor agent:<x>) targeting a library agent →
  // resolved THEN suppressed by the autonomy gate (agent.chain.suppressed emitted, zero runs).
});
test('a trigger-fired library-agent run uses the event-human as caller, not a system actor (C5)', async () => {
  // a human-caused event fires a library agent; the run's caller snapshot = that human's membership in B
  // (resolveOwnerUser), not the agent / not system.
});
test('a caller-less (scheduled / actor-less) trigger does NOT fire a library agent (C6)', async () => {
  // an event whose resolveOwnerUser(event.actor) is null, targeting a library agent → NO run created
  // (a library agent with no caller has no authority bound). The same event targeting a LOCAL agent is unchanged.
});
```

- [ ] **Step 2: Run to verify** — the C4/C5 tests likely PASS (gate + caller unchanged); the C6 test FAILS (no caller-less guard yet).

- [ ] **Step 3: Implement** — (a) **C6 guard:** when `resolveTriggerAgent` returns a LIBRARY agent (home === systemId), assert `resolveOwnerUser(event.actor)` is non-null BEFORE firing; if null → log + skip (do NOT fire a caller-less library run). Local agents are unaffected. (b) **Accurate ordering comment** (fix the false claim): at the autonomy gate, comment "ORDER: resolve → allow-list → gate. The gate runs AFTER resolution and SUPPRESSES an agent-originated event (emits `agent.chain.suppressed`, zero runs) — it is NOT a pre-resolution filter. Correct because no run is created; do not reorder." (c) C4/C5 need no code change — they're pinned by the tests.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/trigger-matcher.ts apps/server/src/lib/trigger-matcher.test.ts
git commit -m "phase-C: forbid caller-less library targets + pin autonomy/caller on the fired path (C4/C5/C6)"
```

---

## Task 3.5: Floor MEDIUM on the unattended (trigger-fired) path

**Mitigations: C3.** The deterministic bound — config writes refuse on the fired path. ⚠️ **CORRECTED 2026-06-02 (orchestration-layer audit PC-2): the original file list was INCOMPLETE and would 500 every fired run.** Two real gaps the audit found: (i) `createRun` runs `agentRunFrontmatterSchema.parse(runFm)` under `.strict()` (`agent-runs.ts:227`) — an unschema'd `unattended` key THROWS, so the schema MUST gain the field first; (ii) `ToolContext` (`agent-tools.ts:25`) carries ONLY `token`/`actor`/`tx`/`callerScopes` — NOT run frontmatter — so the `folio_api` handler CANNOT read `unattended` without threading it through `executeTool` (a convergence point). The corrected file list + steps below.

**Files:**
- Modify: `apps/server/src/lib/agent-run-schema.ts` (**add `unattended: z.boolean().optional()` to the `.strict()` run frontmatter schema — REQUIRED FIRST, or `createRun`'s parse throws**)
- Modify: `apps/server/src/services/agent-runs.ts` (`createRun` stamps `frontmatter.unattended`, derived from `triggerId !== null && !resumeOf`)
- Modify: `apps/server/src/lib/agent-tools.ts` (**extend `ToolContext` + `executeTool` to carry an `unattended` flag — the same way `callerScopes` is threaded — this is the central executeTool gate, flag for `/code-review`**)
- Modify: `apps/server/src/lib/runner.ts` (**pass `fm.unattended` at the `executeTool` call site, mirroring how `fm.caller_scopes` is passed at `runner.ts:~389`**)
- Modify: `apps/server/src/lib/folio-api-tool.ts` (MEDIUM refuses when `ctx.unattended`)
- Test: `apps/server/src/lib/agent-run-schema.test.ts` + `apps/server/src/lib/folio-api-tool.test.ts` + `apps/server/src/services/agent-runs.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
test('agentRunFrontmatterSchema accepts unattended (optional) — createRun parse does not throw', () => {
  // .strict() schema: parsing a run fm with unattended:true must NOT throw (the field is in the schema)
});
test('createRun stamps frontmatter.unattended=true for a trigger-fired run, false/absent for a human-invoked run (C3)', async () => {
  // discriminator = triggerId !== null && !resumeOf (NOT firedBy — firedBy is a free-form provenance string).
  // a matcher-fired createRun (triggerId set) → unattended:true; a direct human run-launch (triggerId null) → absent/false;
  // a resume (resumeOf set) → NOT unattended (it's a continuation of a human-approved run).
});
test('folio_api MEDIUM refuses-with-plan on an unattended run, but applies on an attended (human) run (C3)', async () => {
  // unattended run: POST /tables (MEDIUM) → refused:true, plan defined, no mutation.
  // attended run: same POST → 201 (the floor is fired-path-only; humans keep MEDIUM via Phase B).
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement (ORDER MATTERS — schema first):**
  1. **`agent-run-schema.ts`:** add `unattended: z.boolean().optional()` to `agentRunFrontmatterSchema` (mirror Phase B Task 1's `agent_home_workspace_id`; the schema is `.strict()`, so this is the hard prerequisite — without it `createRun`'s `.parse()` throws on every stamp).
  2. **`createRun` (`agent-runs.ts`):** stamp `frontmatter.unattended = (input.triggerId != null && input.resumeOf == null)` — derive it server-side from the CLEAN signal (`triggerId` is on `CreateRunInput`; a trigger fire passes it, a human launch passes null, a resume passes `resumeOf`). Do NOT key off `firedBy` (a free-form string).
  3. **`agent-tools.ts` (the convergence point):** add `unattended?: boolean` to `ToolContext`; thread it through `executeTool` the SAME way `callerScopes` is — via the `caller` param (it already carries the run-derived `callerScopes`). Comment that this is the second run-derived field on the gate.
  4. **`runner.ts`:** at the `executeTool` call (~line 389, where `fm.caller_scopes` is already read), pass `fm.unattended`. MCP-path callers (no run fm) pass undefined → treated as attended (a human-invoked MCP `folio_api` is not a fired run).
  5. **`folio-api-tool.ts` write handler:** if `ctx.unattended === true && tier === 'medium'`, treat like HIGH (refuse-with-plan, structured plan, no dispatch). LOW still auto-applies; HIGH already refuses. Comment: "fired-path MEDIUM floor (C3) — DETERMINISTIC bound on the unattended injection chain; the B10 fence is best-effort for LOW only."

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean. (The `executeTool`/`ToolContext` change touches a convergence point — run the FULL server suite; existing agent-tools/mcp tests must stay green.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-run-schema.ts apps/server/src/services/agent-runs.ts apps/server/src/lib/agent-tools.ts apps/server/src/lib/runner.ts apps/server/src/lib/folio-api-tool.ts <test files>
git commit -m "phase-C: floor MEDIUM on the unattended fired path — schema field + executeTool threading (C3, PC-2 audit fix)"
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

## Task 5: Integration gate + the deterministic-bound verification + the LOW-injection smoke test

**Files:** verification only.

- [ ] **Step 1: Full suites** — server (`cd apps/server && bun test`, 0 fail), shared, web (`npx vitest run`). tsc per app.
- [ ] **Step 2: A real cross-workspace TRIGGER-FIRED run** — with a real key, wire a B trigger (by `target_agent_id`) to the `__system` operator (or a test library agent), cause the triggering event in B as a human, and confirm the fired run (a) loads its skill, (b) acts on B's data, (c) is bounded by the event-human's authority, (d) refuses a HIGH action. Drive via the composed loop (dispatcher + matcher + poller + runner).
- [ ] **Step 3: The DETERMINISTIC-BOUND verification (C3 — MANDATORY, the real merge gate).** This is NOT "prove injection is beaten" — it verifies the FLOOR + CEILING that bound it regardless of the fence:
  - **MEDIUM floor:** the trigger-fired run attempting a MEDIUM config write (create a table / alter a field) is REFUSED-with-plan (the `unattended` floor, Task 3.5). This is a DETERMINISTIC check (does the floor fire?), not a fuzzy injection test — it must pass.
  - **HIGH floor:** same for a HIGH action (already inherited).
  - **Caller ceiling:** the fired run cannot exceed the event-human's authority (a member-caused trigger can't drive a config write at all — member lacks `config:write`).
- [ ] **Step 3b: The LOW-injection SMOKE TEST (a signal, not a proof).** Seed malicious B content that causes a trigger AND instructs the fired library agent to delete a DOCUMENT (LOW — the only auto tier on the fired path). Observe whether the fence holds (the agent treats it as data, doesn't delete). **Framing: this is a smoke test of the best-effort B10 fence on the LOW path — a FAIL is a strong signal to strengthen the fence, but a PASS does NOT prove injection is beaten.** The acceptable bound for unattended LOW is "caller ceiling + best-effort fence — accepted residual" (the deterministic protection is the MEDIUM+HIGH floor in Step 3). Record the smoke-test outcome; if the fence fails even for LOW, weigh tightening (e.g. flooring LOW too on the fired path) — but that's a decision, not an automatic merge-block.
- [ ] **Step 4: `/integration`** then `/code-review high` (C1–C6 as input; confirm Phase A/B/Phase-1/folio_api not weakened), then `/shakeout` (the real trigger-fired run + the Step-3 deterministic-bound checks + the Step-3b smoke test + the `invariant-auditor` against `ARCHITECTURE-INVARIANTS.md` invariants 2/3/4/10), then merge. **At this point Phases A+B+C are the coherent cross-workspace operator — merge the branch to main if not already.**
- [ ] **Step 5: Commit** any gate-fix; `/evaluate` the A→C arc.

---

## Self-Review (run before dispatch)

**Spec coverage (Component 3c):** resolution by IMMUTABLE ID + home predicate, no slug-shadow (Task 1 — C1), the allow-list fire-gate skipped for library agents but run still caller-bounded (Task 2 — C2), the autonomy-gate library→library suppression + event-human caller + the caller-less-trigger forbid (Task 3 — C4/C5/C6), the **fired-path MEDIUM floor** (Task 3.5 — C3), library agents in the trigger-target UI (Task 4), the deterministic-bound verification + the LOW-injection smoke test (Task 5 — C3). Cross-workspace chains stay deferred (C4 gate off). ✅

**The four pre-dispatch review fixes (Stefan) are baked in:** (1) C3 is now a DETERMINISTIC bound (MEDIUM floored on the fired path, Task 3.5) — the shake-out is a smoke test of the best-effort fence on LOW, NOT a "proof" from one payload; (2) resolution is by immutable `target_agent_id` (Task 1) — no slug + local-first shadow of a trigger wired to a library agent; (3) the autonomy-gate ordering claim is corrected (resolve→gate; the gate suppresses post-resolution — Task 3) + a library→library suppression test; (4) caller-less (scheduled) triggers FORBID library targets (Task 3 — C6), since "authority = caller, sole" requires a caller.

**Placeholder scan:** test bodies have `// ...seed...` markers (deliberate fixture pointers). The trigger-target UI (Task 4) reuses Phase B Task 7's endpoint (don't duplicate). The `unattended` discriminator (Task 3.5) is DERIVED from the existing `firedBy`/actor discriminator (ground-truthed Task 1c), not a new input.

**Type consistency:** `getSystemWorkspaceId` (Phase A), `resolveTriggerAgent(db, eventWorkspaceId, payload)` (returns the agent DOC, not a slug — the C1 fix), `frontmatter.unattended` (Task 3.5 → folio_api), `resolveOwnerUser`/the autonomy gate (unchanged) — consistent. `createRun`'s Phase-B `agent_home` stamping is reused.

**Biggest risk flagged:** C3's bound is now DETERMINISTIC (MEDIUM+HIGH floor on the fired path, Task 3.5) — verify the floor actually fires for an unattended run (Task 5 Step 3), don't rely on the LOW smoke test as proof. C1's id-resolution (Task 1) is the subtlest correctness fix — a trigger wired by id to a library agent must NOT be shadowed by a later same-slug local agent; the test seeds exactly that. Re-grep the matcher resolution sites + the autonomy-gate ordering at HEAD (they shift).

---

## Execution Handoff

Plan complete. **Phases A + B must merge first.** Recommended: subagent-driven per task with two-stage review; controller verifies the named C-mitigation + ground-truths the matcher resolution/`resolveTargetAgentSlug`/the autonomy-gate ordering/the `unattended` discriminator/the trigger-target UI live (Step 2.5 gate). After Task 5: `/code-review high` (C1–C6), `/integration`, `/shakeout` (real trigger-fired run + the deterministic-bound checks + the LOW-injection smoke test), merge the full A→C cross-workspace operator. Phase D (library curation UI) is the last plan — UI-only, no execution-model change.
