# Option C — Operator Cockpit Auto-Resume on Reload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On cockpit mount/reload, auto-load the session user's most-recent conversation so a chat (especially one paused on a confirm card) is restored instead of starting blank.

**Architecture:** Add one session-only, owner-scoped read endpoint `GET /api/v1/conversations/recent` returning `{ id }` of the newest conversation (by `updated_at`) owned by the session user, or `{ id: null }` when the user has none. The web cockpit panel fetches it on mount and passes the id into the already-resume-capable `CockpitChat`. No new state model, no schema change — the existing `conversations_user_idx (created_by, updated_at)` index already serves the query.

**Tech Stack:** Hono + Drizzle (server), React + TanStack Query (web), Bun test (server), Vitest (web), Playwright (e2e).

---

## Scope

Two coordinated changes behind ONE review cluster (≤4 tasks → single `── REVIEW GATE ──` at the end):

- **Task 1 (server):** `getMostRecentConversationId(db, userId)` service helper + `GET /conversations/recent` route, owner-scoped, session-only.
- **Task 2 (web):** `useRecentConversation()` hook + auto-resume wiring in `AgentCockpitPanel` → `CockpitChat`.
- **Task 3 (e2e acceptance):** drive the auto-resume flow through the real browser.

**Decision (Stefan, 2026-06-08):** "Most-recent conversation, ALWAYS" — no `active`/`pending`-only predicate. `ORDER BY updated_at DESC LIMIT 1`. A finished chat reloading to its thread is acceptable/desirable; the confirm-card case is covered because a paused conversation is the most recent one.

**Already done (verified, NOT in scope):** the sibling 2026-06-06 finding "confirm gate fails the run with `provider_error`" is FIXED — `runner.ts:1371-1380` catches `AwaitingConfirmationError` and ends the turn cleanly via `postResultAndComplete` (invariant 12, ratified in the doc). This plan is only the auto-resume half.

---

## Threat model

> This threat model is for Option C (cockpit auto-resume), written 2026-06-08. The new surface is a session-only READ endpoint that returns a conversation id belonging to the caller. It exists because the endpoint discloses an identifier scoped to a user — the dominant risk is the cross-user disclosure (M11) class the existing `loadOwnedConversation` convergence point already defends. This section is the `/code-review` convergence target so the review verifies the owner-scoping predicate is present on the NEW query instead of re-deriving the attack surface.

### What we're defending

- **The set of a user's conversation ids** — `conversations.id` rows where `created_by = <that user>`. A conversation id is the resume handle: with it, `GET /conversations/:id` returns the full thread, and `POST /conversations/:id/messages/:mid/click` can confirm a recorded `pending_op` (an irreversible config write). So a leaked id is not just metadata — it can drive a high-tier operation under the owner's confirmer identity.
- **The M11 owner-scoping invariant** — every conversation read/write filters `conversations.created_by === sessionUser.id`. The new `/recent` route must not become the one read path that forgets the predicate.
- **Invariant 4 (session-only auth on the conversations surface)** — the cockpit is a human surface; a bearer/agent token must not drive it. The route is mounted where `attachToken` does not run and `requireSessionUser` is the operative gate.

### Who we're defending against

- **Authenticated user A reading user B's most-recent conversation** — IN scope. The whole risk: `/recent` returning B's newest conversation to A would hand A a resume handle to B's chat (and B's pending confirm cards). Defended by the owner-scoping predicate.
- **An agent / bearer token hitting `/recent`** — IN scope. The conversations surface is session-only (invariant 4); a bearer must get the same `requireSessionUser` 401 the sibling routes give, not a conversation id.
- **Unauthenticated caller** — IN scope (trivially): `requireSessionUser` 401s before any DB read.
- **Insider with stolen session cookie** — OUT of scope (acknowledged): a valid session IS the user; same posture as every other session-only route. Not introduced by this feature.

### Attacks to defend against

1. **Missing owner predicate (cross-user disclosure, M11).** The `/recent` query selects the newest conversation by `updated_at` but omits `WHERE created_by = sessionUser.id` (or uses a stale/attacker-influenced id), returning ANY user's most-recent conversation — handing the caller a resume handle (and confirm-card reach) to a conversation they don't own.
2. **Bearer/agent token reaching the route (invariant 4 bypass).** The route is mounted under a token-parsing scope, or omits `requireSessionUser`, so an agent PAT drives a human-only surface and reads a conversation id.
3. **Id-as-oracle via response shape.** The endpoint distinguishes "no conversation" from "exists-but-not-yours" in a way that lets a caller infer another user's conversation existence (the same disclosure `loadOwnedConversation` avoids by 404-not-403). For `/recent` this manifests as: returning anything other than the caller's OWN id or null.

### Mitigations required

1. **Owner-scoping in the query, routed through one predicate.** `getMostRecentConversationId(db, userId)` selects `WHERE conversations.created_by = userId ORDER BY updated_at DESC LIMIT 1`, returning the `id` or `null`. The `created_by` predicate is the SAME owner-scoping decision `loadOwnedConversation` makes (M11) — code-checkable: the query MUST carry `eq(conversations.createdBy, userId)`. A Tier-A test asserts user A's `/recent` never returns user B's conversation even when B's is globally newest.
2. **Session-only mount + `requireSessionUser`.** The route is added to the EXISTING `conversationsRoute` Hono app (`apps/server/src/routes/conversations.ts`), which already runs `conversationsRoute.use('*', requireSessionUser)` and is mounted on the v1 scope where `attachToken` does NOT run (no bearer parsed). No new mount. Code-checkable: the handler reads `getUser(c)` (the session user), never a token. A Tier-A test asserts a bearer-only request to `/recent` is 401.
3. **Response is the caller's own id or null — never another user's, never an existence oracle.** The handler returns `{ id: <caller's newest> | null }`. Because the query is owner-scoped (mit 1), "null" means "the CALLER has none" — it cannot disclose whether some OTHER user has a conversation. No 403/404 branch needed (the route lists the caller's own resource); `{ id: null }` is the natural empty result. Code-checkable: the handler passes `user.id` (not a param, not a body value) to the service; there is no path where a request value selects the row.

### Out of scope (explicit deferrals)

- **A full conversation list / history switcher** — deferred (Stefan chose "most-recent, always"; the list endpoint was option 3, not taken). `/recent` returns one id, not a list. A future history UI can add `GET /conversations` then.
- **Pagination / cursor** — N/A; `LIMIT 1` by construction.
- **Resume-only-if-active predicate** — deliberately NOT built (Stefan: "most-recent, always"). A finished conversation reloading to its thread is intended.
- **Stolen-session-cookie defense** — OUT of scope; a valid session is the user (unchanged posture).
- **Rate-limiting `/recent`** — N/A; it's a cheap indexed `LIMIT 1` read, same cost class as the existing `GET /:id`.

### How to use this section

- Controller pre-flight (Step 2.5): confirm Task 1's query carries `eq(conversations.createdBy, userId)` and the route reads `getUser(c)` before dispatch — these are mitigations 1 and 2, code-checkable.
- `/code-review` / `/shakeout`: "Verify against the threat model. Mit 1 (owner predicate on `getMostRecentConversationId`), mit 2 (session-only — handler uses `getUser`, not a token), mit 3 (response is caller's own id or null, no request value selects the row). Report in-place / missing / out-of-scope per the deferrals list."
- `/evaluate`: list any missing mitigation as a plan-correction defect.
- Downstream: a future `GET /conversations` list inherits mit 1 (same owner predicate) and mit 2 (same session-only mount) — cross-reference, don't re-litigate.

---

## Architecture invariants touched

Cited per the harness 1b gate against `ARCHITECTURE-INVARIANTS.md`:

- **Invariant 4 (session-only auth / `requireResource`)** — the new route stays on the session-only `conversationsRoute`; no bearer path. The handler authorizes purely by `getUser(c)`.
- **M11 owner-scoping (the conversation owner convergence point, `loadOwnedConversation`)** — `getMostRecentConversationId` makes the SAME `created_by = userId` decision. It does not route through `loadOwnedConversation` itself (that loads a row BY id; `/recent` has no id — it FINDS the id), so it is a *second* site applying the M11 predicate. The threat model's mit 1 is the lockstep guarantee; the test pins it. Note this explicitly in the route comment so a future reader sees the two M11 sites.
- **Invariant 12 (irreversible-op confirm = clean pause)** — NOT modified, but this feature is what makes the clean-pause *reachable after reload*: restoring the conversation restores the rendered confirm card so the user can click "Yes, do it". No code change to the gate.

---

## Acceptance flows

> Per the 1g gate (`netdust-core:feature-acceptance`). One row per intended-use flow; Edges enumerate the six classes. Driven at `/shakeout` (Task 3 e2e is the UI-flow driver; the denied-actor + empty-state rows are driven through the un-mocked wire in the server route test).

| # | Flow | Steps | Expected | Edges |
|---|------|-------|----------|-------|
| 1 | **Resume newest on reload** | User has ≥1 conversation; opens the app fresh (cockpit mounts with no `conversationId`). | Cockpit fetches `/recent`, gets `{ id }`, `CockpitChat` mounts with that id, the thread renders (not the empty greeting). | **Empty/zero:** user has NO conversation → `{ id: null }` → cockpit shows the "How can the operator help?" greeting (current behavior, no regression). **Denied actor:** user A's reload never surfaces user B's conversation (mit 1; covered by the server test, not the e2e). **Wrong-order/re-entry:** `/recent` fires on every mount; if the user already created a conversation THIS session and reloads, the same id comes back (idempotent — newest is stable). **Concurrent/double:** two tabs mount → both fetch `/recent` → both get the same id → both render the same thread + share the dedicated SSE (no write, read-only, safe). **Boundary:** exactly one conversation → returned. Many → newest by `updated_at`. **Mid-flow failure:** `/recent` request fails (network/500) → cockpit falls back to the blank greeting (must NOT throw / blank-screen the panel); the user can still start a new chat. |
| 2 | **Resume a conversation paused on a confirm card** | User runs "set up a CRM", operator emits a `choice_card` + records a `pending_op`, turn ends clean (invariant 12). User reloads the page. | `/recent` returns that conversation's id; `CockpitChat` restores the thread INCLUDING the rendered confirm card; clicking "Yes, do it" still confirms the recorded `pending_op`. | **Empty/zero:** n/a (precondition is a paused conversation). **Denied actor:** another user can't reach this conversation's id (mit 1) or its `/click` confirm (existing M11 on the click route). **Wrong-order/re-entry:** reload twice → card still there (the `pending_op` row is durable until confirmed/expired). **Concurrent/double:** two tabs both show the card; the FIRST "Yes" confirms, the second sees the already-confirmed/expired op (existing pending-op single-use guard — NOT changed here). **Boundary:** card near `pending_op` expiry → if expired before reload, the click path already handles expired ops (existing). **Mid-flow failure:** `/recent` fails → blank greeting, but the `pending_op` is NOT lost (durable row); the user can re-open by sending a new message in a new conversation, OR (out of scope) a future history switcher. |

---

## File structure

- **Modify** `apps/server/src/services/conversations.ts` — add `getMostRecentConversationId(db, userId): Promise<string | null>`.
- **Modify** `apps/server/src/routes/conversations.ts` — add `GET /recent` handler (BEFORE the `GET /:id` handler so `recent` is not swallowed by the `:id` param).
- **Modify** `apps/server/src/routes/conversations.test.ts` — owner-scoping + session-only + empty tests.
- **Modify** `apps/web/src/lib/api/conversations.ts` — add `useRecentConversation()` hook.
- **Modify** `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx` — fetch recent on mount, pass id to `CockpitChat`.
- **Create** `apps/web/tests/e2e/cockpit-auto-resume.spec.ts` — the acceptance e2e (Task 3).

**Route-ordering gotcha (load-bearing):** Hono's RegExpRouter — `GET /:id` would match `/recent` as `id="recent"`. The existing `GET /:id` handler already special-cases a `.md` suffix on the same segment; adding a literal `/recent` route registered BEFORE `/:id` is the clean fix (Hono matches more-specific static segments first, but register order makes it unambiguous). Verify the existing route registration order in the file when implementing.

---

### Task 1: Server — `getMostRecentConversationId` + `GET /conversations/recent`

**Files:**
- Modify: `apps/server/src/services/conversations.ts` (add the helper near the other read helpers, ~after `getThreadSerialized`)
- Modify: `apps/server/src/routes/conversations.ts` (add `GET /recent` BEFORE `GET /:id`, ~line 330)
- Test: `apps/server/src/routes/conversations.test.ts`

- [ ] **Step 1: Write the failing test (owner-scoping + empty + session-only)**

Add to `apps/server/src/routes/conversations.test.ts`. Mirror the existing test setup in that file (it already has helpers to create a session + conversations — reuse them; read the top of the file first for the exact harness shape). The three behaviors:

```ts
describe('GET /conversations/recent', () => {
  test('returns the session user\'s most-recent conversation id', async () => {
    // user A creates two conversations; the SECOND (newer updated_at) wins.
    const a = await sessionFor(userA); // reuse the file's existing session helper
    const c1 = await createConvFor(userA); // older
    const c2 = await createConvFor(userA); // newer (created after c1)
    const res = await app.request('/api/v1/conversations/recent', { headers: a });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(c2.id);
  });

  test('does NOT return another user\'s conversation (M11 owner-scoping)', async () => {
    // user B has a GLOBALLY-newer conversation; user A has an older one.
    const aOld = await createConvFor(userA);
    await createConvFor(userB); // newest overall, but B's
    const a = await sessionFor(userA);
    const res = await app.request('/api/v1/conversations/recent', { headers: a });
    const body = await res.json();
    expect(body.data.id).toBe(aOld.id); // A's own, never B's
  });

  test('returns { id: null } when the user has no conversation', async () => {
    const fresh = await sessionFor(userWithNoConversations);
    const res = await app.request('/api/v1/conversations/recent', { headers: fresh });
    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBeNull();
  });

  test('rejects a bearer-only request 401 (session-only, invariant 4)', async () => {
    const res = await app.request('/api/v1/conversations/recent', {
      headers: { Authorization: `Bearer ${someAgentPat}` }, // no session cookie
    });
    expect(res.status).toBe(401);
  });
});
```

> NOTE to implementer: the exact session/conversation creation helpers + the agent-PAT fixture already exist in this test file (and its siblings). READ the file's existing `describe('POST /conversations')` setup first and reuse those helpers verbatim — do NOT invent new ones. If a bearer fixture isn't already in this file, the session-only assertion can reuse the pattern from a sibling route test that asserts `requireSessionUser` 401s.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/routes/conversations.test.ts`
Expected: FAIL — `404` (route not found) on the `/recent` requests, and the helper does not exist.

- [ ] **Step 3: Add the service helper**

In `apps/server/src/services/conversations.ts`, add (import `desc` from `drizzle-orm` if not already imported; `conversations` is already importable from the schema — check the file's existing imports):

```ts
/**
 * The session user's most-recent conversation id, or null if they have none.
 * Owner-scoped (M11): the `created_by = userId` predicate is the SAME
 * owner-scoping decision `loadOwnedConversation` makes — this is a SECOND M11
 * site (it FINDS the newest id rather than loading one BY id). Served by the
 * existing `conversations_user_idx (created_by, updated_at)` index. Used by
 * `GET /conversations/recent` for cockpit auto-resume.
 */
export async function getMostRecentConversationId(
  db: DB,
  userId: string,
): Promise<string | null> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.createdBy, userId),
    orderBy: desc(conversations.updatedAt),
    columns: { id: true },
  });
  return row?.id ?? null;
}
```

> Check the file's existing imports: it likely already imports `eq` from `drizzle-orm` and the `conversations` table + `DB` type. Add `desc` to the drizzle import if missing, and `conversations` to the schema import if the file doesn't already reference it.

- [ ] **Step 4: Add the route (BEFORE `GET /:id`)**

In `apps/server/src/routes/conversations.ts`, import the new helper into the existing `services/conversations.ts` import block, then register the route ABOVE the `conversationsRoute.get('/:id', ...)` handler (so `:id` cannot swallow `recent`):

```ts
// GET /conversations/recent — the session user's most-recent conversation id
// (or null), for cockpit auto-resume on reload. Owner-scoped via
// getMostRecentConversationId's `created_by` predicate (M11, threat-model mit 1);
// session-only via the route-wide requireSessionUser (invariant 4, mit 2). The
// response is the CALLER's own id or null — never another user's, so null is not
// an existence oracle (mit 3). Registered BEFORE GET /:id so the :id param does
// not match the literal `recent` segment.
conversationsRoute.get('/recent', async (c) => {
  const user = getUser(c);
  const id = await getMostRecentConversationId(db, user.id);
  return jsonOk(c, { id });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/server && bun test src/routes/conversations.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 6: Full server suite + typecheck**

Run: `cd apps/server && bun test` then `cd apps/server && bun x tsc --noEmit`
Expected: suite green (count = prior + 4), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/conversations.ts apps/server/src/routes/conversations.ts apps/server/src/routes/conversations.test.ts
git commit -m "feat: GET /conversations/recent — owner-scoped most-recent id for cockpit auto-resume"
```

---

### Task 2: Web — `useRecentConversation` + auto-resume wiring

**Files:**
- Modify: `apps/web/src/lib/api/conversations.ts` (add `useRecentConversation`)
- Modify: `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx` (fetch on mount, pass id)
- Test: vitest covers the hook indirectly; the real verification is Task 3 e2e (this is a Tier-B wiring task — no bespoke unit test, seam reach proven by e2e).

- [ ] **Step 1: Add the hook**

In `apps/web/src/lib/api/conversations.ts`, extend `conversationsKeys` and add the hook (mirror the existing `useConversation` shape at line 126):

```ts
export const conversationsKeys = {
  all: ['conversations'] as const,
  detail: (id: string) => [...conversationsKeys.all, id] as const,
  recent: () => [...conversationsKeys.all, 'recent'] as const,
};

/**
 * The session user's most-recent conversation id (or null), for cockpit
 * auto-resume on reload. One-shot fetch on mount; not live-tailed (the chosen
 * conversation is then live via useConversation's SSE). `staleTime: Infinity`
 * so a re-mount in the same session doesn't refetch — the cockpit only needs
 * the seed id once. Returns `loaded` so the panel can hold mounting CockpitChat
 * until the seed resolves (avoids a blank→thread flash).
 */
export function useRecentConversation(): { recentId: string | null; loaded: boolean } {
  const query = useQuery({
    queryKey: conversationsKeys.recent(),
    queryFn: () => client.get<{ id: string | null }>('/api/v1/conversations/recent'),
    staleTime: Infinity,
  });
  return { recentId: query.data?.id ?? null, loaded: !query.isLoading };
}
```

> Verify the exact `client.get` response-unwrap shape against the existing `useConversation` (line 133): if `client.get` already unwraps `{ data: ... }` to the inner object, then `query.data` is `{ id }` directly (as written). If it returns the envelope, adjust to `query.data?.data?.id`. Match the file's existing convention exactly — do NOT guess.

- [ ] **Step 2: Wire the panel to fetch on mount and pass the id**

In `apps/web/src/components/agent-panel/agent-cockpit-panel.tsx`, call the hook and pass `recentId` into `CockpitChat`. Hold the mount until `loaded` so the first paint isn't the empty state for a user who DOES have a conversation:

```tsx
export function AgentCockpitPanel() {
  const state: AgentPanelState = useSyncExternalStore(agentPanelBus.subscribe, agentPanelBus.get);
  const { recentId, loaded } = useRecentConversation();
  if (!state.open) return null;
  return (
    <div className="flex w-[360px] shrink-0 flex-col rounded-md border border-border-light bg-content">
      <div className="flex items-center gap-2 border-b border-border-light px-3 py-2.5">
        <strong className="flex-1 truncate text-fg">Operator</strong>
        <button
          type="button"
          aria-label="Close"
          onClick={() => agentPanelBus.close()}
          className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
        >
          <Icon icon={X} size={16} />
        </button>
      </div>
      {/* Hold the chat body until the recent-id seed resolves so a user WITH a
          conversation never flashes the empty greeting first (acceptance flow 1,
          wrong-order edge). `key` forces a fresh CockpitChat once the seed lands
          so its internal activeId useState picks up the resumed id. */}
      {loaded ? (
        <CockpitChat key={recentId ?? 'new'} conversationId={recentId ?? undefined} />
      ) : (
        <div className="min-h-0 flex-1" aria-hidden="true" />
      )}
    </div>
  );
}
```

> Import `useRecentConversation` from `'../../lib/api/conversations.ts'`. The `key={recentId ?? 'new'}` is load-bearing: `CockpitChat` seeds `activeId` from `conversationId` ONCE in `useState` (line 31), so it must remount when the seed transitions from `loading`→`resolved`. Without the key, the chat would stay on its initial `undefined` activeId.

- [ ] **Step 3: Run the web suite + typecheck**

Run: `cd apps/web && npx vitest run` then `cd apps/web && bun x tsc --noEmit`
Expected: suite green (no count change — this is a Tier-B wiring task), tsc clean. If any existing `agent-cockpit-panel` test renders the panel without a QueryClient/route context, the new `useQuery` may need the test's existing provider wrapper — adjust the test's wrapper, do NOT remove the hook.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api/conversations.ts apps/web/src/components/agent-panel/agent-cockpit-panel.tsx
git commit -m "feat: cockpit auto-resumes the most-recent conversation on mount"
```

---

### Task 3: E2E acceptance — drive auto-resume through the real browser

**Files:**
- Create: `apps/web/tests/e2e/cockpit-auto-resume.spec.ts`

> This is the 1g acceptance-flow driver for flow 1 (resume newest on reload) + its empty-state edge. Flow 2's confirm-card reload is best driven against a real BYOK key (a shakeout/manual step, not a deterministic e2e — note it in the shake-out manifest); the e2e proves the RESUME wiring deterministically without needing a live model.

- [ ] **Step 1: Write the e2e**

Read an existing spec in `apps/web/tests/e2e/` (e.g. `hardening-pass.spec.ts`) for the exact login/setup helpers, base URL, and selectors. Then:

```ts
import { test, expect } from '@playwright/test';
// reuse the file-local login/seed helpers from a sibling spec

test('cockpit auto-resumes the most-recent conversation on reload', async ({ page }) => {
  await loginAsSeededUser(page); // reuse sibling helper
  // Open the cockpit; send a message to CREATE a conversation.
  await openCockpit(page); // reuse / inline: ensure the Operator panel is open
  const composer = page.getByPlaceholder(/message|ask|operator/i).first();
  await composer.fill('hello operator');
  await composer.press('Enter');
  // The user message should appear in the thread (optimistic or live).
  await expect(page.getByText('hello operator')).toBeVisible();

  // RELOAD — the blank-on-reload bug would show the empty greeting here.
  await page.reload();
  await openCockpit(page);

  // The thread is RESTORED: the prior message is visible, not the greeting.
  await expect(page.getByText('hello operator')).toBeVisible();
  await expect(page.getByText('How can the operator help?')).toHaveCount(0);
});

test('cockpit shows the empty greeting for a user with no conversation', async ({ page }) => {
  await loginAsFreshUser(page); // a user/seed with zero conversations
  await openCockpit(page);
  await expect(page.getByText('How can the operator help?')).toBeVisible();
});
```

> The exact selectors (composer placeholder, the "Operator" panel open affordance, the greeting text "How can the operator help?") are pinned in the source: greeting copy is in `cockpit-chat.tsx:99`, the panel title "Operator" in `agent-cockpit-panel.tsx`. Match them. If opening the cockpit needs a click (it's default-open but respects last-closed via `agentPanelBus`), reuse whatever a sibling spec does or assert it's already open.

- [ ] **Step 2: Run the e2e**

Run: `cd apps/web && npx playwright test cockpit-auto-resume.spec.ts`
Expected: both tests PASS. (If the dev server / Playwright base config needs the server running, follow the sibling specs' setup — they already encode it.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/cockpit-auto-resume.spec.ts
git commit -m "test(e2e): cockpit auto-resume — restore newest conversation on reload + empty-state"
```

---

## ── REVIEW GATE ── (cluster: Tasks 1–3)

STOP here. This is the single review cluster (3 tasks ≤ 4, per harness 1f). Before finishing:

1. `/integration` on the cluster diff (server + web + shared typecheck, e2e).
2. `/code-review` on the diff — convergence target = the `## Threat model` mitigations (1: owner predicate on `getMostRecentConversationId`; 2: session-only `getUser`, no token; 3: caller's-own-id-or-null) + the architecture invariants cited (4, M11, 12).
3. Because the surface touches an auth/session boundary, also run `/security-review` on the diff.

Do not finish the branch until the cluster review is clear.

---

## Stage 3 — shake-out + finish (controller, after the gate clears)

1. `/integration` (re-run).
2. `netdust-core:test-effectiveness` over the diff — for the M11 owner-scoping test, confirm it goes RED if the `created_by` predicate is removed (mutation-prove mit 1 bites). For the session-only test, confirm it bites if `requireSessionUser` were bypassed.
3. `netdust-core:feature-acceptance` — drive acceptance flow 1 (+ empty edge) via the Task-3 e2e; flow 2 (confirm-card reload) noted as a real-BYOK manual shakeout item.
4. `/shakeout`.
5. `superpowers:finishing-a-development-branch`.

---

## Self-review (writing-plans checklist)

- **Spec coverage:** endpoint (Task 1) + web wiring (Task 2) + acceptance (Task 3) cover the handoff's "needs (1) a server endpoint and (2) web auto-load." The already-fixed confirm-gate half is explicitly out of scope with evidence. ✓
- **Placeholder scan:** no TBDs; every code step has concrete code; the two "verify the existing convention" notes (client.get unwrap shape, test harness helpers) are ground-truth instructions to the implementer, not placeholders. ✓
- **Type consistency:** `getMostRecentConversationId(db, userId): Promise<string|null>` returns `{ id }`; the route returns `jsonOk(c, { id })`; the hook reads `{ id }`; `conversationsKeys.recent()` is used in both the key and the hook. Consistent. ✓
