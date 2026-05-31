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

## Phase 2.5 — Agent scope model (2026-05-26)

Locked after a research round across GitHub Apps, Slack, Linear, Notion, MCP spec, Cloudflare/AWS/Vercel tokens, macaroons/biscuits, and ReBAC systems. Decisions are durable; UI is allowed to evolve.

- **Agents live at workspace level. Period.** No project-scoped agent variant. `documents.workspace_id` is the home; `documents.project_id` is `NULL` for `type IN ('agent','trigger')`. Existing Phase 2 agents migrate to workspace-scoped with their old project's slug captured in `frontmatter.projects`.
- **Project binding is frontmatter, not schema.** Agent + trigger frontmatter gains `projects: string[]` — either `['*']` (all projects in workspace) or an explicit allow-list of project slugs. Notion-style default-deny philosophy: `[]` means zero, only `['*']` opts into all.
- **Principal vs credential are separated** (GitHub Apps three-layer model). The agent document is the durable identity. The `api_tokens` row is a short-livable credential that references the agent and inherits its grant. Tokens may narrow but never broaden the agent's bounds.
- **Action-scope and resource-scope are orthogonal in middleware.** Existing `requireScope('documents:write')` checks the verb. New `requireResource(req → {workspace_id, project_id})` check intersects the URL's project against the agent's `projects:` allow-list on every request. Never merge into a single `documents:write:project:abc`-style string.
- **Live re-eval per request, not stateless JWT.** Token stays opaque, hashed in DB. Auth lookup pulls the agent row and computes effective bounds. Revocation = flip `revoked_at`, next request dies. Cheap because the auth DB IS the data DB.
- **Tokens carry `agent_id` + optional `project_ids` (narrowing only).** On request, effective allow-list = `intersect(agent.frontmatter.projects, token.project_ids ?? '*')`. Token can be down-scoped for a specific deployment without modifying the agent.
- **Agent templates live at instance level**, in `Settings → Agent Templates`. Inert markdown files (no token, no permissions, no events). Instances reference a template via `frontmatter.template: <slug>` and `frontmatter.template_version: N` (pinned). Sync is explicit — instance shows "Update available" when template advances; user opts in per instance.
- **Template body is read-only on instances. Only `frontmatter.additional_instructions` is editable on the instance.** Effective prompt at runtime = `template.system_prompt + "\n\n" + additional_instructions`. Keeps sync trivial and the markdown-as-truth wedge intact.
- **Templates can be MCP-created.** `create_template`, `update_template`, `delete_template`, `list_templates`, `get_template` are first-class MCP tools alongside `create_agent`, `update_agent`. Agent-first means agents can author templates that bootstrap more agents.
- **Templates are NOT a foreign-key dependency.** Deleting a template detaches its instances (their last-synced prompt body inlines into their own frontmatter as `system_prompt`). The `template:` reference is metadata, not a constraint. Markdown-as-truth survives template deletion.
- **One-off agents are still legitimate** — just create an agent without `frontmatter.template`. Workspace-scoped with `projects: ['<one>']` is identical in capability to a project-scoped agent. No UI variant needed.
- **UI surface moves out of the project rail.** Agents + Triggers leaves are removed from each project. Workspace header gains `Agents · Triggers · Settings · ⌘K`. Workspace agents page (`/w/:wslug/agents`) lists all agents with `projects:` shown as chips; filter by project chip to see "agents that touch project X."
- **Assignee picker queries workspace agents filtered by the URL's project.** Picker shows only agents whose `projects:` allow-list includes the current project (or `'*'`).
- **What we explicitly rejected:**
  - Macaroons / Biscuit (Fly.io's "users don't attenuate in practice" finding kills the win on a single-binary deploy).
  - SpiceDB / OpenFGA / ReBAC (violates "no sidecar services"; Folio's permission shape is a flat allow-list, not a graph).
  - Cross-workspace agent identity (workspace-as-tenant invariant cracks; templates cover the "edit once" workflow without breaking it).
  - Project-scoped agent variant living alongside workspace-scoped (two mental models; nothing project-scoped does that workspace-scoped-with-allow-list doesn't do identically).
  - Merging action + resource into one scope string (combinatorial blow-up; AWS/Cloudflare/GCP independently converged on keeping them orthogonal).

## Phase 2.6 — Comments + tabbed slideover + trigger form + builtins + reconciler (2026-05-27)

Five sub-phases (A comments core, B MCP comment tools, C tabbed slideover + UI, D structured trigger form + builtins + MCP agent-lifecycle, E reconciler + acceptance). Decisions locked during execution that future sessions should respect:

- **Comment kind is immutable; `target_agent` is bound to creation-time intent.** Editing the body of a `kind=approval` comment does NOT recompute `target_agent`. The pin test `updateComment on kind=approval does NOT recompute target_agent on body change` exists for exactly this — removing it signals you've lifted the deferral. Reasoning: kind is immutable already, target_agent is what kind+author meant at submit time; recomputing on edit creates a "moving target" UX problem and ambiguous resume semantics for Phase 3's runner.
- **Approval-keyword detection grammar** (parseMentions): position-1 unconditional match for one of `{approved, approve, rejected, reject, lgtm, ship, blocked, blocks}`; position-2 only when position-1 is a copula or auxiliary (`is, was, are, were, been, be, has, have, had, got, gets, just`). Trailing punctuation `[.,!;]?`. English-only. Documented in `docs/AGENTS.md`.
- **WikiLinkPicker scope is the current project only.** Cross-project listing would need a new endpoint; deferred. The wedge here is keyboard-fast, not encyclopedic — most cross-project linking goes via copy-paste of the full slug.
- **Slideover Activity tab uses sibling components for workspace docs**: `workspace-activity-panel.tsx` + `workspace-log-activity-button.tsx` rather than conditional `pslug?` on the project-scoped components. Keeps the two paths visually identical without smuggling optional props into every callsite.
- **Builtin trigger lock is server-enforced via `BUILTIN_TRIGGER_LOCKED`** in `updateDocument`/`deleteDocument`. The error fires before schema-partial validation. Only `frontmatter.enabled` is mutable on a builtin. UI mirrors this with a read-only banner + per-input disabled state.
- **`$event.<key>` dynamic agent resolution is frontmatter syntax, not a server-side feature yet.** The schema accepts the pattern; Phase 3's runner does the resolution at fire time. Documenting today means agents can be configured before the runner exists.
- **Builtin triggers are auto-seeded inside the workspace-create transaction** in `routes/workspaces.ts` rather than refactoring workspace create into a service. The seed helper lives in `apps/server/src/lib/builtin-triggers.ts` and is reused by D4's backfill script. A future refactor may extract `services/workspaces.ts::createWorkspace` but it's not blocking.
- **Backfill script emits `document.created` events** rather than raw-inserting silently (spec §9 option 1). Slower but consistent — the SSE bus sees the restoration, agents subscribed to `document.created` can react. The script is idempotent at slug-collision level: re-runs no-op once all 4 builtins are present.
- **`KNOWN_EVENT_KINDS` + `EventKind` relocated to `packages/shared/src/events.ts`** during D6. Server `apps/server/src/lib/events.ts` and `trigger-schema.ts` re-export for source-compat. Same pattern as D1's `validateCronShape` relocation. Justification: web UI needs the const for the event-kind dropdown.
- **`validateCronShape` + new `nextFires` live in `packages/shared/src/cron.ts`** (relocated in D1 from server). Web `cron-input` consumes both directly. No npm cron lib — minimal 5-field UTC parser implemented in-tree.
- **TriggerForm is controlled (value/onChange), wrapped by `TriggerFieldsTabPane` in the slideover** with a local draft + Save button. This deviates from FrontmatterForm's inline-commit-per-field pattern — the trigger form has too many interlocking fields (mode toggle invalidates other fields) for per-field commit to be coherent. Save button fires diff'd `onPatch` calls.
- **JSON payload editor uses plain `<textarea>` in v1, not CodeMirror.** Spec mentioned CodeMirror+lang-json but the dependency weight isn't worth it for a single-field editor; live `JSON.parse` + `aria-invalid` covers the v1 need. Swap to CodeMirror later if validation rich-formatting becomes important.
- **`agents:write` is a token-scope, separate from `documents:write`.** Granting the holder the ability to spawn/mutate other agents is a privileged op — treated with the same caution as `documents:delete`. `toolsToScopes` maps `create_agent`/`update_agent`/`delete_agent` → `agents:write`; `get_agent_self` is `documents:read` (an agent reading its own row is metadata, not a privileged op).
- **MCP allow-list widening is rejected for agent-bound callers.** When a calling agent updates another agent's `frontmatter.projects`, the new list cannot contain any id not in the calling agent's own allow-list. User-minted PATs (no `agent_id` binding) can widen freely — they have explicit operator authority.
- **MCP self-delete is rejected.** Agents cannot delete themselves via the API. Deleting an agent from inside its own runtime would invalidate the bearer token mid-request and crash the runner; route operators do that via the UI or HTTP DELETE as session-authed admins.
- **Reconciler is a background `setInterval`, not a cron table.** Default interval 1 hour, env-overridable down to 60s minimum. Skipped in `NODE_ENV=test`. Insurance against bugs in the project-delete cascade hook + hand-edited markdown + partial restore-from-backup. Emits `agent.allow_list.reconciled` per scrubbed agent so observers (UI, logs, agents) can see drift was corrected.
- **Reconciler skips wildcard agents and malformed frontmatter.** Wildcards mean "all projects in workspace" — no membership to reconcile. Malformed allow-lists (non-array, non-string members) are left alone rather than overwritten — operator intervention required.

### Phase 2.6 deferrals (parked, not blocking merge)

- **SSE consumer in `CommentsTab`** — Phase 2.6 ships react-query invalidation only; live updates from other users/agents wait for a future ticket. Lost-write UX surfaces only when two humans race on the same comment, which today is rare enough to defer.
- **Document locking on slideover** — paired with the SSE deferral. Last-write-wins via `updated_at` check is the v1 model.
- **8 Playwright TODOs from sub-phase C** — jsdom-deferred behaviors (`@` typing actually opens MentionPicker positioned at caret, `[[` actually opens WikiLinkPicker, picker `onSelect` replaces tokens, focus return). Carried to shake-out OR a follow-up Playwright spec.
- **Real markdown rendering on `CommentRow`** — v1 uses plaintext-with-inline-substitution for mentions + wiki-links. Full markdown rendering (lists, code blocks, formatting) is a polish ticket.
- **`comment.updated` event** — spec did not require one; intentionally absent.
- **Pagination cursor on `listComments`** — "Load more" button renders when `length >= 50` but is inert. Real cursor pagination deferred to Phase 7.
- **Bulk-export of agents/triggers + workspace-scoped `.md` export endpoint** — Phase 7 polish.
- **Approval-comment PATCH `target_agent` recompute** — permanently deferred via the pinning test (see top of this section).
- **`(activates in Phase 3)` banner on builtin-on-assignment / builtin-on-mention** — generic "Builtin" banner is what ships; the Phase-3-activation note is shake-out polish.

## Phase 3 Sub-phase E — Web realtime: ship the SSE client (2026-05-30)

- **The Phase-2.6 "SSE consumer" deferral is LIFTED in Sub-phase E.** Decision (Stefan, 2026-05-30): build the browser-side SSE client — option **A** (push), explicitly scoped to "**don't over-engineer**." Runs lifecycle, provider health, and reactor-halt banners update live; the comments-tab `// when SSE ships` TODO is resolved as a side effect.
- **Why this is small, not infrastructure:** the server half is already complete and load-bearing for the reaction plane — `lib/event-bus.ts` (in-proc pub/sub), `routes/events.ts` (`streamSSE`, `Last-Event-Id` replay, `?project/?parent/?run/?agent/?table` filters, all AND-combined), `lib/agent-event-visibility.ts` (per-bearer gate). D-7 added `?agent=`(slug)/`?table=`(id) specifically for E. The only gap was a browser consumer. So A = "connect the one wire the server is already waving," not "build realtime."
- **The minimal shape (anti-over-engineering guardrails):**
  - ONE reusable hook (`apps/web/src/lib/api/event-stream.ts`, `useEventStream(path, { onEvent })` or similar). Native `EventSource`. No socket lib, no Redis, no client-side event store.
  - **Auth = cookies, automatic.** The API client uses `credentials: 'include'` (cookie session); native `EventSource` sends same-origin cookies on its own. No token threading, no Authorization header (EventSource can't set one anyway). Same-origin relative paths (`/api/v1/w/:wslug/.../events?...`).
  - **SSE invalidates react-query; it does NOT become a second source of truth.** On message → `queryClient.invalidateQueries(...)` (or a targeted setQueryData for the run row). react-query stays the cache/store; SSE is just the "something changed, refetch" signal. This keeps optimistic writes + existing hooks untouched and avoids a parallel state tree.
  - Reconnect: rely on `EventSource`'s built-in auto-reconnect + `Last-Event-Id` (server already supports replay). Don't hand-roll backoff in v1.
  - Clean up the `EventSource` on unmount (effect teardown). One connection per subscribing surface is fine for v1 volume; a shared/multiplexed singleton is a later optimization only if connection count becomes real.
- **What we explicitly did NOT do:** option C (hybrid SSE-for-banners-only — two realtime models = more overhead than one), a websocket upgrade (SSE is sufficient and stays within "one binary, no sidecars"), document locking (still deferred — last-write-wins via `updated_at` holds), a global client event store / event-sourcing on the web side.
- **Supersedes** the `[[realtime-and-locking-deferred]]` memory for the *consumer* half. Document locking remains deferred.

## Phase 3.x — Relation fields + backlinks (2026-05-31)

Shipped on `phase-3.x/board-view`. Closes the highest-leverage gap from the Airtable template analysis (linked records — the one primitive universal to all 7 sampled templates). Design: `docs/superpowers/specs/2026-05-31-relation-fields-and-backlinks-design.md`; plan: `docs/superpowers/plans/2026-05-31-relation-fields-and-backlinks.md`. Scope was deliberately **links + backlinks only** — lookups/rollups/formulas explicitly cut (backlog: `docs/superpowers/specs/2026-05-31-airtable-gap-backlog.md`).

- **`relation` is the pinned, targeted upgrade of `document_ref`.** Both store the SAME frontmatter shape — `"[[slug]]"` (single) or `["[[slug]]", …]` (multi). So there is no data migration; `relation` is opt-in per field. An unpinned bare `[[slug]]` still infers as `document_ref` (plain text). Pinning a field to `relation` is what unlocks target scoping + the typed picker + backlink participation.
- **Target + cardinality live in the existing `fields.options` JSON array:** `options[0]` = `"wiki"` or `"table:<table_id>"`; `options[1]` = `"single"` or `"multi"`. Validated server-side in `routes/fields.ts::validateOptions` (covers both POST and PATCH via the shared helper). No new `documents` columns, no link table.
- **Backlinks are query-time only — never stored.** `services/backlinks.ts::findBacklinks` scans `documents.frontmatter` via SQLite `json_each`, matching the `[[slug]]` token as a top-level string value OR an array element. Exposed at `GET …/documents/:slug/backlinks` (added to the existing `documentsRoute`, so it inherits scope middleware at both pScope and tScope mounts). Links live only in frontmatter (source of truth), so backlinks can't drift — no reconciler. Started without an index; add an expression index only if the reverse scan profiles hot.
- **`work_item` / `page` slugs are IMMUTABLE ONCE NAMED, with ONE placeholder exception** (extends the table/agent/trigger precedent). A retitle never moves the slug of a *named* doc — so `[[slug]]` links stay valid forever, no rename cascade. **Exception (added 2026-05-31, post-merge fix):** a doc still on its create-time `untitled` / `untitled-N` placeholder slug adopts its FIRST real title as its permanent slug, then freezes. WHY: every "New work item" / "New page" seeds `title: 'Untitled'` and creates the doc BEFORE the user names it (create-then-rename-inline), so pure immutability froze every doc at `untitled`/`untitled-2`/…. The single policy lives in `services/documents.ts::maybeReslugPlaceholder` (self-guarding: re-slugs only when the CURRENT slug is a placeholder AND the new title isn't itself a placeholder); called by BOTH the JSON service path and the markdown-PATCH route. `isSlugAutoDerived` + the old broad `maybeRegenerateSlug` stay removed. Pinned by tests in `documents.test.ts`: `retitling a work_item does NOT change its slug` (named→immutable) + `retitling an UNTITLED placeholder DOES re-slug (first real name wins, once)` + the `untitled-N` collision case. Verified live via HTTP.
- **Dangling relations render unresolved, never auto-stripped.** A `[[slug]]` whose target is deleted renders struck-through (`RelationCell`); the frontmatter string is left untouched (don't mutate other docs' source-of-truth on a delete). Self-heals if the slug returns.
- **Editing is slideover-only for v1; table cells are read-only chips.** Relation editing (picker, add/remove, single+multi) lives in the slideover via `frontmatter-form.tsx` (which has `wslug`/`pslug` + can fetch candidate docs). In the table, `FieldRenderer`'s relation case falls back to a read-only `RelationCell` when no candidates are passed. Inline table-editing of relations is deferred — not a wedge regression, just scope.
- **Adding a field type touches BOTH the Drizzle enum AND the SQL CHECK** (migration `0019_relation_field_type.sql`, table-rebuild idiom matching 0004). Reaffirms the Phase 2B precedent. NOTE: there are THREE `FieldType` definitions — server `lib/field-type-change.ts` (validation source of truth), web `lib/api/fields.ts`, shared `index.ts` (was stale, missing `currency` — brought current here). Keep all three in sync.
