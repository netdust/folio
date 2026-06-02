# Phase B — Cross-Workspace Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PREREQUISITE: Phase A (`__system` library foundation) must be built + merged first.** This plan resolves agents whose home is `__system` and reads skills from it. Plan: `docs/superpowers/plans/2026-06-02-phase-A-system-library-foundation.md`.

**Goal:** Make a library agent (defined in `__system`) runnable AGAINST any target workspace B — resolving the agent by id gated by a home-workspace predicate `{run-ws, __system}`, materializing its prompt + named skills via a NARROW definitional system-read (not caller-bounded), deriving the run's authority SOLELY from the caller in B, listing library agents in every workspace's run/assign UI, and enforcing the interim HIGH-tier-refuses-regardless-of-caller floor.

**Architecture:** Today `loadContext` resolves the agent by `(run.workspaceId + agent_slug)` — agent home == run workspace, hard-coded. Phase B splits "where the agent is defined" from "where it acts": the run frontmatter gains `agent_home_workspace_id` (the `__system` id for a library agent, or the run's own workspace id for a local agent — backward compatible); `loadContext` resolves the agent by id-in-home gated by `home ∈ {run.workspaceId, __system.id}` (the predicate is the security boundary — no cross-tenant capability borrowing). The agent's prompt + frontmatter-named skill docs are read from `__system` with SYSTEM authority via a narrow allow-list (definitional, not caller-bounded); the run's effective authority is the caller's (the agent side defers — `['*']`). High-risk writes refuse-with-plan regardless of caller until the approval-gate ships.

**Tech Stack:** Bun, Hono, Drizzle, SQLite. Touches `lib/runner.ts` (`loadContext`), `services/agent-runs.ts` (`createRun` — stamp `agent_home_workspace_id`), `lib/agent-run-schema.ts` (the frontmatter field), `lib/agent-projects.ts` (caller-sole authority for library agents), `lib/folio-api-tool.ts` (interim HIGH floor), + the web run/assign UI (list library agents). Reuses Phase A's `SYSTEM_WORKSPACE_SLUG` + the `folio_api` surface.

**Spec:** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 3, Component 4; Phase B). **Reference the corrected memories:** `project_operator-is-an-agent-not-a-seeded-bot`, `feedback_state-consequences-and-dont-flatter`.

---

## Threat model

> Phase B of the system-library build: cross-workspace agent execution — a `__system`-defined agent acting on a customer workspace B. Written 2026-06-02. This is the single highest-risk surface in the whole operator build: it crosses the multi-tenancy boundary AND introduces a definitional system-authority read. It EXTENDS Phase A (M1–M8) and the kept `folio_api` threat model (P3-1…P3-10). New attacks numbered **B1…BN**. This is the convergence target for `/code-review high` on Phase B — verify against the named mitigations.

### What we're defending

1. **The tenant data boundary** — a library agent acting in B must read/write ONLY B's data (its documents/tables), never another workspace C's, never `__system`'s customer-invisible content beyond the narrow skill exemption.
2. **The capability boundary** — an agent's PROMPT + tool set is its capability. A run must not borrow the prompt/tools of a private agent in a third workspace C (cross-tenant capability borrowing).
3. **The definitional-read exemption integrity** — the runner's SYSTEM-authority read of `__system` must touch EXACTLY the agent's own body + its frontmatter-named skill docs, nothing else in `__system`. It must not become a hole to read arbitrary library content, and it must not be reachable as a general tool.
4. **The caller ceiling** — `effective = caller` (agent side defers). A member-invoked library-agent run must get member reach in B; an admin-invoked run admin reach; NEVER more than the invoking human (`agent ∩ caller`, fail-closed).
5. **The BYOK key boundary** — a library agent running in B uses B's BYOK provider key (the customer's), resolved per-target-workspace; it must NOT read `__system`'s key for a customer run, nor leak B's key cross-workspace.
6. **The HIGH-tier floor** — until the approval-gate ships, a HIGH-risk action (token mint, workspace delete, ai-keys, bulk) refuses-with-plan REGARDLESS of caller — even an admin gets no silent auto-apply (everywhere-invokable + HIGH-open would put a destructive cross-tenant action one prompt-injection away).

### Who we're defending against

1. **A prompt-injected library agent** (IN scope) — steered by malicious B content into reading C's data, escalating, or borrowing another agent's capability. Mitigated by the resolution predicate, caller ceiling, narrow definitional read, HIGH floor, and the existing "treat untrusted context as data" fence.
2. **A customer member/admin in B invoking a library agent** (IN scope) — gets caller-bounded reach; cannot use the library agent to exceed their own authority in B or reach C.
3. **A customer trying to enumerate `__system`** (IN scope) — via the run, the definitional read, or a mis-scoped tool call. Must see only the narrow agent-body + named-skills, never the whole library.
4. **A malicious run record** (IN scope) — a forged/tampered `agent_home_workspace_id` or `caller_*` snapshot pointing at C or claiming broader authority. Mitigated: these are stamped server-side at `createRun`, never client-supplied (inherits the Phase-1 D2 rule).
5. **Insider with a stolen `__system`-owner session** (OUT of scope) — trust root.

### Attacks to defend against

1. **B1 — Cross-tenant capability borrowing via a forged/loose home.** A run resolves an agent whose home is a third workspace C (not B, not `__system`), grafting C's prompt + tool set onto a B run. (Class: capability borrowing / tenant bleed.)
2. **B2 — `agent_home_workspace_id` client-supplied / tampered.** If the run's home id can be set by the caller, an attacker points it at C or a privileged agent. (Class: trust-the-client.)
3. **B3 — Definitional read over-reach.** The runner's system-authority read of `__system` reads MORE than the agent body + named skills — enumerates skills, reads another agent's prompt, or reads customer-invisible library content. (Class: exemption widening.)
4. **B4 — Definitional read reachable as a tool.** The system-authority read path is exposed as (or reachable via) a tool/route, letting a caller read `__system` content they couldn't otherwise. (Class: confused-deputy on the exemption.)
5. **B5 — Authority leak: agent grants authority.** A library agent's own scopes/projects widen the run beyond the caller (e.g. the agent's `projects: ['*']` is read as "all of B's projects" regardless of the caller's narrower set). (Class: ceiling bypass — agent side fails to defer.)
6. **B6 — Cross-workspace BYOK key confusion.** A library agent run in B reads `__system`'s (or C's) provider key instead of B's, or B's key leaks into a `__system`/C context. (Class: credential cross-tenant confusion.)
7. **B7 — HIGH-risk silent auto-apply for a privileged caller.** An admin-invoked library agent silently auto-applies a HIGH-risk action (the everywhere-invokable + HIGH-open combination). (Class: missing risk floor.)
8. **B8 — Run targets a workspace the caller can't reach.** A caller in B starts a library-agent run but the run acts on a workspace the caller has no membership in (target ≠ caller's workspace). (Class: tenant boundary via run targeting.)
9. **B9 — Skill-slug injection in the definitional read.** A malicious agent frontmatter lists a skill slug crafted to traverse/escape the `__system` Skills project (e.g. a slug that matches a doc outside Skills). (Class: injection via the allow-list key.)

### Mitigations required

1. **B1/B2 → resolution is by id, gated by `home ∈ {run.workspaceId, __system.id}`, and `agent_home_workspace_id` is stamped server-side at `createRun`, never client-supplied.** `loadContext` resolves the agent by `(agent_home_workspace_id, type='agent', agent_slug)` and ASSERTS `agent_home_workspace_id === run.workspaceId || agent_home_workspace_id === systemWorkspaceId`; otherwise returns null (fail-closed). `createRun` derives `agent_home_workspace_id` from where the agent was RESOLVED at run-creation (B's own agent, or `__system`), never from request input. Tests: a run with home = a THIRD workspace C → `loadContext` returns null (B1); the run-create path rejects/ignores a client-supplied `agent_home_workspace_id` and stamps the server-derived value (B2).
2. **B3/B9 → the definitional read is a single narrow function with an allow-list keyed on (system workspace, Skills project, exact skill slug).** A `loadAgentDefinition(db, agent)` reads the agent's own `body` (already in hand from resolution) + for each slug in `agent.frontmatter.skills`, a findFirst `(workspaceId = systemWorkspaceId, projectId = skillsProjectId, slug = <exact slug>)`. It reads NOTHING else from `__system`. A skill slug that doesn't resolve to a doc IN the Skills project → a clear "missing skill" error (no fallback to a broader query). Tests: a frontmatter naming skill `folio` loads exactly that doc; a frontmatter naming a non-Skills `__system` doc slug (e.g. another agent's slug, or a Reference doc) → NOT loaded (returns missing-skill, proving the read can't reach outside Skills) (B3/B9).
3. **B4 → the definitional read is NOT a tool and NOT a route.** `loadAgentDefinition` lives in the runner and is called ONLY by `loadContext`; it is not registered in `agent-tools-registry`, not reachable via `folio_api`/`folio_api_get` (those are caller-bounded and 403/404 a non-`__system` member on `__system` paths — unchanged from Phase A). A test: a caller calls `folio_api_get` against a `__system` Skills doc path → 403/404 (caller-bounded, no exemption), while the runner's `loadAgentDefinition` reads it for a run (the exemption is internal-only).
4. **B5 → for a library agent, the agent side of the authority intersection DEFERS (`['*']` projects, scopes = the agent's tool-derived capability only), so `effective = caller`.** In `loadContext`, when `agent_home_workspace_id === systemWorkspaceId`, the project narrowing uses `intersectAgentProjects(['*'], callerProjectIds)` — the agent contributes NO project constraint; the caller's `caller_project_ids` (resolved in B at createRun) is the sole project ceiling. The scope ceiling is unchanged (`executeTool` already does `token.scopes ∩ callerScopes`); the agent's token scopes are its CAPABILITY (which tools), and the caller scopes are the AUTHORITY — a member caller can't exceed member scopes. Tests: a MEMBER-invoked library-agent run is denied a `config:write` action in B (caller lacks it), an OWNER-invoked one is allowed (modulo B7); a library agent with `projects:['*']` does NOT reach a B project the caller is not allow-listed for (B5).
5. **B6 → the BYOK key is resolved for the TARGET workspace B, always.** `loadContext` already resolves the key by the run's workspace (`run.workspaceId` = B); confirm + test that a library-agent run reads B's `ai_keys` row, NEVER `__system`'s. If B has no key for the run's provider → the existing `no_ai_key` pre-flight failure (graceful), NOT a fallback to `__system`'s key. A test: a library-agent run in B with B-having-an-anthropic-key uses B's key; with B lacking it → `no_ai_key` (no `__system` fallback) (B6).
6. **B7 → the interim HIGH-tier floor: `classifyRisk` HIGH refuses-with-plan REGARDLESS of caller, until the approval-gate ships.** The `folio_api` write tool's high branch (already refuses-with-plan) is confirmed to NOT have a caller-privilege bypass — there is no "admin → auto-apply HIGH" path in v1. The `// TODO(approval-gate)` marks where a future deliberate relaxation lands. A test: an OWNER/admin-invoked library-agent run attempting a HIGH action (e.g. `DELETE /w/:slug`) is REFUSED-with-plan (not applied), same as a member (B7). (This is mostly a confirmation + a guard test — the kept `folio_api` already refuses high regardless; Phase B pins it so the everywhere-invokable change doesn't silently open it.)
7. **B8 → a run's target workspace is the caller's workspace; the caller's authority is resolved IN the target.** `createRun` stamps `run.workspaceId` = the workspace the caller invoked FROM (where they have membership), and `caller_scopes`/`caller_project_ids` are resolved from the caller's membership IN that workspace (the existing Phase-1 server-side snapshot). A library agent can't be invoked to act on a workspace the caller isn't a member of (the invoke surface only offers library agents within the caller's accessible workspaces). A test: a run's `workspaceId` always matches a workspace the caller is a member of; the caller snapshot is from that workspace (B8).

### Out of scope (explicit deferrals)

- **Cross-workspace TRIGGERS firing library agents** — Phase C. Phase B is human-invocation (run/assign/Cmd-K) only; the trigger-matcher's `workspaceId`-bound resolution is unchanged here.
- **The approval-gate (relaxing the HIGH floor for trusted callers)** — Phase 3.x; the floor (refuse-regardless) is the v1 default.
- **Library agent CHAINS** (a library agent firing another) — `FOLIO_AGENT_CHAINS_ENABLED` stays off; OP1-F8 prerequisite.
- **`list_skills` runtime discovery / dynamic skill loading** — skills are bound by slug in frontmatter, materialized at load; no runtime browse.
- **Sharing a BYOK key across workspaces** (e.g. an instance-level key) — each workspace uses its own; no `__system` key fallback.
- **Library curation UI** — Phase D; Phase B lists library agents in the run/assign surface but full library management is later.

### How to use this section

- **Controller pre-flight:** verify each task carries its named B-mitigation before dispatch; ground-truth the `loadContext`/`createRun`/`agent-projects` surfaces (they changed since Phase 1 — read live).
- **`/code-review high`:** "Verify against the Phase B threat model (B1–B9) AND confirm Phase-1 (D1–D10) + the `folio_api` threat model (P3-1…P3-10) + Phase A (M1–M8) are not weakened. Headline checks: the resolution predicate `home ∈ {run-ws, __system}` (B1) + server-stamped `agent_home_workspace_id` (B2); the definitional read touches ONLY agent-body + named-skills-in-Skills and is NOT a tool/route (B3/B4); the agent side DEFERS so effective=caller (B5); BYOK is B's key never `__system`'s (B6); HIGH refuses regardless of caller (B7)."
- **`/evaluate` retro:** any missing B-mitigation → plan-correction defect.
- **Downstream (Phase C):** inherits B1–B9; Phase C EXTENDS the resolution predicate to the trigger-matcher — do not re-litigate the run-path mitigations.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/agent-run-schema.ts` | Add `agent_home_workspace_id: z.string()` to the run frontmatter (server-stamped). | Modify |
| `apps/server/src/services/agent-runs.ts` | `createRun` resolves + stamps `agent_home_workspace_id` server-side (from where the agent was found: B or `__system`); never from input. | Modify |
| `apps/server/src/lib/runner.ts` | `loadContext`: resolve agent by id-in-home gated by the `{run-ws, __system}` predicate; `loadAgentDefinition` (the narrow definitional read); library-agent authority defers (`['*']` agent side); confirm BYOK = B's key. | Modify |
| `apps/server/src/lib/agent-projects.ts` | Confirm/extend the caller-sole behavior for library agents (agent side `['*']`). | Modify (likely confirm + a test) |
| `apps/server/src/lib/system-workspace.ts` (Phase A) | Reuse `SYSTEM_WORKSPACE_SLUG` + a `getSystemWorkspaceId(db)` helper (cache the id). | Modify (add the helper) |
| `apps/server/src/lib/folio-api-tool.ts` | Confirm + guard the HIGH-refuses-regardless-of-caller floor (mostly a test). | Modify (guard test) |
| `apps/web/src/...` (run/assign surfaces) | List library agents (from `__system`) alongside the workspace's own agents in the run launcher / assign / @-mention picker; selecting one creates a run with the server resolving home=`__system`. | Modify |
| Tests per file | TDD | Create |

> **Open ground-truth the implementer MUST resolve in Task 1:** (a) the exact `createRun` signature + how it currently derives `agent_slug` + `workspaceId` (`services/agent-runs.ts`); (b) the web run/assign surfaces that list agents (how they query the workspace's agents — to add the `__system` agents); (c) whether `getSystemWorkspaceId` should be cached (it's a hot path in `loadContext`) — confirm a memoized lookup is safe (the `__system` id never changes after bootstrap).

---

## Task 1: Ground-truth + `getSystemWorkspaceId` helper + the run-frontmatter field

**Mitigations: B2 (the field), foundation for B1.**

**Files:**
- Modify: `apps/server/src/lib/system-workspace.ts` (add `getSystemWorkspaceId`), `apps/server/src/lib/agent-run-schema.ts` (add the field)
- Test: `apps/server/src/lib/system-workspace.test.ts`, `apps/server/src/lib/agent-run-schema.test.ts`

- [ ] **Step 1: Resolve the three ground-truth items** (read, don't code): the `createRun` signature + its current `agent_slug`/`workspaceId` derivation; the web agent-listing surfaces; confirm the `__system` id is stable post-bootstrap. Write findings as a comment block at the top of the new code.

- [ ] **Step 2: Write the failing test** — `getSystemWorkspaceId(db)` returns the `__system` workspace id (and a stable/cached value); the run schema accepts `agent_home_workspace_id`.

```typescript
test('getSystemWorkspaceId returns the bootstrapped __system id', async () => {
  const { db } = await makeTestApp();
  await bootstrapSystemWorkspace(db); // Phase A
  const id = await getSystemWorkspaceId(db);
  const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  expect(id).toBe(sys!.id);
});

test('agentRunFrontmatterSchema accepts agent_home_workspace_id', () => {
  const fm = agentRunFrontmatterSchema.parse({ /* ...a valid run fm... */, agent_home_workspace_id: 'ws_abc' });
  expect(fm.agent_home_workspace_id).toBe('ws_abc');
});
```

- [ ] **Step 3: Run to verify fail** — FAIL.

- [ ] **Step 4: Implement** — `getSystemWorkspaceId(db)` (findFirst by `SYSTEM_WORKSPACE_SLUG`, return id; memoize per-process since the id is immutable post-bootstrap — but invalidate on `__resetDbForTests` so tests are isolated, OR don't memoize if simpler/safe). Add `agent_home_workspace_id: z.string()` to `agentRunFrontmatterSchema` (required — server always stamps it; for backward-compat with existing runs, a `.default('')` or a migration backfill — see Task 6 / decide: existing runs predate this; default to the run's own workspaceId at read OR backfill. Prefer: `.optional()` in the schema + `loadContext` treats absent as "home = run.workspaceId" (local agent, backward compatible)).

- [ ] **Step 5: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/system-workspace.ts apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/*.test.ts
git commit -m "phase-B: getSystemWorkspaceId + agent_home_workspace_id run field + ground-truth (B2)"
```

---

## Task 2: `createRun` stamps `agent_home_workspace_id` server-side

**Mitigations: B2, B8.**

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts` (`createRun`)
- Test: `apps/server/src/services/agent-runs.test.ts`

- [ ] **Step 1: Write the failing test** — `createRun` for a B-local agent stamps `agent_home_workspace_id = B`; for a `__system` agent stamps `= __system`; a client-supplied value in the input is IGNORED.

```typescript
test('createRun stamps agent_home_workspace_id from where the agent was resolved, not from input (B2)', async () => {
  // create a run for a local agent → home = the run's workspace
  // create a run for a __system agent → home = __system id
  // pass a bogus agent_home_workspace_id in any client-facing input → it is ignored/overwritten
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — in `createRun`, after resolving the target agent (the agent being run), set `frontmatter.agent_home_workspace_id = resolvedAgent.workspaceId` (which is B for a local agent, the `__system` id for a library agent). NEVER read it from caller input. The caller-authority snapshot (`caller_scopes`/`caller_project_ids`) stays resolved from the caller's membership in `run.workspaceId` = B (unchanged Phase-1 behavior — B8).

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/agent-runs.ts apps/server/src/services/agent-runs.test.ts
git commit -m "phase-B: createRun stamps agent_home_workspace_id server-side (B2/B8)"
```

---

## Task 3: `loadContext` — resolve by home gated by `{run-ws, __system}`

**Mitigations: B1.** The security boundary.

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (`loadContext` agent resolution)
- Test: `apps/server/src/lib/runner.test.ts` (or the relevant loadContext test file)

- [ ] **Step 1: Write the failing test** — a run with home = B's own ws resolves a B agent; home = `__system` resolves a library agent; home = a THIRD workspace C → null (B1).

```typescript
test('loadContext resolves a __system library agent for a run acting in B (B1)', async () => {
  // seed __system + an operator agent + a run in B with agent_home_workspace_id = __system, agent_slug = the operator
  // loadContext returns a context whose agent is the __system operator, run acts in B
});
test('loadContext REJECTS a run whose agent_home is a third workspace C (B1)', async () => {
  // a run in B with agent_home_workspace_id = C (neither B nor __system) → loadContext returns null
});
test('loadContext is backward-compatible: absent agent_home → home = run workspace (local agent)', async () => {
  // an existing-style run with no agent_home_workspace_id resolves the agent in run.workspaceId
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — replace the hard-coded `eq(documents.workspaceId, run.workspaceId)` in the agent resolution with:
  - `const home = fm.agent_home_workspace_id ?? run.workspaceId;` (absent = local, backward compatible).
  - `const systemId = await getSystemWorkspaceId(db);`
  - **Assert the predicate:** `if (home !== run.workspaceId && home !== systemId) return null;` (B1 — fail-closed: home must be the run's own workspace or `__system`).
  - Resolve: `findFirst({ where: and(eq(documents.workspaceId, home), eq(documents.type, 'agent'), eq(documents.slug, fm.agent_slug)) })`.
  - The rest of `loadContext` (workspace = run.workspaceId = B, project, token-by-agentId) is unchanged — the agent's token is its capability; authority narrowing happens in Task 5.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-B: loadContext resolves agent by home gated by {run-ws, __system} (B1)"
```

---

## Task 4: `loadAgentDefinition` — the narrow definitional skill read

**Mitigations: B3, B4, B9.**

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (add `loadAgentDefinition`, call it in `loadContext`)
- Test: `apps/server/src/lib/runner.test.ts`

- [ ] **Step 1: Write the failing test** — the agent body + named-skills-in-Skills load; a non-Skills `__system` slug does NOT; the function is not a registered tool.

```typescript
test('loadAgentDefinition reads the agent body + frontmatter-named skills from __system Skills (B3)', async () => {
  // agent with frontmatter.skills = ['folio']; assert the loaded definition includes the folio skill body
});
test('loadAgentDefinition CANNOT read a non-Skills __system doc via a skill slug (B3/B9)', async () => {
  // frontmatter.skills = ['<the Reference doc slug>'] or ['<another agent slug>'] → missing-skill error, NOT loaded
});
test('a non-__system-member caller cannot read the same skill via folio_api_get (B4 — exemption is internal-only)', async () => {
  // folio_api_get against the __system Skills doc path with a non-member caller → 403/404
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — `loadAgentDefinition(db, agent)`:
  - The agent body is already in hand (`agent.body`).
  - `const systemId = await getSystemWorkspaceId(db); const skillsProjectId = <findFirst Skills project in __system>.id;`
  - For each `slug` in `(agent.frontmatter.skills ?? [])`: `findFirst({ where: and(eq(documents.workspaceId, systemId), eq(documents.projectId, skillsProjectId), eq(documents.slug, slug), eq(documents.type, 'page')) })`. If absent → throw a clear `MISSING_SKILL` (no broader fallback — B3/B9). Collect the bodies.
  - Return `{ prompt: agent.body, skills: [{slug, body}...] }`. Call it in `loadContext` AFTER agent resolution; the materialized skills are prepended/attached to the run's initial messages (the runner's `buildInitialMessages` — wire the skills in as system/context content, fenced as the agent's own definition).
  - It is NOT exported to `agent-tools-registry`, NOT a route — a comment states the exemption is internal-only (B4).

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-B: loadAgentDefinition — narrow definitional skill read, internal-only (B3/B4/B9)"
```

---

## Task 5: Library-agent authority defers to the caller (effective = caller)

**Mitigations: B5, B6.**

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (`loadContext` project narrowing for library agents) + confirm `apps/server/src/lib/agent-projects.ts`
- Test: `apps/server/src/lib/runner.test.ts`

- [ ] **Step 1: Write the failing test** — a member-invoked library-agent run is denied a `config:write` action in B; the agent's `projects:['*']` does NOT reach a B project the caller isn't allow-listed for; BYOK = B's key.

```typescript
test('a member-invoked library-agent run cannot do config:write in B (effective=caller) (B5)', async () => {
  // run a __system agent in B with caller = a member (no config:write); a folio_api config write is denied
});
test('a library agent projects:[*] does not exceed the caller project set in B (B5)', async () => {
  // caller narrowed to project P1; the agent (projects [*]) cannot touch P2 in B
});
test('the run uses B BYOK key, never __system (B6)', async () => {
  // B has an anthropic key; the run resolves B's key. __system has a different/none → not used.
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — in `loadContext`, when `home === systemId` (library agent): the project narrowing uses the AGENT side `['*']` (defer), so `narrowedToken.projectIds = intersectAgentProjects(['*'], callerProjectIds)` — the caller's set is the sole ceiling. (For a local agent, keep the existing `intersectAgentProjects(token.projectIds ?? ['*'], callerProjectIds)`.) The scope ceiling is unchanged (`executeTool` does `token.scopes ∩ callerScopes` — the agent's tool-derived scopes are capability, caller scopes are authority). Confirm the BYOK key resolves by `run.workspaceId` (= B) and assert no `__system` fallback (B6).

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/agent-projects.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-B: library-agent authority defers to caller; BYOK is B's key (B5/B6)"
```

---

## Task 6: Confirm + guard the interim HIGH-tier floor

**Mitigations: B7.**

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (a guard comment; the behavior already refuses high) + a test
- Test: `apps/server/src/lib/folio-api-tool.test.ts`

- [ ] **Step 1: Write the failing/guard test** — an OWNER/admin-invoked HIGH action is REFUSED-with-plan, same as a member (no caller-privilege bypass).

```typescript
test('HIGH-risk refuses-with-plan REGARDLESS of caller privilege (B7)', async () => {
  // folio_api DELETE /w/:slug (high) with an OWNER-scoped caller token → refused:true, plan defined, no mutation
  // (same outcome as the member case — there is NO admin auto-apply path in v1)
});
```

- [ ] **Step 2: Run to verify** — the kept `folio_api` already refuses high unconditionally, so this test likely PASSES immediately (it's a guard/regression pin). If it does, that's correct — the test exists to PREVENT a future "admin → auto-apply" relaxation from sneaking in without a deliberate approval-gate. Add a comment at the high branch: "INTERIM FLOOR (Phase B / threat model B7): HIGH refuses regardless of caller until the approval-gate ships; do not add a caller-privilege bypass here without the approval-gate."

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-B: pin the interim HIGH-refuses-regardless-of-caller floor (B7)"
```

---

## Task 7: List library agents in every workspace's run/assign UI

**Mitigations: supports B8 (invoke surface stays within the caller's workspaces).**

**Files:**
- Modify: the web agent-listing surfaces (ground-truthed in Task 1b) — the run launcher / assign / @-mention picker; the server endpoint they read (likely the workspace agents list).
- Test: web (vitest) + a server test if the listing endpoint changes.

- [ ] **Step 1: Write the failing test** — the run/assign picker in workspace B shows B's own agents PLUS the `__system` library agents; selecting a library agent creates a run with the server resolving `agent_home_workspace_id = __system`.

> Ground-truth (Task 1b) the exact surface. The server change is likely: the agents-list endpoint a workspace's run/assign UI reads should UNION the workspace's own `type='agent'` docs with `__system`'s `type='agent'` docs (clearly marked as library agents so the UI can badge them). The run-create path already resolves the agent + stamps home server-side (Task 2), so the UI just needs to OFFER them.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — extend the agents-list the run/assign UI consumes to include `__system` library agents (union, badged `library: true`). When the user picks one, the run-create call references it; `createRun` (Task 2) stamps `agent_home_workspace_id = __system`. Keep the listing within the caller's accessible workspace context (the caller is in B; library agents are offered because they're instance-wide, not because the caller is a `__system` member — they're CAPABILITY, invoked with B-caller authority). Confirm a non-member of `__system` can still SEE + invoke a library agent (it's offered to everyone) but the agent acts with the caller's B authority (Task 5).

- [ ] **Step 4: Run to verify pass + tsc (web + server)** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/... apps/server/src/... <test files>
git commit -m "phase-B: list __system library agents in every workspace's run/assign UI"
```

---

## Task 8: Integration gate + shake-out with a real run

**Files:** verification only.

- [ ] **Step 1: Full suites** — server (`cd apps/server && bun test`, 0 fail), shared, web (`npx vitest run`). tsc per app.
- [ ] **Step 2: A real library-agent run end-to-end** (the load-bearing proof — this is what the seeded-bot attempt NEVER did and the final review caught): with a real Anthropic key on a test/dev instance, invoke the `__system` operator agent FROM a customer workspace B, and confirm it (a) loads its skill (definitional read), (b) acts on B's data, (c) is denied anything beyond the caller's authority, (d) refuses a HIGH action with a plan. Drive it via the composed loop (poller + runner) or the diagnose-http-chain harness pattern.
- [ ] **Step 3: `/integration`** then announce `/code-review high` over the Phase-B diff (threat model B1–B9 as input; confirm Phase-1 + folio_api + Phase-A not weakened), then `/shakeout` (the real run above + the `invariant-auditor` against `ARCHITECTURE-INVARIANTS.md` invariants 2/3/4/10), then merge.
- [ ] **Step 4: Commit** any gate-fix.

---

## Self-Review (run before dispatch)

**Spec coverage (Component 3 + 4):** agent resolution predicate `{run-ws, __system}` (Tasks 1-3 — B1/B2), definitional skill read narrow + internal-only (Task 4 — B3/B4/B9), authority = caller-sole + BYOK = B's key (Task 5 — B5/B6), interim HIGH floor (Task 6 — B7), library agents in every workspace's run/assign UI (Task 7 — B8), real-run shake-out (Task 8). Cross-workspace TRIGGERS = Phase C (out of scope); the approval-gate relaxation = Phase 3.x (out of scope). ✅

**Placeholder scan:** several test bodies have `// ...seed...` / `// ...` markers where the implementer fills in the run/agent fixtures from the real schema + the Task-1 ground-truth — deliberate pointers, not TBDs (the surrounding assertions are concrete). The web surface (Task 7) is ground-truthed in Task 1b rather than guessed — flagged as the one place needing live reads before the test is concrete.

**Type consistency:** `getSystemWorkspaceId(db)`, `agent_home_workspace_id`, `loadAgentDefinition(db, agent)`, the `home ∈ {run-ws, __system}` predicate, `intersectAgentProjects(['*'], callerProjectIds)` for library agents — used consistently. The kept `folio_api` HIGH-refuse behavior is confirmed, not re-implemented.

**Biggest risk flagged:** the resolution predicate (Task 3) + the definitional read (Task 4) are the load-bearing security mechanisms — B1 (no third-workspace home) and B3/B4 (the exemption can't widen or become a tool) must be verified hardest at `/code-review`. The real-run shake-out (Task 8) is MANDATORY — the seeded-bot attempt shipped 10 green tasks that never ran the agent; do not repeat that. The web surface (Task 7) is the least-specified — ground-truth it first.

---

## Execution Handoff

Plan complete. **Phase A must merge first.** Recommended: subagent-driven per task with two-stage review; controller verifies the named B-mitigation per task + ground-truths `loadContext`/`createRun`/`agent-projects`/the web surface (Step 2.5 gate). After Task 8: `/code-review high` (B1–B9 as input), `/integration`, `/shakeout` with a real key (the actual cross-workspace run), merge. Phase C (cross-workspace triggers) is the next plan.
