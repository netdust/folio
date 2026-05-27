# Agents

Agents in Folio are documents with `type: 'agent'`. They are **workspace-scoped** (Phase 2.5): one agent serves every project in its workspace, narrowed by an explicit `projects:` allow-list in frontmatter. They have validated frontmatter, an auto-minted API token, and emit lifecycle events. The **runner** that actually executes them ships in Phase 3 — this document covers the surface (the data model + the lifecycle hooks).

## The document model

An agent is stored as a `documents` row with `type='agent'`, `workspace_id` set, and `project_id NULL` (the database CHECK constraint enforces this). Its body is the agent's system context (free-form markdown). Its frontmatter declares everything an executor needs to know — including which projects in the workspace it's allowed to act on.

```yaml
---
system_prompt: |
  You triage incoming bugs. Read the body for the latest playbook.
provider: anthropic
model: claude-sonnet-4-6
tools:
  - list_documents
  - get_document
  - update_document
projects:           # workspace project ids — defaults to ['*'] (every project)
  - 8VTeiptMzXIccnoH6V5cd
  - trJ0Tk3zt2jTbquu2FAmG
max_delegation_depth: 2
max_tokens_per_run: 10000
requires_approval: false
# Server-managed (do NOT set on input):
# api_token_id: tok_abc...
# parent_agent: triage-bot     # set when one agent creates another
---

# Triage Bot

When a new work item lands with status=new, ...
```

### Frontmatter schema

Source of truth: `apps/server/src/lib/agent-schema.ts` (`agentFrontmatterSchema`). Validated on POST and PATCH.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `system_prompt` | string (≥1) | ✅ | — | The persistent system context for the agent. |
| `model` | string (≥1) | ✅ | — | Model id passed to the provider. |
| `provider` | enum | ✅ | — | `anthropic \| openai \| openrouter \| ollama` |
| `tools` | string[] | ✅ | — | Whitelist of MCP tool names. Must be subset of `V1_MCP_TOOLS`. |
| `projects` | string[] | — | `['*']` | Project allow-list (workspace project ids). `['*']` = every project in this workspace. Wildcard cannot be mixed with explicit ids; `['*', 'abc']` is rejected at Zod parse time. |
| `max_delegation_depth` | int 0–5 | — | `2` | Maximum depth of agents this one can spawn. `0` means cannot delegate. |
| `max_tokens_per_run` | int 1–100000 | — | `10000` | Per-invocation token cap. Enforced by the Phase 3 runner. |
| `requires_approval` | boolean | — | `false` | Phase 3: the runner pauses for human approval before each action. |
| `api_token_id` | — | ✗ | — | **Server-managed.** Clients must NOT set this; the schema rejects input that includes it. |
| `parent_agent` | — | ✗ | — | **Server-managed.** Set by the delegation guard when one agent creates another. |

`tools[]` must reference tools from the canonical list in `packages/shared/src/mcp-tools.ts:V1_MCP_TOOLS` (re-exported by `apps/server/src/lib/agent-schema.ts` so server Zod and web UI consume the same source):

```
list_workspaces  list_projects  list_documents
get_document     get_document_markdown
create_document  update_document  delete_document
list_statuses    list_fields    list_views    run_view

# Comments (Phase 2.6)
create_comment   list_comments   update_comment   delete_comment

# Agent lifecycle (Phase 2.6 sub-phase D)
create_agent     update_agent    delete_agent     get_agent_self
```

### Tool groups (relevant for scope derivation)

- **Read** (`documents:read`) — `list_*`, `get_*`, `run_view`, `get_agent_self` (read-only metadata-on-self).
- **Write** (`documents:write`) — `create_document`, `update_document`, `create_comment`, `update_comment`.
- **Delete** (`documents:delete`) — `delete_document`, `delete_comment`.
- **Agent lifecycle** (`agents:write`) — `create_agent`, `update_agent`, `delete_agent`. Manage other agents (peer or sub-agent). `get_agent_self` is NOT in this group — it's a read-only `documents:read` tool.

## Creating an agent

Agents are workspace-scoped. POST to `/api/v1/w/:wslug/documents` (NOT the project-level URL — project-level POST with `type=agent` returns `422 INVALID_DOCUMENT_SCOPE` with a pointer to the correct URL):

```bash
curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "title": "Triage Bot",
    "frontmatter": {
      "system_prompt": "Triage incoming bugs.",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "tools": ["list_documents", "get_document", "update_document"],
      "projects": ["8VTeiptMzXIccnoH6V5cd"]
    }
  }' \
  http://localhost:3001/api/v1/w/netdust/documents
# → 201
# {
#   "data": {
#     "id": "...", "type": "agent", "workspaceId": "...", "projectId": null,
#     "frontmatter": { ..., "api_token_id": "tok_...", "projects": ["..."] },
#     "agent_token": "folio_pat_xxx"   ← copy this, you only see it ONCE
#   }
# }
```

Omit `projects` to get the default `['*']` (every project in the workspace, current and future).

## Auto-token lifecycle

When an agent is created, the server mints an `apiTokens` row bound to the agent via `agent_id` (an ON DELETE CASCADE FK on `documents.id` — deleting the agent revokes the token in the same transaction). Scopes are derived from `tools[]` via `toolsToScopes()`:

| If `tools[]` includes any of... | Scope granted |
|---|---|
| `list_*`, `get_*`, `run_view`, `get_agent_self` | `documents:read` |
| `create_document`, `update_document` | `documents:write` (+ implicit `documents:read`) |
| `delete_document` | `documents:delete` (+ implicit `documents:read`) |
| `create_agent`, `update_agent`, `delete_agent` | `agents:write` (+ implicit `documents:read`) |

**On `agents:write`:** granting an agent the `agents:write` scope lets it spawn or mutate other agents in the workspace. Treat with the same caution as `documents:delete`. The MCP layer additionally enforces an *allow-list propagation* rule (see below) to prevent a narrowly-scoped agent from creating or patching a broader-scoped peer.

### Allow-list propagation (Phase 2.6 sub-phase D)

When an agent calls `create_agent` or `update_agent` via MCP, the new (or patched) agent's `frontmatter.projects` allow-list **cannot exceed the calling agent's own**. Specifically:

- The calling agent's allow-list is read from its own `frontmatter.projects` (resolved via `token.agent_id`).
- If the caller's allow-list is `['*']`, anything goes.
- Otherwise, the patch's `projects` array must be a subset of the caller's. Widening to `'*'` is rejected. Adding a project id the caller doesn't have is rejected.
- Violations surface as MCP `-32602` with `data: { reason: 'allow_list_widening_forbidden' }`.

User-minted PATs (no `agent_id` on the token) are unrestricted today — Phase 3+ adds human-PAT enforcement when human PATs get a UI for narrowing.

`delete_agent` additionally rejects self-delete from an agent-bound token (`-32602` with `data: { reason: 'cannot_delete_self' }`). User-minted PATs can delete any agent in their workspace.

The token's `name` mirrors the agent's slug prefixed with `agent:`. Its `workspaceId` is the agent's workspace. `agent_id` is set to the agent's document id; `project_ids` is null by default (the agent's `frontmatter.projects` is the source of truth).

**Narrowing a token beyond its agent's allow-list:** Set `project_ids` on the token row to a subset of the agent's `frontmatter.projects`. The effective allow-list at request time is `intersect(agent.projects, token.project_ids ?? null)`. `null` on the token means "inherit"; `[]` means "no projects" (effectively revoked at the resource layer); an explicit array narrows. Tokens may narrow agent's bounds; **never** broaden.

**On agent deletion**, the auto-token is revoked via the cascade FK. Any client still using it immediately gets 401. The Phase 2 legacy explicit cleanup (by-frontmatter-`api_token_id`) remains as a safety net but the FK cascade is canonical. Source: `apps/server/src/services/documents.ts`.

## Per-request enforcement

Every project-scoped request (`/api/v1/w/:wslug/p/:pslug/*`) that arrives with a Bearer token bound to an agent is checked by the `requireResource` middleware (`apps/server/src/middleware/bearer.ts`). It:

1. Loads the agent doc and reads `frontmatter.projects`.
2. Intersects with the token's optional `project_ids`.
3. If `:pslug` resolves to a project NOT in the intersection, throws `403 FORBIDDEN_RESOURCE` with message `agent not allow-listed for project <pslug>`.

Session-authenticated requests (no Bearer token) bypass this check — workspace membership is the gate.

Human PATs (Bearer tokens without `agent_id`) ALSO bypass this check in Phase 2.5 — Phase 3+ adds enforcement once human PATs get a UI for narrowing.

## Assigning work to an agent

Work items use the `assignee` frontmatter key. For humans the value is the user's email. For agents the value is `agent:<slug>`:

```yaml
---
assignee: agent:triage-bot
priority: high
---
```

The web `AssigneePicker` (`apps/web/src/components/assignee/assignee-picker.tsx`) groups members and agents in the same Popover and writes the value in this format.

## Approval and rejection via comments

Mentioning an agent in a comment with an approval or rejection keyword triggers an `approvalIntent`. The detection rule is intentionally narrow to minimise false positives:

- `@<agent> approved` / `@<agent> rejected` at **position 1** always matches (case-insensitive; optional trailing `.,!;` is stripped).
- At **position 2**, the keyword matches only when position 1 is one of: `is, was, are, were, been, be, has, have, had, got, gets, just` — covering common constructions like `@drafter has approved`, `@drafter got approved`, `@drafter just approved the plan`.
- **Position 3+ never matches** (`@drafter looks approved to me` — no match).
- The **verb form** does not match (`@drafter please approve` — `approve` is not in the keyword set; only the past participle triggers intent).

## Delegation

Agents can create other agents either via the workspace-scoped HTTP endpoint (`POST /api/v1/w/:wslug/documents` with `type=agent`) or — as of Phase 2.6 sub-phase D — via the dedicated `create_agent` MCP tool. The generic `create_document` MCP tool still rejects `type=agent` with `-32602 agent_lifecycle_via_http_only`; use `create_agent` instead.

When an agent IS created, the delegation guard enforces:

- **Maximum chain depth = parent's `max_delegation_depth`**. The guard walks the `parent_agent` chain from the proposed child upward and refuses creation if the chain would exceed the parent's allowance.
- **No cycles.** A cycle in the parent chain throws.
- **No chains longer than 10 hops** total (hard cap independent of `max_delegation_depth`).

Source: `apps/server/src/lib/delegation-guard.ts`. When an agent-authed token creates an agent, the new agent's `parent_agent` frontmatter is auto-populated with the calling agent's slug. The depth ratchets downward via the parent's `max_delegation_depth`.

The delegation guard looks up agents at workspace scope (Phase 2.5: agents live at `documents.workspace_id`, not under any project).

## Lifecycle events

Three event kinds emit over SSE (`docs/API.md#events`):

| Kind | When | Payload |
|---|---|---|
| `agent.created` | After successful agent document insert | `{ slug, api_token_id }` (`projectId: null` on the event row) |
| `agent.deleted` | After agent document delete (token revoke via cascade FK) | `{ slug }` (`projectId: null` on the event row) |
| `agent.task.assigned` | When a work item's `frontmatter.assignee` transitions from null OR a different value to an `agent:<slug>` value | `{ document_slug, agent_slug, previous_assignee }` (event row carries the work item's `projectId`) |

`agent.task.assigned` is the trigger your Phase 3 runner (or any external listener) keys off of to know an agent has new work.

## Browsing in the UI

Agents and triggers are workspace-level infrastructure as of Phase 2.5. They're surfaced from the workspace popover (the workspace tile in the rail), NOT from the project rail. Project rails are content-only now: Tables · Views · Wiki.

- Click the workspace tile → **Agents** entry (Bot icon) → `/w/:wslug/agents` page.
- The agents page lists every workspace agent with project chips per row (one chip per id, resolved to current slug; wildcard renders as a single "All projects" chip; deleted-project ids render as muted `<prefix>·removed` chips).
- Click a project chip → page filters to agents allow-listed for that project (`?project=<id>`).
- `+ New agent` (header + empty-state) opens a slideover in create mode.
- Row click → opens the slideover for that agent (URL: `?doc=<slug>`).

The slideover's frontmatter form auto-renders three custom multi-select editors for agent docs (sourced by key name):
- `projects` → multi-select with "Select all" (wildcard) collapse semantics; never produces invalid `['*', ...ids]` shapes even transiently.
- `tools` → multi-select grouped Read / Write / Delete, sourced from `V1_MCP_TOOLS`.
- `provider` → one row that owns both `provider` + `model`. Provider select annotates each entry with "no key" badge when the workspace has no AI key configured. Model select hardcodes the Anthropic + OpenAI catalogue; OpenRouter + Ollama free-text.

Source: `apps/web/src/components/views/workspace-agents-page.tsx`, `apps/web/src/routes/w.$wslug.agents.tsx`, `apps/web/src/components/slideover/workspace-document-slideover.tsx`.

## What's NOT here yet

**Phase 2.6 (in progress):**
- **Background allow-list reconciler.** Periodic sweep that removes orphan project ids from `frontmatter.projects` arrays. Insurance against bugs in the transactional cascade hook + hand-edited MD + partial restore-from-backup. (Sub-phase E.)
- **Single-project `project_slug` arg inference.** Agents whose `projects:` has exactly one id can omit `project_slug` on MCP calls.
- **Workspace-scoped `.md` export.** Today the project slideover has Copy-as-MD; the workspace slideover doesn't (no `/api/v1/w/:wslug/documents/:slug.md` endpoint).

**Phase 2.6 shipped (Sub-phases A–D):**
- ActivityPanel + LogActivity on the workspace agent slideover (deferred Phase 2.5 ask, sub-phase A).
- Comments primitive (`comment` document type) + tabbed slideover + mention parser + `@`-picker (sub-phases A–C).
- Agent-lifecycle MCP tools (`create_agent` / `update_agent` / `delete_agent` / `get_agent_self`) with `agents:write` scope (sub-phase D).
- Built-in triggers auto-seeded per workspace (sub-phase D); structured trigger form in the UI (sub-phase D).

**Phase 2.7:**
- **Templates.** Instance-level Settings page for inert markdown templates with pinned-version sync (`template:` + `template_version:` references on instances).

**Phase 3:**
- **The runner.** Folio currently stores and authenticates agents but does not execute them. Phase 3 ships the runner that subscribes to `agent.task.assigned`, loads the agent's system prompt + tools, invokes the LLM, and writes results back.
- **`max_tokens_per_run` enforcement.** Stored but not yet honored.
- **`requires_approval` UI.** Stored but the approval flow ships with the runner.
- **The `## Approved` body convention.** Reserved for human-in-the-loop approval flow.
- **Human PAT `project_ids` enforcement.** Column exists from 2.5; enforcement waits until human PATs get a UI for narrowing.

## See also

- [`docs/MCP.md`](./MCP.md) — the tool surface agents use.
- [`docs/API.md`](./API.md) — REST equivalents.
- [`docs/TRIGGERS.md`](./TRIGGERS.md) — cron/event-driven triggers that wake agents.
- `apps/server/src/lib/agent-schema.ts` — frontmatter schema + tool scopes (re-exports `V1_MCP_TOOLS` from `@folio/shared`).
- `apps/server/src/lib/delegation-guard.ts` — parent-chain walker.
- `apps/server/src/services/documents.ts` — auto-mint + revoke implementation.
- `apps/server/src/routes/workspace-documents.ts` — workspace-scoped CRUD routes (Phase 2.5).
- `apps/server/src/middleware/bearer.ts` — `requireResource` middleware + `intersect()` helper (Phase 2.5).
- `packages/shared/src/mcp-tools.ts` — `V1_MCP_TOOLS` + `MCP_TOOL_GROUPS` (single source of truth).
