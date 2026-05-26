# Folio — Tasks

Active task list for the current branch / session. Mark items off as you complete them. Add a `## Review` section at the bottom when a batch wraps up.

For phase-level checkboxes that survive across branches, see `docs/PHASES.md`. This file is short-lived working memory.

---

## Current branch: `phase-2.5/workspace-agents`

Implementing Phase 2.5 per `docs/superpowers/specs/2026-05-26-phase-2.5-workspace-scoped-agents-design.md` via the plan at `docs/superpowers/plans/2026-05-26-phase-2.5-workspace-scoped-agents.md`. Execution mode: sequential (hard dependencies — schema → middleware → routes → UI).

### Tasks (mirror the plan)

- [x] **Task 1 — Schema + migration** (`documents.workspace_id` NOT NULL, `project_id` nullable, CHECK constraint, `api_tokens.agent_id` + `project_ids`; migration `0006_phase_2_5_workspace_agents.sql` + test) — `af93935`. 7 migration tests pass; 58 server-suite failures are expected and traced to Task 4 work (createDocument doesn't write workspace_id yet).
- [x] **Task 2 — Agent frontmatter Zod** (`projects: string[]` defaulting to `['*']`, wildcard exclusivity refine) — 5 new tests cover default, explicit list, wildcard mix-rejection, empty array.
- [x] **Task 3 — `requireResource` middleware** + `intersect()` helper (6 algebra tests + 5 integration tests: deny/allow per allow-list, wildcard agent, token narrowing, session bypass)
- [x] **Task 4 — Workspace-level document routes** (`/api/v1/w/:wslug/documents` POST/GET/PATCH/DELETE; project-level POST/GET reject agent+trigger with `INVALID_DOCUMENT_SCOPE`/`UNSUPPORTED_TYPE_FILTER`). 9 new tests in `workspace-documents.test.ts`; un-skipped + ported all 10 Phase-2-marker tests to the workspace endpoint via a shared `createAgentAtWorkspace` helper. Service signatures updated: `project: Project | null` in CreateDocumentArgs / UpdateDocumentArgs / DeleteDocumentArgs.
- [x] **Task 5 — MCP resolver allow-list** (resolveProjectInWorkspace enforces; `list_projects` filters; `create/update/delete_document` rejects agent/trigger with `-32602`; structured server log on rejection). 6 new tests covering filter behavior, rejection, and human-PAT bypass.
- [x] **Task 6 — Project-delete cascade hook** (transaction wraps project delete + scan of workspace agents' `frontmatter.projects` to remove the deleted id). 2 tests: scrub semantics (explicit + wildcard both correct) + non-owner 403 leaves frontmatter untouched.

#### Server phase gate
- [x] Full server suite green (258 / 1 skip / 0 fail; +45 new tests over Phase 2 baseline)
- [x] Server type-check clean (excluding pre-existing pattern errors in `app.ts`, `bearer.test.ts`, `scope.test.ts`, `workspaces.ts:129` — all unchanged by Phase 2.5)
- [ ] Manual API smoke (curl POST/GET against workspace + project endpoints) — pending
- [ ] `testing-workflow:phase-complete` invoked — pending

- [x] **Task 7 — UI rail subtraction + workspace popover** (removed Agents/Triggers leaves + onAgentsClick/onTriggersClick/isAgents/isTriggers from RailTree; added Agents+Triggers menu items to `workspace-switcher.tsx`; rewired w.$wslug.tsx)
- [x] **Task 8 — Workspace agents+triggers pages + `useWorkspaceAgents`** (new `lib/api/workspace-documents.ts` with `useWorkspaceAgents` + `useWorkspaceTriggers` + `useWorkspaceDocument`; new `workspace-agents-page.tsx` with project chip rendering + filter; `workspace-triggers-page.tsx`; new routes `/w/:wslug/agents` and `/triggers` with `?doc=`/`?project=` search params; deleted old project-scoped route files + `document-type-list.tsx`)
- [x] **Task 9 — `ProjectsField` + assignee picker rewire + E2E** — new `ProjectsField` chip editor with wildcard semantics (`['*']` ↔ explicit list, atomic collapse); `assignee-picker.tsx` swapped to `useWorkspaceAgents(wslug, { project })` with `keepPreviousData` for no-skeleton re-open. FrontmatterForm auto-wires `projects` key for agent docs via `ProjectsFieldWithProjects` subcomponent (keeps `useProjects` out of the non-agent render path). Playwright spec at `tests/e2e/phase-2-5-workspace-agents.spec.ts` — to run during shake-out.

#### Phase 2.5 phase gate
- [x] Web suite, server suite, shared suite all green — server 258/1/0, web 316/1/0, shared 28/0
- [x] Web TS clean (0 errors); server TS clean for touched files (only pre-existing errors remain — `app.ts:31`, `bearer.test.ts:14`, `scope.test.ts` middleware-app composition, `workspaces.ts:129`)
- [ ] Playwright e2e (run during shake-out — cold-start ~4.5 min)
- [ ] Smoke checklist walked (in shake-out)
- [ ] `testing-workflow:phase-complete` invoked (this step — see message below)

#### Hand-off
- [ ] `netdust-core:shake-out` for real-environment QA
- [ ] `superpowers:finishing-a-development-branch` for PR / merge prep
- [ ] Update `memory/STATE.md` Phase 2.5 status → "shipped"

---

## Deferrals confirmed by Phase 2.5 spec (Phase 2.6 / Phase 3+)

- `create_agent` / `update_agent` / `delete_agent` / `get_agent_self` MCP tools — Phase 2.6
- Templates — Phase 2.6
- Background allow-list reconciler — Phase 2.6
- Human PAT `project_ids` enforcement — Phase 3+
- `requires_approval` / `max_tokens_per_run` runtime enforcement — Phase 3 runner

---

## Carried over from prior branches (not blocking Phase 2.5)

- Manual QA pass on Phase 1.7 UX cleanup batch (5 items — see prior Review).
- Pre-existing TS errors in `apps/server/src/index.ts` and `packages/shared/src/{filter-compile,slug}.test.ts` — sweep before next merge.

---

## Review

_(Filled in at branch close.)_
