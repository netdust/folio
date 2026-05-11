# Folio

> Lightweight, agent-native project management. One markdown file is one work item. Pages live next to tasks. Your agents read and write everything natively.

**Status: Phase 0 scaffolded.** Auth, schema, workspace + project CRUD, AI-key encrypted storage, and the single-binary build pipeline all work end to end.

## Where to read first

- **`CLAUDE.md`** — operating manual. Read at the start of every Claude Code session.
- **`docs/FOLIO-BRIEFING.md`** — full PRD: business model, data model, API spec, MCP spec, UX criteria.
- **`docs/PHASES.md`** — six phases with granular checkboxes. Pick the next unchecked task and go.

## Quickstart

Requires **Bun 1.1+** (`curl -fsSL https://bun.sh/install | bash`).

```bash
# 1. Install
bun install

# 2. Configure
cp .env.example .env
# Generate secrets:
openssl rand -hex 32   # → paste into SESSION_SECRET
openssl rand -hex 32   # → paste into FOLIO_MASTER_KEY

# 3. Initialise the database
cd apps/server
bun run db:generate
bun run db:migrate
cd ../..

# 4. Run dev
bun run --filter @folio/server dev   # API on :3000
bun run --filter @folio/web dev      # UI on :5173
```

Visit **http://localhost:5173** and register. With no SMTP configured, magic links print to the server console — copy-paste them.

## Build the single binary

```bash
bun run build:binary    # → dist/folio
./dist/folio
```

## Deploy via Docker

```bash
docker compose up -d --build
```

## What this scaffold contains

```
folio/
├── apps/
│   ├── server/      Hono + Drizzle + SQLite. Auth, workspaces, projects, AI-key BYOK,
│   │                API tokens, frontmatter parser, stubs for documents/views/MCP.
│   └── web/         Vite + React + TanStack Router + Tailwind. Fraunces + Geist fonts,
│                    paper/ink design tokens, sign-in (password + magic), placeholder home.
├── packages/
│   └── shared/      Cross-cutting types (frontmatter field-type inference).
├── docs/            FOLIO-BRIEFING.md, PHASES.md — full planning docs.
├── CLAUDE.md        Operating manual for Claude Code sessions.
├── Dockerfile       Multi-stage → ~50MB single-binary image.
└── docker-compose.yml
```

For architectural rules, UX commitments, conventions, and the next concrete task — see `CLAUDE.md` and `docs/PHASES.md`.

## License

MIT.
