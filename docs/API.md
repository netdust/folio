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

## Instance AI keys (`/api/v1/instance/ai-keys`)

Source: `apps/server/src/routes/instance-ai-keys.ts`. BYOK store — keys are AES-256-GCM-encrypted at rest (via `@noble/ciphers`) with the server master secret (`FOLIO_MASTER_KEY`).

**AI keys are INSTANCE-level, not per-workspace.** One store per instance; a key is identified by `(provider, label)` and the runner resolves an agent's key by `(provider, ai_key_label)` with no workspace tie. This route is mounted on `/api/v1` (NOT under `/w/:wslug`), so:

- **Session-only.** `requireSessionUser` is the operative gate; a Bearer/PAT/agent token can never reach the secret store (`attachToken` does not run on this mount).
- **Instance owner/admin only.** Every handler calls `requireInstanceAdmin` — a session user who is not an instance owner/admin is rejected.
- The encrypted secret (`encryptedKey`) is NEVER returned on any response.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/instance/ai-keys` | session, instance owner/admin | — | `{ keys: [...], operator_model }` — each key is metadata only (`id`, `provider`, `label`, `baseUrl`); `encryptedKey` stripped. `operator_model` is the current operator provider+model selection (or null). |
| POST | `/instance/ai-keys` | session, instance owner/admin | `{ provider, apiKey?, label?, baseUrl? }` | `{ id, provider, label, paid_residual_live }` (201) |
| PUT | `/instance/ai-keys/operator-model` | session, instance owner/admin | `{ provider, aiKeyLabel, model }` (`operatorModelSettingSchema`) | `{ ok: true, operator_model }` |
| DELETE | `/instance/ai-keys/:keyId` | session, instance owner/admin | — | `{ ok: true }` (404 `NOT_FOUND` if the key id does not exist) |

`provider` is one of `anthropic | openai | openrouter | ollama`.

**POST body rules (enforced by Zod + handler):**

- `label` defaults to `"default"`.
- `apiKey` is **required and non-blank** for every paid provider (`anthropic`, `openai`, `openrouter`); `ollama` is keyless. Violation → `422`.
- `baseUrl` is **only** allowed for `ollama`. Supplying it for any other provider → `422` (prevents pinning an attacker-controlled host the runner would send the key to).
- `ollama` **requires** an explicit `baseUrl` → `422` if omitted.
- Any `baseUrl` is run through the SSRF allow-list (`validatePublicUrl`). Loopback is rejected by default; it is permitted ONLY for `ollama` AND ONLY when the server sets `FOLIO_ALLOW_LOOPBACK_AI=true`. A loopback rejection → `422` (with a hint about the env opt-in).
- On a `(provider, label)` conflict the row is **updated in place** (the `id` in the response is the existing row's id, not a new one).
- `paid_residual_live` is `true` when a paid-provider key was stored — a denial-of-wallet flag (per-key usage caps are not built; any agent in any workspace can draw on a shared instance key).

**PUT `/operator-model`** selects which already-configured `(provider, aiKeyLabel)` the operator runs on. The selection must point at an existing AI key — if no key matches, the request is rejected `422 INVALID_BODY`.

## Runner backend: claude-code (Phase 3.x)

The `claude-code` backend executes an agent via the local `claude` CLI instead of calling a BYOK API provider. It is off by default and gated behind the `FOLIO_CLAUDE_CODE_ENABLED` environment flag (see `docs/INSTALL.md`).

> **Security notice.** The `claude-code` runner spawns the local `claude` binary with access to the host's filesystem, SSH keys, and any MCP servers CC has configured. Only enable this on local or personal Folio installs where you control who can define agents. **Never enable it on a shared or hosted instance that holds fleet credentials.**

### Configuring an agent to use this backend

Set `provider: claude-code` in the agent's frontmatter. `model` is optional — when omitted, CC uses its own configured default.

```yaml
---
type: agent
title: Local Dev Helper
provider: claude-code        # no model required; CC uses its own default
system_prompt: |
  You are a local dev assistant. You have access to the project filesystem.
projects: ["*"]
---
```

The agent editor UI shows the `claude-code` option (labelled "no key needed") only when the server flag is on.

### Keyless operation

`claude-code` agents do not use the workspace AI-key store. No key is read, and no key is required. Because of this, `POST /ai/test-key` rejects a payload with `provider: claude-code` with `422 INVALID_BODY` ("claude-code does not use an API key and cannot be tested here") — there is nothing to test.

### How a run executes

When the runner poller claims a `planning` run whose parent agent has `provider: claude-code`, it branches to `ccExecute` instead of the normal provider stream loop:

1. **Pre-run approval is enforced at the poller, not via a REST endpoint.** The poller only claims runs at `status: planning`; a run sitting at `awaiting_approval` is never claimed, so the CLI is never spawned for it. Approval/resume is comment-driven (a `kind=approval` comment routed by the trigger-matcher's `resume_run` internal action), the same flow used by API-provider agents. There is **no** `POST /agent-runs/:id/approve` endpoint. **Note:** in this branch the `requires_approval` field is a schema field only — the production code path that transitions a `planning` run into `awaiting_approval` is **deferred** (see the gaps below); the gate is proven today by tests that seed `awaiting_approval` directly and confirm the poller skips it.
2. For a claimed run (no gate, or once resumed), the server spawns `claude -p <prompt>` in Folio's own working directory.
3. CC runs its own full agentic loop to completion — it may read/write files, run shell commands, call MCP servers, etc. Folio does not step through the loop; it just waits.
4. The full session transcript is captured and written to the run document's `body` field via `setRunBody`.
5. When the process exits, the run transitions to `completed` (or `failed` on non-zero exit), and the final result is posted as a `kind=result` comment on the parent document.

### MCP callback (CC writes back into Folio) — wired (Task 7b)

A `claude-code` run **can** call back into Folio's MCP tools (`update_document`, `create_comment`, etc.) during the run. For each run, `ccExecute`:

1. Mints a **short-lived, scoped Bearer token** that mirrors the run's agent token — same `scopes`, `agentId`, and project allow-list (`projectIds`). Identical permission envelope to an API-loop agent; CC is not a privilege backdoor.
2. Spawns `claude` with `--mcp-config '<json>' --strict-mcp-config`, where the config registers one HTTP MCP server pointing at `${PUBLIC_URL}/mcp` with `Authorization: Bearer <minted token>`. `--strict-mcp-config` means CC uses ONLY this server (not the operator's other `~/.claude` MCP servers) for Folio calls.
3. **Revokes** the token (deletes the row) in a `finally` block — on success, failure, or throw. The agent-delete cascade is the backstop.

So CC's Folio-side writes are governed by the agent's exact scopes; its host-side powers (SSH, `wp`, files) remain governed by the machine, outside Folio's envelope.

### v1 known gaps (fast-follow)

These are deferred; the runner still works without them:

- **Runs in Folio's own cwd.** The CLI is spawned from the server's working directory. Host context (project path, etc.) must come from the agent's system prompt or tools — there is no automatic cwd injection yet.
- **No mid-run cancellation.** Once the `claude` process is spawned, there is no in-flight kill mechanism. A cancellation request transitions the run row to `cancelled` in the database but does not terminate the subprocess.
- **Human-approval transition deferred.** The `planning → awaiting_approval` transition (so a `requires_approval` agent actually pauses for a human) is not wired in this branch; only the poller-skip half of the gate exists. When that transition lands, the resume path (`runAgentResume`) must also branch to `ccExecute` for claude-code — see the TODO on that function.

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
| GET | `/views?tables=slugA,slugB` | session OR token | `{ [tableId]: [{ id, name, type, ... }] }` (batched, grouped by table) |
| POST | `/views` | `views:write` | `{ view: ... }` |
| PATCH | `/views/:id` | `views:write` | `{ view: ... }` |
| DELETE | `/views/:id` | `views:write` | 204 |

`type` is `list | kanban`. `filters` is a Mongo-ish JSON AST (compiled by `packages/shared/src/filter-compile.ts`).

**Batched form (`?tables=`).** The project-scoped `GET /views?tables=slugA,slugB` returns views for multiple tables in one request, grouped by `tableId` (`{ [tableId]: View[] }`) — the UI rail uses this to avoid one request per (project, table) pair. The requested table slugs are **intersected with the project's own tables**: a slug that doesn't belong to this project is silently dropped (its views never appear), so the batched read can never expose another project's views. An empty/absent `tables` value returns `{}`. Without the `tables` param the endpoint keeps its legacy per-table array shape (above).

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

## Agent runs (`/api/v1/w/:wslug/runs`, `/api/v1/w/:wslug/p/:pslug/runs`)

Source: `apps/server/src/routes/runs.ts` + `apps/server/src/services/agent-runs.ts`. An agent run is a planning row; the runner poller (not these routes) executes it. `runAgent` is never called from here — even `retry` only creates a fresh `planning` row. Every response is redacted (`redactRunForApi` strips `system_prompt`).

The verbs split across two scope mounts:

| Method | Path | Scope | Body | Returns |
|---|---|---|---|---|
| GET | `/p/:pslug/runs` | `documents:read` | — | `[run, ...]` — **project-scoped** recent-runs list. |
| GET | `/w/:wslug/runs` | `documents:read` | — | `[run, ...]` — **workspace-scoped** recent-runs list (cross-project history for the Agent Activity feed). |
| GET | `/w/:wslug/runs/:runId` | `documents:read` | — | single run, re-scoped by id (404 if not in caller's allow-list). |
| POST | `/w/:wslug/runs` | `agents:write` | `{ agent_slug, parent_slug, input? }` | `{ run_id, status: "planning" }` (201) |
| POST | `/w/:wslug/runs/:runId/cancel` | `agents:write` | — | `{ run_id, status }` (transitions `planning`/`awaiting_approval` → `failed`; posts a `kind=rejection` cancel comment for a `running` run; terminal runs are a no-op). |
| POST | `/w/:wslug/runs/:runId/retry` | `agents:write` | — | `{ run_id, status: "planning" }` (201) — spawns a fresh planning run from the original's parent + agent. |
| GET | `/w/:wslug/provider-health` | `documents:read` | — | `{ <provider>: { status, consecutiveFailures }, ... }` (mounted at `/provider-health`, not under `/runs`). |

### List query params (both GET list routes)

| Param | Example | Meaning |
|---|---|---|
| `status` | `?status=running` | Filter by `RunStatus`. An unknown value → `422 INVALID_QUERY` (validated against the enum, no silent no-match). |
| `agent` | `?agent=triage-bot` | Filter by agent slug. |
| `since` | ISO8601 | Runs created since the timestamp. |
| `limit` | `?limit=50` | **Capped (M0).** Clamped to `1..100`; defaults to `50` when omitted or unparseable. The cap is applied at the SQL layer — the list is never unbounded (`agent_run` docs accumulate forever). |

### Allow-list narrowing

Both list routes and the id-addressed loads narrow by the caller's effective project allow-list (mitigation 58): an agent-bound token by `agent ∩ token.project_ids`; a project-only human by their direct grants. Owner / `workspace_access` holders / wildcard (`['*']`) agents are unrestricted. An out-of-allow-list run id returns `404` (not `403` — existence is not disclosed). A POST/retry by an agent-bound token is gated by `FOLIO_AGENT_CHAINS_ENABLED` (agent-originated chain hop → `403 AGENT_CHAINS_DISABLED` when off).

### Errors specific to this surface

| Code | Status | When |
|---|---|---|
| `INVALID_QUERY` | 422 | Unknown `?status=` value. |
| `INVALID_BODY` | 422 | POST without `agent_slug` + `parent_slug`, or unparseable JSON. |
| `PARENT_NOT_FOUND` | 404 | `parent_slug` does not resolve in the workspace (or has no project for an `input` comment). |
| `AGENT_NOT_FOUND` | 404 | `agent_slug` does not resolve instance-wide. |
| `RUN_ALREADY_ACTIVE` | 409 | A run is already active for that parent + agent (idempotency, m56). |
| `AGENT_CHAINS_DISABLED` | 403 | Agent-bound bearer create/retry while `FOLIO_AGENT_CHAINS_ENABLED` is off. |

## Conversations — operator cockpit (`/api/v1/conversations`)

Source: `apps/server/src/routes/conversations.ts` + `apps/server/src/services/conversations.ts`. The operator cockpit chat. Mounted on `/api/v1` (NOT under `/w/:wslug`) — conversations are instance-level, not workspace-scoped.

- **Session-only** (invariant 4): a Bearer/PAT does NOT drive the cockpit. `attachToken` does not run on this mount; `requireSessionUser` is the operative gate.
- **Owner-scoped** (M11): every read/write filters `conversations.created_by === session user`. A foreign user gets `404 CONVERSATION_NOT_FOUND` (not 403 — existence is not disclosed).
- **Single-active-turn CAS** (M14): a turn starts only by atomically acquiring the conversation's run slot. A double-send loser is rejected `409 OPERATOR_BUSY` — never queued, never run.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/conversations` | session | `{ title? }` (≤200 chars; default `"Untitled"`) | `{ id }` (201) |
| GET | `/conversations/recent` | session | — | `{ id }` — caller's most-recent conversation id, or `null` (cockpit auto-resume). |
| GET | `/conversations/:id` | session, owner | — | `{ id, title, activeRunId, messages: [...] }` — full thread (seeds the cockpit; the SSE is live-only). |
| GET | `/conversations/:id.md` | session, owner | — | `text/markdown` serialized thread. |
| GET | `/conversations/:id/stream` | session, owner | — | SSE live-tail (`event: message`, one frame per appended row). Owner-gated before subscription; rides `conversationBus` (no `events` rows, no replay / `Last-Event-Id`). |
| POST | `/conversations/:id/messages` | session, owner | `{ text }` (1–10000 chars) | `{ runId }` — appends the user message, acquires the M14 slot, kicks the runner. `409 OPERATOR_BUSY` if a turn is already active. |
| POST | `/conversations/:id/messages/:messageId/click` | session, owner | `{ optionId }` | a `choice_card` button click — see below. |

### Choice-card click (`POST /:id/messages/:messageId/click`)

The click sends the chosen option **id** (never label text — the label is operator-authored and must not re-enter as trusted input, M8). The id is validated against the card's recorded `options[].id` set, then one of three branches runs:

- **Confirmation card, "yes"** (`optionId` equals the card's `pending_op` id) → `confirmPendingOp` (single-use, caller-bound, M7), then start a turn so the operator re-issues the now-confirmed action → `{ confirmed: true, runId }`.
- **Confirmation card, "no"/`cancel`** → reject the backing pending op; no turn → `{ confirmed: false }`.
- **Ordinary card** → start a new turn reflecting the choice (re-fires the caller floor + M14 CAS) → `{ runId }`. A `cancel` on an ordinary card just locks the card → `{ confirmed: false }`.

### Errors specific to this surface

| Code | Status | When |
|---|---|---|
| `CONVERSATION_NOT_FOUND` | 404 | The id does not resolve to a conversation the session user owns. |
| `OPERATOR_BUSY` | 409 | A turn is already active on the conversation (M14 CAS loser). |
| `COMPONENT_NOT_FOUND` | 404 | `messageId` is not a component message on the conversation. |
| `NOT_A_CHOICE_CARD` | 400 | The targeted message is not a `choice_card`. |
| `ALREADY_CHOSEN` | 409 | The card has already been answered (single-use). |
| `OPTION_NOT_IN_SET` | 400 | `optionId` is not in the card's presented option set. |
| `PENDING_OP_EXPIRED` | 410 | A confirmation can no longer be applied (expired). |
| `PENDING_OP_NOT_CONFIRMABLE` | 409 | A confirmation can no longer be applied (replay / foreign-user). |

## Health (`/healthz`)

Unversioned. `GET /healthz` returns `{ ok: true, version: "0.0.1" }`.

## See also

- [`docs/MCP.md`](./MCP.md) — JSON-RPC MCP server at `/mcp`.
- [`docs/AGENTS.md`](./AGENTS.md) — agent document model.
- [`docs/TRIGGERS.md`](./TRIGGERS.md) — trigger document model.
- [`docs/FOLIO-BRIEFING.md`](./FOLIO-BRIEFING.md) — full PRD.
