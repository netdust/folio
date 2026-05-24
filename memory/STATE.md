# Folio — STATE

_Last updated: 2026-05-24 (post phase-1.6 build)_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Phase

Phase numbering aligned with `docs/PHASES.md` (canonical) as of 2026-05-24 reorg. Original Phase 2 (Agents) and Phase 3 (AI/runner) stayed as the v1 spine; new phases slotted around them.

- **Phase 0–0.5 (Foundation + Design system):** shipped.
- **Phase 1 (Core CRUD):** shipped — backend + frontend + slideover + raw-MD round-trip.
- **Phase 1.5 (Tables + Spreadsheet UI):** shipped + merged to main at `af3c0f1` on 2026-05-24. 21 subagent-driven tasks across 1.5a (tables foundation) and 1.5b (spreadsheet UI). Plans: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md` (now Phase 1.5a) + `2026-05-24-phase-2b-spreadsheet-table-ui.md` (now Phase 1.5b).
- **Phase 1.6 (Saved views in rail):** shipped on `phase-1.6/saved-views` 2026-05-24. 9 implementation tasks (Task 10 Playwright descoped — coverage via 21 new unit/RTL tests). Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. 113 server / 175 web (+21) / 28 shared. Awaiting manual QA + merge.
- **Phase 1.7 (Lightweight CRM polish):** queued — `next_action` first-class fields, `last_touched_at`, activity log panel, playbook linking.
- **Phase 1.8 (Time-aware views):** queued — timeline view + This Week dashboard.
- **Phase 2 (Agents):** queued — spine of v1. Tokens, SSE, MCP server, agents-as-documents, triggers-as-documents (surface only).
- **Phase 3 (AI in UI + Agent runner):** queued — second spine. Slash commands, provider abstraction, agent runner, trigger scheduler/matcher.
- **Phase 4 (Inbound webhooks):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-4-inbound-webhooks.md`. 7 tasks.
- **Phase 5 (CMS bridge — Statamic):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-5-statamic-cms-bridge.md`. 10 tasks. WordPress is Phase 5.1.
- **Phase 6 (Per-view render modes):** queued — kanban becomes a render mode; calendar added.
- **Phase 7 (UX polish + admin UIs):** queued — Cmd-K depth, keyboard shortcuts, admin screens for webhooks + sync targets.
- **Phase 8 (Ship):** queued — release pipeline, landing page, first paying customer.

## Current branch

`phase-1.6/saved-views` — 10 commits ahead of main (`af3c0f1`). Phase 1.6 build complete; awaiting manual QA + merge. 113 / 113 server unit + 175 / 175 web unit + 1 skipped + 28 / 28 shared.

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
