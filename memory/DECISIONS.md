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
- **BYOK only.** Server never holds a default AI key. AI keys are INSTANCE-level (one store, resolved by `(provider, ai_key_label)`, admin-gated at `/instance/ai-keys`) — NOT per-workspace (the `ai_keys.workspace_id` column was dropped). If no key is configured, AI features hide.
- **Multi-tenancy is out of scope. One instance = one team.** **Workspaces are ORGANIZATIONAL FOLDERS, not a security/tenancy boundary (drop-workspace-tenancy refactor, 2026-06):** the `memberships` table + the `__system` reserved workspace were DROPPED. Instance authority = `users.role` (owner/admin/member); per-workspace/project visibility = invitation-based `workspace_access`/`project_access` grants, decided in `lib/access.ts` (single convergence point, invariant 4a). The operator is a code runtime singleton (`_operator`), not a seeded doc. Skills live in `instance_skills` (typed `trusted` column). Agents resolve by slug instance-wide; execution bounded by project ceiling + caller authority. **This SUPERSEDES the earlier "agents live at workspace level / workspace-as-tenant" decisions below** (the cross-workspace-agent-identity exclusion is now the intended model, not a cracked invariant).

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

## Phase 3.x — Agent management vs. interaction (2026-05-31)

Web-only IA split, shipped on `phase-3.x/agents-page`. Root cause it fixes: the agent cockpit panel conflated *managing* agents (the `agents` screen) with *interacting* with them (run/activity), so agents felt panel-bound rather than workspace-owned, and configuring an agent inside an interaction panel was awkward. Design `docs/superpowers/specs/2026-05-31-agent-management-vs-interaction-design.md`, plan `…/plans/2026-05-31-agent-management-vs-interaction.md`.

- **Management → a page.** A combined **`/w/:wslug/agents`** page with **Agents | Triggers** tabs (`?tab=`), both workspace-scoped automation documents under one destination (reinforces workspace-scoping). `WorkspaceAutomationPage` wraps `WorkspaceAgentsTab` (new — list w/ provider·model + projects chips) + the slimmed `WorkspaceTriggersPage` (its outer page chrome was dropped so it nests as a tab body; its two `navigate` targets now point at `/w/:wslug/agents`).
- **`/w/:wslug/triggers` redirects** to `/w/:wslug/agents?tab=triggers` (`beforeLoad` throw redirect). Old bookmarks still land right.
- **Editing uses the existing `?wdoc=` slideover** — unchanged. The page (and tabs) open it via `?wdoc=<slug>` on the current route. `?wdoc=` stays distinct from the project DocumentSlideover's `?doc=`.
- **The cockpit panel is interaction-only.** `AgentPanelScreen` dropped `'agents'` (now `'activity' | 'run'`); `agent-panel/agent-list.tsx` + its test were DELETED (logic moved to `views/workspace-agents-tab.tsx`). The panel = give work + watch + results.
- **Nav: two distinct destinations.** Workspace switcher: "Agents & Triggers" → the page (manage); a new "Work with an agent" entry → `agentPanelBus.toggle()` (interact). `onOpenAgents`/`onOpenTriggers` navigate to the page; `onWorkWithAgent` opens the panel.
- New-agent default stays `anthropic` / `claude-haiku-4-5`. **Out of scope (deferred):** runs-view/result-rendering polish ("not clear what I was looking at"), and claude-code (left in, not default — too slow per the ~8s CLI floor measured this session).
- `routeTree.gen.ts` is a TRACKED generated file (TanStackRouterVite plugin); adding/removing a route requires regenerating it (start the dev server briefly) and committing it — `bun run build` can't regenerate it because its `tsc --noEmit` gate fails first on the unknown route.

## Phase 3.x — Document editing uses buffered save, not optimistic auto-save (2026-06-01)

Shipped on `phase-3.x/unified-document-save`. Design `docs/superpowers/specs/2026-06-01-unified-document-save-design.md`, plan `docs/superpowers/plans/2026-06-01-unified-document-save.md`. Trigger: the trigger slideover had a draft-and-Save button (rendered invisibly — `bg-fg text-bg` white-on-white) while agents/work-items/pages auto-saved on every commit, an inconsistent and partly-broken model.

- **All four document types (agents, triggers, work items, pages) now buffer edits behind ONE header disk icon, dirty-gated.** This INTENTIONALLY OVERRIDES the "Optimistic writes" UX commitment in CLAUDE.md *for in-slideover document editing*. That commitment still holds for inline-edit on list rows and other mutations. Rationale: a long-form agent prompt or work item is a deliberate, reviewable edit; a visible dirty/save state beats silent optimism for file-like documents.
- **Buffer shape is `{ body, frontmatter }` — title and status are EXCLUDED** and keep their immediate-commit paths (InlineEdit title commits on Enter/blur; project-slideover status PATCHes on select). Keeping status/title immediate makes the buffer shape identical across both slideovers, so one `useDocumentDraft` hook + one `SaveButton` serve all four types.
- **Three shared primitives:** `lib/use-document-draft.ts` (buffer + `isDirty` + `diff()`; re-seeds on `doc.id`/`doc.updatedAt`), `lib/use-unsaved-guard.ts` (defers a close/switch action while dirty; caller renders the Save/Discard/Cancel dialog), `components/slideover/save-button.tsx` (clean/dirty/saving states on `IconButton` token styling — `text-fg`, never `bg-fg text-bg`, so the invisible-pill bug can't recur).
- **The draft seeds ONCE per mount; the OWNER remounts it via a React `key` to re-seed** — `useDocumentDraft` does NOT re-seed on prop change. Hard-won fix for a long debugging session: re-seeding in-place (render-phase, then effect, then guarded variants) OSCILLATED because React Query toggles the `doc` reference to `undefined` on every refetch (staleTime/focus/post-mutation invalidation), so the parent's `doc ?? placeholder` flipped to the empty placeholder mid-session and every re-seed strategy stomped the draft to empty (blank slideover + perpetually dirty + the agent 422 from echoing a stale/empty frontmatter). Robust architecture: each slideover parent fetches the doc + owns the Sheet shell, tab state, and the close/switch URL guard, and renders a **keyed inner component** (`WorkspaceSlideoverInner` / `DocumentSlideoverInner`) `key={`${doc.id}:${doc.updatedAt}`}`, mounted ONLY once a real doc is loaded. The inner owns `useDocumentDraft(doc)` (clean `useState` seed per mount), `onSave`, `SaveButton`, the body, the unsaved dialog; it mirrors `isDirty`/`saving` up via callbacks and exposes `save`/`discard` via an actions ref so the parent guard drives them. A switch or post-save `updatedAt` bump changes the key → React remounts the inner → fresh seed. No mid-render setState, no effect lag, no oscillation. (`useUnsavedGuard` was removed — the guard is inline in each parent now, since it needs the parent-owned mirrored dirty + the T5 switch latch, still required because the inner remounts clean before an effect could observe the old dirty state.) Known edge: a background refetch mid-edit remounts the inner and drops the unsaved buffer — acceptable (staleTime 30s makes it rare; prior behavior was worse).
- **Doc-switch-while-dirty interception needs a DIRTY-SLUG LATCH, not an effect reading `isDirty`.** The naive `[search.doc]`-effect approach fails: switching the URL unloads the old doc and the draft re-seeds on the new load, so `isDirty` is already false by the time any effect fires. The working pattern (in BOTH slideovers): latch the dirty doc's slug DURING render (`dirtySlugRef`, survives the re-seed), build the guard on `isDirty || dirtySlugRef.current !== null`, detect the URL flip during render into a `pendingSwitchRef`, and a `[search param]` effect reverts the URL to the latched slug + queues the intended switch behind the guard. Latch releases via the render-time `else if` when the reverted doc's buffer goes clean (Save re-seeds / Discard resets).
- **Close + Cmd/Ctrl-S + toast + spinner** all ship: close/switch route through the guard dialog; Cmd-S saves when dirty (preventDefault kills the browser save dialog); success toasts "Saved"; the disk icon spins on `update.isPending`.
- **Legacy `/w/:wslug/triggers` route was DELETED this session** (the redirect shim from the Phase-3.x agent-management split) — nothing in-app or server-side links to it; `/agents?tab=triggers` is canonical. Supersedes that part of the prior "agent management vs interaction" decision.

## Agent modes — the taxonomy + the v1 boundary (2026-06-01)

Folio's agents span FIVE modes across two independent axes — *who/what initiates* (external-human / internal-human / user-authored-doc / event / time) and *whether output can fan out* (single-hop vs. chains). Naming them so "did we cover everything?" stops recurring and so the deliberate deferrals don't get mistaken for oversights. Originating discussion: the built-in operator brainstorm (spec `docs/superpowers/specs/2026-06-01-builtin-folio-operator-agent-design.md`).

| Mode | Initiated by | Status |
|---|---|---|
| **Outside agent (MCP / API)** | external human driving Claude Code / their own agent | ✅ built (Phase 3 D — MCP + REST) |
| **Inside agent (operator)** | internal human talking in the cockpit | 🔜 specced (the operator-agent spec above) |
| **Custom table / work-item agents** | a user-authored agent doc, human-fired (assign / `@`-mention) | ✅ built |
| **Event-triggered agents** | a webhook / event fires ONE agent, it does the task, reports, done | ✅ built (Phase 3 C.3 reaction plane + trigger system) — single-hop, no human needed for the firing |
| **Scheduled / cron** | time | ⏸️ Phase 3.5 — deferred |

- **The v1 model is "agent performs a task, reports, done."** One agent, one task, one report, terminate. This is the locked turn-based thesis (`folio-agent-thesis`: agent does a task, stops, waits). Triggers AUTOMATE the firing of a single agent — that is fully in scope and shipped. The autonomous single-hop back-office (webhook → trigger → agent → report → done, no human in the loop) **already works**.
- **Agents spawning agents (chains / fan-out) is DELIBERATELY HELD OFF** — not an oversight, a chosen boundary. An agent's OWN output must not fire another agent run in v1. Enforced in code by the reaction plane's autonomy gate (`FOLIO_AGENT_CHAINS_ENABLED`, default false; `isAgentOriginated(event)` short-circuit emits `agent.chain.suppressed`). WHY held off: chains are where runaway cost, infinite loops, and debugging-hell live; single-hop triggered agents already deliver ~90% of "the back-office operates itself" at a fraction of the risk. Revisit only with an explicit "I want to enable agent chains" — and `tasks/retro-follow-ups.md` F-D2 (cancel/retry HTTP↔MCP duplication) is a MANDATORY prerequisite before the flag flips on.
- **Guard against accidental creep:** a trigger that happens to fire on an agent's own write would silently cross this boundary. The autonomy gate already blocks it in code; this decision is the *intent* behind that gate, so it's defended on purpose, not by accident.

## Operator agent runs on an API provider only (2026-06-01)

The built-in operator agent (operator-agent spec Phase 3) MUST run on an API provider (Anthropic/OpenAI/etc.), NEVER on the `claude-code` backend. WHY: Folio has two runner backends — API-provider runs the in-process loop where every tool call goes through `executeTool` (so the Phase-1 caller-delegation ceiling APPLIES), while claude-code spawns the `claude` CLI whose native tools bypass `executeTool` (the scope ceiling does NOT apply — see [[claude-code-runner-cli-not-sdk]]). An instance-operating agent with delegated authority running on a backend that bypasses the authority model would be self-defeating. So Phase 3 seeds the operator with `provider: anthropic`, never `claude-code`. The claude-code scope-bypass remains a general property of that backend (relevant only to a USER who deliberately configures a claude-code agent), now out of the operator's path by construction. Recorded in the Phase 2/3 handoff (OP1-DECIDED).

## Operator agent Phase 2 — one `config:write` scope for the structure surface (2026-06-01)

Phase 2 (token-scoped config write surface) found that four route guards — `tables:write`, `fields:write`, `views:write`, `statuses:write` — checked scope strings that were NEVER in the canonical scope set (`ALL_DOCUMENT_SCOPES` had only `documents:read|write|delete` + `agents:write`). No token could ever hold them, so those mutating routes were **token-dead** (reachable only by session users, who bypass `requireScope`). DECISION: collapse all four into ONE new canonical scope **`config:write`** (owner/admin-only via `roleToScopes`; members get only `documents:read|write`), rather than promoting four per-resource scopes. WHY: structure/config is one authority concept; one scope keeps the delegate-ceiling reasoning (`agent ∩ caller`) and the `roleToScopes`/`toolsToScopes` wiring minimal, and the Phase-1 `executeTool` double-check covers it for free. Project create/configure routes (previously scope-less but bearer-OK) also gained the `config:write` guard. EXCLUDED from this phase (deferred, separate sessions): users/memberships CRUD (no routes exist), AI-key WRITE (stays `requireSessionUser` — the operator runs on a key, never writes it), workspace create/rename/delete (instance bootstrap, session-only). Every config-mutation route also gained a uniform **`dryRun`** preview contract (`{dry_run, would, resource}` with zero inserts/events) — POST/PATCH read it from the validated JSON body, DELETE from `?dryRun=true` (the web DELETE client sends no body). The risk-SCORED gate is NOT v1; the coarse resource-type default ships, scorer drops in later. Companion fix `9f75c40` closed the natural consequence: `POST /tokens` now validates requested scopes against `roleToScopes(role)` so a member can't MINT a `config:write` PAT. Plans: `docs/superpowers/plans/2026-06-01-operator-agent-phase-2-token-scoped-write-surface.md` (+ phase-3). Built on branch `fix/token-mint-scope-ceiling`.
