# CLAUDE.md — Folio

You are working on **Folio**, a lightweight, self-hostable, agent-first project management + wiki tool. One MD file = one work item or page. This file is the operating manual — read it at the start of every session.

For the full PRD and architecture rationale: `@docs/FOLIO-BRIEFING.md`
For phase-by-phase tasks with checkboxes: `@docs/PHASES.md`

---

## What Folio Is

A markdown-native, agent-friendly alternative to Plane / Linear / Notion task tools. One team per instance, multiple workspaces, multiple projects. Documents have two types: **work_item** (kanban-able tasks) and **page** (wiki-style long-form). Storage is SQLite, format is markdown with YAML frontmatter. AI is BYOK (customer brings their own Anthropic / OpenAI / Ollama key). Sold by Stefan / Netdust as an add-on to client website projects, deployed per-customer on Hetzner via Ploi.

## The Wedge (Never Compromise)

1. **Markdown is the source-of-truth surface.** Every work item and page exports as a `.md` file with YAML frontmatter. Bulk export the entire instance as a folder of `.md` files at any time. Customers and agents can both read and write the format directly.
2. **Agents are first-class users.** A documented REST API and an MCP server endpoint ship in v1. Tokens have scoped permissions. Every write emits an event for agents to react to.
3. **The UX is keyboard-fast.** Cmd-K palette. Inline edit everywhere. Slideovers, never modals. Optimistic UI. The product feels like Linear, stores data like Obsidian.

## Tech Stack (Locked — Do Not Re-Litigate)

| Layer | Choice |
|-------|--------|
| Runtime | Bun (latest stable) |
| Backend | Hono |
| ORM | Drizzle |
| DB | SQLite (Postgres-compatible later via env toggle) |
| Frontend | React + Vite + TanStack Router |
| Styling | Tailwind + shadcn/ui |
| MD body editor | Milkdown (real MD round-trip) |
| Raw MD editor | CodeMirror 6 with markdown mode |
| Drag-drop | dnd-kit |
| Encryption | libsodium |
| Tests | Bun test (unit), Playwright (e2e, phase 4+) |
| Lint/format | Biome |
| Auth | Hand-rolled session auth (no NextAuth, no Auth0) |
| License | MIT |

## Architectural Rules (Non-Negotiable)

1. **One binary.** `bun build --compile` produces a single executable that serves the API + static React bundle. A working install = `./folio` + a SQLite file + a reverse proxy. Nothing else.
2. **No sidecar services.** No Redis, no separate worker, no Postgres-required. Use SQLite for queues if needed (cron table + interval polling is fine).
3. **Frontmatter is the schema.** Only `title`, `status`, and `body` are columns on `documents`. Everything else (`priority`, `assignee`, `due_date`, `labels`, anything custom) lives in `documents.frontmatter` (JSON column). The UI infers field types from values; users can pin types explicitly per-project via the `fields` table.
4. **Every write emits an event.** Insert into `events` table + push to an SSE channel on the same transaction. Agents subscribe to this. Never bypass.
5. **BYOK only.** The server never holds a default AI key. If a workspace has no key configured, AI features hide gracefully. Keys are libsodium-encrypted at rest with a server master secret from `FOLIO_MASTER_KEY` env var.
6. **Self-hostable means installable in one command.** `docker run -v ./data:/data -p 3000:3000 folio:latest` or `./folio` from the binary. No external services required for a basic install.

## UX Commitments (Acceptance Criteria, Not Suggestions)

1. **Cmd-K palette.** Every primary action reachable here. One registry populates it.
2. **Inline editing.** Every field in every view is click-to-edit. No "Edit" buttons. Escape saves and exits.
3. **Slideovers, not modals.** Detail views push from the right; the list stays visible behind.
4. **Optimistic writes.** Mutations update the UI immediately. Failures roll back with a toast.
5. **Slash commands in the body editor.** v1 set: `/draft`, `/decompose`, `/summarize`, `/link`, `/ai`.
6. **Copy-as-MD.** Right-click any row, any document — copy clean markdown to clipboard.

## Repo Layout

```
folio/
├── apps/
│   ├── server/                 # Hono backend (Bun)
│   └── web/                    # React SPA (Vite)
├── packages/
│   └── shared/                 # Types shared between server + web
├── docker/
│   └── Dockerfile
├── scripts/
│   ├── build.ts                # bun compile single binary
│   └── deploy-ploi.sh
├── docs/
│   ├── FOLIO-BRIEFING.md       # Full PRD + architecture
│   ├── PHASES.md               # Phase-by-phase task list
│   ├── API.md                  # REST + MCP reference (write as you build)
│   └── INSTALL.md
├── CLAUDE.md                   # This file
├── package.json                # Workspace root
└── bun.lockb
```

## Conventions

- **TypeScript everywhere.** No JS files. `strict: true`.
- **Naming.** Files `kebab-case.ts`. Types/components `PascalCase`. Functions/vars `camelCase`. DB columns `snake_case`. Frontmatter keys `snake_case`.
- **IDs.** UUIDv7 (time-ordered) via `crypto.randomUUID()` or a uuid7 lib. Stored as `text` in SQLite.
- **Slugs.** Human-friendly identifiers for URLs. Generated from title, deduped per project.
- **Errors.** Throw `HTTPException` from Hono. Server returns `{ error: { code, message } }`. Client surfaces via toasts.
- **Validation.** Zod schemas at API boundaries. Shared in `packages/shared`.
- **Imports.** Absolute via `@/` aliases inside each app. No deep relative paths.
- **Commit messages.** `phase-N: <what>` for phase work. `fix:` / `chore:` / `docs:` otherwise. Atomic commits per task.
- **No `any`.** Use `unknown` and narrow.
- **No default exports** except for routers and React route components.

## How to Work in This Repo

1. **For any non-trivial work, load `netdust-agent:harnessed-development`** (via the Skill tool). This is the single entry point for the full harness — invoking it engages the whole pipeline so no gate gets skipped: brainstorm → write-plan (+ threat-modeling + architecture-invariants when triggered) → execute (subagent/TDD + mandatory testing-workflow at every task close, plus the Step 2.5 plan-freshness ground-truth) → shake-out → finish-branch. It absorbs and supersedes `ntdst-execute-with-tests` (that name still works — older handoff docs reference it — but `harnessed-development` is the front door). The two gates below are now *fired by this skill*; they remain documented here as the contract it enforces.
2. **Threat-modeling gate (fired by `harnessed-development` Stage 1a).** `netdust-agent:threat-modeling` produces a `## Threat model` section embedded inline in the plan BEFORE task breakdown, IF the work touches any of: user-controlled URLs (webhooks, BYOK provider URLs, OAuth redirects), auth/session/token surfaces, untrusted parsing (frontmatter from external sources, AI tool-call args, webhook payloads, file uploads), BYOK credentials, multi-tenancy boundaries, or anywhere the server makes outbound requests to user-supplied URLs. **Also fires on ad-hoc security-boundary edits with no plan** (a one-line change to `url-allow-list.ts`, auth/token surfaces, or `crypto.ts` — run the threat model on the diff). Worked example: `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` (section: `## Threat model`).
3. **Architecture-invariants gate (fired by `harnessed-development` Stage 1b).** `ARCHITECTURE-INVARIANTS.md` (root) names this repo's convergence points — the single places authorization, data access, live updates, error handling, and entity modeling are decided. When the work touches one of those properties, `netdust-agent:architecture-invariants` cites the touched invariants in the plan. **When running `/code-review`**, verify the diff against `ARCHITECTURE-INVARIANTS.md` and FLAG (don't block) any path that bypasses a convergence point, keyed to the invariant number (e.g. "writes scopes without `roleToScopes` → bypasses invariant 5"). `/shakeout` auto-dispatches the `invariant-auditor` for this. If the doc doesn't exist yet, author it via `/architecture-invariants audit`.
3b. **Feature-acceptance gate (fired by `harnessed-development` Stage 1g + Stage 3).** For any **user-facing feature** (a view, form, wizard, interactive flow, CRUD surface, or an endpoint a client/agent drives), `netdust-agent:feature-acceptance` embeds an `## Acceptance flows` matrix in the plan — one row per intended-use flow, each with a mandatory enumeration of the six edge classes (empty/zero state, denied actor, wrong-order/re-entry, concurrent/double, boundary value, mid-flow failure). At `/shakeout` it *drives* that matrix: **UI flows through the real browser** (Playwright spec → else `superpowers-chrome` `use_browser` against the dev server), **backend flows through the un-mocked wire** — emitting a `pass`/`fail`/`not-reachable`/`unverified-no-browser` manifest. This is the behavioral sibling of the `test-effectiveness` audit (code-bite): unit/integration tests prove the code is correct in the small; this proves the feature behaves when used. The five calibration bugs that motivated it (empty-state blank editor, route-vs-service guard gap, double-submit collision, no-rollback client divergence, jsdom-masked InlineEdit race) all shipped past a green, tier-disciplined suite. Run `/feature-acceptance` standalone to author or drive the matrix.
4. Read this file. Read `@docs/PHASES.md` to see what phase you're in and which task is next.
5. Pick the next unchecked task. Plan briefly, then implement.
6. Run tests before committing: `bun test`.
7. Commit atomically per task. Update `@docs/PHASES.md` to check the box.
8. When you learn something worth remembering across sessions (gotcha, dependency quirk, decision rationale), write it to `.claude/memory/notes.md`.

## Build & Run

```bash
bun install                       # Install all workspace deps
bun dev                                  # Run server + Vite dev together
bun run --filter @folio/server dev        # Backend only (@folio/server, NOT "server")
bun run --filter @folio/web dev           # Frontend only
bun run db:generate                       # Generate Drizzle migration (root script → @folio/server)
bun run db:migrate                        # Apply pending migrations (root script → @folio/server)
bun run db:studio                         # Open Drizzle Studio (root script → @folio/server)
# Tests: run server/shared from their own dir — root-cwd `bun test apps/server`
# triggers a spurious ~650-fail module-init cascade (a cwd quirk, not a regression).
cd apps/server && bun test               # server unit tests (1011)
cd packages/shared && bun test           # shared unit tests (63)
cd apps/web && npx vitest run            # web tests (vitest, NOT bun test)
bun x tsc --noEmit                       # typecheck — run from EACH of apps/server, apps/web, packages/shared (no root tsconfig)
bun run build                     # Build React → embed → bun compile single binary
docker build -f docker/Dockerfile -t folio:dev .
```

- One-time per fresh clone: `./scripts/hooks/install.sh` to enable the migration-journal pre-commit check. Re-run if you re-clone.

## Decisions Already Made — Do Not Re-Litigate

- Stack: see table above.
- License: MIT.
- Auth: email-password + magic-link in v1. No SSO/OIDC in v1.
- Status field: per-project configurable (not hard-coded states).
- Field rendering: type inferred from value on read; per-project `fields` table overrides inference with explicit type pins.
- AI cost model: BYOK only. Server never holds a default key. **AI keys are INSTANCE-level** (one store per instance, resolved by `(provider, ai_key_label)` — no per-workspace key), admin-gated at `/api/v1/instance/ai-keys`.
- Multi-tenancy: out of scope. **One instance = one team. Workspaces are ORGANIZATIONAL FOLDERS, NOT a security/tenancy boundary** (the `memberships` table + `__system` reserved workspace were dropped in the drop-workspace-tenancy refactor, 2026-06). Instance authority lives on `users.role` (owner/admin/member); per-workspace/project visibility is an explicit invitation-based grant (`workspace_access` / `project_access`), decided in `lib/access.ts` (the single who-can-see-what convergence point — invariant 4a). The operator is a code-resolved runtime singleton (`lib/operator.ts`, slug `_operator`), not a seeded row. Agents resolve by slug INSTANCE-WIDE (no workspace wall); execution is bound by the project ceiling + caller authority.
- Search: not in v1. sqlite-fts5 in v1.1.
- Comments / attachments / email notifications: not in v1.
- Real-time collab on a single document: not in v1. Last-write-wins with `updated_at` check.

## What This File Is Not

- Not generic instructions ("write clean code"). Claude Code already knows.
- Not a duplicate of the PRD. The PRD lives in `@docs/FOLIO-BRIEFING.md`.
- Not a task tracker. Tasks live in `@docs/PHASES.md` with `[ ]` checkboxes.

## Project memory

Three in-repo files curate state across sessions:

- `@memory/STATE.md` — living snapshot of where the project is (current branch, what's working, open threads). Read at session start. Update at session end if anything changed.
- `@memory/DECISIONS.md` — locked architectural + product decisions with reasoning. Don't re-litigate without explicit "I want to revisit X."
- `@memory/lessons.md` — self-improvement log. After any user correction, append a rule that prevents the same mistake.
- `@tasks/todo.md` — active task list for the current branch / session.

`@memory/README.md` explains the convention. Auto-memory at `~/.claude/projects/-home-ntdst-Projects-folio/memory/` complements these (tacit context, project deltas) but does not replace them.

---

**Next step:** open `@memory/STATE.md` to see where we left off, then `@docs/PHASES.md` for the current phase and the next unchecked task.
