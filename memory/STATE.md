# Folio — STATE

_Last updated: 2026-05-25 (post UX cleanup batch on phase-1.7/crm-polish)_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Phase

Phase numbering aligned with `docs/PHASES.md` (canonical) as of 2026-05-24 reorg. Original Phase 2 (Agents) and Phase 3 (AI/runner) stayed as the v1 spine; new phases slotted around them.

- **Phase 0–0.5 (Foundation + Design system):** shipped.
- **Phase 1 (Core CRUD):** shipped — backend + frontend + slideover + raw-MD round-trip.
- **Phase 1.5 (Tables + Spreadsheet UI):** shipped + merged to main at `af3c0f1` on 2026-05-24. 21 subagent-driven tasks across 1.5a (tables foundation) and 1.5b (spreadsheet UI). Plans: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md` (now Phase 1.5a) + `2026-05-24-phase-2b-spreadsheet-table-ui.md` (now Phase 1.5b).
- **Phase 1.6 (Saved views in rail):** shipped + merged to main at `cfe4ed6` on 2026-05-24. Saved views nest in rail with `?view=<id>` URL contract, filter/sort/columnOrder/visibleFields auto-save to active view, table last column hugs right edge. Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. Merge bundled Phase 1.6.1 (see below).
- **Phase 1.6.1 (Rail completeness):** shipped 2026-05-24, absorbed into `phase-1.6/saved-views` branch. NocoDB-style hover-reveal `+`/`⋯` affordances on every rail row (workspace, project, table, view), double-click rename, confirm-delete dialog. `+ New project` in workspace switcher popover. Wiki as a rail leaf under each project. Per `[[rail-ux-pattern]]` auto-memory.
- **Phase 1.7 (Lightweight CRM polish):** shipped on `phase-1.7/crm-polish` 2026-05-24. 3 of 4 sections shipped (Playbook linking deferred): `last_touched_at` column + Log Activity endpoint + ?stale_for=Nd filter, Activity panel in slideover, color-coded `next_action_due`. 116 server / 173 web / 28 shared. Awaiting manual QA + merge.
- **Phase 1.8 (Time-aware views):** queued — timeline view + This Week dashboard.
- **Phase 2 (Agents):** queued — spine of v1. Tokens, SSE, MCP server, agents-as-documents, triggers-as-documents (surface only).
- **Phase 3 (AI in UI + Agent runner):** queued — second spine. Slash commands, provider abstraction, agent runner, trigger scheduler/matcher.
- **Phase 4 (Inbound webhooks):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-4-inbound-webhooks.md`. 7 tasks.
- **Phase 5 (CMS bridge — Statamic):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-5-statamic-cms-bridge.md`. 10 tasks. WordPress is Phase 5.1.
- **Phase 6 (Per-view render modes):** queued — kanban becomes a render mode; calendar added.
- **Phase 7 (UX polish + admin UIs):** queued — Cmd-K depth, keyboard shortcuts, admin screens for webhooks + sync targets.
- **Phase 8 (Ship):** queued — release pipeline, landing page, first paying customer.

## Current branch

`phase-1.7/crm-polish` — 6 phase commits + 6 auto-memory commits ahead of main (`cfe4ed6`). NOT merged; Stefan is doing a manual QA pass on 1.6 + 1.7 + the post-1.7 fixes before deciding what to merge / revert.

Tests on branch tip: 116 server (was 113, +3 activity endpoint tests) / 173 web (+4 due-urgency) / 28 shared. All green. TS clean.

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
- Rail user menu: avatar/name → popover with `+ Create workspace` + `Sign out`.
- Workspace switcher: workspace tile → popover with full workspace list + `+ Create workspace`. Creating a workspace from inside another no longer dead-ends.

## What's not built yet

See `docs/PHASES.md` for the canonical phase list (above-section mirrors it). Loose items not phase-tracked:

- Workspace AI-key UI (backend exists; lives in Phase 3 settings work).
- Single-binary build verification (`bun build --compile`).
- Docker image verification end-to-end.

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
