# Folio — Decisions

_Last updated: 2026-05-24 (post Phase 2B)_

Architectural and product decisions that are locked. Re-litigating any of these requires explicit "I want to revisit X" from Stefan. CLAUDE.md has the briefer "Decisions Already Made" list; this file is the longer-form record with reasoning.

For the originating PRD: `docs/FOLIO-BRIEFING.md`. For phase-level commitments: `docs/PHASES.md`.

---

## Stack

- **Runtime:** Bun, latest stable.
- **Backend:** Hono.
- **ORM:** Drizzle.
- **DB:** SQLite for v1. Postgres compatibility via env toggle deferred to v1.1.
- **Frontend:** React + Vite + TanStack Router.
- **Styling:** Tailwind + shadcn/ui (Dialog, Sheet, Popover, Command, Toast); bespoke primitives for Button/Pill/Avatar/etc.
- **MD body editor:** Milkdown (real round-trip).
- **Raw MD editor:** CodeMirror 6.
- **Drag-drop:** dnd-kit.
- **Encryption:** libsodium for AI-key storage.
- **Tests:** Vitest + RTL (web), Bun test (server), Playwright in Phase 4+.
- **Lint/format:** Biome.
- **Auth:** Hand-rolled session + magic-link. No NextAuth, no Auth0, no SSO/OIDC in v1.
- **License:** MIT.

## Architecture

- **One binary.** `bun build --compile` ships a single executable serving API + static React. No sidecar services, no Redis, no separate worker.
- **SQLite for queues** if queues are ever needed (cron table + interval polling). Stays inside the one-binary commitment.
- **Frontmatter is the schema.** Only `title`, `status`, `body` are columns on `documents`. Everything else lives in `documents.frontmatter` JSON column. UI infers type from values; per-project `fields` table pins types explicitly.
- **Every write emits an event.** Inserts to `events` table + pushes to SSE on the same transaction. Agents subscribe to this. Never bypass.
- **BYOK only.** Server never holds a default AI key. Workspaces without a key configured hide AI features.
- **Multi-tenancy is out of scope.** One instance = one team. Workspaces live inside an instance.

## v1 scope inclusions & exclusions

- **In:** Phase 1.5 (timeline view + This Week dashboard) added 2026-05-12.
- **In:** Trigger-documents (cron + event automation) added 2026-05-12.
- **In:** Phase 2A-D — tables-and-views (NocoDB-style) added 2026-05-24. Project owns multiple **tables**; each table owns its own statuses/fields/views/work-items; views are saved filter + columns + sort + render mode bound to a table.
- **Out for v1:** Full-text search (sqlite-fts5 → v1.1), vector search, Postgres, email notifications, per-project ACLs, calendar/gantt, public sharing, plugin API, webhooks, mobile PWA.
- **Out for v1:** Real-time collab on a single document. Last-write-wins with `updated_at` check is the v1 model.
- **Out for v1:** Comments, attachments.

## Phase 2A — Tables as first-class concept (2026-05-24)

- Projects own one or more **tables**. Statuses, fields, views, and `work_item` documents belong to a table, not directly to a project.
- Wiki pages stay project-scoped (`documents.table_id IS NULL` for `type = 'page'`). Pages are NOT inside any table.
- Routes nested as `/api/v1/w/:ws/p/:p/t/:tslug/{documents,statuses,fields,views}`. Legacy `/p/:pslug/{...}` routes still work — `resolveProject` attaches the project's default `work-items` table when no `:tslug` is in the path (unconditional lookup; `resolveTable` overwrites on explicit-table mounts).
- One default table per project: slug `work-items`, name `Work Items`, icon null. Auto-created on project creation by `seedProjectDefaults` (which returns `{ tableId }`).
- FK cascades: `statuses/fields/views.tableId → tables.id ON DELETE CASCADE` (config is meaningless without its table). `documents.tableId → tables.id ON DELETE SET NULL` (markdown documents are source of truth — orphan them, don't delete).
- Table slug is **immutable** after creation (PATCH /tables/:tslug strips `slug` from the body via Zod). Renaming would silently invalidate every URL pointing at the table's children.
- Migration `0003_phase_2a_tables.sql` handles populated DBs via: (1) create `tables`; (2) ADD nullable `table_id` columns; (3) INSERT a default `Work Items` table per project; (4) backfill all FKs; (5) rebuild statuses/fields/views with NOT NULL `table_id` via SQLite's CREATE+COPY+DROP+RENAME idiom. Documents stays nullable.
- Row type for `tables` is exported as `TableEntity` (not `Table` — collides with DOM `HTMLTableElement` and any future shadcn `<Table>`).
- Test harness `makeTestApp({ seedProjectDefaults: true })` is the **default** as of Phase 2A — every test gets a default table unless it opts out with `seedProjectDefaults: false`. This matches production behavior (POST /projects always creates one).

## UI / UX

- **Cmd-K palette** is the universal command surface. Every primary action must be reachable from it.
- **Inline editing** everywhere — no "Edit" buttons.
- **Slideovers, not modals,** for document detail. List stays visible behind.
- **Optimistic writes** by default. Rollback on failure with a toast.
- **Slash commands** in the body editor for v1: `/draft`, `/decompose`, `/summarize`, `/link`, `/ai`.
- **Copy-as-MD** on right-click of any row or document.

## Design system

- **Tokens-only.** No raw hex outside `tokens.css`. Alpha-overlay rgba lives near its single component OR is promoted to a token when used 2+ times with a clear semantic family.
- **Focus styling.** Two patterns, named:
  - Non-bordered focusables → base `*:focus-visible` rule (single 1.5px subtle ring via `--ring`).
  - Bordered inputs → `.input-focus` utility (darkens border to `fg-3`, lifts bg to `card`, no ring overlay).
  Do not stack ring + border on bordered inputs.
- **Bespoke primitives** live in `components/ui/`. shadcn primitives only for radix-backed components (Dialog, Sheet, Popover, Command, Toast).

## Conventions

- **TypeScript strict everywhere.** No `any` — use `unknown` and narrow.
- **No default exports** except for routers and React route components.
- **Files** `kebab-case.ts`. **Types/components** `PascalCase`. **Functions/vars** `camelCase`. **DB columns** `snake_case`. **Frontmatter keys** `snake_case`.
- **IDs** UUIDv7 stored as text.
- **Errors** thrown as Hono `HTTPException`; server returns `{ error: { code, message } }`; client surfaces via toasts.
- **Validation** via Zod schemas at API boundaries, shared in `packages/shared/`.
- **Imports** use `@/` aliases per app; no deep relative paths.
- **Commits** `phase-N: <what>` for phase work; `fix:` / `chore:` / `docs:` otherwise. Atomic per task.

## Phase 2B — Spreadsheet table UI (2026-05-24)

- **Column model is derived, not stored.** Built-in columns (`title`, `status`, `updated_at`) plus one column per pinned `fields` row. No `columns` table — fields ARE the schema.
- **View owns visibility + order**, not the table or the user. `views.visibleFields` (string[]) + `views.columnOrder` (string[] | null). Width is per-user only (localStorage, not in DB) — width is a UI preference, not a data property.
- **Empty / null `visibleFields` falls back to built-ins** (`['title', 'status', 'updated_at']`). A view with `columnOrder = null` uses default order (built-ins first, then fields by `fields.order` asc).
- **Currency field type**: stored as a plain number in frontmatter; `fields.options` carries a single ISO-4217 code (e.g. `["EUR"]`); rendered right-aligned via `Intl.NumberFormat`. Formatter cached per-code at module level for table-row perf.
- **Drag-reorder columns** via `@dnd-kit/sortable` + `horizontalListSortingStrategy`. Whole header is the drag handle (no separate grip icon for v1); PointerSensor `distance: 5` distinguishes click from drag.
- **Sortable columns**: only built-ins (`title`, `status`, `updated_at`) get a click-to-sort UI for v1. Sorting on frontmatter fields is a server-side concern deferred to Phase 2C+.
- **The shared `TABLE_GRID_TEMPLATE` const** in `columns.ts` keeps TableHeader and TableRow grid columns aligned. Don't inline the template; always import.
- **TableRow sends minimal frontmatter patches** (`{ frontmatter: { [key]: next } }` — server merges per-key at `documents.ts:308`). Don't spread `doc.frontmatter` — race against concurrent sibling edits.
- **DB-level CHECK constraint on `fields.type`** (added in migration 0004): when adding a new field type in the future, BOTH the Drizzle TS enum AND the SQL CHECK clause must be updated — Drizzle's enum is TS-only otherwise. Sets a precedent for other type-like fields (`statuses.category`, `views.type`) that are TS-only today.
- **Default seeded view** (`seed-project-defaults.ts`): `visibleFields: ['title', 'status', 'priority', 'assignee', 'due_date', 'updated_at']`. Built-ins always shown by default; the rest are the standard "agency" fields. User can hide any via the column picker.
- **`relativeTime` extracted to `apps/web/src/lib/relative-time.ts`** so TableCell and list-row share one implementation while both exist (list-row + kanban will eventually consume TableView render-mode in Phase 2D).
