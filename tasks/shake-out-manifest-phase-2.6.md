# Bug Manifest — Folio Phase 2.6

**Generated:** 2026-05-27
**Last updated:** 2026-05-27 (post-tier-1-2-3-fix)
**Spec:** `docs/superpowers/specs/2026-05-26-phase-2.6-comments-and-tabbed-slideover-design.md`
**Branch:** `phase-2.6/comments-and-slideover` (base `8df3f2f`, now ~130 files / +21K LOC after fixes)
**Build status:** server typecheck clean / web typecheck clean / server 524 pass / web 547 pass / shared 46 pass / scripts 7 pass
**Sweep status:** Track A (automated against booted server on a fresh DB) complete; Track B (manual browser walkthrough) is `apps/web/tests/manual-qa-phase-2.6.md` — 40 scenarios already authored, user-side

---

## Summary

**21 issues found total:** 3 BLOCKERs (shake-out) + 15 code-review findings + 3 deferred (BUG-002 IMPORTANT, BUG-003 MINOR, BUG-004 MINOR/DEFER).

**18 RESOLVED** across two fix sessions:
- 3 BLOCKERs in shake-out session (`977c364`): BUG-001, BUG-005, BUG-006.
- 15 tier-1/2/3 findings in code-review fix session (`fd4ced2`..`b0d8c0d`): BUG-007 → BUG-021.

**3 OPEN, all non-blocking:** BUG-002 (MCP slug schema), BUG-003 (intermittent Milkdown teardown), BUG-004 (bundle size — defer to Phase 7).

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

## Code-review findings (post-shake-out, 2026-05-27)

After the three BLOCKER fixes in `977c364`, a full `/code-review --base=main --effort=high` pass on the Phase 2.6 branch surfaced **15 additional defects** verified by independent reviewer agents (9 finders + 6 verifiers + 1 sweep). These are NOT in the shake-out cluster sweep — they're the second-pass formal review.

**Tiering for the next session:**
- **TIER 1 — must-fix-before-merge (security / data integrity exploits):** BUG-007, BUG-008, BUG-009, BUG-010, BUG-011, BUG-014.
- **TIER 2 — important correctness (data is wrong now):** BUG-012, BUG-013, BUG-015, BUG-016, BUG-017, BUG-021.
- **TIER 3 — cleanup (low-impact correctness gaps):** BUG-018, BUG-019, BUG-020.

### BUG-007 [TIER 1 / security] — Token presets bundle `agents:write` — **RESOLVED**

- **Where:** `apps/web/src/components/settings/token-create-modal.tsx:44, 58`
- **What happened:** Both 'Read + write' and 'Full access' PAT presets include `'agents:write'` in their scopes. Human PATs (no agentId) bypass `assertAgentAllowListWidening` and `assertAgentToolsWidening` — every preset-minted PAT can mint, widen, or delete any agent in the workspace.
- **Failure scenario:** Admin creates a CI PAT via 'Read + write' expecting docs/fields write. Anyone with that CI secret can `POST /api/v1/w/<ws>/documents` with `type: 'agent', frontmatter.tools: [...]` to mint an agent whose child token inherits any scope; can also widen any existing agent's `frontmatter.projects` to `['*']`. The 'dangerous' tone is only on 'Full access', but 'Read + write' carries the same agent-management capability silently.
- **Suggested fix:** Remove `'agents:write'` from both presets. Add a separate 'Manage agents' preset gated behind danger styling, OR require users to tick `agents:write` manually if they actually need it.
- **Test that should pin it:** new web test asserts `PRESETS['Read + write'].scopes` does NOT include `'agents:write'`.

### BUG-008 [TIER 1 / data integrity] — Backfill bypasses `txWithEvents` — **RESOLVED**

- **Where:** `scripts/backfill-builtin-triggers.ts:70`
- **What happened:** Backfill uses raw `db.transaction(async (tx) => { ... await emitEvent(tx, ...) })`. `emitEvent`'s deferred-publish branch only engages inside `txWithEvents` (which populates the `pendingByTx` WeakMap). With raw `db.transaction`, `emitEvent`'s fallback fires `eventBus.publish` IMMEDIATELY while the tx is still open. If a subsequent insert throws or bun-sqlite's phantom-rollback fires, SSE subscribers receive ghost trigger events whose rows never persist.
- **Failure scenario:** Operator runs backfill on a workspace where one builtin slug collides with a re-seed race. Inserts 1+2 already published `document.created` to live SSE (Phase 3 dispatcher kicks off runs against ghost trigger ids). Insert 3 throws; tx rolls back; rows disappear. Last-Event-Id replay can't redeliver (no anchor row). Live + durable views permanently diverge.
- **Suggested fix:** Wrap the loop body in `txWithEvents(actor, async (tx) => { … })` so each insert's events sit in the pending queue until commit. Drop `eventBus` import from the script if no longer needed.
- **Test that should pin it:** integration test that injects a mid-loop throw and asserts zero `eventBus.publish` calls fired.

### BUG-009 [TIER 1 / security] — Mention parser is code/blockquote-blind — **RESOLVED**

- **Where:** `apps/server/src/lib/mention-parser.ts:8` (TOKEN_RE)
- **What happened:** Parser walks the raw comment body with no markdown awareness. `@`-mentions inside backtick inline-code, fenced ` ```code``` ` blocks, and `> ` blockquotes all match TOKEN_RE and trigger the approval-keyword scan. The pos-1/2 window then upgrades them to `kind: 'approval'`.
- **Failure scenario:** User posts `> @drafter approved this last week.` (quoting a prior decision). Server overrides the comment kind to `approval`, persists `target_agent: 'drafter'`. Builtin-on-approval trigger fires; once Phase 3 dispatch ships, this resumes the agent run. One-comment privilege escalation primitive — quoting a past approval counts as a new one. Same trick with inline code and fenced blocks.
- **Suggested fix:** Pre-process the body to mask out fenced-code (` ```…``` `), inline-code (` `…` `), and blockquote-prefixed (`> `) lines before TOKEN_RE runs. OR: parse via a tiny markdown AST (no external dep — a regex sweep that replaces those spans with spaces of equal length preserves positions for keyword detection).
- **Test that should pin it:** unit tests in `mention-parser.test.ts` for each of: ` `@drafter approved` `, ` ```\n@drafter approved\n``` `, `> @drafter approved`. All three should return `approvalIntent: null` and `mentions: []`.

### BUG-010 [TIER 1 / data integrity] — Recursive cascade emits no comment.deleted + bypasses author-only guard — **RESOLVED**

- **Where:** `apps/server/src/services/documents.ts:778-791` (recursive CTE) vs `:746-752` (top-level author guard) — partial overlap with the shake-out reviewer's shallow finding; this is the recursive widening.
- **What happened:** Parent-delete cascade uses a raw recursive CTE that hard-DELETEs all descendants (comments + nested pages + grandchildren). No per-row `comment.deleted` or `document.deleted` events emit. The cascade also bypasses the `COMMENT_REQUIRES_COMMENT_TOOL` guard at line 746 (which only checks `existing.type === 'comment'` on the top-level delete target).
- **Failure scenario:** Owner deletes work_item W with 50 comments (5 different authors) and 3 nested pages each with their own comments. CTE wipes all in one SQL statement. Only the W-level `document.deleted` event hits the bus. Comment authors get no signal; UIs caching the thread stale-display indefinitely; Phase 3 audit log records "1 deletion" for what was 50+ removals. Author-only invariant the direct-delete path enforces is dead-letter for cascaded comments.
- **Suggested fix shape:** Either (a) fan out per-descendant events in the same tx (requires walking descendants in TS first, not raw CTE — slower but honours the wedge); OR (b) introduce a new `parent.cascade.deleted` event kind carrying `{parent_id, descendant_count, descendant_ids: string[]}` that subscribers can use to invalidate. Phase 3 dispatcher needs to subscribe to it.
- **Test that should pin it:** integration test that deletes a parent with comments by 2 different authors and asserts SSE delivers `comment.deleted` (or `parent.cascade.deleted` with both ids) before the connection closes.

### BUG-011 [TIER 1 / security] — deleteComment author-fingerprinting oracle — **RESOLVED**

- **Where:** `apps/server/src/services/comments.ts:553` (`assertAuthor`) runs BEFORE the soft-delete idempotency guard at `:563`.
- **What happened:** A second delete by a non-author of an already-soft-deleted comment returns 403 `COMMENT_AUTHOR_ONLY`. A second delete by the original author returns 200 with the row. The 403/200 distinction lets a hostile narrowed agent fingerprint historical authorship by enumerating slugs.
- **Failure scenario:** Hostile narrowed agent A lists comments it can see (across the project), then issues `DELETE /comments/<slug>` for each. Each 403 reveals "agent A is NOT the author"; each 200 reveals "agent A IS the author". Over time the agent maps comment-authorship across the workspace — a real-world fingerprinting oracle for prior agent activity.
- **Suggested fix:** Move the idempotency check BEFORE `assertAuthor`. Any caller deleting an already-soft-deleted comment gets 200 (or 204) regardless of authorship; `assertAuthor` only fires on the live-delete path.
- **Test that should pin it:** integration test where agent B (non-author) deletes a soft-deleted comment authored by A, asserts 200 (not 403).

### BUG-012 [TIER 2 / correctness] — Visibility ignores `payload.agent_id` — **RESOLVED**

- **Where:** `apps/server/src/lib/agent-event-visibility.ts:91-97` (the `agent.task.assigned` branch).
- **What happened:** S2 (in `services/documents.ts:515`) now writes `payload.agent_id` into the event so subscribers tolerate renames. But the visibility predicate that decides which SSE subscriber sees an assignment STILL uses `payload.agent === ctx.agentSlug` (slug-only).
- **Failure scenario:** Agent 'drafter' opens SSE (ctx.agentSlug='drafter' captured at connect). Owner renames the agent to 'writer'; new assignment emits `payload.agent='writer'`, `agent_id=<id>`. Visibility tests `'writer' === 'drafter'` → false. Renamed agent doesn't see assignments on the live stream OR on Last-Event-Id replay until reconnect.
- **Suggested fix:** Match on `payload.agent_id === ctx.agentId` first (when both present), fall back to slug-match for legacy events with no agent_id field. Same shape S2 expected for assignment subscribers.
- **Test that should pin it:** test that subscribes as agent A, renames A to B in DB, emits `agent.task.assigned` with `agent_id: A.id` + `agent: 'B'`, asserts the original subscriber receives it.

### BUG-013 [TIER 2 / correctness] — `target_agent` persisted as slug only — **RESOLVED**

- **Where:** `apps/server/src/services/comments.ts:240` discards `approvalIntent.targetAgentId`; line `:336` persists `frontmatter.target_agent = <slug>`.
- **What happened:** `mention-parser` already returns the immutable `targetAgentId`, but `resolveKindAndTarget` only forwards the slug. Same rename-hijack class as F11/S2 explicitly fixed for assignments.
- **Failure scenario:** User comments `@drafter approved`. Stored `frontmatter.target_agent='drafter'`. Owner renames the agent to 'writer'. ApprovalButtons does `agents.find(a => a.id === target || a.slug === target)` — neither matches 'drafter' anymore. Historical approvals lose their bound agent in the UI and in any Phase 3 dispatcher resolving through this field.
- **Suggested fix:** Add `target_agent_id: string | undefined` alongside `target_agent` in `commentFrontmatterSchema` (or replace the slug field entirely). Plumb the id through `resolveKindAndTarget` → service → frontmatter. Backfill via migration 0011 (mirror 0008's pattern).
- **Test that should pin it:** integration test that creates approval comment, renames the target agent, asserts the UI / API still resolves the original target.

### BUG-014 [TIER 1 / correctness] — `innerHTML` escape only handles `<` — **RESOLVED**

- **Where:** `apps/web/src/components/comments/comment-composer.tsx:122`
- **What happened:** `dom.innerHTML = \`<p>${resetTo.replace(/</g, '&lt;')}</p>\`` only escapes `<`. Misses `&`, `>`, `"`, named entities, numeric entities. The browser decodes any HTML entity in `resetTo` on parse.
- **Failure scenario:** User types `Send me &amp;company list` and triggers a mention picker (or wiki-link picker). `replaceTrigger` rebuilds body, the reset effect writes the new body via `innerHTML`, browser decodes `&amp;` → `&`. Submit posts the corrupted body. localStorage draft also diverges. Round-trip MD wedge violated — typed source ≠ stored source.
- **Suggested fix:** Replace the `innerHTML` write with `dom.textContent = resetTo` inside a child `<p>` element built via `createElement` + `appendChild`. OR: switch to Milkdown's real content-replace API (a known TODO per the existing comment).
- **Test that should pin it:** Vitest test types `&amp; ` then triggers `@`, asserts the final body POSTed = original-with-mention-appended (no entity decoding).

### BUG-015 [TIER 2 / operability] — Migration 0009 promises trigger backstop that doesn't exist — **RESOLVED**

- **Where:** `apps/server/src/db/migrations/0009_phase_2_6_events_seq.sql:9` (comment promises 'AFTER INSERT trigger backstops any direct-insert path'); grep `CREATE TRIGGER` across the entire repo returns zero hits.
- **What happened:** The backstop the migration comment promises does not exist. Direct inserts into `events` that omit `seq` fall back to DEFAULT 0; the second such insert collides on `events_seq_idx` UNIQUE.
- **Failure scenario:** Future bulk-importer or admin script inserts into `events` without going through `emitEvent`. First row gets seq=0; second row's insert errors `UNIQUE constraint failed`. Operator reading the migration comment assumes the trigger is in place and wastes debug time.
- **Suggested fix:** Either (a) add the promised trigger in a new migration 0011 — `CREATE TRIGGER events_seq_auto AFTER INSERT ON events WHEN NEW.seq = 0 BEGIN UPDATE events SET seq = (SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE workspace_id = NEW.workspace_id) WHERE rowid = NEW.rowid; END;` — OR (b) delete the misleading comment lines in 0009 and document that direct inserts are unsupported.
- **Test that should pin it:** migration test that inserts a row via raw `db.run('INSERT INTO events (id, workspace_id, kind, created_at) VALUES (?, ?, ?, ?)', ...)` (no seq) twice and asserts both succeed with monotonic seqs.

### BUG-016 [TIER 2 / correctness] — Trigger PATCH skips cross-field refine — **RESOLVED**

- **Where:** `apps/server/src/services/documents.ts:637` uses `triggerFrontmatterSchema.innerType().partial()` to validate the PATCH payload, deliberately stripping the cross-field refine that requires `schedule!==null || on_event!==null`. The merged document is never re-validated against the create schema.
- **What happened:** Existing trigger `{schedule:'0 * * * *', on_event:null}` PATCHed with `{schedule:null}` validates fine (refine gone; on_event omitted in partial). Merged doc becomes `{schedule:null, on_event:null}` — a state the create schema would reject. Dispatch never fires.
- **Failure scenario:** User edits a trigger to "pause it temporarily" by clearing the schedule, intends to set on_event next, gets distracted. Trigger persists in a state the create schema would have rejected. Operator sees the trigger row in the UI but zero runs and no error feedback. Same hazard applies to clearing on_event when schedule is null.
- **Suggested fix:** After computing `merged = { ...existing.frontmatter, ...patch.frontmatter }`, run the full `triggerFrontmatterSchema.parse(merged)` and return its error as `INVALID_PATCH` if it fails.
- **Test that should pin it:** service test that PATCHes a schedule-only trigger with `{schedule:null}` and asserts the call rejects with `INVALID_PATCH`.

### BUG-017 [TIER 2 / UX data loss] — handleSaveEdit closes editor on PATCH failure — **RESOLVED**

- **Where:** `apps/web/src/components/comments/comments-tab.tsx:265-268` (handleSaveEdit), `:296-299` (handleDeleteConfirm).
- **What happened:** Both `finally` blocks unconditionally call `setEditingSlug(null)` / close the dialog, regardless of mutation outcome. On PATCH/DELETE failure, the optimistic rollback restores the original body, the editor is gone, the user's typed edit is lost.
- **Failure scenario:** User opens inline-edit on a comment, types a long correction, hits Save. Server returns 422 (body too large, transient 500, etc.). `useUpdateComment.mutate` rejects → catch swallows → finally closes editor. Comment snaps back to original; user must click Edit and re-type from scratch with no indication WHY the save failed. The mutation hook's toast may surface the error briefly but the typed text is unrecoverable.
- **Suggested fix:** Move the close-editor calls into the `onSuccess` branch only. On error, keep the editor open with the typed text intact so the user sees the toast + can retry.
- **Test that should pin it:** Vitest test that mocks updateComment to reject; asserts the textarea retains the user's typed value AND the editor is still rendered.

### BUG-018 [TIER 3 / correctness gap] — listWorkspaceDocuments bypasses resolveAgentProjects — **RESOLVED**

- **Where:** `apps/server/src/services/documents.ts:862` parses `frontmatter.projects` directly via `Array.isArray + includes`, bypassing `resolveAgentProjects`. (Companion finding: `routes/projects.ts:130` cascade does the same — both should route through the helper.)
- **What happened:** S1 was meant to consolidate the contract that missing/non-array `frontmatter.projects` means `['*']` (workspace-wide). Bearer/SSE/mention-parser route through `resolveAgentProjects`; this filter and the project-delete cascade don't.
- **Failure scenario:** Legacy pre-2.5 agent (or hand-imported markdown agent) has no `frontmatter.projects`. Bearer grants workspace-wide; SSE replay agrees; mention-parser agrees. But `GET /api/v1/w/<ws>/documents?type=agent&project=<pid>` omits the agent from the picker. Operators report "why won't this agent show up in this project's assignee dropdown?".
- **Suggested fix:** Replace direct parsing with `resolveAgentProjects(agentRow)` in `listWorkspaceDocuments`. Audit `routes/projects.ts:130` (cascade scrub) at the same time for the same drift.
- **Test that should pin it:** integration test that seeds an agent with no `frontmatter.projects`, asserts it appears in the result of `GET /documents?type=agent&project=<any>`.

### BUG-019 [TIER 3 / contract] — Bare `await c.req.json()` returns 500 instead of 422 — **RESOLVED**

- **Where:** `apps/server/src/routes/workspace-documents.ts:51, 132` (POST + PATCH); also `apps/server/src/routes/documents.ts:75, 310`. `routes/comments.ts:146-150, 234-238` and `documents.ts:343-344` correctly wrap in try/catch.
- **What happened:** Invalid or empty body throws an unwrapped SyntaxError; surfaces as Hono's default 500/400, not the documented `{ error: { code: 'INVALID_BODY' }, 422 }`.
- **Failure scenario:** Agent sends `POST /api/v1/w/<ws>/documents` with empty body, malformed JSON, or just whitespace. Server returns 500 with a stack trace; code-by-name client handlers fall through to a raw 500 toast; agents retrying on transient 5xx but treating 4xx as terminal retry forever.
- **Suggested fix:** Copy the try/catch + HTTPError pattern from `routes/comments.ts:146-150` at all 4 sites.
- **Test that should pin it:** integration tests for each of the 4 sites posting `''` and `'{title:}'`; assert 422 `INVALID_BODY`.

### BUG-020 [TIER 3 / UX] — Optimistic comment id collision + bad parentId/projectId — **RESOLVED**

- **Where:** `apps/web/src/lib/api/comments.ts:141-147`
- **What happened:** Optimistic create sets `id` AND `slug` to `optimistic-${Date.now()}`. Two creates in the same millisecond (automation, Playwright double-click, agent batch) collide on React key. The optimistic object also sets `parentId: parentSlug` (a slug, not the parent's UUID), `projectId: ''`, and `workspaceId: ''` — any consumer reading those fields drops the optimistic row.
- **Failure scenario:** Two `useCreateComment.mutate` calls fire in the same tick. Both `onMutate` blocks compute the same `optimistic-<ms>` id. React logs `Encountered two children with the same key`; the second render drops a row. When the slower mutation's `onSettled` lands before the faster, cache invalidation reorders comments — the user's first message briefly disappears.
- **Suggested fix:** Use `crypto.randomUUID()` for the optimistic id/slug. Pass real parent UUID (the parent document is loaded in the slideover; that's the natural source). Pass `wsId`/`projectId` from the resolved hook scope or omit those fields from the optimistic row entirely.
- **Test that should pin it:** Vitest test that fires two `useCreateComment.mutate` calls in the same tick, asserts no duplicate React key warnings.

### BUG-021 [TIER 2 / correctness] — Bus filter drops workspace events for `?project=` subs — **RESOLVED**

- **Where:** `apps/server/src/lib/event-bus.ts:44` (live filter); same shape in `apps/server/src/routes/events.ts:124` (replay loop).
- **What happened:** `if (sub.filter?.projectId !== undefined && sub.filter.projectId !== e.projectId) continue;` — a subscriber with `?project=X` does NOT receive workspace-level events (`projectId: null`).
- **Failure scenario:** Agent SSEs to `/api/v1/w/<ws>/events?project=proj-1` (sensible default — most events the agent cares about live in its project). The reconciler scrubs an orphan project id from the agent's allow-list, emits `agent.allow_list.reconciled` with `projectId: null`. Bus drops it. Agent never learns its allow-list changed; subsequent writes appear inexplicably forbidden.
- **Suggested fix:** Allow `e.projectId === null` through when `sub.filter.projectId` is set (workspace-level events transcend project scope). Apply the same loosening to the replay loop's filter.
- **Test that should pin it:** SSE test that subscribes with `?project=<X>`, emits a workspace-level event (`projectId: null`), asserts the subscriber receives it.

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

| Bug | Tier | Commit | Root Cause | Fix Summary | Tests |
|-----|------|--------|-----------|-------------|-------|
| BUG-001 | BLOCKER | (shake-out) | Lock compared key presence, not value diff | services/documents.ts → value-diff lock | regression in documents.test |
| BUG-005 | BLOCKER | (shake-out) | `tools` field ungated by widening guard | New `assertAgentToolsWidening`; wired into 4 entrypoints | 4 regression tests |
| BUG-006 | BLOCKER | (shake-out) | 100ms-poll on idle SSE connections | Event-driven `wake()`/`waiter` promise | 17 SSE tests still pass |
| BUG-007 | TIER 1 | `fd4ced2` | Token presets bundled `agents:write` silently | Drop from both `Read+write` + `Full access` presets | 4 web tests updated/added |
| BUG-008 | TIER 1 | `81f77ce` | Backfill used raw `db.transaction`; emitEvent fallback published ghost events on rollback | Swap to `txWithEvents` | 1 script test |
| BUG-009 | TIER 1 | `907be93` | TOKEN_RE walked raw body; mentions in code/quotes triggered approval semantics | Pre-mask fenced code, inline code, blockquote lines | 6 mention-parser tests |
| BUG-010 | TIER 1 | `07aa1df` | Recursive CTE cascade emitted no per-row events | Walk descendants in TS + fan out `comment.deleted` / `document.deleted` per row | 1 service test |
| BUG-011 | TIER 1 | `bf05c50` | `assertAuthor` ran before idempotency guard → 403 vs 200 leaked authorship | Reorder: idempotency first | 1 service test |
| BUG-014 | TIER 1 | `d8abc6a` | innerHTML escape only handled `<` | Extracted `resetEditorContent` helper using createElement+createTextNode | 6 web tests |
| BUG-012 | TIER 2 | `5ad89c3` | Visibility matched on slug only; renamed agents lost assignments | Match `payload.agent_id === ctx.agentId` first, slug as fallback | 3 visibility tests |
| BUG-013 | TIER 2 | `2ab55e8` | `target_agent` slug-only; renames orphaned approvals | New `target_agent_id` field + migration 0011 backfill + service plumbing | 3 service + 8 migration tests |
| BUG-015 | TIER 2 | `6a48a27` | 0009 migration comment promised an AFTER INSERT trigger that doesn't exist | Delete the misleading promise; document direct inserts unsupported | comment-only |
| BUG-016 | TIER 2 | `3b920e3` | Trigger PATCH validator stripped cross-field refine | Re-validate merged frontmatter on triggers; reject INVALID_PATCH if neither schedule nor on_event set | 3 service tests |
| BUG-017 | TIER 2 | `2acd734` | Edit/delete `finally` closed editor regardless of outcome | Move close into success branch | 2 web tests |
| BUG-021 | TIER 2 | `dee03ef` | `?project=X` subs dropped workspace-level events | Loosen filter so projectId=null transcends scope (bus + replay) | 1 bus test |
| BUG-018 | TIER 3 | `82992da` | listWorkspaceDocuments parsed projects directly; legacy rows dropped | Route through `resolveAgentProjects` (also fix vocabulary in projects.ts cascade) | 1 route test |
| BUG-019 | TIER 3 | `cd01442` | Bare `c.req.json()` → 500 on bad body | try/catch + HTTPError at 4 sites | 2 route tests |
| BUG-020 | TIER 3 | `b0d8c0d` | `optimistic-${Date.now()}` collided on same-tick double mutate | Use `crypto.randomUUID()` for id + slug | 1 hook test |

---

## Final Status

**Resolved (2026-05-27 shake-out session):** 3 BLOCKERs (BUG-001, BUG-005, BUG-006) — committed as `977c364`.

**Resolved (2026-05-27 code-review fix session):** 15 findings (BUG-007 through BUG-021) — committed as `fd4ced2`..`b0d8c0d` (15 atomic commits, each w/ failing-test-first → fix → re-run pattern).

**Open from shake-out cluster (not in this session's scope):**
- BUG-002 (MCP `create_agent` slug schema mismatch) — IMPORTANT, OPEN.
- BUG-003 (Milkdown teardown — intermittent jsdom) — MINOR, OPEN.
- BUG-004 (web bundle 1.7MB raw — DEFER to Phase 7) — MINOR, OPEN.

**Reviewer backlog (non-blocking):** 23 SHOULD-FIX + 24 NICE-TO-HAVE from the four shake-out reviewer agents (see "Reviewer backlog" section). Untouched in this session.

**Test totals after all 18 fixes (3 BLOCKER + 15 code-review):**
- Server **524 / 1-skip / 0-fail** (was 495 at end of shake-out; +29 from new regression tests + the 8 migration 0011 tests).
- Web **547 / 8-skip / 0-fail** (was 537; +10 from BUG-007/014/017/020 tests).
- Shared **46 / 0-fail** (unchanged).
- Scripts (backfill) **7 / 0-fail** (was 6; +1 from BUG-008).
- Playwright not re-run in this session — Tier 1 + 2 + 3 changes are server-side or web unit-scope, no e2e flow touched.

**Recommended next session:**
1. Re-run `bun run e2e` to verify Playwright still 28/0 after the cascade/visibility/PATCH-validation changes.
2. (Optional, polish) Wire BUG-002 + BUG-003 + a couple SHOULD-FIX simplicity wins from the reviewer backlog.
3. `/code-review --base=main --effort=high --comment` for a final inline pass on the now-much-larger diff.
4. `superpowers:finishing-a-development-branch` to merge `--no-ff` into main.
