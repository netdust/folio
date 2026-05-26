# MCP

Folio ships a hand-rolled JSON-RPC 2.0 MCP server at `POST /mcp`. Source: `apps/server/src/routes/mcp.ts`.

The endpoint is bearer-only — no session cookies. Mint a token in **Workspace settings → API tokens**, or programmatically via the REST API (`POST /api/v1/w/:wslug/tokens/:workspaceId`).

## Quickstart

```bash
TOK=folio_pat_xxx

# 1. Initialize the session
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-client","version":"0.1"}}}' \
  http://localhost:3001/mcp
# → { result: { serverInfo: { name: "folio", version: "0.1.0" }, protocolVersion: "2024-11-05", capabilities: { tools: {} } } }

# 2. List tools
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  http://localhost:3001/mcp

# 3. Call one
curl -s -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_workspaces","arguments":{}}}' \
  http://localhost:3001/mcp
```

## Supported JSON-RPC methods

| Method | Behavior |
|---|---|
| `initialize` | Returns `serverInfo` (`name: "folio"`, `version: "0.1.0"`) and `protocolVersion: "2024-11-05"`. |
| `tools/list` | Returns the 12 v1 tools (see below) as `{ name, description, inputSchema }`. |
| `tools/call` | Invokes a tool with `{ name, arguments }`. Returns `{ content: [{ type: 'text', text: <json or markdown> }] }`. |
| `ping` | Returns `{}`. |

Any other method returns JSON-RPC error `-32601 method not supported`.

## Errors

Errors use standard JSON-RPC error codes:

| Code | Meaning |
|---|---|
| `-32601` | Unknown method or unknown tool name. |
| `-32602` | Invalid params. Phase 2.5 uses this for allow-list rejections and for the agent-lifecycle-via-HTTP-only rejections. See `data.reason` to discriminate. |
| `-32603` | Tool execution error. Scope-denied calls also report `-32603` with `message: "tool <name> requires scope: <scope>"` and `data: { tool, required_scope }`. |

### `-32602` reasons (Phase 2.5)

| `data.reason` | When | Additional `data` fields |
|---|---|---|
| `agent_not_in_allow_list` | Agent-bound token called a project-scoped tool with a `project_slug` that's not in `intersect(agent.frontmatter.projects, token.project_ids ?? null)` | `project_slug`, `agent_slug` |
| `agent_lifecycle_via_http_only` | `create_document` with `type=agent\|trigger`, OR `update_document` / `delete_document` on a doc whose type is `agent` or `trigger` | (none — message includes the pointer to the HTTP endpoint) |
| `agent_missing` | The agent referenced by `token.agent_id` no longer exists (race between MCP call and agent deletion) | (none) |

Server-side logging contract: every allow-list rejection logs at INFO with structured fields `{ agent_slug, agent_id, requested_project_slug, requested_project_id, allowed_projects, tool }`. The MCP response keeps the minimal `data` shape above (operator-friendly, not leaky); the server log carries the full reasoning trail.

HTTP-level: requests without a valid bearer token return **401 UNAUTHENTICATED** (handled by `attachToken` + `requireToken` middleware in `apps/server/src/middleware/bearer.ts`).

## Scopes

Each tool requires one of the resource scopes the bearer token must carry. The mapping is hard-coded in `apps/server/src/routes/mcp.ts` per-tool. The shorthand:

- **Read tools** require `documents:read`.
- **Write tools** require `documents:write`.
- **`delete_document`** requires `documents:delete`.

When you create an **agent** document via the REST API or MCP, the auto-minted token derives its scopes from the agent's `tools[]` whitelist via `toolsToScopes()` in `apps/server/src/lib/agent-schema.ts`. Manually-issued tokens declare their scopes directly.

## The v1 tools

All 12 tools live in `apps/server/src/routes/mcp.ts`. The handler bodies delegate to the service layer (`apps/server/src/services/*`) — REST routes and MCP share the same service functions, so behavior is identical between the two surfaces.

Source-of-truth list (`V1_MCP_TOOLS` in `apps/server/src/lib/agent-schema.ts`):

```
list_workspaces           get_document              list_statuses
list_projects             get_document_markdown     list_fields
list_documents            create_document           list_views
                          update_document           run_view
                          delete_document
```

`search_documents` is deferred to v1.1 (requires sqlite-fts5).

### list_workspaces

Lists workspaces visible to the token. Today this is exactly the workspace the token belongs to (tokens are workspace-scoped via `workspaceId`).

- **Scope:** `documents:read`
- **Arguments:** none
- **Returns:** `{ workspaces: [{ id, slug, name }] }`

### list_projects

```jsonc
{ "workspace_slug": "netdust" }
```

- **Scope:** `documents:read`
- **Returns:** `{ projects: [{ id, slug, name }] }`
- **Allow-list filtering (Phase 2.5):** when the calling token is bound to an agent, the result is filtered to projects the agent is allow-listed for (`intersect(agent.frontmatter.projects, token.project_ids ?? null)`). Wildcard `['*']` agents and human PATs see every project in the workspace.

### list_documents

```jsonc
{ "workspace_slug": "netdust", "project_slug": "folio", "type": "work_item" }
```

- **Scope:** `documents:read`
- **Optional:** `type` — one of `work_item | page` (project-scoped types). Omit to list all project-scoped types.
- **Returns:** `{ documents: [{ id, slug, title, type, status }] }`
- **Allow-list enforcement (Phase 2.5):** if the calling token is bound to an agent and `project_slug` resolves to a project NOT in the agent's allow-list, returns `-32602` with `data: { reason: 'agent_not_in_allow_list', project_slug, agent_slug }`. Listing agent/trigger documents via MCP is HTTP-only in Phase 2.5 — use the workspace-scoped REST endpoint `GET /api/v1/w/:wslug/documents?type=agent` instead.

### get_document

```jsonc
{ "workspace_slug": "netdust", "project_slug": "folio", "slug": "triage-bot" }
```

- **Scope:** `documents:read`
- **Returns:** the full document row including `frontmatter` and `body`.

### get_document_markdown

Same arguments as `get_document`. Returns the raw markdown (YAML frontmatter + body) as text content. Round-trips byte-for-byte with the storage representation.

### create_document

```jsonc
{
  "workspace_slug": "netdust",
  "project_slug": "folio",
  "type": "work_item",
  "title": "From an agent",
  "body": "Optional body",
  "frontmatter": { "priority": "high" }
}
```

- **Scope:** `documents:write`
- **Returns:** the created document.
- **Allow-list enforcement:** same as `list_documents` — `-32602 agent_not_in_allow_list` when the project isn't in the agent's effective allow-list.
- **`type: 'agent'` and `type: 'trigger'` are rejected (Phase 2.5).** Returns `-32602` with `data: { reason: 'agent_lifecycle_via_http_only' }` and a message pointing at the workspace-scoped HTTP endpoint `POST /api/v1/w/:wslug/documents`. The convenience MCP tools (`create_agent` / `update_agent` / `delete_agent` / `get_agent_self`) ship in Phase 2.6.
- **Delegation guard (for project-doc creation by an agent token):** when an agent creates a `work_item` assigning it to another agent via `frontmatter.assignee = agent:<slug>`, the delegation guard walks the parent chain and rejects if the calling agent's `max_delegation_depth` is exceeded (`apps/server/src/lib/delegation-guard.ts`).

### update_document

```jsonc
{
  "workspace_slug": "netdust",
  "project_slug": "folio",
  "slug": "my-task",
  "title": "Optional new title",
  "body": "Optional new body",
  "status": "in_progress",
  "frontmatter": { "priority": "high" }
}
```

- **Scope:** `documents:write`
- **Frontmatter merge:** shallow merge; `null` values DELETE keys. Reserved keys (`type`, `title`, `status`, `last_touched_at`) are columns and are ignored if present in `frontmatter`.
- **Assignee transition** (`null` → `agent:<slug>` or different agent) additionally emits an `agent.task.assigned` event over SSE.
- **Allow-list enforcement:** same as above.
- **Mutating an agent or trigger document is rejected (Phase 2.5):** `-32602 agent_lifecycle_via_http_only`. Use the workspace-scoped HTTP `PATCH /api/v1/w/:wslug/documents/:slug` instead.

### delete_document

```jsonc
{ "workspace_slug": "netdust", "project_slug": "folio", "slug": "stale-doc" }
```

- **Scope:** `documents:delete`
- **Returns:** `{ ok: true, slug }`
- **Allow-list enforcement:** same as above.
- **Deleting an agent or trigger document is rejected (Phase 2.5):** `-32602 agent_lifecycle_via_http_only`. Use the workspace-scoped HTTP `DELETE /api/v1/w/:wslug/documents/:slug` instead. (When the HTTP delete IS used: the bound API token is revoked via the cascade FK on `api_tokens.agent_id`.)

### list_statuses / list_fields / list_views

```jsonc
{ "workspace_slug": "netdust", "project_slug": "folio", "table_slug": "work-items" }
```

- **Scope:** `documents:read`
- **`table_slug` optional** — defaults to the project's default table.
- **Returns:** `{ table: { id, slug }, statuses|fields|views: [...] }`

### run_view

```jsonc
{
  "workspace_slug": "netdust",
  "project_slug": "folio",
  "view_slug": "triage",
  "limit": 50
}
```

- **Scope:** `documents:read`
- **One of `view_slug` or `view_id` is recommended.** When neither is provided, the default view is used.
- **Returns:** `{ view: { id, name }, documents: [...] }` — documents are filtered by the view's stored filter AST and sort.
- **Note:** `view_slug` matches the view's **name** case-insensitively (views have no slug column in v1). Prefer `view_id` when known.

## Mounting in an MCP client

Folio's `/mcp` endpoint implements the same JSON-RPC subset Claude Desktop and the Anthropic SDK speak. Point your client at `https://your-folio.example.com/mcp` with a bearer header.

In Claude Desktop's config:

```jsonc
{
  "mcpServers": {
    "folio": {
      "url": "https://your-folio.example.com/mcp",
      "headers": { "Authorization": "Bearer folio_pat_xxx" }
    }
  }
}
```

## See also

- `docs/API.md` — full REST reference (every MCP tool has a REST equivalent).
- `docs/AGENTS.md` — agent document model, auto-token lifecycle, delegation.
- `apps/server/src/routes/mcp.ts` — implementation source of truth.
- `apps/server/src/routes/mcp.test.ts` — contract examples.
