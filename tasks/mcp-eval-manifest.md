# MCP-only eval — bug + usability manifest

**Date:** 2026-06-09 | **Method:** drove the hardened `/mcp` JSON-RPC endpoint as an external
client (curl, full-scope instance PAT, isolated DB on :3099) through realistic
multi-table project-management flows. Goal: find bugs AND assess whether the MCP
tool/skill surface makes these flows easy & quick (MCP-only).

## Setup
- Isolated DB `apps/server/mcp-eval.db`, hermetic server :3099 (live dev env untouched).
- Seed: 1 workspace `main`, 1 project `webproject` (default work-items table), full-scope
  instance MCP token. Everything else built via MCP.
- Driver: `scripts/mcp-eval-setup.ts` (reseed + mint). Skill loaded via `get_skill('folio')`.

---

## BUGS

### B1 — [HIGH] MCP tools and HTTP routes disagree on a project's "default table"; the MCP rule is non-deterministic
**The headline finding.** Two different default-table resolvers exist for the same concept:

| Surface | Rule | Site |
|---|---|---|
| HTTP routes (`folio_api`, browser) | pinned `slug === 'work-items'` | `middleware/scope.ts:119-120` |
| MCP registry tools (`list_views`, `list_statuses`, `list_fields`, `run_view`, `create_document`) | `ORDER BY order ASC LIMIT 1` | `lib/agent-tools-registry.ts:318-320` (`resolveTableForArgs`) |

**Reproduced live:** after creating a 2nd table `bugs` in `webproject`, the SAME bare-path call returns different tables:
- HTTP `GET …/p/webproject/statuses` → `[backlog, todo, in_progress, done]` (**work-items** ✓)
- MCP `list_statuses(webproject)` → `[fixed, open, triaged]` (**bugs** ✗)

**Why it bites:** `create_document` (MCP) uses `resolveTableForArgs`, so a work_item created without
`table_slug` lands in whatever the order-resolver picks — which after a 2nd table is NOT necessarily
work-items. `list_views`/`run_view` then read a different table than the one a sibling write hit.
During the eval this made a freshly-created kanban view appear DELETED (`list_views → []`) and made
`run_view(view_id)` fail with `view_not_found`, because the read resolved to the bugs table while the
view lived on work-items.

**Compounding defect B1a — tables get no unique `order`:** `routes/tables.ts:78` sets
`order: input.order ?? 0`, so BOTH tables had `order: 0`. The MCP resolver's `ORDER BY order ASC
LIMIT 1` is therefore a **non-deterministic tie** — it can flip between tables run-to-run.

**Compounding defect B1b — even the tiebreak diverges:** the tables LIST route uses
`asc(order), asc(createdAt)` (stable); `resolveTableForArgs` uses `asc(order)` only (no createdAt
tiebreak). So the two resolvers can't even agree among tied rows.

**Compounding defect B1c — the skill actively misleads:** `system-skills.ts:156` tells the agent
"tables/fields/views/statuses paths target the project's `work-items` table unless you insert
`/t/<tslug>`." That's true for HTTP but FALSE for the MCP tools the same skill tells the agent to
use. An agent trusting the skill will silently operate on the wrong table after a 2nd table exists.

**Fix direction (one of):** make `resolveTableForArgs` pin to `slug === 'work-items'` (match HTTP +
the skill), OR mark one table `is_default` and resolve on that, OR auto-increment `order` on table
create AND add the `createdAt` tiebreak to the resolver AND fix the skill text. Pinning to
work-items is the cheapest and matches the documented contract.

### B2 — [MEDIUM] A new table created via MCP has NO statuses; `create_document` into it silently yields status-less, unkanban-able items
A 2nd table (`folio_api POST …/tables`) is created with zero statuses (`seedProjectDefaults` runs only
at PROJECT creation). `create_document(table_slug:'bugs')` then returned items with `status: null` —
accepted with no warning. Those items can't appear on a kanban board (no columns). An MCP agent asked
to "add a Bugs table and put bugs in it" produces an empty, status-less table unless it independently
knows to seed statuses first. Consider: auto-seed default statuses on table create, OR have
create_document warn/refuse when the target table has no statuses.

---

## USABILITY / SKILL FINDINGS (not bugs, but friction)

### U1 — [LOW] view `type` enum is `list|kanban`, but the natural/used word is "board"
`folio_api POST …/views {type:"board"}` → 400 (Zod: expected `list|kanban`). The hardening pass &
UI use "board" (STATE.md: "navigates to /board"); the skill says "Kanban" but never pins the enum
value. Self-correcting (the Zod error lists the options) but costs a round-trip. Fix: skill should
state `type: "kanban"` verbatim in the views recipe.

### U2 — [INFO] no `create_workspace`/`create_project`/`create_table` narrow tools — by design
Structural creation goes through the general `folio_api` primitive (Claude-Code-shaped: few general
tools + skill). This is the intended model and works. WORTH NOTING for onboarding: an agent that
doesn't load the skill first won't discover that projects/tables are made via `folio_api` POST — the
`initialize` instructions DO point at `get_skill('folio')`, which mitigates this well.

### U4 — [MEDIUM] an MCP-only HUMAN operator cannot CREATE an agent (only run existing ones)
"Trigger agents via MCP" hits a wall on creation. Both agent-creation paths reject a human PAT
(an instance MCP token IS a human PAT):
- `create_document type:agent` → `mcpInvalidParams` "must be created via the workspace-scoped HTTP
  endpoint; not available via MCP in Phase 2.5"
- `create_agent` → `-32000 "agent-lifecycle tools require an agent-bound bearer; human PATs are
  rejected"` (`human_pat_rejected_on_agent_lifecycle`)

BUT `run_agent` does NOT reject a human PAT (it accepted the call, failed only on agent-not-found).
So the boundary is: **a human MCP operator can RUN/trigger an existing agent, but cannot CREATE one
via MCP** — agents must be created in-app (browser/HTTP) first. This is a coherent, defensible
security posture (agent lifecycle = agent-bound or in-app only), but it means the cold "set up and
trigger an agent entirely via MCP" flow is NOT achievable. Worth either (a) documenting this clearly
in the skill (the skill should say "create agents in-app; MCP can run them"), or (b) allowing an
admin/owner human PAT with `agents:write` to create agents via MCP (it already holds the scope; the
gate is currently agent-bound-bearer, not scope-based). Errors are well-shaped and clear.

### B1 confirmed on a SECOND fresh project (Scenario 2 — Holiday) — and it BREAKS basic CRUD, not just reads
On project `holiday` (work-items + a 2nd `packing` table, both `order:0`), the MCP resolver
consistently picked `packing`: `list_statuses` → `[]` (3× deterministic this run), and crucially
**`create_document{status:"todo"}` with NO table_slug FAILED** with `-32603 "status \"todo\" not in
registry" / INVALID_STATUS` — because it routed to the status-less `packing` table. The SAME call
with `table_slug:"work-items"` succeeded. So the user's plain "add a work item to the holiday
project" request **errors out** after a 2nd table exists, with a misleading status-error that hides
the real cause (wrong table). This upgrades B1's user impact from "silent mis-route" to "breaks the
most basic CRUD op with a confusing error." (Project-create DID auto-seed work-items+statuses
correctly — B2 is specific to secondary tables.)

### U3 — [INFO, positive] the `folio` skill is genuinely good
Two-rails (CRUD vs Build) guidance, call-frugality habits, exact paths, the `/w/`+`/p/` shorthand
gotcha, dryRun, frontmatter-is-schema. The `initialize` response proactively tells the client to load
it. This is the right shape — the B1c defect is that ONE concrete claim in it is wrong, not that the
skill is bad.

---

## What worked cleanly (no bugs)
- MCP handshake, `tools/list` (33 tools), `get_skill`, scope-checked auth, shaped errors.
- `create_document` work_items, `update_document` status moves (kanban transitions) + assignee writes.
- `folio_api` create-view (kanban), create-table, create-status — all 201.
- `folio_api_get` reads. Sanitized JSON-RPC errors (`-32602` with `reason`, no internal leak) — the
  M-MCP hardening is holding.
