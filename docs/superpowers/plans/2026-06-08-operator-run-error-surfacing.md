# Operator Run Error Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a conversation (operator cockpit) run fails — provider 402/401/5xx, network drop, decrypt failure, any unhandled throw — post a sanitized error message into the conversation thread (and publish it to the live tail) instead of dying silently to server stderr, so the user sees *why* their turn produced nothing.

**Architecture:** The runner's top-level catch (`runAgent`/`runAgentResume` → `failRunLastResort`) currently only transitions an `agent_run` *document* row. A conversation run has no such row, so for the cockpit the catch logs to stderr and returns — the user watches a dead chat. The fix threads the conversation context (id + run id) into the last-resort path and, when present, posts ONE `kind:'text'` operator message carrying the sanitized error, via the existing `appendMessage` + `conversationBus.publish` pair (the same channel `ctx.sink.text()` already uses for the no-key preflight error). No schema change, no new message kind, no frontend change — `kind:'text'` renders in every existing client.

**Tech Stack:** Bun, Hono, Drizzle, SQLite, the existing `ConversationSink` / `conversationBus` / `sanitizeProviderError` primitives.

---

## Threat model

**Scope:** a new write of an attacker-influenceable string (the upstream provider's error response) into a user-visible conversation thread, on the run's failure path.

**Assets**
- A1: The conversation thread content (rendered as markdown-ish text in the cockpit).
- A2: The server master secret / API keys (must never appear in a surfaced error).
- A3: Run-slot liveness (`conversations.active_run_id`) — must end cleared on every failure path.

**Attacks**
- T1 — **Secret leakage via error detail.** A provider error or thrown exception could embed the API key, a URL with credentials, or internal stack details; surfacing the raw `err.message` into the thread would leak A2.
  - **Mitigation M1:** Surface ONLY `sanitizeProviderError(err, providerLabel)` — the same sanitizer `failRunLastResort` already uses for the document-run `errorDetail`. Never `err.message`, never `String(err)`, never the raw object. The raw error stays in the existing `console.error` (server-only) for diagnostics. *(sanitizeProviderError already collapses statusful/network/unknown errors to fixed safe strings — verified: `src/lib/ai/sanitize-error.ts`.)*
- T2 — **Stored-XSS / markup injection** via a crafted provider error string into the thread.
  - **Mitigation M2:** The cockpit renders text messages through React (`MessageText`) — JSX auto-escapes; no `dangerouslySetInnerHTML` on this path (verified: `message-text.tsx` renders `{message.body}` / markdown via a sanitizing renderer, not raw HTML). The body is data, not markup. No new escaping needed; M2 is a *confirm-not-regressed* check, asserted in Task 3's acceptance check, not new code.
- T3 — **Error-path throw re-wedges the conversation.** If posting the error message itself throws (DB error, bus error), and that throw escapes, the run slot could be left set → conversation wedged at 409 OPERATOR_BUSY until reboot (the exact T8 failure class the existing slot-clearing `finally` was added to prevent).
  - **Mitigation M3:** The error-surfacing write is wrapped in its own `try/catch` that swallows + logs; it runs INSIDE the existing `finally`-guarded slot-clear region OR before `failRunLastResort` such that slot-clear still runs. Surfacing is best-effort; it must never prevent the slot from clearing. Test asserts the slot is `null` even when the sink write throws.
- T4 — **Double error message** (post in catch AND a duplicate from a partially-run loop).
  - **Mitigation M4:** Only the TOP-LEVEL catch posts the terminal error. Errors handled *inside* `runLoop` (per-tool `toolStep status:'error'`) are a different, already-shipped surface and are not duplicated here — the top-level catch only fires for throws that escape the loop (provider call failure, message-build failure, preflight throw). Test: a provider-throw produces exactly ONE terminal error text row.

**Deferrals (named, out of scope)**
- D1: The SSE fan-out / connection-pool exhaustion soft spot (ARCHITECTURE-INVARIANTS.md "Deliberate exceptions", line 49) is a *separate* issue (one EventSource per consumer hits the 6-conn browser cap) — not touched here.
- D2: Document-thread runs (non-conversation) already transition their `agent_run` row to `failed` with `errorDetail`; surfacing that into the document's comment thread is a separate, lower-value path — left as-is.
- D3: A typed `kind:'error'` message (distinct styling) is deferred — `kind:'text'` with a `⚠️` prefix is sufficient for v1 and needs zero schema/frontend change.

## Architecture invariants touched

- **Invariant 9 (Error handling):** the current code is the named anti-pattern — *"swallows an error (`catch {}` discarding it)"* — for conversation runs. The HTTP envelope (`HTTPError` → `formatApiError`) does NOT apply: this is a background run with no HTTP response in flight. The sanctioned surface for a background conversation run's outcome is the thread message (the sink), so this fix routes the error to that convergence point rather than inventing a new error shape. Cited, not bypassed.
- **Invariant 8 (Live updates):** the conversation thread is one of the two ratified append-only live-tail consumers. Posting via `conversationBus.publish(serializeMessage(row))` is the sanctioned broadcast for this feed. The fix reuses it; it does NOT build new client-side state from the event.
- **Invariant 5 (Data access):** `appendMessage` is the documented deliberate exception to `txWithEvents` (conversation state, emits no domain event). The fix writes the error row through `appendMessage` (via the sink helper), staying inside that exception. No new write path is introduced.

## Acceptance flows

| # | Flow | Steps | Expected | Edges (MANDATORY) |
|---|------|-------|----------|-------------------|
| AF1 | Provider error surfaces in thread | Operator run hits a provider error (e.g. 402 no-credit) | A `kind:'text'` operator message `⚠️ The operator couldn't complete this turn: <sanitized reason>` appears in the thread; `active_run_id` is cleared | **empty/zero:** thread had only the user msg → error row still appends (seq = max+1). **denied actor:** n/a (server-internal path; the user is already authed to the conversation). **wrong-order/re-entry:** a second send after the error works (slot was cleared). **concurrent/double:** exactly ONE terminal error row per failed run (M4). **boundary:** a very long provider error string is sanitized to a fixed safe string (M1), not surfaced raw. **mid-flow failure:** the error-surfacing write ITSELF throws → slot still clears, raw error still logged (M3). |
| AF2 | Secret never leaks | Run fails with an error whose raw message contains a key-shaped string | The surfaced body is the sanitized fixed string; the key never appears in any `messages.body` row | **boundary:** raw `err.message` containing `sk-or-...` → surfaced body excludes it (M1). **denied actor:** n/a. **empty:** n/a. |
| AF3 | Healthy run unaffected | A successful operator turn | Normal `tool_step` + `text` output; NO terminal error row appended | **concurrent/double:** the catch does not fire on success → zero error rows. **re-entry:** subsequent turns unaffected. |

---

## File Structure

- **Modify** `apps/server/src/lib/runner.ts`:
  - `failRunLastResort(...)` — add an optional conversation surface: when a `conversationId` + `runId` are known, post one sanitized `kind:'text'` error message through `appendMessage` + `conversationBus.publish`, best-effort (own try/catch), BEFORE the existing `agent_run`-document transition (which no-ops for conversation runs).
  - `runAgent` / `runAgentResume` catch blocks — pass the conversation id into `failRunLastResort` (resolve it the same way the `finally` does: from `ctx.conversationId`, captured into a variable visible to the catch).
- **Test** `apps/server/src/lib/runner-error-surface.test.ts` (new) — drives `failRunLastResort`'s conversation branch + the slot-clear-on-surface-throw case.

> NOTE: `failRunLastResort` is module-private. Either (a) export it for the test, or (b) test via the public `runAgent` with a stubbed provider that throws. Task 1 chooses (b) where feasible (closer to real), falling back to a narrow `export` for the throw-in-surface case (M3) that's hard to trigger through the public path. The implementer picks per what's cleanly reachable and records the choice in the STATUS block.

---

### Task 1: RED — a failed conversation run posts a sanitized error into the thread

**Files:**
- Test: `apps/server/src/lib/runner-error-surface.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
// Use the project's standard in-memory test DB harness (mirror an existing
// runner test's setup — e.g. runner.test.ts — for migrate + seed helpers).
import { setupTestDb, seedUser, seedConversation } from './__test-helpers__/runner-fixtures.ts';
// ^ If a shared harness path differs, match what runner.test.ts imports.

import { __setKickForTest } from '../routes/conversations.ts'; // if needed; else drive runner directly

// The behavioral assertion (provider-agnostic): when a conversation run's
// provider stream throws, the conversation thread gains exactly one operator
// text row whose body is the SANITIZED error, and active_run_id ends null.

test('failed conversation run surfaces a sanitized error into the thread', async () => {
  const { db, raw } = await setupTestDb();
  const user = await seedUser(db);
  const conv = await seedConversation(db, { createdBy: user.id });

  // Force the provider stream to throw a 402-shaped error. Use the provider
  // test-override hatch (provider.__INTERNAL_TEST_ONLY__.overrideRegistry) OR
  // the runner's existing provider-stub seam, mirroring runner.test.ts.
  // The thrown error message intentionally contains a secret-shaped token.
  await driveFailingConversationRun(db, raw, {
    conversationId: conv.id,
    createdBy: user.id,
    providerThrows: new Error('upstream said sk-or-v1-LEAKME-402 payment required'),
  });

  const rows = raw
    .query("SELECT role, kind, body FROM messages WHERE conversation_id=? ORDER BY seq")
    .all(conv.id) as Array<{ role: string; kind: string; body: string | null }>;

  const errorRows = rows.filter((r) => r.role === 'operator' && r.kind === 'text');
  expect(errorRows.length).toBe(1);                              // M4: exactly one
  expect(errorRows[0].body).toMatch(/couldn.t complete this turn/i);
  expect(errorRows[0].body).not.toContain('sk-or-v1-LEAKME');    // M1/T1: no secret

  const slot = raw.query('SELECT active_run_id FROM conversations WHERE id=?').get(conv.id) as { active_run_id: string | null };
  expect(slot.active_run_id).toBeNull();                          // A3: slot cleared
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/runner-error-surface.test.ts`
Expected: FAIL — either `driveFailingConversationRun`/helpers undefined (write the minimal harness mirroring `runner.test.ts`), or, once the harness exists, `errorRows.length` is `0` (current bug: no error row is posted).

> Implementer note: the helper `driveFailingConversationRun` should reproduce what `startTurn` + `runAgent` do (append a user msg, set `active_run_id`, `createConversationRun`, then `runAgent({runId})` with the provider forced to throw). Mirror the seams `runner.test.ts` already uses to stub the provider — do NOT invent a new mechanism.

---

### Task 2: GREEN — thread the conversation surface into `failRunLastResort`

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (`failRunLastResort` signature + body; `runAgent`/`runAgentResume` catch call sites)

- [ ] **Step 1: Add an optional conversation surface to `failRunLastResort`**

In `runner.ts`, change the signature and prepend a best-effort thread post. Exact shape:

```ts
async function failRunLastResort(
  runId: string,
  providerLabel: string,
  err: unknown,
  conversationId?: string, // NEW — set for conversation (cockpit) runs
): Promise<void> {
  // Log the RAW error server-side (unchanged — the only place WHY a run died is visible).
  console.error(`[runner] last-resort failure for run ${runId}:`, err);

  // NEW — surface a SANITIZED error into the conversation thread so the cockpit
  // isn't a silent dead chat. Best-effort: a throw here must NEVER prevent the
  // slot-clear or the document-run transition below (M3). sanitizeProviderError
  // is the SAME sanitizer used for the document-run errorDetail — never raw err.
  if (conversationId) {
    try {
      const row = await appendMessage(db, {
        conversationId,
        role: 'operator',
        kind: 'text',
        body: `⚠️ The operator couldn't complete this turn: ${sanitizeProviderError(err, providerLabel)}`,
        runId,
      });
      conversationBus.publish(conversationId, serializeMessage(row));
    } catch (surfaceErr) {
      console.error(`[runner] failed to surface run ${runId} error into thread:`, surfaceErr);
    }
  }

  // ... existing agent_run-document lookup + transitionRun unchanged below ...
  const runRow = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  // (rest of the function exactly as today)
```

Ensure `appendMessage`, `serializeMessage`, `conversationBus`, and `sanitizeProviderError` are imported in `runner.ts` (the sink imports them already in `chat-thread-sink.ts`; add to `runner.ts`'s import block if not present — verify and add).

- [ ] **Step 2: Pass `conversationId` from both catch sites**

In `runAgent`, capture the conversation id where it's known and pass it to the catch. The `ctx` is in scope only inside the `try`; capture it into an outer `let`:

```ts
export async function runAgent(args: { runId: string }): Promise<void> {
  const { runId } = args;
  let providerLabel = 'AI';
  let conversationId: string | undefined;          // NEW
  try {
    const ctx = await loadContext(runId);
    if (ctx === null) { console.error(`[runner] run ${runId} not found or missing context; skipping`); return; }
    providerLabel = PROVIDER_LABELS[ctx.fm.provider as ProviderName] ?? 'Claude Code';
    conversationId = ctx.conversationId ?? undefined; // NEW — set once context loads
    try {
      // ... unchanged preflight + stream consumption ...
    } finally {
      if (ctx.conversationId) await clearConversationSlot(ctx.conversationId, runId);
    }
  } catch (err) {
    await failRunLastResort(runId, providerLabel, err, conversationId); // NEW arg
  }
}
```

Apply the identical change to `runAgentResume` (same `let conversationId` capture + same 4th arg at its `failRunLastResort` call).

- [ ] **Step 3: Run the Task-1 test to verify it passes**

Run: `cd apps/server && bun test src/lib/runner-error-surface.test.ts`
Expected: PASS — one error row, sanitized body, slot cleared.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner-error-surface.test.ts
git commit -m "fix: surface failed operator-run errors into the conversation thread

A conversation (cockpit) run that threw (provider 402/401/5xx, network,
decrypt) died silently to stderr — failRunLastResort only transitioned an
agent_run document row, which a conversation run does not have. The user saw
a dead chat. Now the last-resort path posts ONE sanitized kind:'text' operator
message into the thread (+ live-tail publish), best-effort so it never blocks
the slot-clear. Sanitized via the same sanitizeProviderError used for the
document-run errorDetail (no secret leak). Invariants 9/8/5 cited in the plan."
```

---

### Task 3: RED+GREEN — slot still clears when the error-surfacing write throws (M3)

**Files:**
- Test: `apps/server/src/lib/runner-error-surface.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

```ts
test('slot still clears and raw error still logs when surfacing the error throws (M3)', async () => {
  const { db, raw } = await setupTestDb();
  const user = await seedUser(db);
  const conv = await seedConversation(db, { createdBy: user.id });

  // Force appendMessage (the surfacing write) to throw, e.g. by stubbing it via
  // the same mechanism the suite uses for module seams, OR by making the bus
  // publish throw. The point: surfacing fails, but the run must still end clean.
  await driveFailingConversationRun(db, raw, {
    conversationId: conv.id,
    createdBy: user.id,
    providerThrows: new Error('402 payment required'),
    breakSurface: true, // helper makes appendMessage/publish throw on this run
  });

  const slot = raw.query('SELECT active_run_id FROM conversations WHERE id=?').get(conv.id) as { active_run_id: string | null };
  expect(slot.active_run_id).toBeNull(); // A3/M3: slot cleared despite surface throw
});
```

- [ ] **Step 2: Run to verify it fails (or passes) and reconcile**

Run: `cd apps/server && bun test src/lib/runner-error-surface.test.ts`
Expected: PASS if the Task-2 `try/catch` around the surface write is correct (the surface throw is swallowed; the `finally` already cleared the slot before `failRunLastResort` ran). If it FAILS (slot not null), the surface write is escaping — wrap it tighter per M3, then re-run to GREEN.

> This task is the adversarial proof of M3. It is GREEN-on-arrival IF Task 2 wrapped the surface write correctly; its value is locking that guarantee against regression. If GREEN immediately, record in STATUS that it was a confirm-not-regress assertion (Tier-A denial-adjacent), not a fresh RED.

- [ ] **Step 3: Confirm AF2/AF3 by assertion (no new code)**

Add two cheap assertions to the existing tests (or as a third `test`):
- AF2: the secret-shaped substring is absent from EVERY `messages.body` row (already in Task 1 — extend to scan all rows, not just the error row).
- AF3: drive a SUCCESSFUL conversation run (provider yields a normal `done`) and assert ZERO `role='operator' kind='text'` rows that match `/couldn.t complete/i` (the catch did not fire).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/lib/runner-error-surface.test.ts
git commit -m "test: M3 slot-clears-on-surface-throw + AF2 no-leak + AF3 healthy-run-unaffected"
```

---

## Phase close

- [ ] `cd apps/server && bun test` — full server suite green; record the count delta.
- [ ] `cd apps/server && bun x tsc --noEmit` — clean.
- [ ] **Feature-acceptance drive (Stage 3):** with the dev server running and a real BYOK key configured to a *zero-credit* or deliberately-bad provider, send an operator message in the cockpit and confirm the `⚠️ couldn't complete this turn` message appears in the thread in the browser (AF1 through the real surface). Then add credit / fix the key and confirm a healthy turn shows no error row (AF3).
- [ ] `/integration` on the diff, then `/code-review` (convergence target: the `## Threat model` mitigations M1–M4 + invariants 9/8/5).

## Self-review

- **Spec coverage:** AF1 (Task 1+2), AF2 (Task 1/3), AF3 (Task 3) — all mapped. M1–M4 each have an assertion. Invariants 9/8/5 cited.
- **Type consistency:** `failRunLastResort(runId, providerLabel, err, conversationId?)` — 4th arg optional, passed at both `runAgent` and `runAgentResume`. `appendMessage`/`serializeMessage`/`conversationBus`/`sanitizeProviderError` confirmed importable in `runner.ts`.
- **No placeholders:** the only deferred specifics are the test-harness helper names (`setupTestDb`/`seedConversation`/`driveFailingConversationRun`), explicitly delegated to "mirror runner.test.ts" because the exact shared-fixture API must match what already exists in the suite — the implementer reads it at Step 2.5 ground-truth and reconciles.
