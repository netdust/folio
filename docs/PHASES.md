# Folio — Phases

Six phases to v1. Each is a focused chunk. Check tasks off as you complete them. When a phase is done, commit `phase-N: complete` and move on.

For full context on any decision: `@docs/FOLIO-BRIEFING.md`. For the operating manual: `@../CLAUDE.md`.

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

---

## Phase 1 — Core CRUD (Week 2)

**Goal:** Create, read, update, delete documents (work items + pages). List view with filters and kanban view with drag-drop work. Inline editing functions. Body editor (Milkdown) and raw-MD toggle (CodeMirror) both work.

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

- [ ] `components/views/list-view.tsx`: virtualized table, configurable columns
- [ ] Display fields: title, status, plus frontmatter keys from view's `displayFields`
- [ ] Inline edit: click title → text input; click status → dropdown
- [ ] Frontmatter cell editors dispatch to `field-renderer.tsx` based on inferred/pinned type
- [ ] Sort by clicking column header
- [ ] Filter chips at the top: "Status is...", "Priority is..." (add via "+ Filter" button)

### Frontend — kanban view

- [ ] `components/views/kanban-view.tsx`: columns grouped by status
- [ ] dnd-kit setup for drag-drop between columns
- [ ] Optimistic status update on drop, rollback on failure
- [ ] Card shows title + selected frontmatter fields

### Frontend — editor & slideover

- [ ] `components/slideover.tsx`: right-side panel, animates, URL-driven open state
- [ ] Clicking a work item in any view opens the slideover for that document
- [ ] Frontmatter fields render as labeled inputs above the body editor
- [ ] Milkdown body editor with markdown plugins (gfm, math optional)
- [ ] CodeMirror "raw MD" toggle: switches the whole document to raw mode
- [ ] Round-trip: edit in raw → switch to form → all fields preserved correctly

### Pages (wiki)

- [ ] Pages live under a "Wiki" tab in the project nav
- [ ] Tree view by `parent_id`
- [ ] Same editor as work items (Milkdown + raw toggle)
- [ ] Pages don't have status; their UI hides the status field

### Phase 1 acceptance

- [ ] Create / edit / delete work items via UI works
- [ ] Create / edit / delete pages via UI works
- [ ] List view with filters + sort works
- [ ] Kanban view with drag-drop works
- [ ] Raw MD toggle preserves all data
- [ ] All edits round-trip via raw MD export
- [ ] Commit: `phase-1: complete`

---

## Phase 1.5 — Time-aware views (Half-week)

**Goal:** Folio becomes a tool you check on Monday morning. Add a timeline view as a third view type and a "This Week" dashboard surface. Read-only against existing data — no new tables.

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
- [ ] Server endpoint: `GET /api/v1/w/:wslug/this-week` returns three buckets — `due_this_week` (due_date within next 7 days), `overdue` (due_date in past, status not done/cancelled), `stale` (no update in 14+ days, status not done/cancelled)
- [ ] Renders as three stacked sections; each row links to the document slideover
- [ ] Items show their project icon + name so cross-project context is visible
- [ ] Empty state per bucket — "Nothing due this week" is a feature, not a void

### Phase 1.5 acceptance

- [ ] Timeline view renders work items by `due_date` and lets you drag-reschedule
- [ ] Items without dates land in the Unscheduled tray and can be dragged onto the timeline
- [ ] `/w/$workspace/this-week` shows due, overdue, and stale buckets across all projects
- [ ] Default `Schedule` view is auto-created with each new project
- [ ] Commit: `phase-1.5: complete`

---

## Phase 2 — Agents (Week 3)

**Goal:** Folio is usable by AI agents. REST + MCP both work. Tokens have scoped permissions. Every write emits an event on SSE. Documentation lets a new agent integrate in 15 minutes.

### Tokens

- [ ] `routes/tokens.ts`: create, list, revoke
- [ ] Token format: `folio_pat_<workspace_slug>_<32-char-random>`
- [ ] Returned in full *once* on creation; only `prefix` shown after
- [ ] Scopes: `read`, `write`, `admin`
- [ ] Scope-checking middleware applied per route
- [ ] UI: workspace settings → API tokens tab; create/revoke flow

### Events & SSE

- [ ] `lib/events.ts`: in-memory pub/sub (`emit(event)`, `subscribe(filters, handler)`)
- [ ] On every document write: insert events row + emit
- [ ] `routes/events.ts`: SSE endpoint `GET /api/v1/w/:wslug/events?kinds=...&project=...`
- [ ] Heartbeat every 30s to keep connections alive
- [ ] Reconnect-friendly: support `Last-Event-Id` header for replay from `events` table

### MCP server

- [ ] `routes/mcp.ts`: mount MCP server at `/mcp`
- [ ] Use `@modelcontextprotocol/sdk` (or hand-rolled if simpler)
- [ ] Implement v1 tool set from FOLIO-BRIEFING.md §9
- [ ] Token auth via the same `Bearer` scheme as REST
- [ ] Tool output includes both structured JSON and a `markdown` field for convenience
- [ ] Tool: `get_folio_workflow(section?: 'task-pickup' | 'task-execution' | 'task-finalization' | 'delegation')` returns markdown guidance — agents call this once at session start instead of being pre-loaded with workflow rules (borrowed from Backlog.md's `get_backlog_instructions`)

### Agents-as-documents (surface only — no runner yet)

Agents are first-class entities inside Folio, modelled as documents. No new tables — `type: 'agent'` reuses the documents table; one API token is auto-minted per agent and stored in frontmatter. The runner that actually executes agent tasks lands in Phase 3 (it depends on the AI provider abstraction).

- [ ] `documents.type` accepts `'agent'` alongside `'work_item'` and `'page'`
- [ ] Agent frontmatter shape (validated by Zod):
  - `system_prompt: string` (also lives in body if author prefers — body wins)
  - `model: string` (e.g. `claude-sonnet-4-6`)
  - `provider: 'anthropic'|'openai'|'openrouter'|'ollama'`
  - `tools: string[]` (MCP tool names the agent is allowed to call; subset of v1 tool set)
  - `max_delegation_depth: number` (default `2`, hard cap `5`)
  - `max_tokens_per_run: number` (default `10000`, hard cap `100000`) — runner aborts with `## Error: budget_exceeded` if exceeded mid-run; protects BYOK customers from runaway spend
  - `requires_approval: boolean` (default `false`) — if true, the agent runs in two phases: writes `## Plan` and stops, then resumes only when a human writes `## Approved` (any value) in the body. Use for high-stakes agents.
  - `api_token_id: string` (server-managed; never editable by user)
  - `parent_agent: string | null` (slug of the agent that spawned this one, if any)
- [ ] On agent create: auto-mint an API token scoped to the agent's `tools`, store `api_token_id` in frontmatter; never expose the raw token in API responses after creation
- [ ] On agent delete or archive: revoke the linked token in the same transaction
- [ ] Assignment convention: `frontmatter.assignee` of the form `agent:<slug>` means "this work item is assigned to an agent in the same project"
- [ ] New event kind `agent.task.assigned` emitted when a work item's `assignee` transitions to an `agent:*` value (covers create-with-assignee and update-to-assignee)
- [ ] Delegation guard: when an agent (actor_type `agent`) creates a work item with `assignee: agent:*`, server rejects if `parent_agent` chain would exceed the parent's `max_delegation_depth`
- [ ] UI: "Agents" tab in project nav — a default view filtered to `type: 'agent'`
- [ ] UI: agent slideover renders `system_prompt` in the body editor (same Milkdown surface as any other document — editing the agent = writing markdown)
- [ ] UI: inline assignee picker on work items lists both humans (memberships) and agents (documents with `type: 'agent'` in the same project)

### Triggers-as-documents (surface only — scheduler/matcher in Phase 3)

Triggers are documents with `type: 'trigger'`. Same documents table, same export-as-MD story. A trigger points at an agent slug and fires either on a schedule, an event pattern, or both. N triggers per agent. The scheduler that actually fires them lands in Phase 3 with the agent runner.

- [ ] `documents.type` accepts `'trigger'` alongside `'work_item'`, `'page'`, `'agent'`
- [ ] Trigger frontmatter shape (validated by Zod):
  - `agent: string` (slug of the agent document this trigger invokes; must exist in the same project)
  - `schedule: string | null` (cron expression, e.g. `"0 9 * * 1"` for Mondays 9am; null if event-only)
  - `on_event: string | null` (event kind, e.g. `"document.updated"`; null if schedule-only)
  - `event_filter: object | null` (mongo-ish filter against the event payload, e.g. `{ "document.status": "Done" }`; only consulted when `on_event` is set)
  - `payload: object | null` (free-form JSON passed to the agent as input context — agent decides what to do with it)
  - `enabled: boolean` (default `true`)
  - `last_fired_at: string | null` (server-managed ISO datetime; never user-editable)
  - `last_status: 'ok' | 'failed' | null` (server-managed)
- [ ] At least one of `schedule` or `on_event` must be set — Zod rejects triggers with neither
- [ ] On trigger create/update: validate `agent` slug exists in project; validate cron expression parses; validate `on_event` is a known event kind
- [ ] Trigger CRUD uses the same documents endpoints — no new routes
- [ ] UI: "Triggers" tab in project nav — default view filtered to `type: 'trigger'`, columns show `agent`, `schedule`, `on_event`, `last_fired_at`, `last_status`
- [ ] UI: trigger slideover renders frontmatter as a form (cron picker, event-kind dropdown, JSON payload editor) above the body — body is a free-form description of what the trigger is for
- [ ] Exported MD includes triggers under `projects/<pslug>/trigger/<slug>.md` — round-trip preserved

### Documentation

- [ ] `docs/API.md`: REST reference, generated from route + JSDoc or hand-written
- [ ] `docs/MCP.md`: tool reference with example invocations
- [ ] `docs/AGENTS.md`: how the agent-document model works — schema, token minting, delegation rules, the `agent.task.assigned` event contract (the runner that consumes it ships in Phase 3)
- [ ] `docs/TRIGGERS.md`: how the trigger-document model works — schema, cron + event-pattern semantics, payload contract (the scheduler/matcher that fires them ships in Phase 3)
- [ ] Update root `README.md` with the agent integration story

### Phase 2 acceptance

- [ ] Create token via UI, use it to `curl POST /api/v1/.../documents` → success
- [ ] Connect with an MCP client (Claude Desktop, Paperclip), list workspaces, create a document
- [ ] Open SSE stream, edit a document in the UI, see the event arrive
- [ ] Revoking a token immediately blocks subsequent requests
- [ ] Create an agent document via UI; its API token is auto-minted and the agent appears in the work-item assignee picker
- [ ] Assigning a work item to `agent:<slug>` emits one `agent.task.assigned` event visible on the SSE stream
- [ ] Deleting an agent revokes its token immediately (subsequent requests with that token fail)
- [ ] Create a trigger document with a cron schedule pointing at an existing agent; trigger persists and round-trips as MD (scheduler fires in Phase 3)
- [ ] Create a trigger with an `on_event` pattern + `event_filter`; validation accepts known event kinds and rejects unknown ones
- [ ] Commit: `phase-2: complete`

---

## Phase 3 — AI in UI + Agent runner (Week 4)

**Goal:** Slash commands work in the body editor. AI settings UI lets the user configure a provider and validate the key. Streaming responses feel snappy. The Phase 2 agent-document surface gains a runner that actually executes assigned tasks.

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

## Phase 4 — UX Polish (Week 5)

**Goal:** Hit every UX commitment from FOLIO-BRIEFING.md §11. Playwright covers them end-to-end.

### Cmd-K palette

- [ ] `components/palette.tsx`: global Cmd-K opens a fuzzy-search palette
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

- [ ] Right-click any row → context menu with "Copy as Markdown"
- [ ] Right-click in a document view → same
- [ ] `Cmd-Shift-C` on focused row triggers it
- [ ] Output matches the export format exactly (frontmatter + body)

### Theme & polish

- [ ] Dark mode (default) and light mode toggle
- [ ] Empty states with helpful copy
- [ ] Loading skeletons (not spinners) on initial loads
- [ ] Error boundaries on each route with retry

### Playwright

- [ ] Install Playwright in `apps/web/tests/e2e/`
- [ ] One e2e test per UX commitment
- [ ] CI runs Playwright headlessly (later — local for now)

### Phase 4 acceptance

- [ ] All six UX commitments pass Playwright
- [ ] Dark mode looks good on every screen
- [ ] Commit: `phase-4: complete`

---

## Phase 5 — Ship (Week 6)

**Goal:** Public release. Docs, landing page, one paying customer.

### Docs

- [ ] `README.md` — what Folio is, install in 60 seconds, screenshot, link to docs
- [ ] `docs/INSTALL.md` — Docker + binary + Ploi recipes
- [ ] `docs/API.md` — finalize REST reference
- [ ] `docs/MCP.md` — finalize MCP reference
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
- [ ] Embed a short Loom demo
- [ ] Link to GitHub + docs

### First customer

- [ ] Pick one friendly Netdust client (small team, low risk)
- [ ] Free pilot install on their existing Hetzner instance
- [ ] Onboarding session with them — capture every friction point
- [ ] Address blockers; ship `0.1.1`
- [ ] Decide pricing for paid installs based on what they were willing to pay

### Phase 5 acceptance

- [ ] Tagged `0.1.0` release on GitHub
- [ ] Stefan is using Folio daily for his own work
- [ ] One non-Stefan user is using Folio in production
- [ ] Commit: `phase-5: complete`. Ship it.

---

## After v1

Things to consider for v1.1 onward — *do not build in v1*:

- Full-text search via sqlite-fts5
- Vector search via sqlite-vec
- Postgres adapter
- Email notifications
- Per-project ACLs
- Calendar view
- Timeline / Gantt view
- Public document sharing (read-only links)
- Plugins / extensions API
- Webhooks (in addition to SSE)
- Mobile-optimized PWA
