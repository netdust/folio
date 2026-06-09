# Headless Folio via MCP — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents manageable headlessly via MCP by an admin PAT (D1), fix the MCP-vs-HTTP default-table divergence bug (D2), and correct/improve the `folio` skill (D3) — Phase 1 of "headless Folio via MCP".

**Architecture:** One shared predicate (`mayManageAgentLifecycle`) replaces the four duplicated human-PAT rejections across the MCP tools and the HTTP route, so the two surfaces converge by construction and gate on `agents:write` (= owner/admin). The MCP default-table resolver is pinned to `work-items` to match the HTTP routes. The skill body is corrected to match the converged reality.

**Tech Stack:** Bun, Hono, Drizzle, SQLite, TypeScript (strict). Tests: `bun test` (server). Driven over MCP JSON-RPC for acceptance.

**Spec:** `docs/superpowers/specs/2026-06-09-headless-folio-via-mcp-design.md` (read its `## Threat model` — this plan implements its 5 numbered mitigations).

---

## Architecture invariants touched

- **Invariant 17 (root-of-trust is session-only; everything else admin-PAT-reachable)** — NEW, authored 2026-06-09 for this phase. D1 introduces the agent-lifecycle convergence point (`mayManageAgentLifecycle`). Task 2 must route BOTH the MCP and HTTP agent-CRUD gates through this single predicate; a path that re-hand-rolls the human-PAT check is the bug this invariant exists to prevent. **When Task 2 lands, update invariant 17's citation** in `ARCHITECTURE-INVARIANTS.md` from `assertNotHumanPatForAgentLifecycle` to `mayManageAgentLifecycle`, and re-run `bun run check:invariants`.
- **Invariant 2 (executeTool scope double-check)** — unchanged; the agent-lifecycle gate runs INSIDE the tools, downstream of `executeTool`'s `agents:write` scope check. Gate on the same scope, never re-derive authority.
- **Invariant 7 (token authority ≤ minting role)** — the minted agent's scope stays `agent ∩ caller`; D1 does not change this. The `agents:write`-only-for-owner/admin fact (`roleToScopes`) IS the admin signal the new gate keys on.
- **Invariant 12 + the "headless MCP skips confirm gate" Deliberate exception** — D1 is the FIRST feature to deliberately lean on this exception (agent-mint is a high-risk op reachable gate-less over headless MCP). Accepted residual per the spec threat model; the exception text was sharpened 2026-06-09 to cover agent-lifecycle. Do NOT re-flag the missing confirm gate as a new bug — it is the documented, accepted state.

## Threat-model mitigations this plan implements (from the spec)

1. **Agent token listable + revocable (LOAD-BEARING)** → Task 1 (verify-first).
2. **Member/low-scope PAT blocked on agent lifecycle** → Task 2 + Task 3 (RED-first denial).
3. **MCP & HTTP gates can't re-diverge** → Task 2 (single shared predicate) + Task 4 (cross-surface equality test).
4. **Agent can't be minted wider than caller** → Task 5 (width-guard regression).
5. **Root-of-trust unreachable by admin PAT** → Task 6 (regression guard).

---

## File structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `apps/server/src/lib/agent-guards.ts` | DEFINE `mayManageAgentLifecycle` (the one shared predicate); rewrite `assertNotHumanPatForAgentLifecycle` to delegate to it | 2 |
| `apps/server/src/lib/mcp-errors.ts` | `mcpRejectHumanPat` delegates to the shared predicate | 2 |
| `apps/server/src/lib/agent-tools-registry.ts` | `resolveTableForArgs` pins to `work-items` (D2) | 7 |
| **Test harness note** | D1/D2 wire tests live in `apps/server/src/routes/mcp.test.ts` using its existing `setupToken(workspaceId, userId, scopes)` helper + `app.request('/mcp', { method:'POST', body: JSON-RPC tools/call })`. `agent-tools-registry.test.ts` does NOT exist — do NOT create it; use `mcp.test.ts` (drives the real wire, which the threat model wants). The predicate unit tests (Task 2/4) go in a NEW `apps/server/src/lib/agent-guards.test.ts`. The token-list/revoke test (Task 1) goes in `workspace-documents.test.ts`, which already has `mintPAT(workspaceId, userId, scopes)`, `mintAgentBoundToken(...)`, and `createAgent(...)`. | — |
| `apps/server/src/lib/system-skills.ts` | `folio` skill body corrections (D3) | 8 |
| `ARCHITECTURE-INVARIANTS.md` | refresh invariant-17 citation to `mayManageAgentLifecycle` | 2 |
| Tests (co-located `*.test.ts`) | per-task | all |

---

## REVIEW CLUSTER A — D1 agent-lifecycle (Tasks 1–6). `── REVIEW GATE ──` at Task 6 close: `/integration` + `/code-review high` + `/security-review` (auth-boundary loosening). Do NOT begin Cluster B until clear.

---

### Task 1: VERIFY-FIRST — an MCP-minted agent's token is listable + revocable (the load-bearing mitigation)

This is mitigation 1 and gates the whole loosening. No production change unless a gap is found.

**Files:**
- Test: `apps/server/src/routes/workspace-documents.test.ts` (add)

- [ ] **Step 1: Write the test asserting an agent's token appears in the per-workspace token list and is killed by agent delete**

Use this file's EXISTING helpers — `createAgent(...)` (already creates an agent via the route and returns its `api_token_id`) and the `seed`/`app` setup the other tests in this file use. Match the existing tests' session/auth setup verbatim (read 2-3 nearby tests first). Sketch:

```ts
// apps/server/src/routes/workspace-documents.test.ts (add — use the file's existing seed + createAgent helpers)
import { eq } from 'drizzle-orm';
import { apiTokens } from '../db/schema.ts';

test('an agent-bound token appears in the per-workspace token list and agent delete revokes it', async () => {
  // 1. Seed (use the existing pattern in this file): a workspace + owner session.
  // 2. createAgent(...) → returns the agent doc incl. frontmatter.api_token_id.
  //    (createAgent already exists at workspace-documents.test.ts:305.)
  const agent = await createAgent(/* existing args */);
  const tokenId = (agent.frontmatter as { api_token_id: string }).api_token_id;
  expect(tokenId).toBeTruthy();

  // 3. The token row is workspace-pinned (so it's in the per-WS list, not the instance list).
  const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) });
  expect(row?.workspaceId).toBe(workspaceId);

  // 4. It surfaces in GET /api/v1/w/:wslug/tokens/:workspaceId (session auth) — the revocable surface.
  //    Assert tokens.map(t => t.id) contains tokenId.

  // 5. DELETE the agent (session auth) → 200 → the token row is gone (api_tokens.agent_id ON DELETE CASCADE).
  //    Assert findFirst(apiTokens, id=tokenId) is undefined afterward.
});
```

**Why this is the mitigation:** the per-workspace token list (`routes/tokens.ts`, filtered by `workspaceId`) DOES surface agent-bound tokens (it has no `agentId` filter), and agent delete cascades the token via `api_tokens.agent_id ON DELETE CASCADE` (`services/documents.ts:1220`). The instance-token list (`routes/instance-tokens.ts`) filters `workspaceId IS NULL` so it does NOT show agent tokens — that's expected; the per-workspace list is the revocation surface. If the per-WS assertion FAILS, that is the gap to close before D1 ships.

- [ ] **Step 2: Run the test**

Run: `cd apps/server && bun test src/routes/workspace-documents.test.ts -t "appears in the per-workspace token list"`
Expected: PASS (the surfaces already exist — `tokens.ts` lists by workspaceId, `api_tokens.agent_id ON DELETE CASCADE` revokes). **If it FAILS** (token not listed, or not cascaded), STOP — that is the mitigation-1 gap the spec says must be closed before D1 ships; report it and add a closing task before continuing.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/workspace-documents.test.ts
git commit -m "test(mcp): verify agent token is listable + revocable (headless D1 mitigation 1)"
```

---

### Task 2: DEFINE the shared `mayManageAgentLifecycle` predicate + route both surfaces through it

**Files:**
- Modify: `apps/server/src/lib/agent-guards.ts` (add predicate; rewrite `assertNotHumanPatForAgentLifecycle:254`)
- Modify: `apps/server/src/lib/mcp-errors.ts` (`mcpRejectHumanPat:55` delegates)
- Modify: `ARCHITECTURE-INVARIANTS.md` (refresh inv-17 citation)
- Test: `apps/server/src/lib/agent-guards.test.ts`

- [ ] **Step 1: Write the failing test for the predicate**

```ts
// apps/server/src/lib/agent-guards.test.ts (add)
import { describe, expect, test } from 'bun:test';
import { mayManageAgentLifecycle } from './agent-guards.ts';
import type { EphemeralToken } from '../db/schema.ts';

const tok = (over: Partial<EphemeralToken>): EphemeralToken =>
  ({ id: 't', workspaceId: 'w', createdBy: 'u', scopes: [], agentId: null, ...over }) as EphemeralToken;

describe('mayManageAgentLifecycle', () => {
  test('session (no token) → allowed', () => {
    expect(mayManageAgentLifecycle(null)).toBe(true);
  });
  test('agent-bound bearer → allowed', () => {
    expect(mayManageAgentLifecycle(tok({ agentId: 'agt_1' }))).toBe(true);
  });
  test('operator (isOperator marker, agentId null) → allowed', () => {
    expect(mayManageAgentLifecycle(tok({ agentId: null, isOperator: true }))).toBe(true);
  });
  test('human PAT WITH agents:write (owner/admin) → allowed', () => {
    expect(mayManageAgentLifecycle(tok({ scopes: ['documents:write', 'agents:write'] }))).toBe(true);
  });
  test('human PAT WITHOUT agents:write (member/stolen) → rejected', () => {
    expect(mayManageAgentLifecycle(tok({ scopes: ['documents:read', 'documents:write'] }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — fails (not defined)**

Run: `cd apps/server && bun test src/lib/agent-guards.test.ts -t mayManageAgentLifecycle`
Expected: FAIL — `mayManageAgentLifecycle` is not exported.

- [ ] **Step 3: Implement the predicate + delegate both call sites**

In `apps/server/src/lib/agent-guards.ts`, add (import `isAgentBound` from `./token-reach.ts` — it already exists and treats the operator's `isOperator` marker as agent-bound):

```ts
import { isAgentBound } from './token-reach.ts';
import type { EphemeralToken } from '../db/schema.ts';

/**
 * THE single agent-lifecycle authorization decision (invariant 17). Agent
 * CRUD mints/modifies/revokes an `agent_token` bearer credential. Allowed:
 *   - session callers (no token) — UI admin.
 *   - agent-bound bearers (incl. the operator via isOperator) — self-mgmt.
 *   - human PATs holding `agents:write` — owner/admin only (roleToScopes never
 *     grants agents:write to `member`), so the scope IS the admin signal.
 * Rejected: any other human PAT (member / stolen lower-scope token).
 *
 * 2026-06-09 (headless-Folio Phase 1, D1): this DELIBERATELY admits admin PATs,
 * loosening the prior "all human PATs rejected" stance. Accepted residual: a
 * stolen admin PAT can mint a pivot agent — but it already holds delete+config:write,
 * and the minted token stays revocable (api_tokens.agent_id cascade). See the spec
 * threat model + invariant 12's headless-confirm-gate exception.
 */
export function mayManageAgentLifecycle(token: EphemeralToken | null): boolean {
  if (!token) return true; // session-authenticated
  if (isAgentBound(token)) return true; // agent-bound bearer (incl. operator)
  return token.scopes.includes('agents:write'); // owner/admin human PAT
}
```

Then rewrite `assertNotHumanPatForAgentLifecycle` (`agent-guards.ts:254`) to delegate:

```ts
export function assertNotHumanPatForAgentLifecycle(
  type: 'agent' | 'trigger',
  token: ApiToken | null,
): void {
  if (type !== 'agent') return;
  if (mayManageAgentLifecycle(token as EphemeralToken | null)) return;
  throw new HTTPError(
    'HUMAN_PAT_AGENT_LIFECYCLE_HTTP',
    'agent lifecycle requires session auth, an agent-bound bearer, or an admin (agents:write) token',
    403,
  );
}
```

In `apps/server/src/lib/mcp-errors.ts`, rewrite `mcpRejectHumanPat` (`:55`) to delegate to the SAME predicate (keep the `-32000` shape):

```ts
import { mayManageAgentLifecycle } from './agent-guards.ts';

export function mcpRejectHumanPat(token: EphemeralToken): void {
  if (mayManageAgentLifecycle(token)) return;
  const err = new Error(
    'agent-lifecycle tools require session auth, an agent-bound bearer, or an admin (agents:write) token',
  ) as Error & { code: number; data: Record<string, unknown> };
  err.code = -32000;
  err.data = { reason: 'human_pat_rejected_on_agent_lifecycle' };
  throw err;
}
```

(Watch for an import cycle: `mcp-errors.ts` → `agent-guards.ts`. If `agent-guards.ts` imports from `mcp-errors.ts` today, move `mayManageAgentLifecycle` to a leaf module or confirm the cycle is type-only. Verify with `bun x tsc --noEmit`.)

- [ ] **Step 4: Refresh invariant 17 citation**

In `ARCHITECTURE-INVARIANTS.md` invariant 17, change `assertNotHumanPatForAgentLifecycle (...which Phase 1 rewrites...)` to cite `mayManageAgentLifecycle` (`apps/server/src/lib/agent-guards.ts`) as the live convergence point.

- [ ] **Step 5: Run predicate tests + typecheck + invariant check**

Run: `cd apps/server && bun test src/lib/agent-guards.test.ts -t mayManageAgentLifecycle` → PASS
Run: `cd apps/server && bun x tsc --noEmit` → clean (no import cycle)
Run: `cd /home/ntdst/Projects/folio && bun run check:invariants` → 0 errors

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/agent-guards.ts apps/server/src/lib/mcp-errors.ts apps/server/src/lib/agent-guards.test.ts ARCHITECTURE-INVARIANTS.md
git commit -m "feat(mcp): shared mayManageAgentLifecycle gate — admin PATs may manage agents (D1, inv 17)"
```

---

### Task 3: MCP create/update/delete_agent accept an admin PAT, reject a member PAT (wire-level RED-first)

**Files:**
- Test: `apps/server/src/routes/mcp.test.ts` (add — uses the file's `setupToken` helper + `app.request('/mcp', tools/call)`)

- [ ] **Step 1: Write the failing wire test through the real `/mcp` route**

```ts
// apps/server/src/routes/mcp.test.ts (add). Pattern: mirror the existing tools/call tests here.
// setupToken(workspaceId, userId, scopes) mints a workspace-pinned PAT with those scopes.
// An admin PAT carries agents:write; a member PAT does not.

async function callTool(token: string, name: string, args: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}

test('create_agent: admin PAT (agents:write) succeeds, member PAT rejected', async () => {
  const seed = await setupSeed(); // the file's existing seed (workspace + user)
  const admin = await setupToken(seed.workspace.id, seed.user.id, ['documents:write', 'agents:write']);
  const member = await setupToken(seed.workspace.id, seed.user.id, ['documents:read', 'documents:write']);

  const okRes = await callTool(admin, 'create_agent',
    { workspace_slug: seed.workspace.slug, title: 'Bot', frontmatter: { projects: [] } });
  const ok = await okRes.json();
  expect(ok.result).toBeDefined();
  expect(JSON.parse(ok.result.content[0].text).slug).toBeTruthy();

  const badRes = await callTool(member, 'create_agent',
    { workspace_slug: seed.workspace.slug, title: 'Bot2', frontmatter: { projects: [] } });
  const bad = await badRes.json();
  expect(bad.error.code).toBe(-32000);
  expect(bad.error.data.reason).toBe('human_pat_rejected_on_agent_lifecycle');
});
```

Add parallel `update_agent` + `delete_agent` cases (admin PAT may; member PAT → same `-32000` / `human_pat_rejected_on_agent_lifecycle`). All three call `mcpRejectHumanPat`, which now delegates to the shared predicate.

- [ ] **Step 2: Run — the admin-allowed case FAILS today** (current `mcpRejectHumanPat` rejects EVERY human PAT, so the admin call gets `-32000` instead of a result).

Run: `cd apps/server && bun test src/routes/mcp.test.ts -t "admin PAT"`
Expected: FAIL on the admin-success assertion (pre-Task-2). After Task 2's predicate lands, re-run.

- [ ] **Step 3: No new impl — Task 2's shared predicate already changed behavior.** Re-run → GREEN.

Run: `cd apps/server && bun test src/routes/mcp.test.ts -t "PAT"` → PASS (create/update/delete)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/mcp.test.ts
git commit -m "test(mcp): admin PAT may create/update/delete agents via MCP; member rejected (D1)"
```

---

### Task 4: Cross-surface equality — MCP and HTTP make the SAME agent-lifecycle decision (mitigation 3)

**Files:**
- Test: `apps/server/src/lib/agent-guards.test.ts` (add)

- [ ] **Step 1: Write the equality test**

```ts
// For each token shape, the MCP gate (mcpRejectHumanPat throws?) and the HTTP gate
// (assertNotHumanPatForAgentLifecycle throws?) MUST agree — they share one predicate.
import { assertNotHumanPatForAgentLifecycle } from './agent-guards.ts';
import { mcpRejectHumanPat } from './mcp-errors.ts';

function mcpRejects(t: any): boolean { try { mcpRejectHumanPat(t); return false; } catch { return true; } }
function httpRejects(t: any): boolean { try { assertNotHumanPatForAgentLifecycle('agent', t); return false; } catch { return true; } }

test('MCP and HTTP agent-lifecycle gates agree for every token shape', () => {
  const shapes = [
    null,
    tok({ agentId: 'a' }),
    tok({ isOperator: true }),
    tok({ scopes: ['agents:write'] }),
    tok({ scopes: ['documents:write'] }),
    tok({ scopes: [] }),
  ];
  for (const s of shapes) expect(mcpRejects(s)).toBe(httpRejects(s));
});
```

- [ ] **Step 2: Run → PASS** (both delegate to `mayManageAgentLifecycle` after Task 2).

Run: `cd apps/server && bun test src/lib/agent-guards.test.ts -t "agree for every token shape"`

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/agent-guards.test.ts
git commit -m "test(mcp): MCP and HTTP agent-lifecycle gates converge (mitigation 3)"
```

---

### Task 5: Width-guard regression — an admin PAT can't mint an agent WIDER than itself (mitigation 4)

**Files:**
- Test: `apps/server/src/routes/mcp.test.ts` (add — same `setupToken` + `callTool` wire harness as Task 3)

- [ ] **Step 1: Write the test**

```ts
// An admin PAT (agents:write) WITHOUT config:write tries to mint an agent whose frontmatter
// requests a tool/allow-list wider than the caller. The existing width-guards
// (assertAgentToolsWidening / assertAgentAllowListWidening, called inside create_agent's
// handler) must STILL reject — D1 only changed WHO may reach create_agent, not the width bound.
test('admin PAT cannot mint an agent wider than the caller', async () => {
  const seed = await setupSeed();
  // agents:write but NOT config:write — so a folio_api-tool agent (needs config:write) is "wider".
  const partial = await setupToken(seed.workspace.id, seed.user.id, ['documents:write', 'agents:write']);
  const res = await callTool(partial, 'create_agent',
    { workspace_slug: seed.workspace.slug, title: 'Wide', frontmatter: { tools: ['folio_api'] } });
  const body = await res.json();
  expect(body.error).toBeDefined(); // width-guard rejection (NOT a result)
});
```

**Before finalizing:** read `assertAgentToolsWidening` / `assertAgentAllowListWidening` in `agent-guards.ts` to confirm the exact frontmatter shape that triggers a widening rejection (the `tools: ['folio_api']` example assumes folio_api maps to `config:write`, which the caller lacks — verify) and the rejection error shape, then tighten the assertion to `body.error.data.reason`.

- [ ] **Step 2: Run → PASS** (width-guards unchanged; this is a regression lock).

Run: `cd apps/server && bun test src/routes/mcp.test.ts -t "wider than the caller"`

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/mcp.test.ts
git commit -m "test(mcp): width-guards still bound an admin-PAT-minted agent (mitigation 4)"
```

---

### Task 6: Root-of-trust regression — an admin PAT still cannot mint a token / promote a role / create an account / write an AI key (mitigation 5)

**Files:**
- Test: `apps/server/src/routes/instance-tokens.test.ts` (or a new `root-of-trust.test.ts`)

- [ ] **Step 1: Write the regression guard**

```ts
// An admin INSTANCE PAT (agents:write + config:write) must STILL get 401/403 on every
// root-of-trust route — D1 must not have widened these. (Bearer-auth, not session.)
test('admin PAT is rejected on all root-of-trust routes (invariant 17)', async () => {
  const { app, adminPatHeader } = await seedAdminPat();
  const probes: Array<[string, string, unknown?]> = [
    ['POST', '/api/v1/instance/tokens', { name: 'x', scopes: ['documents:read'] }], // mint instance token
    ['POST', '/api/v1/w/main/tokens/WS', { name: 'x', scopes: ['documents:read'] }], // mint ws token
    ['POST', '/api/v1/instance/ai-keys', { provider: 'anthropic', key: 'sk-x' }],     // write AI key
    ['PATCH', '/api/v1/instance/users/SOMEID', { role: 'owner' }],                     // role promote
  ];
  for (const [method, path, body] of probes) {
    const res = await app.request(path, {
      method, headers: { ...adminPatHeader, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect([401, 403]).toContain(res.status); // requireSessionUser rejects the bearer
  }
});
```

- [ ] **Step 2: Run → PASS** (these mounts are `requireSessionUser`; a bearer never satisfies them).

Run: `cd apps/server && bun test -t "root-of-trust"`

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/instance-tokens.test.ts
git commit -m "test(mcp): root-of-trust routes still reject admin PATs (invariant 17, mitigation 5)"
```

- [ ] **Step 4: `── REVIEW GATE ──` — HALT. Run `/integration`, then hand to the user for `/code-review high --base=main` + `/security-review` on the Cluster-A diff. Do NOT begin Cluster B until clear.**

---

## REVIEW CLUSTER B — D2 bug fix + D3 skill (Tasks 7–8). `── REVIEW GATE ──` at close: `/integration` + `/code-review`.

---

### Task 7: D2 — pin the MCP default-table resolver to `work-items` (the B1 bug)

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts:306-324` (`resolveTableForArgs`)
- Test: `apps/server/src/routes/mcp.test.ts` (add — `setupToken` + `callTool` wire harness)

- [ ] **Step 1: Write the failing RED test (the exact live failure)**

```ts
// A project with TWO tables (work-items + 'bugs', both order:0). Bare list_statuses /
// create_document (no table_slug) MUST resolve to work-items, matching HTTP. Pre-fix this
// resolves non-deterministically to the 2nd table (the live eval failure).
test('default-table resolution pins to work-items when a 2nd table exists', async () => {
  const seed = await setupSeed(); // workspace + a project 'webproject' with the seeded work-items table
  const admin = await setupToken(seed.workspace.id, seed.user.id, ['documents:write', 'config:write']);
  // Create a 2nd table via folio_api (POST .../tables) so both tables exist at order 0.
  await callTool(admin, 'folio_api',
    { method: 'POST', path: `/api/v1/w/${seed.workspace.slug}/p/webproject/tables`, body: { name: 'Bugs' } });

  // list_statuses with NO table_slug → work-items statuses (incl. 'todo'), NOT the empty 'bugs' set.
  const stRes = await callTool(admin, 'list_statuses',
    { workspace_slug: seed.workspace.slug, project_slug: 'webproject' });
  const keys = JSON.parse((await stRes.json()).result.content[0].text).statuses.map((s: any) => s.key);
  expect(keys).toContain('todo');

  // create_document {status:'todo'} with NO table_slug → succeeds (lands in work-items).
  const docRes = await callTool(admin, 'create_document',
    { workspace_slug: seed.workspace.slug, project_slug: 'webproject', type: 'work_item', title: 'X', status: 'todo' });
  const doc = await docRes.json();
  expect(doc.error).toBeUndefined(); // pre-fix: -32xxx 'status "todo" not in registry' (routed to bugs)
  expect(JSON.parse(doc.result.content[0].text).status).toBe('todo');
});
```

(If the file's `setupSeed` doesn't already create a `webproject` project, create one via `folio_api POST /api/v1/w/<ws>/projects` in the test first, or adapt to whatever project the seed provides.)

- [ ] **Step 2: Run → FAILS** (resolves to the 2nd table; `create_document` returns the INVALID_STATUS error).

Run: `cd apps/server && bun test src/routes/mcp.test.ts -t "pins to work-items"`

- [ ] **Step 3: Implement the pin** in `resolveTableForArgs` (`agent-tools-registry.ts:318`):

```ts
  // No table_slug: pin to the project's `work-items` table (matches the HTTP route's
  // scope.ts:119-120 default + the folio skill's documented contract). Fall back to
  // lowest-order (createdAt tiebreak) only if no work-items table exists.
  const wi = await db.query.tables.findFirst({
    where: and(eq(tablesTable.projectId, p.id), eq(tablesTable.slug, 'work-items')),
  });
  if (wi) return wi;
  const t = await db.query.tables.findFirst({
    where: eq(tablesTable.projectId, p.id),
    orderBy: (col, { asc }) => [asc(col.order), asc(col.createdAt)],
  });
  if (!t) throw mcpInvalidParams('project has no tables', { reason: 'no_tables' });
  return t;
```

- [ ] **Step 4: Run → PASS.** Also run the full `mcp.test.ts` + any test exercising `resolveTableForArgs` indirectly (single-table `list_views`/`list_statuses`/`create_document`) to confirm no regression.

Run: `cd apps/server && bun test src/routes/mcp.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-tools-registry.ts apps/server/src/routes/mcp.test.ts
git commit -m "fix(mcp): pin default-table resolver to work-items, matching HTTP (B1/D2)"
```

---

### Task 8: D3 — `folio` skill corrections + efficiency (doc-only)

**Files:**
- Modify: `apps/server/src/lib/system-skills.ts` (the `folio` skill `body`)

- [ ] **Step 1: Edit the skill body — four changes**

In the `folio` skill body string in `system-skills.ts`:

1. **Agent-creation recipe** — add to §5 (recipes): "To create an agent as an admin operator: `create_agent(workspace_slug, title, frontmatter)` — returns `agent_token` ONCE in the response; store it, it is never shown again. Requires an admin (`agents:write`) token."
2. **View enum** — in the views recipe, write the value verbatim: "Create a kanban view with `folio_api POST …/views {name, type: \"kanban\", groupBy: \"status\"}` — the `type` value is exactly `\"kanban\"` (not \"board\"), and grouping is `groupBy` (top-level, not `config.group_by`)."
3. **B2 status-seeding** — in §3 (the default-table note, line ~156): "A table you create via `folio_api` has NO statuses (unlike a project, which auto-seeds them). After creating a 2nd table, seed its statuses (`folio_api POST …/t/<tslug>/statuses {key,name,category}`) BEFORE adding `work_item`s — otherwise they land status-less and can't appear on a board."
4. **Default-table claim** — confirm the existing line ("tables/fields/views/statuses paths target the project's `work-items` table unless you insert `/t/<tslug>`") is unchanged and now TRUE for the MCP tools too (Task 7 made it so). No edit unless wording drifted.

- [ ] **Step 2: Typecheck (the skill body is a TS template string)**

Run: `cd apps/server && bun x tsc --noEmit` → clean

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/system-skills.ts
git commit -m "docs(skill): agent-create recipe, kanban enum, table-status footgun (D3)"
```

- [ ] **Step 4: `── REVIEW GATE ──` — HALT. Run `/integration` + `/code-review` on the Cluster-B diff.**

---

## Phase close (Stage 3)

1. **Integration gate** — `cd apps/server && bun test` (full suite, 0 fail) + `bun x tsc --noEmit` (×3 apps) + `bun run check:invariants` (0 err).
2. **Test-effectiveness audit** — `netdust-core:test-effectiveness` over the phase diff: the load-bearing paths are the agent-lifecycle gate (Task 2/3) and the default-table pin (Task 7). Confirm each goes RED on revert (mutate `mayManageAgentLifecycle` to `return true`/`return false`; mutate the resolver back to `ORDER BY order`).
3. **Feature-acceptance** — RE-RUN the MCP-only eval flows through the real `/mcp` endpoint (the harness from `tasks/mcp-eval-manifest.md`): (a) build a multi-table project, bare `create_document` lands in work-items (D2 fixed); (b) create → run-readiness → update → delete an agent end-to-end with an admin PAT (D1); (c) member PAT rejected on agent CRUD. The manifest's failing flows must now PASS.
4. **Shake-out** — `netdust-core:shake-out` / `/shakeout` (re-integration + reviewer panel incl. invariant-auditor against invariant 17).
5. **Finish** — `superpowers:finishing-a-development-branch`.

---

## Sibling-site audit

D1 changes the agent-lifecycle gate — audit every site that gates agent CRUD on a human-PAT check, to be sure all route through the new predicate and none keep a hand-rolled check:

- [ ] `apps/server/src/lib/agent-tools-registry.ts` — `mcpRejectHumanPat` call sites at `:1524` (create), `:1587` (update), `:1653` (delete). All three call the SAME `mcpRejectHumanPat`, which now delegates — confirm no inline `token.agentId`/`isAgentBound` agent-CRUD check exists beside them.
- [ ] `apps/server/src/routes/workspace-documents.ts` — `assertNotHumanPatForAgentLifecycle` at `:75` (POST), `:173` (PATCH), `:223` (DELETE). All delegate after Task 2.
- [ ] Grep `agents:write` and `token.agentId` across `apps/server/src` for any OTHER place that decides "may this token manage an agent" — there must be exactly one decision (the predicate). Report any third site.
