# Operator Agent — Phase 1: Caller-Identity Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `netdust-core:ntdst-execute-with-tests` (wraps `superpowers:subagent-driven-development`) to implement this plan task-by-task. Step 2.5 plan-freshness per task; two-stage review per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent run carry the **caller's** authority, not just the agent's, and **intersect** the two at tool-execution time — so an agent can never exceed the permissions of the human who started its run.

**Architecture:** Today a run executes with the agent's auto-minted token; the token's scopes + `projectIds` are the sole authority (`runner.ts` loads `apiTokens` by `agent.id`; `executeTool(token, …)` checks `token.scopes`). This phase threads a **caller scope set** + **caller project set** onto the run at `createRun`, then at tool dispatch computes `effective = agent ∩ caller` for BOTH scopes and projects. It extends the EXISTING `intersectAgentProjects(agentProjects, token.projectIds)` precedent in `agent-tools-registry.ts:183` to a full delegate model. No new tables for v1 — the caller authority rides two new nullable columns on the run row + a new `ToolContext` field carrying the caller's effective set.

**Tech Stack:** Hono + Drizzle + bun:sqlite; the shared `executeTool`/`agent-tools.ts` dispatcher; `agent-run-schema.ts` (Zod run frontmatter); `services/agent-runs.ts::createRun`; `lib/runner.ts` `RunContext`; `lib/agent-projects.ts` intersect helpers; Bun test.

**Scope note:** This is Phase 1 of a 3-phase spec (`docs/superpowers/specs/2026-06-01-builtin-folio-operator-agent-design.md`). Phase 2 (token-scoped API surface + `dryRun`) and Phase 3 (the agent + skill + memory) get their own plans. This plan produces working, testable software on its own: after it, every run enforces the delegate ceiling, even though no new tools exist yet (the existing 20 tools immediately benefit).

**Ground-truth (verified vs live source 2026-06-01, branch `phase-3.x/agent-ergonomics`, HEAD `69a0e5e`):**
- `executeTool(token: ApiToken, actor: string, name, args, tx?)` — `agent-tools.ts:127`. Token = authority; scope check at `:146` is `token.scopes.includes(def.requiredScope)`. **No caller intersect today.**
- `ToolContext` = `{ token, actor, tx? }` — `agent-tools.ts:25`.
- Runner resolves the agent's token by `agent.id` — `runner.ts:307`; passes `executeTool(ctx.token, ctx.actor, …)` — `runner.ts:697`.
- `RunContext` carries `token`, `actor` (`agent:<slug>`), `transitionActor` (FK-valid `run.createdBy`) — `runner.ts:118-135`.
- `CreateRunInput` — `agent-runs.ts:57`; the run row is stamped `createdBy: actor.id` at `:170`. **`createdBy` is where the human caller already lives.**
- Project allow-list intersect precedent: `intersectAgentProjects(resolveAgentProjects(agent), token.projectIds ?? null)` — `agent-tools-registry.ts:183`; helpers in `agent-projects.ts:33,61`.
- Run frontmatter schema — `agent-run-schema.ts` (Zod); `fired_by: z.string()` at `:85`.

---

## Threat model

> Written 2026-06-01 at plan time for the caller-identity delegation keystone (Phase 1 of the operator-agent spec). The surface is auth/token-authority + multi-tenancy isolation: this phase changes WHO a run acts as and adds a new authorization-narrowing path. Without this section, `/code-review` would re-discover the privilege-escalation and intersect-bypass surface independently each round. This is the convergence target. It EXTENDS the Phase 3 agent-runner threat model (mitigations 1–66) — this plan adds mitigations **D1–D10**; it does not re-litigate the inherited ones.

### What we're defending

- **A1 — The delegate ceiling**: the invariant that a run's effective authority never exceeds `agent_scopes ∩ caller_scopes` and `agent_projects ∩ caller_projects`. This IS the feature; breaking it is the whole risk.
- **A2 — Workspace/project isolation**: the existing multi-tenancy boundary (`token.workspaceId`, project allow-list). The new caller-project intersect must NARROW, never widen, this boundary.
- **A3 — The caller-authority snapshot** stored on the run row (`caller_scopes`, `caller_project_ids`) — it must be reproducible, tamper-evident from the API surface, and never client-supplied.
- **A4 — The agent's auto-minted token** (`apiTokens` row, `agentId`-bound, carries `scopes` + `projectIds`) — still the agent-side half of the intersect; unchanged but now load-bearing in a new way.
- **A5 — Audit fidelity**: events/comments emitted by a run must still attribute to an FK-valid actor (`run.createdBy`), so a delegated action is traceable to the human who authorized it.

### Who we're defending against

- **External attacker, no account** — OUT of scope for THIS phase (no new unauthenticated surface added; the bearer-auth wall is unchanged). IN scope only insofar as the new run columns must not be settable via any request body.
- **Authenticated member with LOW scopes who starts a run on a HIGH-scope agent** — **IN scope (primary threat).** The whole point: a member must not borrow the agent's broader authority. The intersect must clamp to the member.
- **Authenticated member of workspace X trying to reach workspace Y / a project they're not in** — **IN scope.** The caller-project intersect must never let a run touch a project the caller lacks.
- **A prompt-injected / steered agent** — **IN scope (bounded).** Even fully steered, the agent cannot exceed the caller ceiling — that's the structural mitigation. We do NOT additionally defend against the agent doing *anything the caller could legitimately do* (that's the caller's own authority; the gate for risky actions is Phase 3's plan/apply, out of scope here).
- **Insider with stolen human credentials** — OUT of scope (acknowledged; stolen creds = full caller authority by definition; not defendable at this layer).

### Attacks to defend against

1. **D1 — Caller authority not captured → run still acts as the agent.** If `createRun` doesn't record the caller's scopes/projects, the intersect has nothing to clamp against and falls open to the agent's full authority (silent no-op of the entire feature).
2. **D2 — Client-supplied caller authority.** If `caller_scopes` / `caller_project_ids` can be set from a request body (HTTP `POST /runs` or MCP `run_agent`), a low-scope caller forges a high-scope snapshot and escalates.
3. **D3 — Intersect computed but not enforced at dispatch.** The snapshot is stored but `executeTool` still checks only `token.scopes` (the agent's), so the ceiling is decorative.
4. **D4 — Project intersect widens instead of narrows.** A bug in set logic (`∪` instead of `∩`, or `['*']` from the caller treated as "all" when the caller is actually project-limited) lets a run reach a project the caller can't.
5. **D5 — Wildcard handling asymmetry.** `resolveAgentProjects` returns `['*']` for an unconfigured allow-list (wildcard = all). If the CALLER side mis-maps "caller has no project restriction" to `['*']` when the caller is in fact workspace-scoped-but-not-all-projects, the intersect over-grants.
6. **D6 — Resume/retry loses the caller snapshot.** A `resume_of` or `retry-of` run that re-derives authority from the agent (not the original run's snapshot) escalates on the second hop — the approved-plan resume is exactly where a careless re-mint would re-open the ceiling.
7. **D7 — Scope-narrowing leaks the rejected value.** When the intersect denies a tool, the error must surface the missing scope NAME only (paths/names), never the caller's full scope list or the agent's — consistent with the inherited mitigation 26/28 paths-only rule.
8. **D8 — Audit actor decoupled from caller.** If the delegated run emits events as `agent:<slug>` with no link back to `run.createdBy`, a delegated mutation can't be traced to the authorizing human (audit-integrity break).
9. **D9 — Empty-intersect falls open.** If `agent ∩ caller = ∅` is treated as "no restriction" (e.g. an empty array meaning "all" somewhere downstream), a zero-overlap run gets FULL access instead of NONE.
10. **D10 — Backfill / null-column ambiguity on existing runs.** Pre-migration run rows have NULL caller columns. If NULL is read as "unrestricted caller" (`['*']`), every historical or in-flight run silently bypasses the new ceiling.

### Mitigations required (numbered to match D1–D10; each code-checkable)

1. **D1 — `createRun` captures the caller snapshot from the AUTHENTICATED actor, server-side.** `CreateRunArgs.actor` already carries the resolved user/token (`agent-runs.ts:170` stamps `createdBy: actor.id`). Add a `callerAuthority: { scopes: string[]; projectIds: string[] | null }` field DERIVED inside `createRun` from `actor` (the session user's effective scopes + project memberships, or the human PAT's `scopes`/`projectIds`) — never from `input`. Persist to two new columns. Test: a run created by a low-scope caller stores exactly that caller's scopes.
2. **D2 — Caller authority is NOT in any request schema.** `documentPatchSchema`, the HTTP `POST /runs` body schema, and the MCP `run_agent` input schema MUST NOT contain `caller_scopes`/`caller_project_ids`/`callerAuthority`. Test: posting those keys in the body is ignored (strict schema strips them); the stored snapshot reflects the authenticated actor, not the body. Grep all three schemas for the field names → must be absent.
3. **D3 — `executeTool` enforces the intersect.** `ToolContext` gains `callerScopes: string[]` + `callerProjectIds: string[] | null`. The scope check at `agent-tools.ts:146` becomes: `requiredScope ∈ token.scopes AND requiredScope ∈ callerScopes`. Test: a tool needing `documents:write`, agent token HAS it, callerScopes does NOT → `forbidden: scope documents:write missing` (NOT executed).
4. **D4 — Project intersect uses the existing `intersectAgentProjects`, applied a SECOND time against the caller.** Effective projects = `intersectAgentProjects(intersectAgentProjects(agentProjects, token.projectIds), callerProjectIds)`. Reuse the audited helper; do not hand-roll set logic. Test: agent allow-lists [P1,P2], caller is in [P1] only → effective [P1]; a tool targeting P2 is rejected with the existing `agent_not_in_allow_list` shape.
5. **D5 — Wildcard semantics are explicit and asymmetric-safe.** `['*']` means "all projects in the workspace" ONLY when it genuinely is (agent unconfigured). The CALLER side maps to `['*']` IFF the caller is a workspace owner/admin (full project access); a regular member maps to their actual `projectIds` membership list, never `['*']`. Encode this in a single `callerProjectsFor(actor): string[]` helper in `agent-projects.ts`, unit-tested for owner→`['*']`, member→explicit list.
6. **D6 — Resume/retry INHERITS the original run's caller snapshot, never re-derives.** `runAgentResume` and the `retry-of` path read `caller_scopes`/`caller_project_ids` from the ORIGINAL run row and copy them onto the new row (same as `chain_id` inheritance today). Test: resume of a low-scope run stays low-scope even if the agent's token is broad.
7. **D7 — Denied-intersect errors are name-only.** The `forbidden: scope <name> missing` message names ONLY the single missing scope (already the shape at `:147`); the project rejection reuses the existing `agent_not_in_allow_list` `{project_slug, agent_slug}` payload — neither logs the caller's full scope/project set. Test: assert the error string/payload contains the one scope name and NOT the caller arrays.
8. **D8 — Audit actor stays FK-valid + caller-linked.** Unchanged: events/comments use `run.createdBy` (the caller) as the FK-valid actor via `transitionActor` (`runner.ts:323`). The delegate snapshot does not change WHO the actor is — it was always the caller for audit; this phase makes the AUTHORITY match the audit. Test: a delegated run's emitted event `actor` resolves to `createdBy`.
9. **D9 — Empty intersect = DENY, enforced at the check.** The scope check is a positive membership test (`∈ both`), so `∅` naturally denies every scope. The project effective-set: an empty result (not `['*']`) means no project is allowed → every project-scoped tool rejects. Test: agent ∩ caller scopes = ∅ → all tools `forbidden`; project ∩ = [] → all project tools rejected (NOT fall-open).
10. **D10 — NULL caller columns FAIL CLOSED via migration backfill + a non-null contract going forward.** Migration backfills existing runs' `caller_scopes` = the run's agent token scopes AND `caller_project_ids` = the agent's resolved projects (i.e. historical runs keep their PRE-delegation behavior — agent-only authority — explicitly, not via a fall-open NULL). New runs always write non-null. At read time in `executeTool`, a NULL/undefined `callerScopes` is treated as `[]` (deny-all), never `['*']`. Test: a run row with NULL caller columns (simulating an un-backfilled row) → `executeTool` denies, does not fall open.

### Out of scope (explicit deferrals)

- **The plan/apply risk gate** (low/medium/high tiers, `dryRun`) — Phase 3 of the spec. This phase only builds the ceiling, not the approval workflow. A high-risk action the caller IS allowed to do runs unprompted here; gating it is Phase 3.
- **New token-scoped write routes** (views/users/settings) — Phase 2. The intersect protects the EXISTING 20 tools now; new resources inherit it for free when they land.
- **Live re-evaluation of caller authority mid-run** — the snapshot is captured at `createRun` and is immutable for the run's life (a caller demoted mid-run keeps the run's original ceiling). Acceptable residual risk for v1 (runs are short, turn-based). Re-checking on each tool call against the live user is a future refinement.
- **Session-revocation propagation** — if the caller's session is revoked after a run starts, the run completes under the captured snapshot. Same rationale as above.
- **Insider with stolen human credentials** — undefendable at this layer (stolen creds = legitimate caller authority).

### How to use this section

- **Controller pre-flight:** before dispatching each task, verify the task's code carries the mitigation it claims (D1 in Task 2, D3 in Task 4, etc. — mapping in each task header).
- **`/code-review` invocations:** pass "Verify code against the Threat model (D1–D10) in this plan. Report each as in-place / missing / out-of-scope per the deferrals. This EXTENDS the Phase 3 threat model 1–66 — do not re-litigate inherited mitigations."
- **`/evaluate` retro:** list any D-mitigation not implemented as a plan-correction defect.
- **Downstream (Phase 2/3 plans):** cross-reference D1–D10; extend with new mitigation numbers (D11+) as the surface grows. The delegate ceiling is the inheritance baseline.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/agent-projects.ts` | project-set helpers | ADD `callerProjectsFor(actor)` (D5) |
| `apps/server/src/db/schema.ts` | run-row columns live on `documents`? NO — runs are `documents` of type `agent_run` with authority in frontmatter | caller authority rides **frontmatter**, NOT new SQL columns — see Task 1 decision |
| `apps/server/src/lib/agent-run-schema.ts` | run frontmatter Zod schema | ADD `caller_scopes`, `caller_project_ids` (D1, D10) |
| `apps/server/src/services/agent-runs.ts` | `createRun` | capture caller snapshot from `actor` (D1, D2) |
| `apps/server/src/lib/agent-tools.ts` | `executeTool` + `ToolContext` | add caller fields; enforce scope intersect (D3, D7, D9) |
| `apps/server/src/lib/agent-tools-registry.ts` | per-tool project resolution | second intersect vs caller (D4) |
| `apps/server/src/lib/runner.ts` | `RunContext` build + `executeTool` call + resume | thread caller snapshot; inherit on resume (D6, D8) |

> **Architecture decision (resolves the schema question up front):** Folio runs are `documents` rows of type `agent_run`; per the locked "frontmatter is the schema" rule, run authority lives in **`documents.frontmatter`**, NOT new top-level columns. So `caller_scopes` + `caller_project_ids` are new **frontmatter keys** validated by `agent-run-schema.ts`, written by `createRun`, read by the runner. No migration on `documents` structure — only a one-time **data backfill** of existing `agent_run` frontmatter (D10). This matches how `system_prompt`, `chain_id`, `fired_by`, `resume_of` already live in run frontmatter.

---

## Task 1: Run-frontmatter schema — caller authority fields

**Mitigations:** D1 (capture target), D10 (non-null contract going forward).

**Files:**
- Modify: `apps/server/src/lib/agent-run-schema.ts`
- Test: `apps/server/src/lib/agent-run-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in agent-run-schema.test.ts
import { test, expect } from 'bun:test';
import { agentRunFrontmatterSchema } from './agent-run-schema.ts';

test('caller_scopes and caller_project_ids parse and round-trip', () => {
  const fm = {
    // ...minimal valid existing run frontmatter (copy from a sibling test in this file)...
    agent_slug: 'op',
    status: 'planning',
    fired_by: 'manual',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    system_prompt: 'x',
    caller_scopes: ['documents:read', 'documents:write'],
    caller_project_ids: ['proj_1'],
  };
  const parsed = agentRunFrontmatterSchema.parse(fm);
  expect(parsed.caller_scopes).toEqual(['documents:read', 'documents:write']);
  expect(parsed.caller_project_ids).toEqual(['proj_1']);
});

test('caller_project_ids accepts null (wildcard caller = owner)', () => {
  const fm = { /* ...minimal valid... */ caller_scopes: ['documents:read'], caller_project_ids: null };
  // fill the same required keys as above
  expect(() => agentRunFrontmatterSchema.parse({ agent_slug:'op', status:'planning', fired_by:'manual', provider:'anthropic', model:'claude-haiku-4-5', system_prompt:'x', ...fm })).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-run-schema.test.ts`
Expected: FAIL — `caller_scopes`/`caller_project_ids` unknown or stripped (schema is `.strict()` or omits them).

- [ ] **Step 3: Add the fields to the schema**

In `agent-run-schema.ts`, add to the run frontmatter object schema (mirror the optionality of `system_prompt`):

```typescript
  // Caller-authority snapshot (Phase 1 delegation). Captured server-side at
  // createRun from the authenticated actor — NEVER client-supplied (mitigation
  // D2). The run's effective authority is agent ∩ caller for both scopes and
  // projects (mitigation D3/D4). caller_project_ids === null means the caller
  // is a workspace owner/admin (all projects); an array is an explicit
  // allow-list; [] means no project access (deny). (mitigations D1, D5, D9)
  caller_scopes: z.array(z.string()),
  caller_project_ids: z.array(z.string()).nullable(),
```

> If the schema is `.strict()`, these additions are required for the new keys to survive. If a sibling field is `.optional()` for legacy rows, keep `caller_scopes` REQUIRED here — the backfill (Task 7) guarantees every row has it, so requiring it enforces the D10 non-null contract for new code paths. Legacy un-backfilled rows are handled by the read-time deny in Task 3, not by making the schema optional.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-run-schema.test.ts`
Expected: PASS (both new tests + all existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/agent-run-schema.test.ts
git commit -m "phase-op-1: add caller_scopes/caller_project_ids to run frontmatter (D1,D10)"
```

---

## Task 2: `callerProjectsFor` + caller-authority derivation helper

**Mitigations:** D5 (wildcard asymmetry), D1 (server-side derivation).

**Files:**
- Modify: `apps/server/src/lib/agent-projects.ts`
- Test: `apps/server/src/lib/agent-projects.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in agent-projects.test.ts
import { test, expect } from 'bun:test';
import { callerProjectsFor } from './agent-projects.ts';

test('workspace owner/admin maps to wildcard (null = all projects)', () => {
  expect(callerProjectsFor({ role: 'owner', projectIds: ['p1'] })).toBeNull();
  expect(callerProjectsFor({ role: 'admin', projectIds: [] })).toBeNull();
});

test('regular member maps to their explicit project membership, never wildcard', () => {
  expect(callerProjectsFor({ role: 'member', projectIds: ['p1', 'p2'] })).toEqual(['p1', 'p2']);
});

test('member with no project memberships maps to [] (deny), not null', () => {
  expect(callerProjectsFor({ role: 'member', projectIds: [] })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-projects.test.ts`
Expected: FAIL — `callerProjectsFor` is not exported.

- [ ] **Step 3: Implement the helper**

In `agent-projects.ts`:

```typescript
/**
 * Map an authenticated caller to the project set the delegate ceiling clamps
 * against (mitigation D5). Owners/admins have full project access → null
 * (wildcard, intersect treats null as "no narrowing"). A regular member is
 * clamped to their EXPLICIT project membership list — never wildcard, so a
 * member can never borrow an agent's broader project reach. An empty list
 * stays [] (deny), never coerced to wildcard (mitigation D9).
 */
export function callerProjectsFor(actor: {
  role: 'owner' | 'admin' | 'member';
  projectIds: string[];
}): string[] | null {
  if (actor.role === 'owner' || actor.role === 'admin') return null;
  return actor.projectIds;
}
```

> **Step 2.5 note for the implementer:** verify the actual membership-role type + how a session user's `role` and `projectIds` are resolved in the existing auth middleware (`middleware/auth.ts` / `middleware/bearer.ts`) BEFORE finalizing the param shape. The `{role, projectIds}` shape here is the contract; adapt the field names to what the middleware actually attaches. If human PATs carry `scopes`/`projectIds` directly (no role), branch on token-vs-session in the CALLER of this helper (Task 3 wiring), not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-projects.ts apps/server/src/lib/agent-projects.test.ts
git commit -m "phase-op-1: callerProjectsFor — owner→wildcard, member→explicit (D5,D9)"
```

---

## Task 3: `executeTool` enforces the scope intersect

**Mitigations:** D3 (enforce at dispatch), D7 (name-only error), D9 (empty = deny), D10 (NULL = deny).

**Files:**
- Modify: `apps/server/src/lib/agent-tools.ts` (`ToolContext`, `executeTool`)
- Test: `apps/server/src/lib/agent-tools.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in agent-tools.test.ts — uses the __echo test tool (requiredScope 'documents:read')
import { test, expect } from 'bun:test';
import { executeTool } from './agent-tools.ts';

const agentToken = { scopes: ['documents:read', 'documents:write'], /* ...minimal ApiToken... */ } as any;

test('caller WITHOUT the required scope → tool denied even though agent token has it', async () => {
  await expect(
    executeTool(agentToken, 'agent:op', '__echo', { value: 'x' }, undefined, {
      callerScopes: [], // caller has nothing
      callerProjectIds: null,
    }),
  ).rejects.toThrow('forbidden: scope documents:read missing');
});

test('caller WITH the required scope → tool runs', async () => {
  const out = await executeTool(agentToken, 'agent:op', '__echo', { value: 'x' }, undefined, {
    callerScopes: ['documents:read'],
    callerProjectIds: null,
  });
  expect(out).toEqual({ echoed: 'x' });
});

test('undefined caller authority → DENY (fail closed, not fall open)', async () => {
  await expect(
    executeTool(agentToken, 'agent:op', '__echo', { value: 'x' }, undefined, {
      callerScopes: undefined as unknown as string[],
      callerProjectIds: null,
    }),
  ).rejects.toThrow('forbidden: scope documents:read missing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts`
Expected: FAIL — `executeTool` has no 6th param; caller scopes ignored.

- [ ] **Step 3: Add caller fields + enforce the intersect**

In `agent-tools.ts`, extend `ToolContext` and `executeTool`. Add an optional `caller` arg (6th param) so existing call sites keep compiling until Task 5 wires the runner; default it to deny-closed:

```typescript
export interface ToolContext {
  token: ApiToken;
  actor: string;
  tx?: DBOrTx;
  /** Caller-authority snapshot (Phase 1 delegation, mitigation D3). */
  callerScopes: string[];
  callerProjectIds: string[] | null;
}

export async function executeTool(
  token: ApiToken,
  actor: string,
  name: string,
  args: unknown,
  tx?: DBOrTx,
  caller?: { callerScopes: string[]; callerProjectIds: string[] | null },
): Promise<unknown> {
  const def = registry.get(name);
  if (!def) throw new Error(`method not found: ${name}`);
  if (name === '__echo' && process.env.NODE_ENV !== 'test') {
    throw new Error(`method not found: ${name}`);
  }

  // Delegate ceiling (mitigation D3/D9/D10): caller authority FAILS CLOSED.
  // Missing/undefined caller scopes are treated as [] (deny-all), never as
  // wildcard — so an un-backfilled run or an unwired call site denies rather
  // than escalates.
  const callerScopes = caller?.callerScopes ?? [];
  const callerProjectIds = caller?.callerProjectIds ?? [];

  // Scope check is now a DOUBLE membership test: agent token AND caller must
  // both hold the scope (mitigation D3). Name-only error (mitigation D7).
  if (!token.scopes.includes(def.requiredScope) || !callerScopes.includes(def.requiredScope)) {
    throw new Error(`forbidden: scope ${def.requiredScope} missing`);
  }

  let parsed: unknown;
  try {
    parsed = def.schema.parse(args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path }));
      const e = new Error('MCP_INVALID_ARGS') as Error & { issues: typeof issues };
      e.issues = issues;
      throw err instanceof z.ZodError ? e : err;
    }
    throw err;
  }

  return def.handler(parsed as never, {
    token,
    actor,
    tx,
    callerScopes,
    callerProjectIds: caller?.callerProjectIds ?? null,
  });
}
```

> NOTE: `callerProjectIds` for the project intersect (Task 4) is passed THROUGH to the handler as `caller?.callerProjectIds ?? null` (preserving the null=wildcard distinction). The local `callerProjectIds = caller?.callerProjectIds ?? []` above is only a guard variable; the handler receives the nullable form. Keep the two distinct — null (owner, no narrowing) vs [] (member, deny-all) is load-bearing (D5/D9).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts`
Expected: PASS. Then run the whole file's existing tests — the 6th param is optional so legacy callers still compile, but they now hit deny-closed; **expect sibling tests that call `executeTool` without caller to FAIL** — that's correct and fixed in Step 5.

- [ ] **Step 5: Update existing in-file callers to pass an explicit caller**

Any existing `executeTool(...)` test/call in this file that should succeed must now pass `{ callerScopes: <the scope it needs>, callerProjectIds: null }`. Update them. (Real production callers are wired in Task 5; MCP route in Task 6.)

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/agent-tools.ts apps/server/src/lib/agent-tools.test.ts
git commit -m "phase-op-1: executeTool enforces caller∩agent scope intersect, fail-closed (D3,D7,D9,D10)"
```

---

## Task 4: Per-tool project intersect against the caller

**Mitigations:** D4 (narrow not widen), D5 (wildcard asymmetry), reuses `intersectAgentProjects`.

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (the `resolveProject`-style helper around `:160-198`)
- Test: `apps/server/src/lib/agent-tools-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in agent-tools-registry.test.ts — exercise the project-resolution path
import { test, expect } from 'bun:test';
// import the helper that currently does intersectAgentProjects(agentProjects, token.projectIds)
// (verify its exact exported name at Step 2.5; the live code is the unnamed
// internal resolver near line 160 — if it's not exported, the test goes through
// executeTool on a project-scoped real tool instead. Prefer testing via executeTool.)

test('caller not in the project → tool rejected even when agent allow-lists it', async () => {
  // agent allow-lists [P1, P2]; agent token unrestricted; caller projects [P1]
  // → a tool targeting P2 must reject with agent_not_in_allow_list shape
  // (assert the rejection; exact wiring per Step 2.5)
});

test('caller is owner (callerProjectIds null) → no extra narrowing; agent allow-list still applies', async () => {
  // owner caller (null) → effective = agent ∩ token only; P2 allowed if agent allows it
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts`
Expected: FAIL — the resolver only intersects agent vs token, not the caller.

> **Step 2.5 (mandatory before Step 3):** read `agent-tools-registry.ts:160-198` live. The current intersect is `intersectAgentProjects(resolveAgentProjects(agent), token.projectIds ?? null)`. Confirm the handler/context has access to `ctx.callerProjectIds` (added in Task 3). If the resolver is a free function not receiving `ctx`, thread `callerProjectIds` into it.

- [ ] **Step 3: Apply the second intersect**

In the project resolver, after computing the agent∩token effective set, intersect AGAIN against the caller:

```typescript
    const agentProjects = resolveAgentProjects(agent);
    const agentTokenEffective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
    // Phase 1 delegation (mitigation D4): clamp once more to the caller. null =
    // owner (no narrowing); [] or list = explicit member allow-list. Reuses the
    // audited helper — no hand-rolled set logic.
    const effective = intersectAgentProjects(agentTokenEffective, ctx.callerProjectIds);
    if (!effective.includes('*') && !effective.includes(p.id)) {
      // ...existing agent_not_in_allow_list rejection (unchanged shape, mitigation D7)...
    }
```

> Verify `intersectAgentProjects(list, null)` returns `list` unchanged (null = no narrowing) and `intersectAgentProjects(list, [])` returns `[]` (deny) — this is the D5/D9 contract. If the helper doesn't already behave this way, that's a finding: fix the helper with a unit test, do NOT special-case here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-tools-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/agent-tools-registry.test.ts
git commit -m "phase-op-1: per-tool project intersect clamps to caller (D4,D5)"
```

---

## Task 5: `createRun` captures the caller snapshot + runner threads it

**Mitigations:** D1 (capture), D2 (server-side only), D6 (resume inherits), D8 (audit actor unchanged).

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts` (`createRun`)
- Modify: `apps/server/src/lib/runner.ts` (`RunContext`, `executeTool` call site, resume path)
- Test: `apps/server/src/services/agent-runs.test.ts`, `apps/server/src/lib/runner.test.ts`

- [ ] **Step 1: Write the failing test (createRun captures caller)**

```typescript
// in agent-runs.test.ts
test('createRun stamps caller_scopes/caller_project_ids from the actor, not from input', async () => {
  // actor = a member with scopes ['documents:read'] and projectIds ['p1']
  // createRun(..., actor) → the persisted run frontmatter has
  // caller_scopes ['documents:read'] and caller_project_ids ['p1']
  // AND ignores any caller_* keys smuggled into `input`.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/agent-runs.test.ts`
Expected: FAIL — `createRun` doesn't write caller frontmatter.

> **Step 2.5 (mandatory):** read `createRun` (`agent-runs.ts:104-200`) + its `CreateRunArgs.actor` shape live. Determine where the actor's effective scopes + project memberships are available. For a SESSION user, derive scopes from role + `callerProjectsFor(actor)`; for a human PAT actor, use the token's `scopes`/`projectIds` directly. The derivation MUST be inside `createRun` from `actor` — never from `input` (mitigation D2).

- [ ] **Step 3: Capture the snapshot in `createRun`**

In `createRun`, when building the run frontmatter (around `:145`/`:196`), add:

```typescript
      caller_scopes: deriveCallerScopes(actor),          // from actor, NOT input (D2)
      caller_project_ids: deriveCallerProjectIds(actor),  // callerProjectsFor(...) for members; token.projectIds for PATs (D1,D5)
```

Implement `deriveCallerScopes`/`deriveCallerProjectIds` as small local helpers (or inline) per the Step 2.5 finding. They take ONLY `actor`.

- [ ] **Step 4: Thread the snapshot into the runner's `executeTool` call**

In `runner.ts`: add `callerScopes: string[]` + `callerProjectIds: string[] | null` to `RunContext` (read from the run row's frontmatter when building the context near `:306-331`). At the call site (`:697`):

```typescript
const result = await executeTool(ctx.token, ctx.actor, tc.name, tc.arguments, undefined, {
  callerScopes: ctx.callerScopes,
  callerProjectIds: ctx.callerProjectIds,
});
```

- [ ] **Step 5: Resume/retry inherits the original snapshot (D6)**

In `runAgentResume` (and any `retry-of` createRun call), copy `caller_scopes`/`caller_project_ids` from the ORIGINAL run's frontmatter onto the new row — same mechanism as `chain_id` inheritance. Add a test:

```typescript
test('resume inherits the original run caller snapshot, does not re-derive from agent', async () => {
  // original run caller_scopes ['documents:read']; agent token has write too;
  // resume → new run caller_scopes still ['documents:read']
});
```

- [ ] **Step 6: Run all touched suites**

Run: `cd apps/server && bun test src/services/agent-runs.test.ts src/lib/runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/agent-runs.ts apps/server/src/lib/runner.ts apps/server/src/services/agent-runs.test.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-op-1: createRun captures caller snapshot; runner threads it; resume inherits (D1,D2,D6,D8)"
```

---

## Task 6: MCP `run_agent` + HTTP `POST /runs` reject client-supplied caller authority

**Mitigations:** D2 (no client-supplied authority — verify the negative).

**Files:**
- Modify (if needed): `apps/server/src/routes/runs.ts`, the MCP `run_agent` registration in `apps/server/src/lib/agent-tools-registry.ts`
- Test: `apps/server/src/routes/runs.test.ts`

- [ ] **Step 1: Write the failing/guard test**

```typescript
// in runs.test.ts
test('POST /runs ignores caller_scopes/caller_project_ids in the body (D2)', async () => {
  // POST a run create with body containing caller_scopes:['admin:everything']
  // → the created run's stored caller_scopes reflect the AUTHENTICATED caller,
  //   not the body; the injected scope is absent.
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `cd apps/server && bun test src/routes/runs.test.ts`
Expected: Likely PASS already IF the body schema is strict and `createRun` derives server-side (Task 5). This task is a GUARD test that locks the negative. If it FAILS, the body schema is leaking the field → fix by ensuring the schema omits/strips it.

- [ ] **Step 3: Verify + lock (grep all three schemas)**

Run: `grep -rn "caller_scopes\|caller_project_ids\|callerScopes\|callerAuthority" apps/server/src/routes apps/server/src/lib/agent-tools-registry.ts packages/shared/src`
Expected: the strings appear ONLY in createRun/runner/schema internals, NEVER in a request-body schema or the shared `documentPatchSchema`. If any request schema contains them, remove them.

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `cd apps/server && bun test src/routes/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/runs.test.ts
git commit -m "phase-op-1: lock D2 — caller authority is server-derived, never client-supplied"
```

---

## Task 7: Backfill existing runs' caller frontmatter (fail-closed for history)

**Mitigations:** D10 (NULL ambiguity → explicit pre-delegation behavior).

**Files:**
- Create: `apps/server/src/db/migrations/00NN_backfill_run_caller_authority.sql` (+ journal entry)
- Create: `apps/server/scripts/backfill-run-caller-authority.ts` OR do it as a data migration — decide per the repo's migration conventions at Step 2.5
- Test: `apps/server/src/db/<migration-test>.ts`

> **Step 2.5 (mandatory):** Folio runs are `documents` of type `agent_run` with authority in `frontmatter` (JSON). A pure-SQL `UPDATE documents SET frontmatter = json_set(...)` is the right tool. Verify the `_journal.json` discipline (see the `[[drizzle-migration-journal]]` lesson — every new `.sql` MUST be added to `apps/server/src/db/migrations/meta/_journal.json` or `migrate()` silently skips it). Also recall `[[drizzle-migrate-is-idempotent]]`: to TEST an UPDATE against pre-seeded rows, run the migrator once then `sqlite.exec(readFileSync(<migration>))` against seeded data.

- [ ] **Step 1: Write the failing migration test**

```typescript
test('backfill stamps caller_scopes=agent-token-scopes and caller_project_ids=agent-resolved-projects on pre-existing runs', () => {
  // seed an agent_run document with frontmatter lacking caller_* keys
  // run the backfill SQL
  // assert the row now has caller_scopes (= the agent's token scopes) and
  // caller_project_ids (= resolveAgentProjects-equivalent) — i.e. historical
  // runs keep PRE-delegation (agent-only) authority EXPLICITLY (D10), not via
  // a fall-open null.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/db/<migration-test>.ts`
Expected: FAIL — backfill not written.

- [ ] **Step 3: Write the backfill SQL**

```sql
-- 00NN_backfill_run_caller_authority.sql
-- D10: existing agent_run docs predate caller-authority. Stamp them with the
-- agent's own authority so historical runs keep their PRE-delegation behavior
-- EXPLICITLY (never a fall-open NULL). New runs are stamped by createRun.
-- caller_scopes := the agent token's scopes; caller_project_ids := the agent's
-- resolved projects (mirrors resolveAgentProjects: missing/'*' → null).
UPDATE documents
SET frontmatter = json_set(
  frontmatter,
  '$.caller_scopes', (/* subquery or app-computed; see Step 2.5 — if a pure-SQL
     join to apiTokens.scopes is awkward, do this in the .ts backfill script
     instead and keep the SQL migration as a no-op marker */ json('[]')),
  '$.caller_project_ids', json('null')
)
WHERE type = 'agent_run'
  AND json_extract(frontmatter, '$.caller_scopes') IS NULL;
```

> If joining `apiTokens.scopes` per-agent in pure SQL is awkward (it is — scopes live on a different table keyed by `agentId`), implement the backfill as a **`.ts` script** that loads each `agent_run`, looks up the agent's token scopes + `resolveAgentProjects`, and `json_set`s them — and keep the `.sql` migration as the journal-registered marker that the script ran. The TEST asserts the end state regardless of mechanism. **Do NOT** stamp `[]`/`null` blindly if that would DENY historical runs you intend to keep runnable — the intent is "historical runs keep agent-only authority," so the stamp must be the AGENT's real scopes. Resolve this explicitly at Step 2.5.

- [ ] **Step 4: Add the journal entry + run the test**

Update `apps/server/src/db/migrations/meta/_journal.json` with the new migration (mandatory — `[[drizzle-migration-journal]]`).

Run: `cd apps/server && bun test src/db/<migration-test>.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrations/ apps/server/scripts/ apps/server/src/db/<migration-test>.ts
git commit -m "phase-op-1: backfill run caller authority — historical runs keep agent-only authority (D10)"
```

---

## Task 8: Integration gate + threat-model verification

**Files:** none (verification task)

- [ ] **Step 1: Full server suite from inside apps/server**

Run: `cd apps/server && bun test`
Expected: 0 fail (per `[[server-fullsuite-init-cascade]]`, run from INSIDE apps/server, NOT repo root). Record the new count vs the pre-phase baseline.

- [ ] **Step 2: Typecheck (per-app — no root tsconfig)**

Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Threat-model self-check (D1–D10)**

Walk each mitigation D1–D10 and point to the test that proves it:
- D1 → Task 5 Step 1 (createRun captures)
- D2 → Task 6 Step 1 + Step 3 grep
- D3 → Task 3 Step 1 (caller-without-scope denied)
- D4 → Task 4 Step 1 (caller-not-in-project rejected)
- D5 → Task 2 (owner→null, member→list)
- D6 → Task 5 Step 5 (resume inherits)
- D7 → Task 3 (name-only error assertion)
- D8 → audit actor unchanged (Task 5; assert event actor = createdBy)
- D9 → Task 3 Step 1 (empty caller = deny) + Task 4 ([] projects = deny)
- D10 → Task 3 (undefined caller = deny) + Task 7 (backfill)

Any D-mitigation without a green test is a gap → add the test before declaring the gate green.

- [ ] **Step 4: Commit the integration marker (if the repo uses one)**

```bash
# update .last-integration if the repo convention uses it, else skip
git commit -m "phase-op-1: integration gate green — delegate ceiling enforced (D1-D10)" --allow-empty
```

---

## Self-review (run before dispatch)

**Spec coverage:** Phase 1 of the spec = "caller-identity delegation: thread the caller onto the run + intersect scopes at execution." Tasks 1+5 (thread onto run), 3+4 (intersect at execution), 2 (wildcard semantics), 6 (server-side only), 7 (history fail-closed), 8 (gate). ✓ Phases 2/3 explicitly out of scope (their own plans). ✓

**Placeholder scan:** Tasks 2/4/5/7 carry `Step 2.5` ground-truth instructions rather than guessed field names — this is deliberate (the exact membership-role shape + createRun actor shape must be read live), NOT a placeholder. Every code-changing step shows real code or a real SQL/grep command. No "TBD"/"add validation"/"similar to Task N". ✓

**Type consistency:** `ToolContext` gains `callerScopes: string[]` + `callerProjectIds: string[] | null` (Task 3) — same names used in the `executeTool` call site (Task 5) and the handler/registry (Task 4). `callerProjectsFor` returns `string[] | null` (Task 2) feeding `caller_project_ids` (Task 1) and the intersect (Task 4). Frontmatter keys `caller_scopes`/`caller_project_ids` (snake_case, Task 1) vs context fields `callerScopes`/`callerProjectIds` (camelCase) — intentional per the DB-snake/TS-camel convention; the boundary is `createRun` (writes snake) and `RunContext` build (reads snake → camel). ✓

**The one open contract (resolve at Step 2.5, not a plan gap):** the authenticated actor's role + project-membership shape. The plan names the contract (`{role, projectIds}`) and instructs the implementer to adapt to the live middleware. This is the single most likely divergence point — flagged in Tasks 2 and 5.
