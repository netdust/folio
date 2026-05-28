# Folio — Phases

Eight phases to v1. Each is a focused chunk. Check tasks off as you complete them. When a phase is done, commit `phase-N: complete` and move on.

For full context on any decision: `@docs/FOLIO-BRIEFING.md`. For the operating manual: `@../CLAUDE.md`.

> **Reading guide (2026-05-26 revision).** This doc carves the agent platform into four sequenced phases on top of the shipped Phase 2 / 2.5 surface: **Phase 2.6 (Comments + tabbed slideover)**, **Phase 2.7 (Templates — optional ordering)**, **Phase 3 (Agent runner + runs as documents)**, **Phase 3.5 (Script & webhook trigger actions)**. The May 24 reorg established the surrounding phases (1.5/1.6/1.7/1.8/4/5/6) around the agent spine; the May 26 revision restructured the spine itself — runner output is now child `comment` documents (not body-ledger sections), the approval gate is a `kind=approval` comment (not a body marker), runs are first-class documents in a per-project runs table, slash commands were dropped in favor of the `@`-mention surface. The 0/0.5/1 foundation is shipped; 1.5/1.6/1.7/1.8 polish the operational UI to "good enough to use"; 2/2.5 deliver the declarative agent surface; **2.6/2.7/3 deliver the live agent platform**; 4/5 close the loop with the customer's website; 6/7 polish; 8 ships.

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

- [x] `middleware/bearer.ts`: reads `Authorization: Bearer <token>`, hashes, looks up in `apiTokens`, attaches `{ token, workspace, scopes }` to context. Bumps `apiTokens.lastUsedAt` (best-effort, no transaction).
- [x] Composable `attachToken` (best-effort) + `requireToken` (throws 401 if absent).
- [x] `requireScope('documents:read' | ...)` factory that throws 403 if the token's scopes don't include the required one.
- [x] **Compose with session auth:** every existing scoped route (`/api/v1/w/:wslug/...`) should accept EITHER a session cookie OR a bearer token. Implement as `attachUser` OR `attachToken` → `requireUserOrToken` middleware. Tokens grant workspace scope by virtue of the row's `workspaceId`; user routes check membership as today.
- [x] Scopes use `resource:action` shape per FOLIO-BRIEFING.md §8 and the existing `documents:read|write` defaults. Initial v1 vocabulary: `documents:read`, `documents:write`, `documents:delete`, `fields:write`, `views:write`, `tables:write`, `statuses:write`. (`tokens:admin` not yet enforced — token CRUD is session-only as of Phase 2.)
- [x] Apply scope checks to `documents.ts`, `fields.ts`, `views.ts`, `tables.ts`, `statuses.ts`. Session-auth requests bypass scope checks (membership is the gate there).
- [x] Server tests: token-authenticated GET / POST / PATCH / DELETE on documents; 401 without token; 403 with wrong scope; 403 with revoked token.

### Token UI

- [x] Workspace settings → "API tokens" tab — create with name + scope checkboxes (`documents:{read,write,delete}`, `fields:write`, `views:write`, `tables:write`, `statuses:write`) + Read-only / Read+write / Full access presets; "Show plaintext token" modal on create (one-time copy with warning + a Copy button); list of existing tokens with `lastUsedAt` + revoke (confirm dialog).
- [ ] Inline-edit token name (rename only — scopes are immutable; to change scopes, revoke and recreate). **Deferred to Phase 2.1** — not blocking shipping; revoke-and-recreate is a fine v1 affordance.

### Events & SSE

- [x] In-memory pub/sub — shipped (`lib/event-bus.ts`).
- [x] `lib/event-bus.ts`: `subscribe(workspaceId, filter, handler) → unsubscribe`. In-memory only; one process. Filter shape `{ kinds?: EventKind[], projectId?: string }`.
- [x] `emitEvent` updated to call `eventBus.publish` after the row insert.
- [x] `routes/events.ts`: SSE endpoint `GET /api/v1/w/:wslug/events?kinds=...&project=...`. Workspace-scoped. Bearer or session auth.
- [x] Heartbeat every 30s.
- [x] **Last-Event-Id replay:** the SSE handler reads `Last-Event-Id` header. If present, queries `events` for rows newer than that id (up to 500) and emits before attaching to the live bus.
- [x] Server tests: open SSE, write a document, see event arrive; heartbeat fires.

### Documents type widening

- [x] Migration `0006_agents_and_triggers.sql` widens `documents.type` enum from `('work_item', 'page')` to `('work_item', 'page', 'agent', 'trigger')`. Table-rebuild idiom.
- [x] Drizzle schema reflects the wider enum.
- [x] Existing documents.ts validation Zod schemas accept the new types but reject `tableId` on agent/trigger (they belong to the project, not a table).
- [x] Server tests: create agent, create trigger, reject `tableId` set on either.

### Agents-as-documents (surface only)

- [x] Agent frontmatter Zod schema (`apps/server/src/lib/agent-schema.ts`).
- [x] On agent create: auto-mint an `apiTokens` row scoped via `toolsToScopes()`. Store `api_token_id` in frontmatter. Plaintext token returned ONCE in the create response as `agent_token`.
- [x] On agent delete: revoke the linked `apiTokens` row in the same transaction.
- [x] Assignment convention: `frontmatter.assignee = agent:<slug>` is the agreed-upon shape.
- [x] New event kinds: `agent.task.assigned`, `agent.created`, `agent.deleted`. Emitted from the documents service.
- [x] Delegation guard: walks `parent_agent` chain; rejects when depth exceeds parent's `max_delegation_depth`. Detects cycles. Source: `apps/server/src/lib/delegation-guard.ts`.
- [x] UI: rail shows "Agents" as a leaf row under each project (alongside Wiki + Triggers). Route at `/w/:wslug/p/:pslug/agents`.
- [x] UI: agent slideover renders frontmatter via the standard form; body editor handles the system context. Type-aware frontmatter validation happens server-side.
- [x] UI: assignee picker (`apps/web/src/components/assignee/assignee-picker.tsx`) shows two sections — humans (via new `/members` endpoint) and agents (via `useDocuments` with `type=agent`). Persists as plain string.

### Triggers-as-documents (surface only — scheduler in Phase 3)

- [x] Trigger frontmatter Zod schema (`apps/server/src/lib/trigger-schema.ts`). All fields shipped per the spec.
- [x] At least one of `schedule` or `on_event` must be set — Zod refines and rejects triggers with both null.
- [x] Cron validation: `validateCronShape()` — structural check, 5 fields, `/^[0-9*,\-\/]+$/` per field.
- [x] Event-kind whitelist: `KNOWN_EVENT_KINDS` enum check.
- [x] Trigger CRUD reuses the existing documents endpoints — no new routes.
- [x] UI: rail shows "Triggers" as a leaf under each project (alongside Wiki + Agents). Route at `/w/:wslug/p/:pslug/triggers`.
- [ ] UI: structured trigger form (cron input with validate affordance, event-kind `<select>`, JSON payload editor). **Deferred to Phase 2.1** — current slideover uses the generic frontmatter form, which round-trips correctly but doesn't pretty-render cron/event fields.
- [ ] Exported MD includes triggers under `projects/<pslug>/trigger/<slug>.md`. **Deferred** — bulk MD export is Phase 7 polish.

### MCP server (hand-rolled, /mcp)

Hand-rolled Hono sub-app at `/mcp`. Speaks JSON-RPC 2.0 over HTTP POST. Bearer-authenticated like REST. Single-binary commitment intact — no `@modelcontextprotocol/sdk` dependency.

- [x] `routes/mcp.ts`: handles `initialize`, `tools/list`, `tools/call`, `ping` JSON-RPC methods.
- [x] All 12 v1 tools shipped. Each delegates to the shared `services/*` layer.
- [x] `get_document_markdown` returns the round-tripped frontmatter + body as text content.
- [x] Tool gating by token scopes: tokens missing the required scope get JSON-RPC error `-32603` with `data: { tool, required_scope }`.
- [ ] **Deferred to Phase 2.1:** `get_folio_workflow` tool.

### Documentation

- [x] `docs/API.md`: REST reference, hand-written, covers all current routes + bearer auth + scopes.
- [x] `docs/MCP.md`: tool reference with example JSON-RPC requests + responses.
- [x] `docs/AGENTS.md`: agent-document model — schema, auto-token lifecycle, assignee convention, delegation rules, event contracts.
- [x] `docs/TRIGGERS.md`: trigger-document model — schema, cron + event-pattern semantics.
- [x] Updated root `README.md` with the "Agents in five minutes" walkthrough.

### Phase 2 acceptance

- [x] Create token via UI, use it to `curl -H "Authorization: Bearer ..." POST /api/v1/.../documents` → success. (Shake-out Track A check #8 + 11.)
- [x] Same `curl` without the scope returns 403 with a clear message. (Server tests in `bearer.test.ts` + `composite-auth.test.ts`.)
- [x] Revoking a token immediately blocks subsequent requests (401). (Server test in `composite-auth.test.ts`.)
- [x] Connect via the MCP endpoint with a JSON-RPC client, list workspaces, create a document. (Shake-out Track A check #10–12.)
- [x] Open SSE stream, edit a document in the UI, see the event arrive within 1s. (Shake-out Track A check #16 — observed <0.5s.)
- [x] Open SSE stream with `Last-Event-Id` header, get buffered events from the table before live ones start streaming. (Server test in `events-route.test.ts`.)
- [x] Create an agent document via UI; its API token is auto-minted and visible in the workspace tokens list with the right scopes; the agent appears in the work-item assignee picker. (Shake-out Track A check #12 + Track B item 5.)
- [x] Assigning a work item to `agent:<slug>` emits exactly one `agent.task.assigned` event on the SSE stream. (Shake-out Track A check #17 — observed both `document.updated` and `agent.task.assigned`.)
- [x] Deleting an agent revokes its token immediately (subsequent requests with that token return 401). (Server tests in documents.service tests.)
- [x] Create a trigger document with a cron schedule pointing at an existing agent; trigger persists and round-trips as MD. (Shake-out Track A check #14.)
- [x] Create a trigger with `on_event` + `event_filter`; validation accepts known event kinds and rejects unknown ones. (Tests in `trigger-schema.test.ts`.)
- [x] Trigger Zod rejects a trigger with both `schedule: null` AND `on_event: null`. (Tests in `trigger-schema.test.ts`.)
- [x] All existing user-flow tests still pass — no session-auth regression. Web 292/1-skip, server 216/1-skip, shared 28/28 on the phase-2/agents-surface tip.
- [ ] Commit: `phase-2: complete` (this commit)

---

## Phase 2.5 — Workspace-scoped agents (Half-week)

**Goal:** Move agent + trigger identity from per-project to workspace-level so a single "Triage Bot" can act across multiple projects without per-project duplication. Add a `projects:` allow-list in frontmatter for explicit narrowing. Surface agents + triggers from the workspace popover instead of under each project rail.

> **Why:** Operational reality from one user × three workspaces — agents kept being copy-pasted between projects in the same workspace, and each copy needed its own token. Workspace-scoped agents with a frontmatter allow-list collapse the duplication.

**Shipped + merged to main + pushed** at `7d73124` on 2026-05-26. 45 commits. Spec: `docs/superpowers/specs/2026-05-26-phase-2.5-workspace-scoped-agents-design.md`. Plan: `docs/superpowers/plans/2026-05-26-phase-2.5-workspace-scoped-agents.md`. Locked decisions: `memory/DECISIONS.md` → "Phase 2.5 — Agent scope model (2026-05-26)".

### Data model

- [x] Migration `0006_phase_2_5_workspace_agents.sql`: `documents.workspace_id NOT NULL` (backfilled from `project_id`), `project_id` relaxed to nullable, CHECK enforces the type ↔ scope invariant (`agent`/`trigger` ⇒ `project_id IS NULL`; `work_item`/`page` ⇒ `project_id IS NOT NULL`). New indexes on `(workspace_id, type, slug)` UNIQUE and `(workspace_id, type)`.
- [x] `api_tokens` gain `agent_id` (FK → `documents.id` ON DELETE CASCADE — revoking an agent deletes its token) + `project_ids` (JSON, nullable; `null` = inherit from agent, `[]` = explicitly no projects, an array = narrow to subset of agent's allow-list).
- [x] Agent frontmatter Zod gains `projects: string[]` default `['*']`. Refine rejects `['*', ...ids]` (wildcard exclusivity). Project ids are uuids (survives project renames without rename-time fixup).
- [x] Trigger frontmatter is unchanged. Triggers inherit their project allow-list from the referenced agent — no per-trigger `projects:` field.
- [x] Pre-existing agent/trigger rows from Phase 2 (seeded as project-scoped) are dropped by the migration since they violate the new CHECK. Their auto-minted tokens (`name LIKE 'agent:%'`) drop with them. Phase 2 was a fresh deploy; nothing was lost.

### Middleware

- [x] New `requireResource()` middleware in `apps/server/src/middleware/bearer.ts`. Bypasses session-auth (membership is the gate) and human PATs (Phase 3+ enforcement). For agent-bound bearer tokens: loads the agent, intersects `frontmatter.projects` with `token.projectIds` (the helper is the exported `intersect(agentList, tokenList)`), throws `FORBIDDEN_RESOURCE` 403 when the requested `:pslug` isn't in the result.
- [x] Mounted on `pScope.use('*', resolveProject, requireResource())` in `apps/server/src/app.ts`. **BUG-001 from shake-out:** middleware was exported + unit-tested but the integration wire was missed; a token narrowed to `[folio, stride]` could read `/p/client-website/documents` (200 instead of 403). Live re-sweep verified the fix.
- [x] `intersect()` semantics tested for all algebra cases: `(['*'], null) → ['*']`, `(['*'], ['a','b']) → ['a','b']`, `(['a','b','c'], ['b','c','d']) → ['b','c']` (drops broadening), `(['a'], []) → []` (token revoked at resource layer).

### Routes

- [x] New `routes/workspace-documents.ts` mounted on `wScope.route('/documents', …)`. Exposes `POST /api/v1/w/:wslug/documents` (agent + trigger only), `GET ?type=agent|trigger&project=<id>` (server-side allow-list filter), `GET /:slug`, `PATCH /:slug`, `DELETE /:slug`.
- [x] `POST /api/v1/w/:wslug/p/:pslug/documents` with `type: 'agent'|'trigger'` returns `422 INVALID_DOCUMENT_SCOPE` with a pointer to the workspace URL.
- [x] `GET /api/v1/w/:wslug/p/:pslug/documents?type=agent|trigger` returns `400 UNSUPPORTED_TYPE_FILTER` with the same pointer.
- [x] `services/documents.ts` `createDocument` writes `workspace_id` for all rows; agents/triggers get `project_id: null`. Auto-minted token rows now carry `agent_id` so the cascade FK can revoke on delete (the old by-frontmatter-`api_token_id` cleanup is now a redundant safety net).
- [x] `services/documents.ts` `updateDocument` + `deleteDocument` accept `project: Project | null` so workspace-scoped CRUD shares the service layer with project docs.
- [x] Project-delete (`DELETE /api/v1/w/:wslug/p/:pslug`) transactionally scrubs the deleted project id from every workspace agent's `frontmatter.projects` array. Wildcard agents untouched; explicit allow-lists lose only the deleted id. SQLite can't enforce FK across JSON columns; this is the enforcement point.

### MCP

- [x] `resolveProjectInWorkspace()` now takes the token, intersects the agent's allow-list with `token.project_ids`, returns `-32602` with `data: { reason: 'agent_not_in_allow_list', project_slug, agent_slug }` on miss. Structured server log on every rejection (operators can debug "my agent is silently ignoring this project").
- [x] `list_projects` filters its output by the same intersection (Notion-style default-deny). Human PATs (no `agent_id`) and wildcard agents see everything.
- [x] `create_document` with `type=agent|trigger` returns `-32602` with `data: { reason: 'agent_lifecycle_via_http_only' }`. `update_document` + `delete_document` reject the same way when the target doc is an agent or trigger.
- [x] MCP error response builder propagates `err.code` + `err.data` (was hardcoding `-32603`).

### UI

- [x] Rail: `Agents` and `Triggers` leaves removed from every project node in `apps/web/src/lib/rail-tree.ts`. Project rail is now content-only: Tables · Views · Wiki.
- [x] Workspace popover (`components/shell/workspace-switcher.tsx`) gains `Agents` (Bot icon) + `Triggers` (Zap icon) menu items above the existing footer.
- [x] New `/w/:wslug/agents` route. New `WorkspaceAgentsPage` lists workspace agents with project chips (id → current slug via `useProjects` cache; orphans render as `<prefix>·removed` muted chips; wildcard renders a single "All projects" chip). Chip click filters via `?project=<id>`. `+ New agent` button in header + on empty state.
- [x] New `/w/:wslug/triggers` route + `WorkspaceTriggersPage` (analogous list; trigger create needs at least one workspace agent to satisfy the Zod `agent` field).
- [x] New `WorkspaceDocumentSlideover` (workspace-scoped analog of `DocumentSlideover`). Reads `?doc=<slug>`, hydrates via `useWorkspaceDocument`, renders title editor + FrontmatterForm + Body editor (rich/raw toggle) + Delete via ⋯ menu. Skips project-only surface (no status field, no pinned fields, no ActivityPanel, no LogActivity, no Copy-as-MD — those deferred to Phase 2.6 polish).
- [x] New mutation hooks `useCreateWorkspaceDocument` / `useUpdateWorkspaceDocument` / `useDeleteWorkspaceDocument` in `lib/api/workspace-documents.ts`.
- [x] `AssigneePicker` swapped from `useDocuments(wslug, pslug, {type:'agent'})` to `useWorkspaceAgents(wslug, {project: projectId})` (resolves `pslug → projectId` via `useProjects`). `keepPreviousData` avoids skeleton flash on re-open.
- [x] `FrontmatterForm` for agents auto-renders three custom multi-select editors by key dispatch (same pattern as `assignee`): `projects` → `ProjectsField` (wildcard collapse semantics, never produces invalid `['*', ...ids]` even transiently), `tools` → `ToolsField` (sourced from `V1_MCP_TOOLS` in `@folio/shared`; grouped Read/Write/Delete), `provider` → `ProviderModelField` (one row owns both `provider` + `model` keys; provider select annotated with "no key" badge per `useWorkspaceAiKeys`; model select hardcodes the Anthropic/OpenAI catalogue, free-text input for OpenRouter/Ollama).
- [x] Agent form has a canonical field order (system_prompt → provider/model → tools → projects → max_delegation_depth → max_tokens_per_run → requires_approval) + plain-English help text per field.

### Design system

- [x] New `<Chip>` primitive in `components/ui/chip.tsx`. API: `<Chip>label</Chip>`, `<Chip muted>label</Chip>`, `<Chip onClick={fn}>label</Chip>`, `<Chip mono>label</Chip>` (compose freely). Default: `border border-border-light bg-card text-fg-2` at rest (visible without floating), primary tint on hover when clickable. Renders `<span>` when no `onClick`, `<button>` (with `forwardRef`) when present.
- [x] Three ad-hoc chips migrated to the primitive: `ProjectChip` in `workspace-agents-page.tsx`, local `Chip` in `projects-field.tsx`, local `Chip` in `tools-field.tsx`. All three local definitions deleted.
- [x] Pre-existing `Chip` (filter-bar key+value) renamed to `FilterChipValue`. Sole consumer (`dev.design-system.tsx`) updated.
- [x] Design system page shows the new Chip variants in a canonical row.

### Tests

- [x] Server: 259 / 1-skip / 0-fail on the merge tip (was 216 / 1-skip pre-Phase-2.5). New: migration tests, `requireResource` algebra + integration tests, workspace-documents route tests, MCP allow-list tests, project-delete cascade tests.
- [x] Web: 339 / 1-skip / 0-fail (was 292 / 1-skip). New: `WorkspaceAgentsPage` page tests, `ProjectsField`, `ToolsField`, `ProviderModelField`, `Chip` primitive tests.
- [x] Shared: 28 / 0-fail. New `MCP_TOOL_GROUPS` + `V1_MCP_TOOLS` export.
- [x] Phase 2.5 Playwright e2e: `phase-2-5-workspace-agents.spec.ts` — create narrowed agent, verify the assignee picker shows it in the allow-listed project and NOT in the other. 1/1.

### Phase 2.5 acceptance

- [x] All 9 plan tasks merged.
- [x] Project rail has zero Agents/Triggers leaves. Workspace popover has both (with icons).
- [x] Workspace agent with `projects: [<inboxId>]` shows in `/p/inbox` assignee picker, not in `/p/website`. (E2E.)
- [x] MCP `list_projects` filters by allow-list. (Test in `mcp.test.ts`.)
- [x] MCP project-scoped tools reject cross-allow-list with `-32602 agent_not_in_allow_list`. (Test in `mcp.test.ts` + live curl re-sweep.)
- [x] `bun --filter=server tsc --noEmit` unchanged from pre-2.5 baseline. `bun --filter=web tsc --noEmit` clean.
- [x] Commit: `phase-2.5: workspace-scoped agents (merge)` — `7d73124` on main.

### Phase 2.5 deferrals (Phase 2.6 + Phase 3)

- [ ] `create_agent` / `update_agent` / `delete_agent` / `get_agent_self` MCP tools. **Phase 2.6 — v1 blocker** per spec.
- [ ] Templates (instance-level Settings page, inert markdown, `template:` + `template_version:` references on instances, sync UI). **Phase 2.6.**
- [ ] Background allow-list reconciler (periodic sweep removing orphan project ids; insurance against bugs in the cascade hook + hand-edited MD + partial restore-from-backup). **Phase 2.6.**
- [ ] Workspace-scoped `.md` export endpoint + Copy-as-MD on workspace slideover + bulk MD export of agents/triggers. **Phase 2.6 polish.**
- [ ] ActivityPanel + LogActivity on workspace agent slideover. **Phase 2.6 polish.**
- [ ] Human PAT `project_ids` enforcement (column exists; needs UI). **Phase 3+.**
- [ ] Per-project action-scope overrides. **Only if a real use case appears.**
- [ ] Cache the agent's `projects:` allow-list in `requireResource`. **Measure perf first.**
- [ ] Table-cell `AssigneePicker` (was never wired pre-2.5 either). **Phase 7 UX polish.**

---

## Phase 2.6 — Comments primitive + tabbed slideover (Week 5a)

**Goal:** Land the data + UX foundation that does NOT need an AI key. New `comment` document type, tabbed slideover (Fields · Comments · Activity, plus Runs for agent/trigger types), mention parser with `@`-mention picker, structured trigger form, ActivityPanel on workspace agent slideover, four built-in triggers auto-seeded per workspace, agent-lifecycle MCP tools, allow-list reconciler. The comments thread renders end-to-end on work_items and pages; the runner that fills it with agent output ships in Phase 3.

> **Why this carve:** comments are a pure data + UX feature with no provider dependency. Shipping them first unlocks the manual callcenter workflow (humans threading on work items), gives Phase 3 a working substrate to write into, and is independently testable.

> Spec: `docs/superpowers/specs/2026-05-26-phase-2.6-comments-and-tabbed-slideover-design.md`.

### Data model

- [ ] Migration `0007_phase_2_6_comments.sql`: widen `documents.type` enum to include `comment`. CHECK constraint: `type='comment' ⇒ parent_id IS NOT NULL AND parent.type IN ('work_item','page') AND table_id IS NULL`. Index `documents_comments_idx` on `(parent_id, created_at DESC)`.
- [ ] Comment frontmatter Zod (`apps/server/src/lib/comment-schema.ts`): `author`, `kind` (`comment|plan|result|error|approval|rejection|reply`, default `comment`), `visibility` (`normal|internal`, default `normal`), `mentions` (array of resolved targets carrying `target` + `resolved` + `resolvedId` + `resolvedType`), `edited_at`, `target_agent` (required+exclusive on `kind in {approval,rejection}`), `run_id`.

### Services + routes

- [ ] `services/comments.ts` — create / list / get / patch / delete. Soft delete (row stays, body blanked, `deleted_at` in frontmatter). All mutations transactional via `emitEvent`.
- [ ] `lib/mention-parser.ts` — token regex `/(?:^|\s)@([a-z][a-z0-9-]+)/g`. Resolves agents (allow-list-filtered for current project) + members (email localpart, ambiguous → unresolved). Returns `ResolvedMention[]` carrying `target` + `resolved` + `resolvedId` + `resolvedType` so the Phase 3 runner can look up the agent/user by id directly. Approval-keyword detection: `approved|rejected` in positions 1 or 2 immediately after the mention.
- [ ] `routes/comments.ts` — 4 REST verbs mounted at `/api/v1/w/:ws/p/:p/documents/:parentSlug/comments` + `/api/v1/w/:ws/p/:p/comments/:slug`. Bearer-token scopes: `documents:read` for GETs, `documents:write` for mutations. `requireResource()` enforces project allow-list for bearer tokens.
- [ ] Edit + delete restricted to comment's author (user-id or agent-slug match).

### Events + SSE

- [ ] New event kinds added to `KNOWN_EVENT_KINDS`: `comment.created`, `comment.mentioned`.
- [ ] `comment.created` fires once per new comment row. `comment.mentioned` fires once per resolved agent mention (so a single comment with 3 agent mentions emits 3 events).
- [ ] SSE filter params added to `/api/v1/w/:wslug/events`: `?parent=<doc_id>`, `?run=<run_id>`. AND-combined with existing `?kinds=` + `?project=`.

### MCP tools (8 new)

- [ ] `create_comment` (`documents:write`): post a comment on a work_item or page. Server resolves `author=agent:<slug>` from the bearer's `agent_id`. Parent must be in caller's allow-list.
- [ ] `list_comments` (`documents:read`): list a parent's comments; filterable by `kind`.
- [ ] `update_comment` / `delete_comment` (`documents:write` / `documents:delete`): author-only; soft delete.
- [x] `create_agent` / `update_agent` / `delete_agent` (new scope: `agents:write`): workspace-scoped agent CRUD via MCP. Token auto-minted on create; revoked on delete (existing Phase 2.5 cascade). *(D8)*
- [x] `get_agent_self` (no scope required): returns the calling agent's own document. Resolves via bearer's `agent_id`. *(D8 — implemented as `documents:read` since the agent row is a document.)*
- [x] New scope `agents:write` added to `apiTokens.scopes` vocabulary. Workspace settings UI scope-checkbox + Read+write/Full presets updated. *(D8)*

### UI — tabbed slideover

- [ ] `components/slideover/tab-strip.tsx`: icon-tab strip between title row and body editor. Tab state per-slideover-open (no URL persistence). Counts render where meaningful (`💬 Comments · 4`).
- [ ] Per-type tab sets: work_item / page → `Fields · Comments · Activity`. agent → `Fields · Activity · Runs`. trigger → `Fields · Activity · Runs`.

### UI — Comments tab

- [ ] `components/comments/comments-tab.tsx`: newest-first list, composer pinned at top. Subscribes to `comment.created` + `comment.mentioned` via SSE filtered by `?parent=`. "Show internal" toggle above the list controls whether `visibility: internal` rows render (default hidden); state persists to `localStorage`.
- [ ] `components/comments/comment-composer.tsx`: Milkdown-lite (no `/` slash menu). `Cmd/Ctrl+Enter` posts. `localStorage` draft persistence keyed by parent_id. Escape closes the tab when composer is empty + focused.
- [ ] `components/comments/mention-picker.tsx`: `@` opens popover. Two sections — AGENTS (allow-list-filtered via `useWorkspaceAgents`) and MEMBERS (via existing `/api/v1/w/:wslug/members`). Leading 🤖 / 👤 icons. Arrow / Enter / Escape.
- [ ] `components/comments/wiki-link-picker.tsx`: `[[` opens popover. Fuzzy by title across workspace docs. Selection inserts `[[<slug>]]`. Shared component — body editor consumes the same picker.
- [ ] `components/comments/comment-row.tsx`: author chip · timestamp · kind chip (hidden on `kind=comment`) · run-id badge link. Hover-revealed Edit / Delete / Copy-as-MD. Soft-deleted rows render as muted single-line. Stale mentions render strikethrough. Internal-visibility rows render with a muted "internal" pill.
- [ ] `components/comments/approval-buttons.tsx`: render only on `kind=plan` comments. Approve → POSTs `kind=approval` with `target_agent` resolved. Reject → opens popover for optional reason, POSTs `kind=rejection`. Resolved state shows muted "Approved/Rejected by @X · Nm later". In Phase 2.6 the buttons post comments correctly but no run lifecycle exists yet — wiring to runner state ships in Phase 3.

### UI — Activity tab on workspace agent slideover (Phase 2.5 carry-over)

- [ ] ActivityPanel + LogActivity components from Phase 1.7 wire into the workspace agent slideover. Reads events where `documentId = agent.id`. Posts via the existing Phase 1.7 endpoint.
- [ ] Endpoint widening: the existing `POST /api/v1/w/:wslug/documents/:slug/activity` accepts `documents.type IN ('work_item','page','agent')`. Triggers remain excluded (their event stream is on the Runs tab in Phase 3).

### Structured trigger form

- [x] `components/triggers/trigger-form.tsx` replaces the generic FrontmatterForm in the trigger slideover's Fields tab. *(D6 + D7)*
- [x] Schedule vs event mode toggle. Cron input with live `validateCronShape()` + "next 3 fires" preview. Event-kind dropdown sourced from `KNOWN_EVENT_KINDS`. Filter rows reuse the views filter primitive. *(D5 / D6)*
- [x] JSON payload editor (CodeMirror JSON mode with live validation). *(D6 — implemented as plain textarea with on-change parse + aria-invalid; CodeMirror was not used.)*
- [x] Builtin triggers render the form read-only with a banner; only `Enabled` toggle is interactive. *(D6)*

### Built-in triggers (4 per workspace, auto-seeded)

- [x] On workspace create: seed `builtin-on-assignment`, `builtin-on-mention`, `builtin-on-approval`, `builtin-on-rejection` as workspace-scoped trigger documents. `frontmatter.builtin: true`. The `agent:` field uses `$event.<key>` dynamic resolution syntax. *(D3; D4 backfill script for pre-2.6 workspaces.)*
- [x] Trigger schema accepts `$event.<key>` syntax. Trigger-fire path resolves the reference at fire time. *(D2 — schema-side only; runtime resolution waits on Phase 3 runner.)*
- [x] PATCH on `builtin: true` triggers: only `enabled` mutable; everything else 422 `BUILTIN_TRIGGER_LOCKED`. DELETE: 422. *(D2)*
- [x] Enable-default policy: `builtin-on-assignment` and `builtin-on-mention` ship with `enabled: false` in Phase 2.6 (no runner exists to consume their fires). Their slideover shows a muted "(activates in Phase 3 — agent runner)" banner. Phase 3 migration auto-flips them to `enabled: true`. *(D3 — seeded disabled; slideover banner deferred to E2 polish.)*
- [x] `builtin-on-approval` and `builtin-on-rejection` ship with `enabled: true` (the comment-posting UI surface exists in 2.6; only the runner-resume internal action is stubbed). *(D3)*

### Allow-list reconciler (Phase 2.5 deferral)

- [ ] Background job that periodically sweeps workspace agents' `frontmatter.projects` allow-lists and removes orphan project ids (ids that no longer correspond to a project row).
- [ ] Cron interval set via env `FOLIO_RECONCILER_INTERVAL_MS` (default 1h). In-process timer, no sidecar.
- [ ] Emits `agent.allow_list.reconciled` event when it scrubs any agent. No event on no-op runs.

### Phase 2.6 acceptance

- [ ] Comments primitive: create / list / get / patch / delete via REST + MCP work end-to-end. Soft delete preserves row.
- [ ] Tabbed slideover renders on every existing slideover type with the right tab set.
- [ ] Mention picker filters agents by project allow-list; member list correct.
- [ ] Mention parser detects approval keywords correctly; non-keyword mentions remain `kind=comment`.
- [ ] Workspace agent slideover gets Activity tab with LogActivity wired (Phase 2.5 deferral resolved).
- [x] Structured trigger form replaces the generic FrontmatterForm on triggers; builtin triggers read-only. *(D5–D7)*
- [x] Four builtin triggers auto-seed on workspace create; PATCH/DELETE blocked. *(D2 + D3; D4 backfill for pre-2.6.)*
- [ ] Allow-list reconciler scrubs orphan ids on schedule. *(E1.)*
- [x] Agent-lifecycle MCP tools (`create_agent` / `update_agent` / `delete_agent` / `get_agent_self`) work end-to-end with `agents:write` scope enforcement. *(D8)*
- [ ] All existing user-flow tests still pass — no Phase 2 / 2.5 regression.
- [ ] Commit: `phase-2.6: complete`

---

## Phase 2.7 — Templates (Half-week, optional ordering)

**Goal:** Instance-level Settings page for agent + trigger templates. Workspaces install templates and stay pinned to a specific version; publishing a new template version surfaces an "Update available" banner in the workspace, where the user can review the diff and opt in. **Full MCP exposure** via a new `templates:admin` instance-level scope — meta-agents bootstrap customer instances with the same surface humans use.

> **Why a separate phase:** templates are a distribution mechanism, not a runtime feature. They have their own tables, their own routes, their own UI, their own scope. Carving them out lets the runner (Phase 3) ship without waiting on the templates story, and lets the templates story ship when there's a real "agent worth templating" in production. Either ordering (before or after Phase 3) works.

> **Principle:** everything humans do via UI, agents do via MCP. Templates aren't a walled garden — they're scope-gated like every other resource.

> Spec: `docs/superpowers/specs/2026-05-26-phase-2.7-templates-design.md`.

### Schema

- [ ] Migration `0008_phase_2_7_templates.sql`: three new tables (`template_groups`, `templates`, `template_versions`). Templates are NOT workspace-scoped (instance-level catalog). `templates.template_group_id` is nullable FK → forward-compat for Pack installs (Phase 7+). `template_versions.frontmatter_schema` is optional JSON Schema. New `users.instance_admin` boolean column (default 0; Stefan flips his row via SQL on initial deploy).
- [ ] Optional `template: { id, version }` frontmatter on workspace agent + trigger documents — added to agent + trigger Zod (not enforced; opt-in).
- [ ] New scope `templates:admin` added to `apps/server/src/lib/scopes.ts` (first instance-level scope; workspace tokens cannot have it).
- [ ] New MCP tool group `MCP_TOOL_GROUPS.INSTANCE_ADMIN` in `packages/shared/src/mcp-tool-groups.ts` — filtered out of the default agent-editor tools picker unless editing context has `templates:admin`.

### Routes + middleware

- [ ] `middleware/instance-admin.ts`: `requireInstanceAdmin()` (session must have `users.instance_admin = 1`) + `requireTemplatesAdmin()` (bearer must carry `templates:admin`). Composed for template routes.
- [ ] `routes/templates.ts`: 10 verbs covering list / get / create / patch / delete templates + list / get versions + publish new version + install + promote workspace doc to template. Session auth OR bearer with `templates:admin`.
- [ ] `routes/template-groups.ts`: 4 verbs (list / create / patch / delete) for template groups.
- [ ] `routes/workspace-docs-sync.ts`: `POST /api/v1/workspace-docs/:docId/sync-to-template-version` (admin API for scripted updates; accepts conflict_resolutions) + `POST /api/v1/workspace-docs/:docId/promote-to-template` (extract a workspace doc to a new template + link back).
- [ ] Template versions are immutable once published.

### Schema validation (optional per template)

- [ ] `lib/templates/schema-validate.ts` — JSON Schema (draft 2020-12) validator (ajv-based or equivalent).
- [ ] `lib/templates/schema-derive.ts` — derives starter JSON Schema from a frontmatter snapshot (used by promote-with-lock).
- [ ] `services/documents.ts::updateDocument` branches: if target has `template: { id, version }` AND that version's `frontmatter_schema` is non-null, validate post-patch frontmatter; reject 422 `TEMPLATE_SCHEMA_VIOLATION` with validation errors.

### MCP tools (13 new)

- [ ] `list_templates` / `get_template` (read with `templates:admin`).
- [ ] `create_template` / `update_template` / `publish_template_version` / `delete_template` (mutate with `templates:admin`).
- [ ] `install_template_to_workspace` (creates workspace agent or trigger doc; same path as HTTP install).
- [ ] `update_workspace_doc_to_template_version` (returns `{ document, conflicts }`; caller passes conflict resolutions back on retry).
- [ ] `promote_doc_to_template` (extract a workspace doc to a new template + atomic link back; preserves agent API token).
- [ ] `list_template_groups` / `create_template_group` / `update_template_group` / `delete_template_group` (group CRUD; delete sets group_id to NULL on member templates via FK).
- [ ] All 13 delegate to `services/templates.ts` or `services/template-groups.ts` — same service layer humans hit via HTTP.

### Install + update + events

- [ ] `lib/templates/install.ts` — install a template into a workspace creates a workspace-scoped agent or trigger doc with `template` frontmatter pointing at `{ id, version }`. Agents auto-mint API token (Phase 2.5 cascade).
- [ ] `lib/templates/diff.ts` — pure function: three-way merge between installed-version / current-workspace-doc / target-version. Returns per-key actions (`unchanged | apply_target | preserve_local | conflict`) for frontmatter + body.
- [ ] "Update available" banner in workspace agent + trigger slideovers when their pinned version is < the template's current_version.
- [ ] Update flow: banner → `VersionDiffDialog` shows diff → confirm (with per-conflict resolutions) → workspace doc patched to target version. Returns 409 with conflict list when called without resolutions.
- [ ] Delete-cascade: deleting a template clears `template` frontmatter on every workspace doc carrying that template.id (transactional); emits `template.workspace_doc_orphaned` per affected doc. Workspace docs remain functional.

### Events + SSE

- [ ] New event kinds in `KNOWN_EVENT_KINDS`: `template.created`, `template.updated`, `template.published`, `template.deleted`, `template.installed_to_workspace` (with `source: 'install' | 'promote'`), `template.workspace_doc_updated`, `template.workspace_doc_orphaned`, `template_group.created`, `template_group.updated`, `template_group.deleted`.
- [ ] New instance-scoped SSE endpoint `GET /api/v1/events` — admin-only auth (session OR bearer with `templates:admin`). Workspace tokens reject with 403.
- [ ] Cross-channel emission: workspace-affecting template events (`installed_to_workspace`, `workspace_doc_updated`, `workspace_doc_orphaned`) flow to both the instance SSE and the affected workspace's SSE. Non-workspace events flow only to instance.

### UI

- [ ] `pages/settings-templates.tsx` at `/settings/templates` (no `/w/:wslug/` prefix — instance-level admin route).
- [ ] Two top tabs: Agents · Triggers. Filterable by group. Each row shows template name, group label (if any), current version, workspace-count badge, last-updated, Edit / New version actions.
- [ ] Template editor slideover: Fields · Versions · Activity · Workspaces tabs (no Comments, no Runs — templates don't run, their instances do). Group assignment dropdown in Fields tab.
- [ ] `components/templates/version-diff-dialog.tsx` — markdown body diff + JSON frontmatter diff side-by-side; conflict rows render Keep-yours / Apply-new picker.
- [ ] `components/templates/promote-dialog.tsx` — "Promote to template" dialog accessible from agent + trigger slideover ⋯ menu (visible only with `templates:admin`). Optional "Lock frontmatter shape" toggle adds a starter JSON Schema derived from the doc's current frontmatter.
- [ ] `components/templates/template-groups-section.tsx` — group CRUD on the catalog page.
- [ ] `components/agents/tools-field.tsx` (modified from Phase 2.5) — filter `MCP_TOOL_GROUPS.INSTANCE_ADMIN` based on editing context's scope.
- [ ] `components/frontmatter/frontmatter-form.tsx` (modified) — inline JSON Schema validation when target doc has template + schema; disable save on validation error.

### Phase 2.7 acceptance

- [ ] Create a template via `/settings/templates` → appears in catalog with version 1.
- [ ] Install template into a workspace → workspace agent doc has `template: { id, version: 1 }`; agent token auto-minted.
- [ ] Publish v2 → workspace agent surfaces "Update available" banner.
- [ ] Update workspace agent → diff dialog → confirm → frontmatter + body sync to v2.
- [ ] Workspace-local edits without conflict preserved on update.
- [ ] Conflicting local edits surface diff for manual resolve; nothing overwritten without confirmation.
- [ ] Delete a template with workspace installs → all affected workspace docs orphaned (template frontmatter cleared); workspace docs remain functional; `template.workspace_doc_orphaned` fires per doc.
- [ ] **Promote workspace doc to template** via the ⋯ menu → new template + v1 created → doc linked back → API token preserved → 3 events emit in order.
- [ ] **Schema-validated template** rejects invalid frontmatter PATCH with 422 `TEMPLATE_SCHEMA_VIOLATION`; templates without schema have no validation.
- [ ] **Template groups** CRUD works; templates assignable to groups; deleting a group sets member templates' `template_group_id` to NULL.
- [ ] Full MCP lifecycle reproducible via JSON-RPC: bearer with `templates:admin` creates / publishes / installs / updates / promotes / groups templates end-to-end. Bearer without scope → -32602 on every tool.
- [ ] **`MCP_TOOL_GROUPS.INSTANCE_ADMIN`** filtered out of agent-editor tools picker for non-admin authors; visible to instance-admin sessions / `templates:admin` bearers.
- [ ] Instance SSE endpoint streams `template.*` and `template_group.*` events; cross-channel events flow to affected workspace SSE.
- [ ] Admin-only auth enforced: non-admin session → 403 on template routes; workspace-scoped bearer tokens → 403.
- [ ] Commit: `phase-2.7: complete`

---

## Phase 3 — Agent runner + provider abstraction + runs as documents (Week 5b)

**Goal:** Agents become alive. Provider abstraction with 4 BYOK providers. Runner subscribes (via builtin triggers seeded in Phase 2.6) to assignment + mention + run-document creation; executes against the workspace's configured provider; writes its progress as child comments under the parent doc; transitions runs through the lifecycle state machine; enforces approval gates via the comments thread. Runs are first-class documents (`type: agent_run`) living in a per-project, lazy-seeded runs table — sortable, filterable, savable-as-views like any other table.

> **This is the second v1 spine phase.** Phase 2 built the agent surface; Phase 2.6 built the conversation surface; Phase 3 makes the agents alive.

> Spec: `docs/superpowers/specs/2026-05-26-phase-3-agent-runner-design.md`.

### Data model

> Shipped on `phase-3/agent-runner` as Sub-phase A (2026-05-28). Migration shipped as `0012_phase_3_agent_runs.sql` + `0012a_flip_runner_builtins_to_enabled.sql` — Phase 2.6 took 0007–0011, so the original `0009`/`0009a` tags slid forward. State-machine transitions live in `apps/server/src/lib/agent-run-schema.ts::isValidTransition()` for Sub-phase A; service-layer enforcement lands in Sub-phase C.

- [x] Migration `0012_phase_3_agent_runs.sql`: widen `documents.type` enum to include `agent_run`. CHECK constraint: `type='agent_run' ⇒ workspace_id IS NOT NULL AND project_id IS NOT NULL AND table_id IS NOT NULL AND parent_id IS NOT NULL`. Indexes: `documents_runs_by_parent_idx` (parent_id), `documents_runs_by_status_idx` (table_id, status), `documents_runs_pending_idx` (partial on status='planning' — the poller's claim index), `documents_runs_by_chain_idx` (expression index on json_extract chain_id — for fanout/duration/token aggregation). *(A-2, commit `13c76d8`.)*
- [x] `agent_run` frontmatter Zod: `agent_slug` (required), `provider`, `model`, `tokens_in`, `tokens_out`, `max_tokens`, `trigger_id` (nullable), `chain_id` (uuid; root mints, descendants inherit), `fired_by` (string — chain_id-prefixed trigger chain), `system_prompt` (snapshot), `worker_started_at` (set when poller claims; cleared on terminal), `error_reason` (nullable), `started_at`, `completed_at`. Lives at `apps/server/src/lib/agent-run-schema.ts` (camelCase consts per house style, `.strict()` enforced). *(A-4, commits `02c4564` + fixup `bc4b5ee`.)*
- [x] Status state machine: `planning → awaiting_approval → running → completed | failed | rejected`. `isValidTransition(from, to)` helper + `TERMINAL_STATUSES` constant shipped in `agent-run-schema.ts`. Service-layer enforcement at write-time deferred to Sub-phase C. *(A-4.)*

### Provider abstraction

- [ ] `lib/ai/provider.ts`: `AIProvider` interface (streams `text | tool_call | tokens | done` events) + factory.
- [ ] `lib/ai/anthropic.ts`, `openai.ts`, `openrouter.ts`, `ollama.ts` — all support streaming.
- [ ] `routes/ai.ts`: `POST /api/v1/w/:wslug/ai/test-key` — validates a key with a cheap call without storing.
- [ ] Workspace AI-key UI in `/w/:wslug/settings` — new "AI" tab with provider/model selectors + key input + Test button. Hooks into existing `aiKeys` storage (Phase 0).

### MCP tool dispatch — extract to a callable lib (runner prerequisite)

> **Why this is a hard prerequisite for the runner.** Today `tools/list` + `tools/call` + the `TOOLS` registry + the per-tool scope check live *inline inside the Hono route* (`apps/server/src/routes/mcp.ts:1253-1314`), reachable only via an HTTP request with a bearer-auth'd `token`/`actor`. The runner has **no HTTP request** — it has an `agent_run` row. So when `runAgent`'s loop receives a `tool_call` event it has no function to invoke; the model can talk, but every tool call hits a wall. Lifting dispatch into a shared lib that *both* the route and the runner call is the gate everything else sits behind. Pure extraction — the existing MCP route tests pin the behavior, so a green suite proves the lift is faithful. See `memory/project_folio-agent-thesis.md`: the introspect-and-shape tools that make "set up a project for me" work all flow through this surface.

- [ ] `lib/mcp-dispatch.ts`: extract the `TOOLS` registry + dispatch out of `routes/mcp.ts`. Expose `callTool(token, actor, name, args): Promise<ToolResult>` (the body of `mcp.ts:1272-1313` verbatim — unknown-tool, scope-gate, handler-invoke, error→code mapping) and `listTools(token): ToolDef[]` (**scope-filtered to the token, not the raw static array** — the runner hands the model only the tools its agent is allowed to call).
- [ ] `routes/mcp.ts`: rewire `tools/list` + `tools/call` to call the lib. Route becomes a thin JSON-RPC wrapper; no behavior change. Existing MCP route tests stay green (the pin that proves the extraction is faithful).
- [ ] Confirm the lib's `ToolDef` shape matches the provider layer's `ToolDef` (`lib/ai/provider.ts:18-22`) so `runAgent` can pass `listTools(token)` straight into `provider.stream({ tools })` with no adapter.

### Runner (polling-worker model)

- [ ] `services/agent-runs.ts`: `createRun`, `transitionRun`, `incrementTokens`, `getActiveRun`, `claimNextPlanningRun` (atomic UPDATE-based claim), `recoverOrphanRuns` (boot-time crash recovery), `checkRunRateLimits` (workspace + agent caps), `checkChainGuards` (fanout + duration + tokens by chain_id), `countPendingPlanning` (backpressure visibility). All transactional, all emit events.
- [ ] `lib/poller.ts::startRunnerPoller(db)`: long-lived async loop started in `apps/server/src/index.ts`. Calls `claimNextPlanningRun` every ~1s (configurable via `FOLIO_POLLER_INTERVAL_MS`). Dispatches claimed rows to `runAgent` fire-and-forget. Concurrency capped at `FOLIO_POLLER_CONCURRENCY` (default 5). On boot, calls `recoverOrphanRuns` to flip stale `running` rows to `failed (worker_crash)`.
- [ ] `lib/runner.ts::runAgent(agentRunId)`: called by the poller with a pre-claimed row at `status=running`. Runs pre-flight checks (six guards: depth, fired_by, workspace rate, agent rate, fanout, chain duration+tokens), executes provider call loop, posts comments, transitions to terminal status.
- [ ] `lib/runner.ts::runAgentResume({ runId })`: invoked when a planning row with `frontmatter.resume_of` is claimed. Reads both the original (awaiting_approval) and the new (resuming) rows. Runs with prior plan + approval as message history.
- [ ] `lib/runner.ts::rejectRun({ runId })`: invoked synchronously by the trigger-matcher when `kind=rejection` lands. Transitions the matching awaiting_approval run to `rejected`, posts closing kind=comment from the agent.
- [ ] Runner posts `kind=plan / comment / result / error` comments on the parent doc. Every agent-written comment carries `run_id` in frontmatter.
- [ ] **Six layered recursion guards** enforced as pre-flight checks before the provider call:
  - max_delegation_depth (existing) — linear chain depth.
  - fired_by same-slug rejection (existing) — direct A→A cycles.
  - **Per-workspace run rate cap** — `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE` (default 200). Error: `rate_limited`.
  - **Per-agent run rate cap** — `agent.frontmatter.max_runs_per_hour` (default 60). Error: `rate_limited`.
  - **Fanout cap per chain** — `FOLIO_MAX_FANOUT_PER_CHAIN` (default 25). Counts agent_run rows sharing `chain_id`. Error: `fanout_exceeded`.
  - **Chain duration + token caps** — `FOLIO_MAX_CHAIN_DURATION_MS` (default 30 min) + `FOLIO_MAX_CHAIN_TOKENS` (default 1M). Aggregates over chain_id. Errors: `chain_duration_exceeded`, `chain_tokens_exceeded`.
- [ ] Token budget per-run enforcement: `incrementTokens` checks against `max_tokens` snapshot; over-budget → posts `kind=error budget_exceeded`, transitions to `failed`.
- [ ] No-AI-key path: missing workspace key → run fails with `no_ai_key`, kind=error posted.
- [ ] Cancel via `POST /runs/:id/cancel`: transitions row; next runner iteration detects flip, exits cleanly.
- [ ] Retry via `POST /runs/:id/retry`: inserts a new agent_run row at `status=planning` with original args + `firedBy: retry-of:<old_id>`. Original row preserved. Poller picks up.
- [ ] **Crash recovery.** Server killed mid-run → next boot finds orphan running rows (older than `FOLIO_WORKER_STALE_MS`, default 5 min) via `recoverOrphanRuns`, transitions them to `failed (worker_crash)`, emits `agent.run.failed`.
- [ ] **Backpressure stats** at `GET /api/v1/admin/runner-stats` (admin-only) — pending count, active count, recovered count. Log line emitted when pending > threshold.

### Built-in triggers — wiring (defined in Phase 2.6, activated here)

- [x] Migration `0012a_flip_runner_builtins_to_enabled.sql`: flips `builtin-on-assignment` and `builtin-on-mention` from `enabled: false` to `enabled: true` for every workspace. Idempotent (no-op if already enabled). Companion change in `apps/server/src/lib/builtin-triggers.ts` so newly-created workspaces seed the runner builtins already enabled. *(A-3, commit `d6fd994`. Migration tag shipped as 0012a, not 0009a — Phase 2.6 took 0007–0011.)*
- [ ] `builtin-on-assignment` (`on_event: agent.task.assigned`): trigger handler calls `runAgent` with the assignee.
- [ ] `builtin-on-mention` (`on_event: comment.mentioned`): trigger handler calls `runAgent` with the mentioned agent.
- [ ] `builtin-on-approval` (`on_event: comment.created`, filter `kind=approval`): trigger handler invokes `runAgentResume` for the matching `awaiting_approval` run on `(parent_id, target_agent)`.
- [ ] `builtin-on-rejection` (`on_event: comment.created`, filter `kind=rejection`): trigger handler transitions the matching run to `rejected`, posts a closing `kind=comment` from the agent.

### Approval gate — three channels (consolidated)

- [ ] **Inline button** (UI sugar): `kind=plan` comment renders Approve / Reject. Approve POSTs `kind=approval` with resolved `target_agent`. Reject opens popover with optional reason, POSTs `kind=rejection`. Phase 2.6 buttons now have runner state to act on.
- [ ] **`@`-mention keyword**: typing `@<agent> approved` in a comment → server detects keyword, persists comment as `kind=approval` with `target_agent` resolved. Same flow as button.
- [ ] **MCP**: `create_comment { kind: approval, target_agent }` → same flow.

### Runs as documents — lazy-seeded per-project runs table

- [ ] Runner creates the project's `runs` table on first run (lazy seed). Table comes with default status set + 3 auto-seeded saved views: `All runs` (no filter), `Failures` (`status in {failed, rejected}`), `Awaiting approval` (`status = awaiting_approval`).
- [ ] Runs table renders via the existing spreadsheet UI — columns for status / duration / tokens_in / tokens_out / agent_slug / trigger_id / created_at. Sort, filter, save view all work via Phase 1.5 / 1.6 mechanisms.
- [ ] Manually creating an `agent_run` row in the table via `+ New row` → assignee picker → select agent → save with `status=planning` → builtin-on-assignment fires → runner adopts the row.
- [ ] Drag-to-status from `failed` back to `planning` re-fires the run (effective retry gesture).

### Routes

- [ ] `routes/runs.ts`: `GET /runs/:id`, `POST /runs` (Cmd-K + MCP entry point; creates an `agent_run` doc with `status=planning`), `POST /runs/:id/cancel`, `POST /runs/:id/retry`.
- [ ] New MCP tool `run_agent` (`agents:write`): thin sugar over `POST /runs`. Resolves slugs, validates allow-list, returns `{ run_id, status }`. Idempotency check preserved.

### Events + SSE

- [x] New event kinds: `agent.run.started`, `agent.run.awaiting_approval`, `agent.run.running`, `agent.run.completed`, `agent.run.failed`, `agent.run.rejected`, `ai.action`, `runs_table.lazy_seeded`, `workspace.provider.degraded`, `workspace.provider.recovered`. Added to `KNOWN_EVENT_KINDS` at `packages/shared/src/events.ts`. *(A-1, commit `52439c6`.)*
- [ ] `ai.action` audit event emitted per provider call with `actor_type: 'agent'`, `actor_id: <agent_id>`, `provider`, `model`, `tokens_in`, `tokens_out`. No content stored.
- [ ] New SSE filter params: `?agent=<doc_id>`, `?table=<table_id>`. AND-combined with existing filters.

### Provider-down "Agent Offline" surface

- [ ] `services/agent-runs.ts::checkProviderHealth(workspaceId, provider)` — derived from event history; returns `{ status: 'healthy' | 'degraded', consecutiveFailures }`. Tipping edge emits `workspace.provider.degraded`; first `completed` run after that emits `workspace.provider.recovered`. Cancelled runs excluded from the window. Per `(workspace, provider)`. Threshold via env `FOLIO_PROVIDER_DEGRADE_THRESHOLD` (default 3).
- [ ] `services/agent-runs.ts::getProviderHealth(workspaceId)` — snapshot of all four providers; used by the workspace shell on mount before SSE takes over.
- [ ] `GET /api/v1/w/:wslug/provider-health` — exposes the snapshot. Session auth. No MCP twin (UI-only surface).
- [ ] `transitionRun` calls `checkProviderHealth` on terminal transitions inside the same transaction; emits the degraded/recovered events idempotently (no banner thrash on repeated failures).
- [ ] `components/shell/provider-health-banner.tsx` — workspace-level banner; renders "⚠ Anthropic is unreachable — last N agent runs failed. Agents using Anthropic are paused until it recovers." Provides "Check key" link → `/w/:wslug/settings?tab=ai&provider=<provider>`. Clears on SSE `workspace.provider.recovered`.
- [ ] `components/slideover/agent-slideover.tsx` — when opening an agent whose provider is currently degraded, render inline "Provider currently offline" notice above body.
- [ ] `lib/api/provider-health.ts` — `useProviderHealth(wslug)` hook (one-shot GET + SSE subscription for `workspace.provider.degraded` / `workspace.provider.recovered`).
- [ ] **NOT shipped:** no circuit breaker (runner keeps trying on each new assignment so transient recovery is detected). No retry queue (failed runs do not auto-retry on recovery — user uses existing retry gesture). No per-agent surface (unit is workspace+provider).

### Shared MCP/HTTP dispatcher

- [ ] `lib/mcp-dispatch.ts::executeMcpTool(name, args, authContext)` — single dispatcher shared by `routes/mcp.ts` (HTTP JSON-RPC) and `lib/runner.ts` (runner tool calls). Validates args via Zod, checks scopes, applies `requireResource` allow-list intersection, dispatches to the right service.
- [ ] All existing MCP tool dispatchers (Phase 2 + 2.5 + 2.6 + 2.7) refactored to route through `executeMcpTool` (consistency cleanup landing with this phase).
- [ ] Locked project rule going forward: every new resource operation ships on BOTH HTTP and MCP, sharing a service layer and `executeMcpTool`. Appendix B of the Phase 3 spec maintains the parity table.

### UI — link tiles + Cmd-K

- [ ] Agent slideover's Runs tab is a link tile: `12 runs · view all →` navigates to `/w/:wslug/p/:pslug/t/runs?filter.assignee=agent:<this>`. Per-agent run history through the runs table, not a tab list.
- [ ] Trigger slideover's Runs tab same pattern, filtered by `trigger_id`.
- [ ] Cmd-K palette adds: `Run agent...` (two-step picker: agent → parent → optional input; POSTs new `agent_run` doc), `Approve pending plan` (lists workspace-wide `awaiting_approval` runs, navigates to plan comment).

### Slash commands — DROPPED

- [ ] PHASES.md update: the previous slash-command set (`/draft`, `/decompose`, `/summarize`, `/link`, `/ai`) is dropped. Comment composer's `@`-mention surface is the universal "ask an agent" affordance; agents have richer context and persisted runs.
- [ ] **Kept** as non-AI helper: `[[` wiki-link autocomplete (lands in Phase 2.6 with the comment composer; same picker is wired into the body editor).

### Trigger scheduler + event-pattern matcher

- [ ] `lib/trigger-scheduler.ts`: on server boot, load all enabled triggers with non-null `schedule`. Single in-process cron loop (1-minute tick, SQLite-backed).
- [ ] On schedule fire: create a new `agent_run` row in the trigger's project's runs table with `assignee: agent:<trigger.agent>`, `parent_id` from `trigger.payload.parent_slug` or unset. The on-assignment builtin picks it up.
- [ ] `lib/trigger-matcher.ts` (extended for new event kinds): subscribes to the event bus; on each event scans triggers in the same workspace, applies `event_filter`, fires matches.
- [ ] Fired triggers patch their own frontmatter: `last_fired_at`, `last_status`.
- [ ] Disabled triggers loaded but never fire.
- [ ] On trigger delete: removed from in-memory schedule + subscriber lists in the same transaction.
- [ ] New event kinds: `trigger.fired`, `trigger.failed`.

### Phase 3 acceptance

- [ ] **Polling worker.** Trigger handlers return immediately (no LLM blocking). Poller picks up `planning` rows within ~1s.
- [ ] **Crash recovery.** Killing the server mid-run → next boot recovers orphan runs as `failed (worker_crash)`; agent.run.failed emitted.
- [ ] **Concurrency.** Up to `FOLIO_POLLER_CONCURRENCY` (default 5) runs simultaneously; race-safe atomic claim.
- [ ] Configure Anthropic key → assign a work item to an agent → runner runs → kind=comment + kind=result comments appear on the work item within seconds.
- [ ] `@`-mention an agent in a comment → run fires → comments appear under the parent.
- [ ] Create an `agent_run` row directly in the runs table with `status=planning` and `assignee=agent:<slug>` → runner adopts → run completes.
- [ ] Agent with `requires_approval: true` → kind=plan comment posted, run at `awaiting_approval`. Approve via button → poller picks up new resuming planning row → completes. Reject → original run transitions to `rejected`, agent posts closing note.
- [ ] Approve via `@drafter approved` in a comment → same flow.
- [ ] Approve via MCP `create_comment` → same.
- [ ] **All six recursion guards** enforced:
  - max_delegation_depth violation → `depth_exceeded`.
  - Same-slug `fired_by` cycle → `depth_exceeded` (caught by trigger matcher).
  - Workspace run-rate cap exceeded → `rate_limited`.
  - Per-agent run-rate cap exceeded → `rate_limited`.
  - Fanout > 25 in chain → `fanout_exceeded`.
  - Chain duration > 30 min OR tokens > 1M → `chain_duration_exceeded` / `chain_tokens_exceeded`.
- [ ] Token budget per-run exceeded → `budget_exceeded`.
- [ ] No AI key → `no_ai_key`.
- [ ] Cron trigger set to `* * * * *` → within ~60 seconds an `agent_run` row appears, poller picks up, run completes.
- [ ] Event trigger with filter → fires exactly once per matching event; loop prevention works.
- [ ] Cancel mid-flight run → runner exits within ~1 iteration, no further comments.
- [ ] Retry failed run → new run row at planning, original preserved, completes.
- [ ] Lazy-seed: first run in a fresh project creates the runs table with 3 default saved views.
- [ ] Runs table spreadsheet UI fully functional — sort, filter, column reorder, save view.
- [ ] **Chain_id tracking.** Every agent_run row has chain_id. Root mints fresh uuid. Descendants inherit.
- [ ] MCP `run_agent` returns `run_id`, SSE stream shows transitions.
- [ ] **Backpressure visible.** `GET /api/v1/admin/runner-stats` returns stats; log line on high pending count.
- [ ] **Agent Offline banner.** With provider stubbed to always fail, the workspace banner appears after N consecutive `provider_error` failures (default 3); one successful run clears it. Per provider (Anthropic degraded ≠ OpenAI degraded). Cancelled runs excluded from the window.
- [ ] All existing user-flow tests still pass — no Phase 2 / 2.5 / 2.6 regression.
- [ ] Commit: `phase-3: complete`

---

## Phase 3.5 — Script & webhook trigger actions (Half-week)

**Goal:** A trigger today must fire an agent (`agent` is a required field in `apps/server/src/lib/trigger-schema.ts`). Open the action surface so triggers can also POST to a webhook URL or run a script, for cases where the user wants automation without an LLM in the loop.

> **Why:** cron-style "POST this URL every Monday" or "run this shell snippet when a doc flips to Done" is operational glue most teams want before they're ready to trust an agent. Webhooks are cheap, sandbox-free, and stay inside Folio's existing event model. Scripts are powerful but security-loaded — gated behind an env flag, off by default.

### Schema

- [ ] In `apps/server/src/lib/trigger-schema.ts`, replace the required `agent` field with a discriminated `action` union: `{ type: 'agent', agent: slug }` | `{ type: 'webhook', url, method?, headers?, body? }` | `{ type: 'script', command, cwd?, env?, timeout_ms? }`
- [ ] Keep the existing `agent: <slug>` shorthand parsing for back-compat — normalize it to `action: { type: 'agent', agent: <slug> }` on read
- [ ] Add a Zod validator per action type; reject mixed/legacy shapes with `code: invalid_form_input`
- [ ] Migration is in-place (frontmatter only — no schema change)

### Runner

- [ ] Extend the Phase 3 trigger firing loop in `apps/server/src/services/trigger-runner.ts` (or wherever it lands) with a per-type dispatcher
- [ ] `webhook` dispatcher: outbound POST via `fetch`, 10s default timeout, retries piggyback on the existing webhook retry queue, emit `trigger.fired` + `trigger.failed`
- [ ] `script` dispatcher: `Bun.spawn`, capture stdout/stderr (cap at 64 KB), enforce `timeout_ms` (default 30s, max 5 min), kill on overflow
- [ ] Script execution is OFF unless `FOLIO_ALLOW_SCRIPT_TRIGGERS=1` is set in the server env — when off, validation accepts the doc but the runner emits `trigger.skipped` with reason `scripts_disabled`
- [ ] Audit log entry per fire in `trigger_runs` (existing table)

### UI

- [ ] Trigger slideover gets an "Action" segmented control (Agent / Webhook / Script) — the right-hand panel swaps between agent picker, URL+headers editor, and command editor
- [ ] Script action shows a warning banner + a link to the env flag docs when scripts are disabled server-side
- [ ] Run history panel renders webhook response code + script exit code

### Phase 3.5 acceptance

- [ ] Existing `agent:`-only triggers still fire after the schema change (back-compat regression test)
- [ ] Create a cron trigger with `action.type = webhook` pointing at a local echo endpoint; within ~60s the endpoint is hit and `trigger.fired` is emitted
- [ ] Create a cron trigger with `action.type = script` while `FOLIO_ALLOW_SCRIPT_TRIGGERS` is unset → runner emits `trigger.skipped` (`scripts_disabled`); set the flag and re-run → the script executes and stdout is captured
- [ ] Script that exceeds `timeout_ms` is killed and reports `trigger.failed` with reason `timeout`
- [ ] Commit: `phase-3.5: complete`

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

### Performance polish

> Server pagination + indexes already scale to 10k+ rows; the table UI is the bottleneck. Goal: a single table with 10k rows scrolls smoothly and filters/sorts return in < 100ms.

- [ ] Row virtualization in `apps/web/src/components/table-view.tsx` (~line 457 — replace `filteredDocs.map(...)` with `@tanstack/react-virtual`'s `useVirtualizer`, ~15 visible + overscan)
- [ ] Push `priority` + `labels` filtering server-side in `apps/server/src/routes/documents.ts` (today they filter client-side on the fetched page only — see `apps/web/src/lib/api/documents.ts:237` and `apps/server/src/routes/documents.ts:226`)
- [ ] Infinite scroll / "load more" wired through TanStack Query's `useInfiniteQuery` so the table can grow past one page without re-fetching from scratch
- [ ] Add covering index on `(table_id, status)` if status filtering stays the dominant filter after 1.5/1.7 usage
- [ ] Smoke test: seed 10k documents into one table, assert initial paint < 500ms and scroll stays at 60fps

### Playwright

- [ ] Install Playwright in `apps/web/tests/e2e/` *(shipped in Phase 1)*
- [ ] One e2e test per UX commitment
- [ ] CI runs Playwright headlessly (later — local for now)

### Phase 7 acceptance

- [ ] All six UX commitments pass Playwright
- [ ] Dark mode looks good on every screen
- [ ] Webhook + sync admin screens shipped and tested
- [ ] 10k-row table scrolls smoothly; server-side filtering covers every visible filter chip
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
