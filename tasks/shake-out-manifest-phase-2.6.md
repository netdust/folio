# Bug Manifest — Folio Phase 2.6

**Generated:** 2026-05-27
**Spec:** `docs/superpowers/specs/2026-05-26-phase-2.6-comments-and-tabbed-slideover-design.md`
**Branch:** `phase-2.6/comments-and-slideover` (base `8df3f2f`, ~110 files / +20.6K LOC)
**Build status:** server typecheck clean / web typecheck clean / server 488 pass / web 533 pass / shared 46 pass / scripts 6 pass / Playwright 28 pass
**Sweep status:** Track A (automated against a booted server on a fresh DB) complete; Track B (manual browser walkthrough) is `apps/web/tests/manual-qa-phase-2.6.md` — 40 scenarios already authored, user-side

---

## Summary

4 issues found: **1 CRITICAL, 1 IMPORTANT, 2 MINOR**

Acceptance criteria 1-10 (spec §10) all pass functionally on the server side. The CRITICAL bug is a UI/server protocol mismatch on builtin-trigger toggle: both halves "work" in isolation, the combination doesn't.

---

## Root Cause Clusters

### Cluster A — Builtin trigger Enabled toggle
- **BUG-001** stands alone. Server lock is correct-by-spec; UI patch path doesn't speak its protocol.
- Fix candidate: server-side change so the lock compares each PATCH frontmatter key against `existing.frontmatter`, rejecting only when a key OTHER than `enabled` differs in value. (Alternative: have the slideover slim-diff frontmatter for builtins. Server-side fix is simpler and matches the error message's promise.)

### Standalone
- **BUG-002** — `create_agent` MCP schema/handler mismatch on `slug`
- **BUG-003** — Milkdown teardown errors after vitest tests finish
- **BUG-004** — Web bundle size warning

---

## Bug List

### BUG-001 [CRITICAL] — Builtin trigger Enabled toggle is rejected from the UI

- **Found by:** Automated (live PATCH against booted server + code trace of UI patch path)
- **What happened:** UI sends `PATCH /api/v1/w/acme/documents/builtin-on-assignment` with `{ frontmatter: { on_event, schedule, agent, enabled: <toggled>, builtin, payload } }` (full frontmatter, only `enabled` value differs from current). Server's builtin lock rejects with `422 BUILTIN_TRIGGER_LOCKED — only frontmatter.enabled is mutable on builtin triggers`. So toggling Enabled on a builtin from the slideover always errors.
- **Expected:** Toggle persists. Spec §6e + acceptance #7 carve out `enabled` as mutable; the server's own error text says so.
- **Where:**
  - Server: `apps/server/src/services/documents.ts:580-600` — rejects when `Object.keys(patch.frontmatter).filter(k => k !== 'enabled').length > 0`, which trips on every key the UI sends along.
  - UI: `apps/web/src/components/slideover/workspace-document-slideover.tsx:376-387` — diffs frontmatter as a whole object via `JSON.stringify(draft.frontmatter) !== JSON.stringify(initial.frontmatter)`; the full object ships in PATCH.
  - UI source of full frontmatter: `apps/web/src/components/triggers/trigger-form.tsx:161-166` — `emitFrontmatter(patch)` spreads `...fm` into onChange's frontmatter.
- **Cluster:** A / Standalone
- **Status:** OPEN
- **Reproduction:**
  ```
  curl -X PATCH .../w/acme/documents/builtin-on-assignment \
    -d '{"frontmatter":{"on_event":"agent.task.assigned","schedule":null,"agent":"$event.agent","enabled":true,"builtin":true,"payload":null}}'
  → 422 BUILTIN_TRIGGER_LOCKED
  ```
- **Why tests missed it:** Server unit tests send `{frontmatter:{enabled:true}}` (server-API shape). Web tests probably mock the API at the hook layer and don't assert the wire shape against the server. The `[[feedback_mock-the-wire-not-the-response]]` pattern from Phase 2 applies here too.
- **Root cause:** [filled after fix]
- **Fix:** [filled after fix]

### BUG-002 [IMPORTANT] — `create_agent` MCP tool advertises `slug` but silently ignores it

- **Found by:** Automated MCP tools/call
- **What happened:** `tools/call create_agent` with `{slug: "copywriter", title: "Copy Bot", ...}` returned a doc with `slug: "copy-bot"` (slug derived from title; client `slug` silently dropped). No warning, no error.
- **Expected:** Either honour the client-supplied `slug`, or remove `slug` from `inputSchema` and document slug-from-title behavior in the tool description. Current state is a contract lie that future MCP clients (Plane, Cursor, etc.) will trip on.
- **Where:**
  - Schema declares it: `apps/server/src/routes/mcp.ts:1003-1010` (`slug` listed in `create_agent.inputSchema.properties`).
  - Handler ignores it: `apps/server/src/routes/mcp.ts:1013-1044` — only `title`/`body`/`frontmatter` are read.
- **Cluster:** Standalone
- **Status:** OPEN
- **Suggested fix shape:** drop `slug` from `create_agent.inputSchema.properties` and add one sentence to the description: "Slug is derived from `title`; use `update_agent` on the returned slug for subsequent edits." Cheapest fix, no behavior change.
- **Root cause:** [filled after fix]
- **Fix:** [filled after fix]

### BUG-003 [MINOR] — Milkdown teardown "removeEventListener is not defined" after web vitest finishes

- **Found by:** Automated (`bun run test` in apps/web)
- **What happened:** Run reports `Test Files: 92 passed | Tests: 533 passed | 8 skipped` then prints 7 uncaught `ReferenceError: removeEventListener is not defined` from `@milkdown/ctx`'s internal timer. Script exits 1.
- **Expected:** Exit 0 when all tests pass. CI gating on the script's exit code would see a failing build.
- **Where:** Milkdown ctx timer firing after jsdom is torn down. Stack trace points at `apps/web/src/components/comments/comments-tab.test.tsx` and any other test mounting Milkdown.
- **Cluster:** Standalone
- **Status:** OPEN
- **Suggested fix shape:** explicit Milkdown teardown helper (`await editor.destroy()`) invoked from `afterEach` in every test that mounts the editor. Phase 1.5 slideover tests may already do this — copy that pattern.
- **Root cause:** [filled after fix]
- **Fix:** [filled after fix]

### BUG-004 [MINOR / DEFER] — Web bundle 1.7 MB raw / 532 KB gzip exceeds 500 KB warning

- **Found by:** `bun run build`
- **What happened:** `apps/web/dist/assets/index-…js` is 1,688 KB raw / 532 KB gzip. Vite's `chunkSizeWarningLimit: 500` trips.
- **Expected:** Either code-split (router-level lazy chunks) or bump the warning limit. The single-binary distribution still works.
- **Where:** Likely culprits are Milkdown + ProseMirror + dnd-kit + TanStack Router in the entry chunk.
- **Cluster:** Standalone
- **Status:** OPEN — **recommend DEFER to a dedicated frontend-perf plan** (Phase 7 — UX polish).

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

---

## Final Status

**Resolved:** 0
**Deferred:** 0 (BUG-004 recommended but not yet confirmed by user)
**New bugs found during fix:** —
**Final sweep:** PENDING
