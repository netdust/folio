# Folio — STATE

_Last updated: 2026-05-24_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Phase

- **Phase 1 (Core CRUD): shipped.** Backend + frontend + slideover + raw-MD round-trip + acceptance ticks done.
- **Phase 1.5 (UX polish): shipped on `phase-1.5/ux-polish`.** Two waves of polish + a review-driven cleanup commit + 10 wired e2e scenarios landed; awaiting visual sign-off + merge to main.
- **Phase 1.5 (Time-aware views): not started.** Timeline view + This Week dashboard still on the docket per `docs/PHASES.md`.
- **Phase 2A (Tables foundation): shipped on `phase-1.5/ux-polish`.** 9 subagent-driven tasks, schema rework, NocoDB-style table-then-views model. Backend only — UI lands in Phase 2B.
- **Phase 2B (Spreadsheet table UI): shipped on `phase-1.5/ux-polish`.** 12 subagent-driven tasks. Real columnar table with built-ins (title/status/updated_at) + one column per pinned field, drag-to-reorder columns, show/hide picker, currency cell type with Intl.NumberFormat, plus all existing field types (date/select/multi-select/etc) rendered inline. View state (visibleFields + columnOrder) persists to the active view via PATCH.

## Current branch

`phase-1.5/ux-polish`. Tip is the Phase 2A close-out (`35f5c8b` seed-demo verify) on top of the resolveProject + comment cleanups (`a9fd601`). 107 / 107 server unit + 134 / 134 web unit + 28 / 28 shared + 13 / 13 manual-qa e2e + 11 / 11 click-through e2e pass.

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

- Workspace AI-key UI (backend exists, no settings page).
- Single-binary build verification (`bun build --compile`).
- Docker image verification end-to-end.
- Timeline view, This Week dashboard (Phase 1.5 time-aware bundle).
- **Phase 2C — saved views in rail (Linear-style)**: nest tables under projects, views under tables. Click a view = filter applied, render mode applied. Picking active view by URL (?view=:slug) — TableView currently picks default-or-first.
- **Phase 2C.5 — Lightweight CRM polish** (added 2026-05-24): first-class `next_action` / `next_action_due` / `next_action_owner` frontmatter surfaced in spreadsheet + slideover; `last_touched_at` distinct from `updated_at` (touched only by explicit activity log); per-record activity log panel in slideover reading from the existing `events` table; playbook linking from a stage to a wiki page. Use case: agency follow-up CRM, no automation — "where are we / what's next / when's it due / what's the playbook for this stage." Designed to be agent-readable (markdown source-of-truth).
- **Phase 2D — per-view render mode**: views store `renderAs: 'list' | 'kanban' | 'calendar'`. Frontend renders accordingly.
- Tokens / SSE / MCP server (Phase 3).
- Slash commands in body editor (Phase 4).

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

- [2026-05-24] Phase 2B "Spreadsheet table UI" shipped via subagent-driven development. 12 tasks, all spec+quality reviewed. Backend: currency type + views.columnOrder + migration 0004. Frontend: pure column helpers, TableHeader (sort+picker+drag-reorder), TableRow, TableView replaces ListView on work-items route. Seed widened default view's visibleFields + registers 4 standard fields (priority/assignee/labels/due_date) per project. Suite: 107→112 server, 134→154 web. Plan: `docs/superpowers/plans/2026-05-24-phase-2b-spreadsheet-table-ui.md`.
- [2026-05-24] Phase 2A "Tables Foundation" shipped via subagent-driven development. 9 tasks (1 → 2+3 merged → 4 → 5 → 6 → 7 → 8 → 9), all spec+quality reviewed. Schema + migration + middleware + 4 route files + tests + seed verification. Suite: 81→107 server tests, all green. Plan: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md`.
- [2026-05-24] Earlier: wired all 10 skipped manual-qa Playwright scenarios (`55cb795`), silenced TanStack Router warnings via `routeFileIgnorePattern`, seeded demo data via `scripts/seed-demo.ts` for stefan@netdust.be.
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
