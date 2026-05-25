# Folio — Phases

Eight phases to v1. Each is a focused chunk. Check tasks off as you complete them. When a phase is done, commit `phase-N: complete` and move on.

For full context on any decision: `@docs/FOLIO-BRIEFING.md`. For the operating manual: `@../CLAUDE.md`.

> **Reading guide (2026-05-24 revision).** This doc was reorganized so the originally-locked **Phase 2 (Agents)** and **Phase 3 (AI in UI + Agent runner)** stay the spine of v1 — those are Folio's moat and shipping them unchanged is the goal. New phases (1.5/1.6/1.7/1.8/4/5/6) fit *around* the spine, not in place of it. The 0/0.5/1 foundation is shipped; 1.5/1.6/1.7/1.8 polish the operational UI to "good enough to use"; 2/3 deliver the agent platform; 4/5 close the loop with the customer's website; 6/7 polish; 8 ships.

---

## Phase 0 — Foundation (Week 1)

**Goal:** Bootable empty shell. `bun dev` runs both backend and frontend. The single-binary compile pipeline works. A user can sign up, log in, create a workspace and a project, and configure an AI key.

### Repo & tooling

- [x] `bun init` + workspace setup (`apps/server`, `apps/web`, `packages/shared`)
- [x] Root `package.json` with workspace globs and shared scripts (`dev`, `build`, `test`)
- [x] Biome config at root (`biome.json`) — formatter + linter
- [x] `.gitignore`, `LICENSE` (MIT), starter `README.md`
- [x] TypeScript configs: root `tsconfig.base.json`, app-level extends
- [x] Path aliases: `@/` in each app, `@folio/shared` for the shared package *(completed in Phase 0.5 Plan A Task 2)*

### Server foundation

- [x] Hono app skeleton: `app.ts` composes routes, `index.ts` is the Bun entrypoint *(completed in Phase 0.5 Plan A Task 3)*
- [x] Env validation via Zod (`env.ts`) — fail fast if `FOLIO_MASTER_KEY` is missing
- [x] Logger middleware, error handler, CORS for dev *(error handler + dev CORS completed in Phase 0.5 Plan A Tasks 4-5)*
- [x] Health route `GET /healthz` returns `{ ok: true, version: ... }` *(completed in Phase 0.5 Plan A Task 6)*
- [x] Drizzle setup pointing at SQLite (`drizzle.config.ts`)
- [x] Schema file with all tables from FOLIO-BRIEFING.md §6
- [x] Migration scripts: `db:generate`, `db:migrate`, `db:studio`
- [x] Initial migration generated and applied *(completed in Phase 0.5 Plan A Task 7)*

### Auth

- [x] `lib/auth.ts`: password hashing (`Bun.password`), session token generation
- [x] `lib/crypto.ts`: libsodium secretbox wrappers for AI key storage
- [x] `middleware/session.ts`: reads cookie, attaches user + memberships — *implemented as `middleware/auth.ts` with `attachUser` + `requireUser`. Same concept, different filename.*
- [ ] `middleware/bearer.ts`: reads `Authorization: Bearer`, attaches token + scopes — *Phase 2 work per the Phase 1 spec.*
- [x] `routes/auth.ts`: register, login, logout, me
- [x] Magic-link: request + consume (log link to console in dev; SMTP later)

### Workspaces & projects

- [x] `routes/workspaces.ts`: CRUD, slug uniqueness, owner membership on create *(slug-scoped CRUD landed in Phase 1 backend; GET/POST collection + GET/PATCH/DELETE :wslug)*
- [x] `routes/projects.ts`: CRUD scoped to workspace, slug unique per workspace *(split out of workspaces.ts; slug-scoped via `/w/:wslug/projects/:pslug` in Phase 1 backend)*
- [x] AI key encryption end-to-end: encrypted before insert, never returned — *implemented in `routes/settings.ts` rather than as a PATCH on workspaces.*

### Frontend foundation

- [x] `bun create vite` inside `apps/web` (React + TS)
- [x] Tailwind + shadcn/ui init *(completed in Phase 0.5 Plan A Task 23 — Dialog/Sheet/Popover via radix-ui; Sonner toast; cmdk command)*
- [x] TanStack Router setup with file-based routing
- [x] `lib/api.ts`: typed fetch client — *minimal version; expand with shared Zod schemas in Phase 1.*
- [ ] Routes: `/login`, `/magic`, `/` (workspace picker), `/w/$workspace`, `/w/$workspace/p/$project` — *only `/` and `/login` exist. Workspace + project routes built in Phase 1.*
- [ ] Auth pages: login, signup, magic-link request, magic-link consume — *login + magic request done. Signup is not a separate page; magic consume is a server-side redirect (no client route). Acceptable but document.*
- [ ] Sidebar shell: workspace switcher, project list — *not built; lands in Phase 0.5 (Design System) and Phase 1.*
- [ ] Workspace settings page with AI provider + key configuration (UI only, posts to API) — *API exists; UI deferred to Phase 1 settings work.*

### Build pipeline

- [ ] `scripts/build.ts`: builds web → copies dist to server/public → runs `bun build --compile` — *no `scripts/` directory; `build:binary` script is inline in root `package.json`. Either move to script or accept inline.*
- [ ] Verify single binary runs and serves both API and static React — *script exists but no record of an end-to-end binary run. Verify in Phase 1 smoke E2E.*
- [x] Dockerfile (multi-stage, alpine final) — *at repo root, not under `docker/`. Functionally equivalent.*
- [ ] `docker build -t folio:dev .` succeeds — *Dockerfile written but no record of a successful build. Verify in Phase 1.*
- [ ] `docker run -e FOLIO_MASTER_KEY=... -v ./data:/data -p 3000:3000 folio:dev` works end-to-end — *blocked on the above; verify in Phase 1.*

### Phase 0 acceptance

- [x] Fresh `git clone` → `bun install` → `bun dev` works *(README documents the flow; trusting it)*
- [x] Sign up, log in, log out flows complete *(register/login/logout/me + magic flow all implemented)*
- [ ] Create workspace + project + AI key persists — *API supports it; no UI yet. Lands in Phase 1.*
- [ ] Single binary built and verified — *script exists, not verified end-to-end.*
- [ ] Docker image built and verified — *Dockerfile exists, not verified end-to-end.*
- [ ] Commit: `phase-0: complete` — *not declarable until the unticked boxes above are resolved. Phase 0 is "scaffolded" not "complete" per the README.*

> **Phase 0 honest status:** ~70% done. The backend foundation (auth, schema, AI-key encryption) is real. The frontend UI for workspaces / projects / settings is not built. Migrations need to be generated. The single binary + Docker build are scripted but not verified. The remaining work folds naturally into Phase 0.5 (Design System) and Phase 1 (Core CRUD).

---

## Phase 0.5 — Design System (Half-week)

**Goal:** Implement the visual design system spec'd in `docs/superpowers/specs/2026-05-11-design-system-design.md`. Tokens, primitives, shell components, theme switching, dev catalog. Every subsequent phase consumes this.

**Acceptance criteria (full list in spec §14).** All of these must be true:

- [x] `apps/web/src/styles/tokens.css` exists with all values from spec §5, light + dark.
- [x] `tailwind.config.ts` maps every token to a semantic utility name; no raw hex appears in any feature file.
- [x] Geist + Geist Mono self-hosted in `apps/web/public/fonts/`; `@font-face` declarations in `fonts.css`.
- [x] Hard `<button>` reset shipped (background / border / outline / box-shadow / appearance all zeroed) so no chunky pill buttons appear.
- [x] Bespoke primitives in `components/ui/`: `Button`, `IconButton`, `Pill`, `Badge`, `Chip`, `Avatar`, `Kbd`. Each renders correctly in both themes with working `:focus-visible`.
- [x] shadcn primitives installed and themed via Tailwind tokens: `Dialog`, `Sheet`, `Popover`, `Command`, `Toast`.
- [x] Shell components composed in `components/shell/`: `Shell`, `Rail` (expanded + collapsed), `MainFrame`, `RightPanel`, `WorkspaceSwitcher`.
- [x] Theme bootstrap snippet in `index.html` prevents first-paint flash.
- [x] `localStorage` persistence for theme + rail collapsed/expanded preference.
- [x] Dev-only `/dev/design-system` route renders every primitive and the shell in both themes.
- [x] Login + home pages re-styled to consume the new tokens (sanity check existing scaffold against the system).
- [x] Lighthouse accessibility audit on `/dev/design-system` passes ≥ 95. *(verified 2026-05-11 in browser by Stefan.)*
- [x] Mockups in `.superpowers/brainstorm/` match what the implementation renders. *(verified 2026-05-11 in browser by Stefan.)*
- [x] Commit: `phase-0.5: design system complete`

---

## Phase 1 — Core CRUD (Week 2)

**Goal:** Create, read, update, delete documents (work items + pages). List view with filters and kanban view with drag-drop work. Inline editing functions. Body editor (Milkdown) and raw-MD toggle (CodeMirror) both work.

> **Status (2026-05-12):** Backend shipped 2026-05-11. Server normalization shipped 2026-05-12. Phase 1 frontend (Tasks 5-30 of `docs/superpowers/plans/2026-05-11-phase-1-frontend.md`) shipped under branch `phase-1/frontend`. UX polish (the original "Phase 1.5 UX polish" thread — separate from the Time-aware views thread, now Phase 1.8 below) shipped under branch `phase-1.5/ux-polish` — Lucide icons, skeletons, primary create CTAs, signup tab, dot pills, Search via command-palette bus. 125 frontend tests pass + 1 jsdom-skipped (rich-body initial render). Acceptance is via the 15-scenario manual QA pass in `apps/web/tests/manual-qa-phase-1.md` plus an 11-screenshot visual sign-off against the canonical mockups.

### Documents API

- [x] `routes/documents.ts`: list (with filters), get, create, patch, delete
- [x] Accept both JSON body and `Content-Type: text/markdown` for create/patch
- [x] `lib/md.ts`: parse/serialize markdown ↔ `{ frontmatter, body }` *(lives at `apps/server/src/lib/frontmatter.ts`, uses `yaml` not gray-matter)*
- [x] `lib/slug.ts`: title → slug with per-project dedup *(pure slugify in `packages/shared/src/slug.ts`; dedup in `apps/server/src/lib/slug-unique.ts`)*
- [x] `GET /api/v1/.../documents/:slug.md` returns raw MD with frontmatter
- [x] Validate `status` against project statuses table for work items

### Statuses, fields, views

- [x] `routes/statuses.ts`: CRUD; auto-seed 4 defaults on project create (`Backlog`, `Todo`, `In Progress`, `Done`)
- [x] `routes/fields.ts`: CRUD for type-pinned frontmatter fields
- [x] `lib/field-infer.ts`: inference rules from FOLIO-BRIEFING.md §7 *(in `packages/shared/src/field-infer.ts`)*
- [x] `routes/views.ts`: CRUD; auto-seed two defaults per project (All work items, Board)
- [x] `lib/filter-compile.ts`: ViewConfig → Drizzle where() *(AST in `packages/shared/src/filter-compile.ts`; adapter in `apps/server/src/lib/filter-to-drizzle.ts`)*

### Frontend — list view

- [x] `components/views/list-view.tsx`: virtualized table, configurable columns *(flat row render — virtualization deferred to Phase 7; spec §2 locked decision)*
- [x] Display fields: title, status, plus frontmatter keys from view's `displayFields` *(title + status + updated_at in v1; full per-view column model lands in Phase 1.5)*
- [x] Inline edit: click title → text input; click status → dropdown
- [x] Frontmatter cell editors dispatch to `field-renderer.tsx` based on inferred/pinned type *(field-renderer.tsx lives in the slideover form in v1; lifted into spreadsheet cells in Phase 1.5)*
- [x] Sort by clicking column header
- [x] Filter chips at the top: "Status is...", "Priority is..." (add via "+ Filter" button)

### Frontend — kanban view

- [x] `components/views/kanban-view.tsx`: columns grouped by status
- [x] dnd-kit setup for drag-drop between columns
- [x] Optimistic status update on drop, rollback on failure
- [x] Card shows title + selected frontmatter fields *(priority + due_date chips in v1)*

### Frontend — editor & slideover

- [x] `components/slideover.tsx`: right-side panel, animates, URL-driven open state *(at `components/slideover/document-slideover.tsx`, URL via `?doc=<slug>`)*
- [x] Clicking a work item in any view opens the slideover for that document
- [x] Frontmatter fields render as labeled inputs above the body editor
- [x] Milkdown body editor with markdown plugins (gfm, math optional) *(commonmark + gfm + history + listener + clipboard; math deferred)*
- [x] CodeMirror "raw MD" toggle: switches the whole document to raw mode *(rich ↔ raw toggle; frontmatter form stays visible across modes per spec §5.6)*
- [x] Round-trip: edit in raw → switch to form → all fields preserved correctly *(component-level test in `apps/web/src/components/slideover/__roundtrip__/round-trip.test.tsx`; manual QA scenario #8 is the byte-level gate)*

### Pages (wiki)

- [x] Pages live under a "Wiki" tab in the project nav
- [x] Tree view by `parent_id` *(plus drag-to-reparent with cycle guard)*
- [x] Same editor as work items (Milkdown + raw toggle)
- [x] Pages don't have status; their UI hides the status field

### Phase 1 acceptance

- [x] Create / edit / delete work items via UI works
- [x] Create / edit / delete pages via UI works
- [x] List view with filters + sort works
- [x] Kanban view with drag-drop works
- [x] Raw MD toggle preserves all data
- [x] All edits round-trip via raw MD export
- [x] Commit: `phase-1: complete`

---

## Phase 1.5 — Tables + Spreadsheet UI (Week 3) — SHIPPED 2026-05-24

**Goal:** Promote tables from "implicit single bucket per project" to a first-class concept. Replace the 3-column list with a real columnar spreadsheet — per-table fields render as columns, every cell is the right editor for its field type, columns are reorder/show/hide-able and their state persists per view. Foundation for Phase 1.6 (saved-views nesting) and Phase 1.7 (CRM polish).

> **Status (2026-05-24):** Shipped on `phase-1.5/ux-polish` branch. 21 subagent-driven tasks across two sub-phases (originally branded "Phase 2A / 2B" before the 2026-05-24 reorg that put Agents back at Phase 2 and renamed this slot to 1.5). Plans:
> - `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md` (now Phase 1.5a)
> - `docs/superpowers/plans/2026-05-24-phase-2b-spreadsheet-table-ui.md` (now Phase 1.5b)
>
> Server: 81 → 112 tests. Web: 134 → 154 tests. Both suites green.

### Tables foundation (Phase 1.5a)

- [x] New `tables` table: every project owns ≥1 table; auto-created `work-items` default per project
- [x] `tableId` FKs on `statuses`, `fields`, `views`, `documents` (nullable on documents — pages have null)
- [x] Migration `0003_phase_2a_tables.sql` backfills existing data via SQLite table-rebuild idiom
- [x] `resolveTable` middleware reads `:tslug` from URL; `resolveProject` auto-attaches the default `work-items` table when no `:tslug` is present (backward-compat for legacy `/p/:pslug/...` routes)
- [x] New mounts: `/api/v1/w/:ws/p/:p/t/:tslug/{documents,statuses,fields,views}`
- [x] `tables` CRUD route at `/api/v1/w/:ws/p/:p/tables` — slug immutable after create

### Spreadsheet table UI (Phase 1.5b)

- [x] New `currency` field type — schema enum + SQL CHECK constraint + ISO-4217 code in `options[0]`
- [x] `views.columnOrder` JSON column (`string[] | null`) — per-view column ordering
- [x] Pure column helpers: `mergeColumns(fields, view)`, `applyColumnOrder(cols, order)`, `effectiveVisibleKeys(cols, view)`
- [x] Built-in columns (title, status, updated_at) + one column per pinned `fields` row
- [x] `TableView` replaces `ListView` on the work-items route
- [x] `TableHeader` with sort (built-ins only) + column-visibility picker + drag-reorder via `@dnd-kit/sortable`
- [x] `TableRow` matches header grid via shared per-column-type fixed widths (Title 280, Status 140, currency/number 120, date 140, etc.)
- [x] Horizontal scroll with sticky first column when columns overflow viewport
- [x] Subtle scrollbar styling (`.folio-scroll` utility) on both vertical (MainFrame) and horizontal (table) scrollers
- [x] Currency cell renderer via `Intl.NumberFormat` — right-aligned, formatter cached per ISO code
- [x] Click-to-edit date cells (no permanent dark border)
- [x] Multi-select "add" affordance is a `+` icon popover, not a bordered native `<select>`
- [x] Slug regenerates from new title when slug looks auto-derived from old title (`untitled` → `fix-login-bug`)
- [x] Demo seed registers 4 standard fields per project (priority/assignee/labels/due_date) + widens the default view's `visibleFields`
- [x] Commit: `phase-1.5: complete` *(tip is `4a7942d` + subsequent polish commits; the explicit "complete" marker hasn't been written, but the phase's acceptance is met)*

### Phase 1.5 acceptance

- [x] Documents create / edit / delete still work end-to-end (no Phase 1 regression)
- [x] Tables can be created beyond the default `work-items` per project
- [x] Per-table fields render as spreadsheet columns; currency/date/select/multi-select all editable inline
- [x] Column visibility + order persist to the active view via PATCH
- [x] Manual-qa Playwright e2e: 13 / 13 green; click-through: 11 / 11 green
- [x] Server suite: 112 / 112; web suite: 154 / 154

---

## Phase 1.6 — Saved views in rail (Week 3, second half) — SHIPPED 2026-05-24

**Goal:** Saved views surface as nested children under their table in the left rail (Linear / NocoDB style). Clicking a view navigates to `/w/.../work-items?view=<id>` and applies the view's filter + visibleFields + columnOrder. A `+` action saves the current filter / column state as a new view.

> **Status (2026-05-24):** Shipped on `phase-1.6/saved-views`. Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. Final pass dropped the explicit Save Filters action in favor of full auto-save: filter changes PATCH the active view immediately, matching the existing sort/columnOrder/visibleFields behavior. Suite: 113 server (+1), 169 web (+15 net), 28 shared. Playwright spec descoped — manual QA gates the merge.

### Rail

- [x] Rail shows `Project → ⚏ Work Items → views[]` with expandable tree (per-item localStorage expand state under `folio:rail-expanded:<id>`)
- [x] Each row carries an icon: folder for projects, table for tables, list for views (kanban filtered out per Phase 6 deferral)
- [x] `+` button under each table opens "New view" sheet (name only — current URL state always captured)
- [x] Click view → navigate to `/w/.../work-items?view=<id>` (preserves any open `doc=` param)

### TableView wiring

- [x] `TableView` reads `?view=` from URL, resolves via `useViews` *(no per-view hook needed — list query + find by id)*
- [x] Active view's `filters` translate into the URL filter params on first navigation — ref-guarded hydration effect, fires once per view id
- [x] **Filter changes auto-save to active view** (no explicit Save button — same behavior as sort/columnOrder/visibleFields)
- [x] Default view is auto-selected when no `?view=` is in URL — preserves Phase 1.5 behavior

### Phase 1.6 acceptance

- [x] Three views can coexist on one table; switching between them updates the spreadsheet without page reload
- [x] Creating a view captures the current URL filters + sort accurately
- [x] Editing a view's filter via inline chip changes round-trips through the URL params correctly (auto-saves to view)
- [x] Existing single-view tests still green
- [x] Commit: `phase-1.6: complete`

---

## Phase 1.6.1 — Rail completeness (Half-day polish) — SHIPPED 2026-05-24

**Goal:** Close the dead-end UX gaps Stefan hit on the post-1.6 walkthrough.

> **Status:** Absorbed into `phase-1.6/saved-views` branch. Hover-reveal `+`/`⋯` pattern (NocoDB-style) on every rail row, double-click rename, confirm dialog for deletes. `+ New project` lives in the workspace switcher popover footer. No new tests added — manual QA gates this. Today: workspace creation works everywhere, but **creating a project from inside a workspace requires going back to the project picker**; tables can't be **renamed / created / deleted** from the UI at all (every project's table is just stuck called "Work Items"); views can't be **renamed / deleted** either. Backend supports all of these — only UI is missing. Also: surface Wiki + multi-table structure in the rail so the table layer earns its keep.

Target UX:

```
▾ Netdust
  ▾ 📁 Folio
      ▾ ⚏ Tasks                ← table, renameable
          • All tasks
          • In progress         ← view, renameable
          + New view
      ▸ ⚏ Bugs                  ← additional tables, when created
      📖 Wiki
      + New table
  ▸ 📁 Client website
  + New project                  ← from rail, not only from picker page
```

### Project creation from the rail

- [ ] `+ New project` action lives in the rail at the workspace level (trailing slot on the workspace row, or as a sibling row below all projects). Opens the existing `<ProjectCreate>` sheet — same flow as `/w/:wslug/` index. No new backend.
- [ ] After create, the rail refreshes and the new project's row is visible. Optional: auto-navigate into the new project.

### Tables: create / rename / delete

- [ ] `+ New table` trailing on each project row opens a "New table" sheet (name input; slug auto-derived from name, editable before submit; optional icon). Uses existing `POST /api/v1/w/:wslug/p/:pslug/tables`.
- [ ] Right-click (or `⋯` button on hover) on a table row → context menu with `Rename` / `Delete`. Rename opens an inline edit (or a small sheet) that PATCHes `name` only (slug is immutable per Phase 1.5a — confirm via a note in the rename UI: "URL slug stays the same").
- [ ] Delete shows a confirm dialog with the count of documents that will be cascaded. Calls `DELETE /api/v1/w/:wslug/p/:pslug/tables/:tslug` — verify the cascade behavior on documents + views before shipping.
- [ ] Cannot delete a project's last table (server should enforce or UI should disable).

### Views: rename / delete

- [ ] Right-click (or `⋯` on hover) on a view row → `Rename` / `Delete`.
- [ ] Rename: inline edit or small sheet, PATCH `name`.
- [ ] Delete: confirm dialog; if it's the default view, server should auto-promote another (verify) or UI should block.
- [ ] Cannot delete the last view of a table (server or UI).

### Wiki in the rail

- [ ] Wiki renders as a leaf NavItem under each project (FileText icon). Clicking navigates to `/w/:wslug/p/:pslug/wiki`. No nesting underneath — wiki has its own internal tree, not exposed in the rail.

### Backend

- No new endpoints. Tables CRUD shipped in Phase 1.5a; Views CRUD shipped in Phase 1. Verify each PATCH/DELETE path is wired before building the UI; add a regression test if anything is shaky.

### Phase 1.6.1 acceptance

- [x] Create a project from inside another project — `+ New project` lives in the workspace switcher popover footer.
- [x] Rename the default table from "Work Items" to "Tasks" — double-click table row label.
- [x] Create a second table "Bugs" — `+` button on project row's hover affordances opens TableCreate sheet.
- [x] Delete a non-default view — `⋯ → Delete` on view row, confirm dialog.
- [x] Rename a view via the rail — double-click view row label.
- [x] Wiki appears as a sibling row to tables under each project.
- [x] Commit: `phase-1.6.1: absorbed into phase-1.6`

---

## Phase 1.7 — Lightweight CRM polish (Half-week) — SHIPPED 2026-05-24

**Goal:** Folio becomes usable as a follow-up CRM without adding automation. Three frontmatter fields are surfaced as first-class spreadsheet + slideover affordances; an activity log panel renders inside the slideover from the existing `events` table; playbook pages can be linked from a stage. Use case: agency follow-up workflow — "where are we / what's next / when's it due / what's the playbook for this stage."

> **Status (2026-05-24):** Shipped on `phase-1.7/crm-polish` branch. 3 of 4 sections shipped (Playbook linking deferred). Suite: 113 → 116 server, 169 → 173 web. Awaiting manual QA + merge.

### First-class follow-up fields

- [x] `next_action_due: date` — color-coded by urgency via `dueUrgency` helper: overdue/today=red, this week=amber, beyond=neutral
- [x] No new field types — conventional keys with built-in UI affordances. `next_action` + `next_action_owner` use existing string/user_ref renderers.

### `last_touched_at` distinct from `updated_at`

- [x] New `documents.last_touched_at` column (nullable, timestamp_ms) — migration 0005
- [x] Bumped only by the explicit "Log activity" action via POST `/documents/:slug/activity`
- [x] `updated_at` continues to fire on every edit
- [x] Filterable in the URL via `?stale_for=Nd` — server-side WHERE on `last_touched_at`

### Activity log panel

- [x] Slideover gets a collapsible "Activity" section below the body editor
- [x] Renders rows from `events` table filtered to `documentId = current.id`, newest first via GET `/documents/:slug/events`
- [x] Each row shows kind label + relative time; click row to expand JSON payload
- [x] "Log activity" button in slideover header opens a popover with note textarea (⌘↵ to log); emits `activity.logged` event + bumps `last_touched_at`

### Playbook linking — DEFERRED

Deferred. Convention is solid but use isn't proven yet; ship after Phase 1.8 dashboard if real follow-up workflow surfaces the need.

### Phase 1.7 acceptance

- [x] `next_action_due` color-codes by urgency (overdue / soon / later)
- [x] Logging an activity bumps `last_touched_at` AND appends an `activity.logged` event row
- [x] `?stale_for=14d` filters documents whose `last_touched_at` is null or older than 14 days
- [x] Commit: `phase-1.7: complete`

---

## Phase 1.8 — Time-aware views (Half-week)

**Goal:** Folio becomes a tool you check on Monday morning. Add a timeline view as a third view type and a "This Week" dashboard surface. Read-only against existing data — no new tables.

> Originally drafted as "Phase 1.5 — Time-aware views"; renamed to 1.8 in the 2026-05-24 reorg so the timeline work doesn't collide with the (separately-shipped) UX-polish + spreadsheet work that ended up at 1.5.

### Timeline view

- [ ] Extend `views.type` to accept `'timeline'` alongside `'list'` and `'kanban'`
- [ ] `components/views/timeline-view.tsx`: horizontal lanes, configurable day/week/month zoom
- [ ] Items render from `frontmatter.due_date` (primary) or `frontmatter.start_date`/`end_date` range when both present
- [ ] Items without a date appear in a collapsible "Unscheduled" tray below the timeline (drag-to-schedule sets `due_date`)
- [ ] Drag an item horizontally → optimistic `PATCH frontmatter.due_date`; rollback on failure
- [ ] Group lanes by status (default), assignee, or any frontmatter key — same `groupBy` mechanism as kanban
- [ ] Auto-seed a third default view per project: **Schedule** — `type: timeline`, filter `type = work_item`, `groupBy: status`

### This Week dashboard

- [ ] New route: `/w/$workspace/this-week` — workspace-scoped, aggregates across all projects in the workspace
- [ ] Server endpoint: `GET /api/v1/w/:wslug/this-week` returns three buckets — `due_this_week` (due_date within next 7 days), `overdue` (due_date in past, status not done/cancelled), `stale` (no `last_touched_at` update in 14+ days, status not done/cancelled — uses the Phase 1.7 column)
- [ ] Renders as three stacked sections; each row links to the document slideover
- [ ] Items show their project icon + name so cross-project context is visible
- [ ] Empty state per bucket — "Nothing due this week" is a feature, not a void

### Phase 1.8 acceptance

- [ ] Timeline view renders work items by `due_date` and lets you drag-reschedule
- [ ] Items without dates land in the Unscheduled tray and can be dragged onto the timeline
- [ ] `/w/$workspace/this-week` shows due, overdue, and stale buckets across all projects
- [ ] Default `Schedule` view is auto-created with each new project
- [ ] Commit: `phase-1.8: complete`

---

## Phase 1.9 — Field management UI (Half-week)

**Goal:** Close the last missing surface in the spreadsheet feature: managing columns inline. Today, pinned fields can only be created via the API or the demo seed; renaming, type changes, reordering, and deletion all require API calls. Phase 1.9 makes the table itself the management surface — `⋯` on a column header, `+ Add column` at the end, and a "Suggested columns" section in the column picker that surfaces unpinned frontmatter keys found in existing docs.

This must land BEFORE Phase 2 (Agents). Agents will write new frontmatter keys; users need a frictionless way to promote those keys to columns without editing JSON.

### Why the priority

- The `fields` table + REST endpoints (GET/POST/PATCH/DELETE on `/api/v1/w/:ws/p/:p/t/:t/fields`) shipped in Phase 1.5. The UI surface didn't.
- Spreadsheet feels complete to a user only when they can shape it. Today, hidden/visible + reorder works (per-view); add/rename/type-change/delete does not.
- Agents are about to start creating frontmatter keys (Phase 2-3). Without a column-pin surface, users will see `frontmatter.foo_bar = "value"` in the raw editor and have no way to make it a first-class column.

### `useFields` rescoped to the active table

- [ ] `useFields(wslug, pslug, tslug)` — current hook hits `/p/:pslug/fields` (project-scoped, returns all fields across all tables); switch to `/p/:pslug/t/:tslug/fields` so the field set is the active table's only
- [ ] Audit existing callers: `TableView`, `DocumentSlideover`, `FrontmatterForm`, anywhere else that reads `useFields` — pass the active `tslug` from the route
- [ ] Server route already exists at the table-scoped path (Phase 1.5a); just point the hook at it
- [ ] Update test fixtures + Vitest mocks for the new query key shape

### `+ Add column` at the end of the table header row

- [ ] New `TableAddColumn` component renders after the last header cell (mirrors `TableAddRow`'s placement at the bottom of the data rows)
- [ ] Trigger: `+` icon button at right end of header row. Click opens an inline popover anchored to the button
- [ ] Popover form: `Key` (lowercase + underscore validation matching `^[a-z][a-z0-9_]*$`), `Label` (display name, defaults to titleized key), `Type` (dropdown of `FIELD_TYPES`)
- [ ] Conditional options field: select/multi_select shows comma-separated options input; currency shows a single ISO-4217 code input with a default of `EUR`
- [ ] On commit: `POST /fields` → on success, refetch fields + auto-add the new key to the active view's `visibleFields`
- [ ] Form validation matches server's `validateOptions` so users see errors before the request fires
- [ ] Cancel: Escape or click-outside closes without persisting

### Column header `⋯` menu

- [ ] Each non-builtin column header gets a hover-revealed `⋯` button (same affordance pattern as rail rows: opacity-0 → group-hover/header:opacity-100)
- [ ] Menu items:
  - **Rename** → inline edit on the label (reuse `InlineEdit`)
  - **Change type** → opens the same form used by `+ Add column`, pre-filled; PATCH on commit. Disabled (with tooltip) if the type change is destructive (e.g. `select` → `number` when docs have non-numeric values); see Type migration below
  - **Hide column** → removes from active view's `visibleFields` (already works via column picker; this is a shortcut)
  - **Delete column** → confirm dialog (reuse `ui/dialog.tsx` pattern from slideover delete) listing how many docs have a non-null value for this key; on confirm DELETE + toast
- [ ] Built-in columns (`title`, `status`, `updated_at`) get NO `⋯` menu — they're not in the `fields` table

### "Suggested columns" in the column picker

- [ ] ColumnPicker scans `documents.frontmatter` for keys not in `fields`. Builds the suggestion list from `useDocuments(...)`'s `data.data[].frontmatter` Object.keys (dedupe).
- [ ] Renders below the existing visible/hidden checkbox list under a `SUGGESTED FROM YOUR DATA` divider
- [ ] Each suggestion shows: `key` · sample value preview (first non-null) · inferred type (use existing `inferType` helper from FrontmatterForm)
- [ ] `+ Pin` button on each row → opens the same add-column form pre-filled with key + inferred type, user confirms or edits, POST creates the field row and the suggestion disappears

### Type migration (the hairy part)

- [ ] PATCH `type` is allowed for COMPATIBLE changes only. Define compatibility matrix server-side: `string ↔ text`, `string → url`, `number → currency` (with default `EUR`), anything → `text` (always safe). Cross-family changes (`number → select`, `boolean → date`) return 422 with a clear message.
- [ ] No automatic value coercion — incompatible values stay as-is in frontmatter; the UI just renders the new type's input. Edge: a `select` field with options `[low, medium, high]` keeps "high" in storage even after switching to a select with options `[red, green, blue]`. UI surfaces this as a warning ("3 documents have values not in the new options") with a "Migrate values" link → table-row preview where the user clears or remaps each.
- [ ] For incompatible changes the UI offers: "Delete column and recreate" with explicit confirmation, or "Keep as-is and create a new column with the new type".

### Phase 1.9 acceptance

- [x] `+ Add column` at end of header row creates a field, adds it to the visible set, and the new column renders with the right cell editor type immediately
- [x] Column header `⋯` menu rename, hide, and delete all work; delete confirms with doc count (rename uses `InlineEdit`, not `window.prompt`)
- [x] ColumnPicker shows "Suggested columns" for any frontmatter key in existing docs that isn't a pinned field; clicking `+ Pin` creates and reveals the column
- [x] `useFields` now table-scoped — switching tables shows only that table's pinned fields
- [ ] Type change to a compatible type works without warnings; incompatible change shows the migration warning UI — **deferred to Phase 1.9.1**
- [x] Web unit suite covers: `useFields` mutations, `TableAddColumn` form validation + submit, `⋯` menu rename + delete confirm, ColumnPicker suggestion list, `columnSuggestions` helper
- [ ] Playwright covers: full add-column → see new cell in row → rename column → delete column flow — **deferred; manual smoke is the acceptance gate for this branch**
- [x] Commit: `phase-1.9: complete`

### Phase 1.9.1 — shipped 2026-05-25

- [x] Compatible-only type-change in `⋯` menu (`string ↔ text`, `number ↔ currency`, `* → text`). Incompatible changes return 422 `INVALID_TYPE_CHANGE` with a clear allowed-transitions message.
- [x] `useUpdateView` envelope-unwrap fix (parity with Task 3's `useUpdateField` fix from Phase 1.9).
- [ ] Value-remap migration UI for incompatible type changes — **deferred further; "Delete column and recreate" is the v1 path.**
- [ ] Optional Playwright e2e journey for the full add → rename → type-change → delete flow — **deferred to Phase 7.**
- [x] Commit: `phase-1.9.1: complete`

---

## Phase 2 — Agents (Week 4)

**Goal:** Folio is usable by AI agents. REST + MCP both work. Tokens have scoped permissions and authenticate every existing route. Every write emits an event over SSE. Documentation lets a new agent integrate in 15 minutes.

> **This is the spine of v1.** The agent-first wedge is what makes Folio defensible. The phases around this one (1.5–1.8, 4–5) all build the surfaces that agents read and write through. Phase 2 turns Folio from "nice markdown PM tool" into "the agent-friendly back-office layer."

> **Plan-vs-reality reconciliation (2026-05-25):** several of the pieces this spec originally listed as "to build" are already shipped (token CRUD, events table + emitter, aiKeys, all-route event emission). The bullets below reflect what's actually missing. Runner-side items (token budget enforcement, `## Approved` gate, `requires_approval` two-phase loop) moved to Phase 3 where the runner lives. Decisions locked: opaque token format (no `prefix` column), resource:action scopes (`documents:read`, `documents:write`, etc.), hand-rolled Hono MCP routes (no `@modelcontextprotocol/sdk` dep, single-binary intact).

### Already shipped — verify, don't rebuild

- [x] `routes/tokens.ts` — create / list / revoke. Workspace-scoped. Plaintext token returned once on create; only the row metadata (id, name, scopes, createdBy, createdAt, lastUsedAt) is returned on list.
- [x] `apiTokens` schema with `tokenHash` (SHA-256) and `scopes JSON` columns.
- [x] `aiKeys` schema (libsodium-encrypted BYOK store) + `routes/settings.ts`.
- [x] `events` table + `lib/events.ts` `emitEvent(tx, args)`. All write routes (documents, fields, views, tables, projects, workspaces) call it.
- [x] `EventKind` union covers all document/status/field/view/table/project/workspace + `activity.logged`.

### Bearer-auth middleware + scope enforcement

- [ ] `middleware/bearer.ts`: reads `Authorization: Bearer <token>`, hashes, looks up in `apiTokens`, attaches `{ token, workspace, scopes }` to context. Bumps `apiTokens.lastUsedAt` (best-effort, no transaction).
- [ ] Composable `attachToken` (best-effort) + `requireToken` (throws 401 if absent).
- [ ] `requireScope('documents:read' | ...)` factory that throws 403 if the token's scopes don't include the required one.
- [ ] **Compose with session auth:** every existing scoped route (`/api/v1/w/:wslug/...`) should accept EITHER a session cookie OR a bearer token. Implement as `attachUser` OR `attachToken` → `requireUserOrToken` middleware. Tokens grant workspace scope by virtue of the row's `workspaceId`; user routes check membership as today.
- [ ] Scopes use `resource:action` shape per FOLIO-BRIEFING.md §8 and the existing `documents:read|write` defaults. Initial v1 vocabulary: `documents:read`, `documents:write`, `documents:delete`, `fields:write`, `views:write`, `tables:write`, `tokens:admin`. Read scopes implied by their write counterparts is OPT-IN — write doesn't grant read.
- [ ] Apply scope checks to `documents.ts`, `fields.ts`, `views.ts`, `tables.ts`, `statuses.ts`. Session-auth requests bypass scope checks (membership is the gate there).
- [ ] Server tests: token-authenticated GET / POST / PATCH / DELETE on documents; 401 without token; 403 with wrong scope; 403 with revoked token.

### Token UI

- [ ] Workspace settings → "API tokens" tab — create with name + scope checkboxes; "Show plaintext token" modal on create (one-time copy with warning + a "Copy" button); list of existing tokens with `lastUsedAt` + revoke.
- [ ] Inline-edit token name (rename only — scopes are immutable; to change scopes, revoke and recreate).

### Events & SSE

- [x] In-memory pub/sub — **NOT YET SHIPPED.** `lib/events.ts` only writes to the `events` table today. Need: lightweight in-process emitter that `emitEvent` also publishes to.
- [ ] `lib/event-bus.ts`: `subscribe(workspaceId, filter, handler) → unsubscribe`. In-memory only; one process. Filter shape mirrors view filters (`{ kind: 'document.updated', projectId?: string }`).
- [ ] `emitEvent` updated to call `eventBus.publish` after the row insert (inside the same transaction commit).
- [ ] `routes/events.ts`: SSE endpoint `GET /api/v1/w/:wslug/events?kinds=...&project=...`. Workspace-scoped. Bearer or session auth.
- [ ] Heartbeat every 30s (`: ping\n\n`).
- [ ] **Last-Event-Id replay:** the SSE handler reads `Last-Event-Id` header. If present, query `events` table for rows with `id > lastEventId` AND `workspaceId = current` ordered by `createdAt`, emit each as a buffered event before subscribing to the live bus. Requires no schema change — `events.id` is `nanoid` (lexically sortable per-create but NOT per workspace); v1 acceptable since `createdAt` is the real ordering and Last-Event-Id is best-effort. If reliability matters more later, add a monotonic `seq` column.
- [ ] Server tests: open SSE, write a document, see event arrive; heartbeat fires.

### Documents type widening

- [ ] Migration `0006_agents_and_triggers.sql` widens `documents.type` enum from `('work_item', 'page')` to `('work_item', 'page', 'agent', 'trigger')`. SQLite enum is enforced via CHECK constraint → rebuild table per the existing migration idiom.
- [ ] Drizzle schema reflects the wider enum.
- [ ] Existing documents.ts validation Zod schemas accept the new types but reject `tableId` on agent/trigger (they belong to the project, not a table).
- [ ] Server tests: create agent, create trigger, reject `tableId` set on either.

### Agents-as-documents (surface only)

- [ ] Agent frontmatter Zod schema (validated on POST/PATCH when `type: 'agent'`):
  - `system_prompt: string` (also lives in body if author prefers — body wins on conflict)
  - `model: string` (e.g. `claude-sonnet-4-6`)
  - `provider: 'anthropic'|'openai'|'openrouter'|'ollama'`
  - `tools: string[]` (MCP tool names; must be subset of the v1 MCP tool set listed below)
  - `max_delegation_depth: number` (default `2`, hard cap `5`)
  - `max_tokens_per_run: number` (default `10000`, hard cap `100000`) — **stored but not enforced in Phase 2** (runner uses it in Phase 3)
  - `requires_approval: boolean` (default `false`) — **stored but not enforced in Phase 2** (runner uses it in Phase 3)
  - `api_token_id: string` (server-managed; rejected if set by the client on create)
  - `parent_agent: string | null` (slug of the agent that spawned this one; server-managed when a child is auto-created by an agent)
- [ ] On agent create: auto-mint an `apiTokens` row scoped to the agent's `tools` translated to resource:action scopes (e.g. `tools: ['create_document', 'update_document']` → `scopes: ['documents:write', 'documents:read']`). Store `api_token_id` in frontmatter. Plaintext token returned ONCE in the create response, then never again.
- [ ] On agent delete: revoke (DELETE) the linked `apiTokens` row in the same transaction.
- [ ] Assignment convention: `frontmatter.assignee` of the form `agent:<slug>` means "this work item is assigned to an agent in the same project."
- [ ] New event kinds: `agent.task.assigned`, `agent.created`, `agent.deleted`. Emitted from `documents.ts` when `type === 'agent'` or when a work item's `assignee` transitions to an `agent:*` value (covers create-with-assignee and update-to-assignee).
- [ ] Delegation guard: when a request is bearer-authenticated AND the token belongs to an agent (lookup via `apiTokens.id` → agent document via `frontmatter.api_token_id` index) AND the request creates a work item with `assignee: agent:<other>`, server walks the `parent_agent` chain (max 10 hops) to detect cycles + count depth. Reject if depth > parent's `max_delegation_depth` with 403 `DELEGATION_DEPTH_EXCEEDED`.
- [ ] UI: rail shows "Agents" as a leaf row under each project (alongside Wiki). Clicking navigates to a default agents view.
- [ ] UI: agent slideover renders `system_prompt` in the body editor (same Milkdown surface — editing the agent = writing markdown). Frontmatter form above shows model + provider + tools (multi-select) + delegation depth + token budget + requires-approval toggle.
- [ ] UI: assignee inline edit on work items shows two sections — humans (memberships) and agents (`type: 'agent'` documents in the same project). Persists as plain string (`agent:<slug>` or user email).

### Triggers-as-documents (surface only — scheduler in Phase 3)

- [ ] Trigger frontmatter Zod schema (validated on POST/PATCH when `type: 'trigger'`):
  - `agent: string` (slug of the agent this trigger invokes; must exist in the same project)
  - `schedule: string | null` (cron expression; null if event-only)
  - `on_event: string | null` (event kind; null if schedule-only)
  - `event_filter: object | null` (filter against the event payload — **reuse `packages/shared/src/filter-compile.ts`** dialect; only consulted when `on_event` is set)
  - `payload: object | null` (free-form JSON passed to the agent at fire time)
  - `enabled: boolean` (default `true`)
  - `last_fired_at: string | null` (server-managed; rejected if set by the client)
  - `last_status: 'ok' | 'failed' | null` (server-managed)
- [ ] At least one of `schedule` or `on_event` must be set — Zod rejects triggers with both null.
- [ ] Cron validation: lightweight 5-field parser (`* * * * *`). Hand-rolled — verify the expression has 5 space-separated fields each matching `/^[0-9*,\-\/]+$/`. Full evaluation lives in Phase 3 with the scheduler.
- [ ] Event-kind whitelist: validate `on_event` against the current `EventKind` union at server boundary. Unknown kinds rejected with 422 `UNKNOWN_EVENT_KIND`.
- [ ] Trigger CRUD reuses the existing documents endpoints — no new routes.
- [ ] UI: rail shows "Triggers" as a leaf under each project (alongside Wiki + Agents). Default view shows columns: `agent`, `schedule`, `on_event`, `last_fired_at`, `last_status`.
- [ ] UI: trigger slideover renders frontmatter as a structured form (cron input with a "validate" affordance, event-kind `<select>` populated from the known-kinds list, JSON payload editor) above the body. Body is a free-form description.
- [ ] Exported MD includes triggers under `projects/<pslug>/trigger/<slug>.md` — round-trip preserved.

### MCP server (hand-rolled, /mcp)

Hand-rolled Hono sub-app at `/mcp`. Speaks JSON-RPC 2.0 over HTTP POST. Bearer-authenticated like REST. Single-binary commitment intact — no `@modelcontextprotocol/sdk` dependency.

- [ ] `routes/mcp.ts`: handles `initialize`, `tools/list`, `tools/call`, `ping` JSON-RPC methods.
- [ ] Tool set mirrors FOLIO-BRIEFING.md §9 v1. Each tool is a thin wrapper that delegates to the same service code the REST handlers use (extract service functions if needed — don't duplicate logic):
  - `list_workspaces` / `list_projects` / `list_documents` / `get_document` / `get_document_markdown`
  - `create_document` / `update_document` / `delete_document`
  - `list_statuses` / `list_fields` / `list_views`
  - `run_view` (returns documents filtered + sorted per the view)
  - **Defer to v1.1:** `search_documents` (no sqlite-fts5 yet)
- [ ] Tool output is JSON with a `markdown` field where applicable (e.g. `get_document` returns parsed frontmatter + body + a `markdown` round-trip string per briefing §9).
- [ ] Tool gating by token scopes: a token with only `documents:read` cannot call `create_document` (return JSON-RPC error `-32601` or `-32603` with the missing scope in `data`).
- [ ] **Deferred to Phase 2.1:** `get_folio_workflow` tool. The Backlog.md-style guidance-as-tool is a polish item; agents can read `docs/AGENTS.md` directly in v1.

### Documentation

- [ ] `docs/API.md`: REST reference, hand-written, covers all current routes + bearer auth + scopes.
- [ ] `docs/MCP.md`: tool reference with example JSON-RPC requests + responses.
- [ ] `docs/AGENTS.md`: agent-document model — schema, auto-token lifecycle, assignee convention, delegation rules, the `agent.task.assigned` event contract (runner ships in Phase 3).
- [ ] `docs/TRIGGERS.md`: trigger-document model — schema, cron + event-pattern semantics, payload contract (scheduler ships in Phase 3).
- [ ] Update root `README.md` with the agent integration story (5-minute curl walkthrough + MCP example).

### Phase 2 acceptance

- [ ] Create token via UI, use it to `curl -H "Authorization: Bearer ..." POST /api/v1/.../documents` → success.
- [ ] Same `curl` without the scope returns 403 with a clear message.
- [ ] Revoking a token immediately blocks subsequent requests (401).
- [ ] Connect via the MCP endpoint with a JSON-RPC client, list workspaces, create a document.
- [ ] Open SSE stream, edit a document in the UI, see the event arrive within 1s.
- [ ] Open SSE stream with `Last-Event-Id` header, get buffered events from the table before live ones start streaming.
- [ ] Create an agent document via UI; its API token is auto-minted and visible in the workspace tokens list with the right scopes; the agent appears in the work-item assignee picker.
- [ ] Assigning a work item to `agent:<slug>` emits exactly one `agent.task.assigned` event on the SSE stream.
- [ ] Deleting an agent revokes its token immediately (subsequent requests with that token return 401).
- [ ] Create a trigger document with a cron schedule pointing at an existing agent; trigger persists and round-trips as MD (scheduler fires in Phase 3).
- [ ] Create a trigger with `on_event` + `event_filter`; validation accepts known event kinds and rejects unknown ones with 422.
- [ ] Trigger Zod rejects a trigger with both `schedule: null` AND `on_event: null` with 422.
- [ ] All existing user-flow tests still pass (no session-auth regression from adding bearer middleware).
- [ ] Commit: `phase-2: complete`

---

## Phase 3 — AI in UI + Agent runner (Week 5)

**Goal:** Slash commands work in the body editor. AI settings UI lets the user configure a provider and validate the key. Streaming responses feel snappy. The Phase 2 agent-document surface gains a runner that actually executes assigned tasks.

> **This is the second spine phase.** Phase 2 builds the surface; Phase 3 makes the surface come to life. Together they are the agent-platform half of Folio's v1.

### Provider abstraction

- [ ] `lib/ai/provider.ts`: `AIProvider` interface, factory
- [ ] `lib/ai/anthropic.ts`, `openai.ts`, `openrouter.ts`, `ollama.ts`
- [ ] All providers support streaming (return an `AsyncIterable<string>`)
- [ ] `routes/ai.ts`: `POST /api/v1/w/:wslug/ai/complete` reads workspace key, dispatches to provider
- [ ] `POST /api/v1/w/:wslug/ai/test-key` validates a key with a cheap call without storing

### UI

- [ ] AI settings panel in workspace settings: provider select, model select, key input, "Test" button
- [ ] On save: encrypt key, store, never return; show `keyConfigured: true` flag
- [ ] When no key is configured: slash commands show disabled state with "Configure AI" link

### Slash commands

- [ ] `/draft` — uses title as prompt, streams body into editor
- [ ] `/decompose` — sends current body, returns list of subtask titles; accept → creates child documents with `parent_id`
- [ ] `/summarize` — one-paragraph summary, inserted at top or copied to clipboard
- [ ] `/link <query>` — fuzzy search documents by title, inserts `[[slug]]` on select
- [ ] `/ai <prompt>` — open-ended completion with current body as context

### Agent runner

Consumes the Phase 2 surface (`type: 'agent'` documents, auto-minted tokens, `agent.task.assigned` events) and the provider abstraction above. Runs in-process — no sidecar.

- [ ] `lib/agent-runner.ts`: subscribes to `agent.task.assigned` via the SSE pub/sub
- [ ] On event: load the agent document, build the system prompt from frontmatter + body, call the workspace AI with the agent's allowed MCP tools as function calls
- [ ] Tool gating: runner exposes only the subset of MCP tools listed in the agent document's `tools` frontmatter — not the full v1 tool set (per-agent surface, not per-token)
- [ ] Tool calls dispatch back into Folio via the agent's own API token (same auth path as an external agent — no privileged shortcut)
- [ ] Result-reporting convention: runner patches the work item body under named sections — `## Plan` (intent), `## Notes` (append-only progress), `## Result` (final summary), `## Error` (failure reason). Writing `## Error` flips `status` to `failed`. No comments table, no updates table — the body is the ledger.
- [ ] Token budget enforcement: runner tracks cumulative input + output tokens against the agent's `max_tokens_per_run`. On overrun, the runner stops mid-call, writes `## Error: budget_exceeded` with the actual token count, and emits `agent.task.failed` with reason `budget_exceeded`.
- [ ] Approval gate: if the agent's `requires_approval` is true, the runner stops after writing `## Plan` and emits `agent.task.awaiting_approval`. On the next `document.updated` event for that work item, the runner checks for an `## Approved` section in the body — if present, resumes; if absent, stays paused. Rejection = human deletes the work item or reassigns away from the agent.
- [ ] On completion: patch the work item's body per the convention above, optionally transition `status` if the agent emits one in its final message
- [ ] Delegation: if the agent creates a child work item with `assignee: agent:*`, the child fires a fresh `agent.task.assigned` and the runner re-enters; depth enforced at write time per the Phase 2 guard
- [ ] No AI key configured → assigning a work item to an agent stays in the assigned state but emits an `agent.task.failed` event with reason `no_ai_key`; UI shows a banner on the work item
- [ ] Every agent invocation emits an `ai.action` event tagged with `actor_type: 'agent'` and `actor_id: <agent_document_id>`

### Trigger scheduler + event-pattern matcher

Fires the Phase 2 trigger documents. Two firing paths: a cron-driven scheduler for `schedule` triggers, and an event subscriber for `on_event` triggers. Both create a work item assigned to the trigger's `agent`, which then flows through the standard agent-runner path.

- [ ] `lib/trigger-scheduler.ts`: on server boot, load all enabled triggers with non-null `schedule`; run a single in-process cron loop (1-minute tick, SQLite-backed — no Redis)
- [ ] On schedule fire: create a work item in the trigger's project with `assignee: agent:<trigger.agent>`, title `"Triggered run: <trigger.slug>"`, body containing the trigger's `payload` JSON as a `## Input` section
- [ ] `lib/trigger-matcher.ts`: subscribes to the events pub/sub; on each event, scan triggers with matching `on_event` kind in the same workspace; apply `event_filter` (same mongo-ish dialect as view filters); fire matching ones
- [ ] Fired triggers patch their own frontmatter: `last_fired_at = now`, `last_status = 'ok'|'failed'` based on whether the work item was created successfully
- [ ] Loop prevention: trigger-created work items carry `frontmatter.fired_by: <trigger_slug>`; the event-matcher skips events whose source document already has `fired_by` set (prevents trigger A firing trigger B firing trigger A)
- [ ] Disabled triggers (`enabled: false`) are loaded but never fire — toggling `enabled` is the off switch
- [ ] On trigger document delete: removed from the in-memory schedule + subscriber lists in the same transaction
- [ ] New event kinds: `trigger.fired` (success), `trigger.failed` (e.g. agent doesn't exist, payload invalid)

### Audit

- [ ] Every AI call emits an `ai.action` event with input/output token counts (no content stored)

### Phase 3 acceptance

- [ ] Configure Anthropic key, run `/draft` on a new work item, body streams in
- [ ] `/decompose` creates linked child documents
- [ ] `/link` inserts wiki-links correctly
- [ ] Removing the key disables all slash commands gracefully
- [ ] Create an agent with `tools: ['create_document', 'update_document']`, assign a work item to it, see the body patched by the agent within a few seconds
- [ ] Agent A creates a child work item assigned to agent B; B runs and patches its own work item (one level of delegation works end-to-end)
- [ ] An agent attempting to delegate past `max_delegation_depth` gets rejected and emits `agent.task.failed` with reason `depth_exceeded`
- [ ] Create a cron trigger set to `* * * * *`; within ~60 seconds a work item is created and the assigned agent patches its body
- [ ] Create an event trigger on `document.updated` with filter `{ "document.status": "Done" }`; flipping a work item to Done fires the trigger exactly once
- [ ] A trigger created by an agent's output does not re-fire indefinitely (loop prevention via `fired_by` works)
- [ ] Commit: `phase-3: complete`

---

## Phase 4 — Inbound webhooks (Half-week)

**Goal:** External systems (Statamic contact forms, WordPress FluentForms, webshop checkouts, Stripe/Mollie) POST to a Folio webhook URL and a markdown document is created in the configured table with payload fields mapped to frontmatter. This is the inbound half of the agency back-office loop.

> Plan ready at `docs/superpowers/plans/2026-05-24-phase-4-inbound-webhooks.md`. 7 tasks. Backend only — admin UI for managing webhooks lands in Phase 7.

### Schema + auth

- [ ] New `webhooks` table: `(id, workspace_id, table_id, name, secret, mapping JSON, active, last_fired_at, created_by, created_at)`
- [ ] Secret-in-URL auth: `POST /api/v1/webhooks/:secret` — the secret IS the auth (no session, no bearer)
- [ ] `webhooks_secret_idx` unique index
- [ ] Migration `0005_phase_4_webhooks.sql`

### Mapping engine

- [ ] `lib/payload-mapping.ts`: pure helper resolves `$payload.key.nested` references against the JSON body
- [ ] Reference syntax: `$payload` = whole payload JSON, `$payload.key.nested` = path walk, literal strings pass through unchanged
- [ ] Missing paths resolve to empty string; non-string values coerced via `String()`
- [ ] Shared type `WebhookMapping` in `@folio/shared/webhook-mapping.ts`

### Inbound POST

- [ ] `POST /api/v1/webhooks/:secret` looks up webhook by secret, validates active, parses JSON, resolves mapping
- [ ] Creates a `work_item` document via the same code path as authenticated POST (slug uniqueness, event emission)
- [ ] Bumps `webhooks.last_fired_at`
- [ ] Emits `webhook.fired` event for observability
- [ ] Returns `202 Accepted` with `{ data: { slug, title } }`

### Authenticated CRUD

- [ ] `GET /api/v1/w/:wslug/webhooks` — list (secret redacted)
- [ ] `POST /api/v1/w/:wslug/webhooks` — create; returns secret + full URL ONCE
- [ ] `PATCH /api/v1/w/:wslug/webhooks/:id` — rename / toggle active / edit mapping
- [ ] `DELETE /api/v1/w/:wslug/webhooks/:id`
- [ ] Cross-tenant guard: `tableId` must belong to a project in the request workspace

### Phase 4 acceptance

- [ ] Statamic FluentForms POSTs a contact-form submission → Folio creates a `work_item` in the configured "Leads" table with the form fields as frontmatter
- [ ] Deactivating a webhook makes subsequent POSTs return 403
- [ ] Rotating a secret = delete + recreate the webhook (no in-place rotation in v1)
- [ ] Commit: `phase-4: complete`

> **Out of scope for Phase 4:** HMAC signature verification, retry queue, per-webhook rate limiting, admin UI (covered in Phase 7 UX Polish).

---

## Phase 5 — CMS bridge: Statamic (Week 6)

**Goal:** Folio documents publish to a Statamic site. A document with `status: 'published'` in a configured source table syncs to a Statamic collection entry; subsequent edits replicate; unpublishing deletes the remote entry. This is the outbound half of the agency back-office loop.

> Plan ready at `docs/superpowers/plans/2026-05-24-phase-5-statamic-cms-bridge.md`. 10 tasks. WordPress adapter is Phase 5.1 (same architecture, different adapter class) — explicitly out of scope here so we ship one solid adapter end-to-end.

### Schema

- [ ] `sync_targets` table: `(workspace_id, source_table_id, adapter='statamic', base_url, collection_handle, token_encrypted, publish_on_status, mapping JSON, active)`
- [ ] `sync_log` append-only table for visibility + future retry — `(sync_target_id, document_id, remote_id, operation, status, error)`
- [ ] Migration `0006_phase_5_sync_targets.sql`
- [ ] Token libsodium-encrypted at rest (reuse the BYOK crypto helpers)

### Adapter interface + Statamic implementation

- [ ] `lib/adapters/interface.ts`: `CmsAdapter` interface with `createEntry / updateEntry / deleteEntry` — forward-compatible with WP in 5.1
- [ ] `lib/adapters/statamic.ts`: REST + bearer-token implementation
  - POST `/api/collections/{handle}/entries`
  - PATCH `/api/collections/{handle}/entries/{id}`
  - DELETE same path
  - Trims trailing slash from baseUrl; throws on non-2xx with body excerpt

### Mapping + sync engine

- [ ] `lib/sync-mapping.ts`: pure helper — `(doc, mapping, publishOnStatus) → AdapterEntry`
- [ ] Reference syntax: `$title`, `$body`, `$slug`, `$frontmatter.key` — literals pass through
- [ ] `lib/sync-engine.ts`: per-document, finds matching sync_targets, decides create/update/delete based on prior `sync_log`, calls adapter, writes log row
- [ ] Sync runs synchronously AFTER the document write transaction commits (failure doesn't roll back the local doc)
- [ ] Errors recorded in `sync_log.status='error'` — surfaced via UI in Phase 7
- [ ] Pages (`tableId IS NULL`) are skipped — sync is table-scoped

### Hooks into document writes

- [ ] POST `/documents` calls `syncDocument(db, newDocId)` after commit
- [ ] PATCH `/documents/:slug` calls `syncDocument(db, existing.id)` after commit (both markdown and JSON branches)
- [ ] DELETE `/documents/:slug` issues remote delete via the adapter directly (no syncDocument because the local doc is already gone)

### Workspace-scoped CRUD

- [ ] `GET /api/v1/w/:wslug/sync-targets` (token redacted)
- [ ] `POST /api/v1/w/:wslug/sync-targets` (token encrypted on insert)
- [ ] `PATCH /api/v1/w/:wslug/sync-targets/:id`
- [ ] `DELETE /api/v1/w/:wslug/sync-targets/:id`
- [ ] Adapter enum restricted to `['statamic']` in 5.0 (5.1 adds `'wordpress'`)

### Phase 5 acceptance

- [ ] Configure a sync target pointing at a Statamic site, create a Folio doc with status='published' → Statamic shows the entry within seconds
- [ ] Edit the doc's title in Folio → Statamic entry updates via PATCH on the same `remote_id`
- [ ] Change the status to 'draft' → Statamic entry is deleted
- [ ] Delete the Folio doc → Statamic entry is also deleted (with a `sync_log` row for the delete)
- [ ] Sync failures (e.g. wrong token) land as `sync_log.status='error'` rows with the response body excerpt
- [ ] Commit: `phase-5: complete`

> **Phase 5.1 (deferred):** WordPress adapter via REST API (`/wp-json/wp/v2/posts`). Same architecture, different adapter class. Defer until Phase 5.0 has run against a real client site for at least 4 weeks.

---

## Phase 6 — Per-view render modes (Half-week)

**Goal:** Views become first-class render-mode containers. A view stores `renderAs: 'list' | 'kanban' | 'calendar'`; picking a view switches the active render mode for its table. Kanban is no longer a separate sibling tab — it's a render mode like any other. Calendar is a new render mode that consumes `frontmatter.due_date` (same data Phase 1.8 uses).

> Originally branded "Phase 2D" in the May 24 brainstorm; renumbered to Phase 6 so it sits after Agents + integrations as a v1 polish item.

### Schema

- [ ] Extend `views.type` enum to `['list', 'kanban', 'calendar', 'timeline']` (timeline already added in Phase 1.8; kanban moves from being a tab to being a view type)
- [ ] Migration `0007_phase_6_view_render_modes.sql`

### Routing

- [ ] Remove `/work-items` and `/board` as separate route segments; the project route becomes `/w/:ws/p/:p/t/:tslug?view=:vslug` and the view's `type` decides the renderer
- [ ] Backward-compat redirect: old `/work-items` and `/board` URLs redirect to the corresponding default view
- [ ] Wiki stays at `/w/:ws/p/:p/wiki` (pages have no `tableId` and don't participate in render modes)

### Renderers

- [ ] `<ViewRouter>` component picks the renderer based on `view.type`
- [ ] List → `TableView` (Phase 1.5)
- [ ] Kanban → `KanbanView` (existing — lifted from `/board` route)
- [ ] Calendar → new `CalendarView` (month grid; items render on `frontmatter.due_date`)
- [ ] Timeline → `TimelineView` (Phase 1.8)
- [ ] Each renderer reads visibleFields / columnOrder / sort from the active view

### Phase 6 acceptance

- [ ] Switching from a list view to a kanban view of the same table preserves filters but changes the layout
- [ ] Creating a new "Calendar" view via the rail's `+` action lets the user pick which date field drives the calendar
- [ ] No `/board` route exists anymore (old links redirect); `/work-items` is also gone (redirects to default view)
- [ ] Commit: `phase-6: complete`

---

## Phase 7 — UX Polish (Week 7)

**Goal:** Hit every UX commitment from FOLIO-BRIEFING.md §11. Playwright covers them end-to-end.

### Cmd-K palette

- [ ] `components/palette.tsx`: global Cmd-K opens a fuzzy-search palette *(initial version shipped in Phase 1.5; Phase 7 deepens it)*
- [ ] `usePaletteCommands()` hook: components register commands
- [ ] Default registry: workspaces, projects, documents (by title), actions (new work item, switch theme, copy as MD, ...)
- [ ] Recent surfaces first when query is empty
- [ ] Arrow / Enter / Escape work

### Keyboard shortcuts

- [ ] Global: `Cmd-K` palette, `C` new document (when in a project), `/` focus search, `?` show shortcuts
- [ ] List view: `J`/`K` move focus, `Enter` open slideover, `E` edit title inline
- [ ] Editor: `Cmd-S` save (no-op since optimistic, but show a "Saved" toast)
- [ ] Document view: `Cmd-Shift-C` copy as MD

### Slideover polish

- [ ] Animation enters from right, ~600px wide on desktop, full-width on mobile
- [ ] URL updates to `/w/.../documents/:slug` while open
- [ ] Browser back closes slideover (does not pop list view)
- [ ] Escape closes; click-outside closes

### Optimistic UI

- [ ] All mutations via a `useOptimisticMutation` helper that updates query cache before fetch
- [ ] Rollback + toast on failure
- [ ] Subtle "Saving…" indicator in the corner during in-flight writes

### Copy-as-MD

- [ ] Right-click any row → context menu with "Copy as Markdown" *(shipped in Phase 1)*
- [ ] Right-click in a document view → same
- [ ] `Cmd-Shift-C` on focused row triggers it
- [ ] Output matches the export format exactly (frontmatter + body)

### Admin UI for integrations

> The Phase 4 (webhooks) + Phase 5 (sync targets) CRUD shipped as API only; Phase 7 wraps them in usable admin screens.

- [ ] `/w/:wslug/settings/webhooks` — list webhooks, create-with-secret-reveal flow, edit mapping
- [ ] `/w/:wslug/settings/sync` — list sync targets, create flow with adapter dropdown + token field, test-connection button
- [ ] Both surfaces show `last_fired_at` / `sync_log` excerpt + retry-failed-sync button

### Theme & polish

- [ ] Dark mode (default) and light mode toggle *(shipped in 1.5)*
- [ ] Empty states with helpful copy
- [ ] Loading skeletons (not spinners) on initial loads
- [ ] Error boundaries on each route with retry

### Playwright

- [ ] Install Playwright in `apps/web/tests/e2e/` *(shipped in Phase 1)*
- [ ] One e2e test per UX commitment
- [ ] CI runs Playwright headlessly (later — local for now)

### Phase 7 acceptance

- [ ] All six UX commitments pass Playwright
- [ ] Dark mode looks good on every screen
- [ ] Webhook + sync admin screens shipped and tested
- [ ] Commit: `phase-7: complete`

---

## Phase 8 — Ship (Week 8)

**Goal:** Public release. Docs, landing page, one paying customer.

### Docs

- [ ] `README.md` — what Folio is, install in 60 seconds, screenshot, link to docs
- [ ] `docs/INSTALL.md` — Docker + binary + Ploi recipes
- [ ] `docs/API.md` — finalize REST reference (started in Phase 2)
- [ ] `docs/MCP.md` — finalize MCP reference (started in Phase 2)
- [ ] `docs/WEBHOOKS.md` — inbound webhook recipes (Statamic, FluentForms, Stripe)
- [ ] `docs/CMS-BRIDGE.md` — Statamic adapter recipes; WordPress preview
- [ ] `docs/CUSTOMIZE.md` — themes, field types, view configs

### Release pipeline

- [ ] GitHub Actions: build linux-x64, linux-arm64, macos-arm64 binaries on tag
- [ ] Publish Docker image to GHCR on tag
- [ ] CHANGELOG.md with `0.1.0` entry

### Deploy

- [ ] `scripts/deploy-ploi.sh` — pulls latest binary, restarts systemd unit
- [ ] Stand up `folio.netdust.be` as the public demo + Stefan's own internal instance
- [ ] Move Stefan's Paperclip task tracking and Stride pipeline INTO Folio (dogfood)

### Landing page

- [ ] Simple Statamic or static page at `folio.netdust.be` or similar
- [ ] Three sections: what it is, who it's for, how to install
- [ ] Position as "the agent-driven back-office for small business websites" — orders + leads + content pipeline + SEO tasks in one self-hostable markdown surface that closes the loop with the customer's website via webhooks + Statamic sync
- [ ] Embed a short Loom demo showing the website → Folio → AI agent → published-back-to-website loop
- [ ] Link to GitHub + docs

### First customer

- [ ] Pick one friendly Netdust client (small team, low risk, already on Statamic)
- [ ] Free pilot install on their existing Hetzner instance
- [ ] Onboarding session with them — capture every friction point
- [ ] Wire up at least one inbound webhook (contact form) and one outbound sync target (blog) to close the loop end-to-end
- [ ] Address blockers; ship `0.1.1`
- [ ] Decide pricing for paid installs based on what they were willing to pay

### Phase 8 acceptance

- [ ] Tagged `0.1.0` release on GitHub
- [ ] Stefan is using Folio daily for his own work
- [ ] One non-Stefan user is using Folio in production with at least one webhook + one sync target configured
- [ ] Commit: `phase-8: complete`. Ship it.

---

## After v1

Things to consider for v1.1 onward — *do not build in v1*:

- WordPress CMS bridge adapter (Phase 5.1)
- Webflow / Sanity / Ghost adapters (Phase 5.2+)
- HMAC signature verification on webhooks (Phase 4.1)
- Background queue for sync retries
- Bidirectional sync (Statamic → Folio)
- Asset / image upload through the sync bridge
- Full-text search via sqlite-fts5
- Vector search via sqlite-vec
- Postgres adapter
- Email notifications
- Per-project ACLs
- Public document sharing (read-only links)
- Plugins / extensions API
- Mobile-optimized PWA
