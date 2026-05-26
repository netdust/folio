# Triggers

Triggers in Folio are documents with `type: 'trigger'`. They declare WHEN an agent should run — either on a cron schedule or in response to a specific event kind. Like agents, triggers are **workspace-scoped** (Phase 2.5) and **inherit their project allow-list from the referenced agent** (no separate `projects:` field on triggers). The **scheduler/matcher ships in Phase 3** — this document covers the surface (the data model + validation rules).

## The document model

A trigger is a `documents` row with `type='trigger'`, `workspace_id` set, and `project_id NULL` (the CHECK constraint enforces this). Its body is free-form notes; everything operational is in frontmatter.

```yaml
---
agent: triage-bot
schedule: 0 9 * * 1     # Mondays at 09:00
on_event: null
event_filter: null
payload: null
enabled: true
# Server-managed (do NOT set on input):
# last_fired_at: 2026-05-25T09:00:00Z
# last_status: ok
---

# Weekly triage run

Runs every Monday morning so the team starts the week with a clean board.
```

Or event-driven:

```yaml
---
agent: triage-bot
schedule: null
on_event: document.created
event_filter:
  type: work_item
  status: new
payload:
  note: Triage on intake
enabled: true
---
```

## Frontmatter schema

Source of truth: `apps/server/src/lib/trigger-schema.ts` (`triggerFrontmatterSchema`). Validated on POST and PATCH.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `agent` | string (≥1) | ✅ | — | Slug of the agent to invoke. |
| `schedule` | cron string \| null | ✗ | — | Five-field cron. Validated for shape (see below). |
| `on_event` | event kind \| null | ✗ | — | One of `KNOWN_EVENT_KINDS`. |
| `event_filter` | object \| null | — | `null` | Mongo-ish predicate over the event payload (Phase 3 will compile against the same AST as view filters). |
| `payload` | object \| null | — | `null` | Arbitrary blob passed to the agent on each invocation. |
| `enabled` | boolean | — | `true` | `false` disables without deleting. |
| `last_fired_at` | — | ✗ | — | **Server-managed.** Schema rejects client input. |
| `last_status` | — | ✗ | — | **Server-managed.** |

**Mutex rule:** at least one of `schedule` or `on_event` must be non-null. A trigger with both null is rejected with `trigger must have at least one of schedule or on_event`.

**Project scope:** triggers don't carry a `projects:` field. They inherit from the referenced `agent`'s `frontmatter.projects` allow-list. A trigger fires once per project in the agent's allow-list (Phase 3 runner behavior — the surface stores the trigger, the runner walks the agent's allow-list at fire time).

## Cron validation

Folio validates cron expressions **structurally only**. It checks five whitespace-separated fields and that each field contains only `[0-9*,/-]`. It does NOT evaluate semantic correctness (e.g. "31 * * * *" passes shape but won't fire in February). Phase 3's scheduler does the real cron parse.

Source: `validateCronShape()` in `apps/server/src/lib/trigger-schema.ts`. Invalid shapes return 422 with `code: invalid_form_input` and message `invalid cron expression`.

Examples:

| Cron | Valid? | Note |
|---|---|---|
| `0 9 * * 1` | ✅ | Mondays at 09:00 |
| `*/15 * * * *` | ✅ | Every 15 minutes |
| `0 9 * * 1-5` | ✅ | Weekdays at 09:00 |
| `hello world` | ❌ | Not 5 fields |
| `0 9 * * Mon` | ❌ | Contains alpha (`Mon`) — use `1` instead |
| `0 9 * *` | ❌ | Only 4 fields |

## Known event kinds

The full list lives in `KNOWN_EVENT_KINDS` (`apps/server/src/lib/trigger-schema.ts`). `on_event` must be exactly one of these strings:

```
document.created   document.updated   document.deleted
status.created     status.updated     status.deleted
field.created      field.updated      field.deleted
view.created       view.updated       view.deleted
table.created      table.updated      table.deleted
project.created    project.updated    project.deleted
workspace.created  workspace.updated
activity.logged
agent.created      agent.deleted      agent.task.assigned
```

Same list emits over the SSE event stream (`docs/API.md#events`).

## Event filter (`event_filter`)

A predicate against the event payload. v1 stores the object verbatim; Phase 3's matcher will compile it to an evaluation function using the same compiler as view filters (`packages/shared/src/filter-compile.ts`). Shape examples (these are stored, not yet evaluated):

```yaml
# Match document.created where the new doc is a work_item with status=new
on_event: document.created
event_filter:
  type: work_item
  status: new

# Match document.updated where priority transitioned to "high"
on_event: document.updated
event_filter:
  changes:
    $contains: priority
  frontmatter.priority: high
```

If `event_filter` is `null`, every event of the configured kind fires the trigger.

## Creating a trigger

Triggers are workspace-scoped. POST to `/api/v1/w/:wslug/documents` (NOT the project-level URL — same rejection contract as agents: `422 INVALID_DOCUMENT_SCOPE`):

```bash
curl -X POST -H "Cookie: $COOKIE" -H "Content-Type: application/json" \
  -d '{
    "type": "trigger",
    "title": "Weekly triage",
    "frontmatter": {
      "agent": "triage-bot",
      "schedule": "0 9 * * 1",
      "on_event": null
    }
  }' \
  http://localhost:3001/api/v1/w/netdust/documents
# → 201
```

The trigger must reference a workspace agent by slug (`agent: triage-bot`). The runner will resolve the slug at fire time and walk that agent's allow-list to know which projects to fire against.

## Browsing in the UI

Triggers (and agents) are surfaced from the **workspace popover** as of Phase 2.5, NOT from the project rail. Click the workspace tile in the rail → **Triggers** entry (Zap icon) → `/w/:wslug/triggers` page. Source: `apps/web/src/components/views/workspace-triggers-page.tsx` + `apps/web/src/routes/w.$wslug.triggers.tsx`.

The page lists every workspace trigger with the referenced agent's title and the schedule/event pill. Click a row to edit its frontmatter in the workspace slideover.

`+ New trigger` requires at least one workspace agent to exist — the trigger's `agent` field needs a valid slug to satisfy the Zod schema. The empty-state shows a toast when no agents exist.

## What's NOT here yet

**Phase 2.6:**
- **Structured trigger form.** Today's slideover uses the generic FrontmatterForm — round-trips correctly but doesn't pretty-render cron or offer an event-kind dropdown. The form still works; it just looks like raw frontmatter rather than a domain editor.

**Phase 3:**
- **The scheduler.** Folio currently stores triggers but does not fire them. Phase 3 ships:
  - A cron loop that wakes up every minute and fires `schedule`-typed triggers whose cron matches the current time.
  - An event-bus subscriber that fires `on_event`-typed triggers and compiles+evaluates `event_filter`.
  - Fanout: each trigger fires once per project in the referenced agent's allow-list.
- **`payload` delivery.** Stored on the trigger but not yet passed to the agent on invocation.
- **`enabled: false` honoring.** Stored, not yet read by anything.
- **`last_fired_at` / `last_status` writes.** The fields are server-managed but only become meaningful once the scheduler is writing them.

**Phase 3.5 (drafted, not yet implemented):**
- **Non-agent trigger actions.** Currently a trigger MUST fire an agent. Phase 3.5 opens the action surface so triggers can also POST to a webhook URL or run a script. See `docs/PHASES.md` § Phase 3.5 for the draft.

## See also

- [`docs/AGENTS.md`](./AGENTS.md) — what triggers wake up + how the project allow-list (inherited from the agent) works.
- [`docs/API.md`](./API.md) — REST CRUD for triggers via the workspace-scoped `/api/v1/w/:wslug/documents` endpoints.
- [`docs/MCP.md`](./MCP.md) — agents can read/list triggers via the same tools they use for any document. Lifecycle (`create_document` with `type=trigger`) is rejected at MCP in Phase 2.5 — HTTP-only.
- `apps/server/src/lib/trigger-schema.ts` — schema + cron validator + event-kind whitelist.
- `apps/server/src/routes/workspace-documents.ts` — workspace-scoped CRUD (shared with agents).
