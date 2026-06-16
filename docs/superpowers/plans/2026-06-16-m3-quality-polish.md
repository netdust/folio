# M3 — Quality & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audit's Milestone 3 (quality & polish: docs accuracy, client pagination, rail-fetch batching, typing cleanup, test-gap closure, the Playwright IOUs) plus the cheap doc/flake folds Stefan approved — taking Folio's *delivery + maintainability* surface to v1 quality without touching the hardened auth/crypto/runner-correctness work already merged in M0–M2.

**Architecture:** Five review clusters, each independently committable and reviewable. Most of M3 is docs/config/test work (LIGHT/STANDARD review); two clusters change user-facing UI behavior (STANDARD + browser-driven feature-acceptance). No cluster touches a 1a security-trigger surface, so the FULL specialist panel is held in reserve and fires only on one-way escalation if a reviewer surfaces a finding on a security surface.

**Tech Stack:** Bun, Hono, Drizzle, SQLite (server); React + Vite + TanStack Router + react-query (web); Vitest (web tests), Bun test (server tests), Playwright (e2e); Biome.

**Source of truth:** `docs/AUDIT-2026-06-10.md` Phase 4 / Milestone 3 (tasks 3.1–3.8). All file:line citations below are **re-ground-truthed against `main` @ `5579e99` on 2026-06-16** (the audit's own citations had drifted across the M0–M2 merges — corrections noted inline).

---

## Gate summary (harnessed-development Stage 1)

- **1a Threat model — DOES NOT FIRE.** No cluster touches user-controlled URLs, auth/session/token writes, crypto writes, untrusted parsing, BYOK credential writes, or outbound-to-user-URL paths. The tests added for `autonomy-gate.ts` / `email.ts` / the per-tool denial matrix are *new tests against existing code*, not behavior changes. **If any reviewer surfaces a finding on a 1a surface, that cluster escalates to FULL (one-way) and `/security-review` runs.**
- **1b Invariants — cited, not newly converged.** Cluster D (typing) touches the runner RunContext (inv 12/19 area) and comments service (inv 5) but is type-only/behavior-preserving. Cluster B (pagination) and C (rail fetch) touch read paths only. Invariants cited per-cluster below; no new convergence point introduced.
- **1g Acceptance flows — fire for Cluster B (pagination) and Cluster C (rail fetch)** (user-facing UI behavior changes). Matrices embedded in those clusters. Docs/typing/test clusters are not user-facing features → no matrix.

## Review tier per cluster (harnessed-development 1h — provisional, restate at each gate)

| Cluster | Content | Provisional tier | Why |
|---|---|---|---|
| **A — Docs accuracy** | API.md, MCP.md, PHASES.md, FOLIO-BRIEFING.md, optional check-invariants doc-citation extension | **LIGHT** (single generalist) | Doc/config edits. EXCEPTION: if the check-invariants extension (A5) ships code, that *task* gets STANDARD. |
| **B — Client pagination** | consume `nextCursor` in table view; fix the client-side frontmatter post-filter wrongness at scale | **STANDARD** (2 finders + simplicity + browser pass) | User-facing UI behavior + react-query cache semantics. No 1a surface. |
| **C — Rail-fetch batching** | gate/batch the O(P×T) views fan-out; lift handlers to `useRailHandlers` | **STANDARD** | User-facing UI behavior (rail). No 1a surface. |
| **D — Typing cleanup** | discriminated `RunContext` variant kills `as unknown as Workspace`; typed Drizzle→Document mapper for comments | **STANDARD** | Touches runner authority-adjacent context (cite inv 12/19) — type-only but security-*adjacent*, so STANDARD not LIGHT. Escalates to FULL only on a real finding. |
| **E — Test gaps + Playwright IOUs + flake** | `email.ts` + `autonomy-gate.ts` Tier-A tests; per-tool denial matrix test; write-or-delete the 8 `it.skip` IOUs; replace 7 raw sleeps; silence the Milkdown teardown flake; dispatcher cursor batch-advance | **STANDARD** | Adds security-adjacent tests (autonomy-gate, denial matrix) + a server behavior change (cursor batching). STANDARD; the denial-matrix + autonomy-gate tests are Tier-A. |

**Cluster ordering:** A → E → D → B → C. Rationale: docs first (zero-risk, unblocks nothing but clears the deck); E next (test-gap closure raises the safety net *before* the behavioral changes in B/C/D lean on it); D before B/C (typing cleanup is isolated and de-risks nothing downstream but is cheap and self-contained); B and C last (the two user-facing behavior changes, each with a browser-driven acceptance pass). Each cluster is a `── REVIEW GATE ──`.

---

## Cluster A — Docs accuracy (LIGHT)

**Audit:** 3.1, 3.2 + the approved doc folds (libsodium drift, API.md AI-keys path).
**Invariants:** none.
**Acceptance flows:** n/a (not a user-facing feature).

> **Ground-truth corrections to the audit:** README has **no** "~50MB" claim — that audit sub-item is dropped. PHASES.md is a *layering inconsistency*, not a true numbering collision (1.5–1.9.1 are numbered as Phase-1 substeps but post-date Phase 2) — the fix is a clarifying note, not a renumber. MCP.md says "20 tools", real registry has **31**. API.md AI-keys path is flatly wrong AND still says libsodium.

### Task A1: Fix API.md AI-keys endpoint path + encryption term + add missing surfaces

**Files:**
- Modify: `docs/API.md:83-93` (AI-keys section)
- Modify: `docs/API.md` (add conversations + runs sections)

- [ ] **Step 1: Fix the AI-keys section.** Replace the section header path `/api/v1/w/:wslug/settings/:workspaceId/ai-keys` with `/api/v1/instance/ai-keys`; replace the source-file reference with `apps/server/src/routes/instance-ai-keys.ts`; replace "libsodium-encrypted" with "AES-256-GCM-encrypted (via @noble/ciphers)". Verify the exact route shape by reading `apps/server/src/routes/instance-ai-keys.ts` first and documenting the actual methods/paths it exposes (GET list, POST create, DELETE, etc. — read, don't assume).

- [ ] **Step 2: Add the conversations surface.** Add a section for `/api/v1/conversations/*` documenting the real routes in `apps/server/src/routes/conversations.ts` (read the file; document each method + path + auth scope as the existing API.md sections do).

- [ ] **Step 3: Add the runs surface.** Add a section for `/api/v1/w/:wslug/runs/*` from `apps/server/src/routes/runs.ts` (read the file; mirror the existing API.md section style; note the `?limit` cap added in M0 quick-wins).

- [ ] **Step 4: Commit.**
```bash
git add docs/API.md
git commit -m "phase-m3: fix API.md AI-keys path + term, document conversations + runs surfaces"
```

### Task A2: Fix MCP.md tool count

**Files:**
- Modify: `docs/MCP.md:34` (and any other count references)

- [ ] **Step 1: Read the registry.** Read `apps/server/src/lib/agent-tools-registry.ts` and enumerate the registered tools to confirm the count (ground-truth says 31: 8 document + 4 comment + 4 agent-lifecycle + 5 run + 2 ui + 2 config). Grep MCP.md for every place a count appears (not just line 34).

- [ ] **Step 2: Update the count + the grouping breakdown** to match reality (31, with the correct category sub-counts). If MCP.md lists the tools by name, reconcile the list against the registry.

- [ ] **Step 3: Commit.**
```bash
git add docs/MCP.md
git commit -m "phase-m3: correct MCP.md tool count 20->31 + category breakdown"
```

### Task A3: Reconcile crypto term across PHASES.md + FOLIO-BRIEFING.md

**Files:**
- Modify: `docs/PHASES.md:38, 469, 475`
- Modify: `docs/FOLIO-BRIEFING.md` (multiple — grep first)

- [ ] **Step 1: Grep for residual term.** `grep -rn -i 'libsodium\|secretbox' docs/` to get the live list (ground-truth: PHASES.md:38/469/475 + several in FOLIO-BRIEFING.md). Note line 475 is also an *unchecked* token-encryption IOU — fix the term but DO NOT check the box (that's a feature claim, not a doc fix).

- [ ] **Step 2: Replace** each "libsodium secretbox"/"libsodium-encrypted" with "AES-256-GCM (@noble/ciphers)". Preserve surrounding meaning; do not alter checkbox state.

- [ ] **Step 3: Commit.**
```bash
git add docs/PHASES.md docs/FOLIO-BRIEFING.md
git commit -m "phase-m3: docs crypto-term drift libsodium->AES-256-GCM"
```

### Task A4: PHASES.md layering-inconsistency note (NOT a renumber)

**Files:**
- Modify: `docs/PHASES.md:1-8` (reading guide)

- [ ] **Step 1: Add a one-paragraph note** to the reading guide clarifying that phases 1.5–1.9.1 are *polish layers* that were executed AFTER the Phase 2 agent backbone despite their Phase-1 numbering, and that `memory/STATE.md` is the canonical live roadmap while PHASES.md is the historical phase ledger. Do NOT renumber executed phases (would break every cross-reference in the repo). This resolves Open Question #6 from the audit by documenting the answer.

- [ ] **Step 2: Commit.**
```bash
git add docs/PHASES.md
git commit -m "phase-m3: clarify PHASES.md numbering vs executed reality"
```

### Task A5 (OPTIONAL — propose before building): Extend check-invariants.ts to verify doc endpoint paths

> This task ships **code**, so it is **STANDARD-tier**, not LIGHT. It is OPTIONAL — the audit lists it as "consider". Decision gate: only build it if the doc-path drift we just fixed (A1) is judged likely to recur. The cheaper alternative is "we just fixed it by hand; revisit if it drifts again." **Surface this choice to the controller at the A-cluster gate; default = SKIP unless Stefan wants the machine check.**

**Files (if built):**
- Modify: `scripts/check-invariants.ts`
- Test: extend the existing invariant-checker test harness

- [ ] **Step 1 (if approved): Write the failing test.** A doc-path-citation check: parse `/api/v1/...` patterns from `docs/API.md`, scan `apps/server/src/routes/*.ts` for `app.get|post|put|delete|patch` route registrations, assert every documented path resolves to a real route. RED-verify against the pre-A1 (wrong) API.md state, or a deliberately-broken fixture.
- [ ] **Step 2: Implement `checkDocPaths()`** following the existing file/symbol/line-drift pattern in the script.
- [ ] **Step 3: GREEN + run `bun run check:invariants`.**
- [ ] **Step 4: Commit.**

### ── REVIEW GATE A ── (LIGHT, unless A5 built → that task STANDARD)
- Tier statement at gate: `Review tier: LIGHT — docs-only (A5 if built: STANDARD for the code)`.
- LIGHT = single generalist `reviewer` pass on the cluster diff. No fan-out.
- `/integration` not required for docs-only; if A5 ships code, run `bun run check:invariants` + the script's test.

---

## Cluster E — Test gaps + Playwright IOUs + flake + dispatcher batching (STANDARD)

**Audit:** 3.4, 3.7 (denial matrix), 3.8 + the approved web-flake fold.
**Invariants:** inv 4a (authorization) is the *subject under test* for the denial matrix + autonomy-gate — these tests assert the convergence point holds; they don't change it.
**Acceptance flows:** n/a (tests + a server-internal write-amplification fix, no user-facing feature).

### Task E1: `lib/email.ts` magic-link URL/regex round-trip test (Tier A)

**Files:**
- Read: `apps/server/src/lib/email.ts`
- Test: `apps/server/src/lib/email.test.ts` (create)

- [ ] **Step 1: Read `email.ts`** to learn the exact magic-link URL construction + any parse/regex. Tier-A justification: URL construction for an auth flow is parsing/logic.
- [ ] **Step 2: Write RED tests** — round-trip the built URL (construct → parse the token back out), assert the token survives byte-exact; assert malformed input is rejected (denial path). Run, verify RED.
- [ ] **Step 3: GREEN** (the impl exists; the test should pass once written correctly — if it goes RED against real code, that's a real bug → escalate via systematic-debugging, do not "fix the test").
- [ ] **Step 4: Commit.**

### Task E2: `lib/autonomy-gate.ts` direct test (Tier A)

**Files:**
- Read: `apps/server/src/lib/autonomy-gate.ts`
- Test: `apps/server/src/lib/autonomy-gate.test.ts` (create)

- [ ] **Step 1: Read `autonomy-gate.ts`** — this gates whether an agent run may proceed unattended (security-relevant). Tier A (security guard, always).
- [ ] **Step 2: Write RED tests** covering the allow path AND the **denial path** (the case where autonomy is refused) + any boundary (e.g. risk-tier threshold). Run, verify RED.
- [ ] **Step 3: GREEN.**
- [ ] **Step 4: Commit.**

### Task E3: Per-tool denial matrix test (Tier A)

**Files:**
- Read: `apps/server/src/lib/agent-tools-registry.ts` (the `registerRealTools` body, ~lines 416-2206) + `lib/agent-identity.ts` + wherever scope∩caller is enforced (`executeTool`)
- Test: `apps/server/src/lib/agent-tools-denial-matrix.test.ts` (create)

> **Ground-truth correction:** the audit (3.7) said `registerRealTools` is in `services/agent-runs.ts` — it is NOT; it's in `lib/agent-tools-registry.ts`. Build against the real location.

- [ ] **Step 1: Enumerate** each registered tool and its required scope. Build a table: for each tool, a caller WITHOUT the scope must be denied at `executeTool`.
- [ ] **Step 2: Write the matrix test** — parametrized over all 31 tools, each asserting fail-closed denial for the missing-scope caller (this is the single highest-value test in M3: it locks the authorization convergence point against future tool additions silently shipping un-gated). Run, verify it goes RED if you temporarily remove one tool's scope check (RED-proof).
- [ ] **Step 3: GREEN against real code.** If any tool is found *un-gated* by this test, that is a real security finding → STOP, escalate to FULL + `/security-review`, fix RED-first.
- [ ] **Step 4: Commit.**

### Task E4: Resolve the 8 `it.skip` Playwright IOUs

**Files:**
- Modify: `apps/web/src/components/comments/comment-composer.test.tsx:232-258` (7 IOUs)
- Modify: `apps/web/src/components/slideover/body-editor.test.tsx:9` (1 IOU)
- Possibly: `apps/web/tests/e2e/*.spec.ts` (if promoting to Playwright)

- [ ] **Step 1: Decide per IOU — write or delete.** The 7 comment-composer IOUs are caret-position/picker/focus behaviors that jsdom genuinely can't test (that's *why* they're skipped). Decision rule: if the behavior is already covered by an existing Playwright click-through spec, DELETE the skip with a one-line comment pointing at the covering spec. If not covered and the behavior is real-user-critical, WRITE the Playwright spec in `apps/web/tests/e2e/click-through.spec.ts`. If neither (low value), DELETE with a recorded rationale. Same for body-editor.test.tsx:9 ('renders the initial markdown' — likely a jsdom-Milkdown limitation; verify and delete-or-promote).
- [ ] **Step 2: Apply the decisions.** No `it.skip('TODO ...')` lines remain after this task — each is either a real spec or deleted-with-reason.
- [ ] **Step 3: Run web suite + (if specs written) the relevant Playwright spec in isolation.**
- [ ] **Step 4: Commit.**

### Task E5: Replace the 7 raw `setTimeout` sleeps with deterministic waits

**Files:**
- Modify: `apps/web/src/components/settings/ai-tab.test.tsx:112,250,285`
- Modify: `apps/web/src/components/table/table-view.test.tsx:496,568,753`
- Modify: `apps/web/src/components/views/kanban-view-dnd.test.tsx:506`

- [ ] **Step 1: Replace each `await new Promise(r => setTimeout(r, N))`** with the appropriate Testing-Library deterministic wait (`await waitFor(() => expect(...))` / `findBy*`). Read each test's intent — the sleep is masking an async assertion; assert the actual post-condition instead.
- [ ] **Step 2: Run each touched test file ≥3× to confirm determinism** (no flake reintroduced).
- [ ] **Step 3: Commit.**

### Task E6: Silence the Milkdown teardown flake (approved fold)

**Files:**
- Modify: `apps/web/src/components/comments/comments-tab.test.tsx` (the `@milkdown/ctx` `removeEventListener` teardown race)

> STATE.md non-blocker: a `setTimeout` fires after jsdom teardown in `comments-tab.test.tsx` (renders Milkdown), throwing `ReferenceError: removeEventListener is not defined`, flipping vitest's exit code ~40% of runs. Zero tests *fail*; it's an unhandled rejection.

- [ ] **Step 1: Pick the fix** — preferred: unmount Milkdown explicitly in `afterEach` so the teardown listener detaches before jsdom tears down. Fallback: a scoped `onUnhandledError`/`dangerouslyIgnoreUnhandledErrors` filter for this known lib pattern (last resort — narrow, commented).
- [ ] **Step 2: Run the full web suite ≥5×** confirming the exit code is stable 0.
- [ ] **Step 3: Commit.**

### Task E7: Dispatcher cursor batch-advance (audit 3.8 — server behavior)

**Files:**
- Modify: `apps/server/src/lib/event-dispatcher.ts:135-172`
- Test: extend `apps/server/src/lib/event-dispatcher.test.ts` (or co-located)

> `persistCursor` does a separate UPDATE per event (lines 165, 171) → ~40 writes per workspace mount. Batch-advance: persist the cursor once at the end of a reactor's drain loop (or every K events), not per event.

- [ ] **Step 1: Read the drain loop** to understand crash-safety semantics — the cursor is the at-least-once delivery guarantee; batching MUST NOT drop the guarantee (on crash mid-batch, re-delivery of already-reacted events must remain safe/idempotent, which the reactor already is). Tier A (touches the durable event plane).
- [ ] **Step 2: Write a RED test** asserting the cursor advances to the final seq after a drain of N events with a single (or bounded) write, AND that a simulated mid-drain crash leaves the cursor at a safe (not-ahead) position. Run, verify RED.
- [ ] **Step 3: Implement batch-advance** — move `persistCursor` to once-per-drain (after the loop), keeping the value monotonic and never ahead of a successfully-reacted event.
- [ ] **Step 4: GREEN + full server suite.**
- [ ] **Step 5: Commit.**

### ── REVIEW GATE E ── (STANDARD)
- Tier statement: `Review tier: STANDARD — test-gap closure + a durable-event-plane write change; no 1a write surface. E2/E3/E7 are Tier-A tests/changes.`
- `/integration` on the cluster diff (server + web suites + 3× typecheck).
- STANDARD fan-out: 2 finders (line-by-line + cross-file tracer) + `code-simplicity-reviewer`. **Plus `invariant-auditor`** specifically on E3 (denial matrix asserts inv 4a) + E7 (touches the event plane, inv 5-adjacent).
- **Escalation watch:** if E3 finds an un-gated tool, or E7's crash-safety test reveals a real delivery-guarantee bug → promote E to FULL + `/security-review`.

---

## Cluster D — Typing cleanup (STANDARD)

**Audit:** 3.3.
**Invariants:** inv 12 (run lifecycle) / inv 19 (RunSink) — Cluster D touches `RunContext` shape; cite both. inv 5 (single write path) — comments mapper is read-shaping only. Behavior-preserving; the existing runner + comments suites are the safety net (green before AND after).
**Acceptance flows:** n/a.

### Task D1: Discriminated `RunContext` variant to kill `as unknown as Workspace`

**Files:**
- Modify: `apps/server/src/lib/runner.ts:664-795` (`loadConversationContext`) + the `RunContext` type definition (find it)
- Test: existing `runner.test.ts` is the behavior-preservation net; add a type-level assertion if useful

> Casts at runner.ts:698 (`AgentRunFrontmatter`), 706 (`Workspace {id:'',slug:'',name:''}`), 707 (`Project`). Comment says these are "synthetic non-null sentinels...never dereferenced on the sink path". The honest fix: make `RunContext` a discriminated union — a `document` variant carries real `workspace`/`project`; a `conversation` variant simply DOESN'T HAVE those fields. Then no fabrication is needed; the type system proves the sink path never reads them.

- [ ] **Step 1: Read `RunContext`'s definition and every read site** of `ctx.workspace` / `ctx.project`. Confirm (grep) that the conversation path truly never dereferences them — if it does, the discriminant must guard that read. This is the load-bearing ground-truth step; the cast comment *claims* never-dereferenced, verify it.
- [ ] **Step 2: Define the discriminated union** (`kind: 'document' | 'conversation'`, or reuse the existing RunSink `isConversation` discriminant if one already exists post-RunSink — check `lib/run-sink.ts` first). Document variant has `workspace: Workspace; project: Project`; conversation variant omits them.
- [ ] **Step 3: Replace the fabrications** with the conversation variant constructor (no `as unknown as`). Update read sites to narrow on the discriminant.
- [ ] **Step 4: Run the FULL server suite** (1828 baseline) — ZERO behavioral assertions may change. tsc clean. This is the behavior-preservation proof.
- [ ] **Step 5: Commit.**

### Task D2: Typed Drizzle-row→Document mapper for comments

**Files:**
- Modify: `apps/server/src/services/comments.ts:392,451,565,595,637`
- Test: existing comments suite is the net

> 5 `as unknown as` casts across create/update/deleteComment (Drizzle row → `Document`, frontmatter → `Record`). Extract ONE typed mapper `rowToDocument(row): Document` that does the real field mapping, used by all three.

- [ ] **Step 1: Write the mapper** `function rowToDocument(row: <DrizzleRowType>): Document` mapping each field explicitly (no blanket cast). Read the Drizzle schema for the row type + the `Document` type to align fields.
- [ ] **Step 2: Replace all 5 cast sites** with the mapper (or the appropriate sub-mapping for the `Record` casts).
- [ ] **Step 3: Run the comments suite + full server suite** — zero behavioral change. tsc clean.
- [ ] **Step 4: Commit.**

### ── REVIEW GATE D ── (STANDARD)
- Tier statement: `Review tier: STANDARD — type-only, behavior-preserving; touches runner authority-adjacent RunContext (inv 12/19) so STANDARD not LIGHT.`
- `/integration` (server suite must equal baseline + tsc clean).
- STANDARD fan-out: 2 finders + `code-simplicity-reviewer` + **`invariant-auditor`** (RunContext touches inv 12/19; confirm the discriminant doesn't open a path that reads workspace/project on the conversation branch).
- Escalation watch: if the cast removal reveals the conversation path DID dereference a fabricated field (a latent bug) → FULL + systematic-debugging.

---

## Cluster B — Client pagination (STANDARD)

**Audit:** 3.6 / M5.
**Invariants:** none new (read path).
**Acceptance flows:** REQUIRED (user-facing UI behavior).

> `nextCursor` is defined (`documents.ts:43`) but **read nowhere** in prod. `table-view.tsx:381` reads `page?.data` only; `applyFrontmatterClauses` (`documents.ts:306-326`, called at `table-view.tsx:377`) filters **only the current page** → wrong result set past the first page at thousands of docs. The audit pairs this with virtualization; **scope decision: this plan does pagination consumption + correct post-filter, and DEFERS virtualization** (it's a perf-polish that can land separately; flag it as a follow-up). The server already returns `nextCursor` correctly (M0-verified) and `GET /runs` got its `?limit` in M0.

### `## Acceptance flows` (1g)

| Flow | Happy path | Edges (mandatory) |
|---|---|---|
| **Load more / paginate a table past page 1** | Table with >page-size docs loads first page; user scrolls/clicks → next page appends; `nextCursor` consumed until null | **empty**: 0-doc table shows empty state, no "load more". **denied**: n/a (read, scoped by existing access). **wrong-order/re-entry**: rapid double "load more" doesn't double-append or skip a page. **concurrent**: an SSE insert during pagination doesn't corrupt the cursor sequence. **boundary**: exactly page-size docs → no spurious empty next page; last page → cursor null, no further fetch. **mid-flow failure**: a failed next-page fetch shows an error/retry, doesn't wedge the table. |
| **Filter a table by a frontmatter field across pages** | Apply a frontmatter clause (e.g. priority=high) → results reflect ALL matching docs, not just page-1 matches | **empty**: filter matching nothing → empty state. **boundary**: a match only present on page 2 IS found (the exact bug being fixed). **concurrent**: filter change mid-pagination resets cleanly. **mid-flow failure**: filter fetch error surfaces, prior results not silently wrong. |

### Task B1: Decide + implement the correct filter-at-scale strategy

> **Design decision (resolve in Step 1, the load-bearing one):** the *correct* fix for "filter only sees page 1" is **server-side frontmatter filtering**, not fetching all pages client-side (which defeats pagination). Check whether the server's `listDocuments` filter compiler (the audited "injection-proof filter compiler — whitelisted columns/operators") already supports frontmatter-clause filtering. If it does, the client should pass the clauses to the server and drop `applyFrontmatterClauses` from the hot path. If it does NOT, the honest scope is: (a) push frontmatter filtering server-side (larger), OR (b) document the client-filter as page-local with a visible "filtering current page only" affordance until server-side lands (smaller, honest). **Surface this fork to the controller at dispatch; do not silently fetch-all-pages.**

**Files:**
- Modify: `apps/web/src/lib/api/documents.ts:306-326` (post-filter) + `:43` (type, already correct)
- Modify: `apps/web/src/components/table/table-view.tsx:73,377,381`
- Test: `apps/web/src/components/table/table-view.test.tsx`

- [ ] **Step 1: Ground-truth the server filter capability** (read the server `listDocuments` + filter compiler) and pick strategy (a)/(b) above. Record the choice in the commit.
- [ ] **Step 2: Write RED tests** for the chosen strategy — at minimum the boundary case "a match on page 2 is found" (or, for strategy (b), "the affordance shows + page-local result is correctly labeled"). Plus the empty-state and last-page-cursor-null cases.
- [ ] **Step 3: Implement.** Consume `nextCursor` via react-query's `useInfiniteQuery` (or the repo's existing infinite pattern — check `lib/api/` for precedent) in the table view; wire "load more" / scroll trigger. Apply the chosen filter strategy.
- [ ] **Step 4: GREEN + run web suite ≥3×** (no flake).
- [ ] **Step 5: Commit.**

### ── REVIEW GATE B ── (STANDARD)
- Tier statement: `Review tier: STANDARD — user-facing UI + react-query cache semantics; read path, no 1a surface.`
- `/integration` + the **feature-acceptance browser pass** (drive the matrix above through Chrome/Playwright against the dev server — the page-2-match boundary MUST be driven in a real browser, not jsdom).
- STANDARD fan-out: 2 finders + `code-simplicity-reviewer`. `performance-oracle` ONLY if Step 1 chose a strategy that changes query volume on a hot path.

---

## Cluster C — Rail-fetch batching (STANDARD)

**Audit:** 3.5.
**Invariants:** none new (read path).
**Acceptance flows:** REQUIRED (rail is user-facing; the bug class is "view vanished when collapsed").

> `w.$wslug.tsx:181-200` fires one `GET /views` per (project, table) pair UNCONDITIONALLY on the always-mounted sidebar — O(P×T) on every workspace mount. The in-code TODO already analyzed the two fixes: **expand-gating** (skip fetch for collapsed projects — but expand state lives non-reactively in `rail-tree.tsx`'s `useExpanded`, risking the "view vanished when collapsed" regression) OR a **batched endpoint** (`GET /p/<pslug>/views?tables=` or `?tables=` multi). `staleTime: 5m` already prevents within-session refetch storms, so this is a *mount-cost* fix, not a steady-state one.

### `## Acceptance flows` (1g)

| Flow | Happy path | Edges (mandatory) |
|---|---|---|
| **Open a workspace with multiple projects/tables** | Rail renders all projects + their views; view counts/names correct | **empty**: workspace with 0 projects → rail empty state, no fan-out. **boundary**: a project with 0 tables → no views fetch, no error. **concurrent**: expanding a project mid-load doesn't drop its views (the regression guard). **wrong-order/re-entry**: collapse-then-expand a project → views still present (NOT vanished — the documented V3 bug). **mid-flow failure**: a failed views fetch for one project degrades only that project, not the whole rail. |

### Task C1: Batch the views fetch (preferred) or expand-gate

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx:181-200,233`
- Possibly add: a batched server endpoint `apps/server/src/routes/views.ts` (if batched strategy) + `apps/web/src/lib/api/views.ts`
- Test: web test for the rail fetch shape + (if server endpoint) a server route test

- [ ] **Step 1: Pick strategy.** Preferred = **batched endpoint** (avoids the expand-state reactivity hazard the in-code TODO flagged): add `GET /api/v1/w/:wslug/p/:pslug/views?tables=t1,t2,...` (or a workspace-level `GET /views?projects=...`) returning views grouped, collapsing P×T requests to ~P (or 1). Expand-gating is the fallback if the batched endpoint is judged too large for M3. **Surface the fork at dispatch.**
- [ ] **Step 2 (if batched): Write the server route + RED route test** (real-app test over migrations, mirroring existing route tests — returns the right views for the requested tables, scoped by access). GREEN.
- [ ] **Step 3: Rewire the rail** to the batched call (replace the `useQueries` fan-out). Preserve the staleTime + the per-project degradation behavior.
- [ ] **Step 4: Lift handlers to `useRailHandlers`** (audit's second half of 3.5) — extract the inline `handlers` useMemo at `:233` into a `useRailHandlers(wslug, navigate)` hook. Behavior-preserving.
- [ ] **Step 5: GREEN — web suite + server suite (if endpoint added) + 3× run.**
- [ ] **Step 6: Commit.**

### ── REVIEW GATE C ── (STANDARD)
- Tier statement: `Review tier: STANDARD — rail UI + (maybe) a new read endpoint; no 1a surface.`
- `/integration` + **feature-acceptance browser pass** — the collapse→expand "view doesn't vanish" edge MUST be driven in a real browser (it's a documented prior regression, jsdom won't catch it).
- STANDARD fan-out: 2 finders + `code-simplicity-reviewer`. If a server endpoint was added, `invariant-auditor` confirms it routes through the access convergence point (inv 4a — visibility).

---

## Stage 3 — Spec-close (after all clusters)

1. **Phase-complete integration** — `/integration` on the full branch diff (server 1828+ / web 946+ / shared 70, 0 fail; 3× tsc clean; check:invariants 0/0).
2. **test-effectiveness audit** over the whole M3 diff — walk the seven green-but-blind modes. The denial-matrix (E3), autonomy-gate (E2), and dispatcher-crash-safety (E7) tests are the load-bearing "would it bite?" targets; confirm each goes RED if its guard breaks.
3. **feature-acceptance drive** — drive Cluster B + C matrices through the real browser; emit the pass/fail/not-reachable manifest. No UI flow is `pass` without a browser.
4. **shake-out** — `/shakeout`. **Branch tier = STANDARD** (no cluster touched a 1a surface). STANDARD spec-close panel = `reviewer` + `invariant-auditor`. **One-way escalation:** if E3/E7 surfaced anything real, or any reviewer flags a 1a finding, the branch promotes to FULL (full 5-persona panel + `/security-review`) — state the tier before dispatch.
5. **finish** — `superpowers:finishing-a-development-branch`. **Do NOT merge — Stefan gates the merge** (the standing rule for every hardening milestone).
6. **compound** (spec-close only) — propose CODE-MAP.md deltas (the new `useRailHandlers`, the discriminated RunContext, the batched views endpoint, the denial-matrix test as a named guard) + a scoped `/skill-audit`. Report-only.

---

## Deferred (recorded, NOT in this branch)

- **Virtualization** of the table view (audit paired it with 3.6; it's perf-polish, lands separately).
- **a11y backlog** (32 findings at `warn`) — Stefan scoped out.
- **`reapStalePendingOps` chunking** (shares the events-reaper cliff CR-C1 fixed) — infra follow-up, separate.
- **`auth_rate_limits` table reaper** — infra follow-up, separate.
- **CI `bun-version` pin** (latest 1.3.14 vs dev/docker 1.3.8) — separate config PR.
- **`/mcp` oversized-body → JSON-RPC error** (currently HTTP 413, no known client breaks) — separate.
- **Server-side frontmatter filtering** IF Cluster B Step 1 chooses the honest-affordance fallback (b) — the full server-side filter is then its own larger task.

---

## Self-review checklist (done)

- **Spec coverage:** 3.1✓(A1/A2/A5) 3.2✓(A4; README claim dropped per ground-truth) 3.3✓(D1/D2) 3.4✓(E4/E5) 3.5✓(C1) 3.6✓(B1; virtualization deferred) 3.7✓(E3; agent-runs lift itself = the audit's own "leave the rest" guidance, only the denial-matrix test is in-scope) 3.8✓(E1/E2/E7). Doc folds✓(A1/A3). Flake fold✓(E6).
- **Placeholder scan:** no TBD/TODO-in-plan; every code task names exact files + the read-first ground-truth step; design forks (A5, B1, C1) are explicit controller-decision gates, not hand-waves.
- **Type consistency:** `useRailHandlers`, `rowToDocument`, `RunContext` discriminant, `checkDocPaths` named consistently.
- **Note on 3.7 lift:** the audit's "lift provider-health out of agent-runs.ts + split registerRealTools into domain files" is the audit's OWN "Explicitly NOT recommending — leave the rest" item; M3 takes only the **per-tool denial matrix test** (the high-value, low-risk half) and DEFERS the structural split.
