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

## Documents (`/p/:pslug/documents`, `/p/:pslug/t/:tslug/documents`)

Source: `apps/server/src/routes/documents.ts` (HTTP) + `apps/server/src/services/documents.ts` (service layer shared with MCP).

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/documents` | session OR token | List. See **query params** below. |
| GET | `/documents/:slug` | session OR token | Single document with `frontmatter` + `body`. |
| GET | `/documents/:slug.md` | session OR token | Raw markdown (YAML frontmatter + body), `text/markdown`. Round-trips with the storage representation. |
| POST | `/documents` | `documents:write` | Create. Body shape below. |
| PATCH | `/documents/:slug` | `documents:write` | Patch. Frontmatter shallow-merge; `null` deletes keys. |
| DELETE | `/documents/:slug` | `documents:delete` | Hard delete. Side effect on agents → revokes the auto-token. |
| POST | `/documents/:slug/activity` | `documents:write` | Logs an activity entry; bumps `last_touched_at`. |
| GET | `/documents/:slug/events` | session OR token | Per-document event log. |

### List query params

| Param | Example | Meaning |
|---|---|---|
| `type` | `work_item \| page \| agent \| trigger` | Filter by document type. |
| `status` | `?status=todo&status=in_progress` | One-or-more status keys. |
| `assignee` | `agent:triage-bot` or `user@example.com` | Filter on `frontmatter.assignee`. |
| `updated_since` | ISO8601 | `updated_at >= ts` |
| `stale_for` | `7d` | `last_touched_at` null or older than N days. |
| `filter` | URL-encoded JSON | Mongo-ish AST compiled server-side. |
| `limit`, `cursor` | — | Cursor-based pagination. Max `limit=200`. |

### Create body

```jsonc
{
  "type": "work_item",          // or "page" | "agent" | "trigger"
  "title": "Required",
  "body": "Optional",
  "frontmatter": { "priority": "high" }
}
```

Type-specific rules:

- **`agent`** — frontmatter must match `agentFrontmatterSchema` (`apps/server/src/lib/agent-schema.ts`). On create, an `apiTokens` row is auto-minted with scopes derived from `tools[]` via `toolsToScopes()`. The plaintext token is returned in the response as `agent_token` exactly once.
- **`trigger`** — frontmatter must match `triggerFrontmatterSchema` (`apps/server/src/lib/trigger-schema.ts`). Cron-shape validated; at least one of `schedule` or `on_event` required.
- **`work_item`** — must be created on a table-scoped URL (or default-table fallback applies).
- **`page`** — project-scoped; never has `tableId`.

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
