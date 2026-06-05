# Shake-out manifest — operator cockpit-chat (`spec/operator-cockpit-chat`)

Date: 2026-06-05. Swept the built artifact end-to-end against a FRESH-migrated DB
(server on :3939, owner-registered, ws/project/conversations created, real HTTP).

## Verified WORKING end-to-end (Track A — automated, real HTTP)

- **Smoke**: server boots clean against the fresh 32-migration schema; `/auth/me`
  unauth → clean **401** (no 500 — the prior migration-brick regression is absent).
- **Conversation API**: create → 201; seed GET → 200 (`{activeRunId, messages}`);
  `.md` export → 200.
- **#3 createdAt wire-type FIX HOLDS on the real wire** — a `number`
  (`1780695472000`, typeof number) in BOTH the seed AND the SSE frame.
- **#2 user message published FIX HOLDS** — the user row arrives as a live SSE
  `message` frame (one-sided-tail bug gone); operator rows stream too.
- **SSE live-tail** (shared `runSseLoop`, #9): `event: message` + `id:` + valid
  JSON delivered on post; owner-gate-before-subscribe works.
- **M11 owner-scoping**: a foreign user gets **404** (not 403) on the
  conversation, the `.md` export, AND the stream — all three surfaces.
- **Graceful BYOK-not-configured failure**: a run with no AI key writes a
  human-readable operator message into the thread ("No AI key is configured…
  Ask an instance admin to add one in Settings → AI") — no crash, slot released
  (`activeRunId: null`), conversation not wedged (T8 release path works).
- **seq integrity**: back-to-back turns allocate clean monotonic seq (1,2,3,4),
  no dup/gap; slot acquired+released each turn.
- **Error handling**: empty/missing-field body → 400 ZodError; click
  non-existent component → 404; unauthenticated create → 401; server stays
  alive after a barrage of bad input.

## Bugs found

### CRITICAL (0)
_None._

### IMPORTANT (0)
_None in the cockpit-chat changeset._

### MINOR / DEFERRED (2)

- **M-1 (PRE-EXISTING, out of scope): malformed-JSON body → 500, not 400.**
  Posting unparseable JSON (`-d 'not json'`) returns `{error:{code:INTERNAL}}`
  500. Verified GLOBAL (same on `/workspaces` and `/auth/register`, not just
  cockpit routes) → a Hono body-parser / error-handler gap that PRE-DATES this
  branch. NOT a cockpit regression; logging for a future global fix. Defer.

- **M-2 (ENVIRONMENT, not a code bug): the dev `folio.db` is on a divergent
  stale chain** (33 migrations applied vs 32 on disk; `ai_keys` lacks the
  `ai_key_label`/new shape). A local-data artifact from earlier sessions, NOT a
  branch defect — the fresh migration chain applies cleanly (proven: swept
  against a fresh DB). The dev DB should be re-migrated/reset before local use.
  Defer (local hygiene).

### NOT-A-BUG (investigated, resolved during sweep)

- **M14 double-send via concurrent HTTP returned two 200s** — NOT a CAS
  violation. With no AI key each run fails in ~1ms and releases the slot, so the
  two posts SERIALIZED (clean seq 1-2 then 3-4) rather than overlapping the held
  window — 409 never triggers because the window never overlaps. The true
  concurrent-409 path is covered by the unit test (`conversations.test.ts` M14,
  mocked slow runner). Not exercisable via HTTP without a slow/real run.

## Track B — manual checks for the human (model-dependent; the real-key gate)

The keystone real-BYOK flow CANNOT run autonomously (no Ollama up, no Anthropic
key in env) — consistent with every prior phase deferring real-key runs. With a
key configured (Settings → AI), verify in the browser:

1. [ ] Open a workspace → the cockpit panel is OPEN by default; close it →
       reload → it stays closed (respect-last-closed).
2. [ ] Type "set up a CRM project" → the operator acts; **tool_step** rows
       stream live into the thread as it works.
3. [ ] The operator emits a **link_panel** for a created work_item → clicking it
       opens that work item in the main area BESIDE the still-open chat
       (`?doc=` project route; the server-derive #1 fix — confirm it resolves,
       not a dead link).
4. [ ] The operator emits an **ask_choice** card → clicking an option sends the
       option id and locks the card.
5. [ ] Ask for a **destructive op** (e.g. "delete that project") → the operator
       PROPOSES via a choice card and the op REFUSES until confirmed (M4–M7);
       confirm → it executes the recorded params.
6. [ ] A second browser tab on the same conversation sees BOTH your messages and
       the operator's stream (two-sided live-tail).
