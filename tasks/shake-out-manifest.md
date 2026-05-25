# Shake-out manifest — phase-2/agents-surface (2026-05-25)

Scope: Phase 2 surface — tokens (server + web), MCP, SSE events, agent/trigger documents, settings page + Tokens tab, assignee picker, rail Agents/Triggers leaves, /members endpoint.

Automated regression status going in: server 214/1-skip, web 285/1-skip, shared 28/28. Web TS clean. Server TS pre-existing `app.ts` complaints (out of scope per plan).

Environment: dev stack running on :3001 (api) + :5173 (web), DB `apps/server/folio.db` seeded via `scripts/seed-demo.ts` for `stefan@netdust.be` / workspace `netdust`.

---

## Phase 1 Track A — automated sweep

| # | Check | Tool | Status | Notes |
|---|---|---|---|---|
| 1 | API liveness — GET /api/v1/auth/me (no cookie) | curl | ✅ 401 | correct: requires session |
| 2 | API liveness — GET / | curl | ✅ 404 | no root route by design |
| 3 | Web SPA — GET :5173/ | curl | ✅ 200 | Vite dev server serving |
| 4 | MCP rejects no-auth | curl | ✅ 401 | bearer required |
| 5 | SSE rejects no-auth | curl | ✅ 401 | bearer or cookie required |
| 6 | Login via /api/v1/auth/login | curl | ✅ 200 + cookie | session cookie set |
| 7 | Members endpoint — GET /api/v1/w/netdust/members (cookie) | curl | ✅ 200, 1 member | Stefan listed, role=owner |
| 8 | Create token — POST /api/v1/w/netdust/tokens/:wsId | curl | ✅ 201 | token returned exactly once, all 6 scopes |
| 9 | Tokens list — GET /api/v1/w/netdust/tokens/:wsId | curl | ✅ 200 | created token visible, no hash leaked |
| 10 | MCP initialize + tools/list (bearer) | curl | ✅ 12 tools | all v1 tools present |
| 11 | MCP list_projects (bearer) | curl | ✅ | client-website, folio, stride returned |
| 12 | MCP create_document type=agent (valid frontmatter) | curl | ✅ | auto-mints `api_token_id`, `parent_agent=null` |
| 13 | MCP create_document type=agent (unknown tool in frontmatter) | curl | ✅ rejected | Zod enum error mentions the allowed values |
| 14 | MCP create_document type=trigger (valid cron) | curl | ✅ | daily-standup created |
| 15 | MCP create_document type=trigger (invalid cron) | curl | ✅ rejected | "invalid cron expression" on schedule path |
| 16 | SSE document.created flows on bearer-authed write | curl + bg | ✅ | event arrived <0.5s after MCP create |
| 17 | SSE agent.task.assigned fires on assignee transition | curl + bg | ✅ | both `document.updated` AND `agent.task.assigned` emitted on null→agent patch |
| 18 | Server unit suite — `bun test` | bun | ✅ 214/1-skip | no regressions |
| 19 | Web unit suite — `bun run test` | vitest | ✅ 285/1-skip | no regressions |
| 20 | Playwright e2e suite | playwright | ⚠️ **26/27, 1 fail** | see Bug A |

---

## Bugs

### Bug A — CRITICAL — Playwright "table sticky first column has 1px right border" regression

- **Test:** `apps/web/tests/e2e/click-through.spec.ts:278` — `table: sticky first column has a 1px right border in header AND data rows (regression)`
- **Failure mode:** 30s timeout on `locator('[data-testid="table-scroll"] button.sticky').first()`
- **Page state at failure (from error-context.md):**
  - The rail correctly shows `Wiki` / `Agents` / `Triggers` leaves (Task 16 working)
  - Header reads "1 work item · 0 pages" — data exists
  - But the locator can't find `button.sticky` inside `[data-testid="table-scroll"]`
- **Suspicion (not investigation — that's Phase 3's job):** something between `main` and this branch removed or renamed the sticky button — could be the type-widening, the rail-tree changes, or completely unrelated drift. Existing unit `table-cell.test.tsx` still passes the className assertion, so the regression is likely in the DOM tree shape, not the classname.
- **All 26 other e2e tests pass.** Limited blast radius.

### Bug B — IMPORTANT — Create-token modal omits `statuses:write` and has no scope presets

- **Where:** `apps/web/src/components/settings/token-create-modal.tsx` `ALL_SCOPES`
- **Symptom:** Modal offers 6 scopes (documents:{read,write,delete}, fields:write, views:write, tables:write). Server actually enforces 6 + `statuses:write` (used by the statuses route). A token created via the UI cannot manage statuses, so the UI cannot mint a token equivalent to an "agent token with full project authority."
- **Root cause:** Plan §Task 14 step 4 spec'd exactly the 6 scopes I shipped; nobody cross-referenced against `grep "requireScope" routes/`. Plan-vs-API source-of-truth rule from auto-memory was violated.
- **Fix shape (Stefan approved):** add `statuses:write` + a preset strip ("Read-only" / "Read + write" / "Full access") above the checkboxes. Per superpowers:systematic-debugging in Phase 3.

### No other bugs surfaced in Track A.

---

## Phase 1 Track B — manual checks (waiting for human)

Please run these in a real browser at http://localhost:5173 logged in as stefan@netdust.be / demo-password-1, then report back:

1. **Settings page reachable** — Click your avatar (bottom-left rail) → click "Settings" in the popover. Does the `/w/netdust/settings` page render? Tab strip visible with "API tokens" active?
2. **Tokens tab — empty / non-empty states**
   - If list is empty: "No API tokens yet." empty-state with `+ Create token` button shows.
   - If list has tokens (you already created `shake-out` via shell): each row shows name, scope chips, "last used" / "Never used", and a `Revoke` button.
3. **Create token flow** — Click `+ Create token`. Modal shows: Name input, 6 scope checkboxes, Cancel + Create. Create disabled until name + ≥1 scope. On submit, view switches to the plaintext reveal with Copy button + "this is the only time" warning. Click Copy → "Copied" confirmation. Close → list refreshes with the new token at the top.
4. **Revoke token flow** — Click `Revoke` on a row. Confirm dialog opens quoting the token name. Click `Revoke` (danger) → toast appears, row disappears from list.
5. **Assignee picker in slideover** — Open any work item slideover. If `assignee` is one of its frontmatter keys, the value should render as a button labeled with the current assignee (or "Unassigned"). Clicking opens a Popover with **Members** section (Stefan) and **Agents** section (the `shake-out-triage-bot` you just created via MCP). Clicking a member sets the email; clicking an agent sets `agent:<slug>`. Slideover should reflect the change.
6. **Agents leaf in rail** — Expand any project. Below `Wiki` you should see `Agents` and `Triggers` leaves. Click `Agents` — page lists the agent we created. Click the row — slideover opens with the agent's frontmatter (system_prompt, model, provider, tools, etc.). Same for `Triggers`.
7. **Console** — Open DevTools console. Any red errors during the above flows that weren't there on `main`?

Report what you see (or screenshots). I'll fold anything broken into the manifest before Phase 3 begins.

---

## Status

- Track A: complete (20 checks, 1 bug)
- Track B: **waiting on human**
- Phase 2 (manifest review): blocked on Track B
- Phase 3 (fix loop): blocked on Phase 2 sign-off
