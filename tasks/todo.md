# Folio — Tasks

Active task list for the current branch / session. Mark items off as you complete them. Add a `## Review` section at the bottom when a batch wraps up.

For phase-level checkboxes that survive across branches, see `docs/PHASES.md`. This file is short-lived working memory.

---

## Current branch: `phase-2.5/workspace-agents`

Implementing Phase 2.5 per `docs/superpowers/specs/2026-05-26-phase-2.5-workspace-scoped-agents-design.md` via the plan at `docs/superpowers/plans/2026-05-26-phase-2.5-workspace-scoped-agents.md`. Execution mode: sequential (hard dependencies — schema → middleware → routes → UI).

### Tasks (mirror the plan)

- [x] **Task 1 — Schema + migration** (`documents.workspace_id` NOT NULL, `project_id` nullable, CHECK constraint, `api_tokens.agent_id` + `project_ids`; migration `0006_phase_2_5_workspace_agents.sql` + test) — `af93935`. 7 migration tests pass; 58 server-suite failures are expected and traced to Task 4 work (createDocument doesn't write workspace_id yet).
- [x] **Task 2 — Agent frontmatter Zod** (`projects: string[]` defaulting to `['*']`, wildcard exclusivity refine) — 5 new tests cover default, explicit list, wildcard mix-rejection, empty array.
- [ ] **Task 3 — `requireResource` middleware** + `intersect()` helper (6 algebra tests + integration tests against project A vs B with a narrowed agent token)
- [ ] **Task 4 — Workspace-level document routes** (`/api/v1/w/:wslug/documents` POST/GET/PATCH/DELETE; project-level POST/GET reject agent+trigger with `INVALID_DOCUMENT_SCOPE`/`UNSUPPORTED_TYPE_FILTER`)
- [ ] **Task 5 — MCP resolver allow-list** (resolveProjectInWorkspace enforces; `list_projects` filters; `create/update/delete_document` rejects agent/trigger with `-32602`; structured server log on rejection)
- [ ] **Task 6 — Project-delete cascade hook** (transaction wraps project delete + scan of workspace agents' `frontmatter.projects` to remove the deleted id)

#### Server phase gate
- [ ] Full server suite green
- [ ] Server type-check clean (excluding pre-existing `index.ts`)
- [ ] Manual API smoke (curl POST/GET against workspace + project endpoints)
- [ ] `testing-workflow:phase-complete` invoked

- [ ] **Task 7 — UI rail subtraction + workspace popover** (remove project Agents/Triggers leaves; add Agents+Triggers menu items to `workspace-switcher.tsx`)
- [ ] **Task 8 — Workspace agents+triggers pages + `useWorkspaceAgents`** (new routes `/w/:wslug/agents` and `/triggers`; new `workspace-agents-page.tsx`; delete old project-scoped route files)
- [ ] **Task 9 — `ProjectsField` + assignee picker rewire + E2E** (multi-select with Select-all collapse semantics; assignee picker uses `useWorkspaceAgents` with `keepPreviousData`; Playwright spec `phase-2-5-workspace-agents.spec.ts`)

#### Phase 2.5 phase gate
- [ ] Web suite, server suite, shared suite, both type-checks all green
- [ ] Playwright e2e (existing 26 + new phase-2.5 spec)
- [ ] Smoke checklist walked (8 items in plan)
- [ ] `testing-workflow:phase-complete` invoked

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
