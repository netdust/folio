/**
 * Folio schema. Source of truth for the SQLite database.
 *
 * Design principles:
 *  - Documents are the only "content" table. A work_item and a wiki page are
 *    both rows here, differentiated by `type`.
 *  - frontmatter is stored as JSON text (parsed lazily). The UI introspects it
 *    and renders inputs based on per-project field type hints in `fields`.
 *  - Only `title`, `status`, and `body` are first-class columns on documents.
 *    Everything else lives in frontmatter for maximum flexibility.
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// --- Users & auth ---

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'), // nullable -> magic-link-only users
  name: text('name').notNull(),
  // Instance-level role (one instance = one team). The single source of instance
  // authority — the legacy workspace-scoped `memberships` table was dropped in
  // Phase 4 (migration 0028). owner/admin gate the instance-admin surfaces;
  // visibility is by `workspace_access`/`project_access` grant.
  role: text('role', { enum: ['owner', 'admin', 'member'] })
    .notNull()
    .default('member'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(), // session token (random)
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index('auth_sessions_user_idx').on(t.userId),
  }),
);

export const magicLinks = sqliteTable(
  'magic_links',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(), // sha256 of the token sent in email
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tokenIdx: uniqueIndex('magic_links_token_idx').on(t.tokenHash),
  }),
);

// --- Workspaces & projects ---

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  // Phase 3 (Task C-5) — per-workspace AI provider health, durable so
  // tipping-edge detection survives restarts. Shape: `{ [provider]: {
  // status, consecutive_failures } }`. Missing keys default to
  // { healthy, 0 } at read time. Migration 0013 adds the column with
  // a string-literal '{}' default so existing workspaces backfill safely.
  providerHealth: text('provider_health', { mode: 'json' })
    .$type<Record<string, { status: 'healthy' | 'degraded'; consecutive_failures: number }>>()
    .notNull()
    .default({}),
});

// `memberships` was the legacy workspace-scoped role table. Phase 4 dropped it
// (migration 0028 — drop-workspace-tenancy): instance authority moved to
// `users.role`, visibility to `workspace_access`/`project_access`. One instance
// = one team; there is no per-workspace membership.

// --- Per-user access grants (invitation-based, replacing workspace tenancy) ---
//
// Step 2 of dropping workspace-as-tenancy-boundary (one instance = one team).
// Access to a specific workspace or project becomes an explicit grant rather
// than implied by membership. Composite PK = (user, scope) so a grant is unique
// per pair; the reverse index seeks by scope ("who can see this workspace?").
// Additive only: nothing reads these tables yet — readers land in later tasks.

export const workspaceAccess = sqliteTable(
  'workspace_access',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.workspaceId] }),
    wsIdx: index('workspace_access_ws_idx').on(t.workspaceId),
  }),
);

export const projectAccess = sqliteTable(
  'project_access',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId] }),
    projIdx: index('project_access_proj_idx').on(t.projectId),
  }),
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    icon: text('icon'), // emoji or short string
    description: text('description'),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    slugIdx: uniqueIndex('projects_workspace_slug_idx').on(t.workspaceId, t.slug),
  }),
);

// --- Tables (logical grouping of work_item documents within a project) ---

export const tables = sqliteTable(
  'tables',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    icon: text('icon'), // emoji or short string
    order: integer('order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    slugIdx: uniqueIndex('tables_project_slug_idx').on(t.projectId, t.slug),
  }),
);

// --- Per-project configuration ---

/** Configurable status states per project. */
export const statuses = sqliteTable(
  'statuses',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // stable key written into documents.status
    name: text('name').notNull(), // display name
    color: text('color').notNull().default('#9ca3af'),
    category: text('category', {
      enum: ['backlog', 'unstarted', 'started', 'completed', 'cancelled'],
    })
      .notNull()
      .default('unstarted'),
    order: integer('order').notNull().default(0),
  },
  (t) => ({
    keyIdx: uniqueIndex('statuses_table_key_idx').on(t.tableId, t.key),
  }),
);

/** Per-project field type pinning. Optional - inference works without entries here. */
export const fields = sqliteTable(
  'fields',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // frontmatter key name
    type: text('type', {
      enum: [
        'string', 'text', 'number', 'boolean', 'date', 'datetime',
        'select', 'multi_select', 'user_ref', 'url', 'document_ref',
        'currency', 'relation',
      ],
    }).notNull(),
    label: text('label'),
    options: text('options', { mode: 'json' }).$type<string[] | null>(), // for select types
    order: integer('order').notNull().default(0),
  },
  (t) => ({
    keyIdx: uniqueIndex('fields_table_key_idx').on(t.tableId, t.key),
  }),
);

// --- Documents (the heart of it) ---

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    // Phase 2.5: project_id is nullable for agent/trigger (workspace-scoped).
    // CHECK constraint at the SQL level enforces the type ↔ scope invariant.
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tableId: text('table_id').references(() => tables.id, { onDelete: 'set null' }),
    type: text('type', {
      enum: ['work_item', 'page', 'agent', 'trigger', 'comment', 'agent_run'],
    }).notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    status: text('status'), // matches a statuses.key for work_items; null for pages
    boardPosition: text('board_position'), // fractional rank for manual kanban order; null = unranked
    body: text('body').notNull().default(''),
    // frontmatter stored as JSON object. Type inference happens in the UI.
    frontmatter: text('frontmatter', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    parentId: text('parent_id'), // for nested pages
    createdBy: text('created_by').references(() => users.id),
    updatedBy: text('updated_by').references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    // Distinct from updated_at: bumped only by explicit "Log activity" action.
    // Powers the ?stale_for=Nd filter + Phase 1.8's "stale" dashboard bucket.
    lastTouchedAt: integer('last_touched_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    slugIdx: uniqueIndex('documents_project_slug_idx').on(t.projectId, t.slug),
    typeIdx: index('documents_project_type_idx').on(t.projectId, t.type),
    // NOTE: the REAL shape of this index is PARTIAL — `WHERE project_id IS NULL`
    // — set by migration 0017 (see the F15 note below). It uniquely constrains
    // only workspace-SCOPED docs (agents/triggers, project_id NULL). Drizzle's
    // builder can't express the WHERE clause, so this declaration is the
    // non-partial fallback; the migration is the source of truth. Without the
    // partial predicate it wrongly collided project-scoped work_item/page slugs
    // across projects in a workspace (the "New work item" 500 — 0017 fixes it).
    workspaceSlugIdx: uniqueIndex('documents_workspace_type_slug_idx').on(
      t.workspaceId,
      t.type,
      t.slug,
    ),
    workspaceTypeIdx: index('documents_workspace_type_idx').on(t.workspaceId, t.type),
    parentIdx: index('documents_parent_idx').on(t.parentId),
    tableIdx: index('documents_table_idx').on(t.tableId),
    // F15 (post-C.1 review) — the following partial indexes are created
    // directly in raw-SQL migrations and CANNOT be declared here because
    // Drizzle's index builder does not support partial-index `WHERE`
    // clauses or expression-indexed columns like `json_extract(...)`.
    // They are intentional, load-bearing, and tested:
    //  - `documents_comments_idx`        (migration 0007, comments hot path)
    //  - `documents_runs_by_parent_idx`  (migration 0012, getActiveRun)
    //  - `documents_runs_by_status_idx`  (migration 0012, list-runs-by-table)
    //  - `documents_runs_pending_idx`    (migration 0012, claimNextPlanningRun)
    //  - `documents_runs_by_chain_idx`   (migration 0012, checkChainGuards)
    //  - `documents_workspace_type_slug_idx` is RECREATED PARTIAL
    //      (`WHERE project_id IS NULL`) by migration 0017 — see the note on
    //      workspaceSlugIdx above. The builder declares it non-partial; the
    //      migration narrows it to workspace-scoped (agent/trigger) rows.
    // DO NOT run `bun --filter=server db:generate` without checking the
    // generated diff for `DROP INDEX` statements against any of these.
    // The integration test suite + the EXPLAIN volume tests in
    // services/agent-runs.test.ts will fail if these indexes go away,
    // but only at test time, not at generate-time. Audit before
    // applying.
  }),
);

// --- Views (saved filters/sorts/groupings) ---

export const views = sqliteTable('views', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tableId: text('table_id')
    .notNull()
    .references(() => tables.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['list', 'kanban'] }).notNull(),
  filters: text('filters', { mode: 'json' }).$type<unknown>().notNull().default({}),
  sort: text('sort', { mode: 'json' }).$type<unknown>().notNull().default([]),
  groupBy: text('group_by'), // field key for kanban grouping; defaults to status
  visibleFields: text('visible_fields', { mode: 'json' }).$type<string[]>().notNull().default([]),
  columnOrder: text('column_order', { mode: 'json' }).$type<string[] | null>(),
  order: integer('order').notNull().default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// --- Agent-facing surface ---

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(), // sha256 of the bearer token
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Phase 2.5: agent-bound tokens carry the agent's document id; cascade-delete
    // means revoking the agent revokes its token. Human PATs have agentId NULL.
    agentId: text('agent_id').references(() => documents.id, { onDelete: 'cascade' }),
    // Optional project narrowing — must be subset of agent.frontmatter.projects.
    // null = inherit from agent (distinct from [] which = no projects).
    projectIds: text('project_ids', { mode: 'json' }).$type<string[] | null>(),
    createdBy: text('created_by').references(() => users.id),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    hashIdx: uniqueIndex('api_tokens_hash_idx').on(t.tokenHash),
    workspaceIdx: index('api_tokens_workspace_idx').on(t.workspaceId),
  }),
);

/** Encrypted BYOK AI provider credentials — INSTANCE-level (workspace-independent).
 *  A key is identified by (provider, label); the runner resolves an agent's key
 *  by (provider, ai_key_label) with no workspace tie (the B6 reversal). The
 *  secret never leaves a server-side provider call. */
export const aiKeys = sqliteTable(
  'ai_keys',
  {
    id: text('id').primaryKey(),
    provider: text('provider', {
      enum: ['anthropic', 'openai', 'openrouter', 'ollama'],
    }).notNull(),
    label: text('label').notNull().default('default'),
    encryptedKey: text('encrypted_key').notNull(), // libsodium-style ciphertext
    baseUrl: text('base_url'), // for ollama / custom endpoints
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    providerLabelIdx: uniqueIndex('ai_keys_provider_label_idx').on(t.provider, t.label),
  }),
);

/* M8 metering note: per-run AI usage is NOT a separate table. Each `agent_run`
 * document already records `tokens_in`/`tokens_out` (written by incrementTokens
 * on every path — success, error, or resume) alongside its `workspace_id`,
 * `provider`, and `ai_key_label`. The run row IS the always-recorded, attributable
 * meter; the shared-instance-key denial-of-wallet residual is observable by
 * aggregating runs per workspace. Per-key enforcement caps are a deferred phase.
 * (A dedicated ai_usage table was dropped at /shakeout as redundant — it only
 * re-copied fields already on the run row, and only on the success path.) */

/**
 * Instance-level agent skills. A skill is a markdown body + frontmatter; when
 * `trusted` is set, the runner loads its body as TRUSTED INSTRUCTIONS into an
 * agent's system prompt (otherwise it loads as untrusted DATA).
 *
 * SECURITY: `trusted` is a TYPED FIRST-CLASS COLUMN, never a key inside the
 * `frontmatter` JSON blob. A `trusted:true` skill becomes trusted instructions
 * in an agent prompt, so trust is privilege. If `trusted` rode in the JSON blob,
 * any wholesale-frontmatter write (skill edit, bulk import, restore) could forge
 * `trusted:true`. As its own column, import/restore — which write body +
 * frontmatter — physically cannot reach it; only a dedicated mutator can. That
 * is what makes the trust-forging attack structurally impossible.
 *
 * Additive only: nothing reads or seeds this table yet (the loader + seeder land
 * in a later task).
 */
export const instanceSkills = sqliteTable(
  'instance_skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    frontmatter: text('frontmatter', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // SECURITY: typed column, never a frontmatter key — see the table doc above.
    trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    nameIdx: uniqueIndex('instance_skills_name_idx').on(t.name),
  }),
);

/**
 * Generic instance-level key/value config store. One row per setting (`key`
 * PK), `value` a JSON blob. Home for instance-wide settings that aren't worth a
 * dedicated table — e.g. `operator_model` ({provider, model, ai_key_label}: which
 * configured provider+model the operator runs on). Read defensively (a corrupt
 * value degrades to the default at the consumer, not a crash).
 */
export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/** Append-only event log. SSE channel + agent webhooks both read from here. */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    documentId: text('document_id'),
    kind: text('kind').notNull(), // document.created, document.updated, status.changed, ...
    actor: text('actor'), // user_id or api_token_id
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull().default({}),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    // H3 — monotonic per-row sequence used as the canonical replay cursor.
    // emitEvent computes `MAX(seq) + 1` inside the same tx as the insert;
    // SQLite's writer lock serializes max() + insert so the value is
    // unique + monotonic. Migration 0009 added the column + backfilled
    // existing rows from rowid (also monotonic per insertion).
    seq: integer('seq').notNull().default(0),
  },
  (t) => ({
    workspaceIdx: index('events_workspace_idx').on(t.workspaceId, t.createdAt),
    documentIdx: index('events_document_idx').on(t.documentId),
    seqIdx: uniqueIndex('events_seq_idx').on(t.seq),
    // B3: composite for SSE replay paginated cursor — covers both the WHERE
    // (workspace_id + seq > ?) and the ORDER BY (seq ASC) in one index seek.
    workspaceSeqIdx: index('events_workspace_seq_idx').on(t.workspaceId, t.seq),
  }),
);

/**
 * Reaction Plane (Phase 3 C-10b) — per-reactor replay cursor over `events`.
 *
 * The durable event dispatcher polls `events` by `seq` and fans each event out
 * to registered reactors. Each reactor's cursor (`last_seq`) advances ONLY on
 * a successful `react()` (cursor-after / at-least-once). The cursor is seeded
 * at MAX(seq) EAGERLY at server boot (seedReactorCursors, before traffic) so
 * reactors start "from now", never replay history, AND don't race startup
 * writes (the F-4/F-6 fix — lazy seeding raced events written during boot).
 * Cursor-lag (`MAX(seq) − last_seq`) is the durable truth for reactor health
 * (spec §4b).
 */
export const reactorCursors = sqliteTable('reactor_cursors', {
  reactorId: text('reactor_id').primaryKey(),
  lastSeq: integer('last_seq').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * Operator cockpit chat — `conversations`, `messages`, `pending_ops`.
 *
 * DELIBERATE EXCEPTION to invariants 5 + 10 (see ARCHITECTURE-INVARIANTS.md
 * "Deliberate exceptions"). These are NOT document types and their writes MUST
 * NOT go through `txWithEvents`: a conversation must never appear in `/documents`,
 * and emitting an event per chat turn would flood the SSE stream + fire the
 * trigger-matcher on document-watching triggers. Chat persistence uses plain
 * `db` transactions, no `emitEvent` (`apps/server/src/services/conversations.ts`).
 *
 * `active_run_id` (nullable) is the single-active-turn slot (threat model M14):
 * "running = id present". Modeled as a nullable id, NOT a boolean, so a future
 * `cancelling` run-status fits without a migration.
 *
 * NO foreign keys — deliberate, tracking the event-plane seam (`events.documentId`,
 * `reactor_cursors` likewise omit FKs): these are walled off from the cascade-managed
 * entity core. CONSEQUENCE for whoever ships conversation-delete (deferred to v1.1
 * multi-thread management): there is NO DB cascade, so that delete MUST manually GC the
 * conversation's `messages` + `pending_ops` rows (and a dangling `pending_ops` row could
 * otherwise still be confirmed by the T7 gate). Flagged Cluster-1 /code-review 2026-06-05.
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    createdBy: text('created_by').notNull(),
    operatorAgentId: text('operator_agent_id').notNull(),
    activeRunId: text('active_run_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    byUser: index('conversations_user_idx').on(t.createdBy, t.updatedAt),
  }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // 'user' | 'operator'
    kind: text('kind').notNull(), // 'text' | 'tool_step' | 'component'
    body: text('body').notNull().default(''),
    payload: text('payload'), // JSON for tool_step/component
    runId: text('run_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // UNIQUE — the structural backstop for the MAX(seq)+1 allocator in
    // conversations.ts (mirrors events.seq's uniqueIndex). The single-active-turn
    // CAS (M14, T6) is the primary guarantee against concurrent appends; this index
    // is defense-in-depth: if that CAS is ever bypassed, a duplicate seq fails LOUD
    // (constraint violation) instead of silently corrupting thread order.
    byConvSeq: uniqueIndex('messages_conv_seq_idx').on(t.conversationId, t.seq),
  }),
);

export const pendingOps = sqliteTable('pending_ops', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  callerId: text('caller_id').notNull(),
  op: text('op').notNull(),
  params: text('params').notNull(), // immutable once recorded — executed verbatim
  target: text('target').notNull(),
  status: text('status').notNull().default('pending'), // 'pending'|'confirmed'|'executed'|'rejected'|'expired'
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  executedAt: integer('executed_at', { mode: 'timestamp_ms' }), // audit (T7): when the destructive op ran
  executedBy: text('executed_by'), // audit (T7): who confirmed it
});

// --- Type exports ---

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type TableEntity = typeof tables.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Status = typeof statuses.$inferSelect;
export type Field = typeof fields.$inferSelect;
export type View = typeof views.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type AiKey = typeof aiKeys.$inferSelect;
export type InstanceSkill = typeof instanceSkills.$inferSelect;
export type Event = typeof events.$inferSelect;
export type ReactorCursor = typeof reactorCursors.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type PendingOp = typeof pendingOps.$inferSelect;
