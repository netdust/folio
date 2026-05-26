# Bug Manifest — Phase 2.5 Workspace-Scoped Agents

**Generated:** 2026-05-26
**Plan:** `docs/superpowers/plans/2026-05-26-phase-2.5-workspace-scoped-agents.md`
**Branch:** `phase-2.5/workspace-agents` (12 commits)
**Build status:** Server 258/1/0, Web 316/1/0, Shared 28/0
**Sweep status:** Track A automated complete; Track B manual pending user

---

## Summary

**4 originals + 3 polish bugs found in second sweep, 1 deferred (pre-existing), 1 known flake (pre-existing).**

- **CRITICAL** (security): BUG-001 RESOLVED — `requireResource` now mounted (commit `174c3d9`).
- **CRITICAL** (feature missing): BUG-004 RESOLVED — workspace slideover + create/delete UI (commit `f94ebc5`).
- **MINOR** (polish): BUG-003 RESOLVED — icons on workspace popover (commit `397d224`).
- **MINOR** (test infra): BUG-002 RESOLVED — Phase 2.5 e2e spec selector + missing `assignee` key fix; spec passes 1/1.
- **IMPORTANT** (UX): BUG-006 RESOLVED — paired provider/model field with AI-key annotation.
- **IMPORTANT** (UX): BUG-007 RESOLVED — `ToolsField` multi-select from `V1_MCP_TOOLS` (shared).
- **MINOR** (UX): BUG-008 RESOLVED — chip neutral at rest, primary on hover (agents-page only — see BUG-011).
- **MINOR** (UX): BUG-009 — field-help text for non-obvious agent keys (system_prompt, etc).
- **IMPORTANT** (design system): BUG-010 — chip drift; need a single `<Chip>` primitive used everywhere.
- **MINOR** (UX): BUG-011 — ProjectsField chips inside the slideover form still float (same root as BUG-010).
- **DEFERRED** (pre-existing, not P2.5): BUG-005 — table-cell assignee field; picker was always slideover-only.
- **DEFERRED** (pre-existing flake): click-through a11y test, matches STATE.md baseline.

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

### BUG-001 [CRITICAL] — `requireResource` middleware never runs — RESOLVED

- **Found by:** Automated (A11)
- **What happened:** An agent-bound bearer token narrowed to projects `[folio, stride]` was able to GET `/api/v1/w/netdust/p/client-website/documents?type=work_item` and received HTTP 200 + work items. The CHECK should have been a 403 `FORBIDDEN_RESOURCE`.
- **Expected:** 403 with `FORBIDDEN_RESOURCE` per `requireResource()` (Task 3 middleware).
- **Where:** `apps/server/src/app.ts` — `requireResource()` was exported from `middleware/bearer.ts` and unit-tested in `middleware/resource.test.ts` but never mounted on any route. Plan §"Middleware composition" specified the chain `… → requireScope → requireResource → handler`; Task 3 added the middleware, Task 4 added the workspace endpoints, but neither task mounted the gate on `pScope`. The Vitest unit suite proved the middleware works in isolation; no full-stack test exercised it via the real `app.ts` chain.
- **Cluster:** Standalone.
- **Root cause:** Missing integration wire. The middleware was a sound piece but it wasn't installed.
- **Fix:** Commit `<pending>`. Mounted `requireResource()` on `pScope` immediately after `resolveProject`, matching the plan's middleware order. The middleware's existing early-returns (`!token`, `!project`, `!token.agentId`) keep session users and human PATs unaffected — confirmed via live re-sweep: session user 200, wildcard agent 200, narrowed agent 403 with `FORBIDDEN_RESOURCE`. Added a full-stack regression test at `apps/server/src/routes/documents.test.ts` that:
  1. Mints an agent narrowed to a second project `other`.
  2. Asserts GET `/p/other/documents` → 200 (allowed),
  3. GET `/p/web/documents` → 403 `FORBIDDEN_RESOURCE` (denied),
  4. A wildcard agent → 200 on `/p/web/documents` (regression on the bypass path).
- **Re-sweep:** Live curl reproduces the fix. Server suite 259/1-skip/0-fail (+1 new test).
- **Status:** RESOLVED

### BUG-002 [MINOR] — Phase 2.5 e2e spec times out opening assignee picker — RESOLVED

- **Found by:** Automated (E1)
- **Root cause:** Two issues in the test:
  1. `page.getByText('Sample inbox item').first().click()` triggered InlineEdit on the row title instead of opening the slideover. Canonical pattern is `getByRole('button', { name: 'Open <title>' })` (each row has an accessible Open button).
  2. The assignee picker only renders when `frontmatter.assignee` key exists (FrontmatterForm is key-driven). A freshly-created work item has empty frontmatter — no picker. Test had to seed the key.
- **Fix:** Commit `<pending>`. Updated the spec to (a) use the canonical Open button selector, (b) PATCH the work item with `frontmatter: { assignee: '' }` BEFORE first navigation so the picker row is rendered on the first slideover open.
- **Re-sweep:** `bun run e2e phase-2-5-workspace-agents.spec.ts` → 1 passed (5.0s test + 4.6m cold start).
- **Status:** RESOLVED

### BUG-003 [MINOR] — Workspace popover "Agents" / "Triggers" items need icons — RESOLVED

- **Found by:** Manual (Track B)
- **What happened:** The new popover entries rendered as plain text without the leading icons every other rail/popover entry in Folio carries.
- **Fix:** Commit `<pending>`. Added `Bot` (agents) and `Zap` (triggers) lucide-react icons via the existing `<Icon>` wrapper. Same icons that were used in the project-rail leaves pre-Phase-2.5 (Task 7 removed those leaves; the icons live on in lucide-react and now resurface in the workspace popover).
- **Re-sweep:** Switcher tests still 4/4 green; web TS clean.
- **Status:** RESOLVED

### BUG-004 [CRITICAL] — Workspace agents + triggers pages have no create / edit / delete affordances — RESOLVED

- **Found by:** Manual (Track B)
- **Root cause:** Task 8 shipped the list-rendering pages but stopped short of the full UI integration the plan called for. The project flow uses a layout route (`w.$wslug.p.$pslug.tsx`) that mounts `<DocumentSlideover>` once and renders `<Outlet />`; the new workspace routes are leaf routes with no layout, so the slideover was never mounted. `useCreate/Update/DeleteDocument` are project-scoped; workspace-scoped mutation hooks didn't exist.
- **Fix:** Commit `<pending>`. Built the missing pieces:
  1. New mutation hooks in `lib/api/workspace-documents.ts`: `useCreateWorkspaceDocument`, `useUpdateWorkspaceDocument`, `useDeleteWorkspaceDocument`. They hit `/api/v1/w/:wslug/documents[/...]` and invalidate the workspace-documents query keys.
  2. New `WorkspaceDocumentSlideover` (slideover/workspace-document-slideover.tsx) — mirrors `DocumentSlideover` but uses workspace-scoped hooks and skips project-only surface (no status field, no pinned fields, no ActivityPanel, no LogActivity, no Copy-as-MD). Reads `?doc=<slug>` from URL search params; opens automatically. Title editor + Mode toggle + Delete via ⋯ menu + confirm dialog + Body editor (rich/raw). FrontmatterForm renders ProjectsField for the `projects` key (already auto-wired in Task 9).
  3. `WorkspaceAgentsPage`: added `+ New agent` button in header AND on the empty state. POSTs an Untitled agent with placeholder Zod-valid frontmatter, then `navigate({ search.doc = created.slug })` to open the slideover. Mounted `<WorkspaceDocumentSlideover wslug={wslug} />` at the page footer.
  4. `WorkspaceTriggersPage`: same shape. New trigger needs at least one agent to exist (Zod refine: `schedule` or `on_event` required + valid `agent` slug); button shows a toast if no agents exist yet.
  5. Slideover wired so row click (already setting `?doc=<slug>` from Task 8) now actually opens the editor.
- **Tests:** 4 new tests in `workspace-agents-page.test.tsx`: header CTA exists, click POSTs + navigates with `?doc=`, empty state surfaces CTA, slideover mounted (closed when `?doc` is absent).
- **Re-sweep:** Web suite 320/1-skip/0-fail (+4 new). Web TS clean. Live dev server still serves the page.
- **Status:** RESOLVED

### BUG-005 [DEFERRED — pre-existing, not Phase 2.5] — Table-row assignee field renders as text input

- **Found by:** Manual (Track B), but NOT a Phase 2.5 regression.
- **Verification:** `grep -rln "AssigneePicker" apps/web/src/` returns only `assignee-picker.tsx`, `frontmatter-form.tsx`, and the test file. The picker has only ever been wired through `FrontmatterForm` (slideover). The table view never had this affordance.
- **Where the assumption came from:** STATE.md line 158 says "Picker is **auto-wired by `FrontmatterForm`** whenever `key === 'assignee'`" — that explicitly scopes it to the form, not the cell. Phase 2 commit `a9cba37 phase-2: assignee picker — humans + agents` shipped the slideover wiring; a table-cell wiring was never built.
- **Action:** Not in Phase 2.5 scope. Worth a follow-up issue ("polish: wire AssigneePicker into TableCell for the assignee column"), but not a Phase 2.5 ship-blocker.
- **Status:** DEFERRED

### BUG-006 [IMPORTANT — UX] — Agent slideover: model/provider paired dropdowns sourced from configured AI keys — RESOLVED

- **Found by:** Manual (Track B, second sweep)
- **Fix:** Commit `<pending>`. New `ProviderModelField` in `apps/web/src/components/inline/`:
  - Provider select: all 4 supported providers (anthropic / openai / openrouter / ollama). Annotates each with "no key" badge when the workspace has no AI key configured for that provider (queried via `useWorkspaceAiKeys`).
  - Model select / input: hardcoded model lists for anthropic + openai (per the user's shake-out call). openrouter + ollama fall back to a free-text input (their model namespace is open-ended).
  - Provider switch resets model to the first model of the new provider unless the current model is in the new provider's list (preserves valid pairings).
  - Wired into FrontmatterForm by key dispatch (`key === 'provider' && type === 'agent'`) — renders ONE row that owns both `provider` and `model` keys. The standalone `model` row is filtered out of orderedKeys.
- Also added `AGENT_KEY_ORDER` in FrontmatterForm (system_prompt → provider/model → tools → projects → max_delegation_depth → max_tokens_per_run → requires_approval). Reads top-down instead of alphabetical mess.
- **Tests:** 4 new tests for `ProviderModelField` (renders provider + model, no-key badge, model reset on provider switch, openrouter free-text).
- **Status:** RESOLVED

### BUG-007 [IMPORTANT — UX] — Agent slideover: `tools` should be a multi-select of `V1_MCP_TOOLS` — RESOLVED

- **Found by:** Manual (Track B, second sweep)
- **Fix:** Commit `<pending>`. Three pieces:
  1. Extracted `V1_MCP_TOOLS` + `McpTool` + new `MCP_TOOL_GROUPS` (read / write / delete grouping) into `packages/shared/src/mcp-tools.ts`. Server's `agent-schema.ts` now re-exports from `@folio/shared` — single source of truth.
  2. New `ToolsField` chip-editor in `apps/web/src/components/inline/tools-field.tsx`. Mirrors ProjectsField pattern: trigger renders chips, popover holds grouped checkboxes. Persisted array always in MCP_TOOL_GROUPS order so MD round-trips are stable.
  3. Wired into `FrontmatterForm` via key dispatch (`key === 'tools' && type === 'agent'`).
- **Tests:** 6 new tests for `ToolsField` (empty state, chip rendering, check/uncheck, ordering, group rendering).
- **Status:** RESOLVED

### BUG-008 [MINOR — UX] — Project chips on agents page invisible at rest — RESOLVED

- **Found by:** Manual (Track B, second sweep)
- **What happened:** Clickable project chips rendered with `bg-primary/10` which blended into the page background; only visible on hover.
- **Fix:** Commit `<pending>`. Moved to a neutral chip at rest (`border-border bg-card text-fg-2`) that gains the primary tint on hover. The "All projects" muted variant kept its existing style. 10/10 page tests still pass.
- **Status:** RESOLVED

### BUG-009 [MINOR — UX] — Frontmatter rows need field-help text for non-obvious keys

- **Found by:** Manual (Track B, third sweep)
- **What happened:** The agent slideover shows raw key names (`system_prompt`, `max_delegation_depth`, `max_tokens_per_run`, `requires_approval`, `tools`) with no inline explanation. Users who haven't read the spec can't tell what `system_prompt` does or why `max_delegation_depth: 2` matters.
- **Expected:** A short one-line description next to each agent field. Two reasonable patterns:
  1. Helper text below or to the right of the input (e.g. "What this agent should do" under `system_prompt`).
  2. `title` attribute on the key term — already exists for the `dt` element (line 91 of frontmatter-form.tsx: `<dt … title={key}>`) but only shows the raw key on hover; replace with a real description.
- **Where:** `apps/web/src/components/slideover/frontmatter-form.tsx` — extend `AGENT_KEY_ORDER` into a `AGENT_FIELD_META = { key, label, description }[]` so render can show the description inline.
- **Severity rationale:** Discoverability. The user just shipped the feature and can't tell which field does what without re-reading the spec — first-time users will hit the same wall.
- **Status:** OPEN

### BUG-010 [IMPORTANT — Design system] — Chip styles drifting; need a single Chip primitive

- **Found by:** Manual (Track B, third sweep)
- **What happened:** During the second-sweep polish I introduced THREE chip variants without a shared component:
  1. `ProjectChip` in `workspace-agents-page.tsx` (now: `border-border bg-card text-fg-2 hover:border-primary/30 …`) — neutral at rest, primary on hover.
  2. `Chip` inside `projects-field.tsx` (`bg-card text-fg-3` muted vs `bg-primary/10 text-primary` non-muted) — different at-rest semantics.
  3. `Chip` inside `tools-field.tsx` (`bg-card text-fg-2 border border-border`) — yet another permutation, and the user noticed the visible border specifically because no other chip in the app uses one ("never used but here").
  - Same shape, three definitions, three styles. Each tweak to one drifts further from the others.
- **Expected:** A single `<Chip>` primitive in `components/ui/` with variants: `default`, `muted`, `interactive` (clickable). Every chip in the app uses it. Variants ARE the only knobs.
- **Where:** New `apps/web/src/components/ui/chip.tsx`. Migrate `ProjectChip`, both inline `Chip`s, and any other ad-hoc chip (audit needed: the assignee picker label, the agents-page project chips, the trigger schedule pill in `workspace-triggers-page.tsx`).
- **Severity rationale:** Design-system entropy. The user explicitly flagged this as the wedge: "please make sure we have a solid set of components that we reuse. no messy design system." This is exactly the kind of "many small definitions" that becomes hard to clean up later.
- **Status:** OPEN

### BUG-011 [MINOR — UX] — ProjectsField chips float without visible background

- **Found by:** Manual (Track B, third sweep, repeat of BUG-008 location)
- **What happened:** I fixed `ProjectChip` (workspace-agents-page) in BUG-008, but the chips INSIDE the ProjectsField slideover editor (used for the `projects` row in the agent's frontmatter form) still use `bg-primary/10` for non-muted and `bg-card text-fg-3` for muted. With theme/background colors close to the chip tint, the chip body disappears and only the text floats. Same symptom as BUG-008, different file.
- **Expected:** Same fix as BUG-008 — neutral chip at rest with a visible border. Best done as part of BUG-010 (use the shared Chip primitive).
- **Where:** `apps/web/src/components/inline/projects-field.tsx` — `Chip` component at the bottom.
- **Status:** OPEN — fold into BUG-010 fix.

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
