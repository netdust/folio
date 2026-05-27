# Folio — STATE

_Last updated: 2026-05-27 (Phase 2.6 sub-phases D + E1 shipped — entire automated build of Phase 2.6 complete on `phase-2.6/comments-and-slideover` branch; manual QA + shake-out + merge are user-side)_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Next up — Phase 2.6 hand-off to user for manual QA + merge

**Phase 2.6 automated build is COMPLETE on `phase-2.6/comments-and-slideover` at `d305810`.** All 30 plan tasks across sub-phases A-E1 shipped + E2 in-session bits (manual-QA scenarios written, DECISIONS appended). Tests across all suites green. What remains is user-side:

1. **Manual QA sweep** — walk `apps/web/tests/manual-qa-phase-2.6.md` (40 scenarios). Mark anomalies as shake-out bugs and fix them in-place with `phase-2.6: BUG-NNN — <fix>` commits.
2. **Playwright suite** — `cd apps/web && bun run e2e`. Known flake on `click-through "wiki: new page"` is fine.
3. **`netdust-core:shake-out` skill invocation** — the post-build QA layer. Will catch what unit tests + manual QA didn't.
4. **Merge call** — once shake-out is clean, invoke `superpowers:finishing-a-development-branch` to `--no-ff` merge into `main` + push.

**Test baseline at hand-off:**
- Server **418 / 1-skip / 0-fail** (was 259 at branch start; +159 tests across all 5 sub-phases).
- Web **504 / 8-skip / 0-fail** (was 339; +165 unit, +8 Playwright TODOs).
- Shared **37 / 0-fail** (was 28; +9 cron tests in D1).
- Scripts (backfill) **6 / 0-fail** (new in D4).

**Phase 3 — AI in UI + Agent runner** still queued. Branches from main when 2.6 merges.


## Phase

Phase numbering aligned with `docs/PHASES.md` (canonical) as of 2026-05-24 reorg. Original Phase 2 (Agents) and Phase 3 (AI/runner) stayed as the v1 spine; new phases slotted around them.

- **Phase 0–0.5 (Foundation + Design system):** shipped.
- **Phase 1 (Core CRUD):** shipped — backend + frontend + slideover + raw-MD round-trip.
- **Phase 1.5 (Tables + Spreadsheet UI):** shipped + merged to main at `af3c0f1` on 2026-05-24. 21 subagent-driven tasks across 1.5a (tables foundation) and 1.5b (spreadsheet UI). Plans: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md` (now Phase 1.5a) + `2026-05-24-phase-2b-spreadsheet-table-ui.md` (now Phase 1.5b).
- **Phase 1.6 (Saved views in rail):** shipped + merged to main at `cfe4ed6` on 2026-05-24. Saved views nest in rail with `?view=<id>` URL contract, filter/sort/columnOrder/visibleFields auto-save to active view, table last column hugs right edge. Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. Merge bundled Phase 1.6.1 (see below).
- **Phase 1.6.1 (Rail completeness):** shipped 2026-05-24, absorbed into `phase-1.6/saved-views` branch. NocoDB-style hover-reveal `+`/`⋯` affordances on every rail row (workspace, project, table, view), double-click rename, confirm-delete dialog. `+ New project` in workspace switcher popover. Wiki as a rail leaf under each project. Per `[[rail-ux-pattern]]` auto-memory.
- **Phase 1.7 (Lightweight CRM polish):** shipped on `phase-1.7/crm-polish` 2026-05-24. 3 of 4 sections shipped (Playbook linking deferred): `last_touched_at` column + Log Activity endpoint + ?stale_for=Nd filter, Activity panel in slideover, color-coded `next_action_due`. 116 server / 173 web / 28 shared. Awaiting manual QA + merge.
- **Phase 1.8 (Time-aware views):** queued — timeline view + This Week dashboard.
- **Phase 1.9 (Field management UI):** shipped + merged to main at `a73b7da` on 2026-05-25 (PR #2). Inline `+ Add column`, column header `⋯` menu (Rename via InlineEdit + Hide + Delete with confirm dialog), "Suggested columns" in picker (deduped + type-inferred), `useFields` table-scoped.
- **Phase 1.9.1 (Type-change UI + useUpdateView fix):** shipped + merged to main at `d12c598` on 2026-05-25 (PR #3). Compatible-only type-change in column `⋯` menu (`string ↔ text`, `number ↔ currency`, `* → text`); 422 with `INVALID_TYPE_CHANGE` for anything else. Default ISO `EUR` auto-injected on `* → currency`; options auto-cleared on `currency → *`. `useUpdateView` envelope unwrap fixed. Web 254 / 1-skip, server 135 / 135, shared 28 / 28, web TS clean.
- **Phase 2 (Agents):** **shipped + merged to main** at `3431301` on 2026-05-26 (PR #4). Bearer auth + scope middleware, in-memory event bus + SSE endpoint with Last-Event-Id replay, migration 0006 widens documents.type to agent + trigger, agent/trigger frontmatter Zod schemas + auto-token-mint + revoke + delegation guard, hand-rolled JSON-RPC MCP server at /mcp with 12 v1 tools, web tokens settings tab + assignee picker + Agents/Triggers rail leaves + DocumentTypeList, 4 reference doc files (API/MCP/AGENTS/TRIGGERS), README walkthrough. Shake-out caught 4 bugs (A/B/C/D), all fixed and committed before merge.
- **Phase 2.5 (Workspace-scoped agents):** **shipped + merged to main + pushed** at `7d73124` on 2026-05-26. 45 commits (18 plan-execution + 12 shake-out fixes + 14 memory/auto-capture + the merge commit + the Phase 3.5 doc draft). `documents.workspace_id NOT NULL` + nullable `project_id` + CHECK constraint; agent + trigger Zod gain `projects: string[]` (default `['*']`); new `requireResource` middleware mounted on `pScope` blocks cross-allow-list bearer access; `/api/v1/w/:wslug/documents` endpoints for agent + trigger CRUD; project-level POST/GET reject those types; MCP `list_projects` filters by allow-list, project-scoped tools return `-32602 agent_not_in_allow_list` on disallowed projects, agent-lifecycle tools rejected (HTTP-only in 2.5). Project-delete cascades through workspace agents' frontmatter.projects transactionally. UI: rail leaves removed, workspace popover gains Agents/Triggers entries, new `/w/:wslug/agents` + `/triggers` pages with full slideover CRUD, new design-system `<Chip>` primitive (BUG-010), ProjectsField + ToolsField + ProviderModelField multi-selects, per-agent-field help text. Shake-out caught 12 bugs, 11 fixed, 1 deferred as pre-existing (table-cell assignee picker — never wired pre-2.5). Suite at merge: server 259 / 1-skip / 0-fail, web 339 / 1-skip / 0-fail, shared 28 / 0-fail, Web TS clean. Phase 2.5 Playwright e2e: 1/1.
- **Phase 2.6 (Comments + tabbed slideover + trigger form + reconciler):** **automated build complete on `phase-2.6/comments-and-slideover` at `d305810`.** All 5 sub-phases shipped: A (comments core), B (MCP comment tools), C (tabbed slideover + UI), D (cron helper + trigger schema $event/builtin lock + builtin auto-seed + backfill + cron-input + trigger-form + slideover mount + MCP agent-lifecycle + docs), E1 (allow-list reconciler). E2 in-session pieces done: manual-QA scenarios written (`apps/web/tests/manual-qa-phase-2.6.md`), DECISIONS appended. Manual QA + Playwright + shake-out + merge are user-side. Suite: server **418 / 1-skip / 0-fail** (+159 since branch start), web **504 / 8-skip / 0-fail** (+165 unit, +8 Playwright TODOs), shared **37 / 0-fail** (+9), scripts **6 / 0-fail** (new).
- **Phase 3 (AI in UI + Agent runner):** queued — second spine. Slash commands, provider abstraction, agent runner, trigger scheduler/matcher.
- **Phase 4 (Inbound webhooks):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-4-inbound-webhooks.md`. 7 tasks.
- **Phase 5 (CMS bridge — Statamic):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-5-statamic-cms-bridge.md`. 10 tasks. WordPress is Phase 5.1.
- **Phase 6 (Per-view render modes):** queued — kanban becomes a render mode; calendar added.
- **Phase 7 (UX polish + admin UIs):** queued — Cmd-K depth, keyboard shortcuts, admin screens for webhooks + sync targets.
- **Phase 8 (Ship):** queued — release pipeline, landing page, first paying customer.

## Current branch

`phase-2.6/comments-and-slideover` at `d305810` (ahead of `main` by ~50 non-memory commits + auto-memory). NOT pushed. Phase 2.6 sub-phases A + B + C + D + E1 shipped; E2 = user-side (manual QA + Playwright + shake-out + merge).

Tests on this branch: **server 418 / 1-skip / 0-fail, web 504 / 8-skip / 0-fail, shared 37 / 0-fail, scripts/backfill 6 / 0-fail**. Web TS clean on all D-touched files. Server TS — pre-existing errors elsewhere not regressed by 2.6.

**Known flake:** `apps/web/src/components/views/list-view-create.test.tsx` intermittently fails in full-suite runs due to high-concurrency jsdom interaction. Passes in isolation. See `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_known-test-flakes.md`.

**Handoff doc:** `docs/superpowers/handoffs/2026-05-27-phase-2.6-handoff.md` — written end of A+B+C; sub-phases D+E1 layered on top in this session. Manual QA scenarios live at `apps/web/tests/manual-qa-phase-2.6.md`.

### Phase 2.6 sub-phases A + B + C — what shipped

**Sub-phase A (Comments core, 8 tasks):** migration 0007 (`comment` type + CHECK + index), `lib/comment-schema.ts` (Zod with strict refines), `lib/mention-parser.ts` (regex + agent/member resolution + approval-keyword grammar w/ pos-1 adjacency whitelist), 4 new event kinds + `?parent` + `?run` SSE filters, `services/comments.ts` (create/update/delete/get/list + transactional events + soft-delete + idempotency), `routes/comments.ts` (5 REST endpoints under `pScope`), workspace-level `/documents/:slug/activity` for agents (Phase 2.5 deferral resolved). A5 caught + fixed a latent bug where A1's migration was missing from `_journal.json`.

**Sub-phase B (MCP comment tools, 2 tasks):** 4 new tools (`create_comment` / `list_comments` / `update_comment` / `delete_comment`) added to the hand-rolled JSON-RPC dispatch in `routes/mcp.ts`. Author resolution from bearer token (agent or human PAT). Author-only enforcement on update/delete. `docs/MCP.md` updated.

**Sub-phase C (Tabbed slideover + Comments UI, 11 tasks):** `TabStrip` primitive, `lib/api/comments` hooks (with optimistic updates locked by mid-flight assertion test), `MentionPicker` (allow-list-filtered agents + members, keyboard nav), `WikiLinkPicker` (project docs by title — current-project scope per user decision), `CommentComposer` (Milkdown-lite + @-mention + [[ -wiki-link + Cmd+Enter + localStorage draft + focus return), `CommentRow` (author/timestamp/kind/body/hover-affordances + soft-delete + plaintext markdown + inline mention/wiki-link chips), `ApprovalButtons` (Approve/Reject on `kind=plan` + resolution detection), `CommentsTab` (composer + list + visibility toggle + inline edit + delete confirm), slideovers rewrapped with TabStrip, workspace ActivityPanel + LogActivityButton (sibling components for workspace docs + new server `GET /:slug/events` endpoint).

### Phase 2.6 sub-phase D — what shipped

**D (9 tasks, all green):** D1 `packages/shared/src/cron.ts` exports `nextFires(cron, n, now?)` + relocated `validateCronShape` from server. D2 `triggerFrontmatterSchema` accepts `agent: $event.<key>|null|optional`, `builtin: bool`, `internal_action: 'resume_run'|'reject_run'`; updateDocument + deleteDocument enforce `BUILTIN_TRIGGER_LOCKED` (422). D3 `apps/server/src/lib/builtin-triggers.ts` defines 4 builtin trigger seeds; `POST /api/v1/workspaces` inserts them inside its existing transaction. D4 `scripts/backfill-builtin-triggers.ts` — idempotent, emits `document.created` per insert (spec §9). D5 `apps/web/src/components/triggers/cron-input.tsx` live ✓/✗ + 3-fire preview. D6 `trigger-form.tsx` schedule/event toggle + cron-input + event-kind dropdown sourced from `KNOWN_EVENT_KINDS` (relocated to shared), filter rows, agent dropdown + custom `$event.<key>` option, JSON payload textarea, enabled toggle, builtin read-only mode. D7 `workspace-document-slideover.tsx` renders TriggerForm for `type='trigger'` inside a `TriggerFieldsTabPane` (local-draft + Save button). D8 4 new MCP tools (`create_agent`, `update_agent`, `delete_agent`, `get_agent_self`) + new `agents:write` scope wired through `toolsToScopes` + tokens-tab UI (checkbox + Read+write/Full presets). D9 docs (MCP/AGENTS/TRIGGERS/PHASES).

### Phase 2.6 sub-phase E — what shipped (E1) / user-side (E2)

**E1:** `apps/server/src/lib/reconciler.ts::reconcileAllowLists(db, opts?)` scrubs orphan project ids from non-wildcard agents' `frontmatter.projects`, emits `agent.allow_list.reconciled` per scrubbed agent. Boot wiring in `index.ts` via `setInterval` gated on `NODE_ENV !== 'test'`. New env `FOLIO_RECONCILER_INTERVAL_MS` (min 60s, default 1h). 6 unit tests cover orphan scrub / wildcard skip / no-op / idempotency / multiple orphans / custom actor.

**E2 (user-side, not in-session):** Manual QA per `apps/web/tests/manual-qa-phase-2.6.md` (40 scenarios) → Playwright e2e → `netdust-core:shake-out` → STATE/DECISIONS final tick → `superpowers:finishing-a-development-branch` to merge `--no-ff` into main.

### Phase 2.6 commit list (newest first, top of `phase-2.6/comments-and-slideover`)

- `d305810` phase-2.6: allow-list reconciler — periodic orphan scrub (E1)
- `d18440e` phase-2.6: docs — agent-lifecycle MCP tools + builtin triggers + $event syntax + structured trigger form (D9)
- `151977a` phase-2.6: MCP agent-lifecycle tools + agents:write scope (D8)
- `f245387` phase-2.6: trigger slideover Fields tab renders TriggerForm (D7)
- `3428b5b` phase-2.6: trigger-form — schedule/event toggle + cron + filters + JSON payload + builtin read-only (D6)
- `086fccc` phase-2.6: cron-input — live validation + next-3-fires preview (D5)
- `72c7c90` phase-2.6: backfill-builtin-triggers script (D4) — idempotent restore
- `a565fed` phase-2.6: auto-seed 4 builtin triggers on workspace create (D3)
- `1aa817b` phase-2.6: trigger schema — $event syntax + internal_action + builtin lock (D2)
- `f3a18e4` phase-2.6: shared/cron — nextFires(cron, n) + relocate validateCronShape (D1)
- `b5325e7` phase-2.6: pin O3 deferral — updateComment does NOT recompute target_agent
- `57c9e00` phase-2.6: handoff after sub-phases A+B+C; STATE + plan + spec tracked
- `139ee5a` phase-2.6: workspace agent slideover Activity tab wires ActivityPanel + LogActivity (Phase 2.5 deferral) — C10
- `b0a31e6` phase-2.6: wrap slideovers with TabStrip (work_item/page → 3 tabs; agent/trigger → 3 different tabs) — C9
- (older A+B+C commits omitted — see handoff doc for full list)

### Phase 2 commit list (newest first, top of `phase-2/agents-surface`)

- Docs commit (this session): docs/API.md + docs/MCP.md + docs/AGENTS.md + docs/TRIGGERS.md + README walkthrough
- `3292e01` phase-2: ai-keys hooks — fix 404 URL + thread wslug (Bug D)
- `ca7fb81` phase-2: documents list — apply type filter for agent + trigger (Bug C)
- `9164e5d` phase-2: token modal — add statuses:write + Read-only/Read+write/Full presets (Bug B)
- `76cdca3` phase-2: fix sticky-column e2e selector after header refactor (Bug A)
- `2e046ae` phase-2: rail — Agents + Triggers leaves under each project (Task 16)
- `a9cba37` phase-2: assignee picker — humans + agents (Task 15 + new /members endpoint)
- `18fa174` phase-2: workspace settings — API tokens tab (Task 14, new /w/:wslug/settings route)
- `d3ef26f` phase-2: useTokens / useCreateToken / useDeleteToken hooks (Task 13)
- `386a1db` phase-2: cover update/delete/list_statuses/run_view in MCP tests
- `4fc7e2a` phase-2: hand-rolled JSON-RPC MCP at /mcp with v1 tool set (Task 12)
- `95f41ca` phase-2: extract MCP-relevant logic into services/* (Task 12 precursor)
- `0d9b1d1` phase-2: delegation guard with parent-chain depth enforcement (Task 11)
- `97d3d47` phase-2: emit agent.task.assigned on assignee transition (Task 10)
- `3d9dbc9` phase-2: auto-mint agent token on create; revoke on delete (Task 9)
- `b7620d2` phase-2: validate agent/trigger frontmatter on documents POST/PATCH (Task 8)
- `80b1f7d` phase-2: trigger frontmatter Zod schema + cron-shape validator (Task 7)
- `3b74d76` phase-2: agent frontmatter Zod schema + toolsToScopes (Task 6)
- `d68f4eb` phase-2: widen documents.type to include agent + trigger (Task 5)
- `ab05622` phase-2: SSE endpoint with Last-Event-Id replay (Task 4)
- `fe5db61` phase-2: in-memory event bus + publish on emitEvent (Task 3)
- `fa8f292` phase-2: route mutations through requireScope for bearer requests (Task 2)
- `ee9548d` phase-2: add bearer auth middleware with scope enforcement (Task 1)

### Phase 2 deferrals (intentional, not blocking PR)

- Inline-rename of token name in tokens tab (Phase 2.1).
- Structured trigger form (cron input with validate affordance + event-kind select). Current slideover uses generic frontmatter form — round-trips correctly but doesn't pretty-render cron.
- Bulk MD export including triggers under `projects/<pslug>/trigger/<slug>.md` (Phase 7 polish).
- `get_folio_workflow` MCP tool (Phase 2.1).
- `requires_approval` + `max_tokens_per_run` enforcement (Phase 3 runner-side).
- The `## Approved` body convention (Phase 3 — human-in-the-loop).
- `search_documents` MCP tool (v1.1 — needs sqlite-fts5).

### Phase 2.5 commit list (newest first, merged into main at `7d73124`)

- `7d73124` phase-2.5: workspace-scoped agents (merge — `--no-ff`)
- `fd0cfbd` shake-out: e2e re-verified green post-BUG-012
- `7fa3d8b` docs: draft Phase 3.5 — script & webhook trigger actions (folded into this merge)
- `d43b3c1` shake-out: final status — 11 resolved, 1 deferred, ready for branch close
- `be319c4` phase-2.5: BUG-012 — soften Chip at-rest weight (rounded-md + border-border-light)
- `ebb20f5` phase-2.5: BUG-009 — field-help text on agent slideover
- `fc74886` phase-2.5: BUG-010 + BUG-011 — single `<Chip>` primitive, migrate 3 ad-hoc chips
- `bd9d492` phase-2.5: BUG-006 — paired provider/model field with AI-key annotation
- `a3a3902` phase-2.5: BUG-007 — ToolsField multi-select from V1_MCP_TOOLS
- `d805503` phase-2.5: BUG-008 — chip visible at rest on agents page (superseded by BUG-010)
- `0a3dbc3` phase-2.5: BUG-002 — Phase 2.5 e2e spec passes
- `397d224` phase-2.5: BUG-003 — icons on workspace popover Agents/Triggers
- `f94ebc5` phase-2.5: BUG-004 — workspace agents/triggers slideover + create/delete UI
- `174c3d9` phase-2.5: BUG-001 — mount requireResource on project-scoped routes
- `a10a2fa` phase-2.5: ProjectsField + assignee picker rewire + e2e spec
- `137bba9` phase-2.5: UI rail subtraction + workspace agents/triggers pages
- `7cedf08` phase-2.5: fix TS narrow on slugUniqueInWorkspaceDocuments call
- `032621c` phase-2.5: project-delete cascade — scrub id from workspace agent allow-lists
- `4663f62` phase-2.5: MCP — allow-list enforcement + list_projects filter + agent-lifecycle rejection
- `11f22e0` phase-2.5: workspace-scoped document routes — reject agent/trigger at project level
- `29bf253` phase-2.5: requireResource middleware + intersect() — bearer allow-list enforcement
- `e463c31` phase-2.5: agent frontmatter — projects allow-list with wildcard exclusivity
- `93511c1` phase-2.5: task 1 cleanup — wire workspace_id + skip Phase-2-only agent tests
- `af93935` phase-2.5: schema + migration — workspace-scoped documents + token allow-list
- `19f02b8` phase-2.5: plan — 9 tasks with testing-workflow gates
- `92c20bf` phase-2.5: spec — absorb stress-test feedback (pre-branch)
- `0fc10b8` phase-2.5: design — workspace-scoped agents (pre-branch)

### Phase 2.5 deferrals (Phase 2.6 + Phase 3)

- `create_agent` / `update_agent` / `delete_agent` / `get_agent_self` MCP tools — Phase 2.6 (agents can't create/edit other agents via MCP yet; HTTP-only in Phase 2.5).
- Single-project `project_slug` arg inference (when an agent's allow-list has exactly one id) — Phase 2.6 polish.
- Templates as a whole (instance-level Settings page, inert markdown, `template:` + `template_version:` references on instances, sync UI) — Phase 2.6.
- Background allow-list reconciler (periodic sweep that removes orphan project ids from agent `frontmatter.projects`; insurance against bugs in the cascade hook + hand-edited MD + partial restore-from-backup) — Phase 2.6.
- Human PAT `project_ids` enforcement (schema column exists from Phase 2.5; enforcement waits until human PATs get a UI for narrowing) — Phase 3+.
- Per-project action-scope overrides (read on A, write on B) — only if a real use case shows up.
- Caching the agent's `projects:` allow-list in `requireResource` — measure perf first.
- Workspace-scoped `.md` export endpoint (so the workspace slideover can offer Copy-as-MD and the bulk-export folder can include agents/triggers under `agents/<slug>.md`) — Phase 2.6 polish.
- ActivityPanel + LogActivity on workspace agent slideover (project-scoped only today) — Phase 2.6 polish.
- BUG-005 from shake-out: table-cell assignee picker (was never wired pre-2.5 either). Phase 7 UX polish.

### Phase 1.9.1 commit list (newest first)

- `1e9548f` phase-1.9.1: fix useUpdateView envelope unwrap
- `a0bccf2` phase-1.9.1: wire Change type into ColumnMenu and TableView
- `a4f84d0` phase-1.9.1: add ColumnTypeChange dialog
- `4153af4` phase-1.9.1: enforce type-change compatibility on field PATCH
- `8707020` phase-1.9.1: add validateTypeChange compatibility helper

### Phase 1.9 commit list (newest first)

- `bed090d` phase-1.9: clarify delete-column copy is page-scoped
- `47f2263` phase-1.9: polish add-column Create button disabled state
- `9c86918` phase-1.9: Suggested columns section in ColumnPicker
- `9961ae2` phase-1.9: columnSuggestions helper
- `0e336fe` phase-1.9: column header ⋯ menu (rename / hide / delete)
- `cfed068` phase-1.9: mount TableAddColumn at the right end of the header
- `bd5e96e` phase-1.9: add TableAddColumn popover form
- `85d42d0` phase-1.9: add useCreateField/useUpdateField/useDeleteField
- `99f0c30` phase-1.9: thread tslug through TableView and its callers
- `b9acb0a` phase-1.9: rescope useFields query key to (wslug, pslug, tslug)

### 2026-05-25 UX cleanup batch (5 items, all green)

Shipped on `phase-1.7/crm-polish` (uncommitted as of this snapshot). 9 new unit tests added; full unit suite at 214 / 215 web (was 173), 123 / 123 server, 28 / 28 shared. TS clean for the touched files; pre-existing TS errors in `apps/server/src/index.ts` and `packages/shared/src/filter-compile.test.ts` are unrelated.

1. **Rail tree chevron on hover.** `apps/web/src/components/shell/rail-tree.tsx` — leading folder/doc icon swaps to chevron on row hover (single slot). Non-expandable rows keep their icon always. Tests in `rail-tree.test.tsx`.
2. **Sticky horizontal scrollbar at viewport bottom.** `apps/web/src/components/table/table-view.tsx` — TableView now owns its scroll context with `flex h-full min-h-0 flex-col` outer + `flex-1 min-h-0 overflow-auto` scroll wrapper. The horizontal scrollbar sits at the bottom of that flex item, which is the viewport bottom inside MainFrame's content area. MainFrame itself is left alone.
3. **Sticky first-column right border.** `table-cell.tsx:40` + `table-header.tsx:113` — `border-r border-border-light pr-3` on the sticky branch. Test in new `table-cell.test.tsx`.
4. **Add-row at table bottom.** New `apps/web/src/components/table/table-add-row.tsx`. Renders only when there are existing docs (EmptyState already CTAs for the zero state). Click → inline title edit → on commit, `createDocument` then navigate to `?doc=<slug>` to open the slideover for the rest of the frontmatter. Three tests in `table-view.test.tsx` (renders, happy path, empty cancel).
5. **Slideover toolbar.** `document-slideover.tsx` — header right-side now Copy MD + Edit/Raw + Activity + vertical divider + ⋯ (Popover) + Close. ⋯ menu houses Delete (destructive). Delete fires a Dialog (existing `ui/dialog.tsx` primitive) with title quote + Cancel + danger Delete; on confirm, calls `useDeleteDocument` then closes the slideover. `mode` state + Alt+M listener lifted to `DocumentSlideover`. Body header simplified to just the slug pill. Three tests in `document-slideover.test.tsx`.

Decisions, locked via AskUserQuestion this session:
- Rail: icon→chevron swap on row hover (single slot).
- Delete: confirm dialog (no toast-undo / soft-delete).
- Add-row: inline title in row → open slideover for rest. NOT optimistic-create with default 'Untitled'.
- Scrollbar: sticky inside main scroll area, NOT fixed overlay.
- Toolbar: visible Copy MD + Edit/Raw + Activity; ⋯ menu houses Delete and is room to grow.

### Open UX issue at session end (DO NOT touch without re-reading)

After Phase 1.7's ColumnPicker hoist (`3614ed4`), a follow-up issue remains:
- The picker icon now sits in the FilterBar row, right-aligned to the whole viewport.
- Stefan reports it "floats above the table in empty space" — visually disconnected from the columns.
- He also still sees a horizontal scrollbar even when the table content fits the viewport.
- His ask: picker should be "right aligned in the last column" — i.e. visually inside the table header, top-right of the columns area, not floating above.

I attempted an `absolute right-0` overlay approach in a non-committed edit and reverted it on Stefan's request. **Next session: investigate via Chrome DevTools FIRST**, don't guess. The scroll trigger needs measurement; the visual disconnect needs a different layout strategy than "separate row above table."

### Phase commit list on this branch (newest first)

- `94ac10f` memory: auto-capture session end
- `3614ed4` fix: hoist ColumnPicker out of the table's horizontal scroll area (the "floats above" change)
- `527263b` memory: auto-capture
- `4bf5ff4` fix: auto-migrate dev DB on server boot
- `6bd9a47` memory: auto-capture
- `9fbe81d` fix: row height + sticky-cell hover mismatch (verified in Chrome — row 50→34px, sticky cell tracks row hover via group/row)
- `3599fb1` memory: auto-capture
- `acc535a` fix: table row height + InlineEdit hover-bg regressions from phase 1.6 (partial — these were guesses, the real fix was 9fbe81d)
- `c19763d` memory: auto-capture
- `a6f8a60` phase-1.7: fix table row height regression from urgency wrapper
- `34ed292` memory: auto-capture
- `3b334be` phase-1.7: complete — last_touched_at, activity log, due-urgency

## What's working in the UI

- Sign-up / login / magic-link flow.
- Workspace + project list, project picker.
- Spreadsheet table view at the Work Items tab — one column per pinned field (currency/date/select/multi-select all render inline), built-ins (title/status/updated_at) always sortable, columns hideable via picker, drag header to reorder, state persists per-view.
- Kanban view (drag-drop status change, per-column `+`, subtle panel surface).
- Wiki tree (parent_id hierarchy, drag-to-reparent with cycle guard).
- Slideover with Milkdown + CodeMirror raw-MD toggle; round-trips byte-for-byte per the round-trip test.
- Cmd-K palette (open via top-right Search nav OR `⌘K`).
- Theme toggle, rail collapse persistence in localStorage.
- Rail user menu: avatar/name → popover with `+ Create workspace` + **Settings** (new in Phase 2 — opens `/w/:wslug/settings`) + `Sign out`.
- Workspace switcher: workspace tile → popover with full workspace list + `+ Create workspace`. Creating a workspace from inside another no longer dead-ends.
- Inline `+ Add column` at the right end of the spreadsheet header — popover form (key + label + type + per-type options).
- Column header `⋯` menu (hover-reveal on non-builtin columns): Rename (InlineEdit on the label), Hide column, Delete column (confirm dialog with affected-doc count).
- "Suggested columns" section in the column picker — surfaces orphan frontmatter keys with inferred type; one-click `+ Pin`.
- Column `⋯ → Change type` (Phase 1.9.1) — compatible-only transitions (`string ↔ text`, `number ↔ currency`, `* → text`); server returns 422 with a clear allowed-transitions message for anything else. Default ISO `EUR` injected on `* → currency`; options cleared on `currency → *`.
- **Workspace settings page (Phase 2)** — `/w/:wslug/settings` with Tabs scaffold. Today: "API tokens" tab only.
- **API tokens tab (Phase 2)** — list/create/revoke tokens; `+ Create token` modal with name + 7 scope checkboxes (`documents:{read,write,delete}`, `fields:write`, `views:write`, `tables:write`, `statuses:write`) + Read-only/Read+write/Full access preset buttons; one-time plaintext reveal with Copy; revoke confirm dialog.
- **Assignee picker (Phase 2)** — `frontmatter.assignee` of any work item opens a Popover with Members (via `/api/v1/w/:wslug/members`) and Agents (via `useDocuments` `type=agent`) sections. Members write the email; agents write `agent:<slug>`. Picker is auto-wired by `FrontmatterForm` whenever `key === 'assignee'`.
- **Agents + Triggers rail leaves (Phase 2)** — each project shows `Agents` and `Triggers` leaves alongside `Wiki`. Routes at `/w/:wslug/p/:pslug/agents` and `/triggers` render a `DocumentTypeList` filtered by type; click → slideover.

## What's not built yet

See `docs/PHASES.md` for the canonical phase list (above-section mirrors it). Loose items not phase-tracked:

- Workspace AI-key UI in the new settings page (backend hooks now point at the correct URL after Bug D; UI lives in Phase 3 settings work).
- Single-binary build verification (`bun build --compile`).
- Docker image verification end-to-end.
- Structured trigger form (cron input with validate affordance + event-kind select). Slideover currently uses generic frontmatter form — round-trips correctly but doesn't pretty-render cron.

## Open Threads

- **Pre-Phase-2 cleanups** (per `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_main-tip-and-pre-phase-2-cleanups.md`): 3 items queued before Phase 2 starts.
- **Phase 1.5 ux-polish gates** (per auto-memory `project_phase-1.5-ux-polish-shipped`): manual QA pass + visual sign-off against canonical mockups + merge to main.
- **Untracked at repo root:** `.zed/` (editor settings), `labeled-actual.png` (mockup-vs-actual comparison artifact). Leave as-is unless they need to be committed or .gitignored.

## Where things live

- **Frontend code:** `apps/web/src/`. Primitives `components/ui/`, shell `components/shell/`, views `components/views/`, kanban `components/kanban/`, slideover `components/slideover/`, inline edits `components/inline/`.
- **API client:** `apps/web/src/lib/api/` — one file per resource, returns react-query hooks.
- **Server:** `apps/server/src/` — Hono routes under `routes/`, frontmatter helpers in `lib/`.
- **Shared types + Zod schemas:** `packages/shared/src/`.
- **Tokens:** `apps/web/src/styles/tokens.css`. Tailwind mappings in `apps/web/tailwind.config.ts`.
- **Brainstorm mockups (HTML):** `.superpowers/brainstorm/94899-1778514720/content/`.

## Live tests

- `bun run test` in `apps/web/` → Vitest. 154 / 154 pass + 1 skipped (jsdom limitation on Milkdown initial render). Phase 2B added columns.test.ts (15), currency-cell.test.tsx (4), table-view.test.tsx (1).
- `cd apps/server && bun test` → 112 / 112 pass (Phase 2B added currency + columnOrder tests on top of 2A's tables/scope coverage).
- `cd packages/shared && bun test` → 28 / 28 pass.
- `bun test` from the repo root invokes Bun's runner, not Vitest — do NOT use it for web tests. Use `bun run --filter @folio/web test` or `cd apps/web && bun run test`.
- `bun run e2e` in `apps/web/` → Playwright. 26 / 26 pass when run in isolation (3 smoke + 10 click-through + 13 manual-qa). One known flake: click-through "wiki: new page" at position #25 in the long serial run can timeout (server lag, not regression — passes solo in 3.5s). Manual-qa scenario 11 (copy-as-MD clipboard) has occasionally flaked in headless Chromium against `navigator.clipboard.readText()`.
- Click-through journeys (no API shortcuts — discover bugs the way users do): `apps/web/tests/e2e/click-through.spec.ts`. Add new regressions HERE when bugs are found via manual exploration.
- API-shortcut smoke: `apps/web/tests/e2e/smoke.spec.ts`. Manual-qa map: `apps/web/tests/e2e/manual-qa.spec.ts`. Config + helpers: `apps/web/playwright.config.ts`, `apps/web/tests/e2e/global-setup.ts`, `apps/web/tests/e2e/fixtures.ts`.
- Boots its own dev stack on ports 5174 (web) / 3002 (api), isolated SQLite at `apps/server/folio-e2e.db` (gitignored, wiped on every run via `global-setup.ts`). Cold-start is ~4.5 minutes mostly Vite warmup; individual tests are 1–3s.

## Servers

- Web dev: `http://localhost:5173/` (Vite).
- API dev: `http://localhost:3001/` (Hono via Bun, `--hot`).
- `bun dev` from repo root starts both via workspace filter.
- API has no `/` or `/health` route → expect 404 on root; the auth probe at `/api/v1/auth/me` is the right liveness signal.
## Session log

- [2026-05-24 late night] Phase 1.6 "Saved views in rail" shipped via subagent-driven development on `phase-1.6/saved-views`. 9 of 10 planned tasks executed; Task 10 (Playwright e2e journey) descoped on user call — coverage via 21 new unit/RTL tests across rail-tree, buildRailTree, new-view-sheet, save-filters-action, table-view hydration + sort auto-save. Two real bugs caught in flight: (a) plan-vs-reality drift on UUIDv7 vs nanoid for view ids (CLAUDE.md aspirational, code uses nanoid — corrected mid-flight via commit `602964e`); (b) filtersEqual returning false-positives on seeded views because it included view-only `type` key + didn't coerce scalar/$eq against URL array shape (fixed in `f7fdb83`). Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. Suite: 112→113 server, 154→175 web (+21). Awaiting manual QA + merge.
- [2026-05-24 night] Merged `phase-1.5/ux-polish` → `main` with `--no-ff` (merge commit `af3c0f1`). 201 commits behind on main fast-forwarded into a single visible merge. Pushed to `origin/main`. All 294 unit tests green pre-merge (154 web + 112 server + 28 shared). Branch kept for reference; next phase will branch from `main`.
- [2026-05-24] Phase 2B "Spreadsheet table UI" shipped via subagent-driven development. 12 tasks, all spec+quality reviewed. Backend: currency type + views.columnOrder + migration 0004. Frontend: pure column helpers, TableHeader (sort+picker+drag-reorder), TableRow, TableView replaces ListView on work-items route. Seed widened default view's visibleFields + registers 4 standard fields (priority/assignee/labels/due_date) per project. Suite: 107→112 server, 134→154 web. Plan: `docs/superpowers/plans/2026-05-24-phase-2b-spreadsheet-table-ui.md`.
- [2026-05-24] Phase 2A "Tables Foundation" shipped via subagent-driven development. 9 tasks (1 → 2+3 merged → 4 → 5 → 6 → 7 → 8 → 9), all spec+quality reviewed. Schema + migration + middleware + 4 route files + tests + seed verification. Suite: 81→107 server tests, all green. Plan: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md`.
- [2026-05-24] Earlier: wired all 10 skipped manual-qa Playwright scenarios (`55cb795`), silenced TanStack Router warnings via `routeFileIgnorePattern`, seeded demo data via `scripts/seed-demo.ts` for stefan@netdust.be.
- [2026-05-24 evening] Reorg of `docs/PHASES.md` after audit revealed I'd been drifting off the canonical phase plan. Original Phase 2 (Agents) + Phase 3 (AI/runner) stay as v1 spine. What I'd been calling "Phase 2A/2B" → Phase 1.5; "Phase 2C" → 1.6; "Phase 2C.5" → 1.7; original "Phase 1.5 time-aware" → 1.8; webhooks → Phase 4; CMS bridge → Phase 5; "Phase 2D" → Phase 6. Renamed the two queued plans (`phase-2-6-inbound-webhooks.md` → `phase-4-inbound-webhooks.md`; `phase-3-statamic-cms-bridge.md` → `phase-5-statamic-cms-bridge.md`) + updated cross-references inside them.
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
