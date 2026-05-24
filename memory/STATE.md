# Folio — STATE

_Last updated: 2026-05-24_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Phase

- **Phase 1 (Core CRUD): shipped.** Backend + frontend + slideover + raw-MD round-trip + acceptance ticks done.
- **Phase 1.5 (UX polish): in flight on `phase-1.5/ux-polish`.** Two waves of polish + a review-driven cleanup commit landed; awaiting visual sign-off + merge to main.
- **Phase 1.5 (Time-aware views): not started.** Timeline view + This Week dashboard still on the docket per `docs/PHASES.md`.
- **Pre-Phase-2 cleanups:** 3 items queued — see Open Threads.

## Current branch

`phase-1.5/ux-polish`. Tip is the `+ Filter forwardRef` fix at `c241407` (+ memory bump `60729ed` + auto-capture). 134 / 134 web unit + 81 / 81 server + 16 / 16 active e2e pass.

## What's working in the UI

- Sign-up / login / magic-link flow.
- Workspace + project list, project picker.
- List view (filters, sort, inline title + status edit).
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
- Tokens / SSE / MCP server (Phase 2).
- Slash commands in body editor (Phase 3).

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

- `bun run test` in `apps/web/` → Vitest. 134 / 134 pass + 1 skipped (jsdom limitation on Milkdown initial render).
- `cd apps/server && bun test` → 81 / 81 pass.
- `bun test` from the repo root invokes Bun's runner, not Vitest — do NOT use it for web tests. Use `bun run --filter @folio/web test` or `cd apps/web && bun run test`.
- `bun run e2e` in `apps/web/` → Playwright. 16 passing (3 smoke + 10 click-through + scenarios 1, 2, 15), 10 skipped (scenarios 3, 4, 5, 6, 8, 9, 10, 11, 12, 13 — each scaffolded with a per-test TODO about which selector still needs work).
- Click-through journeys (no API shortcuts — discover bugs the way users do): `apps/web/tests/e2e/click-through.spec.ts`. Add new regressions HERE when bugs are found via manual exploration.
- API-shortcut smoke: `apps/web/tests/e2e/smoke.spec.ts`. Manual-qa map: `apps/web/tests/e2e/manual-qa.spec.ts`. Config + helpers: `apps/web/playwright.config.ts`, `apps/web/tests/e2e/global-setup.ts`, `apps/web/tests/e2e/fixtures.ts`.
- Boots its own dev stack on ports 5174 (web) / 3002 (api), isolated SQLite at `apps/server/folio-e2e.db` (gitignored, wiped on every run via `global-setup.ts`). Cold-start is ~4.5 minutes mostly Vite warmup; individual tests are 1–3s.

## Servers

- Web dev: `http://localhost:5173/` (Vite).
- API dev: `http://localhost:3001/` (Hono via Bun, `--hot`).
- `bun dev` from repo root starts both via workspace filter.
- API has no `/` or `/health` route → expect 404 on root; the auth probe at `/api/v1/auth/me` is the right liveness signal.
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
[2026-05-23] — session ended (no significant changes captured)
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
