# Folio — Hardening Pass ("no loose ends") — Design

> **Status:** approved design, ready for `writing-plans`. Authored 2026-06-07.
> **Goal (Stefan's words):** "harden the app, no loose ends, no dead code, no 'it's not
> wired' stuff, good UX" — then move to Track A (Content Studio). This pass is the
> *secure + honest + board-usable* floor that must hold before Track A starts.
>
> **Grounded against `main` on 2026-06-07**, AFTER the operator-identity-cleanup session
> merged (`3befd2f`, findings #7/#8: `EphemeralToken` + `isOperator` marker, `agentId null`,
> `eventActor` required, invariant checker committed `a853a2c`). Two design items shrank as a
> result — see §1 and §3. This supersedes the abstract "loose ends" list with a verified scope.
>
> Sibling docs: `folio-flow-roadmap.md` (the 2026-06-07 flow roadmap this pass hardens toward),
> `2026-06-06-folio-focus-roadmap.md` (the prior state-machine-first roadmap, superseded on the
> central question — see "How this reconciles the two roadmaps" below), `ARCHITECTURE-INVARIANTS.md`.

---

## 0. How this reconciles the two roadmaps (why we harden, not build a state machine)

Two roadmaps disagreed on what to do next. Ground-truthing both against source (8 verified claim
clusters, 2026-06-07) settled it:

- **Yesterday's `focus-roadmap` (06-06)** said *build the work-item state machine first* (the
  "differentiator"). **Today's `flow-roadmap` (06-07)** said *don't — harden the engine, pick one
  flow, get a real user.* The flow-roadmap is the more accurate read of the code and the right
  frame for "move toward a functional app to use."
- **Verified nuance that corrected BOTH:** a status *transition guard* genuinely does not exist
  (a card jumps any→any, validated only for registry membership — `documents.ts:341`). Triggers
  can *react* to changes but cannot today cleanly target "status changed to X" (no `status.changed`
  event; `matchesFilter` can't array-contain — verified). So the state machine is a real *future*
  gap, but not what "usable now" needs. **This pass deliberately does NOT build it** (per the
  flow-roadmap's "Explicitly NOT now"). It hardens what exists so Track A can start on a clean base.

This pass = the flow-roadmap's §1 hardening, re-scoped to Stefan's stricter "no loose ends" bar
(which pulled in the parked/half-wired UX the security-only list omitted).

---

## 1. Token lifecycle — add + enforce expiry  *(security; SHRANK after re-ground-truth)*

**What's already there (verified — do NOT rebuild):** `api_tokens` already has `last_used_at`,
and it is **stamped on every bearer validation** (`middleware/bearer.ts:39`, best-effort,
non-blocking). Create / list / revoke all exist. The operator runs on an in-memory
`EphemeralToken = ApiToken & { isOperator?: true }` (`schema.ts:633`) that never hits the DB token
lookup.

**The one real gap:** there is **no `expires_at`** — every minted token lives forever.
`ARCHITECTURE-INVARIANTS.md` (gaps section) records the broader MCP-credential lifecycle as a
deliberate WATCH-ITEM (no rotation handshake / per-session narrowing / revocation-on-use). This
pass closes the **TTL half** of that watch-item and leaves the rotation-handshake half deferred,
as the doc intends.

### Scope

1. **Schema** — add `expires_at: integer (timestamp_ms, nullable)` to `api_tokens`. `null` = no
   expiry → **existing tokens are grandfathered** (no forced migration, no lockout).
2. **Enforcement — at the single convergence point** (`middleware/bearer.ts attachToken`, the only
   per-request token resolver, invariant 1): after lookup, before `attachToken`, if
   `expires_at != null && expires_at < now` → **401, identical shape to an invalid/unknown token**
   (no oracle: an attacker can't distinguish "expired" from "never existed").
   - The in-memory operator `EphemeralToken` path does **not** go through this DB-lookup branch —
     confirm the expiry check sits on the persisted-token branch only, so the operator is unaffected.
3. **Coarse `last_used_at`** — today it writes on *every* request (write-per-request amplification).
   Change to write only when `last_used_at` is null or older than ~60s ("last seen, roughly").
   Kills the hot-path write without losing the signal.
4. **Mint** (`token-reach.ts mintToken` + `routes/tokens.ts` + `routes/instance-tokens.ts`) —
   accept an optional `expires_in_days` (or `expires_at`) in the create body (Zod). Omitting it =
   forever-token (unchanged default). Compute + store `expires_at`.
5. **Rotation = revoke + mint** — no new server primitive. The UI "Rotate" action revokes the old
   token and mints a successor (same scopes/reach/expiry), surfacing the new secret once.
6. **Web** — token list (per-workspace API tab + instance tokens on Settings) shows expiry +
   last-used; create dialog gets an optional expiry field; "Rotate" button.
7. **Doc** — amend the `ARCHITECTURE-INVARIANTS.md` MCP-credential watch-item: TTL/expiry now
   CLOSED; only rotation-handshake / revocation-on-use remain deferred.

### Threat model (fired — token surface) — embed full version in the plan
- **Asset:** the bearer credential.
- **Attacks → mitigations:**
  - Expired token still accepted → enforced at the one bearer check, fail-closed.
  - Expiry used as an existence oracle → expired returns the *same* 401 as invalid.
  - `last_used_at` write amplification as cheap DoS → coarse 60s stamping.
  - Expiry check accidentally gates the operator's `EphemeralToken` → check lives on the
    persisted-token branch only; operator path unaffected (asserted by test).
- **Deferred (explicit):** rotation handshake, per-session narrowing, revocation-on-use — remain
  the documented watch-item.

### Tests (Tier A — auth/security)
RED-first: expired-token→401; expired-shape == invalid-shape; mint-with-expiry stores it;
coarse-stamp writes once then skips within 60s; operator `EphemeralToken` still authorizes (denial
+ positive control).

---

## 2. AI slash commands `/draft` `/decompose` `/summarize` — make them real  *(honesty)*

**The gap:** `slash-registry.ts:46-72` renders all three (gated on `aiConfigured`) but each
`onSelect` just toasts *"Phase 3 wires this up."* CLAUDE.md lists them as the v1 slash-command set.
A shown-but-inert feature is the headline "it's not wired" loose end — and these are Track A's
bread and butter (draft / improve content), so wiring them now also pre-pays Track A.

### Scope — one endpoint, not three; one-shot, read-only
- **Server:** one new `POST /api/v1/w/:wslug/ai/complete` on the existing `routes/ai.ts` group,
  **session-auth**, gated on `ai_configured`.
  - Body (Zod): `{ action: 'draft'|'summarize'|'decompose', document_id, selection?, instruction? }`.
  - Resolves the instance AI key by `(provider, label)` the same way the runner does — **the key is
    injected into the provider call only; never returned, never in the response**.
  - Builds a per-action prompt, calls `ai/provider.ts` (already streams; we consume it server-side
    and return the full text — **one-shot**, not streamed to the client), returns `{ text }`.
  - **NOT an agent run:** no run document, no tools, no event, no approval machinery. This is
    editor-assist, deliberately a weaker surface than a run.
  - **Read-only:** the endpoint returns text; it does **not** write the document. The *editor*
    applies the result, so the human sees it before saving.
- **Web:** the three `slash-registry.ts` handlers call the endpoint, show a loading state, and
  insert/replace text in the Milkdown editor on return; toast on error. Gating unchanged.

### Threat model (fired — untrusted content → model) — embed in plan
- **Asset:** the instance AI key; the model's behavior.
- **Attacks → mitigations:**
  - Document body carries injected instructions → the body is framed as DATA in the user turn,
    reusing the runner's `UNTRUSTED_DATA_DIRECTIVE` fence discipline.
  - Injection causes an unattended write → impossible: endpoint is read-only; worst case is bad
    *suggested* text the human reviews before saving.
  - Key leak via response → response is `{ text }` only; key never serialized.
  - Non-configured instance → gated on `ai_configured`, denied otherwise.

### Tests (Tier A — untrusted input + auth-gated)
RED-first: ai-not-configured → deny; response carries no key; body fenced as untrusted; endpoint
performs no document write (assert the doc is unchanged after a call).

---

## 3. Dead-code & honesty cleanup  *(SHRANK — invariant checker already committed)*

All small. Each makes a declared-but-fake thing either real or gone.

1. **Emit `project.deleted`** — `routes/projects.ts:180` deletes the project inside `txWithEvents`
   but never emits the event (every sibling — status/table/field/view — does). Add the emit.
   **Respect the new invariant 15:** the delete path now requires an explicit `eventActor`; thread
   the acting user through. (Tier A: RED = delete, assert event emitted with correct actor + scope.)
2. **Remove dead event kinds** from `packages/shared/src/events.ts` (`EventKind` union +
   `KNOWN_EVENT_KINDS`):
   - `ai.action` — declared, never emitted, no consumer → remove.
   - `skill.trust.changed` — intentionally dropped in Phase 4 (no emitter, no consumer; documented
     at `skill-trust.ts:38`) → remove the dead declaration.
   - **KEEP** `agent.run.awaiting_approval` + `agent.run.rejected` — these belong to the deferred
     approval-gate feature (not dead, *reserved*). Add a one-line "reserved for approval gate"
     comment so a future reader doesn't mistake them for dead.
   - tsc proves no consumer breaks on the removals (type-level).
3. **Fix stale comments** (truthfulness, no behavior change):
   - `db/schema.ts:480` events `kind` comment references `status.changed` (no such kind) → list
     real kinds.
   - `lib/access.ts:1-34` "nothing reads this yet" → it IS wired now (drop-tenancy merged); correct
     the comment so it doesn't mislead.
4. **Wire comment Retry** — `comment-row.tsx:309` renders a *disabled* Retry button on error
   comments ("Phase 3 wires this"). Wire it to re-trigger the run via the existing runner retry
   path. (Tier B + seam test that Retry re-invokes the runner.)

**Already done by the operator-identity session — explicitly NOT in scope:**
- ✅ Invariant checker (`scripts/check-invariants.ts` + hook) committed (`a853a2c`).
- ✅ `last_used_at` wired (see §1).

---

## 4. Views are real — capture, persist, reorder  *(the biggest UX area)*

**The unifying problem (surfaced by Stefan's own mental model):** the view system half-works. The
board renders and Group/Sort work *in-memory*, but you can't *save* what you set up, and "New view"
silently creates the wrong thing. Verified facts:
- The `[Work items][Board]` header strip is a **fixed 2-tab navigation** (`w.$wslug.p.$pslug.tsx:20`),
  not a view-type picker. "Board" routes to `/board` rendering the seeded kanban view.
- `NewViewSheet.buildPayload()` **hardcodes `type: 'list'`** and has no access to board group-by —
  so "New view" from the board would make a *list* view, dropping the board + grouping.
- Board Group/Sort changes persist to a view **only if** opened via `?view=<id>`
  (`board-controls.tsx:59` consent gate) — on the seeded default board they live in an in-memory
  bus and are **lost on reload**.
- Manual within-column drag-reorder is **parked** (`kanban-view.tsx:132 reorderEnabled=false`); the
  *server* `board_position` persistence already works + round-trips (verified) — the park is on the
  *client* wiring + the "Manual" sort toolbar item.

### Scope — three sub-parts, converged on ONE persist rule

**4a — "New view" captures the current surface** (Stefan's expected behavior).
- The sheet receives the **current view type** (active tab: `work-items`→`list` / `board`→`kanban`)
  and the **current group-by** (from the board-controls bus / active view).
- `buildPayload()` sets `type` + `groupBy` from that, alongside the filters/sort/columns it already
  captures. `ViewCreate` already accepts `type` + `groupBy` — this is wiring, not API change.
- Result: on Board, set Group/Sort → "New view" → a named **kanban** view that opens as a board
  with your grouping. On Work-items → a list view.

**4b — Persist default-board Group/Sort across reload.**
- Today only `?view=`-pinned views persist. **Decision (recommended, confirm in plan): treat the
  active default view as persistable too** — the consent gate was meant for *ad-hoc unpinned* state,
  but the default view IS the user's real working view. So Group/Sort changes on the default board
  write back to that view via `updateView`.

**4c — Un-park manual drag-reorder** (was the original "4b").
- Flip `reorderEnabled` on (restore `effectiveSort === null` logic); restore the "Manual" sort menu
  item (`board-toolbar.tsx:112`); wire within-column drag → `board_position` via the existing
  `rankBetween()` fractional-rank helper → existing PATCH persistence.
- **Edge cases (why it was parked):** null-position cards (never dragged) sort deterministically
  (define: null sorts last, backfill rank on first drag); cross-column regroup (already works,
  writes `status`) must stay intact — within-column writes `board_position`; concurrent drag =
  last-write-wins (Folio's documented concurrency model).

**Convergence note (architecture-invariants):** 4b and 4c both answer "when does a board change get
written to its view?" 4c writes `board_position` per card; 4b writes group-by/sort per view — both
through `updateView`. **Define ONE rule** for when board state persists to its view (not two ad-hoc
gates). Name it in the plan; consider an `ARCHITECTURE-INVARIANTS.md` note for the view-persistence
convergence point.

### Tests
- 4a: "New view from board" → `type:'kanban'` + correct `groupBy` (assert the created view shape);
  "New view from work-items" → `type:'list'`.
- 4b: default-board Group/Sort survives reload (seam test through the real `updateView` path).
- 4c: drag persists `board_position` and round-trips (seam); null-position ordering deterministic.

### Verified-correct DROPS (not loose ends to fix here)
- New-view-sheet "Kanban toggle" as originally framed — the tab strip is navigation; 4a delivers
  real save-as-view *within* that model instead.
- Calendar / Timeline / Gallery view types — **planned** as their own feature (their own view-type
  design), not this pass. 4a must not foreclose them (leave `type` open-ended).

---

## 5. Explicitly NOT in this pass (accepted deferrals, documented so they're not "loose ends")

- **claude-code provider** — hard-disabled by construction (security gaps S-1/S-2; runner preflight
  refuses it). Revival is large + a security project. Leave parked with its existing clear comment;
  `FOLIO_CLAUDE_CODE_ENABLED` stays parsed-but-inert for deploy-config compatibility.
- **Comment "Load more" cursor pagination** — genuinely needs a server cursor/total_count
  (Phase 7). The button stays; out of scope.
- **`find_documents` / `describe_workspace` not in `V1_MCP_TOOLS`** — a deliberate v1 tool-surface
  decision, not an accident.
- **Work-item status transition guard / state machine** — the real future differentiator, but the
  flow-roadmap explicitly defers it; not what "usable now" needs (see §0).
- **Rotation handshake / revocation-on-use** — the deferred half of the MCP-credential watch-item.

---

## 6. Sequence, review clusters & gates

Five work areas → **review clusters of ≤4 tasks** (harness 1f), security/dead-code first (clean
base), UX last. Each cluster: `/integration` + `/code-review` before the next; the token cluster
(security boundary) also gets `/security-review`.

| # | Cluster | Gate at plan-time | Review |
|---|---|---|---|
| **1** | **Token lifecycle** (§1) — schema + bearer enforce + coarse last_used + mint + UI + Rotate + invariants-doc update | threat-model + invariants (auth) | `/code-review` + `/security-review` |
| **2** | **Dead-code & honesty** (§3) — `project.deleted` emit, dead-kind removal, comment fixes, comment Retry | invariants (event/entity) | `/code-review` |
| **3** | **AI slash commands** (§2) — endpoint + 3 web handlers | threat-model + invariants (AI path) | `/code-review` |
| **4** | **Views are real** (§4) — 4a capture, 4b persist, 4c un-park, converged persist rule | invariants (view-persistence convergence) | `/code-review` |

**Spec-close:** `/shakeout` — `feature-acceptance` drives the AI slash commands + the board
(create-view-from-board, group/sort-survives-reload, drag-reorder-round-trips) through the **real
browser**; token expiry driven through the **un-mocked wire**; reviewer panel (incl.
`invariant-auditor`) on the full branch diff. Then `finish-branch`.

**Done bar (Stefan's):** secure (token TTL enforced) + honest (nothing visible is fake — slash
commands real, dead code gone, comments true) + board-usable (create/persist/reorder all work).
Only then → Track A.
