# Folio — STATE

_Last updated: 2026-05-23_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Phase

- **Phase 1 (Core CRUD): shipped.** Backend + frontend + slideover + raw-MD round-trip + acceptance ticks done.
- **Phase 1.5 (UX polish): in flight on `phase-1.5/ux-polish`.** Two waves of polish + a review-driven cleanup commit landed; awaiting visual sign-off + merge to main.
- **Phase 1.5 (Time-aware views): not started.** Timeline view + This Week dashboard still on the docket per `docs/PHASES.md`.
- **Pre-Phase-2 cleanups:** 3 items queued — see Open Threads.

## Current branch

`phase-1.5/ux-polish`. Tip is the review-cleanup commit (post-`7c306d7`). 125 / 125 web tests pass.

## What's working in the UI

- Sign-up / login / magic-link flow.
- Workspace + project list, project picker.
- List view (filters, sort, inline title + status edit).
- Kanban view (drag-drop status change, per-column `+`, subtle panel surface).
- Wiki tree (parent_id hierarchy, drag-to-reparent with cycle guard).
- Slideover with Milkdown + CodeMirror raw-MD toggle; round-trips byte-for-byte per the round-trip test.
- Cmd-K palette (open via top-right Search nav OR `⌘K`).
- Theme toggle, rail collapse persistence in localStorage.

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

- `bun run test` in `apps/web/` → Vitest. 125 / 125 pass + 1 skipped (jsdom limitation on Milkdown initial render).
- `bun test` from the repo root invokes Bun's runner, not Vitest — do NOT use it for web tests. Use `bun run --filter @folio/web test` or `cd apps/web && bun run test`.

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
