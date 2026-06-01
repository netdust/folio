# Operator Agent — Phase 3: The Agent (`folio_api` + skill + memory + seed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PREREQUISITE: Phase 2 (token-scoped config write surface + dryRun) must be merged first.** This plan calls the config routes Phase 2 made reachable. Plan: `docs/superpowers/plans/2026-06-01-operator-agent-phase-2-token-scoped-write-surface.md`.

**Goal:** Ship the built-in operator agent: a general `folio_api`/`folio_api_get` tool pair (the escape hatch reaching any token-scoped route), the `folio` skill (the API manual, as workspace content), a 2-layer agent memory (working log + workspace profile, as hidden documents), and a seeded operator-agent document born into every workspace — riding the entire Phase-1/Phase-2/Phase-3-runner spine with NO new interface.

**Architecture:** `folio_api` dispatches **in-process HTTP** (`app.request(...)`) using a **short-lived ephemeral bearer token** minted from `ctx.token` — the exact pattern `ccExecute` already uses for Claude Code (`runner.ts:881-895`). The plaintext token does not survive mint (`ctx.token` is hash-only), so in-process HTTP with a fresh ephemeral token is how the tool authenticates as the delegate; the Phase-1 ceiling applies for free because the ephemeral token carries `ctx.token.scopes` (already `agent ∩ caller`). Reads go through `folio_api_get` (GET-only, ungated beyond the token's read scope); writes go through `folio_api` (gated: high-risk → compute dryRun, post the plan, REFUSE to apply until the approval-gate PAUSE side lands). Memory + the seeded agent ride the document primitive — reserved-slug `page` documents flagged `folio_system: true`, filtered out of the wiki overview but readable/writable by the agent and surfaceable in the sidepanel.

**Tech Stack:** Bun, Hono (`app.request` in-process), Drizzle, Zod, the shared tool registry (`lib/agent-tools-registry.ts` + `lib/agent-tools.ts`), `newApiToken()`, the seed pattern (`seedBuiltinTriggers`/`seedProjectDefaults`).

**Decisions locked with Stefan 2026-06-01:**
- **`folio_api` is SPLIT** — `folio_api_get` (reads, ungated) + `folio_api` (writes, gated). Cleaner auto-vs-plan boundary at the tool layer.
- **Memory = documents with frontmatter**, hidden from the wiki overview (`folio_system: true`), NOT a new table. Two reserved-slug `page` docs per workspace. Surfaceable in the sidepanel on demand.
- **High-risk → REFUSE, but the refusal surfaces the dryRun plan/diff** (posts the proposed plan as a comment, declines to apply). The approval gate's exit paths (resume/reject) are already built; only `request_approval` + the `running → awaiting_approval` transition are missing, so the later refuse→pause upgrade is a localized swap.
- **Provider: API only** (`anthropic`/another API provider), never `claude-code` (OP1-DECIDED) — so every `folio_api` call routes through `executeTool` and the ceiling actually constrains it.

---

## Threat model

> Phase 3 of the operator-agent build: a general API primitive (`folio_api`/`folio_api_get`) that reaches any token-scoped route, plus agent memory as hidden documents, plus a seeded operator agent. Written 2026-06-01. EXTENDS Phase-1 (D1–D10) + Phase-2 (P2-1…P2-8). New attacks/mitigations numbered **P3-1 … P3-N**. The general primitive is the highest-leverage attack surface in the whole operator build (one tool reaches everything), so this is the convergence target for `/code-review`.

### What we're defending

1. **The delegate ceiling** — `effective = agent ∩ caller`, fail-closed. `folio_api` must NOT become a hole that escapes it. The ephemeral token it mints MUST carry `ctx.token.scopes` (already narrowed) and nothing more.
2. **BYOK keys** — the agent must NEVER read an AI key back through `folio_api_get GET …/ai-keys` (the GET path is bearer-OK + redacts inline today; the general primitive must inherit that redaction, not bypass it).
3. **The tenant boundary** — `folio_api` must not reach a workspace/project the caller can't. The ephemeral token is workspace-pinned + project-allow-listed exactly like the run's token.
4. **The ephemeral token's lifetime** — a minted token that outlives the call, or leaks into a log/response, is a standing credential. It must be revoked unconditionally and never serialized.
5. **The integrity of "hidden" memory documents** — the `folio_system` flag must actually exclude them from the wiki overview (no accidental exposure of the workspace profile / log to every member's UI) while keeping them under the same tenant guard.
6. **The audit trail** — every `folio_api` mutation must emit an event (it does, because it goes through the real route, which emits).

### Who we're defending against

1. **A prompt-injected operator agent** (IN scope) — steered by malicious document/comment content into an escalating `folio_api` call. Mitigated by: the ceiling (can't exceed caller), high-risk refuse-with-plan, the "treat untrusted context as data" fence (already in the runner).
2. **A workspace member using the operator** (IN scope) — gets a member-tier ceiling; `folio_api` can't do owner-only things on their behalf (Phase-2 P2-1 + Phase-1 ceiling).
3. **An attacker who reads server logs / run transcripts** (IN scope for the ephemeral token) — the minted plaintext token must never appear in a log, transcript, event payload, or tool result.
4. **A workspace member browsing the wiki** (IN scope for memory hiding) — must not see the operator's memory documents in the normal page list.
5. **Insider with a stolen session** (OUT of scope) — trust root.

### Attacks to defend against

- **P3-1 — `folio_api` escapes the ceiling via a mis-scoped ephemeral token.** If the minted token carried broader scopes than `ctx.token` (e.g. all four scopes regardless of caller), the agent would exceed its delegate authority. (Class: ceiling bypass via token mint.)
- **P3-2 — Ephemeral token leaks.** The plaintext token appears in a log line, the tool's return value, a comment, an event payload, or a run transcript → a standing credential an attacker reuses. (Class: credential exfiltration.)
- **P3-3 — Ephemeral token outlives the call.** A throw mid-call skips revocation → the token stays valid in `api_tokens`. (Class: credential lifetime.)
- **P3-4 — BYOK key read-back via the general GET primitive.** `folio_api_get GET …/ai-keys` returns the encrypted key (or any partial) because the general path doesn't inherit the route's inline redaction. (Class: redaction bypass — but note: since folio_api_get rides the REAL route over HTTP, it inherits the route's redaction automatically; the attack is only live if we shortcut the route. Mitigation is "ride the real route, never shortcut.")
- **P3-5 — SSRF / path escape via the `path` argument.** The agent (or injected content) supplies a `path` like `http://169.254.169.254/...` or `../../` or an absolute URL → `app.request` reaches outside the intended API surface. (Class: SSRF / path traversal via the general primitive.)
- **P3-6 — Method/verb smuggling.** `folio_api_get` (advertised read-only) accepts a non-GET method in its body → a "read" tool performs a write, escaping the auto/plan boundary. (Class: tool-contract bypass.)
- **P3-7 — High-risk write auto-applies.** A bulk/destructive/permissions call runs without the refuse-with-plan gate → unreviewed high-blast mutation. (Class: missing risk gate.)
- **P3-8 — Memory documents exposed in the wiki.** The `folio_system` filter is missing on one of the list paths (server list, web tree, search) → the workspace profile / log leaks to members. (Class: incomplete filter coverage — the redact-at-the-loader lesson, applied to listing.)
- **P3-9 — Memory documents writable by any agent/member as if normal content** — a non-operator actor edits the workspace profile to plant false "canonical truths" the operator then trusts. (Class: memory poisoning.)
- **P3-10 — Seeded operator agent carries standing authority.** If the seeded agent's token had broad scopes independent of the caller, it would be a privileged bot. (Class: standing-authority violation — the delegate invariant forbids it; the seed must rely on caller delegation, not its own scopes.)

### Mitigations required

- **P3-1 → the ephemeral token mirrors `ctx.token` EXACTLY.** In the `folio_api` handler, mint via `newApiToken()` and insert with `scopes: ctx.token.scopes, agentId: ctx.token.agentId, projectIds: ctx.token.projectIds, workspaceId: ctx.token.workspaceId` — identical to `ccExecute` (runner.ts:887-894). A test asserts a `folio_api` write to a `config:write` route FAILS when `ctx.token.scopes` lacks `config:write` (member-delegated run), and SUCCEEDS for owner-delegated.
- **P3-2 → the plaintext token is used only as the `Authorization` header for the single `app.request` call and never assigned to any returned/logged value.** A grep-checkable invariant: the variable holding the plaintext is local to the handler, passed only into the header, never into `textResult`/`console`/`emitEvent`. A test captures the tool's return value + asserts it does not contain the token substring.
- **P3-3 → revoke in a `finally`.** The mint→request→revoke is wrapped: `try { … app.request … } finally { await db.delete(apiTokens).where(eq(apiTokens.id, ephemeralId)); }`. A test asserts that after a `folio_api` call that THROWS mid-request, the ephemeral token row is gone (count of `api_tokens` with that name prefix is 0).
- **P3-4 → `folio_api_get` rides the real Hono route via `app.request`, never a service shortcut.** Because it hits the real GET handler, it inherits that handler's inline redaction (e.g. `settings.ts` strips `encryptedKey`). A test calls `folio_api_get` against `…/ai-keys` and asserts the response contains NO `encryptedKey`/`encrypted_key` field. (Plus: per the spec's redact-at-the-loader note, grep the GET handlers the operator can reach to confirm none return a secret.)
- **P3-5 → `path` is validated to be a relative API path.** A shared `validateApiPath(path)` (in the folio_api lib) requires: starts with `/api/v1/`, contains no scheme (`://`), no `..` segment, no `@`, no backslash; rejects otherwise with a tool error. `app.request` is called with the validated relative path only. A test feeds `http://169.254.169.254/`, `/api/v1/../../etc`, `//evil.com`, and a valid `/api/v1/w/x/p/y/tables` — first three rejected, last accepted.
- **P3-6 → `folio_api_get` forces method GET.** Its handler hardcodes `method: 'GET'` and its Zod schema does NOT accept a `method` field — only `path` (+ optional query). `folio_api` (write) accepts `method` ∈ `{POST, PATCH, PUT, DELETE}` and REJECTS `GET` (reads must use the read tool). A test asserts `folio_api` with `method: 'GET'` is rejected and `folio_api_get` has no way to express a write.
- **P3-7 → the write tool classifies risk by the coarse resource-type proxy and REFUSES high-risk with a posted plan.** A `classifyRisk(method, path, body)` returns `'low' | 'medium' | 'high'` using the resource-type table (v1 proxy, per spec): high = membership/role routes (none reachable in v1 — deferred), workspace delete, or an explicit bulk flag; medium = config writes (tables/fields/views/statuses/projects) — runs with the dryRun available as undo-preview; low = document writes. For `high`: the handler computes the dryRun (calls the route with `dryRun:true`), posts the would-be plan as a `kind=plan` comment on the run's parent, and returns a tool result that DECLINES to apply ("high-risk action requires approval; proposed plan posted"). It does NOT mutate. A test asserts a high-risk call (simulate via a forced-high path/flag) inserts 0 mutations + posts a plan comment + returns a decline. **Localized-upgrade marker:** a `// TODO(approval-gate): replace refuse with request_approval + running→awaiting_approval` comment sits exactly at the decline, so the later swap is one edit.
- **P3-8 → the `folio_system` filter is applied at the SHARED document-list loader, not per-route.** `listDocuments` (the one query feeding wiki overview + page tree) excludes `frontmatter.folio_system = true` via a `json_extract(frontmatter,'$.folio_system')` predicate by default, with an explicit opt-in (`includeSystem: true`) the agent's own reads pass. A test asserts a seeded memory doc does NOT appear in the default `listDocuments(type:'page')` result but DOES appear with `includeSystem:true`. (Coverage check: grep every caller of the page-list path — server route, web tree, search if any — and confirm they go through the filtered loader.)
- **P3-9 → memory documents are written only by the operator's own runs, and the profile write is a normal reviewable document write (the agent PROPOSES, a human can see it).** v1 keeps promotion manual/agent-proposed (spec): the agent edits the profile via a normal `write_document` that emits an event like any other; there is no special privileged write path. The `folio_system` flag does not grant write authority — the tenant guard + ceiling still apply. A test asserts editing a `folio_system` doc still requires `documents:write` (no bypass).
- **P3-10 → the seeded operator agent has NO standing authority; it relies entirely on caller delegation.** The seed creates the agent document (body-as-prompt) with its normal tool whitelist (`folio_api`, `folio_api_get`, the document primitives). Its run-time authority is `agent ∩ caller` (Phase 1). The seed does NOT mint a broad standing token. A test asserts a run of the seeded agent started by a `member` cannot perform a `config:write` action (member ceiling), proving no standing escalation.

### Out of scope (explicit deferrals)

- **The `running → awaiting_approval` PAUSE side + `request_approval` tool** — high-risk is refuse-with-plan in v1; the pause upgrade is a localized later swap (marked with the TODO).
- **The risk SCORER** (objects/reversibility/workspace-wide/permissions scoring) — v1 uses the resource-type proxy; the scorer drops into `classifyRisk` later without re-plumbing.
- **Memory auto-promotion + log decay** — v1 is manual/agent-proposed; the 2-layer split makes these possible later without a rewrite.
- **Users/memberships routes** — not reachable (no routes exist; deferred to their own session). `classifyRisk` reserves `high` for them so the gate is ready when they land.
- **Rate-limiting / HMAC / retry queues on the general path** — lean on existing run guards (token budget, round cap, autonomy gate).
- **Agent→agent chains via folio_api** — `FOLIO_AGENT_CHAINS_ENABLED` stays off; OP1-F8 (re-derive sub-run caller) remains the gate before chains.

### How to use this section

- **Controller pre-flight:** verify each task carries its named P3-mitigation before dispatch.
- **`/code-review high`:** "Verify against the Phase 3 threat model (P3-1…P3-10) AND confirm Phase-1 (D1–D10) + Phase-2 (P2-1…P2-8) are not weakened by the general primitive. Pay special attention to the ephemeral-token lifetime (P3-2/3) and path validation (P3-5)."
- **`/evaluate` retro:** any missing P3-mitigation → plan-correction defect.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/folio-api-tool.ts` | NEW — `validateApiPath`, `classifyRisk`, the ephemeral-token mint/revoke wrapper, the two tool registrations | Create |
| `apps/server/src/lib/agent-tools-registry.ts` | Register `folio_api` + `folio_api_get` (calls into folio-api-tool.ts) | Modify (registration only) |
| `apps/server/src/lib/agent-schema.ts` | `V1_MCP_TOOLS` / tool whitelist must include the two new tools; `CONFIG_WRITE_TOOLS` already has `folio_api` (Phase 2) | Modify |
| `packages/shared/src/index.ts` | `V1_MCP_TOOLS` const (the canonical tool-name list the agent form + Zod consume) | Modify — add `folio_api`, `folio_api_get` |
| `apps/server/src/services/documents.ts` | `listDocuments` gains the `folio_system` exclusion + `includeSystem` opt-in | Modify |
| `apps/server/src/lib/seed-operator.ts` | NEW — seed the operator agent + two memory docs at workspace create | Create |
| `apps/server/src/routes/workspaces.ts` | Call `seedOperator` in the workspace-create tx (alongside `seedBuiltinTriggers`) | Modify (one call) |
| `apps/server/src/db/migrations/00NN_seed_operator_backfill.sql` | Backfill the operator agent + memory docs into EXISTING workspaces | Create + journal entry |
| `docs/skills/folio/SKILL.md` (or the workspace-content location) | The `folio` skill — API manual + recipes | Create |
| Tests per file | TDD | Create |

> **Open ground-truth the implementer MUST resolve in Task 1** (the Explore agent was interrupted before returning these — verify directly): (a) the exact `listDocuments` signature + where the `type='page'` wiki query is built (`services/documents.ts`) + whether `json_extract` is already used there; (b) `seedBuiltinTriggers`/`seedProjectDefaults` signatures + the in-tx `createDocument` service for `type:'agent'`; (c) confirm `app` is importable into `lib/` without a circular import (it's exported at `app.ts:34`; if importing `app` into `lib/folio-api-tool.ts` cycles, lazy-import inside the handler: `const { app } = await import('../app.ts')`).

---

## Task 1: Ground-truth + the folio_api path validator

**Mitigation: P3-5.** Pure, dependency-free path validation — the safest first slice, and it forces the ground-truth reads.

**Files:**
- Create: `apps/server/src/lib/folio-api-tool.ts` (validator only this task)
- Test: `apps/server/src/lib/folio-api-tool.test.ts`

- [ ] **Step 1: Resolve the three ground-truth items** (read, don't code): `listDocuments` signature + wiki query in `services/documents.ts`; the seed helpers in `routes/workspaces.ts`/`routes/projects.ts` + the in-tx agent `createDocument`; confirm `app` import path. Write the findings as a comment block at the top of `folio-api-tool.ts` so later tasks have them.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/server/src/lib/folio-api-tool.test.ts
import { describe, expect, test } from 'bun:test';
import { validateApiPath } from './folio-api-tool.ts';

describe('validateApiPath (P3-5)', () => {
  test('accepts a relative API path', () => {
    expect(validateApiPath('/api/v1/w/acme/p/sales/tables')).toBe('/api/v1/w/acme/p/sales/tables');
  });
  test('rejects absolute URLs / scheme', () => {
    expect(() => validateApiPath('http://169.254.169.254/')).toThrow();
    expect(() => validateApiPath('https://evil.com/api/v1/x')).toThrow();
  });
  test('rejects protocol-relative + traversal + injection chars', () => {
    expect(() => validateApiPath('//evil.com')).toThrow();
    expect(() => validateApiPath('/api/v1/../../etc/passwd')).toThrow();
    expect(() => validateApiPath('/api/v1/x@y')).toThrow();
    expect(() => validateApiPath('/api/v1/x\\y')).toThrow();
  });
  test('rejects a path not under /api/v1/', () => {
    expect(() => validateApiPath('/admin/secret')).toThrow();
    expect(() => validateApiPath('relative/no/slash')).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify fail** — `cd apps/server && bun test src/lib/folio-api-tool.test.ts` → FAIL (module/function missing).

- [ ] **Step 4: Implement the validator**

```typescript
// apps/server/src/lib/folio-api-tool.ts
// Ground-truth (resolved Task 1 Step 1):
//   - listDocuments: <signature + file:line>
//   - wiki query: <file:line>; json_extract already used? <yes/no>
//   - seed helpers: <file:line>; in-tx agent createDocument: <file:line>
//   - app import: exported at app.ts:34; <direct | lazy-import to avoid cycle>

/**
 * Validate the `path` arg of folio_api/folio_api_get (mitigation P3-5).
 * Only relative paths under /api/v1/ are allowed; no scheme, no protocol-
 * relative, no traversal, no injection chars. Returns the path unchanged on
 * success; throws on rejection (surfaced to the model as a tool error).
 */
export function validateApiPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('folio_api: path must be a non-empty string');
  }
  if (path.includes('://') || path.startsWith('//')) {
    throw new Error('folio_api: path must be relative (no scheme/host)');
  }
  if (!path.startsWith('/api/v1/')) {
    throw new Error('folio_api: path must start with /api/v1/');
  }
  if (path.includes('..') || path.includes('@') || path.includes('\\')) {
    throw new Error('folio_api: path contains a disallowed sequence');
  }
  return path;
}
```

- [ ] **Step 5: Run to verify pass** — `cd apps/server && bun test src/lib/folio-api-tool.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-op-3: folio_api path validator + ground-truth (P3-5)"
```

---

## Task 2: Risk classifier (coarse resource-type proxy)

**Mitigation: P3-7.** Pure function; the gate decision v1 hardcodes.

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (add `classifyRisk`)
- Test: `apps/server/src/lib/folio-api-tool.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
import { classifyRisk } from './folio-api-tool.ts';

describe('classifyRisk (P3-7, v1 resource-type proxy)', () => {
  test('document writes are low', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/documents', {})).toBe('low');
  });
  test('config writes (tables/fields/views/statuses/projects) are medium', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/tables', {})).toBe('medium');
    expect(classifyRisk('DELETE', '/api/v1/w/a/p/b/views/v1', {})).toBe('medium');
  });
  test('membership/role + workspace delete + explicit bulk are high', () => {
    expect(classifyRisk('DELETE', '/api/v1/w/a', {})).toBe('high'); // workspace delete
    expect(classifyRisk('POST', '/api/v1/w/a/members', {})).toBe('high'); // future
    expect(classifyRisk('PATCH', '/api/v1/w/a/p/b/documents', { bulk: true })).toBe('high');
  });
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement**

```typescript
export type RiskTier = 'low' | 'medium' | 'high';

/**
 * v1 risk proxy by resource type (mitigation P3-7). The real scorer (objects /
 * reversibility / workspace-wide / permissions) drops in here later without
 * re-plumbing — every mutation already routes through dryRun→render→apply.
 */
export function classifyRisk(
  method: string,
  path: string,
  body: Record<string, unknown>,
): RiskTier {
  // High: permission/membership, workspace-level destruction, or explicit bulk.
  if (/\/members?(\/|$)/.test(path)) return 'high';
  if (method === 'DELETE' && /^\/api\/v1\/w\/[^/]+$/.test(path)) return 'high'; // workspace delete
  if (body && body.bulk === true) return 'high';
  // Medium: structure/config writes.
  if (/\/(tables|fields|views|statuses)(\/|$)/.test(path)) return 'medium';
  if (/^\/api\/v1\/w\/[^/]+\/p(\/|$)/.test(path) && method !== 'GET') return 'medium'; // project config
  // Low: document writes + everything else token-scoped.
  return 'low';
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-op-3: classifyRisk v1 resource-type proxy (P3-7)"
```

---

## Task 3: The ephemeral-token in-process dispatch core

**Mitigations: P3-1, P3-2, P3-3, P3-4.** The heart of `folio_api` — mint→request→revoke. Mirror `ccExecute` (runner.ts:881-895).

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (add `dispatchAsCaller`)
- Test: `apps/server/src/lib/folio-api-tool.test.ts` (extend — integration-style, real db + real app)

- [ ] **Step 1: Write the failing test**

```typescript
import { dispatchAsCaller } from './folio-api-tool.ts';
// uses the test harness's seeded db + a ctx.token fixture (grep agent-tools.test.ts)

describe('dispatchAsCaller (P3-1/2/3/4)', () => {
  test('mints a token mirroring ctx.token, calls the route, revokes after (P3-1/3)', async () => {
    const beforeTokens = await countTokens();
    const res = await dispatchAsCaller(callerToken, 'GET', '/api/v1/w/' + ws.slug + '/p/' + proj.slug + '/tables', undefined);
    expect(res.status).toBe(200);
    expect(await countTokens()).toBe(beforeTokens); // revoked
  });

  test('revokes even when the request throws (P3-3)', async () => {
    const beforeTokens = await countTokens();
    await expect(dispatchAsCaller(callerToken, 'GET', '/api/v1/INVALID', undefined)).rejects.toThrow();
    expect(await countTokens()).toBe(beforeTokens);
  });

  test('the return value never contains the plaintext token (P3-2)', async () => {
    const res = await dispatchAsCaller(callerToken, 'GET', '/api/v1/w/' + ws.slug + '/p/' + proj.slug + '/tables', undefined);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toMatch(/folio_[A-Za-z0-9]{20,}/); // token format from newApiToken
  });
});
```

> `countTokens()` = row count of `api_tokens`. `callerToken` = a seeded `ApiToken` fixture with `config:write` scopes (grep `agent-tools.test.ts` for the fixture shape). Confirm `newApiToken()`'s plaintext format to write the P3-2 regex.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement the dispatch core**

```typescript
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { apiTokens, type ApiToken } from '../db/schema.ts';
import { newApiToken } from './auth.ts'; // confirm export name/path during Task 1

/**
 * Call a Folio API route IN-PROCESS as the caller delegate (mitigations P3-1/2/3/4).
 *
 * Mints a short-lived bearer token mirroring `caller` EXACTLY (same scopes /
 * agentId / projectIds / workspaceId — the Phase-1-narrowed authority), calls
 * the route over `app.request`, and revokes the token in a finally. The
 * ephemeral plaintext is used ONLY as the Authorization header and never
 * returned or logged. Because it hits the REAL route, it inherits that route's
 * scope guard (requireScope), tenant guard, redaction, and event emission for
 * free — one auth model, two faces.
 */
export async function dispatchAsCaller(
  caller: ApiToken,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const validPath = validateApiPath(path);
  const { token: plaintext, hash } = newApiToken();
  const ephemeralId = nanoid();
  await db.insert(apiTokens).values({
    id: ephemeralId,
    workspaceId: caller.workspaceId,
    name: `folio-api:${ephemeralId}`,
    tokenHash: hash,
    scopes: caller.scopes, // P3-1 — mirror, never widen
    agentId: caller.agentId,
    projectIds: caller.projectIds,
    createdBy: caller.createdBy,
  });
  try {
    // Lazy import if a static import of `app` cycles (resolved Task 1).
    const { app } = await import('../app.ts');
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${plaintext}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return await app.request(validPath, init);
  } finally {
    await db.delete(apiTokens).where(eq(apiTokens.id, ephemeralId)); // P3-3
  }
}
```

> P3-2 is satisfied structurally: `plaintext` is local, used only in the header. The handlers (Task 4/5) return the route's JSON body, never the Response object's request — assert in the test.

- [ ] **Step 4: Run to verify pass** — PASS (3).

- [ ] **Step 5: tsc + commit**

```bash
cd apps/server && bun x tsc --noEmit
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-op-3: ephemeral-token in-process dispatch core (P3-1/2/3/4)"
```

---

## Task 4: Register `folio_api_get` (reads, ungated)

**Mitigations: P3-4, P3-6.**

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (registration) + `apps/server/src/lib/agent-tools-registry.ts` (import/call the registration) + `packages/shared/src/index.ts` (`V1_MCP_TOOLS`) + `apps/server/src/lib/agent-schema.ts` (READ_TOOLS includes `folio_api_get`)
- Test: extend `folio-api-tool.test.ts`

- [ ] **Step 1: Write the failing test** — register the real tools (the registration runs at import), then call through `executeTool`:

```typescript
test('folio_api_get reads a route, GET-forced, no method field (P3-6)', async () => {
  const out = await executeTool(callerToken, 'agent:op', 'folio_api_get',
    { path: `/api/v1/w/${ws.slug}/p/${proj.slug}/tables` }, undefined,
    { callerScopes: callerToken.scopes });
  // returns parsed body of the GET
  expect(Array.isArray(out?.data ?? out)).toBe(true);
});

test('folio_api_get against ai-keys returns NO encrypted key (P3-4)', async () => {
  // seed an ai-key first via the settings route/service
  const out = await executeTool(callerToken, 'agent:op', 'folio_api_get',
    { path: `/api/v1/w/${ws.slug}/settings/${ws.id}/ai-keys` }, undefined,
    { callerScopes: callerToken.scopes });
  expect(JSON.stringify(out)).not.toMatch(/encrypted_?[Kk]ey/);
});
```

- [ ] **Step 2: Run to verify fail** — FAIL (tool not registered).

- [ ] **Step 3: Implement the registration** (in `folio-api-tool.ts`, exported `registerFolioApiTools()` called from the registry's `registerRealTools()`):

```typescript
import { z } from 'zod';
import { registerTool, type ToolContext } from './agent-tools.ts';

export function registerFolioApiTools(): void {
  registerTool({
    name: 'folio_api_get',
    description:
      'Read any Folio resource by GET. path is a relative /api/v1/... path. Read-only — use folio_api for writes.',
    requiredScope: 'documents:read',
    schema: z.object({ path: z.string() }).strict(), // P3-6: no method field
    handler: async (args: { path: string }, ctx: ToolContext) => {
      const res = await dispatchAsCaller(ctx.token, 'GET', args.path, undefined); // P3-6: GET forced
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    },
  });
  // folio_api (write) registered in Task 5.
}
```

Wire-up: in `agent-tools-registry.ts`, call `registerFolioApiTools()` inside the existing `registerRealTools()`. Add `'folio_api_get'` (and `'folio_api'`) to `V1_MCP_TOOLS` in `packages/shared/src/index.ts`, and add `'folio_api_get'` to `READ_TOOLS` in `agent-schema.ts` (so `toolsToScopes` maps it to `documents:read`). `folio_api` already maps to `config:write` via Phase-2's `CONFIG_WRITE_TOOLS`.

- [ ] **Step 4: Run to verify pass + shared tsc** — `cd apps/server && bun test src/lib/folio-api-tool.test.ts && bun x tsc --noEmit && cd ../../packages/shared && bun x tsc --noEmit` → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/agent-schema.ts packages/shared/src/index.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-op-3: register folio_api_get (reads, GET-forced) (P3-4/6)"
```

---

## Task 5: Register `folio_api` (writes, gated with refuse-with-plan)

**Mitigations: P3-6, P3-7.**

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (the write registration)
- Test: extend `folio-api-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
test('folio_api rejects method GET (P3-6)', async () => {
  await expect(executeTool(callerToken, 'agent:op', 'folio_api',
    { method: 'GET', path: `/api/v1/w/${ws.slug}/p/${proj.slug}/tables`, body: {} }, undefined,
    { callerScopes: callerToken.scopes })).rejects.toThrow();
});

test('folio_api low/medium write executes (medium = config) (P3-7)', async () => {
  const out = await executeTool(callerToken, 'agent:op', 'folio_api',
    { method: 'POST', path: `/api/v1/w/${ws.slug}/p/${proj.slug}/tables`, body: { name: 'Sprints' } },
    undefined, { callerScopes: callerToken.scopes });
  expect(out.status).toBe(201);
});

test('folio_api high-risk REFUSES with a posted plan, does not mutate (P3-7)', async () => {
  const before = await countWorkspaces();
  const out = await executeTool(callerToken, 'agent:op', 'folio_api',
    { method: 'DELETE', path: `/api/v1/w/${ws.slug}`, body: {} }, undefined,
    { callerScopes: callerToken.scopes });
  expect(out.refused).toBe(true);
  expect(out.plan).toBeDefined(); // the dryRun diff
  expect(await countWorkspaces()).toBe(before); // no mutation
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement the write tool**

```typescript
  registerTool({
    name: 'folio_api',
    description:
      'Write a Folio resource. method ∈ POST|PATCH|PUT|DELETE; path is a relative /api/v1/... path. ' +
      'High-risk actions are NOT applied automatically — the proposed plan is returned for approval. ' +
      'Use folio_api_get for reads.',
    requiredScope: 'config:write',
    schema: z
      .object({
        method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']), // P3-6: no GET
        path: z.string(),
        body: z.record(z.unknown()).optional(),
      })
      .strict(),
    handler: async (
      args: { method: string; path: string; body?: Record<string, unknown> },
      ctx: ToolContext,
    ) => {
      const body = args.body ?? {};
      const tier = classifyRisk(args.method, args.path, body);
      if (tier === 'high') {
        // Compute the dryRun plan and REFUSE to apply (mitigation P3-7).
        // TODO(approval-gate): replace refuse with request_approval +
        // running→awaiting_approval once the PAUSE side lands (localized swap).
        const dry = await dispatchAsCaller(ctx.token, args.method, args.path, { ...body, dryRun: true });
        const plan = await dry.json().catch(() => null);
        return {
          refused: true,
          reason: 'high-risk action requires human approval',
          plan, // the dryRun diff — surfaced to the human, not applied
        };
      }
      const res = await dispatchAsCaller(ctx.token, args.method, args.path, body);
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    },
  });
```

> The high-risk branch returns the plan in the tool result; the runner surfaces it. (Posting it as a `kind=plan` comment on the run parent — the spec's preferred rendering — can be a thin follow-up; the structured `plan` return is the load-bearing part and is what the test asserts. If the comment-post is wanted in v1, call the comments route via `dispatchAsCaller` here; keep it OUT if it complicates the refuse path — note the choice in a comment.)

- [ ] **Step 4: Run to verify pass + tsc** — PASS (3) + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-op-3: register folio_api (writes, gated, refuse-with-plan) (P3-6/7)"
```

---

## Task 6: Hide `folio_system` documents from the wiki overview

**Mitigations: P3-8, P3-9.**

**Files:**
- Modify: `apps/server/src/services/documents.ts` (`listDocuments`)
- Test: `apps/server/src/services/documents.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — seed a `page` doc with `frontmatter.folio_system = true`; assert default `listDocuments` excludes it, `includeSystem:true` includes it.

```typescript
test('listDocuments excludes folio_system docs by default (P3-8)', async () => {
  // seed two pages: one normal, one folio_system
  const def = await listDocuments({ /* ...existing args... */, type: 'page' });
  expect(def.find((d) => d.frontmatter?.folio_system)).toBeUndefined();
  const all = await listDocuments({ /* ...same... */, type: 'page', includeSystem: true });
  expect(all.find((d) => d.frontmatter?.folio_system)).toBeDefined();
});

test('editing a folio_system doc still requires documents:write (P3-9)', async () => {
  // a read-only token PATCHing the memory doc is rejected — flag grants no write bypass
  // (route-level test; assert 403 with documents:read-only token)
});
```

- [ ] **Step 2: Run to verify fail** — FAIL (no filter, `includeSystem` not a param).

- [ ] **Step 3: Implement** — in `listDocuments`, add an optional `includeSystem?: boolean` (default false) to the args; when false, add a SQLite predicate excluding rows where `json_extract(frontmatter, '$.folio_system')` is truthy. Match the existing `json_extract` style in the file (ground-truthed in Task 1). The agent's own memory reads pass `includeSystem: true`.

> Coverage (P3-8): grep every caller of the wiki/page list to confirm they all flow through `listDocuments` (the shared loader), not a parallel query. If the web tree or a search path queries documents directly, route it through the loader or apply the same predicate — note each call site checked.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/documents.ts apps/server/src/services/documents.test.ts
git commit -m "phase-op-3: hide folio_system docs from wiki overview (P3-8/9)"
```

---

## Task 7: Seed the operator agent + two memory docs

**Mitigations: P3-10.**

**Files:**
- Create: `apps/server/src/lib/seed-operator.ts`
- Modify: `apps/server/src/routes/workspaces.ts` (call `seedOperator` in the create tx)
- Test: `apps/server/src/lib/seed-operator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test('seedOperator creates the operator agent + two memory docs (P3-10)', async () => {
  await txWithEvents(db, async (tx) => { await seedOperator(tx, ws.id, ownerUserId); });
  const agent = await db.query.documents.findFirst({ where: /* type='agent', slug='__folio_operator' */ });
  expect(agent).toBeDefined();
  expect(agent.frontmatter.provider).not.toBe('claude-code'); // OP1-DECIDED: API provider only
  const log = await db.query.documents.findFirst({ where: /* slug='__folio_memory_log' */ });
  const profile = await db.query.documents.findFirst({ where: /* slug='__folio_workspace_profile' */ });
  expect(log.frontmatter.folio_system).toBe(true);
  expect(profile.frontmatter.folio_system).toBe(true);
});

test('a member-started run of the operator cannot do config:write (no standing authority) (P3-10)', async () => {
  // integration: start a run with a member caller; assert a folio_api config write is denied by the ceiling
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement `seedOperator`** — mirror `seedBuiltinTriggers` (ground-truthed Task 1). Create:
  - an `agent` document, slug `__folio_operator`, body-as-prompt pointing at the `folio` skill + memory docs, frontmatter: `provider: 'anthropic'` (API provider — P3-10/OP1-DECIDED), `tools: ['folio_api','folio_api_get','create_document','update_document','get_document','list_documents','run_view', …]`, `projects: ['*']`. **No standing token minted** — authority is `agent ∩ caller` at run time.
  - a `page` doc slug `__folio_memory_log`, `frontmatter.folio_system: true`, seed body a short "## Working log" stub.
  - a `page` doc slug `__folio_workspace_profile`, `frontmatter.folio_system: true`, seed body a "## Workspace profile" stub with the curated-truths headers (naming conventions, field definitions, team, workflow).

  Call `seedOperator(tx, ws.id, user.id)` in the workspace-create tx in `workspaces.ts` right after `seedBuiltinTriggers(tx, id, user.id)`.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean. Run the workspace-create route test to confirm a freshly created workspace now contains the three docs.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/seed-operator.ts apps/server/src/routes/workspaces.ts apps/server/src/lib/seed-operator.test.ts
git commit -m "phase-op-3: seed operator agent + 2-layer memory docs (P3-10)"
```

---

## Task 8: Backfill migration for existing workspaces

**Mitigation: P3-10 (parity for existing instances).**

**Files:**
- Create: `apps/server/src/db/migrations/00NN_seed_operator_backfill.sql` (next free index — check `meta/_journal.json`)
- Modify: `apps/server/src/db/migrations/meta/_journal.json` (MANDATORY — silent-skip footgun, `feedback_drizzle-migration-journal`)
- Test: `apps/server/src/db/migrations/*backfill*.test.ts` or a migration test

- [ ] **Step 1: Write the failing test** — seed a workspace row WITHOUT the operator (pre-migration state), run the migration, assert the three docs now exist for it.

> Per `feedback_drizzle-migrate-is-idempotent`: the migrator runs once; to test the UPDATE against pre-seeded rows, run the migrator, then `sqlite.exec(readFileSync(<this migration>))` against a workspace seeded without the operator.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Write the migration** — for every existing workspace lacking a `__folio_operator` agent, INSERT the agent + two memory docs (same shape as `seedOperator`, fail-closed: skip workspaces that already have them via `WHERE NOT EXISTS`). Add the `_journal.json` entry. Because document IDs are nanoid (not generatable in pure SQL deterministically), prefer a data-migration approach consistent with how this repo does seed-backfills — if prior backfills (e.g. migration `0020`) used a TS-driven approach, follow that; otherwise generate ids inline. Ground-truth migration `0020` (the Phase-1 backfill) for the established pattern.

- [ ] **Step 4: Run to verify pass** — `cd apps/server && bun test <migration test>` → PASS. Run the migration-journal pre-commit check.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrations/
git commit -m "phase-op-3: backfill operator agent + memory into existing workspaces (P3-10)"
```

---

## Task 9: The `folio` skill (content)

**Files:**
- Create: the `folio` skill markdown at the workspace-content location (ground-truth where skills-as-workspace-content live — likely a seeded `page` or a skill doc; if the convention isn't established yet, seed it as a `folio_system` page `__folio_skill` referenced by the operator's body-as-prompt).
- Test: none (content). A smoke check: the operator's body-as-prompt references the skill doc's slug.

- [ ] **Step 1: Write the skill content** — sections: (1) the resource→route→scope table (copy from the Phase-2 route inventory: tables/fields/views/statuses/projects/documents + their verbs, scope `config:write` or `documents:*`, dryRun support); (2) schema conventions (frontmatter-is-the-schema, snake_case keys, slug immutability, work_item-vs-page split); (3) worked recipes: "set up a project" (POST project → POST tables → POST fields → POST statuses → POST views), "author a view + filter", and the memory protocol (read both memory docs at start, weight profile as truth, propose profile edits as normal writes); (4) the risk-gate protocol (low auto / medium auto-with-dryRun-undo / high refuse-with-plan); (5) the governing principle verbatim ("the API is the source of truth; this skill documents it").

- [ ] **Step 2: Wire** — the seeded operator's body-as-prompt (Task 7) points at this skill doc + the two memory docs by slug.

- [ ] **Step 3: Commit**

```bash
git add <skill path> apps/server/src/lib/seed-operator.ts
git commit -m "phase-op-3: folio skill — the API manual (workspace content)"
```

---

## Task 10: DECISIONS.md + integration gate

**Files:**
- Modify: `memory/DECISIONS.md` (record the primitive-widening)
- Verification only otherwise.

- [ ] **Step 1: Record the decision** — append to `memory/DECISIONS.md`: "Operator agent widens `folio-tools-as-primitives` from documents-only to the whole token-scoped REST surface via `folio_api`/`folio_api_get`. The API is the source of truth; the `folio` skill documents it. Authority is `agent ∩ caller` (Phase 1). High-risk = refuse-with-plan until the approval-gate PAUSE side lands."

- [ ] **Step 2: Full suites** — `cd apps/server && bun test` (0 fail), `cd packages/shared && bun test` (0 fail), `cd apps/web && npx vitest run` (web likely unaffected — confirm). tsc per app.

- [ ] **Step 3: Migration journal check** — confirm Task 8's `.sql` is in `_journal.json`.

- [ ] **Step 4: `/integration`** then announce `/code-review high` over the branch diff with this threat model as input, then `/shakeout` (real API key end-to-end: start an operator run, have it set up a project via `folio_api`, confirm the dryRun + refuse-with-plan paths), then merge.

- [ ] **Step 5: Commit**

```bash
git add memory/DECISIONS.md
git commit -m "phase-op-3: record folio_api primitive-widening in DECISIONS"
```

---

## Self-Review (run before dispatch)

**Spec coverage:** `folio_api`/`folio_api_get` (Tasks 3-5), the `folio` skill (Task 9), 2-layer memory as hidden docs (Tasks 6-7), seeded agent (Tasks 7-8), the risk gate (Task 2 + 5), the delegate ceiling inherited (Tasks 3-5). The approval-gate PAUSE side is explicitly deferred (refuse-with-plan, Task 5 TODO). ✅

**Placeholder scan:** Test bodies reference `/* ...existing args... */` for `listDocuments` and the fixture shapes — these are deliberate "ground-truth in Task 1" pointers, not TBDs; Task 1 Step 1 resolves them and writes them into the file header. The migration (Task 8) defers the id-generation mechanism to "follow migration 0020's pattern" — a real, named precedent, not a placeholder.

**Type consistency:** `dispatchAsCaller(caller, method, path, body)`, `validateApiPath(path)`, `classifyRisk(method, path, body)`, `RiskTier` used identically across tasks. Tool names `folio_api`/`folio_api_get` consistent in registry, `V1_MCP_TOOLS`, `agent-schema.ts`, seed, and skill. ✅

**Biggest risk flagged:** the ephemeral-token dispatch (Task 3) is the load-bearing security mechanism — P3-1/2/3 must be verified hardest at `/code-review` (mirror-exact scopes, finally-revoke, no plaintext leak). It reuses the proven `ccExecute` pattern, which de-risks it.

---

## Execution Handoff

Plan complete. **Phase 2 must merge first.** Recommended: **subagent-driven** per task with two-stage review; controller verifies the named P3-mitigation per task. After Task 10: `/code-review high` (threat model as input), `/integration`, `/shakeout` with a real API key (drive an actual "set up a project for me" run), merge.
