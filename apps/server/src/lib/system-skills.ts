/**
 * Phase A — System Library Foundation, Task 3.
 *
 * A pure CONTENT module: exported string/const definitions only — NO logic, NO
 * db, NO functions. Later tasks (the system-library seeder/loader) import these
 * to materialize the `folio` skill, the `folio-operator` agent, and the
 * "set up a project" reference page into the __system workspace.
 *
 * Provenance: the skill body + operator prompt are adapted from the
 * already-reviewed content on tag `archive/phase-op-3-seeded-bot`
 * (apps/server/src/lib/seed-operator.ts). Phase-A adjustments:
 *   - the 2-layer memory protocol is REMOVED (that was the seeded-bot model,
 *     since reset). No `__folio_memory_log` / `__folio_workspace_profile`.
 *   - the operator reads the skill at slug `'folio'` (NOT `__folio_skill`).
 *   - no `__folio_*` magic slugs anywhere. The operator is identified by
 *     (workspace=__system, type='agent'), not a reserved doc slug.
 */

import { V1_MCP_TOOLS } from '@folio/shared';

/**
 * The skill's slug. `get_document` resolves the skill by this slug; the operator
 * prompt references it by name. Plain human slug — not `__`-prefixed.
 */
export const FOLIO_SKILL_SLUG = 'folio';

/**
 * The operator agent's TITLE. createDocument slugifies it to 'folio-operator'.
 * There is NO reserved doc slug — the operator is identified by
 * (workspace=__system, type='agent').
 */
export const OPERATOR_AGENT_TITLE = 'folio-operator';

/**
 * The operator's tool whitelist (becomes the agent's frontmatter.tools). Exported
 * so the seeder, the token-scope computation, and the tests share ONE source of
 * truth. Every member MUST be a V1_MCP_TOOLS entry (enforced by the test).
 */
export const OPERATOR_TOOLS = [
  'folio_api',
  'folio_api_get',
  'list_documents',
  'get_document',
  'create_document',
  'update_document',
  'list_projects',
  'run_view',
  // Piece B — pull a skill from the __system library before shaping a workspace.
  'get_skill',
  // Piece B (T8) — the operator is the system-origin (createdBy null) principal,
  // so it is the live blesser for __system skills. canBlessSkill gates the flip.
  'set_skill_trust',
] as const;

// Compile-time guard: every OPERATOR_TOOLS member is a real MCP tool. Mirrors the
// runtime test, but catches drift at typecheck time too.
type _AssertOperatorToolsAreMcpTools =
  (typeof OPERATOR_TOOLS)[number] extends (typeof V1_MCP_TOOLS)[number] ? true : never;
const _operatorToolsAreMcpTools: _AssertOperatorToolsAreMcpTools = true;
void _operatorToolsAreMcpTools;

/**
 * FOLIO_SKILL_BODY — the `folio` skill: the API manual. Documents the REAL
 * routes/scopes/risk-tiers so the operator drives Folio's general controls as a
 * power user instead of reaching for invented endpoints. Materialized as a
 * document in the __system workspace; the operator reads it like any other page.
 *
 * Adapted from the reviewed `SKILL_BODY` on archive/phase-op-3-seeded-bot, minus
 * the memory protocol (§5 "The memory protocol") and all `__folio_*` references.
 */
export const FOLIO_SKILL_BODY = `# Folio skill — the API manual

> **Governing principle:** The API is the source of truth; this skill documents it. When this skill and the routes disagree, the routes win — verify with \`folio_api_get\`.

## 1. What you are

You are a power user driving Folio's *general controls*, not a menu of fixed verbs. Folio is markdown-native: every work item and page is a \`.md\` document with YAML frontmatter, stored in SQLite. You shape projects, tables, fields, views, statuses, and documents by calling the real REST API through a small set of general tools. Reason freely; your permission is always scoped (see §6).

## 2. The tools

- **\`folio_api_get\`** — ALL reads. It is GET-forced (the method is fixed to GET regardless of what you pass) and maps to the \`documents:read\` scope. Use it to inspect any resource before changing it.
- **\`folio_api\`** — writes (POST/PATCH/DELETE) to *config* resources (tables, fields, views, statuses, projects). Maps to \`config:write\` and passes through the risk gate (§6).
- **Narrow document tools** — \`get_document\`, \`list_documents\`, \`create_document\`, \`update_document\` (scopes \`documents:read\` / \`documents:write\`), plus \`list_projects\` and \`run_view\`. Prefer these for documents and when they fit; they are clearer than raw API calls.

Rule of thumb: **documents** → narrow tools; **structure/config** (tables, fields, views, statuses, projects) → \`folio_api\` / \`folio_api_get\`.

### Path format for folio_api

Paths are relative and validated — no scheme, no \`..\` traversal, no SSE \`/events\`:

\`\`\`
/api/v1/w/<wslug>/p/<pslug>/<resource>
\`\`\`

## 3. Resource → route → scope

| Resource | Path | Verbs | Scope | dryRun |
|----------|------|-------|-------|--------|
| projects | \`/api/v1/w/<wslug>/projects\` | GET, POST, PATCH, DELETE | GET=read · write=\`config:write\` | yes |
| tables | \`/api/v1/w/<wslug>/p/<pslug>/tables\` | GET, POST, PATCH, DELETE | GET=read · write=\`config:write\` | yes |
| fields | \`/api/v1/w/<wslug>/p/<pslug>/fields\` | GET, POST, PATCH, DELETE | GET=read · write=\`config:write\` | yes |
| views | \`/api/v1/w/<wslug>/p/<pslug>/views\` | GET, POST, PATCH, DELETE | GET=read · write=\`config:write\` | yes |
| statuses | \`/api/v1/w/<wslug>/p/<pslug>/statuses\` | GET, POST, PATCH, DELETE | GET=read · write=\`config:write\` | yes |
| documents | (use the narrow tools) | get/list/create/update | \`documents:read\` / \`documents:write\` | n/a |

- Config **reads** go through \`folio_api_get\`; config **writes** through \`folio_api\`.
- **dryRun** on config writes: POST/PATCH pass \`"dryRun": true\` in the body; DELETE passes \`?dryRun=true\` in the query. You get back \`{ dry_run, would, resource }\` with ZERO writes.
- Documents are read/written via the narrow tools, never \`folio_api\`.

## 4. Schema conventions

- **Frontmatter is the schema.** Only \`title\`, \`status\`, and \`body\` are real columns. EVERYTHING else (\`priority\`, \`assignee\`, \`due_date\`, \`labels\`, anything custom) lives in the document's frontmatter JSON. To "add a field" you simply write that key into frontmatter — no migration.
- **snake_case** for all frontmatter keys (\`due_date\`, not \`dueDate\`).
- **Field types are inferred from values** on read. To pin a type explicitly (so the UI renders it consistently), create a row in the project's \`fields\` table via \`folio_api\`.
- **Two document types:**
  - \`work_item\` — a kanban-able task. Requires a table (work items live in a project's table).
  - \`page\` — wiki-style long-form. Project-scoped.
- **Slugs are immutable** for \`work_item\` and \`page\` documents once created — pick carefully; never try to "rename" a slug.

## 5. Worked recipes

### Set up a project

\`\`\`
# 1. Create the project
folio_api  POST /api/v1/w/<wslug>/projects
  { "name": "Marketing", "slug": "marketing" }

# 2. A table to hold work items
folio_api  POST /api/v1/w/<wslug>/p/marketing/tables
  { "name": "Tasks" }

# 3. Pin field types (optional — otherwise inferred from values)
folio_api  POST /api/v1/w/<wslug>/p/marketing/fields
  { "key": "priority", "type": "select", "options": ["low","med","high"] }

# 4. The project's status set
folio_api  POST /api/v1/w/<wslug>/p/marketing/statuses
  { "name": "In progress", "color": "blue" }

# 5. A view over the table
folio_api  POST /api/v1/w/<wslug>/p/marketing/views
  { "name": "Board", "type": "kanban" }
\`\`\`

### Author a view with a filter

\`\`\`
folio_api  POST /api/v1/w/<wslug>/p/marketing/views
  {
    "name": "My high-priority",
    "type": "table",
    "filter": { "priority": "high", "assignee": "me" }
  }
\`\`\`

Preview first if unsure — add \`"dryRun": true\` to the body and read back \`would\`.

## 6. The risk-gate protocol

Every write is classified into a tier:

- **LOW** — document writes (\`create_document\` / \`update_document\`). Auto-applied.
- **MEDIUM** — config writes to tables / fields / views / statuses / projects. Auto-applied; \`dryRun\` is available as an undo-preview before you commit.
- **HIGH** — token mint/revoke, AI keys, workspace delete/rename, member changes, bulk operations. **Refused-with-plan**: instead of executing, you produce a clear plan of what you WOULD do and let a human apply it. (These are session-only routes you can't reach anyway; the gate refuses them regardless.)

To preview a config write before applying, pass \`dryRun: true\` (POST/PATCH body) or \`?dryRun=true\` (DELETE query). You get \`{ dry_run, would, resource }\` with zero writes — use this to confirm a change is what you intend.

**Authority:** every call runs with \`agent ∩ caller\` permissions — your own scopes intersected with the human who started the run. You can NEVER exceed that caller. A refusal you get is real; do not retry it as a different shape.

---

The API is the source of truth; this skill documents it. When this skill and the routes disagree, the routes win — verify with \`folio_api_get\`.`;

/**
 * OPERATOR_PROMPT — the operator agent's BODY (NOT frontmatter.system_prompt,
 * which is legacy/stripped). An empty body makes the agent unrunnable
 * (AGENT_PROMPT_EMPTY), so this MUST be substantial.
 *
 * Phase-B version: no memory bootstrap. The operator's \`folio\` skill is
 * load-materialized into the run context (the runner's loadAgentDefinition reads
 * the frontmatter-declared skills and prepends them as trusted reference) — NOT
 * read at runtime via get_document. The operator uses folio_api_get for reads /
 * folio_api for writes (+ the narrow document tools), respects authority =
 * agent ∩ caller, and refuses high-risk-with-plan.
 */
export const OPERATOR_PROMPT = `You are the Folio operator — the agent that sets up and maintains this workspace on the user's behalf. You are a power user of Folio, not a menu of admin buttons: you understand the system and drive its general controls.

At the start of every run, ground yourself before acting. Your \`${FOLIO_SKILL_SLUG}\` skill — the API manual (resource → route → scope table, schema conventions, worked recipes, and the risk-gate protocol) — is provided to you in context. Behavior lives in the routes and schema, never in this prompt. When the skill and the routes disagree, the routes win — verify with \`folio_api_get\`.

Use the tools as primitives:
- Use \`folio_api_get\` for reads of resources (tables, views, fields, statuses, projects, documents) — it is GET-forced and maps to documents:read.
- Use \`folio_api\` for config writes (tables, fields, views, statuses, projects) — it is gated and maps to config:write. Preview risky changes with \`dryRun\` first.
- Prefer the narrow document/view tools (\`list_documents\`, \`get_document\`, \`create_document\`, \`update_document\`, \`list_projects\`, \`run_view\`) when they fit; reach for \`folio_api\` only for structure/config the narrow tools don't cover.

Authority and safety:
- Your effective authority is always your own scopes intersected with the caller's — you can never exceed the person who started the run.
- High-risk actions (token mint/revoke, AI keys, workspace delete/rename, member changes, bulk operations) are refused-with-plan: instead of executing, you produce a clear plan describing what you WOULD do, and let a human apply it.
- A refusal you receive is real; do not retry it as a different shape.`;

/**
 * SETUP_PROJECT_REF_BODY — a standalone "how to set up a project" reference page.
 * The core is §5 "Set up a project" from the skill, framed as a worked POST
 * sequence: project → table → fields → statuses → views.
 */
export const SETUP_PROJECT_REF_BODY = `# Reference: set up a project

A worked POST sequence for standing up a new project end-to-end. All config writes go through \`folio_api\`; reads through \`folio_api_get\`. Substitute \`<wslug>\` with the workspace slug. Pass \`"dryRun": true\` in any POST/PATCH body (or \`?dryRun=true\` on DELETE) to preview a write with zero side effects.

## 1. Create the project

\`\`\`
folio_api  POST /api/v1/w/<wslug>/projects
  { "name": "Marketing", "slug": "marketing" }
\`\`\`

## 2. Add a table to hold work items

\`\`\`
folio_api  POST /api/v1/w/<wslug>/p/marketing/tables
  { "name": "Tasks" }
\`\`\`

## 3. Pin field types (optional — otherwise inferred from values)

\`\`\`
folio_api  POST /api/v1/w/<wslug>/p/marketing/fields
  { "key": "priority", "type": "select", "options": ["low","med","high"] }
\`\`\`

## 4. Define the project's status set

\`\`\`
folio_api  POST /api/v1/w/<wslug>/p/marketing/statuses
  { "name": "In progress", "color": "blue" }
\`\`\`

## 5. Author a view over the table

\`\`\`
folio_api  POST /api/v1/w/<wslug>/p/marketing/views
  { "name": "Board", "type": "kanban" }
\`\`\`

Then create work items as documents via the narrow tools (\`create_document\`), and read everything back with \`folio_api_get\` to confirm.`;
