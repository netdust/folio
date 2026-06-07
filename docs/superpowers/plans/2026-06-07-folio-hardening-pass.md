# Folio Hardening Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Folio secure + honest + board-usable before Track A — add token expiry, make the 3 AI slash commands real, remove dead code / stale comments, and make views (board create / persist / reorder) actually work.

**Architecture:** Four independently-shippable review clusters off a fresh branch from `main`. Token expiry enforces at the single `attachToken` convergence point (invariant 1). The AI endpoint is a session-auth, one-shot, read-only completion — deliberately NOT an agent tool (it does not go through `executeTool`). View persistence converges board group/sort + drag-reorder onto one "persist to active view" rule.

**Tech Stack:** Bun, Hono, Drizzle/SQLite, React + TanStack Router, Vitest (web) / `bun test` (server), Zod.

**Spec:** `docs/superpowers/specs/2026-06-07-folio-hardening-pass-design.md`. Read it first — this plan implements it.

**Branch:** `spec/hardening-pass` off `main` (currently `fddd2db`). Create via `using-git-worktrees` at execution time.

---

## Threat model

> For the token-expiry + AI-slash-command surfaces of this hardening pass, written 2026-06-07 BEFORE task breakdown. The token surface touches auth (invariant 1); the AI endpoint feeds untrusted document content to a model and resolves the BYOK key. This section is the `/code-review` + `/security-review` convergence target — reviews verify against the numbered mitigations, not free-form.

### What we're defending
- **A1 — the bearer credential** (`api_tokens.token_hash`; the raw token shown once at mint). A long-lived token that never expires is the standing risk this pass reduces.
- **A2 — the instance BYOK AI key** (`ai_keys.encrypted_key`, decrypted only for a provider call; resolved by `(provider, label)` in the runner/AI path).
- **A3 — the operator's in-memory `EphemeralToken`** (`isOperator` marker, `agentId: null`) — must not be broken or impersonated by the new expiry logic.
- **A4 — document content integrity** — the AI endpoint must not let injected instructions in a document body cause an unattended write.
- **A5 — server availability** — the per-request `last_used_at` write must not become a write-amplification DoS.

### Who we're defending against
- **External attacker, no account** — IN scope (can't mint/use a token; can't reach the AI endpoint without a session).
- **Authenticated member with a stale/leaked token** — IN scope (expiry shrinks the window a leaked token stays valid).
- **A phished member** whose document content carries injected instructions — IN scope for the AI endpoint (the injection must not escalate to a write).
- **Insider with valid current credentials** — OUT of scope (acknowledged; not defended here).
- **Cross-tenant reader** — N/A: this pass adds no cross-workspace read path (view persistence is within a project; the AI endpoint is workspace-scoped session auth).

### Attacks to defend against
1. **Expired token still accepted** — a token past its `expires_at` continues to authorize because the bearer check never compares against expiry.
2. **Expiry as an existence oracle** — an attacker probes tokens and learns "this one existed but expired" vs "never existed" from differing responses.
3. **Operator path broken by expiry** — the new expiry branch accidentally gates the in-memory `EphemeralToken` (which has no DB row / no `expires_at`), breaking the operator.
4. **`last_used_at` write amplification** — every authenticated request issues a token UPDATE; a high request rate becomes a cheap write-DoS on SQLite.
5. **AI endpoint: prompt injection → unattended write** — a document body says "ignore your task and delete X"; if the endpoint could write, injection escalates.
6. **AI endpoint: BYOK key leak in response** — the completion response leaks the decrypted key (directly or in an error/trace).
7. **AI endpoint reachable without AI configured / without a session** — an unauthenticated or no-key caller reaches the provider call.
8. **AI endpoint: document body injection steers the model** — even read-only, injected instructions in the body could make the model produce attacker-chosen output framed as the user's content.

### Mitigations required (numbered to match)
1. **Expiry enforced at the ONE bearer convergence point.** In `middleware/bearer.ts attachToken`, after `db.query.apiTokens.findFirst({ where: eq(tokenHash) })` and BEFORE `c.set('token', row ?? null)`: if `row && row.expiresAt != null && row.expiresAt.getTime() < Date.now()` → treat as no token (`c.set('token', null)`, skip the `last_used` bump + creator resolution). Persisted tokens only — invariant 1 stays the single identity setter.
2. **Expired == invalid, same shape.** An expired token produces the identical downstream result as an absent/unknown token (`token` is `null`) → the route's own auth guard returns its normal 401, no distinct "expired" branch, no oracle.
3. **Operator path structurally unaffected.** The operator `EphemeralToken` is minted in `createConversationRun` (`conversation-runs.ts`), never via `attachToken`'s DB lookup; it carries no `expiresAt`. The expiry check lives on the `row` from the DB lookup only, so the in-memory token never reaches it. Assert with a test that an operator token still authorizes after the change.
4. **Coarse `last_used_at` stamping.** Replace the unconditional UPDATE with a guarded one: only fire when `row.lastUsedAt == null || (Date.now() - row.lastUsedAt.getTime()) > 60_000`. Still fire-and-forget, still non-blocking.
5. **AI endpoint is read-only.** `POST …/ai/complete` returns `{ text }`; it performs NO document write. The editor applies the result. A test asserts the target document is byte-identical after a call.
6. **Key never serialized.** The endpoint resolves the key only into the provider call; the response is `{ text }` only. Reuse the runner's existing sanitized-error path so provider errors don't leak the key.
7. **Gated: session + `ai_configured`.** The route requires a session user (mounted on the session-auth `v1` group, not a token surface) AND checks `ai_configured` (the same presence check `/me` exposes) → 403/409 if not configured. No agent token reaches it.
8. **Document body fenced as untrusted DATA.** The body is placed in the user turn under the runner's `UNTRUSTED_DATA_DIRECTIVE` fence discipline (reuse the existing label), and the system turn carries only the action instruction — so injected body instructions are framed as data, not commands. Worst case is bad *suggested* text the human reviews before saving (bounded by mitigation 5).

### Out of scope (explicit deferrals)
- **Token rotation handshake / per-session narrowing / revocation-on-use** — the other half of the MCP-credential watch-item (`ARCHITECTURE-INVARIANTS.md` gaps). Deferred per the doc's "not fix-now until MCP broadens." This pass closes only the TTL half.
- **Forcing existing tokens to expire** — existing tokens are grandfathered (`expires_at = null`). A migration that retroactively set an expiry could lock out a live integration; not done.
- **AI endpoint output sanitization / content moderation** — v1 returns raw model text; the human reviews before saving.
- **AI endpoint rate-limiting / cost cap** — not added here (instance is single-team, BYOK; the operator-run cost meter is the existing control). Note as a future watch-item if abuse appears.

### How to use this section
- **Controller pre-flight:** before dispatching the token cluster (#1) and the AI cluster (#3), verify the task code carries mitigations 1–4 (token) and 5–8 (AI).
- **`/code-review` + `/security-review`:** "Verify the diff against the threat model. Check each numbered mitigation (1–8) is in place; report in-place / missing / out-of-scope-per-deferral."
- **`/evaluate`:** list any unimplemented mitigation as a plan-correction defect.

---

## Architecture invariants touched

> Cited against `ARCHITECTURE-INVARIANTS.md` (15 invariants, as of 2026-06-07). Each cluster names the convergence point it routes through so `/shakeout`'s `invariant-auditor` checks "does this path use the convergence point?" mechanically.

- **Invariant 1 (AuthContext / `attachToken`)** — Cluster 1. Token expiry is enforced AT `attachToken` (the one identity setter); no route re-checks expiry itself. A route that compares `expiresAt` on its own would bypass the convergence point — it must rely on `token` being `null` for an expired token.
- **Invariant 5 (`txWithEvents` + label fidelity)** — Cluster 2. The new `project.deleted` emit goes INSIDE the existing `txWithEvents` block in `routes/projects.ts`, with `workspaceId`/`projectId` = the authorized scope (`ws.id`/`p.id`), mirroring `status.deleted`. The AI endpoint (Cluster 3) deliberately emits NO event (read-only, not a mutation) — consistent with invariant 5 (it's not a write).
- **Invariant 15 (FK-actor vs event-actor)** — Cluster 2. `project.deleted`'s event `actor` is the acting user id (`user.id`, a human-initiated route delete) — the FK/event actor are the same human here (no agent path), so `actor: user.id` is correct. The `eventActor` param is now required on delete services.
- **Invariant 10 (entity modeling: data-before-tables)** — Cluster 1. Adding `expires_at` as a COLUMN on `api_tokens` (not frontmatter) is correct: token lifecycle is a relational attribute of the `api_tokens` table, not a `documents` type. Re-confirmed per the invariant's "re-confirm before adding any `*.sql` that adds a column" — this is a token-table attribute, the documents-frontmatter rule does not apply.
- **Invariant 8 (live updates: SSE teaches refetch)** — Cluster 4. Board persistence (4b/4c) writes through the existing `updateView` mutation; the board reads via react-query and invalidate-and-refetch on the SSE signal — it must NOT build board state from event payloads (it isn't one of the two ratified live-tail exceptions).
- **Invariant 2 (`executeTool`) — DELIBERATE NON-USE, documented.** The AI slash-command endpoint (Cluster 3) is session-auth editor-assist, NOT an agent tool. It correctly does NOT route through `executeTool` (that gate is for agent/MCP tool dispatch with scope intersection). This is noted so the invariant-auditor does not flag it as a bypass — there is no agent token, no tool registry entry, no scope to intersect; it's a plain authenticated HTTP read.
- **NEW convergence point (Cluster 4): view-persistence.** 4b (board group/sort) and 4c (drag-reorder board_position) both decide "when does board state persist to its active view." Converge both onto ONE rule/path (a single `persistBoardState`-style decision through `updateView`), and add a short note to `ARCHITECTURE-INVARIANTS.md` naming it, so a future board-state writer routes through it instead of adding a third ad-hoc gate.
- **MCP-credential watch-item (gaps section)** — Cluster 1 amends it: TTL/expiry now CLOSED; rotation-handshake / per-session-narrowing / revocation-on-use remain deferred.

---

## File structure

**Cluster 1 — Token lifecycle**
- Modify: `apps/server/src/db/schema.ts` — add `expiresAt` to `apiTokens`.
- Create: `apps/server/src/db/migrations/0033_api_tokens_expires_at.sql` + journal entry.
- Modify: `apps/server/src/middleware/bearer.ts` — expiry check + coarse `last_used` (mitigations 1–4).
- Modify: `apps/server/src/lib/token-reach.ts` — `mintToken` accepts optional `expiresInDays`.
- Modify: `apps/server/src/routes/tokens.ts` + `apps/server/src/routes/instance-tokens.ts` — accept expiry in create body; surface `expiresAt` + `lastUsedAt` in list responses.
- Modify: `apps/web/src/lib/api/tokens.ts` (+ instance tokens) — types + create payload.
- Modify: the token list + create dialog components (per-ws API tab + instance Settings) — show expiry/last-used, add expiry field, add "Rotate".
- Modify: `ARCHITECTURE-INVARIANTS.md` — amend the MCP-credential watch-item.

**Cluster 2 — Dead-code & honesty**
- Modify: `apps/server/src/routes/projects.ts` — emit `project.deleted`.
- Modify: `packages/shared/src/events.ts` — remove `ai.action` + `skill.trust.changed`; comment the reserved `awaiting_approval`/`rejected`.
- Modify: `apps/server/src/db/schema.ts:480` (events `kind` comment) + `apps/server/src/lib/access.ts:1-34` (stale comment).
- Modify: `apps/web/src/components/comments/comment-row.tsx` — wire Retry to the runner retry path.

**Cluster 3 — AI slash commands**
- Modify: `apps/server/src/routes/ai.ts` — add `POST …/ai/complete`.
- Create (maybe): `apps/server/src/lib/ai-complete.ts` — per-action prompt builder (keep `ai.ts` thin).
- Modify: `apps/web/src/lib/slash-registry.ts` — real handlers for draft/decompose/summarize.
- Modify: web AI client (`apps/web/src/lib/api/ai.ts` or equivalent) — `complete()` call.

**Cluster 4 — Views are real**
- Modify: `apps/web/src/components/views/new-view-sheet.tsx` — capture current type + group-by (4a).
- Modify: `apps/web/src/routes/w.$wslug.tsx` (where `NewViewSheet` is rendered, ~422) — pass active tab + group-by in.
- Modify: `apps/web/src/components/kanban/board-controls.tsx` — persist default-board group/sort (4b).
- Modify: `apps/web/src/components/views/kanban-view.tsx` + `apps/web/src/components/kanban/board-toolbar.tsx` — un-park reorder (4c).
- Modify: `ARCHITECTURE-INVARIANTS.md` — name the view-persistence convergence point.

---

── REVIEW GATE: Cluster 1 (Token lifecycle) — `/integration` + `/code-review` + `/security-review` before Cluster 2 ──

## Cluster 1 — Token lifecycle (expires_at + enforce + coarse last_used)

### Task 1.1: Add `expires_at` column to `api_tokens`

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`apiTokens` table)
- Create: `apps/server/src/db/migrations/0033_api_tokens_expires_at.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json` (add the 0033 entry — drizzle skips unjournaled files)

- [ ] **Step 1: Add the column to the schema.** In `schema.ts`, in `apiTokens`, after `lastUsedAt`:

```ts
    // Optional expiry. null = never expires (existing tokens grandfathered).
    // Enforced at middleware/bearer.ts attachToken (invariant 1).
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
```

- [ ] **Step 2: Hand-author the migration** `0033_api_tokens_expires_at.sql`:

```sql
ALTER TABLE `api_tokens` ADD `expires_at` integer;
```

- [ ] **Step 3: Add the journal entry** to `meta/_journal.json` (idx 33, tag `0033_api_tokens_expires_at`), matching the existing entry shape. (Per `feedback_drizzle-migration-journal` — drizzle's `migrate()` silently skips unjournaled files.)

- [ ] **Step 4: Verify the migration applies.** Run from `apps/server`: `bun run db:migrate` against a scratch DB (or a fresh test DB). Expected: applies cleanly, `api_tokens` now has `expires_at`.

- [ ] **Step 5: Commit.**
```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/0033_api_tokens_expires_at.sql apps/server/src/db/migrations/meta/_journal.json
git commit -m "phase-harden: add api_tokens.expires_at column (migration 0033)"
```

### Task 1.2: Enforce expiry + coarse last_used at the bearer convergence point (Tier A)

**Files:**
- Modify: `apps/server/src/middleware/bearer.ts` (`attachToken`)
- Test: `apps/server/src/middleware/bearer.test.ts` (create if absent) OR `apps/server/src/routes/tokens.test.ts`

- [ ] **Step 1: Write the failing tests** (mitigations 1, 2, 4 + operator-unaffected 3). Drive through the real middleware against a seeded token:

```ts
// RED: an expired token is treated as no token (401-equivalent: token === null downstream)
test('expired token does not authorize', async () => {
  const { raw } = await seedToken(db, { expiresAt: new Date(Date.now() - 1000) });
  const res = await app.request('/api/v1/w/acme/documents', {
    headers: { Authorization: `Bearer ${raw}` },
  });
  expect(res.status).toBe(401); // same as an unknown token
});

test('expired and unknown tokens return the same status (no oracle)', async () => {
  const { raw: expired } = await seedToken(db, { expiresAt: new Date(Date.now() - 1000) });
  const expiredRes = await app.request('/api/v1/w/acme/documents', { headers: { Authorization: `Bearer ${expired}` } });
  const bogusRes = await app.request('/api/v1/w/acme/documents', { headers: { Authorization: `Bearer not-a-real-token` } });
  expect(expiredRes.status).toBe(bogusRes.status);
});

test('a non-expired token (expiresAt in future) authorizes', async () => {
  const { raw } = await seedToken(db, { expiresAt: new Date(Date.now() + 60_000), scopes: ['documents:read'] });
  const res = await app.request('/api/v1/w/acme/documents', { headers: { Authorization: `Bearer ${raw}` } });
  expect(res.status).toBe(200);
});

test('last_used_at is NOT re-written within 60s (coarse stamping)', async () => {
  const { raw, id } = await seedToken(db, { lastUsedAt: new Date(Date.now() - 5_000), scopes: ['documents:read'] });
  const before = (await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, id) }))!.lastUsedAt;
  await app.request('/api/v1/w/acme/documents', { headers: { Authorization: `Bearer ${raw}` } });
  await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget settle
  const after = (await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, id) }))!.lastUsedAt;
  expect(after).toEqual(before); // unchanged — within the 60s window
});
```

- [ ] **Step 2: Run to verify they fail.** `cd apps/server && bun test bearer` → FAIL (expiry not enforced; last_used always written).

- [ ] **Step 3: Implement in `attachToken`.** After the `findFirst` and BEFORE `c.set('token', ...)`:

```ts
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hashToken(raw)),
  });

  // Mitigation 1+2: expired token == no token, same shape as invalid. Persisted
  // tokens only — the operator's in-memory EphemeralToken never reaches here.
  if (row && row.expiresAt != null && row.expiresAt.getTime() < Date.now()) {
    c.set('token', null);
    return next();
  }

  c.set('token', row ?? null);

  if (row) {
    // Mitigation 4: coarse last_used — only stamp if null or >60s stale.
    const stale =
      row.lastUsedAt == null || Date.now() - row.lastUsedAt.getTime() > 60_000;
    if (stale) {
      Promise.resolve(
        db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)),
      ).catch((err: unknown) => {
        console.warn('[bearer] lastUsedAt bump failed:', err instanceof Error ? err.message : err);
      });
    }
    // ... existing creator-resolution block unchanged ...
  }
```

- [ ] **Step 4: Run to verify they pass.** `cd apps/server && bun test bearer` → PASS.

- [ ] **Step 5: Operator-unaffected guard (mitigation 3).** Add/confirm a test that an operator `EphemeralToken` still authorizes (it has no DB row → never hits the expiry branch). If an operator-auth test already exists in `conversation-runs`/`operator` tests, assert it still passes; otherwise add one asserting `isOperator` token → tool authorizes.

- [ ] **Step 6: Full suite + typecheck.** `cd apps/server && bun test` (expect prior count + new), `bun x tsc --noEmit` clean.

- [ ] **Step 7: Commit.**
```bash
git add apps/server/src/middleware/bearer.ts apps/server/src/middleware/bearer.test.ts
git commit -m "phase-harden: enforce token expiry + coarse last_used at attachToken (mitigations 1-4)"
```

### Task 1.3: Mint accepts optional expiry; routes surface it (Tier A for mint logic)

**Files:**
- Modify: `apps/server/src/lib/token-reach.ts` (`mintToken`)
- Modify: `apps/server/src/routes/tokens.ts`, `apps/server/src/routes/instance-tokens.ts`
- Test: `apps/server/src/lib/token-reach.test.ts`, route tests

- [ ] **Step 1: Failing test for mint-with-expiry.**

```ts
test('mintToken stores expiresAt when expiresInDays given', async () => {
  const before = Date.now();
  const minted = await mintToken(db, {
    ceilingRole: 'owner', scopes: ['documents:read'], reach: ws.id,
    name: 't', createdBy: user.id, expiresInDays: 30,
  });
  const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, minted.id) });
  expect(row!.expiresAt).not.toBeNull();
  expect(row!.expiresAt!.getTime()).toBeGreaterThan(before + 29 * 86400_000);
});

test('mintToken with no expiresInDays leaves expiresAt null (forever token)', async () => {
  const minted = await mintToken(db, { ceilingRole: 'owner', scopes: ['documents:read'], reach: ws.id, name: 't', createdBy: user.id });
  const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, minted.id) });
  expect(row!.expiresAt).toBeNull();
});
```

- [ ] **Step 2: Run → FAIL** (`expiresInDays` not a param).

- [ ] **Step 3: Implement.** Add to `mintToken`'s args + insert:

```ts
  args: { ceilingRole: Role; scopes: string[]; reach: string | null; name: string; createdBy: string; expiresInDays?: number },
  // ...
  await db.insert(apiTokens).values({
    id, workspaceId: args.reach, name: args.name, tokenHash: hash, scopes: args.scopes, createdBy: args.createdBy,
    expiresAt: args.expiresInDays != null ? new Date(Date.now() + args.expiresInDays * 86_400_000) : null,
  });
```

- [ ] **Step 4: Wire the routes.** In `tokens.ts` + `instance-tokens.ts` create handlers: add an optional `expires_in_days: z.number().int().positive().max(3650).optional()` to the Zod body, pass through to `mintToken`. Add `expiresAt` + `lastUsedAt` to the list-response serializer (both routes).

- [ ] **Step 5: Run tests → PASS.** Add a route test: create-with-expiry → list shows `expiresAt`.

- [ ] **Step 6: Full suite + tsc.** `cd apps/server && bun test`, `bun x tsc --noEmit`.

- [ ] **Step 7: Commit.**
```bash
git add apps/server/src/lib/token-reach.ts apps/server/src/routes/tokens.ts apps/server/src/routes/instance-tokens.ts apps/server/src/lib/token-reach.test.ts
git commit -m "phase-harden: mintToken expiresInDays + surface expiresAt/lastUsedAt in token routes"
```

### Task 1.4: Web — expiry field, expiry/last-used display, Rotate (Tier B + seam)

**Files:**
- Modify: web token client(s) — `apps/web/src/lib/api/tokens.ts` (+ instance token client)
- Modify: the token list + create dialog components (per-ws API tab; instance Settings tokens section)
- Test: the relevant `*.test.tsx`

- [ ] **Step 1: Client types.** Add `expiresAt: string | null` + `lastUsedAt: string | null` to the token type; add `expires_in_days?: number` to the create payload type.

- [ ] **Step 2: Create dialog.** Add an optional "Expires in (days)" input (blank = never). Pass through on submit.

- [ ] **Step 3: List display.** Show "Expires {date} / Never" and "Last used {relative} / Never" per token row.

- [ ] **Step 4: Rotate.** Add a "Rotate" action: calls revoke(old) then create(new, same scopes/reach/expiry), shows the new secret once (reuse the create-success secret display). No new server endpoint.

- [ ] **Step 5: Test (Tier B + one seam).** A component test that the create dialog sends `expires_in_days`; a seam test that Rotate issues revoke-then-create (mock the two mutations, assert both fire in order). `cd apps/web && npx vitest run` (the web runner — NOT bun test).

- [ ] **Step 6: tsc.** `cd apps/web && bun x tsc --noEmit`.

- [ ] **Step 7: Commit.**
```bash
git add apps/web/src/lib/api apps/web/src/components
git commit -m "phase-harden: token expiry field + expiry/last-used display + Rotate (web)"
```

### Task 1.5: Amend the MCP-credential watch-item (doc, no code)

**Files:** Modify `ARCHITECTURE-INVARIANTS.md` (gaps section, MCP-credential watch-item)

- [ ] **Step 1:** Edit the watch-item to record: TTL/expiry is now CLOSED (`api_tokens.expires_at` enforced at `attachToken`); the remaining deferred lifecycle gaps are rotation-handshake, per-session narrowing, and revocation-on-use.
- [ ] **Step 2:** Run `bun run check:invariants` → 0 errors (the citation must still resolve).
- [ ] **Step 3: Commit (`--no-verify` if the journal heuristic false-positives on a doc-only change — it won't here).**
```bash
git add ARCHITECTURE-INVARIANTS.md
git commit -m "docs(invariants): token TTL closes the TTL half of the MCP-credential watch-item"
```

── REVIEW GATE: Cluster 2 (Dead-code & honesty) — `/integration` + `/code-review` before Cluster 3 ──

## Cluster 2 — Dead-code & honesty

### Task 2.1: Emit `project.deleted` (Tier A — invariant 5 + 15)

**Files:**
- Modify: `apps/server/src/routes/projects.ts` (the `projectItemRoute.delete` handler, ~line 180)
- Test: `apps/server/src/routes/projects.test.ts`

- [ ] **Step 1: Failing test.**

```ts
test('deleting a project emits project.deleted with the right actor + scope', async () => {
  const p = await seedProject(db, ws.id);
  await app.request(`/api/v1/w/acme/p/${p.slug}`, { method: 'DELETE', headers: authAsOwner });
  const ev = await db.query.events.findFirst({
    where: and(eq(events.kind, 'project.deleted'), eq(events.projectId, p.id)),
  });
  expect(ev).toBeTruthy();
  expect(ev!.actor).toBe(owner.id);
  expect(ev!.workspaceId).toBe(ws.id);
});
```

- [ ] **Step 2: Run → FAIL** (no emit today).

- [ ] **Step 3: Implement.** Inside the existing `txWithEvents` block in the delete handler, after `await tx.delete(projects).where(eq(projects.id, p.id));`, add (mirroring `status.deleted` at `statuses.ts:145`):

```ts
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, kind: 'project.deleted', actor: user.id,
      payload: { id: p.id, slug: p.slug },
    });
```
(Confirm `user`, `ws`, `p`, `emitEvent` are in scope in that handler — `user` is the session user; `emitEvent` is imported alongside `txWithEvents`. If `user` isn't already bound, resolve it via the same `getUser(c)` the route uses elsewhere.)

- [ ] **Step 4: Run → PASS.** Confirm the SSE-label fidelity (invariant 5): `projectId` = `p.id` (the authorized scope).

- [ ] **Step 5: Full suite + tsc.** `cd apps/server && bun test projects`, full `bun test`, `bun x tsc --noEmit`.

- [ ] **Step 6: Commit.**
```bash
git add apps/server/src/routes/projects.ts apps/server/src/routes/projects.test.ts
git commit -m "phase-harden: emit project.deleted (close the missing-emit gap; invariant 5/15)"
```

### Task 2.2: Remove dead event kinds; comment reserved ones (Tier A — type-level)

**Files:** Modify `packages/shared/src/events.ts`

- [ ] **Step 1:** Remove `'ai.action'` and `'skill.trust.changed'` from BOTH the `EventKind` union AND `KNOWN_EVENT_KINDS`. (Verified: zero emitters, zero consumers — `ai.action` never emitted; `skill.trust.changed` intentionally dropped in Phase 4 per `skill-trust.ts:38`.)
- [ ] **Step 2:** Add a one-line comment above `agent.run.awaiting_approval` + `agent.run.rejected`: `// reserved for the deferred model-initiated approval gate (not dead — not yet entered in production).`
- [ ] **Step 3: Typecheck proves no consumer breaks.** `cd packages/shared && bun x tsc --noEmit`; `cd apps/server && bun x tsc --noEmit`; `cd apps/web && bun x tsc --noEmit`. Any reference to a removed kind is now a compile error → none expected.
- [ ] **Step 4: Run shared suite.** `cd packages/shared && bun test`.
- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/events.ts
git commit -m "phase-harden: remove dead event kinds (ai.action, skill.trust.changed); mark approval kinds reserved"
```

### Task 2.3: Fix stale comments (no behavior change)

**Files:** Modify `apps/server/src/db/schema.ts:480`, `apps/server/src/lib/access.ts:1-34`

- [ ] **Step 1:** `schema.ts:480` — change the events `kind` comment from `... status.changed, ...` to reference real kinds (e.g. `document.created, document.updated, status.updated, project.deleted, ...`).
- [ ] **Step 2:** `access.ts` header — replace "callers are rewired in later tasks; nothing reads this yet" with the truth: this module IS the who-can-see-what convergence point (invariant 4a), read by `/events` SSE narrowing, the runs list, and the project list (drop-tenancy merged 2026-06-05).
- [ ] **Step 3: tsc clean** (comment-only). `cd apps/server && bun x tsc --noEmit`.
- [ ] **Step 4: Commit.**
```bash
git add apps/server/src/db/schema.ts apps/server/src/lib/access.ts
git commit -m "phase-harden: fix stale comments (status.changed kind, access.ts 'nothing reads this')"
```

### Task 2.4: Wire the comment Retry button (Tier B + seam)

**Files:**
- Modify: `apps/web/src/components/comments/comment-row.tsx` (the disabled Retry, ~309-320)
- Test: `apps/web/src/components/comments/comment-row.test.tsx`

- [ ] **Step 1: Ground-truth the retry path FIRST.** Read how a run is retried today (`apps/web/src/lib/api/runs.ts` / the runs hooks — there is an existing retry/`retryRun` mutation per the server `runs.ts`). Confirm the error-comment carries the run id (or parent) needed to retry. *(If the wiring isn't reachable from the comment row, treat as DONE_WITH_CONCERNS and surface — do not invent an endpoint.)*
- [ ] **Step 2: Failing test.** Retry button is enabled on an error comment and calls the retry mutation with the run id.
- [ ] **Step 3: Implement.** Remove `disabled`; `onClick` calls the existing retry mutation; show pending state; toast on error.
- [ ] **Step 4: Run → PASS.** `cd apps/web && npx vitest run comment-row`.
- [ ] **Step 5: tsc.** `cd apps/web && bun x tsc --noEmit`.
- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/components/comments/comment-row.tsx apps/web/src/components/comments/comment-row.test.tsx
git commit -m "phase-harden: wire comment error Retry to the runner retry path"
```

── REVIEW GATE: Cluster 3 (AI slash commands) — `/integration` + `/code-review` before Cluster 4 ──

## Cluster 3 — AI slash commands (one-shot, read-only)

### Task 3.1: Server — `POST …/ai/complete` endpoint (Tier A — auth + untrusted input)

**Files:**
- Modify: `apps/server/src/routes/ai.ts`
- Create: `apps/server/src/lib/ai-complete.ts` (per-action prompt builder, keeps the route thin)
- Test: `apps/server/src/routes/ai.test.ts`

- [ ] **Step 1: Ground-truth the AI key resolution + provider call FIRST.** Read how the runner resolves the instance key by `(provider, label)` and calls `ai/provider.ts` `stream()`, and how `ai_configured` is computed (the `/me` presence check). Reuse those — do NOT re-implement key resolution. Note the exact function names in the dispatch prompt.

- [ ] **Step 2: Failing tests (mitigations 5,6,7,8).**

```ts
test('ai/complete denies when AI not configured', async () => {
  // no ai_keys seeded
  const res = await app.request('/api/v1/w/acme/ai/complete', {
    method: 'POST', headers: sessionAsMember,
    body: JSON.stringify({ action: 'summarize', document_id: doc.id }),
  });
  expect([403, 409]).toContain(res.status);
});

test('ai/complete returns text and writes NOTHING to the document', async () => {
  await seedAiKey(db, { provider: 'ollama', label: 'default' }); // + stub provider.stream
  const before = (await db.query.documents.findFirst({ where: eq(documents.id, doc.id) }))!;
  const res = await app.request('/api/v1/w/acme/ai/complete', {
    method: 'POST', headers: sessionAsMember,
    body: JSON.stringify({ action: 'summarize', document_id: doc.id }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.text).toBe('string');
  const after = (await db.query.documents.findFirst({ where: eq(documents.id, doc.id) }))!;
  expect(after.body).toBe(before.body); // mitigation 5: read-only
  expect(JSON.stringify(body)).not.toContain('SECRET_KEY_VALUE'); // mitigation 6
});
```

- [ ] **Step 3: Run → FAIL** (no route).

- [ ] **Step 4: Implement `ai-complete.ts`** — `buildPrompt(action, doc, selection?, instruction?)` returns `{ system, userDataFenced }` where the document body is wrapped in the runner's `UNTRUSTED_DATA_DIRECTIVE` fence (mitigation 8), and `system` is the per-action instruction (draft/summarize/decompose).

- [ ] **Step 5: Implement the route** in `ai.ts` (session-auth `v1` group): Zod-validate body; check `ai_configured` else 403; resolve key by `(provider, label)`; call `provider.stream()` and accumulate to full text server-side (one-shot); return `{ text }`. Reuse the sanitized-error path (mitigation 6). NO document write, NO event (invariant 5: not a mutation).

- [ ] **Step 6: Run → PASS.** Full suite + tsc. `cd apps/server && bun test ai`, `bun test`, `bun x tsc --noEmit`.

- [ ] **Step 7: Commit.**
```bash
git add apps/server/src/routes/ai.ts apps/server/src/lib/ai-complete.ts apps/server/src/routes/ai.test.ts
git commit -m "phase-harden: POST /ai/complete — one-shot read-only slash-command completions (mitigations 5-8)"
```

### Task 3.2: Web — wire `/draft`, `/decompose`, `/summarize` (Tier B + seam)

**Files:**
- Modify: `apps/web/src/lib/slash-registry.ts` (handlers at 46-72)
- Modify/Create: web AI client `complete()` call
- Test: `apps/web/src/lib/slash-registry.test.ts` (or the editor test)

- [ ] **Step 1: Add `complete()` to the web AI client** — POSTs `{ action, document_id, selection?, instruction? }`, returns `{ text }`.
- [ ] **Step 2: Replace the three stub `onSelect` handlers.** Each: show loading, call `complete(action, …)`, insert/replace text in the Milkdown editor on return, toast on error. Keep the `isEnabled: aiConfigured` gate.
- [ ] **Step 3: Seam test.** Selecting `/summarize` calls `complete('summarize', …)` and inserts the returned text (mock the client). One negative: error → toast, editor unchanged.
- [ ] **Step 4: Run → PASS.** `cd apps/web && npx vitest run slash`. tsc clean.
- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/lib/slash-registry.ts apps/web/src/lib/api
git commit -m "phase-harden: wire /draft /decompose /summarize to /ai/complete (real, was Phase-3 stubs)"
```

── REVIEW GATE: Cluster 4 (Views are real) — `/integration` + `/code-review` before shake-out ──

## Cluster 4 — Views are real (capture + persist + reorder)

### Task 4.1: "New view" captures current type + group-by (4a) (Tier B + seam)

**Files:**
- Modify: `apps/web/src/components/views/new-view-sheet.tsx`
- Modify: `apps/web/src/routes/w.$wslug.tsx` (where `NewViewSheet` is rendered, ~422 — pass the active tab + current group-by)
- Test: `apps/web/src/components/views/new-view-sheet.test.tsx`

- [ ] **Step 1: Ground-truth FIRST.** Confirm `ViewCreate` accepts `type` + `groupBy` (verified: it does, `lib/api/views.ts`). Confirm how the active tab is known at the render site (`activeTab` in `w.$wslug.p.$pslug.tsx` derives from the path; the sheet is rendered in `w.$wslug.tsx` — determine how to pass the current view type + group-by in: via new props).
- [ ] **Step 2: Failing test.** With `viewType='kanban'` + `groupBy='priority'` props, submitting builds a payload with `type:'kanban'` + `groupBy:'priority'` (not the hardcoded `'list'`).
- [ ] **Step 3: Implement.** Add `viewType: 'list'|'kanban'` + `groupBy?: string|null` props; in `buildPayload()` set `type: viewType` and include `groupBy`. Pass them from the render site (derive view type from the active tab; group-by from the board-controls bus / active view).
- [ ] **Step 4: Run → PASS.** `cd apps/web && npx vitest run new-view`. tsc clean.
- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/components/views/new-view-sheet.tsx apps/web/src/routes/w.\$wslug.tsx apps/web/src/components/views/new-view-sheet.test.tsx
git commit -m "phase-harden: New view captures current view type + group-by (4a)"
```

### Task 4.2: Persist default-board group/sort + converge the persist rule (4b) (Tier B + seam)

**Files:**
- Modify: `apps/web/src/components/kanban/board-controls.tsx` (the `isActiveViewUrlPinned` gate ~59)
- Test: `apps/web/src/components/kanban/board-controls.test.tsx`

- [ ] **Step 1: Confirm the decision (from the spec, recommended).** The default/active view IS persistable — the consent gate was for *ad-hoc unpinned* state, but the default view is the user's real working view. Define ONE rule: board group/sort writes to the active view via `updateView` whenever there is a resolved `activeView` (not only when `?view=`-pinned). *(If you'd rather keep the URL-pin gate, that's the alternative — but the spec recommends persisting the default; confirm at execution if uncertain.)*
- [ ] **Step 2: Failing test.** Changing group-by on the default board (no `?view=`) calls `updateView` with the active view id. (Today it only updates the bus.)
- [ ] **Step 3: Implement.** Replace `isActiveViewUrlPinned` gating of the `updateView.mutate` calls with "persist whenever `activeView` exists." Keep the bus update (live UI) as-is. Name the rule in a comment as the view-persistence convergence point.
- [ ] **Step 4: Run → PASS.** `cd apps/web && npx vitest run board-controls`. tsc clean.
- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/components/kanban/board-controls.tsx apps/web/src/components/kanban/board-controls.test.tsx
git commit -m "phase-harden: persist default-board group/sort to the active view (4b; converged persist rule)"
```

### Task 4.3: Un-park manual drag-reorder (4c) (Tier B + seam)

**Files:**
- Modify: `apps/web/src/components/views/kanban-view.tsx` (`reorderEnabled` ~132; the sort fallback ~73)
- Modify: `apps/web/src/components/kanban/board-toolbar.tsx` (the parked "Manual" menu item ~112)
- Test: `apps/web/src/components/views/kanban-view.test.tsx`, `apps/web/src/components/kanban/board-reorder.test.ts`

- [ ] **Step 1: Ground-truth FIRST.** Read the dormant path: `board-drag.ts`/`board-reorder.ts` (the `rankBetween` computation), how `board_position` was written before parking, and that the server PATCH persists `board_position` (verified: `services/documents.ts` persists it + round-trip tested). Confirm cross-column regroup (writes `status`) is independent of within-column reorder (writes `board_position`).
- [ ] **Step 2: Failing test.** With reorder enabled, dropping a card within a column computes a `board_position` via `rankBetween` and calls the document PATCH with it; cross-column drag still writes `status` (unchanged).
- [ ] **Step 3: Implement.** Flip `reorderEnabled` to the live logic (restore `effectiveSort === null` → manual); restore `sort:'board_position'` fallback; re-add the "Manual" menu item in `board-toolbar.tsx`. Define null-position ordering deterministically (null sorts last; first drag assigns a rank). Route the write through the SAME persist path as 4b where applicable (one rule).
- [ ] **Step 4: Run → PASS.** `cd apps/web && npx vitest run kanban-view board-reorder`. tsc clean.
- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/components/views/kanban-view.tsx apps/web/src/components/kanban/board-toolbar.tsx apps/web/src/components/views
git commit -m "phase-harden: un-park manual drag-reorder; persist board_position via rankBetween (4c)"
```

### Task 4.4: Name the view-persistence convergence point (doc)

**Files:** Modify `ARCHITECTURE-INVARIANTS.md`

- [ ] **Step 1:** Add a short invariant (or a Deliberate-exception-style note) naming the one place board state (group/sort + board_position) persists to its view — the converged 4b/4c rule — so a future board-state writer routes through it.
- [ ] **Step 2:** `bun run check:invariants` → 0 errors.
- [ ] **Step 3: Commit.**
```bash
git add ARCHITECTURE-INVARIANTS.md
git commit -m "docs(invariants): name the view-persistence convergence point"
```

---

## Spec close — shake-out & finish

- [ ] **`/integration`** — full server (`cd apps/server && bun test`) + shared + web (`cd apps/web && npx vitest run`) + tsc ×3 clean.
- [ ] **`netdust-core:test-effectiveness`** over the branch diff — walk the seven green-but-blind modes; confirm the token-expiry denial, the AI read-only assertion, and the board-persist seam would each go RED if broken. `covered`/`blind`/`fixed` manifest.
- [ ] **`netdust-core:feature-acceptance`** drives the acceptance flows through the real browser:
  - `/draft` `/summarize` `/decompose` in the editor → real text inserted (Chrome/Playwright against the dev server, with an AI key configured).
  - Create a view from the Board → opens as a kanban board with the chosen grouping (4a).
  - Change board group/sort → reload → it persists (4b).
  - Drag a card within a column → reorder persists across reload (4c).
  - Token expiry → through the un-mocked wire: mint a token expiring in the past (or fast-forward), confirm it 401s.
- [ ] **`netdust-core:shake-out`** / `/shakeout` — re-integration + e2e + reviewer panel (incl. `invariant-auditor`) on the full diff, with the threat model (mitigations 1–8) + the invariants-touched list as the convergence target.
- [ ] **`superpowers:finishing-a-development-branch`** — merge `spec/hardening-pass` → `main`.

**Done bar:** secure (token TTL enforced) + honest (slash commands real, dead code gone, comments true) + board-usable (create / persist / reorder all work). Then → Track A.

---

## Self-review (writing-plans)

- **Spec coverage:** §1 token → Cluster 1 (1.1–1.5); §2 AI → Cluster 3 (3.1–3.2); §3 dead-code → Cluster 2 (2.1–2.4); §4 views → Cluster 4 (4.1–4.4). All spec sections have tasks. ✅
- **Placeholder scan:** no TBD/TODO; the two "ground-truth FIRST" steps (2.4, 3.1, 4.1, 4.3) are explicit verification steps (Step 2.5 discipline), not placeholders — each names what to confirm and the fallback (DONE_WITH_CONCERNS, don't invent).
- **Type consistency:** `expiresAt`/`expires_at` (schema/SQL), `expiresInDays` (mint arg) / `expires_in_days` (route body Zod) — naming is intentional (camelCase TS, snake_case DB/wire) per CLAUDE.md conventions. `ViewCreate.type`/`groupBy` match the verified client type.
- **Review-group sizing (1f):** 4 clusters, each ≤5 tasks; the security-boundary cluster (1) gets `/security-review`; each cluster has a `── REVIEW GATE ──` STOP marker. ✅
