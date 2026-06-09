## Next up — Sub-phase E (web UI) IN PROGRESS — see 2026-05-30 marker above. (Historical readiness handoff below predates the runs-surface redesign.)

> **🎯 READ FIRST (E session)**: `docs/superpowers/handoffs/2026-05-30-phase-3-sub-phase-E-readiness.md` — Sub-phase E readiness (web UI: runs table + link tiles + Cmd-K + provider/reactor-halt banners + body wiki-links). E is server-API-complete (D shipped every endpoint E consumes); E is almost all `apps/web`. Two cheap pre-steps: (1) `/integration` to advance the marker `9748a64`→`255c3e1` (D-9 shipped past it); (2) optional D + D-9 `/evaluate` retros. Then EXPAND the outline-only E-1..E-9 (writing-plans, Step 2.5 reconcile vs the D response shapes + existing Phase-1.5/1.6/2.6 web components + the SSE-client design decision). Skill order in the handoff. **The (historical) D readiness handoff is below; D is DONE.**

## Phase

Phase numbering aligned with `docs/PHASES.md` (canonical) as of 2026-05-24 reorg. Original Phase 2 (Agents) and Phase 3 (AI/runner) stayed as the v1 spine; new phases slotted around them.

- **Phases 0–2.6:** shipped + merged — per-phase detail archived 2026-06-09 (see ARCHIVE.md).
- **Phase 1.8 (Time-aware views):** queued — timeline view + This Week dashboard.
- **Phase 3 (Agent runner + provider abstraction + runs as documents):** **Sub-phase A shipped** on `phase-3/agent-runner` 2026-05-28 morning (auto-migrate on boot, event kinds, migration 0012 widens documents.type to agent_run + 4 partial indexes, migration 0012a flips runner builtins, agent_run Zod + state machine, pre-commit hook for migration↔journal pairing). 9 substantive commits in a 50-min session under subagent-driven-development with two-stage review per task. Two plan defects surfaced (A-4 house-style drift, A-4b heredoc portability) and corrected in the plan. Retro at `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-A-retro.md`. **Sub-phases B (provider abstraction + AI settings tab) → C (runner core) → D (routes + MCP parity) → E (web UI) → F (shake-out + merge)** queued.
- **Phase 4 (Inbound webhooks):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-4-inbound-webhooks.md`. 7 tasks.
- **Phase 5 (CMS bridge — Statamic):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-5-statamic-cms-bridge.md`. 10 tasks. WordPress is Phase 5.1.
- **Phase 6 (Per-view render modes):** queued — kanban becomes a render mode; calendar added.
- **Phase 7 (UX polish + admin UIs):** queued — Cmd-K depth, keyboard shortcuts, admin screens for webhooks + sync targets.
- **Phase 8 (Ship):** queued — release pipeline, landing page, first paying customer.

## Current branch

`phase-3/agent-runner` at `b05761a` — branched from main at `984b31c` (Phase 2.6 merge). Sub-phase A shipped; Sub-phase B (provider abstraction, 8 tasks) ready to start in a fresh session per user direction "batch them, do A first, then B in new session." Not pushed.

Tests on this branch: **server 544 / 1-skip / 0-fail, web 547 / 8-skip / 0-fail, shared 51 / 0-fail, scripts/backfill 7 / 0-fail**. Server + web TS clean for touched files. Pre-existing errors elsewhere unchanged. `.last-integration` marker at `13e5954`; `.last-evaluate` marker at `b05761a`.

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

### Phase 2 deferrals (intentional, not blocking PR)

- Inline-rename of token name in tokens tab (Phase 2.1).
- Structured trigger form (cron input with validate affordance + event-kind select). Current slideover uses generic frontmatter form — round-trips correctly but doesn't pretty-render cron.
- Bulk MD export including triggers under `projects/<pslug>/trigger/<slug>.md` (Phase 7 polish).
- `get_folio_workflow` MCP tool (Phase 2.1).
- `requires_approval` + `max_tokens_per_run` enforcement (Phase 3 runner-side).
- The `## Approved` body convention (Phase 3 — human-in-the-loop).
- `search_documents` MCP tool (v1.1 — needs sqlite-fts5).

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

### Open UX issue at session end (DO NOT touch without re-reading)

After Phase 1.7's ColumnPicker hoist (`3614ed4`), a follow-up issue remains:
- The picker icon now sits in the FilterBar row, right-aligned to the whole viewport.
- Stefan reports it "floats above the table in empty space" — visually disconnected from the columns.
- He also still sees a horizontal scrollbar even when the table content fits the viewport.
- His ask: picker should be "right aligned in the last column" — i.e. visually inside the table header, top-right of the columns area, not floating above.

I attempted an `absolute right-0` overlay approach in a non-committed edit and reverted it on Stefan's request. **Next session: investigate via Chrome DevTools FIRST**, don't guess. The scroll trigger needs measurement; the visual disconnect needs a different layout strategy than "separate row above table."

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
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)

---
### 2026-06-05 — tagged capture

**Decisions**
- **API tab on Agents & Triggers**, and **delete the standalone Workspace-settings page entirely**. This consolidates everything:

---
### 2026-06-05 — tagged capture

**Decisions**
- **API tab on Agents & Triggers**, and **delete the standalone Workspace-settings page entirely**. This consolidates everything:
[2026-06-05] — session ended (no significant changes captured)

---
### 2026-06-09 — tagged capture

**Decisions**
- **agent self-contained, core drops the trio.** netdust-agent keeps the full hook set (Stop/SessionStart/PreToolUse/SubagentStop); netdust-core drops Stop/SessionStart/PreToolUse.
- **Fix both copies identically.** Both `session-stop.py` files get the watermark + continuation fixes; core's hooks.json drops the trio so it doesn't fire, but the file stays correct.

---
### 2026-06-09 — tagged capture

**Decisions**
- **agent self-contained, core drops the trio.** netdust-agent keeps the full hook set (Stop/SessionStart/PreToolUse/SubagentStop); netdust-core drops Stop/SessionStart/PreToolUse.
- **Fix both copies identically.** Both `session-stop.py` files get the watermark + continuation fixes; core's hooks.json drops the trio so it doesn't fire, but the file stays correct.
