# API

Folio's HTTP API. All paths are prefixed `/api/v1` unless noted. Bodies are `application/json` unless noted. Successful responses are wrapped in `{ data: ... }`; failures return `{ error: { code, message } }` with a 4xx/5xx status.

The MCP server is documented separately in [`docs/MCP.md`](./MCP.md). Every MCP tool has a REST equivalent here.

## Auth

Routes accept either:
- **Session cookies** (set on login/register; `folio_session=...`)
- **Bearer tokens** (`Authorization: Bearer folio_pat_xxx`)

Either is sufficient — they're checked by the `requireUserOrToken` middleware on every workspace-scoped route. Source: `apps/server/src/middleware/auth.ts`, `apps/server/src/middleware/bearer.ts`.

### Scopes

Bearer tokens carry an array of `resource:action` scopes. The mapping is enforced by `requireScope()` wrappers on each mutating route:

| Scope | Granted for |
|---|---|
| `documents:read` | Read access to documents. Implicitly granted to anything that lists project content. |
| `documents:write` | Create + update documents. |
| `documents:delete` | Delete documents. |
| `fields:write` | Create / update / delete pinned fields. |
| `views:write` | Create / update / delete saved views. |
| `statuses:write` | Create / update / delete project statuses. |
| `tables:write` | Create / update / delete tables (destructive — cascades to documents). |

**Session-authenticated requests bypass scope checks** — membership is the gate. Scope checks only fire when a Bearer token is attached.

### Resource-scope (Phase 2.5)

Action-scope (`requireScope`) and resource-scope (`requireResource`) are **orthogonal** — both must pass. Resource-scope only applies to agent-bound Bearer tokens on project-scoped routes (anything under `/api/v1/w/:wslug/p/:pslug/*`):

1. The agent is loaded; its `frontmatter.projects` allow-list is read (default `['*']`).
2. The token's optional `project_ids` column narrows that list (`intersect()`).
3. If the URL's `:pslug` doesn't resolve to a project in the result, the request is rejected with `403 FORBIDDEN_RESOURCE` and message `agent not allow-listed for project <pslug>`.

Session-auth and human PATs (Bearer tokens without `agent_id`) bypass this check. Source: `apps/server/src/middleware/bearer.ts` (`requireResource`, `intersect`).

### Workspace-scoped vs project-scoped documents (Phase 2.5)

- `work_item` and `page` are **project-scoped**: created/listed/edited under `/api/v1/w/:wslug/p/:pslug/documents`. `project_id` is required; `workspace_id` is auto-derived.
- `agent` and `trigger` are **workspace-scoped**: created/listed/edited under `/api/v1/w/:wslug/documents` (NO `/p/:pslug`). `project_id` is null; `workspace_id` is required. The database CHECK constraint enforces the invariant.
- Project-level POST or GET with `type=agent|trigger` is rejected — see error codes in the Documents section below.

## Auth endpoints (`/api/v1/auth/*`)

Source: `apps/server/src/routes/auth.ts`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/register` | none | `{ email, password, name }` | `{ user }` + sets session cookie |
| POST | `/login` | none | `{ email, password }` | `{ user }` + sets session cookie |
| POST | `/logout` | session | — | `{ ok: true }` |
| GET | `/me` | session | — | `{ user }` |
| POST | `/magic-link/request` | none | `{ email }` | `{ ok: true }` (link printed to server console in dev) |
| GET | `/magic-link/consume?token=...` | none | — | sets session cookie, redirects to `/` |

## Workspaces (`/api/v1/workspaces`, `/api/v1/w/:wslug`)

Source: `apps/server/src/routes/workspaces.ts`

| Method | Path | Scope | Body | Returns |
|---|---|---|---|---|
| GET | `/api/v1/workspaces` | session | — | `[{ workspace, role }, ...]` |
| POST | `/api/v1/workspaces` | session | `{ name, slug? }` | `{ id, slug, name }` (201) |
| GET | `/api/v1/w/:wslug` | session OR token | — | `{ ...workspace, role }` |
| PATCH | `/api/v1/w/:wslug` | session, owner | `{ name }` | updated workspace |
| DELETE | `/api/v1/w/:wslug` | session, owner | — | 204 |
| GET | `/api/v1/w/:wslug/members` | session OR token | — | `{ members: [{ id, email, name, role }] }` |

## API tokens (`/api/v1/w/:wslug/tokens/:workspaceId`)

Source: `apps/server/src/routes/tokens.ts`. Plaintext returned exactly once on create — store it, then it's never recoverable. The hash is the only thing in the database.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/.../tokens/:workspaceId` | session, member | — | `{ tokens: [...] }` (hash omitted) |
| POST | `/.../tokens/:workspaceId` | session, member | `{ name, scopes: string[] }` | `{ id, name, token, scopes }` (201, **token is the plaintext**) |
| DELETE | `/.../tokens/:workspaceId/:tokenId` | session, member | — | `{ ok: true }` |

## Settings — AI keys (`/api/v1/w/:wslug/settings/:workspaceId/ai-keys`)

Source: `apps/server/src/routes/settings.ts`. BYOK store — keys are libsodium-encrypted at rest with the server master secret (`FOLIO_MASTER_KEY`).

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/.../ai-keys` | session, member | — | `{ keys: [...] }` (no plaintext) |
| POST | `/.../ai-keys` | session, member | `{ provider, apiKey, label?, baseUrl? }` | `{ ok: true }` |
| DELETE | `/.../ai-keys/:keyId` | session, member | — | `{ ok: true }` |

`provider` is one of `anthropic | openai | openrouter | ollama`.

## Projects (`/api/v1/w/:wslug/projects`, `/api/v1/w/:wslug/p/:pslug`)

Source: `apps/server/src/routes/projects.ts`

| Method | Path | Scope | Body | Returns |
|---|---|---|---|---|
| GET | `/projects` | session OR token | — | `[{ id, slug, name, icon? }, ...]` |
| POST | `/projects` | session, member | `{ name, slug?, icon? }` | created project |
| GET | `/p/:pslug` | session OR token | — | project |
| PATCH | `/p/:pslug` | session, member | partial | updated project |
| DELETE | `/p/:pslug` | session, owner | — | 204 |

**Project-delete cascade (Phase 2.5):** DELETE `/p/:pslug` runs inside a single transaction that (a) scans every workspace agent + trigger whose `frontmatter.projects` array contains the deleted project's id, (b) rewrites each match's frontmatter with the id filtered out, (c) deletes the project row (which cascades to its work_items, pages, tables, views, statuses via existing FK relations). Wildcard `['*']` agents are untouched. If the cascade fails mid-transaction, the project delete rolls back — no half-state. Source: `apps/server/src/routes/projects.ts`.

## Tables (`/api/v1/w/:wslug/p/:pslug/tables`)

Source: `apps/server/src/routes/tables.ts`

| Method | Path | Scope | Returns |
|---|---|---|---|
| GET | `/tables` | session OR token | `[{ id, slug, name, order }]` |
| POST | `/tables` | `tables:write` | created table |
| PATCH | `/tables/:tslug` | `tables:write` | updated table |
| DELETE | `/tables/:tslug` | `tables:write` | 204 (cascades to views / fields / statuses / documents) |

Table-scoped routes also exist at `/p/:pslug/t/:tslug/{statuses,fields,views,documents}` — same handlers but with the table resolved from the URL instead of falling back to the project default.

## Statuses (`/p/:pslug/statuses`, `/p/:pslug/t/:tslug/statuses`)

Source: `apps/server/src/routes/statuses.ts`

| Method | Path | Scope | Returns |
|---|---|---|---|
| GET | `/statuses` | session OR token | `[{ id, key, name, color, order }]` |
| POST | `/statuses` | `statuses:write` | created status |
| PATCH | `/statuses/:id` | `statuses:write` | updated status |
| DELETE | `/statuses/:id` | `statuses:write` | 204 |

## Fields (`/p/:pslug/fields`, `/p/:pslug/t/:tslug/fields`)

Source: `apps/server/src/routes/fields.ts`. Pinned fields override per-row type inference and add structural metadata (label, options, order).

| Method | Path | Scope | Returns |
|---|---|---|---|
| GET | `/fields` | session OR token | `[{ id, key, label, type, options, order }]` |
| POST | `/fields` | `fields:write` | created field |
| PATCH | `/fields/:id` | `fields:write` | updated field |
| DELETE | `/fields/:id` | `fields:write` | 204 |

## Views (`/p/:pslug/views`, `/p/:pslug/t/:tslug/views`)

Source: `apps/server/src/routes/views.ts`

| Method | Path | Scope | Returns |
|---|---|---|---|
| GET | `/views` | session OR token | `[{ id, name, type, filters, sort, ... }]` |
| POST | `/views` | `views:write` | `{ view: ... }` |
| PATCH | `/views/:id` | `views:write` | `{ view: ... }` |
| DELETE | `/views/:id` | `views:write` | 204 |

`type` is `list | kanban`. `filters` is a Mongo-ish JSON AST (compiled by `packages/shared/src/filter-compile.ts`).

## Documents — project-scoped (`/p/:pslug/documents`, `/p/:pslug/t/:tslug/documents`)

Source: `apps/server/src/routes/documents.ts` (HTTP) + `apps/server/src/services/documents.ts` (service layer shared with MCP).

These endpoints handle `work_item` and `page` documents only. `agent` and `trigger` documents are workspace-scoped — see the next section. Agent-bound bearer tokens are gated by `requireResource` here (see Auth § Resource-scope above).

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/documents` | session OR token | List. See **query params** below. |
| GET | `/documents/:slug` | session OR token | Single document with `frontmatter` + `body`. |
| GET | `/documents/:slug.md` | session OR token | Raw markdown (YAML frontmatter + body), `text/markdown`. Round-trips with the storage representation. |
| POST | `/documents` | `documents:write` | Create. Body shape below. |
| PATCH | `/documents/:slug` | `documents:write` | Patch. Frontmatter shallow-merge; `null` deletes keys. |
| DELETE | `/documents/:slug` | `documents:delete` | Hard delete. |
| POST | `/documents/:slug/activity` | `documents:write` | Logs an activity entry; bumps `last_touched_at`. |
| GET | `/documents/:slug/events` | session OR token | Per-document event log. |

### List query params

| Param | Example | Meaning |
|---|---|---|
| `type` | `work_item \| page` | Filter by document type. `agent` and `trigger` are rejected with `400 UNSUPPORTED_TYPE_FILTER` — use the workspace endpoint. |
| `status` | `?status=todo&status=in_progress` | One-or-more status keys. |
| `assignee` | `agent:triage-bot` or `user@example.com` | Filter on `frontmatter.assignee`. |
| `updated_since` | ISO8601 | `updated_at >= ts` |
| `stale_for` | `7d` | `last_touched_at` null or older than N days. |
| `filter` | URL-encoded JSON | Mongo-ish AST compiled server-side. |
| `limit`, `cursor` | — | Cursor-based pagination. Max `limit=200`. |

### Create body

```jsonc
{
  "type": "work_item",          // or "page"
  "title": "Required",
  "body": "Optional",
  "frontmatter": { "priority": "high" }
}
```

Type-specific rules:

- **`agent`** / **`trigger`** — rejected with `422 INVALID_DOCUMENT_SCOPE`. Message includes a pointer to `POST /api/v1/w/:wslug/documents`. Workspace-scoped from Phase 2.5; see next section.
- **`work_item`** — must be created on a table-scoped URL (or default-table fallback applies).
- **`page`** — project-scoped; never has `tableId`.

### Errors specific to this surface

| Code | Status | When |
|---|---|---|
| `INVALID_DOCUMENT_SCOPE` | 422 | POST with `type=agent` or `type=trigger`. |
| `UNSUPPORTED_TYPE_FILTER` | 400 | GET with `?type=agent` or `?type=trigger`. |
| `FORBIDDEN_RESOURCE` | 403 | Agent-bound bearer token whose effective allow-list (`intersect(agent.projects, token.project_ids)`) doesn't include the requested `:pslug`. |

## Documents — workspace-scoped (`/api/v1/w/:wslug/documents`) — Phase 2.5

Source: `apps/server/src/routes/workspace-documents.ts` (HTTP) + `apps/server/src/services/documents.ts` (shared service layer).

Handles `agent` and `trigger` documents only. `project_id` is always null; uniqueness is `(workspace_id, type, slug)`.

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/documents?type=agent\|trigger` | session OR token | List workspace agents or triggers. |
| GET | `/documents?type=agent&project=<id>` | session OR token | Filter agents to those allow-listed for the given project id (wildcard `['*']` agents always included). |
| GET | `/documents/:slug` | session OR token | Single workspace doc by slug. |
| POST | `/documents` | `documents:write` | Create agent or trigger. `type` must be `agent` or `trigger`. |
| PATCH | `/documents/:slug` | `documents:write` | Patch. Frontmatter shallow-merge; `null` deletes keys. |
| DELETE | `/documents/:slug` | `documents:delete` | Hard delete. For agents, the cascade FK on `api_tokens.agent_id` revokes the bound token in the same transaction. |

### Create body

```jsonc
{
  "type": "agent",                       // or "trigger"
  "title": "Triage Bot",
  "body": "Optional system context",
  "frontmatter": {
    "system_prompt": "Triage incoming bugs.",
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "tools": ["list_documents", "get_document", "update_document"],
    "projects": ["8VTeiptMzXIccnoH6V5cd"]   // optional; default ['*']
  }
}
```

For `type=agent`, the response includes `agent_token` (plaintext, ONCE). See `docs/AGENTS.md`.

### Errors specific to this surface

| Code | Status | When |
|---|---|---|
| `INVALID_DOCUMENT_SCOPE` | 422 | POST with type other than `agent` or `trigger`. |
| `UNSUPPORTED_TYPE_FILTER` | 400 | GET without `?type=agent` or `?type=trigger`, or with an unknown type. |
| `INVALID_AGENT_FRONTMATTER` | 422 | Agent frontmatter fails Zod (includes wildcard-exclusivity violation `'*' cannot be combined with explicit project ids`). |
| `INVALID_TRIGGER_FRONTMATTER` | 422 | Trigger frontmatter fails Zod (cron shape, both schedule + on_event null, etc). |

## Events — SSE (`/api/v1/w/:wslug/events`)

Source: `apps/server/src/routes/events.ts`. Live event stream over Server-Sent Events.

```bash
curl -N -H "Authorization: Bearer $TOK" \
  "http://localhost:3001/api/v1/w/:wslug/events?project=<pid>&kinds=document.created,document.updated"
```

Query params:
- `project` — filter to one project id.
- `kinds` — comma-separated `EventKind` list. Omit for all.
- `Last-Event-Id` header — replays everything since that event id (up to 500 historical rows), then attaches to the live stream.

Each SSE message:
```
id: <event-id>
event: <kind>
data: { "id": "...", "workspaceId": "...", "projectId": "...", "documentId": "...", "kind": "...", "actor": "...", "payload": {...} }
```

A `ping` event is sent every 30 seconds to keep the connection alive.

Event kinds enumerated in `KNOWN_EVENT_KINDS` (`apps/server/src/lib/trigger-schema.ts`):

```
document.created  document.updated  document.deleted
status.created    status.updated    status.deleted
field.created     field.updated     field.deleted
view.created      view.updated      view.deleted
table.created     table.updated     table.deleted
project.created   project.updated   project.deleted
workspace.created workspace.updated
activity.logged
agent.created     agent.deleted     agent.task.assigned
```

## Health (`/healthz`)

Unversioned. `GET /healthz` returns `{ ok: true, version: "0.0.1" }`.

## See also

- [`docs/MCP.md`](./MCP.md) — JSON-RPC MCP server at `/mcp`.
- [`docs/AGENTS.md`](./AGENTS.md) — agent document model.
- [`docs/TRIGGERS.md`](./TRIGGERS.md) — trigger document model.
- [`docs/FOLIO-BRIEFING.md`](./FOLIO-BRIEFING.md) — full PRD.
