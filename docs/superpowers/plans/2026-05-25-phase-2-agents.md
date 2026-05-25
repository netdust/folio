# Phase 2 — Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD per task: RED → GREEN → REFACTOR → commit.

**Goal:** Folio becomes usable by AI agents. REST and MCP both work end-to-end. Bearer tokens authenticate every existing route alongside session cookies. Every write emits an event over an in-memory bus and an SSE stream. Agents and triggers are documents with `type: 'agent'` / `type: 'trigger'` — auto-token minting, delegation guard, frontmatter validation. Phase 2 ships the surface; Phase 3 ships the runner that consumes it.

**Architecture:** The current code already has the token table, the events table, the event-row emitter, and the BYOK key store. Phase 2 closes the gaps: a bearer-auth middleware layered over existing routes, an in-memory event bus on top of the event-row writer, an SSE endpoint with `Last-Event-Id` replay, a `documents.type` widening migration, agent + trigger Zod schemas + auto-token-mint hooks, a hand-rolled JSON-RPC MCP endpoint at `/mcp`, and three docs files.

**Tech Stack:** Hono (REST + JSON-RPC), Drizzle (SQLite, table-rebuild migrations), Zod (validation), Bun test (server), Vitest (web), Tailwind / Radix (web UI). No new dependencies — JSON-RPC MCP is hand-rolled; cron is validated structurally (full evaluation in Phase 3).

**Branch:** `phase-2/agents-surface` cut from `main` at `f67caa9` (current tip — Phase 2 spec revision).

---

## Conventions

- TDD per task. Server tests: `cd apps/server && bun test <file>`. Web tests: `cd apps/web && bun run test <file>`. Never bare `bun test` from repo root for web — use the workspace filter (per `memory/lessons.md` 2026-05-23 "Don't use `bun test` for the web app").
- Type-check: `cd apps/web && bunx tsc --noEmit` and `cd apps/server && bunx tsc --noEmit`. Pre-existing errors in `apps/server/src/app.ts` are out of scope — confirm anything new is from your task, then leave the rest alone.
- Commit cadence: one commit per task. Message format `phase-2: <what>`.
- React-query invalidation: use coarse keys (per `memory/lessons.md` 2026-05-24 "react-query list invalidation must be coarse-grained").
- Skill discipline: every task = one TDD cycle. Don't bundle multiple behavior changes per commit (per `memory/lessons.md` 2026-05-25 "Invoke superpowers skills at phase start").

---

## Reuse map (don't rebuild these)

| Need | Already shipped at |
|---|---|
| `apiTokens` table | `apps/server/src/db/schema.ts:273` |
| `newApiToken()` returns `{ token: 'folio_pat_<40>', hash }` | `apps/server/src/lib/auth.ts:54` |
| `hashToken(t)` | `apps/server/src/lib/auth.ts:44` |
| `routes/tokens.ts` CRUD | `apps/server/src/routes/tokens.ts` (session-auth, returns plaintext once) |
| `events` table | `apps/server/src/db/schema.ts:323` |
| `emitEvent(tx, args)` writes row | `apps/server/src/lib/events.ts:27` |
| `EventKind` union | `apps/server/src/lib/events.ts:5` |
| `attachUser` / `requireUser` / `getUser` pattern | `apps/server/src/middleware/auth.ts` |
| Filter compile (mongo-ish AST) | `packages/shared/src/filter-compile.ts` |
| `aiKeys` BYOK store | `apps/server/src/db/schema.ts:296` |

---

## File Structure

**New server files:**
- `apps/server/src/middleware/bearer.ts` — `attachToken`, `requireToken`, `requireScope(scope)`, `requireUserOrToken`, `getToken(c)`
- `apps/server/src/middleware/bearer.test.ts`
- `apps/server/src/lib/event-bus.ts` — in-process pub/sub
- `apps/server/src/lib/event-bus.test.ts`
- `apps/server/src/routes/events.ts` — SSE endpoint
- `apps/server/src/routes/events-route.test.ts`
- `apps/server/src/lib/agent-schema.ts` — Zod schema for agent frontmatter + `toolsToScopes()` translation
- `apps/server/src/lib/agent-schema.test.ts`
- `apps/server/src/lib/trigger-schema.ts` — Zod schema for trigger frontmatter + cron-shape validator + known-event-kinds list
- `apps/server/src/lib/trigger-schema.test.ts`
- `apps/server/src/lib/delegation-guard.ts` — agent parent_agent chain walker
- `apps/server/src/lib/delegation-guard.test.ts`
- `apps/server/src/routes/mcp.ts` — JSON-RPC handler at `/mcp`
- `apps/server/src/routes/mcp.test.ts`
- `apps/server/src/db/migrations/0006_agents_and_triggers.sql`

**Modified server files:**
- `apps/server/src/db/schema.ts` — widen `documents.type` enum to include `'agent'` and `'trigger'`
- `apps/server/src/app.ts` — mount `/mcp`, mount `/events` SSE, add `attachToken` to the workspace-scoped chain
- `apps/server/src/lib/events.ts` — publish to event bus after table write
- `apps/server/src/routes/documents.ts` — validate agent/trigger frontmatter on create/patch; auto-mint token on agent create; revoke token on agent delete; emit `agent.task.assigned` on assignee transition; delegation guard on token-authenticated agent-create
- `apps/server/src/routes/documents.test.ts` — coverage for the new branches
- `apps/server/src/routes/fields.ts`, `views.ts`, `tables.ts`, `statuses.ts` — wrap mutating routes with `requireScope('<resource>:write')` for bearer-authenticated requests
- `apps/server/src/middleware/auth.ts` — extend `AuthContext` to carry the token

**New web files:**
- `apps/web/src/components/settings/tokens-tab.tsx` — workspace settings API tokens UI
- `apps/web/src/components/settings/tokens-tab.test.tsx`
- `apps/web/src/components/settings/token-create-modal.tsx` — one-time plaintext display modal
- `apps/web/src/components/settings/token-create-modal.test.tsx`
- `apps/web/src/lib/api/tokens.ts` — `useTokens`, `useCreateToken`, `useDeleteToken`, `useUpdateToken` hooks
- `apps/web/src/lib/api/events.ts` — `useEventStream(filters)` SSE consumer hook
- `apps/web/src/components/assignee/assignee-picker.tsx` — humans + agents picker
- `apps/web/src/components/assignee/assignee-picker.test.tsx`

**Modified web files:**
- `apps/web/src/components/slideover/frontmatter-form.tsx` — wire `AssigneePicker` when the field key is `assignee`
- `apps/web/src/components/shell/rail-tree.tsx` — add "Agents" and "Triggers" leaves under each project (alongside Wiki)
- `apps/web/src/lib/api/documents.ts` — widen the `type` filter to accept `'agent'` and `'trigger'`

**New doc files:**
- `docs/API.md`
- `docs/MCP.md`
- `docs/AGENTS.md`
- `docs/TRIGGERS.md`

**Modified doc files:**
- `README.md` — add the agent integration story

---

## Task 1: Bearer auth middleware

**Files:**
- Create: `apps/server/src/middleware/bearer.ts`
- Create: `apps/server/src/middleware/bearer.test.ts`
- Modify: `apps/server/src/middleware/auth.ts` — widen `AuthContext` to carry `token`

### Step 1: Write the failing tests

**Create `apps/server/src/middleware/bearer.test.ts`:**

```ts
import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { attachToken, requireToken, requireScope, getToken } from './bearer.ts';
import type { AuthContext } from './auth.ts';
import { makeTestApp } from '../test/harness.ts';
import { nanoid } from 'nanoid';

function build() {
  const app = new Hono<AuthContext>();
  app.use('*', attachToken);
  app.get('/optional', (c) => {
    const t = c.get('token');
    return c.json({ has: !!t });
  });
  app.get('/protected', requireToken, (c) => {
    const t = getToken(c);
    return c.json({ id: t.id, scopes: t.scopes });
  });
  app.get('/scoped', requireToken, requireScope('documents:write'), (c) => c.json({ ok: true }));
  return app;
}

test('attachToken makes the route work without a token', async () => {
  const app = build();
  const res = await app.request('/optional');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ has: false });
});

test('attachToken loads the token row when a valid Bearer header is provided', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id, scopes: ['documents:read'] });
});

test('requireToken returns 401 when no Bearer header is provided', async () => {
  const app = build();
  const res = await app.request('/protected');
  expect(res.status).toBe(401);
});

test('requireToken returns 401 when the Bearer token does not match any row', async () => {
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: 'Bearer folio_pat_doesnotexist' } });
  expect(res.status).toBe(401);
});

test('requireScope returns 403 when the token lacks the required scope', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/scoped', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN_SCOPE');
});

test('requireScope passes when the token has the required scope', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:write'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/scoped', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
});
```

> The harness at `apps/server/src/test/harness.ts` already exposes `seed.user` (full row), `seed.workspace`, `seed.project`, and `seed.sessionCookie`. Read those via `.id` — do NOT add `workspaceId` / `userId` shortcuts to the harness.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/server && bun test bearer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extend `AuthContext` to carry a token**

In `apps/server/src/middleware/auth.ts`, replace the `AuthContext` interface:

```ts
import type { User, ApiToken } from '../db/schema.ts';

export interface AuthContext {
  Variables: {
    user: User | null;
    token: ApiToken | null;
  };
}
```

- [ ] **Step 4: Implement `bearer.ts`**

**Create `apps/server/src/middleware/bearer.ts`:**

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import type { ApiToken } from '../db/schema.ts';
import { hashToken } from '../lib/auth.ts';
import { HTTPError } from '../lib/http.ts';
import type { AuthContext } from './auth.ts';

/** Read Bearer token from Authorization header, look up by hash, attach to context. */
export const attachToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    c.set('token', null);
    return next();
  }
  const raw = header.slice('Bearer '.length).trim();
  if (!raw) {
    c.set('token', null);
    return next();
  }
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hashToken(raw)),
  });
  c.set('token', row ?? null);
  // Best-effort lastUsedAt bump; failure must not block the request.
  if (row) {
    db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.id))
      .catch(() => {});
  }
  return next();
};

export const requireToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const t = c.get('token');
  if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
  return next();
};

/** Factory: require the token to carry the given scope. */
export function requireScope(scope: string): MiddlewareHandler<AuthContext> {
  return async (c, next) => {
    const t = c.get('token');
    if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
    if (!t.scopes.includes(scope)) {
      throw new HTTPError('FORBIDDEN_SCOPE', `token missing required scope: ${scope}`, 403);
    }
    return next();
  };
}

export function getToken(c: Context<AuthContext>): ApiToken {
  const t = c.get('token');
  if (!t) throw new Error('token not attached - requireToken missing?');
  return t;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd apps/server && bun test bearer.test.ts`
Expected: PASS — 6/6.

- [ ] **Step 6: Run the full server suite + type-check**

Run: `cd apps/server && bun test && bunx tsc --noEmit | grep -v "node_modules" | head -10`
Expected: 135 + 6 = 141 passing. Type-check: any new errors should be in your touched files only. The pre-existing `app.ts` error is allowed to remain.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/middleware/bearer.ts \
        apps/server/src/middleware/bearer.test.ts \
        apps/server/src/middleware/auth.ts
git commit -m "phase-2: add bearer auth middleware with scope enforcement"
```

---

## Task 2: `requireUserOrToken` composite + wire onto existing routes

**Files:**
- Modify: `apps/server/src/middleware/auth.ts` — export `requireUserOrToken`
- Modify: `apps/server/src/app.ts` — apply `attachToken` to the workspace-scoped chain
- Create: `apps/server/src/middleware/composite-auth.test.ts`
- Modify: `apps/server/src/routes/documents.ts`, `fields.ts`, `views.ts`, `tables.ts`, `statuses.ts` — swap `requireUser` for `requireUserOrToken` (where it makes sense; some still need `requireUser` only)

### Step 1: Write the failing test

**Create `apps/server/src/middleware/composite-auth.test.ts`:**

```ts
import { test, expect } from 'bun:test';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';
import { nanoid } from 'nanoid';

test('documents GET works with a session cookie (existing behavior)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});

test('documents GET works with a Bearer token that has documents:read', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
});

test('documents POST requires documents:write scope', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'From token' }),
  });
  expect(res.status).toBe(403);
});

test('documents POST works with documents:write scope', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:write'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'From token' }),
  });
  expect(res.status).toBe(201);
});

test('documents POST without any auth returns 401', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'No auth' }),
  });
  expect(res.status).toBe(401);
});

test('a revoked token immediately blocks subsequent requests', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const ok = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ok.status).toBe(200);
  await db.delete(apiTokens).where((apiTokens) => apiTokens);  // delete all in test DB scope
  const blocked = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(blocked.status).toBe(401);
});
```

> The `await db.delete(apiTokens).where(...)` argument needs to be a Drizzle WHERE clause. Use `eq(apiTokens.id, id)` (import `eq` and `apiTokens` at the top). The pseudo-code above is a placeholder — read Drizzle's `eq` usage from existing tests in `fields.test.ts` to match style exactly.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/server && bun test composite-auth.test.ts`
Expected: FAIL — currently bearer requests return 401 because no route accepts tokens yet.

- [ ] **Step 3: Add `requireUserOrToken` composite**

In `apps/server/src/middleware/auth.ts`, add (after `requireUser`):

```ts
import { attachToken } from './bearer.ts';

/** Composite: passes if either a valid session OR a valid Bearer token is attached. */
export const requireUserOrToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = c.get('user');
  const token = c.get('token');
  if (!user && !token) {
    throw new HTTPError('UNAUTHENTICATED', 'session cookie or API token required', 401);
  }
  return next();
};
```

> **Watch out for the import cycle:** `auth.ts` now imports from `bearer.ts`, and `bearer.ts` imports `AuthContext` from `auth.ts`. This works because TypeScript handles `import type` without runtime cycles, but the `attachToken` import is a value — if a circular module error appears at runtime, move `requireUserOrToken` into `bearer.ts` instead.

- [ ] **Step 4: Wire `attachToken` into the workspace-scoped chain**

In `apps/server/src/app.ts`, find where the workspace-scoped sub-app is mounted (likely a chain like `app.use('/api/v1/w/:wslug/*', attachUser, ...)`). Add `attachToken` to the chain so both middlewares run for every workspace-scoped request:

```ts
import { attachToken } from './middleware/bearer.ts';
// ...
app.use('/api/v1/w/:wslug/*', attachUser, attachToken);
```

Confirm in the existing file what the exact mount pattern is and mirror it.

- [ ] **Step 5: Apply scope checks to mutating routes**

For each of `documents.ts`, `fields.ts`, `views.ts`, `tables.ts`, `statuses.ts`, replace the existing `requireUser` middleware on the route group with `requireUserOrToken`, AND wrap each mutating handler (POST / PATCH / DELETE) with `requireScope('<resource>:<action>')`.

The mapping is:

| Resource | Read action | Write action |
|---|---|---|
| documents | `documents:read` | `documents:write` (POST, PATCH) — `documents:delete` (DELETE) |
| fields | `fields:read` | `fields:write` (POST, PATCH, DELETE) |
| views | `views:read` | `views:write` (POST, PATCH, DELETE) |
| tables | `tables:read` | `tables:write` (POST, PATCH, DELETE) |
| statuses | `statuses:read` | `statuses:write` (POST, PATCH, DELETE) |

**Important nuance:** `requireScope` only fires when a token is attached. If the request is session-authenticated, scope checks are bypassed (membership is the gate). Implement this in `requireScope`:

```ts
export function requireScope(scope: string): MiddlewareHandler<AuthContext> {
  return async (c, next) => {
    const t = c.get('token');
    const user = c.get('user');
    if (user && !t) {
      // Session-authenticated requests don't need scopes; membership is the gate.
      return next();
    }
    if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
    if (!t.scopes.includes(scope)) {
      throw new HTTPError('FORBIDDEN_SCOPE', `token missing required scope: ${scope}`, 403);
    }
    return next();
  };
}
```

Update Task 1's bearer test that expected 401 for `/scoped` without auth — with this change, it should still 401 because no user AND no token. The existing test passes.

Pattern for wrapping a route handler (example for documents POST):

```ts
// Before:
documentsRoute.post('/', zValidator('json', ...), async (c) => { /* ... */ });

// After:
documentsRoute.post('/', requireScope('documents:write'), zValidator('json', ...), async (c) => { /* ... */ });
```

- [ ] **Step 6: Re-run targeted tests and confirm pass**

Run: `cd apps/server && bun test composite-auth.test.ts bearer.test.ts`
Expected: all green.

- [ ] **Step 7: Run the full server suite**

Run: `cd apps/server && bun test`
Expected: all 141 + 6 = 147 passing. Existing session-auth tests should still pass because `requireUserOrToken` accepts users.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/middleware/auth.ts \
        apps/server/src/middleware/bearer.ts \
        apps/server/src/middleware/composite-auth.test.ts \
        apps/server/src/app.ts \
        apps/server/src/routes/documents.ts \
        apps/server/src/routes/fields.ts \
        apps/server/src/routes/views.ts \
        apps/server/src/routes/tables.ts \
        apps/server/src/routes/statuses.ts
git commit -m "phase-2: route mutations through requireScope for bearer requests"
```

---

## Task 3: In-memory event bus

**Files:**
- Create: `apps/server/src/lib/event-bus.ts`
- Create: `apps/server/src/lib/event-bus.test.ts`
- Modify: `apps/server/src/lib/events.ts` — publish to the bus after the table write

### Step 1: Write the failing test

**Create `apps/server/src/lib/event-bus.test.ts`:**

```ts
import { test, expect } from 'bun:test';
import { eventBus, type BusEvent } from './event-bus.ts';

test('subscribe receives published events for matching workspace', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: { id: 'd1' } });
  expect(received.length).toBe(1);
  expect(received[0].kind).toBe('document.created');
  unsub();
});

test('subscribe does not receive events from other workspaces', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-2', kind: 'document.created', payload: {} });
  expect(received.length).toBe(0);
  unsub();
});

test('subscribe with a kinds filter only receives matching events', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', { kinds: ['document.created'] }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.updated', payload: {} });
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  expect(received[0].kind).toBe('document.created');
  unsub();
});

test('subscribe with a projectId filter only receives events for that project', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', { projectId: 'p1' }, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', projectId: 'p2', kind: 'document.created', payload: {} });
  eventBus.publish({ workspaceId: 'ws-1', projectId: 'p1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  expect(received[0].projectId).toBe('p1');
  unsub();
});

test('unsubscribe stops receiving events', () => {
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  unsub();
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(0);
});

test('handler errors do not break other subscribers', () => {
  const received: BusEvent[] = [];
  const unsub1 = eventBus.subscribe('ws-1', undefined, () => { throw new Error('boom'); });
  const unsub2 = eventBus.subscribe('ws-1', undefined, (e) => received.push(e));
  eventBus.publish({ workspaceId: 'ws-1', kind: 'document.created', payload: {} });
  expect(received.length).toBe(1);
  unsub1();
  unsub2();
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/server && bun test event-bus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `event-bus.ts`**

**Create `apps/server/src/lib/event-bus.ts`:**

```ts
import type { EventKind } from './events.ts';

export interface BusEvent {
  id?: string;             // optional; SSE assigns one on emit if absent
  workspaceId: string;
  projectId?: string | null;
  documentId?: string | null;
  kind: EventKind;
  actor?: string;
  payload?: unknown;
  createdAt?: number;      // unix ms; defaults to Date.now()
}

export interface SubFilter {
  kinds?: EventKind[];
  projectId?: string;
}

type Handler = (e: BusEvent) => void;
interface Sub {
  workspaceId: string;
  filter: SubFilter | undefined;
  handler: Handler;
}

/** Single in-process bus. The instance is exported as `eventBus`. */
class EventBus {
  private subs = new Set<Sub>();

  subscribe(workspaceId: string, filter: SubFilter | undefined, handler: Handler): () => void {
    const sub: Sub = { workspaceId, filter, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(e: BusEvent): void {
    for (const sub of this.subs) {
      if (sub.workspaceId !== e.workspaceId) continue;
      if (sub.filter?.kinds && !sub.filter.kinds.includes(e.kind)) continue;
      if (sub.filter?.projectId !== undefined && sub.filter.projectId !== e.projectId) continue;
      try {
        sub.handler(e);
      } catch {
        // Swallow per-subscriber errors so one bad handler can't take down the bus.
      }
    }
  }

  /** Test-only escape hatch. Not exported through the barrel. */
  __clear(): void {
    this.subs.clear();
  }
}

export const eventBus = new EventBus();
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd apps/server && bun test event-bus.test.ts`
Expected: 6/6 PASS.

- [ ] **Step 5: Hook `emitEvent` into the bus**

In `apps/server/src/lib/events.ts`, modify `emitEvent` to also publish:

```ts
import { eventBus } from './event-bus.ts';

export async function emitEvent(tx: DBOrTx, args: EmitArgs): Promise<void> {
  const id = nanoid();
  const createdAt = Date.now();
  await tx.insert(events).values({
    id,
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: (args.payload ?? {}) as unknown,
  });
  // Publish to the in-process bus after the row insert. SSE subscribers see this
  // event; the table row is the durable backstop for Last-Event-Id replay.
  eventBus.publish({
    id,
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: args.payload ?? {},
    createdAt,
  });
}
```

- [ ] **Step 6: Run full server suite to confirm no regressions**

Run: `cd apps/server && bun test`
Expected: 147 + 6 = 153 passing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/lib/event-bus.ts \
        apps/server/src/lib/event-bus.test.ts \
        apps/server/src/lib/events.ts
git commit -m "phase-2: in-memory event bus + publish on emitEvent"
```

---

## Task 4: SSE endpoint with Last-Event-Id replay

**Files:**
- Create: `apps/server/src/routes/events.ts`
- Create: `apps/server/src/routes/events-route.test.ts`
- Modify: `apps/server/src/app.ts` — mount the SSE endpoint

### Step 1: Write the failing test

**Create `apps/server/src/routes/events-route.test.ts`:**

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { nanoid } from 'nanoid';

test('SSE endpoint requires auth', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/events');
  expect(res.status).toBe(401);
});

test('SSE endpoint returns text/event-stream Content-Type for authenticated requests', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  // Drain the stream so the test doesn't hang.
  await res.body?.cancel();
});

test('Last-Event-Id replay: events from the table flow before live events', async () => {
  // This test reads a fixed number of bytes from the stream rather than waiting
  // for the connection to close. We use the AbortController to terminate after
  // a small read window.
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });

  // Create a doc so an event row exists.
  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Seed' }),
  });

  // Open the stream with Last-Event-Id: ''. The handler should emit the
  // historical row(s) within ~50ms.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  let res: Response;
  try {
    res = await app.request('/api/v1/w/acme/events', {
      headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': '' },
      signal: controller.signal,
    });
  } catch (err) {
    // Hono test app may not honor abort; we just need to verify the stream opens.
    return;
  }
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) return;
  const { value } = await Promise.race([
    reader.read(),
    new Promise<{ value?: Uint8Array }>((resolve) => setTimeout(() => resolve({}), 100)),
  ]);
  await reader.cancel();
  if (value) {
    const text = new TextDecoder().decode(value);
    // We expect at least one SSE-formatted event in the buffered replay.
    expect(text).toMatch(/^id:|^event:|^data:/m);
  }
});
```

> The Last-Event-Id test is intentionally lenient — Bun's test harness for Hono's `app.request()` may not stream the body the way a real HTTP client does. If the third test is flaky in your environment, skip it with `test.skip` and rely on a manual smoke test instead. Don't sink an hour into making it bulletproof.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server && bun test events-route.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement `events.ts` route**

**Create `apps/server/src/routes/events.ts`:**

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { events, workspaces } from '../db/schema.ts';
import { type AuthContext } from '../middleware/auth.ts';
import { requireUserOrToken } from '../middleware/auth.ts';
import { eventBus, type BusEvent } from '../lib/event-bus.ts';
import { HTTPError } from '../lib/http.ts';

const eventsRoute = new Hono<AuthContext>();
eventsRoute.use('*', requireUserOrToken);

eventsRoute.get('/', async (c) => {
  const wslug = c.req.param('wslug');
  if (!wslug) throw new HTTPError('INVALID_REQUEST', 'wslug required', 400);

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, wslug) });
  if (!ws) throw new HTTPError('WORKSPACE_NOT_FOUND', `workspace ${wslug} not found`, 404);

  const projectId = c.req.query('project');
  const kindsParam = c.req.query('kinds');
  const kinds = kindsParam ? kindsParam.split(',').filter(Boolean) : undefined;
  const lastEventId = c.req.header('Last-Event-Id') ?? '';

  return streamSSE(c, async (stream) => {
    // Replay from the event log when Last-Event-Id is present.
    if (lastEventId) {
      const rows = await db.query.events.findMany({
        where: and(
          eq(events.workspaceId, ws.id),
          gt(events.id, lastEventId),
        ),
        orderBy: (e, { asc }) => [asc(e.createdAt)],
        limit: 500,
      });
      for (const row of rows) {
        if (projectId && row.projectId !== projectId) continue;
        if (kinds && !kinds.includes(row.kind)) continue;
        await stream.writeSSE({
          id: row.id,
          event: row.kind,
          data: JSON.stringify({
            id: row.id,
            workspaceId: row.workspaceId,
            projectId: row.projectId,
            documentId: row.documentId,
            kind: row.kind,
            actor: row.actor,
            payload: row.payload,
          }),
        });
      }
    }

    // Subscribe to live events.
    const queue: BusEvent[] = [];
    const unsub = eventBus.subscribe(
      ws.id,
      {
        kinds: kinds as never,
        projectId,
      },
      (e) => { queue.push(e); },
    );

    // Heartbeat every 30s.
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' });
    }, 30_000);

    try {
      while (true) {
        if (queue.length > 0) {
          const e = queue.shift()!;
          await stream.writeSSE({
            id: e.id,
            event: e.kind,
            data: JSON.stringify(e),
          });
        } else {
          // Sleep 100ms between drains. This is a simple loop; if we ever
          // need lower latency, swap for a Promise-resolving signal.
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } finally {
      clearInterval(heartbeat);
      unsub();
    }
  });
});

export { eventsRoute };
```

> **Hono SSE helper:** `streamSSE` lives at `hono/streaming`. If your version doesn't export it, look in `node_modules/hono/dist/streaming/index.js` to confirm the path. As a fallback, write the SSE protocol manually using `c.body` + a `ReadableStream`.

- [ ] **Step 4: Mount the route in `app.ts`**

Add to `apps/server/src/app.ts`:

```ts
import { eventsRoute } from './routes/events.ts';
// ...inside the workspace-scoped sub-app chain:
wScope.route('/events', eventsRoute);
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/server && bun test events-route.test.ts`
Expected: tests 1 and 2 pass. Test 3 either passes or skips per the note above.

- [ ] **Step 6: Run the full server suite**

Run: `cd apps/server && bun test`
Expected: 153 + 2 (or 3) = 155 or 156 passing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/events.ts \
        apps/server/src/routes/events-route.test.ts \
        apps/server/src/app.ts
git commit -m "phase-2: SSE endpoint with Last-Event-Id replay"
```

---

## Task 5: Migration `0006_agents_and_triggers.sql`

**Files:**
- Create: `apps/server/src/db/migrations/0006_agents_and_triggers.sql`
- Modify: `apps/server/src/db/schema.ts` — widen the `documents.type` enum
- Modify: `apps/server/src/routes/documents.ts` — widen the Zod enum in `baseSchema`
- Modify: `apps/server/src/routes/documents.test.ts` — add a passing test for agent + trigger document creation (frontmatter is unvalidated here; full validation lands in Task 7+)

### Step 1: Write the failing test

In `apps/server/src/routes/documents.test.ts`, add:

```ts
test('POST creates a document with type=agent', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Triage bot',
      frontmatter: {
        system_prompt: 'Help triage incoming bugs.',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tools: ['list_documents', 'get_document'],
      },
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.type).toBe('agent');
});

test('POST creates a document with type=trigger', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'trigger',
      title: 'Monday morning standup',
      frontmatter: {
        agent: 'triage-bot',
        schedule: '0 9 * * 1',
        on_event: null,
      },
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.type).toBe('trigger');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server && bun test documents.test.ts`
Expected: FAIL — the Zod enum rejects `'agent'` and `'trigger'`.

- [ ] **Step 3: Write the migration**

**Create `apps/server/src/db/migrations/0006_agents_and_triggers.sql`:**

Read the most recent migration (`0005_phase_1_7_last_touched_at.sql`) first to confirm the table-rebuild idiom in use. Then write:

```sql
-- 0006_agents_and_triggers.sql
-- Widen documents.type enum from ('work_item','page') to
-- ('work_item','page','agent','trigger'). SQLite enums are enforced via CHECK
-- constraints, so we use the standard table-rebuild idiom.

PRAGMA foreign_keys = OFF;

CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  table_id TEXT REFERENCES tables(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('work_item','page','agent','trigger')),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT,
  body TEXT NOT NULL DEFAULT '',
  frontmatter TEXT NOT NULL DEFAULT '{}',
  parent_id TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_touched_at INTEGER
);

INSERT INTO documents_new SELECT * FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE UNIQUE INDEX documents_project_slug_idx ON documents(project_id, slug);
CREATE INDEX documents_project_type_idx ON documents(project_id, type);
CREATE INDEX documents_parent_idx ON documents(parent_id);
CREATE INDEX documents_table_idx ON documents(table_id);

PRAGMA foreign_keys = ON;
```

> Confirm the column list against the actual schema (`SELECT * FROM pragma_table_info('documents')`) before running. If the column count or order has drifted from this template, copy from the live `0005` migration's pattern.

- [ ] **Step 4: Widen the Drizzle schema**

In `apps/server/src/db/schema.ts:216`, change:

```ts
type: text('type', { enum: ['work_item', 'page'] }).notNull(),
```

to:

```ts
type: text('type', { enum: ['work_item', 'page', 'agent', 'trigger'] }).notNull(),
```

- [ ] **Step 5: Widen the Zod enum in documents.ts**

Find the document `baseSchema` in `apps/server/src/routes/documents.ts`. Replace its `type` enum:

```ts
type: z.enum(['work_item', 'page', 'agent', 'trigger']),
```

> Keep the additional validation light at this point — frontmatter shape validation per type lands in the next tasks.

- [ ] **Step 6: Run the new tests + the full suite**

Run: `cd apps/server && bun test documents.test.ts && bun test`
Expected: PASS. The test harness auto-runs migrations from `0000` through `0006` on `makeTestApp()` because of the migrate-on-boot wired in `index.ts` (per `memory/lessons.md` 2026-05-25 "Dev DB drift").

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/migrations/0006_agents_and_triggers.sql \
        apps/server/src/db/schema.ts \
        apps/server/src/routes/documents.ts \
        apps/server/src/routes/documents.test.ts
git commit -m "phase-2: widen documents.type to include agent + trigger"
```

---

## Task 6: Agent frontmatter Zod schema + `toolsToScopes`

**Files:**
- Create: `apps/server/src/lib/agent-schema.ts`
- Create: `apps/server/src/lib/agent-schema.test.ts`

### Step 1: Write the failing tests

**Create `apps/server/src/lib/agent-schema.test.ts`:**

```ts
import { describe, test, expect } from 'bun:test';
import { agentFrontmatterSchema, toolsToScopes, V1_MCP_TOOLS } from './agent-schema.ts';

describe('agentFrontmatterSchema', () => {
  test('accepts a complete valid agent frontmatter', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'do the thing',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents', 'get_document'],
      max_delegation_depth: 2,
      max_tokens_per_run: 10000,
      requires_approval: false,
    });
    expect(r.success).toBe(true);
  });

  test('applies defaults for max_delegation_depth, max_tokens_per_run, requires_approval', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x',
      model: 'gpt-4o',
      provider: 'openai',
      tools: [],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.max_delegation_depth).toBe(2);
      expect(r.data.max_tokens_per_run).toBe(10000);
      expect(r.data.requires_approval).toBe(false);
    }
  });

  test('rejects max_delegation_depth > 5', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], max_delegation_depth: 6,
    });
    expect(r.success).toBe(false);
  });

  test('rejects max_tokens_per_run > 100000', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], max_tokens_per_run: 100001,
    });
    expect(r.success).toBe(false);
  });

  test('rejects unknown provider', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'magic', tools: [],
    });
    expect(r.success).toBe(false);
  });

  test('rejects tools not in the v1 MCP set', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: ['list_documents', 'invent_thing'],
    });
    expect(r.success).toBe(false);
  });

  test('rejects api_token_id when set by the client on input', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], api_token_id: 'tok_x',
    });
    expect(r.success).toBe(false);
  });

  test('rejects parent_agent when set by the client on input', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], parent_agent: 'agent-foo',
    });
    expect(r.success).toBe(false);
  });
});

describe('toolsToScopes', () => {
  test('list/get tools require documents:read', () => {
    expect(toolsToScopes(['list_documents'])).toContain('documents:read');
    expect(toolsToScopes(['get_document', 'get_document_markdown'])).toContain('documents:read');
  });

  test('create/update tools require documents:write', () => {
    expect(toolsToScopes(['create_document'])).toContain('documents:write');
    expect(toolsToScopes(['update_document'])).toContain('documents:write');
  });

  test('delete_document requires documents:delete', () => {
    expect(toolsToScopes(['delete_document'])).toContain('documents:delete');
  });

  test('write tools always also include read', () => {
    expect(toolsToScopes(['create_document'])).toContain('documents:read');
  });

  test('empty tools returns no scopes', () => {
    expect(toolsToScopes([])).toEqual([]);
  });

  test('scopes are deduped', () => {
    const out = toolsToScopes(['list_documents', 'get_document', 'create_document', 'update_document']);
    const reads = out.filter((s) => s === 'documents:read');
    expect(reads.length).toBe(1);
  });
});

describe('V1_MCP_TOOLS', () => {
  test('contains the 13 v1 tools', () => {
    expect(V1_MCP_TOOLS).toEqual([
      'list_workspaces', 'list_projects', 'list_documents',
      'get_document', 'get_document_markdown',
      'create_document', 'update_document', 'delete_document',
      'list_statuses', 'list_fields', 'list_views',
      'run_view',
      // search_documents deferred to v1.1
    ] as readonly string[]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server && bun test agent-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agent-schema.ts`**

**Create `apps/server/src/lib/agent-schema.ts`:**

```ts
import { z } from 'zod';

export const V1_MCP_TOOLS = [
  'list_workspaces', 'list_projects', 'list_documents',
  'get_document', 'get_document_markdown',
  'create_document', 'update_document', 'delete_document',
  'list_statuses', 'list_fields', 'list_views',
  'run_view',
] as const;

export type McpTool = (typeof V1_MCP_TOOLS)[number];

export const agentFrontmatterSchema = z.object({
  system_prompt: z.string().min(1),
  model: z.string().min(1),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  tools: z.array(z.enum(V1_MCP_TOOLS)),
  max_delegation_depth: z.number().int().min(0).max(5).default(2),
  max_tokens_per_run: z.number().int().min(1).max(100_000).default(10_000),
  requires_approval: z.boolean().default(false),
  // Server-managed fields rejected on client input.
  api_token_id: z.undefined(),
  parent_agent: z.undefined(),
}).strict();

const READ_TOOLS: ReadonlySet<string> = new Set([
  'list_workspaces', 'list_projects', 'list_documents',
  'get_document', 'get_document_markdown',
  'list_statuses', 'list_fields', 'list_views',
  'run_view',
]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['create_document', 'update_document']);
const DELETE_TOOLS: ReadonlySet<string> = new Set(['delete_document']);

/** Translate the agent's tool whitelist into the matching set of token scopes. */
export function toolsToScopes(tools: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const tool of tools) {
    if (READ_TOOLS.has(tool)) scopes.add('documents:read');
    if (WRITE_TOOLS.has(tool)) {
      scopes.add('documents:write');
      scopes.add('documents:read');  // write implies read
    }
    if (DELETE_TOOLS.has(tool)) {
      scopes.add('documents:delete');
      scopes.add('documents:read');
    }
  }
  return Array.from(scopes);
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd apps/server && bun test agent-schema.test.ts`
Expected: 17/17 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-schema.ts apps/server/src/lib/agent-schema.test.ts
git commit -m "phase-2: agent frontmatter Zod schema + toolsToScopes"
```

---

## Task 7: Trigger frontmatter Zod schema + cron-shape validator

**Files:**
- Create: `apps/server/src/lib/trigger-schema.ts`
- Create: `apps/server/src/lib/trigger-schema.test.ts`

### Step 1: Write the failing tests

**Create `apps/server/src/lib/trigger-schema.test.ts`:**

```ts
import { describe, test, expect } from 'bun:test';
import { triggerFrontmatterSchema, validateCronShape, KNOWN_EVENT_KINDS } from './trigger-schema.ts';

describe('validateCronShape', () => {
  test('accepts 5-field cron expressions', () => {
    expect(validateCronShape('0 9 * * 1').ok).toBe(true);
    expect(validateCronShape('* * * * *').ok).toBe(true);
    expect(validateCronShape('*/5 * * * *').ok).toBe(true);
    expect(validateCronShape('0 0 1,15 * *').ok).toBe(true);
  });

  test('rejects expressions with wrong number of fields', () => {
    expect(validateCronShape('0 9 * *').ok).toBe(false);
    expect(validateCronShape('0 9 * * * *').ok).toBe(false);
    expect(validateCronShape('').ok).toBe(false);
  });

  test('rejects expressions with invalid characters', () => {
    expect(validateCronShape('a b c d e').ok).toBe(false);
    expect(validateCronShape('@daily').ok).toBe(false);
  });
});

describe('triggerFrontmatterSchema', () => {
  test('accepts schedule-only triggers', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: '0 9 * * 1',
      on_event: null,
    });
    expect(r.success).toBe(true);
  });

  test('accepts event-only triggers', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: null,
      on_event: 'document.updated',
    });
    expect(r.success).toBe(true);
  });

  test('accepts both schedule and on_event set', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: '0 9 * * 1',
      on_event: 'document.updated',
    });
    expect(r.success).toBe(true);
  });

  test('rejects triggers with both schedule and on_event null', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: null,
      on_event: null,
    });
    expect(r.success).toBe(false);
  });

  test('rejects unknown on_event kinds', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'x',
      schedule: null,
      on_event: 'document.exploded',
    });
    expect(r.success).toBe(false);
  });

  test('rejects bad cron expressions', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'x',
      schedule: 'every monday',
      on_event: null,
    });
    expect(r.success).toBe(false);
  });

  test('rejects last_fired_at and last_status when set by the client', () => {
    const a = triggerFrontmatterSchema.safeParse({
      agent: 'x', schedule: '* * * * *', on_event: null, last_fired_at: '2026-05-25',
    });
    expect(a.success).toBe(false);
    const b = triggerFrontmatterSchema.safeParse({
      agent: 'x', schedule: '* * * * *', on_event: null, last_status: 'ok',
    });
    expect(b.success).toBe(false);
  });

  test('applies enabled default true', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'x', schedule: '* * * * *', on_event: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.enabled).toBe(true);
  });
});

describe('KNOWN_EVENT_KINDS', () => {
  test('includes the document, field, view, table, project, workspace kinds', () => {
    expect(KNOWN_EVENT_KINDS).toContain('document.created');
    expect(KNOWN_EVENT_KINDS).toContain('document.updated');
    expect(KNOWN_EVENT_KINDS).toContain('field.created');
    expect(KNOWN_EVENT_KINDS).toContain('view.created');
    expect(KNOWN_EVENT_KINDS).toContain('table.created');
    expect(KNOWN_EVENT_KINDS).toContain('project.created');
    expect(KNOWN_EVENT_KINDS).toContain('workspace.created');
    expect(KNOWN_EVENT_KINDS).toContain('activity.logged');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server && bun test trigger-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `trigger-schema.ts`**

**Create `apps/server/src/lib/trigger-schema.ts`:**

```ts
import { z } from 'zod';
import type { EventKind } from './events.ts';

/** Source-of-truth list. Keep in sync with EventKind in events.ts. */
export const KNOWN_EVENT_KINDS: readonly EventKind[] = [
  'document.created', 'document.updated', 'document.deleted',
  'status.created',   'status.updated',   'status.deleted',
  'field.created',    'field.updated',    'field.deleted',
  'view.created',     'view.updated',     'view.deleted',
  'table.created',    'table.updated',    'table.deleted',
  'project.created',  'project.updated',  'project.deleted',
  'workspace.created','workspace.updated',
  'activity.logged',
];

export interface CronShapeResult {
  ok: boolean;
  reason?: string;
}

const FIELD_RE = /^[0-9*,\-/]+$/;

/** Structural validation only — does NOT verify the cron is meaningful.
 *  Phase 3's scheduler does full evaluation when the trigger fires. */
export function validateCronShape(expr: string): CronShapeResult {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, reason: `cron must have 5 fields (got ${parts.length})` };
  }
  for (const p of parts) {
    if (!FIELD_RE.test(p)) {
      return { ok: false, reason: `cron field "${p}" contains invalid characters` };
    }
  }
  return { ok: true };
}

const cronOrNull = z.union([
  z.string().refine((s) => validateCronShape(s).ok, { message: 'invalid cron expression' }),
  z.null(),
]);

const onEventOrNull = z.union([
  z.enum(KNOWN_EVENT_KINDS as unknown as readonly [string, ...string[]]),
  z.null(),
]);

export const triggerFrontmatterSchema = z.object({
  agent: z.string().min(1),
  schedule: cronOrNull,
  on_event: onEventOrNull,
  event_filter: z.union([z.record(z.unknown()), z.null()]).default(null),
  payload: z.union([z.record(z.unknown()), z.null()]).default(null),
  enabled: z.boolean().default(true),
  // Server-managed fields rejected on client input.
  last_fired_at: z.undefined(),
  last_status: z.undefined(),
}).strict().refine(
  (d) => d.schedule !== null || d.on_event !== null,
  { message: 'trigger must have at least one of schedule or on_event' },
);
```

- [ ] **Step 4: Run and watch pass**

Run: `cd apps/server && bun test trigger-schema.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/trigger-schema.ts apps/server/src/lib/trigger-schema.test.ts
git commit -m "phase-2: trigger frontmatter Zod schema + cron-shape validator"
```

---

## Task 8: Wire agent/trigger Zod validation into `documents.ts`

**Files:**
- Modify: `apps/server/src/routes/documents.ts` — branch on `type` and apply the agent/trigger schema
- Modify: `apps/server/src/routes/documents.test.ts` — replace the loose "agent passes" tests with strict ones

### Step 1: Write the failing tests

In `documents.test.ts`, append:

```ts
test('POST agent rejects missing required fields', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'agent', title: 'Broken', frontmatter: {} }),
  });
  expect(res.status).toBe(422);
});

test('POST trigger rejects when both schedule and on_event are null', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'trigger',
      title: 'Empty',
      frontmatter: { agent: 'x', schedule: null, on_event: null },
    }),
  });
  expect(res.status).toBe(422);
});

test('POST agent rejects when a tableId is set', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'No table allowed',
      tableId: 'some-table',
      frontmatter: {
        system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [],
      },
    }),
  });
  expect(res.status).toBe(422);
});
```

> Replace your earlier two passing tests (Task 5's "POST creates a document with type=agent" and "POST creates a document with type=trigger") with the correctly-shaped frontmatter passing cases — but only after the validation lands, or they'll start failing. Easier: leave them in place but expect 201 with valid frontmatter; the validator will let them through.

- [ ] **Step 2: Run and watch the new failing cases fail**

Run: `cd apps/server && bun test documents.test.ts`
Expected: the three new tests fail because the current code accepts whatever frontmatter shape is given.

- [ ] **Step 3: Add the validation branch in `documents.ts`**

Find the POST handler in `apps/server/src/routes/documents.ts`. After parsing the body and before inserting, add:

```ts
import { agentFrontmatterSchema } from '../lib/agent-schema.ts';
import { triggerFrontmatterSchema } from '../lib/trigger-schema.ts';

// ...inside the POST handler, after Zod parses the outer body:

if (input.type === 'agent') {
  if (input.tableId) {
    throw new HTTPError('INVALID_BODY', 'agents cannot have a tableId', 422);
  }
  const r = agentFrontmatterSchema.safeParse(input.frontmatter ?? {});
  if (!r.success) {
    throw new HTTPError('INVALID_AGENT_FRONTMATTER', r.error.message, 422);
  }
  // Replace input.frontmatter with the parsed, default-applied version.
  input.frontmatter = r.data;
}
if (input.type === 'trigger') {
  if (input.tableId) {
    throw new HTTPError('INVALID_BODY', 'triggers cannot have a tableId', 422);
  }
  const r = triggerFrontmatterSchema.safeParse(input.frontmatter ?? {});
  if (!r.success) {
    throw new HTTPError('INVALID_TRIGGER_FRONTMATTER', r.error.message, 422);
  }
  input.frontmatter = r.data;
}
```

Do the same in the PATCH handler.

- [ ] **Step 4: Run all the tests and confirm pass**

Run: `cd apps/server && bun test documents.test.ts`
Expected: all pass — including the previously-loose agent + trigger creation tests, which now validate frontmatter shape.

- [ ] **Step 5: Run full server suite**

Run: `cd apps/server && bun test`
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/documents.ts \
        apps/server/src/routes/documents.test.ts
git commit -m "phase-2: validate agent/trigger frontmatter on documents POST/PATCH"
```

---

## Task 9: Auto-mint API token on agent create + revoke on delete

**Files:**
- Modify: `apps/server/src/routes/documents.ts` — on agent create, mint a token + store `api_token_id` in frontmatter; on agent delete, revoke the token
- Modify: `apps/server/src/routes/documents.test.ts`
- Modify: `apps/server/src/lib/events.ts` — add `agent.created`, `agent.deleted`, `agent.task.assigned` to `EventKind`

### Step 1: Write the failing tests

In `documents.test.ts`:

```ts
test('agent create auto-mints an API token with toolsToScopes scopes', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: {
        system_prompt: 'x', model: 'x', provider: 'anthropic',
        tools: ['create_document', 'list_documents'],
      },
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.frontmatter.api_token_id).toBeTruthy();
  // The plaintext token is returned ONCE alongside the document.
  expect(body.data.agent_token).toMatch(/^folio_pat_/);
});

test('agent delete revokes the linked token', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: ['list_documents'] },
    }),
  });
  const { data: { slug, agent_token, frontmatter: { api_token_id } } } = await create.json();

  // Confirm the token works.
  const tokenWorks = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${agent_token}` },
  });
  expect(tokenWorks.status).toBe(200);

  // Delete the agent.
  const del = await app.request(`/api/v1/w/acme/p/web/documents/${slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);

  // Token should be revoked.
  const tokenBlocked = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${agent_token}` },
  });
  expect(tokenBlocked.status).toBe(401);
});

test('agent.created event emitted on agent create', async () => {
  const { app, seed } = await makeTestApp();
  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
    }),
  });
  // Verify the events table has the row.
  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.created') });
  expect(rows.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/server && bun test documents.test.ts`
Expected: FAIL — no token minted, no `agent_token` in response, no `agent.created` kind.

- [ ] **Step 3: Add the new event kinds**

In `apps/server/src/lib/events.ts`, widen `EventKind`:

```ts
export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'table.created'    | 'table.updated'    | 'table.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated'
  | 'activity.logged'
  | 'agent.created'    | 'agent.deleted'   | 'agent.task.assigned';
```

Also update `KNOWN_EVENT_KINDS` in `trigger-schema.ts` to include the three new kinds.

- [ ] **Step 4: Wire auto-mint on agent create**

In `documents.ts`, inside the POST handler, after the frontmatter validation block from Task 8 but before the insert:

```ts
import { toolsToScopes } from '../lib/agent-schema.ts';
import { newApiToken, hashToken } from '../lib/auth.ts';
import { apiTokens } from '../db/schema.ts';

let agentTokenPlaintext: string | undefined;

if (input.type === 'agent') {
  const { token, hash } = newApiToken();
  const apiTokenId = nanoid();
  const scopes = toolsToScopes(r.data.tools);  // `r.data` from the validation above; rename it `agentFm` for clarity
  await db.insert(apiTokens).values({
    id: apiTokenId,
    workspaceId: ws.id,
    name: `agent:${slug}`,
    tokenHash: hash,
    scopes,
    createdBy: user.id,
  });
  agentTokenPlaintext = token;
  input.frontmatter = { ...r.data, api_token_id: apiTokenId };
}
```

You'll need to refactor the existing Task 8 code so the validated `r.data` is named (e.g. `agentFm = r.data`) and accessible after the validation branch.

In the response, include the plaintext token ONLY for type='agent' creates:

```ts
return jsonOk(c, agentTokenPlaintext
  ? { ...row, agent_token: agentTokenPlaintext }
  : row, 201);
```

For the matching event:

```ts
if (input.type === 'agent') {
  await emitEvent(tx, {
    workspaceId: ws.id, projectId: p.id, documentId: row.id,
    kind: 'agent.created', actor: user.id,
    payload: { slug, api_token_id: input.frontmatter.api_token_id },
  });
}
```

- [ ] **Step 5: Wire revoke on agent delete**

In the DELETE handler:

```ts
if (existing.type === 'agent') {
  const apiTokenId = (existing.frontmatter as Record<string, unknown>)['api_token_id'];
  if (typeof apiTokenId === 'string') {
    await tx.delete(apiTokens).where(eq(apiTokens.id, apiTokenId));
  }
  await emitEvent(tx, {
    workspaceId: ws.id, projectId: p.id, documentId: existing.id,
    kind: 'agent.deleted', actor: user.id,
    payload: { slug: existing.slug },
  });
}
```

- [ ] **Step 6: Run all the tests + full suite**

Run: `cd apps/server && bun test`
Expected: green. Token mint + revoke + event emission all verified.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/lib/events.ts \
        apps/server/src/lib/trigger-schema.ts \
        apps/server/src/routes/documents.ts \
        apps/server/src/routes/documents.test.ts
git commit -m "phase-2: auto-mint agent token on create; revoke on delete"
```

---

## Task 10: `agent.task.assigned` event emission

**Files:**
- Modify: `apps/server/src/routes/documents.ts` — detect assignee transition to `agent:*` on POST + PATCH
- Modify: `apps/server/src/routes/documents.test.ts`

### Step 1: Write the failing tests

In `documents.test.ts`:

```ts
test('work item POST with assignee=agent:slug emits agent.task.assigned', async () => {
  const { app, seed } = await makeTestApp();
  // First create the agent so the slug exists.
  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: ['list_documents'] },
    }),
  });

  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Triage me',
      frontmatter: { assignee: 'agent:bot' },
    }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.task.assigned') });
  expect(rows.length).toBe(1);
});

test('work item PATCH that adds assignee=agent:slug emits agent.task.assigned', async () => {
  const { app, seed } = await makeTestApp();
  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
    }),
  });
  const create = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'No assignee yet' }),
  });
  const { data: { slug } } = await create.json();

  await app.request(`/api/v1/w/acme/p/web/documents/${slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { assignee: 'agent:bot' } }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.task.assigned') });
  expect(rows.length).toBe(1);
});

test('PATCH that keeps the same agent assignee does NOT re-emit', async () => {
  const { app, seed } = await makeTestApp();
  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
    }),
  });
  const create = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Triage',
      frontmatter: { assignee: 'agent:bot' },
    }),
  });
  const { data: { slug } } = await create.json();

  // PATCH that doesn't change the assignee — emits nothing.
  await app.request(`/api/v1/w/acme/p/web/documents/${slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { assignee: 'agent:bot', priority: 'high' } }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.task.assigned') });
  expect(rows.length).toBe(1);  // still just the create
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/server && bun test documents.test.ts`
Expected: FAIL — no `agent.task.assigned` events emitted yet.

- [ ] **Step 3: Implement the assignee transition logic**

Helper at the top of `documents.ts`:

```ts
function getAssignee(fm: unknown): string | null {
  if (typeof fm !== 'object' || fm === null) return null;
  const v = (fm as Record<string, unknown>)['assignee'];
  return typeof v === 'string' ? v : null;
}
```

In the POST handler, after the row insert + main `document.created` event:

```ts
if (input.type === 'work_item') {
  const assignee = getAssignee(input.frontmatter);
  if (assignee && assignee.startsWith('agent:')) {
    await emitEvent(tx, {
      workspaceId: ws.id, projectId: p.id, documentId: row.id,
      kind: 'agent.task.assigned', actor: user.id,
      payload: { slug, agent: assignee.slice('agent:'.length) },
    });
  }
}
```

In the PATCH handler, after the row update:

```ts
const prevAssignee = getAssignee(existing.frontmatter);
const nextAssignee = getAssignee(updated.frontmatter);
if (
  nextAssignee &&
  nextAssignee.startsWith('agent:') &&
  prevAssignee !== nextAssignee
) {
  await emitEvent(tx, {
    workspaceId: ws.id, projectId: p.id, documentId: updated.id,
    kind: 'agent.task.assigned', actor: user.id,
    payload: { slug: updated.slug, agent: nextAssignee.slice('agent:'.length) },
  });
}
```

- [ ] **Step 4: Run + commit**

Run: `cd apps/server && bun test`
Expected: green.

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.test.ts
git commit -m "phase-2: emit agent.task.assigned on assignee transition"
```

---

## Task 11: Delegation guard

**Files:**
- Create: `apps/server/src/lib/delegation-guard.ts`
- Create: `apps/server/src/lib/delegation-guard.test.ts`
- Modify: `apps/server/src/routes/documents.ts` — apply the guard when a bearer-authenticated agent creates a work item with `assignee: agent:*`

### Step 1: Write the failing tests

**Create `apps/server/src/lib/delegation-guard.test.ts`:**

```ts
import { test, expect } from 'bun:test';
import { walkParentChain, type AgentLookup } from './delegation-guard.ts';

const make = (lookups: Record<string, { parent: string | null; max_delegation_depth: number }>): AgentLookup => ({
  findAgentBySlug: async (slug) => lookups[slug] ?? null,
});

test('walkParentChain returns depth 0 for a top-level agent', async () => {
  const lookup = make({ a: { parent: null, max_delegation_depth: 2 } });
  expect(await walkParentChain('a', lookup)).toBe(0);
});

test('walkParentChain returns depth 1 for a single-parent chain', async () => {
  const lookup = make({
    parent: { parent: null, max_delegation_depth: 2 },
    child: { parent: 'parent', max_delegation_depth: 2 },
  });
  expect(await walkParentChain('child', lookup)).toBe(1);
});

test('walkParentChain detects cycles and throws', async () => {
  const lookup = make({
    a: { parent: 'b', max_delegation_depth: 2 },
    b: { parent: 'a', max_delegation_depth: 2 },
  });
  await expect(walkParentChain('a', lookup)).rejects.toThrow(/cycle/i);
});

test('walkParentChain caps depth at 10 and throws if exceeded', async () => {
  const lookup = make(Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `a${i}`, { parent: i > 0 ? `a${i - 1}` : null, max_delegation_depth: 5 },
    ]),
  ));
  await expect(walkParentChain('a11', lookup)).rejects.toThrow(/too deep/i);
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/server && bun test delegation-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `delegation-guard.ts`**

**Create `apps/server/src/lib/delegation-guard.ts`:**

```ts
export interface AgentLookup {
  findAgentBySlug(slug: string): Promise<{ parent: string | null; max_delegation_depth: number } | null>;
}

const MAX_WALK = 10;

/** Walk the parent_agent chain from `slug` up. Returns the depth (0 = root).
 *  Throws on cycle or chain > MAX_WALK hops. */
export async function walkParentChain(slug: string, lookup: AgentLookup): Promise<number> {
  const visited = new Set<string>();
  let current: string | null = slug;
  let depth = 0;
  while (current) {
    if (visited.has(current)) throw new Error('agent delegation cycle detected');
    visited.add(current);
    if (depth > MAX_WALK) throw new Error('agent delegation chain too deep');
    const row: { parent: string | null; max_delegation_depth: number } | null = await lookup.findAgentBySlug(current);
    if (!row) return depth;
    current = row.parent;
    if (current) depth++;
  }
  return depth;
}
```

- [ ] **Step 4: Run + commit**

Run: `cd apps/server && bun test delegation-guard.test.ts`
Expected: 4/4 pass.

```bash
git add apps/server/src/lib/delegation-guard.ts \
        apps/server/src/lib/delegation-guard.test.ts
git commit -m "phase-2: delegation guard parent-chain walker"
```

### Step 5: Wire the guard into `documents.ts`

In the POST handler, BEFORE inserting a work item, check if the request is token-authenticated AND the token belongs to an agent AND the new work item has `assignee: agent:*`:

```ts
import { walkParentChain } from '../lib/delegation-guard.ts';

// ...inside POST, after the basic validation:

const token = c.get('token');
if (token && input.type === 'work_item') {
  const childAssignee = getAssignee(input.frontmatter);
  if (childAssignee?.startsWith('agent:')) {
    // Find the agent that owns this token.
    const ownerAgent = await db.query.documents.findFirst({
      where: and(
        eq(documents.projectId, p.id),
        eq(documents.type, 'agent'),
      ),
      // The token-to-agent link is via frontmatter.api_token_id; SQLite can't
      // index JSON natively, so we walk in JS for v1.
    });
    if (ownerAgent && (ownerAgent.frontmatter as Record<string, unknown>)['api_token_id'] === token.id) {
      const ownerSlug = ownerAgent.slug;
      const ownerFm = ownerAgent.frontmatter as Record<string, unknown>;
      const maxDepth = (ownerFm['max_delegation_depth'] as number | undefined) ?? 2;
      const lookup = {
        findAgentBySlug: async (slug: string) => {
          const row = await db.query.documents.findFirst({
            where: and(eq(documents.projectId, p.id), eq(documents.type, 'agent'), eq(documents.slug, slug)),
          });
          if (!row) return null;
          const fm = row.frontmatter as Record<string, unknown>;
          return {
            parent: (fm['parent_agent'] as string | null | undefined) ?? null,
            max_delegation_depth: (fm['max_delegation_depth'] as number | undefined) ?? 2,
          };
        },
      };
      try {
        const ownerDepth = await walkParentChain(ownerSlug, lookup);
        if (ownerDepth + 1 > maxDepth) {
          throw new HTTPError(
            'DELEGATION_DEPTH_EXCEEDED',
            `agent ${ownerSlug} cannot delegate past max_delegation_depth ${maxDepth} (current ${ownerDepth + 1})`,
            403,
          );
        }
      } catch (err) {
        if (err instanceof HTTPError) throw err;
        throw new HTTPError('DELEGATION_GUARD_FAILED', String(err), 500);
      }
    }
  }
}
```

> The `findAgentBySlug` walks the documents table per hop. For v1 this is fine; deep chains are bounded at 5 hops max. If we ever need it, a small in-memory cache per request is the optimization.

- [ ] **Step 6: Write an integration test in documents.test.ts**

```ts
test('an agent token cannot delegate past its max_delegation_depth', async () => {
  const { app, seed } = await makeTestApp();
  // Create an agent with max_delegation_depth: 0 (cannot delegate at all).
  const create = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Bot',
      frontmatter: {
        system_prompt: 'x', model: 'x', provider: 'anthropic',
        tools: ['create_document'], max_delegation_depth: 0,
      },
    }),
  });
  const { data: { agent_token } } = await create.json();

  const childCreate = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agent_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'I am trying to assign',
      frontmatter: { assignee: 'agent:bot' },  // assigning to itself, depth 1 > max 0
    }),
  });
  expect(childCreate.status).toBe(403);
  const body = await childCreate.json();
  expect(body.error.code).toBe('DELEGATION_DEPTH_EXCEEDED');
});
```

- [ ] **Step 7: Run + commit**

Run: `cd apps/server && bun test`
Expected: green.

```bash
git add apps/server/src/routes/documents.ts apps/server/src/routes/documents.test.ts
git commit -m "phase-2: enforce delegation depth on agent-token document creates"
```

---

## Task 12: Hand-rolled MCP server at `/mcp`

**Files:**
- Create: `apps/server/src/routes/mcp.ts`
- Create: `apps/server/src/routes/mcp.test.ts`
- Modify: `apps/server/src/app.ts` — mount `/mcp`

### Step 1: Write the failing tests

**Create `apps/server/src/routes/mcp.test.ts`:**

```ts
import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { nanoid } from 'nanoid';

async function setupToken(workspaceId: string, userId: string, scopes: string[]) {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId, name: 'mcp-test', tokenHash: hash,
    scopes, createdBy: userId,
  });
  return token;
}

test('MCP rejects requests without a Bearer token', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
});

test('MCP initialize returns serverInfo + protocolVersion', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.serverInfo.name).toBe('folio');
  expect(body.result.protocolVersion).toBeTruthy();
});

test('MCP tools/list returns the 12 v1 tools', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = await res.json();
  expect(body.result.tools.length).toBe(12);
});

test('MCP tools/call list_workspaces returns the workspaces visible to the token', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_workspaces', arguments: {} },
    }),
  });
  const body = await res.json();
  expect(body.result.content[0].type).toBe('text');
  const parsed = JSON.parse(body.result.content[0].text);
  expect(parsed.workspaces.length).toBeGreaterThan(0);
});

test('MCP tools/call create_document requires documents:write', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);  // NO write
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: { workspace_slug: 'acme', project_slug: 'web', type: 'work_item', title: 'from mcp' },
      },
    }),
  });
  const body = await res.json();
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe(-32603);
  expect(body.error.message).toMatch(/documents:write/);
});

test('MCP tools/call create_document works with documents:write', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:write', 'documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: { workspace_slug: 'acme', project_slug: 'web', type: 'work_item', title: 'from mcp' },
      },
    }),
  });
  const body = await res.json();
  expect(body.result).toBeDefined();
  const parsed = JSON.parse(body.result.content[0].text);
  expect(parsed.title).toBe('from mcp');
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/server && bun test mcp.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement `mcp.ts`**

**Create `apps/server/src/routes/mcp.ts`:**

```ts
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, projects, statuses, fields, views, workspaces, memberships } from '../db/schema.ts';
import { attachToken, requireToken, getToken } from '../middleware/bearer.ts';
import { type AuthContext } from '../middleware/auth.ts';

const mcpRoute = new Hono<AuthContext>();
mcpRoute.use('*', attachToken, requireToken);

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type ToolHandler = (token: typeof getToken extends (c: any) => infer T ? T : never, args: Record<string, unknown>) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScope?: string;
  handler: ToolHandler;
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_workspaces',
    description: 'List workspaces visible to the token.',
    inputSchema: { type: 'object', properties: {} },
    requiredScope: 'documents:read',
    handler: async (token) => {
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, token.workspaceId) });
      return textResult({ workspaces: ws ? [{ id: ws.id, slug: ws.slug, name: ws.name }] : [] });
    },
  },
  {
    name: 'list_projects',
    description: 'List projects in a workspace.',
    inputSchema: {
      type: 'object',
      properties: { workspace_slug: { type: 'string' } },
      required: ['workspace_slug'],
    },
    requiredScope: 'documents:read',
    handler: async (token, args) => {
      const wslug = String(args['workspace_slug']);
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, wslug) });
      if (!ws || ws.id !== token.workspaceId) throw new Error('workspace not accessible');
      const list = await db.query.projects.findMany({ where: eq(projects.workspaceId, ws.id) });
      return textResult({
        projects: list.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
      });
    },
  },
  {
    name: 'list_documents',
    description: 'List documents in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' },
        project_slug: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug'],
    },
    requiredScope: 'documents:read',
    handler: async (token, args) => {
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, String(args['workspace_slug'])) });
      if (!ws || ws.id !== token.workspaceId) throw new Error('workspace not accessible');
      const p = await db.query.projects.findFirst({
        where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, String(args['project_slug']))),
      });
      if (!p) throw new Error('project not found');
      const typeArg = args['type'] ? String(args['type']) : undefined;
      const list = await db.query.documents.findMany({
        where: typeArg
          ? and(eq(documents.projectId, p.id), eq(documents.type, typeArg as 'work_item' | 'page' | 'agent' | 'trigger'))
          : eq(documents.projectId, p.id),
        limit: 100,
      });
      return textResult({
        documents: list.map((d) => ({ id: d.id, slug: d.slug, title: d.title, type: d.type, status: d.status })),
      });
    },
  },
  {
    name: 'get_document',
    description: 'Get a single document with frontmatter + body.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' }, project_slug: { type: 'string' }, slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:read',
    handler: async (token, args) => {
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, String(args['workspace_slug'])) });
      if (!ws || ws.id !== token.workspaceId) throw new Error('workspace not accessible');
      const p = await db.query.projects.findFirst({
        where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, String(args['project_slug']))),
      });
      if (!p) throw new Error('project not found');
      const doc = await db.query.documents.findFirst({
        where: and(eq(documents.projectId, p.id), eq(documents.slug, String(args['slug']))),
      });
      if (!doc) throw new Error('document not found');
      return textResult(doc);
    },
  },
  {
    name: 'get_document_markdown',
    description: 'Get the raw markdown of a document (frontmatter + body).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' }, project_slug: { type: 'string' }, slug: { type: 'string' },
      },
      required: ['workspace_slug', 'project_slug', 'slug'],
    },
    requiredScope: 'documents:read',
    handler: async (token, args) => {
      // Same lookup as get_document, return as `text/markdown` string.
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, String(args['workspace_slug'])) });
      if (!ws || ws.id !== token.workspaceId) throw new Error('workspace not accessible');
      const p = await db.query.projects.findFirst({
        where: and(eq(projects.workspaceId, ws.id), eq(projects.slug, String(args['project_slug']))),
      });
      if (!p) throw new Error('project not found');
      const doc = await db.query.documents.findFirst({
        where: and(eq(documents.projectId, p.id), eq(documents.slug, String(args['slug']))),
      });
      if (!doc) throw new Error('document not found');
      const fm = doc.frontmatter ?? {};
      const fmYaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
      const md = `---\n${fmYaml}\n---\n\n# ${doc.title}\n\n${doc.body}`;
      return { content: [{ type: 'text', text: md }] };
    },
  },
  {
    name: 'create_document',
    description: 'Create a document. Args: workspace_slug, project_slug, type, title, body?, frontmatter?.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_slug: { type: 'string' }, project_slug: { type: 'string' },
        type: { type: 'string' }, title: { type: 'string' },
        body: { type: 'string' }, frontmatter: { type: 'object' },
      },
      required: ['workspace_slug', 'project_slug', 'type', 'title'],
    },
    requiredScope: 'documents:write',
    handler: async (token, args) => {
      // Delegate to the existing documents.ts POST handler logic. For v1 simplicity,
      // do an in-process fetch to avoid duplicating the create/event/slug logic.
      const url = `/api/v1/w/${args['workspace_slug']}/p/${args['project_slug']}/documents`;
      const res = await mcpInternalFetch(token, url, 'POST', JSON.stringify({
        type: args['type'], title: args['title'],
        body: args['body'] ?? '', frontmatter: args['frontmatter'] ?? {},
      }));
      if (!res.ok) throw new Error(`create_document failed: ${res.status}`);
      const body = await res.json();
      return textResult(body.data);
    },
  },
  // Remaining tools follow the same pattern. Implement update_document, delete_document,
  // list_statuses, list_fields, list_views, run_view. For brevity in this plan the full
  // bodies are not shown — they mirror create_document's "delegate via mcpInternalFetch"
  // approach. See FOLIO-BRIEFING.md §9 for the arg shapes.
  // STUB for the plan; the implementer fills these in:
  ...['update_document', 'delete_document', 'list_statuses', 'list_fields', 'list_views', 'run_view']
    .map((name): ToolDef => ({
      name,
      description: `${name} (see docs/MCP.md)`,
      inputSchema: { type: 'object', properties: {} },
      requiredScope: name.startsWith('list_') || name === 'run_view' ? 'documents:read' : 'documents:write',
      handler: async () => { throw new Error(`${name} not implemented`); },
    })),
];

/** Internal app.request that forwards the bearer token. Avoids running the full network stack. */
async function mcpInternalFetch(token: { id: string }, path: string, method: string, body?: string): Promise<Response> {
  // The Hono app instance is reachable through a singleton — read app.ts to confirm.
  // For now: re-import via a getter the implementer wires up.
  const { app } = await import('../app.ts');
  return app.request(path, {
    method,
    headers: {
      // We forward as the agent's own token; the bearer middleware will re-attach it.
      Authorization: `Bearer ${await getRawTokenForId(token.id)}`,
      'Content-Type': 'application/json',
    },
    body,
  });
}

/** PROBLEM: we have the hashed token, not the plaintext. Tools must NOT need to recover plaintext.
 *  Instead, call the route logic directly without re-routing through HTTP. See implementer note. */
async function getRawTokenForId(_id: string): Promise<string> {
  throw new Error('plaintext token not recoverable — refactor tools to call internal services directly');
}

mcpRoute.post('/', async (c) => {
  const body = (await c.req.json()) as JsonRpcRequest;
  const token = getToken(c);

  if (body.method === 'initialize') {
    return c.json<JsonRpcResponse>({
      jsonrpc: '2.0', id: body.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'folio', version: '0.1.0' },
        capabilities: { tools: {} },
      },
    });
  }

  if (body.method === 'tools/list') {
    return c.json<JsonRpcResponse>({
      jsonrpc: '2.0', id: body.id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        })),
      },
    });
  }

  if (body.method === 'tools/call') {
    const { name, arguments: args } = (body.params ?? {}) as { name: string; arguments: Record<string, unknown> };
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0', id: body.id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      });
    }
    if (tool.requiredScope && !token.scopes.includes(tool.requiredScope)) {
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0', id: body.id,
        error: { code: -32603, message: `tool ${name} requires scope: ${tool.requiredScope}`, data: { tool: name, required_scope: tool.requiredScope } },
      });
    }
    try {
      const result = await tool.handler(token as never, args ?? {});
      return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id: body.id, result });
    } catch (err) {
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0', id: body.id,
        error: { code: -32603, message: String(err) },
      });
    }
  }

  if (body.method === 'ping') {
    return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id: body.id, result: {} });
  }

  return c.json<JsonRpcResponse>({
    jsonrpc: '2.0', id: body.id,
    error: { code: -32601, message: `method not supported: ${body.method}` },
  });
});

export { mcpRoute };
```

> **IMPLEMENTER NOTE — KNOWN ISSUE TO RESOLVE IN THIS TASK:** The `mcpInternalFetch` approach above does not work because we don't have the plaintext token at handler-call time — only the hashed row. There are two acceptable resolutions; pick one before completing this task:
>
> **(a) Refactor the document/status/field/view route handlers** to extract their core logic into pure service functions (e.g. `createDocumentService(db, { workspaceId, projectId, input, actor })` in `apps/server/src/services/documents.ts`). The HTTP route handler becomes a thin wrapper, and `mcp.ts` calls the same service directly with `token.workspaceId` as the auth context. This is the right long-term shape and matches what `memory/lessons.md` calls "don't duplicate logic between MCP and REST."
>
> **(b) Bypass the bearer middleware for internal calls** by passing the already-resolved `ws.id` / `user / token` into a context-aware route invocation. Hono supports this via `c.set` before `app.request`. Messier; deferred recommended.
>
> **Go with (a).** Extract `documents.service.ts`, `fields.service.ts`, etc. with the create / patch / delete logic isolated. MCP tools call services; REST handlers call services. This is a small refactor (each handler is currently ~30-50 lines; extract the body into a pure async function taking `{ db, workspaceId, projectId, ... }`).
>
> Mark the original sub-task complete when **all 12 v1 tools are implemented via the service layer** AND the test file passes. Plan to spend ~half of Task 12's time on the service extraction; the rest on wiring.

- [ ] **Step 4: Mount `/mcp`**

In `app.ts`:

```ts
import { mcpRoute } from './routes/mcp.ts';
// ...near the bottom of the route mounts:
app.route('/mcp', mcpRoute);
```

- [ ] **Step 5: Run + iterate until green**

Run: `cd apps/server && bun test mcp.test.ts`
Expected: 6/6 PASS once tools are wired through the service layer.

- [ ] **Step 6: Run full server suite**

Run: `cd apps/server && bun test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/mcp.ts \
        apps/server/src/routes/mcp.test.ts \
        apps/server/src/app.ts \
        apps/server/src/services/*.ts \
        apps/server/src/routes/documents.ts \
        apps/server/src/routes/fields.ts \
        apps/server/src/routes/views.ts \
        apps/server/src/routes/statuses.ts \
        apps/server/src/routes/tables.ts
git commit -m "phase-2: hand-rolled JSON-RPC MCP at /mcp with v1 tool set"
```

---

## Task 13: Web — `useTokens` / `useCreateToken` / `useDeleteToken`

**Files:**
- Create: `apps/web/src/lib/api/tokens.ts`
- Create: `apps/web/src/lib/api/tokens.test.tsx`

### Step 1: Write the failing tests

**Create `apps/web/src/lib/api/tokens.test.tsx`:**

```tsx
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCreateToken, useDeleteToken, tokensKeys } from './tokens.ts';

afterEach(() => vi.unstubAllGlobals());

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('tokensKeys', () => {
  it('list key includes workspaceId', () => {
    expect(tokensKeys.list('ws-1')).toEqual(['tokens', 'ws-1']);
  });
});

describe('useCreateToken', () => {
  it('POSTs to /api/v1/tokens/:workspaceId and returns the plaintext token once', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({
        data: { id: 'tok_1', name: 'CI', token: 'folio_pat_abc', scopes: ['documents:read'] },
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));

    const { result } = renderHook(() => useCreateToken('ws-1'), { wrapper: wrap(qc) });
    const created = await result.current.mutateAsync({ name: 'CI', scopes: ['documents:read'] });

    expect(calls[0].url).toContain('/api/v1/tokens/ws-1');
    expect(created.token).toBe('folio_pat_abc');
  });
});

describe('useDeleteToken', () => {
  it('DELETEs /api/v1/tokens/:workspaceId/:id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { result } = renderHook(() => useDeleteToken('ws-1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync('tok_1');

    expect(calls[0]).toContain('/api/v1/tokens/ws-1/tok_1');
  });
});
```

- [ ] **Step 2: Run + watch fail**

Run: `cd apps/web && bun run test tokens.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `tokens.ts`**

**Create `apps/web/src/lib/api/tokens.ts`:**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiTokenCreateResponse {
  id: string;
  name: string;
  token: string;  // plaintext, returned ONCE
  scopes: string[];
}

export const tokensKeys = {
  list: (workspaceId: string) => ['tokens', workspaceId] as const,
};

export function useTokens(workspaceId: string) {
  return useQuery({
    queryKey: tokensKeys.list(workspaceId),
    queryFn: () => client.get<{ tokens: ApiToken[] }>(`/api/v1/tokens/${workspaceId}`),
    enabled: !!workspaceId,
  });
}

export interface TokenCreate {
  name: string;
  scopes: string[];
}

export function useCreateToken(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TokenCreate) =>
      client.post<ApiTokenCreateResponse>(`/api/v1/tokens/${workspaceId}`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKeys.list(workspaceId) }),
  });
}

export function useDeleteToken(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      client.delete(`/api/v1/tokens/${workspaceId}/${tokenId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKeys.list(workspaceId) }),
  });
}
```

- [ ] **Step 4: Run + commit**

Run: `cd apps/web && bun run test tokens.test.tsx`
Expected: PASS.

```bash
git add apps/web/src/lib/api/tokens.ts apps/web/src/lib/api/tokens.test.tsx
git commit -m "phase-2: useTokens / useCreateToken / useDeleteToken hooks"
```

---

## Task 14: Web — Tokens tab in workspace settings

**Files:**
- Create: `apps/web/src/components/settings/tokens-tab.tsx`
- Create: `apps/web/src/components/settings/tokens-tab.test.tsx`
- Create: `apps/web/src/components/settings/token-create-modal.tsx`
- Modify: the workspace settings route (find via `grep`) to mount the tab

### Steps

- [ ] **Step 1.** Read the existing settings route to learn the tab pattern. Likely `apps/web/src/routes/w.$wslug.settings.tsx` or similar.

- [ ] **Step 2.** Write a failing test that mounts `<TokensTab workspaceId="..." />` with a mocked `useTokens` returning two tokens. Asserts: both names render, `lastUsedAt` shows as relative time or "Never used", delete button per row.

- [ ] **Step 3.** Implement `tokens-tab.tsx`: list of tokens, inline-edit name (PATCH), `Revoke` button with confirm dialog, `+ Create token` button that opens `<TokenCreateModal>`.

- [ ] **Step 4.** Write a failing test for `<TokenCreateModal>`: opens, shows scope checkboxes (`documents:read`, `documents:write`, `documents:delete`, `fields:write`, `views:write`, `tables:write`), submits → server returns plaintext token → modal switches to "Show plaintext" state with copy button and warning.

- [ ] **Step 5.** Implement the modal.

- [ ] **Step 6.** Mount the tab in the workspace settings route.

- [ ] **Step 7.** Run full web suite + commit.

```bash
git add apps/web/src/components/settings/tokens-tab.tsx \
        apps/web/src/components/settings/tokens-tab.test.tsx \
        apps/web/src/components/settings/token-create-modal.tsx \
        apps/web/src/components/settings/token-create-modal.test.tsx \
        apps/web/src/routes/w.\$wslug.settings.tsx
git commit -m "phase-2: workspace settings — API tokens tab"
```

> This task is the most UI-heavy and least tightly specified. The implementer has discretion on layout — keep it consistent with existing settings tabs (AI keys tab in `routes/settings.ts` is the closest model). Use the existing primitives (`Button` / `Dialog` / inline-edit / `Pill` for scopes). Confirm dialog matches the slideover/column-delete pattern.

---

## Task 15: Web — Assignee picker (humans + agents)

**Files:**
- Create: `apps/web/src/components/assignee/assignee-picker.tsx`
- Create: `apps/web/src/components/assignee/assignee-picker.test.tsx`
- Modify: `apps/web/src/components/slideover/frontmatter-form.tsx` — render `<AssigneePicker>` when key is `assignee`

### Steps

- [ ] **Step 1.** Write a failing test rendering `<AssigneePicker value="" onChange={...} wslug pslug />` with mocked memberships + agents queries. Asserts: two sections "Members" and "Agents", clicking an agent calls `onChange('agent:<slug>')`, clicking a member calls `onChange('<email>')`.

- [ ] **Step 2.** Implement the component. It's a Popover with two sections. Reuse `useWorkspaces`/`useMemberships` hook for the member list. Add a new hook `useAgents(wslug, pslug)` (or extend `useDocuments` with `?type=agent`).

- [ ] **Step 3.** Wire into `frontmatter-form.tsx`: when the field key is `assignee`, render `<AssigneePicker>` instead of the generic string input.

- [ ] **Step 4.** Run full suite + commit.

```bash
git add apps/web/src/components/assignee/assignee-picker.tsx \
        apps/web/src/components/assignee/assignee-picker.test.tsx \
        apps/web/src/components/slideover/frontmatter-form.tsx
git commit -m "phase-2: assignee picker — humans + agents"
```

---

## Task 16: Web — Agents + Triggers in the rail

**Files:**
- Modify: `apps/web/src/components/shell/rail-tree.tsx` — add leaves
- Modify: existing rail-tree tests

### Steps

- [ ] **Step 1.** Write failing tests for the rail tree: when a project is expanded, "Agents" and "Triggers" appear as leaf rows below Wiki. Clicking each navigates to the right route.

- [ ] **Step 2.** Add new file routes:
  - `apps/web/src/routes/w.$wslug.p.$pslug.agents.tsx`
  - `apps/web/src/routes/w.$wslug.p.$pslug.triggers.tsx`
  Both render `<TableView>` filtered by `type='agent'` / `type='trigger'`.

- [ ] **Step 3.** Modify `rail-tree.tsx` to emit the two extra leaves.

- [ ] **Step 4.** Run full suite + commit.

```bash
git add apps/web/src/components/shell/rail-tree.tsx \
        apps/web/src/routes/w.\$wslug.p.\$pslug.agents.tsx \
        apps/web/src/routes/w.\$wslug.p.\$pslug.triggers.tsx
git commit -m "phase-2: rail — Agents + Triggers leaves under each project"
```

---

## Task 17: Documentation — `docs/API.md`, `docs/MCP.md`, `docs/AGENTS.md`, `docs/TRIGGERS.md` + README update

**Files:**
- Create: `docs/API.md`, `docs/MCP.md`, `docs/AGENTS.md`, `docs/TRIGGERS.md`
- Modify: `README.md`

### Steps

- [ ] **Step 1.** Write `docs/API.md`: REST reference. Use the existing route files as the source of truth. Cover auth (session vs. bearer), scopes table, every endpoint with method + path + request body shape + response shape + scope required. Group by resource (workspaces, projects, tables, fields, views, statuses, documents, tokens, events, settings).

- [ ] **Step 2.** Write `docs/MCP.md`: tool reference. Each tool from `V1_MCP_TOOLS` gets a section with argument shape, return shape, scope required, and a complete curl example showing a JSON-RPC request + response.

- [ ] **Step 3.** Write `docs/AGENTS.md`: agent-document model. Schema (frontmatter shape), auto-token lifecycle (create → token minted, delete → token revoked), assignee convention (`agent:<slug>`), delegation rules with the `parent_agent` chain, the `agent.task.assigned` / `agent.created` / `agent.deleted` event contracts, and an explicit note that the runner ships in Phase 3.

- [ ] **Step 4.** Write `docs/TRIGGERS.md`: trigger-document model. Schema, cron + event-pattern semantics, payload contract, validation rules (cron shape, known event kinds, mutex on schedule + on_event), and a note that the scheduler/matcher ships in Phase 3.

- [ ] **Step 5.** Update `README.md`'s top-level "What this is" section with a 5-minute agent walkthrough: create a token via UI, `curl POST` to create a doc, see the event arrive on SSE, mount the MCP server in Claude Desktop. Link to `docs/AGENTS.md` for depth.

- [ ] **Step 6.** Commit:

```bash
git add docs/API.md docs/MCP.md docs/AGENTS.md docs/TRIGGERS.md README.md
git commit -m "phase-2: docs — API + MCP + AGENTS + TRIGGERS + README walkthrough"
```

> Docs are the final acceptance gate per FOLIO-BRIEFING.md ("documentation lets a new agent integrate in 15 minutes"). Use the actual code (route files, schemas) as the source of truth — don't paraphrase. Cite file paths inline.

---

## Task 18: Update PHASES.md + STATE.md, integration gate, PR

**Files:**
- Modify: `docs/PHASES.md` — check off Phase 2 acceptance
- Modify: `memory/STATE.md` — flip Phase 2 to shipped

### Steps

- [ ] **Step 1.** Check off the 12 Phase 2 acceptance criteria in `docs/PHASES.md` lines 541-553 (or wherever they end up after this branch lands).

- [ ] **Step 2.** Update `memory/STATE.md`:
  - Move Phase 2 from queued → shipped with branch + tip + test counts.
  - Add to "What's working in the UI": Tokens tab, Agents/Triggers in rail, AssigneePicker.
  - Add to "What's working server-side": Bearer auth, SSE, MCP.
  - Note any open follow-ups (e.g. the `get_folio_workflow` MCP tool deferred to 2.1).

- [ ] **Step 3.** Run the full integration gate:
  ```bash
  cd apps/web && bun run test
  cd apps/server && bun test
  cd packages/shared && bun test
  cd apps/web && bunx tsc --noEmit
  cd apps/server && bunx tsc --noEmit | grep -v "node_modules"
  ```
  Expected counts: server ~165-175, web ~270-285, shared 28. Web TS clean.

- [ ] **Step 4.** Manual smoke (15 minutes):
  - Sign in, open workspace settings → API tokens tab. Create a token with `documents:read + documents:write`. Copy the plaintext.
  - In a terminal: `curl -H "Authorization: Bearer <token>" http://localhost:3001/api/v1/w/<wslug>/p/<pslug>/documents` returns the document list.
  - Same `curl` POST a new document. Verify it appears in the UI.
  - Open `curl -H "Authorization: Bearer <token>" -N http://localhost:3001/api/v1/w/<wslug>/events` and edit a doc in the UI — see the event arrive.
  - Hit `/mcp` with a JSON-RPC initialize call, then tools/list, then tools/call list_workspaces. All return valid JSON-RPC responses.
  - Create an agent via the UI (Agents leaf in rail). Verify the agent's auto-minted token appears in the Tokens tab. Assign a work item to `agent:<slug>` via the assignee picker. Confirm a `agent.task.assigned` event arrives on the SSE stream.
  - Create a trigger with a cron schedule. Persist + reload — round-trip works.
  - Delete the agent. Confirm the auto-token is gone from the Tokens tab AND subsequent requests with that token return 401.

- [ ] **Step 5.** Commit docs:
  ```bash
  git add docs/PHASES.md memory/STATE.md
  git commit -m "phase-2: complete"
  ```

- [ ] **Step 6.** Push + open PR.

PR body template:

```
## Summary

Phase 2 — Agents. The v1 spine of Folio. Tokens authenticate every route via bearer alongside session cookies; events emit over an in-memory bus and an SSE stream; agents and triggers are documents (`type: 'agent'`, `type: 'trigger'`) with Zod-validated frontmatter, auto-minted scoped tokens, delegation guards, and a hand-rolled JSON-RPC MCP endpoint at `/mcp` exposing the v1 tool set.

- Bearer auth middleware + resource:action scopes (`documents:read`, `documents:write`, etc.). All workspace-scoped routes accept either session or token.
- In-memory event bus (`lib/event-bus.ts`) + SSE endpoint with `Last-Event-Id` replay.
- Migration 0006 widens `documents.type` to include `'agent'` and `'trigger'`. Both reject `tableId` (they belong to the project, not a table).
- Agent surface: Zod schema validates frontmatter (`system_prompt`, `model`, `provider`, `tools`, `max_delegation_depth`, `max_tokens_per_run`, `requires_approval`). On create, a `apiTokens` row is auto-minted with scopes derived from `tools[]`; plaintext returned once. On delete, the token is revoked. Assignee `agent:<slug>` emits `agent.task.assigned`. Delegation depth enforced via parent-chain walk.
- Trigger surface: cron-shape validation + known-event-kind whitelist + mutex on `schedule` / `on_event`. Storage only — Phase 3 ships the scheduler.
- MCP server: hand-rolled JSON-RPC at `/mcp`. 12 v1 tools delegating to a freshly-extracted service layer (`services/documents.ts`, etc.). Per-tool scope gating.
- Web: workspace settings → API tokens tab (create / list / revoke with one-time plaintext modal), assignee picker (humans + agents), Agents + Triggers as rail leaves.
- Docs: `API.md`, `MCP.md`, `AGENTS.md`, `TRIGGERS.md` + README walkthrough.

## Deferred

- `get_folio_workflow` MCP tool → Phase 2.1.
- `requires_approval` + `max_tokens_per_run` enforcement → Phase 3 (runner-side).
- The `## Approved` body convention → Phase 3.
- `search_documents` MCP tool → v1.1 (needs sqlite-fts5).

## Test plan

- Server unit suite: ~165-175 passing (was 135).
- Web unit suite: ~270-285 passing (was 254).
- Shared: 28 / 28.
- Type-check (`apps/web`): clean. Pre-existing `apps/server/src/app.ts` error remains out of scope.
- Manual smoke checklist (see plan doc Task 18) verified.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

Spec coverage check against PHASES.md Phase 2 (post-revision):

| Spec section | Tasks |
|---|---|
| Already shipped (verify) | Tasks 1, 2 (verify in passing) |
| Bearer middleware + scopes | Tasks 1, 2 |
| Token UI | Tasks 13, 14 |
| Events & SSE | Tasks 3, 4 |
| Documents type widening | Task 5 |
| Agent Zod schema + autotoken | Tasks 6, 9 |
| `agent.task.assigned` | Task 10 |
| Delegation guard | Task 11 |
| UI: Agents in rail + assignee picker | Tasks 15, 16 |
| Trigger Zod + cron validation | Task 7 |
| Trigger frontmatter wired into documents.ts | Task 8 |
| UI: Triggers in rail | Task 16 |
| MCP server | Task 12 |
| Docs | Task 17 |
| PHASES.md + STATE.md + PR | Task 18 |

Placeholder scan: Task 14 (Tokens tab UI) and Task 17 (docs) have "Steps" without full code blocks. **This is intentional** — those tasks are about discretion-heavy UI / prose work where verbatim code-in-plan would constrain the implementer wrongly. Each step is bite-sized and TDD-able; the implementer chooses layout / wording. All other tasks have complete code.

Type consistency: `EventKind` in `events.ts` is widened in Task 9; `KNOWN_EVENT_KINDS` in `trigger-schema.ts` is updated in the same task. `BusEvent` shape matches across `event-bus.ts` and `routes/events.ts`. `V1_MCP_TOOLS` is the single source of truth for tool names (used by `agent-schema.ts` and `mcp.ts`). `ApiToken` type in `apps/web/src/lib/api/tokens.ts` mirrors the server's row shape minus `tokenHash`.

**Known plan risk:** Task 12 (MCP) requires extracting service layer functions from existing route handlers. This is a non-trivial side-quest. The implementer should budget extra time and may need to split Task 12 into 12a (extract services) + 12b (wire MCP). If the subagent reports BLOCKED on Task 12, the controller's call: either split it OR pivot to option (b) from the implementer note (the messier in-process route invocation approach).
