# Triggers

Triggers in Folio are documents with `type: 'trigger'`. They declare WHEN an agent should run — either on a cron schedule or in response to a specific event kind. Like agents, the **scheduler/matcher ships in Phase 3** — this document covers the surface (the data model + validation rules).

## The document model

A trigger is a regular `documents` row with `type='trigger'`. Its body is free-form notes; everything operational is in frontmatter.

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

## Browsing in the UI

The rail has a **Triggers** leaf under every project (right of Agents). Source: `apps/web/src/lib/rail-tree.ts` + `apps/web/src/routes/w.$wslug.p.$pslug.triggers.tsx`. Click a trigger to edit its frontmatter in the slideover.

## What's NOT here yet (Phase 3)

- **The scheduler.** Folio currently stores triggers but does not fire them. Phase 3 ships:
  - A cron loop that wakes up every minute and fires `schedule`-typed triggers whose cron matches the current time.
  - An event-bus subscriber that fires `on_event`-typed triggers and compiles+evaluates `event_filter`.
- **`payload` delivery.** Stored on the trigger but not yet passed to the agent on invocation.
- **`enabled: false` honoring.** Stored, not yet read by anything.
- **`last_fired_at` / `last_status` writes.** The fields are server-managed but only become meaningful once the scheduler is writing them.

## See also

- [`docs/AGENTS.md`](./AGENTS.md) — what triggers wake up.
- [`docs/API.md`](./API.md) — REST CRUD for triggers (same shape as any document).
- [`docs/MCP.md`](./MCP.md) — agents can read/list triggers via the same tools they use for any document.
- `apps/server/src/lib/trigger-schema.ts` — schema + cron validator + event-kind whitelist.
