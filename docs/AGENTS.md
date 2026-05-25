# Agents

Agents in Folio are documents with `type: 'agent'`. They have validated frontmatter, an auto-minted API token, and emit lifecycle events. The **runner** that actually executes them ships in Phase 3 — this document covers the surface (the data model + the lifecycle hooks).

## The document model

An agent is stored as a regular `documents` row with `type='agent'`. Its body is the agent's system context (free-form markdown). Its frontmatter declares everything an executor needs to know.

```yaml
---
system_prompt: |
  You triage incoming bugs. Read the body for the latest playbook.
model: claude-sonnet-4-6
provider: anthropic
tools:
  - list_documents
  - get_document
  - update_document
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
| `max_delegation_depth` | int 0–5 | — | `2` | Maximum depth of agents this one can spawn. `0` means cannot delegate. |
| `max_tokens_per_run` | int 1–100000 | — | `10000` | Per-invocation token cap. Enforced by the Phase 3 runner. |
| `requires_approval` | boolean | — | `false` | Phase 3: the runner pauses for human approval before each action. |
| `api_token_id` | — | ✗ | — | **Server-managed.** Clients must NOT set this; the schema rejects input that includes it. |
| `parent_agent` | — | ✗ | — | **Server-managed.** Set by the delegation guard when one agent creates another. |

`tools[]` must reference tools from the canonical list in `apps/server/src/lib/agent-schema.ts:V1_MCP_TOOLS`:

```
list_workspaces  list_projects  list_documents
get_document     get_document_markdown
create_document  update_document  delete_document
list_statuses    list_fields    list_views    run_view
```

## Auto-token lifecycle

When an agent is created, the server mints an `apiTokens` row for it. Scopes are derived from `tools[]` via `toolsToScopes()`:

| If `tools[]` includes any of... | Scope granted |
|---|---|
| `list_*`, `get_*`, `run_view` | `documents:read` |
| `create_document`, `update_document` | `documents:write` (+ implicit `documents:read`) |
| `delete_document` | `documents:delete` (+ implicit `documents:read`) |

The plaintext token is returned **exactly once** in the POST response as `agent_token`:

```bash
curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "title": "Triage Bot",
    "frontmatter": {
      "system_prompt": "Triage incoming bugs.",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "tools": ["list_documents", "get_document", "update_document"]
    }
  }' \
  http://localhost:3001/api/v1/w/netdust/p/folio/documents
# → 201
# {
#   "data": {
#     ...document fields...,
#     "frontmatter": { ..., "api_token_id": "tok_..." },
#     "agent_token": "folio_pat_xxx"   ← copy this, you only see it ONCE
#   }
# }
```

The token's `name` mirrors the agent's title prefixed with `agent:`. Its `workspaceId` is the workspace of the project the agent lives in.

**On agent deletion**, the auto-token is revoked from `apiTokens`. Any client still using it immediately gets 401. Source: `apps/server/src/services/documents.ts`.

## Assigning work to an agent

Work items use the `assignee` frontmatter key. For humans the value is the user's email. For agents the value is `agent:<slug>`:

```yaml
---
assignee: agent:triage-bot
priority: high
---
```

The web `AssigneePicker` (`apps/web/src/components/assignee/assignee-picker.tsx`) groups members and agents in the same Popover and writes the value in this format.

## Delegation

Agents can create other agents via `create_document` (when their token has `documents:write`). The delegation guard enforces:

- **Maximum chain depth = parent's `max_delegation_depth`**. The guard walks the `parent_agent` chain from the proposed child upward and refuses creation if the chain would exceed the parent's allowance.
- **No cycles.** A cycle in the parent chain throws.
- **No chains longer than 10 hops** total (hard cap independent of `max_delegation_depth`).

Source: `apps/server/src/lib/delegation-guard.ts`. When an agent-authed token creates an agent, the new agent's `parent_agent` frontmatter is auto-populated with the calling agent's slug. The depth ratchets downward via the parent's `max_delegation_depth`.

## Lifecycle events

Three event kinds emit over SSE (`docs/API.md#events`):

| Kind | When | Payload |
|---|---|---|
| `agent.created` | After successful agent document insert | `{ slug, api_token_id }` |
| `agent.deleted` | After agent document delete (token revoke included) | `{ slug }` |
| `agent.task.assigned` | When a work item's `frontmatter.assignee` transitions from null OR a different value to an `agent:<slug>` value | `{ document_slug, agent_slug, previous_assignee }` |

`agent.task.assigned` is the trigger your Phase 3 runner (or any external listener) keys off of to know an agent has new work.

## Browsing in the UI

The rail has an **Agents** leaf under every project (left of Triggers). Source: `apps/web/src/lib/rail-tree.ts` + `apps/web/src/routes/w.$wslug.p.$pslug.agents.tsx`. Click an agent to open the slideover and edit its system prompt + frontmatter.

## What's NOT here yet (Phase 3)

- **The runner.** Folio currently stores and authenticates agents but does not execute them. Phase 3 ships the runner that subscribes to `agent.task.assigned`, loads the agent's system prompt + tools, invokes the LLM, and writes results back.
- **`max_tokens_per_run` enforcement.** Stored but not yet honored.
- **`requires_approval` UI.** Stored but the approval flow ships with the runner.
- **The `## Approved` body convention.** Reserved for human-in-the-loop approval flow.

## See also

- [`docs/MCP.md`](./MCP.md) — the tool surface agents use.
- [`docs/API.md`](./API.md) — REST equivalents.
- [`docs/TRIGGERS.md`](./TRIGGERS.md) — cron/event-driven triggers that wake agents.
- `apps/server/src/lib/agent-schema.ts` — frontmatter schema + tool scopes.
- `apps/server/src/lib/delegation-guard.ts` — parent-chain walker.
- `apps/server/src/services/documents.ts` — auto-mint + revoke implementation.
