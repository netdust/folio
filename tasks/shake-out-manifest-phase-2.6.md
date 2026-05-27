# Bug Manifest — Folio Phase 2.6

**Generated:** 2026-05-27
**Last updated:** 2026-05-27 (post-blocker-fix)
**Spec:** `docs/superpowers/specs/2026-05-26-phase-2.6-comments-and-tabbed-slideover-design.md`
**Branch:** `phase-2.6/comments-and-slideover` (base `8df3f2f`, ~110 files / +20.6K LOC before fixes)
**Build status:** server typecheck clean / web typecheck clean / server 495 pass / web 537 pass / shared 46 pass / scripts 6 pass / Playwright 28 pass
**Sweep status:** Track A (automated against booted server on a fresh DB) complete; Track B (manual browser walkthrough) is `apps/web/tests/manual-qa-phase-2.6.md` — 40 scenarios already authored, user-side

---

## Summary

**6 issues found:** 3 CRITICAL/BLOCKER, 1 IMPORTANT, 2 MINOR.

**3 BLOCKERs RESOLVED** in this shake-out session (BUG-001, BUG-005, BUG-006). All other items OPEN for triage.

Acceptance criteria 1-10 (spec §10) pass functionally on the server side after the fixes.

---

## Root Cause Clusters

### Cluster A — Builtin trigger Enabled toggle
- **BUG-001** stands alone. Server lock is correct-by-spec; UI patch path doesn't speak its protocol.

### Cluster B — Agent policy widening (Phase 2.6 D8 reviewer finding)
- **BUG-005** scope-escalation via `tools` field is the same shape as the pre-existing `projects` allow-list widening guard. Both gates needed on every agent-CRUD entrypoint (HTTP + MCP, create + patch).

### Standalone
- **BUG-002** — `create_agent` MCP schema/handler mismatch on `slug`
- **BUG-003** — Milkdown teardown errors after vitest tests finish
- **BUG-004** — Web bundle size warning
- **BUG-006** — SSE hot-spin polling loop

---

## Bug List

### BUG-001 [CRITICAL] — Builtin trigger Enabled toggle is rejected from the UI — **RESOLVED**

- **Found by:** Automated (live PATCH against booted server + code trace of UI patch path)
- **What happened:** UI sent `PATCH /api/v1/w/acme/documents/builtin-on-assignment` with `{ frontmatter: { on_event, schedule, agent, enabled: <toggled>, builtin, payload } }` (full frontmatter, only `enabled` value differs). Server's builtin lock rejected with `422 BUILTIN_TRIGGER_LOCKED — only frontmatter.enabled is mutable on builtin triggers`. Toggling Enabled on a builtin from the slideover always errored.
- **Expected:** Toggle persists. Spec §6e + acceptance #7 carve out `enabled` as mutable; the server's own error text says so.
- **Where:**
  - Server: `apps/server/src/services/documents.ts:580-600` — rejected when `Object.keys(patch.frontmatter).filter(k => k !== 'enabled').length > 0`, which tripped on every key the UI sent along.
  - UI: `apps/web/src/components/slideover/workspace-document-slideover.tsx:376-387` — diffs frontmatter as a whole object via `JSON.stringify`; the full object ships in PATCH.
  - UI source of full frontmatter: `apps/web/src/components/triggers/trigger-form.tsx:161-166` — `emitFrontmatter(patch)` spreads `...fm` into onChange's frontmatter.
- **Cluster:** A / Standalone
- **Status:** RESOLVED
- **Why tests missed it:** Server unit tests sent `{frontmatter:{enabled:true}}` (server-API shape). Web tests mock the API at the hook layer and don't assert the wire shape against the server. The `[[feedback_mock-the-wire-not-the-response]]` pattern from Phase 2 applies here too.
- **Root cause:** Lock predicate compared key *presence*, not value diff. A client that echoes the full frontmatter shape on every save tripped a guard intended to block *real* changes.
- **Fix:** server-side, `apps/server/src/services/documents.ts` — lock now compares each frontmatter key against `existing.frontmatter` via `JSON.stringify` and rejects only when a key OTHER than `enabled` differs in *value*. Matches the error message's promise. Regression test in `apps/server/src/services/documents.test.ts` pins the UI-shape PATCH succeeds, real protected-key change still 422s.
- **Re-sweep:** ✅ Live curl confirmed: UI-shape PATCH → 200; `on_event` value change → 422; title change → 422.

### BUG-005 [BLOCKER, security] — Tools-widening / scope escalation via `create_agent` / `update_agent` — **RESOLVED**

- **Found by:** Multi-reviewer security pass (post-sweep)
- **What happened:** `assertAgentAllowListWidening` gated `frontmatter.projects` but nothing gated `frontmatter.tools`. An agent-bound token with `agents:write` + a narrow toolset could call `create_agent` with broader `tools`; `createDocument` then minted a child token via `toolsToScopes(tools)` that inherited scopes (`documents:delete`, `agents:write`, …) the parent never had. One-call instance-wide privilege escalation. Same hole on `update_agent` (patch path).
- **Expected:** Mirror the projects guard: an agent-bound caller's `next.tools ⊆ callingAgent.tools` on both create and patch.
- **Where:**
  - `apps/server/src/lib/agent-guards.ts` — guard module (had `assertAgentAllowListWidening`, missing the tools sibling).
  - 4 call sites: `apps/server/src/routes/workspace-documents.ts:63, 131` (HTTP create + patch), `apps/server/src/routes/mcp.ts:1021, 1080` (MCP create + patch).
- **Cluster:** B / Standalone
- **Status:** RESOLVED
- **Root cause:** Phase 2.6 D8 added `agents:write` scope + `toolsToScopes`-derived child-token minting without symmetric defense-in-depth. The widening guard was authored for `projects` only.
- **Fix:**
  - New `assertAgentToolsWidening(token, nextFrontmatter, op)` in `apps/server/src/lib/agent-guards.ts` — same signature shape as the projects guard, throws `TOOLS_WIDENING_FORBIDDEN` (403). Sessions + human PATs bypass (consistent with projects). Calling agent malformed/missing `tools` → fail-closed with distinct `CALLING_AGENT_INVALID_TOOLS` (500).
  - Wired into all 4 entrypoints.
  - `rethrowAgentGuardAsMcp` updated to translate `TOOLS_WIDENING_FORBIDDEN` → MCP `-32602` with `reason: 'tools_widening_forbidden'`.
  - 4 new regression tests in `apps/server/src/routes/workspace-documents.test.ts` (BUG-005 prefix): POST rejects widening, POST allows subset, PATCH rejects widening, human-PAT bypass preserved.
- **Re-sweep:** ✅ Live MCP call from an agent-bound token tried to mint a child with `delete_document` → blocked with `tools_widening_forbidden`. Subset `list_documents` → 201 (allowed).

### BUG-006 [BLOCKER, performance] — Hot-spin SSE polling loop — **RESOLVED**

- **Found by:** Multi-reviewer performance pass (post-sweep)
- **What happened:** `apps/server/src/routes/events.ts:221-237` polled `queue.length` every 100ms via `setTimeout` even when no events were pending. Every open SSE connection burned ~10 idle wakeups/sec — on the explicit Phase 2.6 fan-out target (N agents + N browsers per workspace), this becomes 20·N idle wakeups/sec doing nothing.
- **Expected:** Event-driven wakeup — the loop awaits a promise that the bus handler resolves on push (and the abort handler resolves on abort). Heartbeat stays independent at 30s.
- **Where:** `apps/server/src/routes/events.ts:221-237`.
- **Cluster:** Standalone
- **Status:** RESOLVED
- **Root cause:** v1 shape was the simplest correct delivery loop; the polling was a known-acceptable tradeoff that became unacceptable now that Phase 2.6 multiplies subscriber counts (agents + browsers + Phase 3's runner each open at least one connection).
- **Fix:** introduced a per-connection `wake()` / `waiter` promise pair. Bus handler resolves `wake()` after pushing to queue; abort handler also calls `wake()` so the loop exits promptly. Loop drains the queue, then `await waiter` until something happens. No idle work, sub-millisecond delivery latency. All 17 existing SSE tests + 30+ replay tests continue to pass.
- **Re-sweep:** ✅ Live test — subscribed via curl, wrote 5 documents in a tight loop, all 5 `document.created` events streamed back in real time.

### BUG-002 [IMPORTANT] — `create_agent` MCP tool advertises `slug` but silently ignores it — **OPEN**

- **Found by:** Automated MCP tools/call
- **What happened:** `tools/call create_agent` with `{slug: "copywriter", title: "Copy Bot", ...}` returned a doc with `slug: "copy-bot"` (slug derived from title; client `slug` silently dropped). No warning, no error.
- **Expected:** Either honour the client-supplied `slug`, or remove `slug` from `inputSchema` and document slug-from-title behavior in the tool description. Current state is a contract lie that future MCP clients (Plane, Cursor, etc.) will trip on.
- **Where:**
  - Schema declares it: `apps/server/src/routes/mcp.ts:1003-1010` (`slug` listed in `create_agent.inputSchema.properties`).
  - Handler ignores it: `apps/server/src/routes/mcp.ts:1013-1044` — only `title`/`body`/`frontmatter` are read.
- **Cluster:** Standalone
- **Status:** OPEN
- **Suggested fix shape:** drop `slug` from `create_agent.inputSchema.properties` and add one sentence to the description: "Slug is derived from `title`; use `update_agent` on the returned slug for subsequent edits." Cheapest fix, no behavior change.

### BUG-003 [MINOR] — Milkdown teardown "removeEventListener is not defined" after web vitest finishes — **OPEN**

- **Found by:** Automated (`bun run test` in apps/web)
- **What happened:** First run reported `Test Files: 92 passed | Tests: 533 passed | 8 skipped` then printed 7 uncaught `ReferenceError: removeEventListener is not defined` from `@milkdown/ctx`'s internal timer; script exited 1. (Subsequent runs were clean — likely transient.)
- **Expected:** Exit 0 when all tests pass. CI gating on the script's exit code would see a failing build.
- **Where:** Milkdown ctx timer firing after jsdom is torn down. Stack trace pointed at `apps/web/src/components/comments/comments-tab.test.tsx` and any other test mounting Milkdown.
- **Cluster:** Standalone
- **Status:** OPEN (intermittent — second run did not surface the errors)
- **Suggested fix shape:** explicit Milkdown teardown helper (`await editor.destroy()`) invoked from `afterEach` in every test that mounts the editor.

### BUG-004 [MINOR / DEFER] — Web bundle 1.7 MB raw / 532 KB gzip exceeds 500 KB warning — **OPEN, recommend DEFER**

- **Found by:** `bun run build`
- **What happened:** `apps/web/dist/assets/index-…js` is 1,688 KB raw / 532 KB gzip. Vite's `chunkSizeWarningLimit: 500` trips.
- **Expected:** Either code-split (router-level lazy chunks) or bump the warning limit. The single-binary distribution still works.
- **Where:** Likely culprits are Milkdown + ProseMirror + dnd-kit + TanStack Router in the entry chunk.
- **Cluster:** Standalone
- **Status:** OPEN — **recommend DEFER to a dedicated frontend-perf plan** (Phase 7 — UX polish).

---

## Reviewer backlog (NOT blocking merge)

The multi-reviewer pass surfaced **23 SHOULD-FIX + 24 NICE-TO-HAVE** items beyond the BLOCKERs above. None are merge-blocking; they're recorded here so we don't lose the work.

### Simplicity (code-simplicity-reviewer)

SHOULD-FIX (8):
- `workspace-activity-panel.tsx` + `workspace-log-activity-button.tsx` are near-duplicates of their project-scoped siblings. ~100+ LOC + tests duplicated. Thread `pslug` through the originals or pass the hook as a prop.
- `lib/event-bus.ts:19-21,49-52` + `routes/events.ts:36-37,137-140,175` — `runId` SSE filter has no emitter writing `payload.run_id` in Phase 2.6. Ship with Phase 3 runner.
- `lib/comment-schema.ts:10` + `lib/api/comments.ts:17` + `routes/mcp.ts:778` — `kind: 'reply'` enum value is unused; spec labels it "callcenter pack" (parked). Drop until callcenter ships.
- `lib/comment-schema.ts:39` + `services/comments.ts:511` + `comment-row.tsx:233,264` + `copy-as-md.ts:41` — `run_id` frontmatter field plumbed everywhere but never written in 2.6. Drop until Phase 3 wires it.
- `services/comments.ts:79-86` + `routes/comments.ts:82-105` — `AuthorContext.agentSlug` is dead weight; only `agentId` is canonical. Drop the slug round-trip query.
- `comments-tab.tsx:43,184,382` + `comment-row.tsx:25,187,231` — `currentAgentSlug` plumbed through 3 components, always passed `null`. Pure YAGNI.
- `comment-row.tsx:28` — `workspaceAgents?` is optional with `?? []` fallback, but every caller passes it. Make it required.
- `scripts/backfill-builtin-triggers.ts:70-93` — duplicates the insert + emit loop from `seedBuiltinTriggers`. Should call it directly; also `builtinSlugs.includes(def.slug)` at line 64 is tautological.

NICE-TO-HAVE (10): impossible-scenario null guards in `services/comments.ts`; dead inner try/catch in `comment-composer.tsx:153-159`; Milkdown DOM `innerHTML` workaround in `comment-composer.tsx:73-141`; mention-parser POS1_ADJACENCY_ALLOW set could collapse to just-pos1; ugly conditional spread in comments service `506-512`; `agent-event-visibility.ts` comment-to-code ratio; `agent-guards.ts:88-101` H16 distinct error code with no UI consumer; `events.ts:107-159` G10 rollback-scrub belt-and-braces; `builtin-triggers.ts:33-88` four hand-rolled defs could share a builder; `trigger-form.tsx:97-122` split-brain controlled-component pattern that exists for tests.

### Security (security-sentinel)

SHOULD-FIX (4):
- **`workspace-documents.ts:172-223`** — `POST /:slug/activity` enforces only `documents:write` and no agent-self check. An agent-bound token can write `activity.logged` events into another agent's history. H7 covers the read side; mirror it on write. **Cross-agent activity forgery.**
- **`routes/comments.ts:54 + 130-172`** + **`services/comments.ts:271`** — `kind` accepted from clients without restricting privileged values (`plan`/`result`/`error`). Any user/agent with `documents:write` can post a fake `result` comment impersonating Phase 3 runner output.
- **`services/documents.ts:643-654`** — prototype-pollution sink on `documents.frontmatter` merge. `z.record(z.unknown())` accepts `__proto__` as a key. Strip `__proto__`/`constructor`/`prototype` before merge or use `Object.create(null)`.
- **`routes/events.ts:78-83`** — SSE `Last-Event-Id` anchor lookup has no workspace filter. Workspace filter applies on the row query but the anchor existence check leaks across workspaces. Tighten with `and(eq(events.id, lastEventId), eq(events.workspaceId, ws.id))`.

NICE-TO-HAVE (5): policy-widening for `requires_approval`/`max_delegation_depth`/`max_tokens_per_run` (same shape as BUG-005 fix when Phase 3 lands); `comment-composer.tsx:122` `innerHTML` escapes only `<`; `middleware/bearer.ts:42-47` silent user-substitution on null creator → 500 instead of 401; `agent-event-visibility.ts:91-97` slug-vs-id discipline (use id first); `documents.ts:454-462` delegation guard fetches all agents instead of using `token.agentId` directly.

### Performance (performance-oracle)

SHOULD-FIX (5):
- **`lib/events.ts:56-59`** — `emitEvent` runs `SELECT MAX(seq)` per insert. Multi-mention comments do N+1 lookups per write. Switch `seq` to `INTEGER PRIMARY KEY AUTOINCREMENT` and drop the MAX lookup.
- **`lib/reconciler.ts:50-53`** — pulls full agent rows (incl. multi-KB body markdown) for every agent every interval just to read `frontmatter.projects`. Narrow the projection.
- **`services/comments.ts:705-709`** + **`migrations/0007:50`** — `desc(createdAt), desc(id)` defeats the new partial index because nanoid `id` is random-order. Drop the `id` tiebreaker.
- **`services/comments.ts:643-665`** — `json_extract(frontmatter, '$.kind')` filters in `listComments` skip indices. Promote `kind` to a column next rebuild.
- **`routes/events.ts:50-54`** + **`routes/comments.ts:88-97`** + **`routes/mcp.ts:186-238`** — every agent-bound request re-queries the agent row. Cache resolved agent on the `token` row in `attachToken` middleware (one query at auth time).

NICE-TO-HAVE (4): drop redundant `events_workspace_idx`; mirror `documents_comments_idx` in `schema.ts` so Drizzle doesn't DROP it next generate; shard `event-bus.ts` subs as `Map<workspaceId, Set<Sub>>` for O(1) lookup; gate `useComments` behind `tab === 'comments'` so list views don't fetch per-row.

### Architecture (architecture-strategist)

SHOULD-FIX (8):
- **`services/documents.ts:778-787`** — parent-delete cascade hard-deletes child comments with NO `comment.deleted` events. Violates the "every write emits an event" wedge.
- **`routes/mcp.ts:766-981`** + **`shared/mcp-tools.ts:10-29`** — 4 comment MCP tools dispatch but are NOT in `V1_MCP_TOOLS`; gated only by `documents:*`. Bypass the per-agent tool allow-list.
- **`db/schema.ts:208-254`** — `documents_comments_idx` partial WHERE-type='comment' index not in Drizzle schema source-of-truth. Next `db:generate` may DROP it.
- **`services/comments.ts:362-403` + `299-340`** — `comment.created` payload omits `visibility`. SSE subscribers receive notification of internal-comment existence even when filtered from REST list.
- **`services/comments.ts:339, 373, 510` + `lib/mention-parser.ts:42-44`** — `target_agent` persisted as slug only. `ApprovalIntent.targetAgentId` is computed and discarded. Phase 3 will hit the same slug-rename hijack vector that drove migration 0008.
- **`lib/builtin-triggers.ts:105-131` + `scripts/backfill-builtin-triggers.ts:70-93`** — both seed paths write to `documents` directly, bypassing `triggerFrontmatterSchema`. Future schema additions will diverge.
- **`scripts/backfill-builtin-triggers.ts`** — Bun script outside the compiled binary. Violates ONE BINARY commitment. Expose as `./folio migrate-builtins` subcommand or auto-run idempotently at boot.
- **`shared/src/index.ts`** — `DocumentType` still `'work_item' | 'page'`; server schema accepts 5. Five drift sites re-enumerate locally.

NICE-TO-HAVE (5): drop dead `agentSlug` from `AuthorContext`; explicit IMMEDIATE/EXCLUSIVE on `emitEvent` transaction; consistent `created_by` policy on agent-authored comments; promote `Comment = Document & {frontmatter: CommentFrontmatter}` helper; add `$event.agent_id` placeholder to builtin trigger grammar.

---

## What was NOT swept but is covered by passing tests + Playwright

- Tabbed slideover rendering on every type (work_item/page/agent/trigger) — `workspace-document-slideover.test.tsx` + Playwright `manual-qa.spec.ts` scenarios
- Mention picker filtering — `mention-picker.test.tsx`
- TriggerForm rendering & schedule/event toggle — `workspace-document-slideover.test.tsx` "trigger slideover Fields tab renders TriggerForm"
- Comments tab rendering, composer, optimistic mutate — `comments-tab.test.tsx`, `comment-composer.test.tsx`
- Reconciler periodic loop — `reconciler.test.ts` covers the logic; the boot-time `setInterval` was sanity-checked via the `[folio] reconciler enabled (interval: 3600000ms)` log line on real boot.
- Migration journal — 11 files match 11 entries in `_journal.json`; migrations apply cleanly on a fresh DB.

---

## Fix Log

| Bug | Attempts | Root Cause | Fix | Re-sweep |
|-----|----------|-----------|-----|----------|
| BUG-001 | 1 | Lock compared key presence, not value diff | `services/documents.ts` → value-diff lock; regression test | PASS |
| BUG-005 | 1 | `assertAgentAllowListWidening` didn't gate `tools` field; child token minted via `toolsToScopes` inherited extra scopes | `lib/agent-guards.ts` new `assertAgentToolsWidening`; wired into 4 entrypoints; MCP error rethrow; 4 regression tests | PASS |
| BUG-006 | 1 | 100ms-poll on idle SSE connections | `routes/events.ts` event-driven `wake()` / `waiter` promise pair | PASS (live + 17 SSE unit tests) |

---

## Final Status

**Resolved (this session):** 3 BLOCKERs (BUG-001, BUG-005, BUG-006)
**Open (non-blocking):** 1 IMPORTANT (BUG-002), 1 MINOR (BUG-003), 1 MINOR/DEFER (BUG-004), 23 reviewer SHOULD-FIX, 24 reviewer NICE-TO-HAVE
**Deferred (recommended):** BUG-004 (Phase 7 frontend-perf), most NICE-TO-HAVE backlog
**New bugs found during fix:** none
**Test totals after fixes:** server 495 / web 537 / shared 46 / scripts 6 / Playwright 28 — all green; server + web typecheck clean
**Final sweep:** ✅ all three BLOCKER scenarios verified live against a freshly booted server
