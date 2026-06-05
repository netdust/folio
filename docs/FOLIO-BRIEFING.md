# Folio — Full Briefing

The complete PRD and architecture document. `CLAUDE.md` references this file. If anything here conflicts with `CLAUDE.md`, CLAUDE.md wins (it carries the immutable rules).

---

## 1. Executive Summary

**Folio is a lightweight, self-hostable, agent-first project management and wiki tool.** Each work item and each wiki page is a single markdown file with YAML frontmatter. The format is the source of truth: customers and AI agents both speak it natively, and the whole instance can be exported as a folder of `.md` files at any time.

Folio is sold by Stefan / Netdust as an add-on alongside client website projects (gallery sites, cultural orgs, Stride LMS customers). Each customer gets their own instance, deployed per-customer on Hetzner via Ploi. It is not a SaaS product. The license is MIT — the wedge is the bundled service + agent integration, not code secrecy.

Folio targets a clear gap: Plane and Linear hide content behind opaque DBs; Notion is heavyweight and not agent-native; Obsidian is single-user. Folio is **multi-user + online + markdown-native + agent-first + lightweight**, with no current competitor occupying that exact slot.

---

## 2. Mission & Wedge

### Mission

Make project management invisible. The customer thinks in tasks and pages; the agent reads and writes markdown; the format is portable forever.

### The Wedge — Three Hard Commitments

1. **Markdown is the source-of-truth surface.** Every document round-trips losslessly as `.md` with YAML frontmatter. There is always a "View as Markdown" toggle and a "Copy as Markdown" action. Bulk export of the entire instance is a single command.
2. **Agents are first-class users.** REST API + MCP server endpoint are not afterthoughts — they ship in v1. Tokens have scoped permissions. Every CRUD operation emits an event on an SSE channel agents can subscribe to.
3. **The UX is keyboard-fast.** Cmd-K palette, inline editing, slideovers (no modals), optimistic UI. Feels like Linear, stores like Obsidian.

### What Folio Is Not

- Not a SaaS. No central hosting, no signup, no billing.
- Not real-time collaborative (no CRDTs in v1). Last-write-wins with `updated_at` checks.
- Not multi-tenant inside one instance. One instance = one team.
- Not feature-rich. v1 deliberately ships *less* than Plane.

---

## 3. Business Model & Customer

### Who Buys This

Netdust clients who are already getting a website built. Gallery owners, cultural orgs, small foundations, Stride LMS customers in the Belgian non-profit / health-and-social sector. People who want one tool to track work and one place to write docs, who already trust Stefan to host their digital infrastructure.

### How It's Sold

Bundled with website projects. Setup + first year included in a package, then a small annual maintenance fee. Customer's data lives on their own Hetzner instance under Stefan's management. Customer brings their own AI provider key (Anthropic / OpenAI / OpenRouter / local Ollama) and pays their own AI usage directly.

### The Pricing Sketch (Indicative, Refine Later)

- **Bundled with website setup:** included for year 1.
- **Annual maintenance:** ~€500–€1,200/year per instance (hosting + updates + minor support).
- **Custom agent integration:** time-and-materials at Netdust rates.

### Why MIT License

Stefan is not running a competing SaaS. The moat is the bundled service work and per-customer agent customization, not code secrecy. MIT maximizes adoption, contributions, and external scrutiny. Anyone who self-hosts is a potential reference case.

---

## 4. Tech Stack with Rationale

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | **Bun** | Fast startup, single-binary compile target, first-class TS, modern stdlib. Stefan already uses Bun for the Sofie Telegram bot. |
| Backend | **Hono** | Minimal, edge-friendly, Web Standards (Request/Response), trivial to embed in Bun. Fast routing, tiny footprint. |
| ORM | **Drizzle** | TypeScript-native, no codegen runtime, lightweight, good SQLite + Postgres parity for future migration. |
| DB | **SQLite** (Postgres optional) | One file per customer install. Zero ops. Drizzle abstracts the engine; flip via env. |
| Frontend | **React + Vite + TanStack Router** | Mature ecosystem for rich editors (Milkdown/CodeMirror), drag-drop (dnd-kit), shadcn/ui. TanStack Router gives typed routes without Next.js overhead. |
| Styling | **Tailwind + shadcn/ui** | Battle-tested, no framework lock-in (shadcn is copy-paste components), trivial to theme per-customer. |
| MD body editor | **Milkdown** | Real markdown round-trip via remark/mdast. Tiptap is HTML-first and loses MD on round-trip — wrong primitive for an MD-source-of-truth product. |
| Raw MD editor | **CodeMirror 6** | Industry-standard, tiny, syntax highlighting + folding + extensions. Used for the "raw MD" toggle mode. |
| Drag-drop | **dnd-kit** | Accessible, performant, modern. Required for the kanban view. |
| Encryption | **libsodium** (sodium-native for Bun) | For AI key encryption at rest. Authenticated encryption, audited, simple API. |
| Auth | **Hand-rolled session auth** | Sessions table + cookie + bcrypt/argon2 for passwords + signed magic-link tokens. NextAuth/Auth0 add complexity and external surface. ~300 lines of code. |
| Tests | **Bun test + Playwright** | Bun's test runner is fast and zero-config; Playwright for end-to-end UX commitments (Cmd-K, slideovers, optimistic UI). |
| Lint/format | **Biome** | One tool replaces eslint + prettier. 10x faster, less config. |
| License | **MIT** | Maximum adoption. The moat is service + agent integration, not code. |

### Stack Non-Goals

- **No Next.js.** It bundles too much. Hono + Vite SPA + bun compile is leaner.
- **No tRPC.** Plain REST + Zod-validated bodies. Agents speak REST, humans speak the same surface.
- **No Redis.** SQLite can handle queues for the foreseeable future via a `jobs` table.
- **No Postgres-required.** SQLite is the default. Postgres is an opt-in via env adapter, not a requirement.
- **No SSR.** The React SPA is served as static files by Hono. SEO is not a v1 concern for a self-hosted PM tool.

---

## 5. Architecture Overview

### Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Hetzner VPS (per customer)               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  Folio binary (bun compile)          │   │
│  │  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ Hono API   │  │ MCP endpoint │  │ Static React │  │   │
│  │  └─────┬──────┘  └──────┬───────┘  └──────────────┘  │   │
│  │        │                │                            │   │
│  │  ┌─────▼────────────────▼──────────┐                 │   │
│  │  │      SQLite (folio.db file)     │                 │   │
│  │  └─────────────────────────────────┘                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                          ▲                                  │
│                          │ HTTPS                            │
│                  ┌───────┴────────┐                         │
│                  │  Caddy / nginx │ (reverse proxy + TLS)   │
│                  └───────┬────────┘                         │
└──────────────────────────┼──────────────────────────────────┘
                           │
              ┌────────────┼─────────────┐
              │            │             │
       ┌──────▼─────┐ ┌────▼─────┐ ┌─────▼─────────────┐
       │  Customer  │ │  Agent   │ │ Stefan's agents   │
       │   (web)    │ │ (MCP)    │ │ (Paperclip/Hermes)│
       └────────────┘ └──────────┘ └───────────────────┘
```

### Request Flow (User Edits a Work Item)

1. User edits a field inline in the list view.
2. React fires an optimistic mutation; UI updates immediately.
3. Mutation hits `PATCH /api/v1/documents/:id` with a partial body.
4. Hono validates with Zod, opens a SQLite transaction.
5. Document row is updated; `events` row is inserted with kind `document.updated` and full diff.
6. Transaction commits. The event is pushed to an in-memory pub/sub.
7. Subscribers on the SSE channel `/api/v1/events?workspace_id=...` receive the event.
8. Response returns to the client; optimistic state is reconciled.
9. Any subscribed agent (Paperclip, Stride agent, etc.) reacts to the event.

### Request Flow (Agent Creates a Work Item)

1. Agent sends `POST /api/v1/documents` with `Authorization: Bearer <token>`.
2. Body is raw markdown with frontmatter — agent did not pre-parse.
3. Hono parses frontmatter (gray-matter or remark-frontmatter), validates, opens transaction.
4. Document inserted, event emitted.
5. Response is the full document with parsed frontmatter as JSON for convenience.
6. Optionally, the MCP equivalent: agent calls `create_document` MCP tool with structured args; server serializes to MD internally.

---

## 6. Data Model

Drizzle schema. Adapt the `crypto.randomUUID()` calls to UUIDv7 (use the `uuid` v9+ lib or `uuidv7` package) for time-ordered IDs.

```typescript
// apps/server/src/db/schema.ts
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// === Users & Auth ===

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),       // nullable: magic-link-only users
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                // session token
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const magicLinks = sqliteTable('magic_links', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// === Workspaces & Projects ===

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  aiProvider: text('ai_provider'),            // 'anthropic'|'openai'|'openrouter'|'ollama'
  aiKeyEncrypted: text('ai_key_encrypted'),   // libsodium-secretbox of the API key
  aiModel: text('ai_model'),                  // e.g. 'claude-sonnet-4'
  aiBaseUrl: text('ai_base_url'),             // for Ollama / OpenRouter
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const memberships = sqliteTable('memberships', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),  // 'owner'|'admin'|'member'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
}));

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  icon: text('icon'),                         // emoji or icon name
  description: text('description'),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  workspaceSlugIdx: index('projects_workspace_slug').on(t.workspaceId, t.slug),
}));

// === Per-project status registry (configurable, not hard-coded) ===

export const statuses = sqliteTable('statuses', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),               // 'Todo', 'In progress', 'Done', ...
  color: text('color').notNull().default('#94a3b8'),
  category: text('category').notNull().default('todo'),  // backlog|todo|in_progress|done|cancelled
  order: integer('order').notNull(),
});

// === Per-project field type registry (overrides inference) ===

export const fields = sqliteTable('fields', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),                 // the frontmatter key, e.g. 'priority'
  type: text('type').notNull(),               // see FIELD_TYPES below
  label: text('label'),
  options: text('options', { mode: 'json' }), // for select/multi_select: string[]
  required: integer('required', { mode: 'boolean' }).notNull().default(false),
  order: integer('order').notNull().default(0),
}, (t) => ({
  projectKeyIdx: index('fields_project_key').on(t.projectId, t.key),
}));

// === Documents (work items + pages) ===

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),               // 'work_item' | 'page' | 'agent' | 'trigger'
  slug: text('slug').notNull(),               // URL-friendly, unique within project
  title: text('title').notNull(),
  status: text('status'),                     // status name; validated against statuses table for work_items
  body: text('body').notNull().default(''),   // markdown body (no frontmatter)
  frontmatter: text('frontmatter', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
  parentId: text('parent_id'),                // for nested pages or sub-work-items
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  createdBy: text('created_by').references(() => users.id),
  updatedBy: text('updated_by').references(() => users.id),
}, (t) => ({
  projectSlugIdx: index('documents_project_slug').on(t.projectId, t.slug),
  projectTypeIdx: index('documents_project_type').on(t.projectId, t.type),
  parentIdx: index('documents_parent').on(t.parentId),
}));

// === Views (saved filters/sorts per project) ===

export const views = sqliteTable('views', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),               // 'list' | 'kanban'
  filters: text('filters', { mode: 'json' }).notNull().default({}),
  sort: text('sort', { mode: 'json' }),       // [{ key: 'priority', dir: 'desc' }, ...]
  groupBy: text('group_by'),                  // for kanban: usually 'status'
  displayFields: text('display_fields', { mode: 'json' }), // frontmatter keys to show as columns
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  order: integer('order').notNull().default(0),
});

// === API tokens (for agents) ===

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),           // first 8 chars, shown in UI for identification
  hash: text('hash').notNull().unique(),      // bcrypt/argon2 of the full token
  scopes: text('scopes', { mode: 'json' }).notNull(),  // string[]: 'read', 'write', 'admin'
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
});

// === Events (audit + agent subscriptions) ===

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),               // 'document.created'|'document.updated'|'document.deleted'|'ai.action'
  payload: text('payload', { mode: 'json' }).notNull(),
  actorType: text('actor_type').notNull(),    // 'user' | 'agent' | 'system'
  actorId: text('actor_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  workspaceCreatedIdx: index('events_workspace_created').on(t.workspaceId, t.createdAt),
}));

// === Type exports ===

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type View = typeof views.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Event = typeof events.$inferSelect;
```

### Notes on the Schema

- **No `documents.workspace_id`** — derived via `projects.workspace_id`. Saves denormalization, costs one join. SQLite handles it fine.
- **`documents.frontmatter` is `JSON` mode** — Drizzle parses to/from `Record<string, unknown>`. Validate shape at API boundary, not at DB layer.
- **`status` is stored as a string**, not an FK. The `statuses` table is a registry per project; documents reference status by name. This keeps export-as-markdown clean (status appears as a plain string in frontmatter) and lets agents invent statuses that get backfilled into the registry later.
- **UUIDv7** is preferred over UUIDv4 for natural sort by creation time. Helps with cursor pagination and event ordering.

---

## 7. Frontmatter System & Field Type Inference

### Storage Format

When a document is exported or copied as markdown:

```markdown
---
status: in_progress
priority: high
assignee: stefan@netdust.be
due_date: 2026-06-01
labels: [bug, urgent]
estimate: 3
custom_anything: "agents can invent fields"
---

# Body content in markdown.

Lists, code blocks, headings — all supported.
```

`title` is taken from the H1 if present, else from the `title:` frontmatter key, else from the document row's `title` column. On import, all three are reconciled.

### Field Types (`FIELD_TYPES`)

```typescript
export const FIELD_TYPES = [
  'string',          // single line text
  'text',            // multi-line text
  'number',
  'boolean',
  'date',            // ISO 8601 date (YYYY-MM-DD)
  'datetime',        // ISO 8601 datetime
  'select',          // single value from options[]
  'multi_select',    // array of values from options[]
  'user_ref',        // user email or id
  'url',
  'document_ref',    // link to another document by slug
] as const;
```

### Inference Rules (Run On Read When No Pin Exists)

Inference is order-sensitive — the first match wins:

1. **boolean** — value is exactly `true` or `false`
2. **datetime** — value matches `YYYY-MM-DDTHH:MM:SS(Z|±HH:MM)`
3. **date** — value matches `YYYY-MM-DD`
4. **number** — value is a finite number (not NaN)
5. **multi_select** — value is an array of strings
6. **user_ref** — value matches an email regex AND a user with that email exists in the workspace
7. **url** — value starts with `http://`, `https://`, or `mailto:`
8. **document_ref** — value matches `[[slug]]` wiki-link syntax
9. **text** — value is a string with newlines
10. **string** — fallback

When the project has a row in the `fields` table with a matching `key`, that explicit pin overrides inference. Inferred type becomes the UI hint; pinned type becomes the contract (validated on write).

### Field Promotion Flow

When an agent or a user adds a new frontmatter key, it shows up immediately in the UI with its inferred type. A small "Pin type" affordance lets a user explicitly type-pin the field via the Settings → Fields page — converting inference into a hard schema entry. Pin-then-promote: a key only becomes a "real" field when someone pins it.

---

## 8. API Surface

### REST API (`/api/v1/...`)

All endpoints require either a session cookie (browser) OR `Authorization: Bearer <token>` (agent). Workspace scoping is implicit from membership / token.

#### Auth

- `POST /api/v1/auth/register` — `{ email, name, password }` → session
- `POST /api/v1/auth/login` — `{ email, password }` → session
- `POST /api/v1/auth/logout` — invalidate current session
- `POST /api/v1/auth/magic-link/request` — `{ email }` → 202, link emailed/logged
- `POST /api/v1/auth/magic-link/consume` — `{ token }` → session
- `GET /api/v1/auth/me` — current user

#### Workspaces

- `GET /api/v1/workspaces` — list workspaces the current actor belongs to
- `POST /api/v1/workspaces` — `{ slug, name }`
- `GET /api/v1/workspaces/:slug`
- `PATCH /api/v1/workspaces/:slug` — `{ name?, aiProvider?, aiKey?, aiModel?, aiBaseUrl? }`
- `DELETE /api/v1/workspaces/:slug`

#### Projects

- `GET /api/v1/w/:wslug/projects`
- `POST /api/v1/w/:wslug/projects` — `{ slug, name, icon? }`
- `GET /api/v1/w/:wslug/projects/:pslug`
- `PATCH /api/v1/w/:wslug/projects/:pslug`
- `DELETE /api/v1/w/:wslug/projects/:pslug`

#### Documents

- `GET /api/v1/w/:wslug/projects/:pslug/documents?type=work_item&filters=...`
- `POST /api/v1/w/:wslug/projects/:pslug/documents` — accepts either `{ type, title, body, frontmatter }` OR `Content-Type: text/markdown` with raw `---\nfrontmatter\n---\nbody`
- `GET /api/v1/w/:wslug/projects/:pslug/documents/:slug`
- `GET /api/v1/w/:wslug/projects/:pslug/documents/:slug.md` — raw MD with frontmatter
- `PATCH /api/v1/w/:wslug/projects/:pslug/documents/:slug` — partial update
- `DELETE /api/v1/w/:wslug/projects/:pslug/documents/:slug`

#### Statuses, Fields, Views

- `GET/POST/PATCH/DELETE /api/v1/w/:wslug/projects/:pslug/statuses`
- `GET/POST/PATCH/DELETE /api/v1/w/:wslug/projects/:pslug/fields`
- `GET/POST/PATCH/DELETE /api/v1/w/:wslug/projects/:pslug/views`

#### API Tokens

- `GET /api/v1/w/:wslug/tokens`
- `POST /api/v1/w/:wslug/tokens` — `{ name, scopes }` → returns the token *once*
- `DELETE /api/v1/w/:wslug/tokens/:id`

#### Events (SSE)

- `GET /api/v1/w/:wslug/events` — Server-Sent Events stream. Filter by `?project=...` or `?kinds=document.created,document.updated`.

#### AI

- `POST /api/v1/w/:wslug/ai/complete` — used by the in-UI slash commands; requires BYOK to be configured.
- `POST /api/v1/w/:wslug/ai/test-key` — validates a key without storing.

#### Export

- `GET /api/v1/w/:wslug/export.zip` — ZIP of all documents as `.md` files, structured as `projects/<pslug>/<type>/<slug>.md`.

### Response Envelope

Success:
```json
{ "data": { ... } }
```

Error:
```json
{ "error": { "code": "DOCUMENT_NOT_FOUND", "message": "Document with slug 'foo' not found in project 'bar'" } }
```

### Pagination

Cursor-based via `?cursor=<opaque>` and `?limit=<int, default 50, max 200>`. Response includes `"data": [...], "nextCursor": "..." | null`.

---

## 9. MCP Server Specification

The MCP server is mounted at `/mcp` and is **the** way Stefan's Paperclip agents (and any customer's agents) interact with Folio programmatically. Same data surface as REST, more ergonomic for AI.

### Authentication

MCP requests use the same API token as REST: `Authorization: Bearer <token>` on the SSE connection. The token's `scopes` determine which tools are exposed to the agent.

### v1 Tool Set

- `list_workspaces` — no args, returns workspaces visible to the token
- `list_projects` — args: `workspace_slug`
- `list_documents` — args: `workspace_slug`, `project_slug`, optional `type`, `filters` (mongo-ish: `{ status: { $in: ['todo', 'in_progress'] } }`), `limit`, `cursor`
- `get_document` — args: `workspace_slug`, `project_slug`, `slug`. Returns parsed frontmatter + body + metadata.
- `get_document_markdown` — same args, returns raw `.md` string
- `create_document` — args: `workspace_slug`, `project_slug`, `type`, `title`, `body`, `frontmatter` (object) — OR — `markdown` (raw string).
- `update_document` — args: identifiers + `patch` (partial). Supports `body_append`, `body_prepend`, `frontmatter_merge` operators.
- `delete_document` — args: identifiers
- `list_statuses` — args: `workspace_slug`, `project_slug`
- `list_fields` — args: `workspace_slug`, `project_slug`
- `list_views` — args: `workspace_slug`, `project_slug`
- `run_view` — args: identifiers + `view_slug` → returns the document list as the view would render it
- `search_documents` (v1.1) — args: query string + scope

### Tool Output Shape

All tools return JSON. `get_document` returns the document as:
```json
{
  "id": "...",
  "type": "work_item",
  "slug": "fix-login-bug",
  "title": "Fix login bug",
  "status": "in_progress",
  "frontmatter": { "priority": "high", "assignee": "stefan@..." },
  "body": "## Steps\n\n1. ...",
  "markdown": "---\nstatus: in_progress\n...\n---\n\n# Fix login bug\n\n## Steps\n\n1. ...",
  "created_at": "...",
  "updated_at": "...",
  "url": "https://folio.client.com/w/main/p/web/work_item/fix-login-bug"
}
```

---

## 10. AI Integration

### Provider Abstraction

```typescript
// apps/server/src/lib/ai/provider.ts
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AICompleteOptions {
  model: string;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AICompleteResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIProvider {
  readonly name: string;
  readonly models: readonly string[];
  complete(opts: AICompleteOptions): Promise<AICompleteResult>;
}

export type AIProviderName = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export function getProvider(name: AIProviderName, apiKey: string, baseUrl?: string): AIProvider;
```

Concrete implementations live in `apps/server/src/lib/ai/`:
- `anthropic.ts` — uses `@anthropic-ai/sdk`
- `openai.ts` — uses `openai`
- `openrouter.ts` — uses `openai` SDK pointed at OpenRouter
- `ollama.ts` — fetch against the customer's Ollama base URL

### Key Storage

`workspaces.ai_key_encrypted` is libsodium-secretbox of the raw key, with the nonce prepended (24-byte nonce + ciphertext). The master key comes from `FOLIO_MASTER_KEY` env (32-byte base64). On read, decrypt; on write, encrypt fresh. Never log decrypted keys. Never return the key over the API — only `aiProvider`, `aiModel`, and a `keyConfigured: boolean` flag.

### Slash Commands (v1)

Triggered in the Milkdown body editor. Each is a thin wrapper that builds a prompt and calls `POST /api/v1/w/:wslug/ai/complete`.

- `/draft` — given the document title, draft a body. Streams into the editor.
- `/decompose` — given the current body, propose subtask documents. Returns a list; on accept, creates child documents (`parent_id` set).
- `/summarize` — given the body, return a one-paragraph summary; inserted at the top or copied.
- `/link <query>` — searches existing documents by title, inserts a `[[slug]]` wiki link.
- `/ai <prompt>` — open-ended; prompt + current body sent as user message.

### Agent vs UI AI

The MCP endpoint does *not* require the workspace AI key — agents bring their own AI to the table and only use Folio for data. The in-UI slash commands *do* require BYOK because the server makes the AI call on the user's behalf.

---

## 11. UX Commitments — Acceptance Criteria

These are testable. Playwright covers them in Phase 4.

### 1. Cmd-K Palette

- Opens with `Cmd-K` / `Ctrl-K` from anywhere
- Fuzzy search across: workspaces, projects, documents (title + slug), actions ("New work item", "Switch theme")
- Arrow keys + Enter navigate; Escape closes
- Recent actions surface first when query is empty
- Implementation: single `usePalette()` hook + a registry that components contribute to via `usePaletteCommands()`

### 2. Inline Editing

- Any field in any view is click-to-edit
- Title in list view: click → text input with current value selected; Enter saves, Escape cancels
- Status: click → dropdown of project statuses; click outside saves
- Frontmatter fields: click → input rendered per field type
- No "Edit" / "Save" buttons anywhere on the main views

### 3. Slideovers, Not Modals

- Opening a document from a view animates a right-side slideover (~600px wide)
- The list/kanban behind it remains visible and the URL updates
- Slideover is closable via Escape, click-outside, or `X` button
- Browser back closes the slideover, not the whole list

### 4. Optimistic UI

- Every PATCH/POST/DELETE updates local state immediately
- On 4xx/5xx: roll back local state + show a toast with the error message
- On 2xx: reconcile local state with server response (timestamps, slugs)
- A subtle "Saving…" indicator in a corner during in-flight requests

### 5. Slash Commands

- `/` in the Milkdown editor opens a command menu inline
- Arrow keys filter; Enter executes
- Streaming responses from `/draft` and `/decompose` insert tokens as they arrive
- Commands that require a configured AI key show a disabled state with a "Configure AI" link when missing

### 6. Copy-as-MD

- Right-click any document row in a list view → "Copy as Markdown" entry
- Right-click anywhere in a document view → same
- Result on clipboard: full document including frontmatter, formatted exactly as the export format
- `Cmd-Shift-C` is a shortcut for copy-as-MD on the focused row

---

## 12. Views Engine

### View Config Shape

```typescript
type ViewType = 'list' | 'kanban';

interface FilterClause {
  key: string;                           // 'status', 'priority', 'frontmatter.assignee', ...
  op: 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with' | 'is_empty' | 'not_empty';
  value?: unknown;
}

interface ViewConfig {
  filters: FilterClause[];               // ANDed together
  sort?: { key: string; dir: 'asc' | 'desc' }[];
  groupBy?: string;                      // for kanban: usually 'status'
  displayFields?: string[];              // frontmatter keys to show as columns
}
```

### Filter Translation to SQL

The filter compiler translates `FilterClause` into Drizzle conditions. For frontmatter fields, use `json_extract(frontmatter, '$.priority')` etc. Index the most common ones via generated columns in v1.1 if performance demands.

### Default Views

Each project gets two default views on creation:
- **All work items** — `list`, filter `type = work_item`, sort by `updated_at desc`
- **Board** — `kanban`, filter `type = work_item`, group by `status`

### Pages Index

The "Wiki" tab shows a tree of pages by `parent_id`. Not a "view" in the configurable sense — it's a fixed tree renderer.

---

## 13. Auth Flow

Hand-rolled, ~300 lines total. No NextAuth, no Auth0.

### Signup

1. `POST /api/v1/auth/register` with `{ email, name, password }`
2. Server validates with Zod, checks email uniqueness
3. Hash password with `Bun.password.hash(password, { algorithm: 'argon2id' })`
4. Insert user row
5. Create session: random 32-byte token, insert into `sessions`
6. Set `Set-Cookie: folio_session=<token>; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
7. Return current user

### Login

Same as signup but verify password against hash, no insert.

### Magic Link

1. `POST /api/v1/auth/magic-link/request` with `{ email }`
2. Generate random 32-byte token, insert into `magic_links` with 15-min expiry
3. Send email with link `https://folio.app/magic?token=...` (in dev: log to console)
4. User clicks link → frontend calls `POST /api/v1/auth/magic-link/consume` with the token
5. Server verifies token unused + not expired, marks consumed, finds-or-creates user by email, creates session
6. Returns session cookie

### Session Validation

Hono middleware reads `folio_session` cookie, looks up in `sessions`, checks expiry, attaches `c.set('user', user)` and `c.set('workspaces', memberships)`. Cached in-memory for the request lifecycle.

### API Tokens (Agents)

Separate path: `Authorization: Bearer <token>`. Token format: `folio_pat_<workspace_slug>_<random>`. On request, hash the token, look up in `api_tokens`, check expiry, check scopes against the route. Update `last_used_at`.

---

## 14. Build & Deploy

### Local Dev

```bash
bun install
bun --filter=server db:migrate
bun dev                # runs both server and web in watch mode
```

Server on `http://localhost:3000`, web on `http://localhost:5173` (Vite proxies `/api` to server).

### Production Build → Single Binary

```bash
# 1. Build the React app
bun --filter=web run build
# Output: apps/web/dist/

# 2. Copy dist into the server's static dir
cp -r apps/web/dist apps/server/src/public/

# 3. Compile the server into a single binary
bun build apps/server/src/index.ts --compile --target=bun-linux-x64 --outfile=dist/folio
```

The binary embeds the React bundle and the SQLite driver. ~50–80 MB. Run with:

```bash
FOLIO_MASTER_KEY=<base64-32-bytes> \
FOLIO_DB_PATH=/var/lib/folio/folio.db \
FOLIO_PORT=3000 \
./folio
```

### Dockerfile

Multi-stage. Alpine final image, ~100 MB.

```dockerfile
# docker/Dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun --filter=web run build
RUN cp -r apps/web/dist apps/server/src/public
RUN bun build apps/server/src/index.ts --compile --target=bun-linux-x64 --outfile=/folio

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /folio /usr/local/bin/folio
VOLUME /data
ENV FOLIO_DB_PATH=/data/folio.db
EXPOSE 3000
ENTRYPOINT ["folio"]
```

### Ploi Deploy

`scripts/deploy-ploi.sh` SSHes to the Hetzner box, pulls latest binary from GitHub releases, restarts the systemd service. Per-customer: one systemd unit, one data dir, one Caddy site block.

### Env Vars

| Var | Required | Purpose |
|-----|----------|---------|
| `FOLIO_MASTER_KEY` | yes | base64 32-byte key for AI-key encryption at rest |
| `FOLIO_DB_PATH` | no (default `./folio.db`) | SQLite file path |
| `FOLIO_PORT` | no (default `3000`) | HTTP port |
| `FOLIO_BASE_URL` | yes (for magic links) | Public URL of the instance |
| `FOLIO_SMTP_*` | no (logs to console if absent) | Email sending |
| `FOLIO_LOG_LEVEL` | no (default `info`) | `debug` / `info` / `warn` / `error` |

---

## 15. Detailed Project Layout

```
folio/
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts                # Bun entrypoint
│   │   │   ├── app.ts                  # Hono app composition
│   │   │   ├── env.ts                  # Validated env (Zod)
│   │   │   ├── db/
│   │   │   │   ├── schema.ts           # Drizzle schema (see §6)
│   │   │   │   ├── client.ts           # Drizzle DB instance
│   │   │   │   └── migrations/         # Generated migration SQL files
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── workspaces.ts
│   │   │   │   ├── projects.ts
│   │   │   │   ├── documents.ts
│   │   │   │   ├── statuses.ts
│   │   │   │   ├── fields.ts
│   │   │   │   ├── views.ts
│   │   │   │   ├── tokens.ts
│   │   │   │   ├── events.ts           # SSE
│   │   │   │   ├── ai.ts
│   │   │   │   ├── mcp.ts              # MCP server endpoint
│   │   │   │   └── export.ts
│   │   │   ├── middleware/
│   │   │   │   ├── session.ts
│   │   │   │   ├── bearer.ts
│   │   │   │   └── workspace-scope.ts
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts             # password hash, session create/destroy
│   │   │   │   ├── crypto.ts           # libsodium wrappers
│   │   │   │   ├── slug.ts
│   │   │   │   ├── md.ts               # frontmatter parse/serialize (gray-matter)
│   │   │   │   ├── field-infer.ts      # type inference from value
│   │   │   │   ├── events.ts           # event bus (in-memory pub/sub)
│   │   │   │   ├── filter-compile.ts   # ViewConfig → Drizzle where()
│   │   │   │   └── ai/
│   │   │   │       ├── provider.ts
│   │   │   │       ├── anthropic.ts
│   │   │   │       ├── openai.ts
│   │   │   │       ├── openrouter.ts
│   │   │   │       └── ollama.ts
│   │   │   └── public/                 # React build output (gitignored, populated at build)
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/
│       ├── src/
│       │   ├── main.tsx
│       │   ├── router.tsx              # TanStack Router config
│       │   ├── routes/
│       │   │   ├── __root.tsx
│       │   │   ├── login.tsx
│       │   │   ├── magic.tsx
│       │   │   ├── w.$workspace.tsx
│       │   │   ├── w.$workspace.p.$project.tsx
│       │   │   ├── w.$workspace.p.$project.work-items.tsx
│       │   │   ├── w.$workspace.p.$project.work-items.$slug.tsx
│       │   │   └── w.$workspace.p.$project.pages.$slug.tsx
│       │   ├── components/
│       │   │   ├── ui/                 # shadcn/ui components
│       │   │   ├── editor/
│       │   │   │   ├── milkdown-body.tsx
│       │   │   │   ├── codemirror-raw.tsx
│       │   │   │   └── slash-menu.tsx
│       │   │   ├── views/
│       │   │   │   ├── list-view.tsx
│       │   │   │   └── kanban-view.tsx
│       │   │   ├── fields/
│       │   │   │   ├── field-renderer.tsx  # dispatches by inferred/pinned type
│       │   │   │   ├── field-string.tsx
│       │   │   │   ├── field-date.tsx
│       │   │   │   ├── field-select.tsx
│       │   │   │   └── ...
│       │   │   ├── slideover.tsx
│       │   │   ├── palette.tsx
│       │   │   └── sidebar.tsx
│       │   ├── lib/
│       │   │   ├── api.ts              # typed fetch client
│       │   │   ├── frontmatter.ts      # shared with server via packages/shared
│       │   │   ├── keybindings.ts
│       │   │   └── optimistic.ts       # mutation helpers
│       │   ├── hooks/
│       │   │   ├── use-palette.ts
│       │   │   ├── use-events.ts       # SSE subscription
│       │   │   └── use-document.ts
│       │   └── styles.css
│       ├── public/
│       ├── index.html
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   └── shared/
│       ├── src/
│       │   ├── types.ts                # Document, View, FilterClause, ...
│       │   ├── frontmatter.ts          # parse/serialize functions
│       │   └── field-types.ts          # FIELD_TYPES enum + inference helpers
│       ├── package.json
│       └── tsconfig.json
├── docker/
│   └── Dockerfile
├── scripts/
│   ├── build.ts                        # full pipeline → binary
│   └── deploy-ploi.sh
├── docs/
│   ├── FOLIO-BRIEFING.md               # This file
│   ├── PHASES.md
│   ├── API.md                          # Generated from route handlers + JSDoc
│   ├── MCP.md
│   └── INSTALL.md
├── .claude/
│   └── memory/
│       └── notes.md                    # Claude Code's per-project learnings
├── CLAUDE.md
├── README.md
├── LICENSE                             # MIT
├── biome.json
├── package.json                        # Workspace root
├── bun.lockb
└── .gitignore
```

---

## 16. Conventions

### TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`
- No `any`. Use `unknown` and narrow.
- No `enum`. Use `as const` objects + union types.
- Path aliases: `@/` in each app pointing at `src/`. Shared types via `@folio/shared`.

### File Naming

- `kebab-case.ts` for files.
- `PascalCase` for type names and React components.
- `camelCase` for functions and variables.
- `snake_case` for DB columns and frontmatter keys.

### React

- Function components only. No classes.
- Server state via TanStack Query. Local state via `useState`. Global UI state via Zustand if it becomes necessary; until then, prop-drill.
- All event handlers `onX` named, all components default-export their route component but **named-export** everything else.

### API Validation

- Zod schemas at every route boundary, both for params and bodies.
- Shared schemas live in `packages/shared` where they're used by both server and web.

### Git

- Branch: `main` is deployable. Feature branches `phase-N/<short-desc>`.
- Commits: `phase-N: <imperative description>`. Atomic per task in PHASES.md.
- PRs not required for solo development; squash merge if used.

### Testing

- Unit: `bun test` next to source files (`x.ts` → `x.test.ts`).
- E2E: Playwright in `apps/web/tests/e2e/` from Phase 4 onward.
- Coverage target: don't optimize for a number. Test the gnarly bits (frontmatter parse, filter compile, AI provider abstraction, auth flows).

---

## 17. Open Questions / Deferred Decisions

These are explicitly *not* in v1. Don't build them. Note them so they're visible.

- **Search.** No full-text search in v1. v1.1 lands sqlite-fts5 over `documents.title + body`. Vector search via `sqlite-vec` is a later option.
- **Comments / discussions.** Deferred. Possibly never — documents themselves can carry threaded discussion as markdown.
- **Attachments / file uploads.** Deferred. Inline images via base64 or external URL only in v1.
- **Real-time collab on a single doc.** Deferred. Last-write-wins with `updated_at` check; the second writer sees a conflict toast and a diff modal.
- **Email notifications.** Deferred. SSE delivers in-app realtime updates; agents handle their own notification logic.
- **Mobile app.** Web should be passable on mobile (Tailwind responsive). No native app planned.
- **SSO / OIDC.** Deferred. Each instance is small; email-password + magic-link is enough.
- **Permissions beyond role.** Deferred. Owner / admin / member is the whole model in v1. Per-project ACLs land later.
- **Postgres adapter.** Schema is written to be Drizzle-portable. The env toggle ships in v1.2 if any customer needs it. Until then, SQLite only.
- **Plugin system.** Deferred. The MCP endpoint is the integration surface in v1.

---

## 18. Glossary

| Term | Meaning |
|------|---------|
| **Workspace** | A top-level ORGANIZATIONAL FOLDER inside an instance — NOT a security/tenancy boundary (one instance = one team). A customer might have one workspace ("Main") or several ("Galleries", "Stride", "Operations"). Visibility into a specific workspace/project is an explicit invitation-based grant (`workspace_access`/`project_access`); instance authority is the user's `role` (owner/admin/member). *(The `memberships` table + reserved `__system` workspace were removed in the drop-workspace-tenancy refactor, 2026-06.)* |
| **Project** | A folder inside a workspace. Holds work items, pages, and configuration (statuses, fields, views). |
| **Document** | The unified term for work items, pages, agents, and triggers. Same table, different `type`. |
| **Work item** | A document with `type = 'work_item'`. Shows up on boards. Has a status. |
| **Page** | A document with `type = 'page'`. Wiki-style long form. Nested via `parent_id`. |
| **Agent** | A document with `type = 'agent'`. Frontmatter defines model, prompt, allowed MCP tools. The body is its system prompt. Auto-minted API token. |
| **Trigger** | A document with `type = 'trigger'`. Frontmatter defines a cron schedule and/or event pattern that fires an agent. N triggers per agent. |
| **Field** | A frontmatter key. Inferred-typed unless pinned in the project's `fields` table. |
| **View** | A saved filter + sort + group-by + display config, scoped to a project. List or kanban in v1. |
| **Event** | A row in the `events` table emitted on every CRUD. Streamed via SSE. Agents subscribe. |
| **Slideover** | The right-side panel that opens when a document is selected. Not a modal. |
| **BYOK** | "Bring your own key" — the customer provides their own AI provider API key. |
| **MCP** | Model Context Protocol — the standard way agents talk to Folio. |
| **Frontmatter** | The YAML block at the top of a markdown document, between `---` fences. |
| **Pin** | Explicitly setting a frontmatter key's type in the `fields` table, overriding inference. |

---

## 19. References

- Plane (the project Folio is the lightweight alternative to): https://github.com/makeplane/plane
- Milkdown: https://milkdown.dev
- Hono: https://hono.dev
- Drizzle: https://orm.drizzle.team
- Bun: https://bun.com
- TanStack Router: https://tanstack.com/router
- shadcn/ui: https://ui.shadcn.com
- MCP spec: https://modelcontextprotocol.io
- Anthropic API: https://docs.claude.com/en/api/overview

---

**End of briefing.** Open `PHASES.md` to start building.
