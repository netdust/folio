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
});

export const memberships = sqliteTable(
  'memberships',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] })
      .notNull()
      .default('member'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
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
        'currency',
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
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tableId: text('table_id').references(() => tables.id, { onDelete: 'set null' }),
    type: text('type', { enum: ['work_item', 'page', 'agent', 'trigger'] }).notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    status: text('status'), // matches a statuses.key for work_items; null for pages
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
    parentIdx: index('documents_parent_idx').on(t.parentId),
    tableIdx: index('documents_table_idx').on(t.tableId),
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(), // sha256 of the bearer token
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
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

/** Encrypted BYOK AI provider credentials, per workspace. */
export const aiKeys = sqliteTable(
  'ai_keys',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
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
    workspaceProviderIdx: uniqueIndex('ai_keys_workspace_provider_idx').on(
      t.workspaceId,
      t.provider,
      t.label,
    ),
  }),
);

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
  },
  (t) => ({
    workspaceIdx: index('events_workspace_idx').on(t.workspaceId, t.createdAt),
    documentIdx: index('events_document_idx').on(t.documentId),
  }),
);

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
export type Event = typeof events.$inferSelect;
