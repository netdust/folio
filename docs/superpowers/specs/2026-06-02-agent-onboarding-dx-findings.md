# Agent-onboarding DX findings (cold external-agent test)

_2026-06-02. A cold external AI agent connected to the live Folio instance over MCP with ZERO prior knowledge and oriented itself. Verdict: **8/10** — a complete, accurate workspace mental model in **2 tool calls** (`list_workspaces` → `describe_workspace`), content depth in 4 more. The wins (one-call orientation, trap-steering descriptions, frontmatter-as-schema + markdown round-trip all legible to the agent) confirm the "agent is the power user" thesis. The findings below are the polish gaps it hit — none blocked it; all are agent-DX improvements. #1 and #3 directly inform the Phase-3 `folio` skill + memory content._

## Findings (backlog — not yet scheduled)

### AGENT-DX-1 — `relation` field exposes a raw target-table ID, not a slug/name
The `others` relation field returned `options: ["table:1HAo5bEAE5m0CIThU-fAz", "single"]` — the target table encoded as a raw internal ID. A cold agent has to reverse-map that ID to know what the relation points at (it happened to be the same `work-items` table). **Fix direction:** in the agent-facing serialization of a `relation` field (MCP `list_fields` + the document frontmatter the agent reads), resolve `table:<id>` → `table:<slug>` (or include a resolved `target_table_slug`/`target_table_name`). The internal ID can stay the source of truth; the agent surface should be slug-addressable (consistent with the rest of the API, which is slug-first). Origin: relation-fields shipped 2026-05-31 kept the internal ID on the agent surface.

### AGENT-DX-2 — `status: null` is ambiguous (unset vs N/A)
Many documents return `"status": null`, which maps to none of the table's status keys. A cold agent can't tell "no status set" from "status not applicable." **Fix direction:** decide + document the semantics (almost certainly "unset"), and surface it explicitly — either a sentinel the agent can recognize, or document in the `folio` skill that `null` = unset and is a valid, common state. Cheapest fix is documentation in the skill (Phase 3); a sentinel is a larger API change, probably not worth it.

### AGENT-DX-3 — no surfaced "who am I / what is this instance" entry point
The agent oriented on *data* shape fine but wanted (a) its own token scope/permissions and (b) an instance/workspace description — and nothing in the tool descriptions pointed it there. `get_agent_self` EXISTS but no description steers a cold agent to call it first. **Fix direction:** this is squarely the **Phase-3 `folio` skill + 2-layer memory** job — the skill is the "what is this / how do I" manual, and `workspace_profile.md` is the curated instance context. Also consider: mention `get_agent_self` in the orientation-tool descriptions ("call describe_workspace AND get_agent_self to learn the workspace shape and your own scope"). Low-cost description tweak + the Phase-3 skill closes this fully.

### AGENT-DX-4 — test/junk records indistinguishable from real ones
The instance contains junk (`Untitled` ×3, `test`, `testing`, a page whose body ends in a stray `hello world` appended to real content). A cold agent can't distinguish fixtures from real work — no `archived`/`draft`/`status` signal separates them. **Fix direction:** partly instance hygiene (this is a dev DB), partly product — consider whether a `draft`/`archived` frontmatter convention should be a documented agent-visible signal (the `folio_system: true` hidden-doc flag from Phase 3 is the same mechanism class). Low priority; mostly resolves when real instances aren't full of dev fixtures.

### AGENT-DX-5 (mild) — `describe_workspace` lists the `runs` table but `list_documents` can't read it
`describe_workspace` shows `client-website` has a `runs` table, but `list_documents` returns only `work_item` + `page` (runs are walled off — security; read via `list_runs`). The `list_documents` description WARNS about this ("runs → list_runs"), so the trap is defused, but the shape call and the listing call disagree on what's reachable. **Fix direction:** acceptable as-is (the description steers correctly). Optional: `describe_workspace` could annotate the `runs` table as "read via list_runs" so the two calls agree. Lowest priority.

## How these feed the roadmap
- **#1 (relation slug)** — small server change to the agent-facing field serialization; do as a standalone agent-DX fix OR fold into Phase 3 (the skill documents relation fields anyway).
- **#2, #3, #4** — primarily **Phase-3 `folio` skill + memory** content (the orientation narrative the agent lacked). The cold-agent test validated that Folio's *data* is legible; what's missing is the *self-orientation layer*, which is exactly Phase 3's job. Confirms the Phase-3 thesis.
- **#5** — optional polish, no action required.

_Full evaluation transcript: the cold-agent run reached a usable mental model in 2 calls; rated 8/10; standout win = `describe_workspace` one-call orientation + trap-steering tool descriptions._
