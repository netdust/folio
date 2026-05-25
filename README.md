# Folio

> Lightweight, agent-native project management. One markdown file is one work item. Pages live next to tasks. Your agents read and write everything natively — via REST, SSE, and a built-in MCP server.

**Status: Phase 2 (Agents surface) shipped.** Bearer tokens, MCP server at `/mcp`, SSE event stream, agents + triggers as documents with auto-minted scoped tokens, delegation guard. Phase 3 (the agent runner) is next.

## Where to read first

- **`CLAUDE.md`** — operating manual. Read at the start of every Claude Code session.
- **`docs/FOLIO-BRIEFING.md`** — full PRD: business model, data model, API spec, MCP spec, UX criteria.
- **`docs/PHASES.md`** — phase-by-phase task list with checkboxes.
- **`docs/API.md`** — REST reference for every endpoint.
- **`docs/MCP.md`** — JSON-RPC MCP server and the v1 tool set.
- **`docs/AGENTS.md`** — agent document model, auto-token lifecycle, delegation.
- **`docs/TRIGGERS.md`** — cron + event-driven trigger model.

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

## Agents in five minutes

Folio is built for agents to read and write everything humans can.

1. **Sign in** and visit **Workspace settings → API tokens** (avatar menu → Settings). Click `+ Create token`, pick a preset, copy the plaintext token — it's shown once.

2. **Read documents** with the token:

   ```bash
   curl -H "Authorization: Bearer folio_pat_xxx" \
     http://localhost:3001/api/v1/w/<wslug>/p/<pslug>/documents
   ```

3. **Watch live events** over SSE in another terminal:

   ```bash
   curl -N -H "Authorization: Bearer folio_pat_xxx" \
     http://localhost:3001/api/v1/w/<wslug>/events
   ```

4. **Edit a doc in the UI** — the event arrives in the SSE terminal within milliseconds.

5. **Talk to Folio's MCP server** at `POST /mcp`:

   ```bash
   curl -X POST -H "Authorization: Bearer folio_pat_xxx" -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://localhost:3001/mcp
   ```

   Or mount it in Claude Desktop:

   ```jsonc
   { "mcpServers": { "folio": { "url": "http://localhost:3001/mcp", "headers": { "Authorization": "Bearer folio_pat_xxx" } } } }
   ```

6. **Create an agent as a document** (rail → Agents → `+`). The agent's `tools[]` whitelist auto-derives token scopes. Assign work to it via the slideover's Assignee picker — the agent appears alongside human members. The `agent.task.assigned` event fires on assignment.

See [`docs/AGENTS.md`](./docs/AGENTS.md) and [`docs/MCP.md`](./docs/MCP.md) for depth.

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
