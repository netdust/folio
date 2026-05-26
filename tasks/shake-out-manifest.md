# Bug Manifest — Phase 2.5 Workspace-Scoped Agents

**Generated:** 2026-05-26
**Plan:** `docs/superpowers/plans/2026-05-26-phase-2.5-workspace-scoped-agents.md`
**Branch:** `phase-2.5/workspace-agents` (12 commits)
**Build status:** Server 258/1/0, Web 316/1/0, Shared 28/0
**Sweep status:** Track A automated complete; Track B manual pending user

---

## Summary

**4 Phase 2.5 bugs to fix, 1 deferred (pre-existing), 1 known flake (pre-existing).**

- **CRITICAL** (security): bearer enforcement gap on project documents endpoint (BUG-001)
- **CRITICAL** (feature missing): workspace agents/triggers pages have no create or edit affordances (BUG-004)
- **MINOR** (polish): workspace popover Agents/Triggers items need leading icons (BUG-003)
- **MINOR** (test infra): Phase 2.5 e2e spec times out at picker open (BUG-002)
- **DEFERRED** (pre-existing, not P2.5): table-cell assignee field is plain text — picker was always slideover-only (BUG-005)
- **DEFERRED** (pre-existing flake): click-through a11y test (matches STATE.md baseline)

---

## Sweep coverage

Track A — Automated (Claude):

| Check | Status | Notes |
|---|---|---|
| A1: POST agent at workspace (default `['*']`) | ✓ | 201, projectId NULL, token minted, defaults applied |
| A2: POST agent with explicit projects | ✓ | 201, frontmatter.projects = the array passed |
| A3: Project-level POST agent rejected | ✓ | 422 INVALID_DOCUMENT_SCOPE with correct message + URL pointer |
| A4: Project-level GET ?type=agent rejected | ✓ | 400 UNSUPPORTED_TYPE_FILTER with correct message |
| A5: Workspace GET ?type=agent lists all | ✓ |  |
| A6: Workspace GET filtered to project A | ✓ | Returns only wildcard agents (correct — no folio-only-for-A agent existed) |
| A7: Workspace GET filtered to folio | ✓ | Returns wildcard + folio-only agent |
| A8: PATCH agent.frontmatter.projects | ✓ | 200, persisted |
| A9: GET confirms PATCH | ✓ |  |
| A10: Wildcard agent token reads its own workspace | ✓ | 200 (no allow-list violation) |
| **A11: folio-only token attempts client-website project** | **✗ BUG-001** | **Returned 200 — `requireResource` is NOT mounted on project document routes** |
| A12: folio-only token reads stride (allowed post-PATCH) | ✓ | 200 |
| A13: DELETE agent → cascade revokes token | ✓ | Token returns 401 after delete |
| A14: Zod rejects `['*', 'x']` mix | ✓ | 422 INVALID_AGENT_FRONTMATTER with the refine message |
| A15: Workspace POST trigger | ✓ | 201 |
| A16: Workspace GET ?type=trigger | ✓ |  |
| A17: Project delete cascades id from agent allow-lists | ✓ | id scrubbed transactionally |
| M1: MCP list_projects filters by allow-list | ✓ | Returns only allowed projects |
| M2: MCP list_documents on disallowed project | ✓ | -32602 `agent_not_in_allow_list` with full data envelope |
| M3: MCP list_documents on allowed project | ✓ | 200 |
| M4: MCP create_document type=agent rejected | ✓ | -32602 `agent_lifecycle_via_http_only` |
| M5: MCP create_document type=trigger rejected | ✓ | -32602 |
| F1: Frontend `/w/:wslug/agents` reachable | ✓ | 200 |
| F2: Frontend `/w/:wslug/triggers` reachable | ✓ | 200 |
| **E1: Phase 2.5 Playwright spec** | **✗ BUG-002** | **Times out at assignee picker open — likely selector issue, not product** |
| E2: Existing Playwright regression spine | 26/27 | 1 failure matches the pre-existing flake noted in STATE.md (a11y duplicates test) |
| Log scan for unhandled errors | ✓ | Clean |

---

## Bug List

### BUG-001 [CRITICAL] — `requireResource` middleware never runs

- **Found by:** Automated (A11)
- **What happened:** An agent-bound bearer token narrowed to projects `[folio, stride]` was able to GET `/api/v1/w/netdust/p/client-website/documents?type=work_item` and received HTTP 200 + work items. The CHECK should have been a 403 `FORBIDDEN_RESOURCE`.
- **Expected:** 403 with `FORBIDDEN_RESOURCE` per `requireResource()` (Task 3 middleware).
- **Where:** `apps/server/src/app.ts` — `requireResource()` is exported from `middleware/bearer.ts` but never mounted on any route. The middleware sits dead code while the project-documents route relies on `requireScope` alone for action-scope and has no resource-scope check.
- **Cluster:** Standalone (the middleware itself works — the unit tests at `middleware/resource.test.ts` prove it). The bug is integration: nothing wires it into the route chain.
- **Severity rationale:** This is the entire point of Phase 2.5. Without `requireResource` mounted, a workspace agent narrowed to one project can act on *every* project in the workspace via the REST API. MCP path is correct (separate enforcement in the resolver), so the leak is REST-only — but REST is what the assignee picker and every web feature go through.
- **Status:** OPEN
- **Root cause:**
- **Fix:**

### BUG-002 [MINOR] — Phase 2.5 e2e spec times out opening assignee picker

- **Found by:** Automated (E1)
- **What happened:** `tests/e2e/phase-2-5-workspace-agents.spec.ts` reaches the project page, clicks `'Sample inbox item'` text to open the slideover, then `getByRole('button', { name: /unassigned/i }).first().click()` — locator never resolves; test times out at 30s. Page snapshot shows the work-items list still on screen, not the slideover.
- **Expected:** Slideover opens and exposes an "Unassigned" button to click.
- **Where:** `apps/web/tests/e2e/phase-2-5-workspace-agents.spec.ts:59-63`. The test selector strategy doesn't account for the row click going to inline-edit instead of slideover-open (Folio's table-row title is InlineEdit-able, so a text click triggers edit, not navigation).
- **Cluster:** Standalone (test infra; product behavior unverified by this test as written).
- **Severity rationale:** The spec covers a workflow that's already verified by curl (assignee picker now queries the workspace agents endpoint with `?project=:pid`; we saw it return the right shape live). The vertical slice will be verifiable via the manual checklist (Track B). Fixing the spec is small.
- **Status:** OPEN
- **Root cause:**
- **Fix:**

### BUG-003 [MINOR] — Workspace popover "Agents" / "Triggers" items need icons

- **Found by:** Manual (Track B)
- **What happened:** The new popover entries render as plain text. Every other rail/popover entry in Folio has a leading icon (workspace tile, project, table, view, wiki all carry icons).
- **Expected:** Leading icons for visual consistency. The codebase already uses `Bot` (lucide-react) for agents and `Zap` for triggers — those icons existed before I removed them from `rail-tree.ts` in Task 7. Reuse them.
- **Where:** `apps/web/src/components/shell/workspace-switcher.tsx:65-86` (the Agents + Triggers button blocks).
- **Cluster:** Standalone polish.
- **Status:** OPEN

### BUG-004 [CRITICAL] — Workspace agents + triggers pages have no create / edit / delete affordances

- **Found by:** Manual (Track B)
- **What happened:** `/w/:wslug/agents` lists the three workspace agents but offers no way to add, open, edit, or delete one. Clicking a row does nothing visible (the slideover doesn't open). The triggers page has the same gap. The plan called for: (1) a "+ New agent" CTA in the page header AND on the empty state, (2) row-click → slideover opens for the agent's frontmatter form. Plan §"Workspace agents page" lines 234-238.
- **Expected:** Header has `+ New agent` button → slideover opens in create mode. Row click → `?doc=<slug>` set → slideover opens for editing. Slideover supports save + delete.
- **Where:**
  - `apps/web/src/components/views/workspace-agents-page.tsx` — header is missing the `+ New agent` button; row click navigates `?doc=<slug>` but no slideover is rendered on this route.
  - `apps/web/src/components/views/workspace-triggers-page.tsx` — same shape, same gap.
  - `apps/web/src/routes/w.$wslug.agents.tsx` + `triggers.tsx` — neither route mounts a `DocumentSlideover`. The project-scoped routes render the slideover from the workspace's `Outlet`; the new workspace routes need their own integration since the project-slideover at `w.$wslug.p.$pslug.tsx` is for project docs (work_items/pages) and resolves docs via `useDocument(wslug, pslug, slug)` which is project-scoped.
- **Cluster:** Standalone — this is the "page integration" that should have been part of Task 8 but only the list-rendering shipped.
- **Severity rationale:** Without create/edit, agents can ONLY be created via curl/API. The whole UI workflow is dead. This is a Phase 2.5 ship-blocker.
- **Status:** OPEN

### BUG-005 [DEFERRED — pre-existing, not Phase 2.5] — Table-row assignee field renders as text input

- **Found by:** Manual (Track B), but NOT a Phase 2.5 regression.
- **Verification:** `grep -rln "AssigneePicker" apps/web/src/` returns only `assignee-picker.tsx`, `frontmatter-form.tsx`, and the test file. The picker has only ever been wired through `FrontmatterForm` (slideover). The table view never had this affordance.
- **Where the assumption came from:** STATE.md line 158 says "Picker is **auto-wired by `FrontmatterForm`** whenever `key === 'assignee'`" — that explicitly scopes it to the form, not the cell. Phase 2 commit `a9cba37 phase-2: assignee picker — humans + agents` shipped the slideover wiring; a table-cell wiring was never built.
- **Action:** Not in Phase 2.5 scope. Worth a follow-up issue ("polish: wire AssigneePicker into TableCell for the assignee column"), but not a Phase 2.5 ship-blocker.
- **Status:** DEFERRED

### Pre-existing, not Phase 2.5 — deferred for separate sweep

**[FLAKE] click-through.spec.ts:123 — "list rows have unique accessible names per doc"**
- Times out on `getByRole('button', { name: /Edit title: Untitled/ })` inside the slideover dialog. The test itself notes "in headless Chromium ambient focus events sometimes dismiss it before the input is interactable" (line 137 comment). Matches the STATE.md baseline of "26/27 playwright pass; 1 known flake." Not a Phase 2.5 change.

---

## Fix Log

| Bug | Attempts | Root Cause | Fix | Re-sweep |
|-----|----------|-----------|-----|----------|

---

## Final Status

(Filled at the end.)
