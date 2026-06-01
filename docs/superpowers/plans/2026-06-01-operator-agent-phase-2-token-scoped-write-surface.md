# Operator Agent — Phase 2: Token-Scoped Write Surface + dryRun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Folio's structure/config HTTP routes (tables, fields, views, statuses, project config) reachable by an agent bearer token and previewable via `dryRun`, so the Phase-3 `folio_api` primitive + `folio` skill can drive a full workspace setup — with NO per-resource tools.

**Architecture:** Three small, independent slices. (1) Introduce ONE new canonical scope `config:write` and wire it into the two scope-derivation functions (`toolsToScopes` for the agent token, `roleToScopes` for the caller-delegate ceiling), then retarget the four dead route guards (`tables:write`/`fields:write`/`views:write`/`statuses:write`) to it. (2) Add a uniform `dryRun` contract to every mutating config route: when `dryRun: true`, validate + build the would-be row + return `{ dry_run: true, would: '<verb>', resource: <row> }` WITHOUT inserting or emitting. (3) Confirm project create/configure routes carry the same scope + dryRun contract. Mutations already live in the route handlers (services are read-only), so `dryRun` is a route-layer guard before `txWithEvents` — no service rewrites.

**Tech Stack:** Bun, Hono, Drizzle (bun:sqlite), Zod, `txWithEvents`/`emitEvent` event helper.

**Scope boundary (locked with Stefan 2026-06-01):**
- IN: tables, fields, views, statuses, project create/rename/configure — token-scoped + dryRun. One `config:write` scope for all of them.
- OUT (separate later sessions, already planned): users/memberships CRUD (no routes exist; net-new feature with its own threat model); AI-key WRITE (stays `requireSessionUser` — the operator runs *on* a key, never writes it); workspace CREATE (instance bootstrap, session-only — not an operator job); the risk-SCORED gate (objects/reversibility scorer — v1 ships the coarse per-resource default only).
- NO per-resource tools. The agent reaches all this through the single `folio_api` primitive (Phase 3). Phase 2 only guarantees the route contract the skill will document.

---

## Threat model

> This threat model covers Phase 2 of the operator-agent build: promoting four dead route-guard scopes into one real canonical `config:write` scope, and adding a `dryRun` preview contract to config-mutation routes. Written 2026-06-01, after Phase 1 (caller-identity delegation) merged. It EXTENDS the Phase-1 model (D1–D10, in `docs/superpowers/plans/2026-06-01-operator-agent-phase-1-caller-delegation.md`) — those mitigations are inherited, not restated. New attacks/mitigations are numbered **P2-1 … P2-N**. It exists so `/code-review` converges in one pass instead of re-discovering the surface; the surface is small (route plumbing) but it touches the scope system and the delegate ceiling, so it qualifies.

### What we're defending

1. **The scope ceiling itself** — the Phase-1 invariant that a run's effective authority is `agent ∩ caller`, fail-closed, enforced centrally in `executeTool` (double-membership scope check) and `loadContext` (project narrowing). Adding a new scope must not create a path that escapes this ceiling.
2. **Workspace/project structure integrity** — tables, fields, views, statuses define how every document in a project is shaped and read. A token that can rewrite them can corrupt or exfiltrate the shape of an entire project.
3. **The human-only surfaces that MUST stay human-only** — AI-key write (`requireSessionUser` in `settings.ts`/`ai.ts`), workspace create/rename/delete (`requireSessionUser` in `workspaces.ts`). Phase 2 must not accidentally widen these to token auth.
4. **The tenant boundary** — every config route already re-asserts workspace membership (`resolveWorkspace`) + project membership (`resolveProject`) + agent allow-list (`requireResource`). Phase 2 must preserve all three, including on the new dryRun path.
5. **Event-log integrity** — every real mutation emits an event (`every write emits an event`). A dryRun must emit NOTHING (no phantom events agents could react to).

### Who we're defending against

1. **A compromised / prompt-injected operator agent** (IN scope) — runs with a workspace token + caller delegation. The whole point of the ceiling is that even a fully-steered agent can't exceed its caller. `config:write` must inherit that ceiling.
2. **A workspace `member` (non-admin) trying to escalate** (IN scope) — members get `documents:read|write` only via `roleToScopes`. They must NOT be able to delegate `config:write` (structure changes are an owner/admin act).
3. **An external attacker with a stolen agent bearer** (IN scope, already mitigated by Phase-1 + tenant guards) — the token is workspace-pinned + project-allow-listed; `config:write` rides the same guards.
4. **A holder of a non-agent human PAT** (PARTIAL — same as Phase 1) — `requireResource` bypasses project narrowing for human PATs (no UI to narrow yet). This is a pre-existing Phase-1 boundary, NOT widened here; noted, not re-solved.
5. **Insider with stolen session cookie** (OUT of scope) — acknowledged; session auth is the trust root.

### Attacks to defend against

- **P2-1 — Member self-escalation to config:write.** A workspace member starts an operator run; if `roleToScopes('member')` returned `config:write`, the member's delegated authority would include structure mutation they can't perform in the UI as a member. (Vulnerability class: privilege escalation via delegation mapping.)
- **P2-2 — Token holds config:write but caller doesn't (or vice-versa).** If the new scope is added to only ONE of `toolsToScopes`/`roleToScopes`, the double-membership check in `executeTool` would either silently deny (agent can't act even as owner — a correctness bug) or, if the ceiling were bypassed, allow (escalation). The scope must be wired into BOTH sides consistently so `agent ∩ caller` holds. (Class: ceiling-inconsistency.)
- **P2-3 — dryRun leaks data the real call would redact.** If a dryRun response serializes a would-be row that includes a field the real GET path redacts (e.g. any secret), dryRun becomes a redaction-bypass oracle. (Class: redaction-path divergence — `project_redact-at-the-loader-not-the-handler`.)
- **P2-4 — dryRun mutates anyway.** A dryRun that still inserts/updates/emits (e.g. the flag checked AFTER `txWithEvents`, or only on one of create/update/delete) silently changes state while claiming to preview. (Class: contract violation / state leak.)
- **P2-5 — Scope retarget accidentally widens a human-only route.** While editing route guards, mistakenly converting an AI-key or workspace-create route from `requireSessionUser` to `requireScope('config:write')` opens the highest-value secret/bootstrap surface to tokens. (Class: surface widening via edit error.)
- **P2-6 — dryRun bypasses the tenant/membership guard.** If the dryRun early-return is placed BEFORE the membership/allow-list/not-found checks, an agent could probe existence of resources (404 vs 200) or "preview" mutations on projects it isn't allow-listed for. (Class: auth-ordering / existence oracle.)
- **P2-7 — New scope not enforced at the central ceiling for the eventual folio_api path.** Phase 3's `folio_api` will dispatch through `executeTool`; if `config:write` mutation paths were reachable via a tool whose `requiredScope` didn't actually gate them, the ceiling wouldn't apply. (Class: ceiling-coverage gap — flagged here, enforced when `folio_api` lands in Phase 3.)
- **P2-8 — `dryRun` accepted on a GET/read route or silently ignored on a route that didn't implement it.** Inconsistent contract → the skill can't promise dryRun universally and an agent's "preview" silently becomes a real write on the un-converted route. (Class: contract inconsistency.)

### Mitigations required

- **P2-1 → `roleToScopes` keeps `config:write` in the owner/admin tier ONLY.** In `apps/server/src/lib/agent-schema.ts`, `config:write` is added to `ALL_DOCUMENT_SCOPES` (owner/admin get it via the spread) and explicitly NOT added to the `member` return branch (`return ['documents:read', 'documents:write']`). A test asserts `roleToScopes('member')` does NOT include `config:write`.
- **P2-2 → `config:write` wired into BOTH derivation functions consistently.** `toolsToScopes` gains a `CONFIG_WRITE_TOOLS` group (the future `folio_api` tool, or — until that exists — any config tool) mapping to `config:write` + `documents:read`; `roleToScopes` includes it for owner/admin via `ALL_DOCUMENT_SCOPES`. A test proves an owner-delegated run's effective authority (`agent ∩ caller`) can include `config:write` while a member-delegated run cannot, exercising the real `executeTool` double-check.
- **P2-3 → dryRun returns ONLY the same shape the route's success response returns.** Each route's dryRun branch returns `{ dry_run: true, would, resource }` where `resource` is the EXACT object the non-dryRun branch returns (the built `row`/`{...row, ...updates}`). Config rows (tables/fields/views/statuses/projects) contain no secrets — confirmed in ground-truth — so there is no redaction path to diverge from; a test asserts the dryRun `resource` is structurally identical to the live-create response for the same input.
- **P2-4 → dryRun guard sits IMMEDIATELY before `txWithEvents`, returns before it, on ALL of create/update/delete.** Pattern per route: after validation + membership + not-found checks + building the would-be row, `if (dryRun) return jsonOk(c, { dry_run: true, would, resource });` THEN the existing `txWithEvents` block. A test per verb asserts: dryRun create inserts 0 rows + emits 0 events; dryRun update changes nothing; dryRun delete deletes nothing; and the events table count is unchanged across all three.
- **P2-5 → human-only routes are NOT touched.** The retarget edits ONLY the four files with dead scopes (`tables.ts`, `fields.ts`, `views.ts`, `statuses.ts`) + the project config routes. `settings.ts`, `ai.ts`, and the `workspaces.ts` create/rename/delete guards keep `requireSessionUser` verbatim. A test asserts a token (no session) still gets 401/403 on `POST /ai-keys` and `POST /workspaces` after this phase (regression guard against accidental widening).
- **P2-6 → dryRun early-return placed AFTER all auth + existence checks.** In each route the order is: `requireScope` middleware (config:write) → `resolveWorkspace`/`resolveProject`/`requireResource` middleware (membership + allow-list) → in-handler not-found lookup (for update/delete) → build row → **dryRun return** → mutate. A test asserts a dryRun against a non-allow-listed project still 403s, and a dryRun update against a missing slug still 404s (same as the live path).
- **P2-7 → flagged for Phase 3.** When `folio_api` is registered in Phase 3, its `requiredScope` for mutating config calls MUST be `config:write` so the central `executeTool` ceiling applies. Recorded here; the Phase-3 plan's threat model inherits it. No Phase-2 code (Phase 2 ships no tool).
- **P2-8 → dryRun is accepted ONLY on the mutating routes, parsed identically everywhere.** A single shared helper `readDryRun(c)` (in `lib/http.ts` or a small `lib/dry-run.ts`) reads the flag from the validated JSON body (`dryRun?: boolean`, default false) so every route parses it the same way; GET routes never call it. The four config route files + project routes all use the helper. A test asserts each mutating route honors `dryRun` and that an unknown `dryRun` value type is rejected by the Zod schema (not silently coerced).

### Out of scope (explicit deferrals)

- **Users/memberships CRUD** — no routes exist; net-new feature, its own session + threat model (Stefan, deferred).
- **AI-key write via token** — stays `requireSessionUser`; the operator never writes the key it runs on.
- **Workspace create/rename/delete via token** — instance-bootstrap + destructive; stays session-only.
- **The risk-SCORED approval gate** (per-object reversibility scoring) — v1 ships the coarse per-resource default; the scorer drops in later. The `awaiting_approval` PAUSE side (Phase 3.x) gates high-risk APPLY; Phase 2 routes are low/medium-risk reversible config, so they need no approval gate.
- **dryRun returning a structured field-level diff** (`{ before, after }` per field) — v1 returns the would-be resource, not a diff. A richer diff is a Phase-3/skill concern if the operator needs it.
- **Master-key rotation, DNS rebinding, SSRF** — no outbound HTTP or credential surface added in Phase 2; inherited Phase-1/Phase-3-B mitigations stand unchanged.

### How to use this section

- **Controller pre-flight:** before dispatching each task, verify the task's code carries the P2-mitigation named in its task header.
- **`/code-review` invocations:** "Verify code against the Phase 2 threat model. Each P2-mitigation should be checked: in place / missing / out-of-scope per deferrals. Also verify the inherited Phase-1 D1–D10 ceiling is not weakened by the new scope."
- **`/evaluate` retro:** list any P2-mitigation not implemented as a plan-correction defect.
- **Phase 3 (`folio_api`):** inherits P2-7 (config mutations route through `executeTool` with `requiredScope: 'config:write'`); cross-reference, don't re-litigate.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/agent-schema.ts` | Scope derivation (`roleToScopes`, `toolsToScopes`, `ALL_DOCUMENT_SCOPES`) | Add `config:write` to canonical set + a `CONFIG_WRITE_TOOLS` group |
| `apps/server/src/lib/dry-run.ts` | NEW — shared `readDryRun(c)` + the dryRun response shape helper | Create |
| `apps/server/src/routes/tables.ts` | Tables create/update/delete | Retarget guard → `config:write`; add dryRun to 3 verbs |
| `apps/server/src/routes/fields.ts` | Fields create/update/delete | Retarget guard → `config:write`; add dryRun to 3 verbs |
| `apps/server/src/routes/views.ts` | Views create/update/delete | Retarget guard → `config:write`; add dryRun to 3 verbs |
| `apps/server/src/routes/statuses.ts` | Statuses create/update/delete | Retarget guard → `config:write`; add dryRun to 3 verbs |
| `apps/server/src/routes/projects.ts` | Project create/update/delete | Add `requireScope('config:write')` to mutating routes (currently scope-less but bearer-OK); add dryRun |
| `apps/server/src/routes/*.test.ts` (per route) | Route tests | New dryRun + scope tests per route |
| `apps/server/src/lib/agent-schema.test.ts` | Scope-derivation tests | New tests for `config:write` in both functions |

**Note on the scope retarget mechanics:** `requireScope(scope)` (bearer.ts:76) checks `token.scopes.includes(scope)` and **bypasses entirely for session users** (line 81: `if (user && !t) return next()`). So retargeting the guard to `config:write` does NOT break the human UI — sessions pass via membership as before. It only changes which *token* scope is required.

---

## Task 1: Introduce the `config:write` canonical scope

**Mitigations: P2-1, P2-2.**

**Files:**
- Modify: `apps/server/src/lib/agent-schema.ts:42-95`
- Test: `apps/server/src/lib/agent-schema.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/src/lib/agent-schema.test.ts
import { describe, expect, test } from 'bun:test';
import { roleToScopes, toolsToScopes } from './agent-schema.ts';

describe('config:write scope', () => {
  test('owner and admin can delegate config:write', () => {
    expect(roleToScopes('owner')).toContain('config:write');
    expect(roleToScopes('admin')).toContain('config:write');
  });

  test('member CANNOT delegate config:write (P2-1)', () => {
    expect(roleToScopes('member')).not.toContain('config:write');
    // member keeps exactly its day-to-day scopes
    expect(roleToScopes('member')).toEqual(['documents:read', 'documents:write']);
  });

  test('the config tool maps to config:write + read (P2-2)', () => {
    // folio_api is the Phase-3 tool; until it exists we register the group so
    // the derivation is consistent. Assert the mapping exists for the tool name.
    const scopes = toolsToScopes(['folio_api']);
    expect(scopes).toContain('config:write');
    expect(scopes).toContain('documents:read');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts`
Expected: FAIL — `roleToScopes('owner')` does not contain `config:write`; `toolsToScopes(['folio_api'])` returns `[]`.

- [ ] **Step 3: Implement — add `config:write` to the canonical set + a CONFIG_WRITE_TOOLS group**

In `apps/server/src/lib/agent-schema.ts`, change the canonical set (line 65):

```typescript
const ALL_DOCUMENT_SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'agents:write',
  'config:write',
] as const;
```

Add a config-write tool group after `AGENT_WRITE_TOOLS` (after line 58):

```typescript
// Phase 2 (operator) — structure/config mutation (tables, fields, views,
// statuses, project config) is reached through the general folio_api primitive
// (Phase 3), gated on the new canonical config:write scope. Registered here so
// toolsToScopes is consistent the moment folio_api is added; owner/admin gets
// config:write via ALL_DOCUMENT_SCOPES in roleToScopes.
const CONFIG_WRITE_TOOLS: ReadonlySet<string> = new Set(['folio_api']);
```

Add the mapping inside the `toolsToScopes` loop (after the `AGENT_WRITE_TOOLS` block, before the closing `}` of the for-loop, ~line 92):

```typescript
    if (CONFIG_WRITE_TOOLS.has(tool)) {
      scopes.add('config:write');
      scopes.add('documents:read'); // config edits imply reading structure
    }
```

`roleToScopes` needs NO change to its member branch — `config:write` flows to owner/admin automatically via the `ALL_DOCUMENT_SCOPES` spread, and the member branch is a hard-coded literal that deliberately excludes it (P2-1).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Run the existing agent-schema / scope tests to confirm no regression**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts && bun x tsc --noEmit`
Expected: PASS + clean tsc. (Existing `toolsToScopes`/`roleToScopes` callers are unaffected — the new scope is additive.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/agent-schema.ts apps/server/src/lib/agent-schema.test.ts
git commit -m "phase-op-2: add config:write canonical scope (owner/admin only)"
```

---

## Task 2: Shared `dryRun` helper

**Mitigations: P2-3, P2-8.**

**Files:**
- Create: `apps/server/src/lib/dry-run.ts`
- Test: `apps/server/src/lib/dry-run.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/src/lib/dry-run.test.ts
import { describe, expect, test } from 'bun:test';
import { dryRunResult } from './dry-run.ts';

describe('dryRunResult', () => {
  test('wraps a resource with the dry_run envelope (P2-3)', () => {
    const row = { id: 'x', name: 'Tasks' };
    expect(dryRunResult('create', row)).toEqual({
      dry_run: true,
      would: 'create',
      resource: { id: 'x', name: 'Tasks' },
    });
  });

  test('resource is passed through verbatim — no redaction divergence', () => {
    const row = { id: 'y', name: 'Docs', icon: null, order: 3 };
    expect(dryRunResult('update', row).resource).toBe(row);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/dry-run.test.ts`
Expected: FAIL — module `dry-run.ts` not found.

- [ ] **Step 3: Implement the helper**

```typescript
// apps/server/src/lib/dry-run.ts
import type { Context } from 'hono';

/**
 * Phase 2 (operator). The uniform preview contract for config mutations.
 *
 * `dryRun: true` on a mutating route validates + builds the would-be resource
 * and returns this envelope WITHOUT inserting or emitting any event. The
 * `resource` is the EXACT object the live (non-dryRun) success branch returns,
 * so a dryRun never leaks a field the real response wouldn't (mitigation P2-3).
 * Config rows carry no secrets, so there's no redaction path to diverge from.
 */
export type DryRunVerb = 'create' | 'update' | 'delete';

export interface DryRunEnvelope<T> {
  dry_run: true;
  would: DryRunVerb;
  resource: T;
}

export function dryRunResult<T>(would: DryRunVerb, resource: T): DryRunEnvelope<T> {
  return { dry_run: true, would, resource };
}

/**
 * Read the dryRun flag off a request whose body has already been Zod-validated
 * to carry an optional `dryRun: boolean`. Single reader so every route parses
 * the flag identically (mitigation P2-8). Defaults to false.
 *
 * Pass the already-validated json object (from `c.req.valid('json')`) — we read
 * the flag from there, not from raw query/body, so an invalid type is rejected
 * by Zod before it reaches here.
 */
export function isDryRun(validatedJson: { dryRun?: boolean } | undefined): boolean {
  return validatedJson?.dryRun === true;
}

// Re-exported for symmetry with other lib helpers that take Context; unused for
// now (routes read from the validated json), kept minimal per YAGNI.
export type { Context };
```

> Note: we deliberately read `dryRun` from the **Zod-validated** json (so an attacker can't pass `dryRun: "yes"` and have it coerced) rather than from `c.req.query`. Each route's schema gains `dryRun: z.boolean().optional()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/dry-run.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/dry-run.ts apps/server/src/lib/dry-run.test.ts
git commit -m "phase-op-2: shared dryRun envelope + flag reader (P2-3, P2-8)"
```

---

## Task 3: Tables — retarget scope + dryRun (create/update/delete)

**Mitigations: P2-2, P2-4, P2-6, P2-8.**

**Files:**
- Modify: `apps/server/src/routes/tables.ts` (guard at 48/90/124; schemas at 18-37; handlers)
- Test: `apps/server/src/routes/tables.test.ts` (create if absent; otherwise extend)

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/routes/tables.test.ts` (use the existing test harness pattern from a sibling route test, e.g. `views.test.ts` or `fields.test.ts` — they set up an in-memory db, seed a workspace/project/table, and mint tokens with given scopes via the test helpers). The three behaviors to pin:

```typescript
// 1. A config:write token can create a table (was previously impossible —
//    tables:write was a dead scope no token could hold).
test('config:write token creates a table', async () => {
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/tables`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sprints' }),
  });
  expect(res.status).toBe(201);
});

// 2. A documents:write-only token is REJECTED (config:write required).
test('documents:write token cannot create a table', async () => {
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/tables`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nope' }),
  });
  expect(res.status).toBe(403);
});

// 3. dryRun create inserts nothing + emits nothing (P2-4).
test('dryRun create does not mutate', async () => {
  const before = await countTables(proj.id);
  const beforeEvents = await countEvents();
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/tables`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Preview', dryRun: true }),
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.dry_run).toBe(true);
  expect(json.data.would).toBe('create');
  expect(json.data.resource.name).toBe('Preview');
  expect(await countTables(proj.id)).toBe(before);
  expect(await countEvents()).toBe(beforeEvents);
});

// 4. dryRun delete against a missing slug still 404s (P2-6 — auth/existence
//    checks run before the dryRun return).
test('dryRun delete on missing table 404s', async () => {
  const res = await app.request(`/api/v1/w/${ws.slug}/p/${proj.slug}/tables/does-not-exist?_=1`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  });
  expect(res.status).toBe(404);
});
```

> Helper notes for the implementer: `countTables(projectId)` = `db.select().from(tables).where(eq(tables.projectId, projectId))` length; `countEvents()` = count of the `events` table. Mint `configWriteToken` with scopes `['config:write','documents:read']` and `docsWriteToken` with `['documents:write','documents:read']` using the same token-seeding helper the sibling route tests use (grep `scopes:` in an existing `*.test.ts`). DELETE carries a JSON body, so the test sends `Content-Type: application/json` + body; the route must read dryRun from a validated body on DELETE too (see Step 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun test src/routes/tables.test.ts`
Expected: FAIL — create returns 403 for `configWriteToken` (guard still `tables:write`); dryRun create still inserts.

- [ ] **Step 3: Implement — retarget guard + add dryRun**

In `apps/server/src/routes/tables.ts`:

(a) Import the helper at the top (after the existing imports):

```typescript
import { dryRunResult, isDryRun } from '../lib/dry-run.ts';
```

(b) Add `dryRun` to the create + patch schemas (lines 18-37):

```typescript
const baseSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  icon: z.string().max(32).nullable().optional(),
  order: z.number().int().optional(),
  dryRun: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  icon: z.string().nullable().optional(),
  order: z.number().int().optional(),
  dryRun: z.boolean().optional(),
});

// DELETE has no body schema today; add a tiny one so dryRun is validated, not
// read raw (P2-8).
const deleteSchema = z.object({ dryRun: z.boolean().optional() });
```

(c) Retarget the three guards `requireScope('tables:write')` → `requireScope('config:write')` (lines 48, 90, 124).

(d) CREATE — insert the dryRun early-return after the row is built, before `txWithEvents` (the row is built at lines 68-76; add immediately after, before line 77):

```typescript
  if (isDryRun(input)) {
    return jsonOk(c, dryRunResult('create', row));
  }
```

(e) PATCH — after `updates` is assembled (after line 107) and AFTER the not-found check (line 98 already ran), insert before `txWithEvents` (line 109):

```typescript
  if (isDryRun(patch)) {
    return jsonOk(c, dryRunResult('update', { ...row, ...updates }));
  }
```

(f) DELETE — add the validator so the body is parsed, then the early-return after the not-found check (line 132), before `txWithEvents` (line 134). Change the route signature to include the validator:

```typescript
tablesRoute.delete(
  '/:tslug',
  requireScope('config:write'),
  zValidator('json', deleteSchema),
  async (c) => {
    // ... existing user/p/ws/tslug + not-found lookup (unchanged) ...
    if (isDryRun(c.req.valid('json'))) {
      return jsonOk(c, dryRunResult('delete', { id: row.id, slug: row.slug, name: row.name }));
    }
    await txWithEvents(db, async (tx) => { /* unchanged */ });
    return c.body(null, 204);
  },
);
```

> The DELETE `zValidator('json', …)` requires a JSON body. Hono's zValidator tolerates an empty/absent body when all fields are optional? — verify: if an existing client sends DELETE with no body and the validator rejects it, make the validator lenient by reading the body defensively. Confirm against the existing DELETE callers (web client + tests) in Step 4; if any send no body, switch DELETE to read dryRun via `c.req.query('dryRun') === 'true'` instead of a body schema (query is acceptable for the no-body verb — note the parse path divergence in a comment for P2-8).

- [ ] **Step 4: Run tests to verify they pass + check existing DELETE callers**

Run: `cd apps/server && bun test src/routes/tables.test.ts`
Expected: PASS (4 new). Also grep the web client + existing tests for `DELETE` on tables to confirm the body-vs-query decision holds:

Run: `grep -rn "method: 'DELETE'" apps/web/src | grep -i table` and inspect; if web sends no body, the query-param fallback for DELETE is correct.

- [ ] **Step 5: tsc + commit**

```bash
cd apps/server && bun x tsc --noEmit
git add apps/server/src/routes/tables.ts apps/server/src/routes/tables.test.ts
git commit -m "phase-op-2: tables route — config:write guard + dryRun (P2-2/4/6/8)"
```

---

## Task 4: Fields — retarget scope + dryRun

**Mitigations: P2-2, P2-4, P2-6, P2-8.** Mirror Task 3 exactly for `apps/server/src/routes/fields.ts`.

**Files:**
- Modify: `apps/server/src/routes/fields.ts` (guards at 67/105/183; schema at 18-24; handlers)
- Test: `apps/server/src/routes/fields.test.ts`

- [ ] **Step 1: Write failing tests** — copy Task 3's four tests, adapted: create a field (`POST …/fields` body `{ key: 'priority', type: 'select', name: 'Priority' }` — match the existing `baseSchema` in fields.ts:18-24, then add `dryRun`); the config:write-creates / docs:write-rejected / dryRun-no-mutate / dryRun-404-on-missing checks are identical in shape. Use `countFields(tableId)`.

- [ ] **Step 2: Run to verify fail** — `cd apps/server && bun test src/routes/fields.test.ts` → FAIL (guard still `fields:write`).

- [ ] **Step 3: Implement** — identical pattern: import `dryRunResult, isDryRun`; add `dryRun: z.boolean().optional()` to the field `baseSchema` (and `.partial()` PATCH inherits it); add a `deleteSchema` for DELETE; retarget the three `requireScope('fields:write')` → `requireScope('config:write')`; insert the three early-returns after row-build / after updates-assembly / after not-found, each before its `txWithEvents`. Use `'create'`/`'update'`/`'delete'` verbs.

- [ ] **Step 4: Run to verify pass + tsc** — `cd apps/server && bun test src/routes/fields.test.ts && bun x tsc --noEmit` → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/fields.ts apps/server/src/routes/fields.test.ts
git commit -m "phase-op-2: fields route — config:write guard + dryRun"
```

---

## Task 5: Views — retarget scope + dryRun

**Mitigations: P2-2, P2-3, P2-4, P2-6, P2-8.** Mirror Task 3 for `apps/server/src/routes/views.ts`. Views carry a `filters` config object (validated by `validateFilters`) — assert the dryRun create response's `resource.filters` matches the input (P2-3 structural-identity check).

**Files:**
- Modify: `apps/server/src/routes/views.ts` (guards at 47/80/103; schema at 18-28; handlers)
- Test: `apps/server/src/routes/views.test.ts`

- [ ] **Step 1: Write failing tests** — Task 3's four tests adapted for views (`POST …/views` body matching views.ts:18-28 `baseSchema` + `dryRun`), PLUS a fifth: `dryRun create resource equals the live-create resource for the same input` (build two identical inputs, one dryRun one real, assert `dryRunResp.resource` deep-equals the real `resource` minus volatile fields like `id`). Use `countViews(tableId)`.

- [ ] **Step 2: Run to verify fail** — `cd apps/server && bun test src/routes/views.test.ts` → FAIL.

- [ ] **Step 3: Implement** — same pattern. `validateFilters(input.filters)` MUST still run before the dryRun return (so a dryRun with bad filters 400s the same as a real call — preserves P2-6 ordering: validation before preview). Retarget `requireScope('views:write')` ×3 → `config:write`. Verbs `'create'`/`'update'`/`'delete'`.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/views.ts apps/server/src/routes/views.test.ts
git commit -m "phase-op-2: views route — config:write guard + dryRun"
```

---

## Task 6: Statuses — retarget scope + dryRun

**Mitigations: P2-2, P2-4, P2-6, P2-8.** Mirror Task 3 for `apps/server/src/routes/statuses.ts` (guards at 26/72/112). Statuses schemas are inline in the POST/PATCH handlers (statuses.ts:29-36) — add `dryRun: z.boolean().optional()` to those inline schemas.

**Files:**
- Modify: `apps/server/src/routes/statuses.ts`
- Test: `apps/server/src/routes/statuses.test.ts`

- [ ] **Step 1: Write failing tests** — Task 3's four, adapted (`POST …/statuses`). Use `countStatuses(tableId)`.
- [ ] **Step 2: Run to verify fail** — FAIL (guard `statuses:write`).
- [ ] **Step 3: Implement** — retarget `requireScope('statuses:write')` ×3 → `config:write`; add `dryRun` to the inline schemas; three early-returns before each `txWithEvents`.
- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/statuses.ts apps/server/src/routes/statuses.test.ts
git commit -m "phase-op-2: statuses route — config:write guard + dryRun"
```

---

## Task 7: Project config routes — add scope guard + dryRun

**Mitigations: P2-2, P2-4, P2-5, P2-6.** Project create/update/delete (`projects.ts:32/86/115`) are currently **scope-less but bearer-OK** (they pass via `wScope`/`pScope` membership). The operator needs to create + configure projects. Add `requireScope('config:write')` to the THREE mutating project routes + dryRun. DELETE is owner-only (projects.ts:116) — keep that role gate; `config:write` is additive on top of it.

> P2-5 guard: do NOT touch `workspaces.ts` (workspace create/rename/delete stay `requireSessionUser`). Only `projects.ts` changes here.

**Files:**
- Modify: `apps/server/src/routes/projects.ts` (POST 32-78, PATCH 86-113, DELETE 115-152)
- Test: `apps/server/src/routes/projects.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// config:write token can create a project
test('config:write token creates a project', async () => {
  const res = await app.request(`/api/v1/w/${ws.slug}/p`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Project' }),
  });
  expect(res.status).toBe(201);
});

// docs:write token CANNOT create a project (newly gated)
test('documents:write token cannot create a project', async () => {
  const res = await app.request(`/api/v1/w/${ws.slug}/p`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nope' }),
  });
  expect(res.status).toBe(403);
});

// dryRun create does not mutate
test('dryRun project create does not mutate', async () => {
  const before = await countProjects(ws.id);
  const res = await app.request(`/api/v1/w/${ws.slug}/p`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Preview', dryRun: true }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.dry_run).toBe(true);
  expect(await countProjects(ws.id)).toBe(before);
});

// P2-5 regression: workspace create is STILL session-only after this phase
test('token cannot create a workspace (session-only preserved)', async () => {
  const res = await app.request(`/api/v1/workspaces`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hax' }),
  });
  expect([401, 403]).toContain(res.status);
});
```

- [ ] **Step 2: Run to verify fail** — `cd apps/server && bun test src/routes/projects.test.ts` → FAIL (docs:write currently CREATES a project; no guard).

- [ ] **Step 3: Implement** — In `projects.ts`: import `dryRunResult, isDryRun`; add `dryRun: z.boolean().optional()` to the POST inline schema (32-45) and PATCH schema; add a DELETE `deleteSchema`. Add `requireScope('config:write')` as the FIRST middleware arg on POST (line 32), PATCH (line 86), DELETE (line 115) — note these mount under `pScope`/`wScope` which already attach the token, so `requireScope` composes correctly. Insert the dryRun early-returns: POST after the row is built + slug resolved, before `txWithEvents` (line 65); PATCH after updates assembled, before `txWithEvents`; DELETE after the owner-role check + not-found, before `txWithEvents`. The P2-5 workspace test passes WITHOUT any code change (it's a regression guard) — `workspaces.ts` is untouched.

> Ordering note (P2-6): `requireScope` runs as middleware (before handler), `pScope` membership runs before it in the chain (app.ts:67), and the owner-role check on DELETE (projects.ts:116) stays before the dryRun return. So a dryRun delete by a non-owner still 403s.

- [ ] **Step 4: Run to verify pass + tsc** — PASS (4 new) + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/projects.ts apps/server/src/routes/projects.test.ts
git commit -m "phase-op-2: project routes — config:write guard + dryRun; workspace stays session-only (P2-5)"
```

---

## Task 8: End-to-end delegate-ceiling test (the payoff)

**Mitigations: P2-1, P2-2, P2-7 (documented).** Prove the Phase-1 ceiling now covers `config:write`: an owner-delegated run CAN reach a config route's scope, a member-delegated run CANNOT — exercised through the real `executeTool` double-membership check, not a unit stub.

**Files:**
- Test: `apps/server/src/lib/agent-tools.test.ts` (extend) OR a new `apps/server/src/lib/config-scope-ceiling.test.ts`

- [ ] **Step 1: Write the test**

Model it on the existing Phase-1 delegate-ceiling tests (grep `callerScopes` in `agent-tools.test.ts`). The test registers a throwaway tool requiring `config:write`, then calls `executeTool` twice:

```typescript
import { describe, expect, test } from 'bun:test';
import { executeTool, registerTool } from './agent-tools.ts';

// A throwaway config-scoped tool that just echoes — proves the ceiling, not behavior.
registerTool({
  name: '__config_probe',
  requiredScope: 'config:write',
  schema: z.object({}).strict(),
  handler: async () => ({ ok: true }),
});

describe('config:write delegate ceiling (P2-2)', () => {
  const agentToken = { /* ...minimal ApiToken... */ scopes: ['config:write', 'documents:read'] } as ApiToken;

  test('owner-delegated run (caller holds config:write) passes', async () => {
    const res = await executeTool(agentToken, 'agent:op', '__config_probe', {}, undefined, {
      callerScopes: ['config:write', 'documents:read'],
    });
    expect(res).toEqual({ ok: true });
  });

  test('member-delegated run (caller lacks config:write) is denied — fail closed (P2-1)', async () => {
    await expect(
      executeTool(agentToken, 'agent:op', '__config_probe', {}, undefined, {
        callerScopes: ['documents:read', 'documents:write'], // member scopes — no config:write
      }),
    ).rejects.toThrow(/forbidden: scope config:write/);
  });

  test('agent token lacks config:write → denied even if caller has it', async () => {
    const weakToken = { ...agentToken, scopes: ['documents:read'] } as ApiToken;
    await expect(
      executeTool(weakToken, 'agent:op', '__config_probe', {}, undefined, {
        callerScopes: ['config:write'],
      }),
    ).rejects.toThrow(/forbidden: scope config:write/);
  });
});
```

> Grep `agent-tools.test.ts` for the exact `ApiToken` test-fixture shape and reuse it; the three minimal fields the ceiling reads are `scopes`, `agentId`, `projectIds`. The probe tool name `__config_probe` mirrors the existing `__echo` test-tool convention.

- [ ] **Step 2: Run to verify** — `cd apps/server && bun test src/lib/config-scope-ceiling.test.ts` → PASS (3). The double-membership check in `executeTool` (agent-tools.ts:160) already enforces this once Task 1 added the scope; this test is the proof, not new logic.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/config-scope-ceiling.test.ts
git commit -m "phase-op-2: prove config:write inherits the Phase-1 delegate ceiling (P2-1/2)"
```

---

## Task 9: Integration gate + full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Full server suite from inside apps/server**

Run: `cd apps/server && bun test`
Expected: all pass, 0 fail (server was 1092/0 at Phase-1 merge; this phase adds tasks 1-8's tests). ⚠️ Run from INSIDE `apps/server` — root cwd fakes the ~650-fail cascade.

- [ ] **Step 2: Shared + web unaffected (server-only phase)**

Run: `cd packages/shared && bun test` (expect 63/0) and `cd apps/web && npx vitest run` (expect 725/8-skip/0 — Phase 2 is server-only; web should be untouched).

- [ ] **Step 3: tsc clean per app**

Run: `cd apps/server && bun x tsc --noEmit` (web/shared unchanged but run them if anything was touched).

- [ ] **Step 4: Migration check** — Phase 2 adds NO migration (scope strings are runtime arrays, not DB columns; `apiTokens.scopes` is already a JSON text column accepting any string). Confirm no new `.sql` files: `git status apps/server/src/db/migrations`.

- [ ] **Step 5: Run `/integration`** to advance the `.last-integration` marker, then announce the `/code-review` to run on the branch diff with the threat model as input.

---

## Self-Review (run before dispatch)

**Spec coverage:** Every resource in the locked scope boundary has a task — tables (3), fields (4), views (5), statuses (6), projects (7). The scope (1) + helper (2) + ceiling-proof (8) tasks make the surface real. Users/AI-key/workspace-create are explicitly deferred (P2-5 guards the last two). ✅

**Placeholder scan:** Tasks 4/5/6 say "mirror Task 3" — per writing-plans this is acceptable ONLY because Task 3 carries the full code and the variations are spelled out (which schema lines, which guard strings, which count helper, which verbs). The implementer reads Task 3's code as the template. No TBDs.

**Type consistency:** `dryRunResult(verb, resource)` / `isDryRun(validatedJson)` used identically in tasks 3-7. `config:write` string identical everywhere. `requireScope('config:write')` matches the canonical set added in Task 1. ✅

**Open implementation question flagged for the implementer (Task 3 Step 3f):** DELETE-with-body vs DELETE-with-query for the dryRun flag — resolved during Task 3 by checking existing DELETE callers; whichever is chosen is applied consistently across tasks 3-7. This is the one place the implementer must ground-truth a client behavior before locking the pattern.

---

## Execution Handoff

Plan complete. Recommended: **subagent-driven** (`superpowers:subagent-driven-development` via `netdust-core:ntdst-execute-with-tests`) — fresh subagent per task, two-stage review (spec then quality) per task, controller verifies the named P2-mitigation per task. After Task 9: `/code-review high` with the threat model as input, then `/integration`, `/shakeout`, merge.
