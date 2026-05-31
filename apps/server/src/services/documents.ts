/**
 * MCP-relevant document service layer.
 *
 * These services contain the same DB writes + event emissions as the
 * documents route handlers, exposed as pure async functions. The MCP server
 * (Task 12b) calls them directly without going through HTTP. Routes become
 * thin wrappers around these.
 *
 * Out of scope for v1 (kept inline in the route): markdown POST/PATCH body
 * parsing — MCP only speaks JSON. The route handles the markdown branch and
 * still calls `validateStatus` etc. directly.
 */

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  slugify,
  filterCompile,
  FilterCompileError,
} from '@folio/shared';
import { db } from '../db/client.ts';
import {
  apiTokens,
  documents,
  statuses,
} from '../db/schema.ts';
import type {
  ApiToken,
  Document,
  Project,
  TableEntity,
  User,
  Workspace,
} from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { agentFrontmatterSchema, toolsToScopes } from '../lib/agent-schema.ts';
import { triggerFrontmatterSchema } from '../lib/trigger-schema.ts';
import { resolveAgentProjects } from '../lib/agent-projects.ts';
import { newApiToken } from '../lib/auth.ts';
import { walkParentChain } from '../lib/delegation-guard.ts';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
import { slugUniqueInDocuments, slugUniqueInWorkspaceDocuments } from '../lib/slug-unique.ts';

// ----- shared types & helpers (kept service-private; routes don't import) -----

export type DocumentType = 'work_item' | 'page' | 'agent' | 'trigger' | 'agent_run';

const RESERVED_FRONTMATTER_KEYS = [
  'type',
  'title',
  'status',
  'last_touched_at',
] as const;

export function stripReservedFrontmatter(
  fm: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if ((RESERVED_FRONTMATTER_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function getAssignee(fm: unknown): string | null {
  if (typeof fm !== 'object' || fm === null) return null;
  const v = (fm as Record<string, unknown>)['assignee'];
  return typeof v === 'string' ? v : null;
}

async function validateStatusForTable(
  tableId: string,
  status: string | null | undefined,
): Promise<void> {
  if (status == null) return;
  const row = await db.query.statuses.findFirst({
    where: and(eq(statuses.tableId, tableId), eq(statuses.key, status)),
  });
  if (!row) {
    throw new HTTPError(
      'INVALID_STATUS',
      `status "${status}" not in registry`,
      422,
    );
  }
}

// ----- list/get reads -----

const SORT_COLUMNS = {
  title: documents.title,
  status: documents.status,
  updated_at: documents.updatedAt,
} as const;
export type SortKey = keyof typeof SORT_COLUMNS;
export type SortDir = 'asc' | 'desc';

// status is NULLABLE — coalesce NULL to a high sentinel (max BMP codepoint) so
// NULLs sort LAST in asc (first in desc) and the keyset cursor can address
// them. The SAME sentinel must be used in ORDER BY, the keyset predicate, AND
// the cursor value, or NULL-status rows silently drop across page boundaries.
// title/updated_at are notNull, so they keep using the raw column.
const NULL_SENTINEL = '￿';
function sortExpr(key: SortKey): SQL {
  if (key === 'status') return sql`coalesce(${documents.status}, ${NULL_SENTINEL})`;
  // SQLiteColumn is an SQLWrapper; the comparison/order helpers accept it, but
  // the union with SQL confuses overload resolution. Normalize to SQL.
  return sql`${SORT_COLUMNS[key]}`;
}

function resolveSort(sort?: string, dir?: string): { key: SortKey; dir: SortDir } {
  const key = (sort && sort in SORT_COLUMNS ? sort : 'updated_at') as SortKey;
  const d: SortDir = dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : key === 'updated_at' ? 'desc' : 'asc';
  return { key, dir: d };
}

function encodeCursor(sortKey: SortKey, sortValue: string, id: string): string {
  return Buffer.from(`${sortKey}:${Buffer.from(sortValue).toString('base64')}:${id}`).toString('base64');
}

function decodeCursor(s: string): { sortKey: SortKey; sortValue: string; id: string } | null {
  try {
    const [sortKey, b64v, id] = Buffer.from(s, 'base64').toString().split(':');
    if (!sortKey || !(sortKey in SORT_COLUMNS) || b64v === undefined || !id) return null;
    return { sortKey: sortKey as SortKey, sortValue: Buffer.from(b64v, 'base64').toString(), id };
  } catch {
    return null;
  }
}

export interface ListDocumentsOptions {
  projectId: string;
  /**
   * The active table id. Only consulted when `type === 'work_item'` or when
   * no type is given AND a table id should be enforced. The route decides
   * whether to pass this; MCP can pass null to skip table-scoping.
   */
  activeTableId?: string | null;
  type?: 'work_item' | 'page' | string;
  limit?: number;
  cursor?: string;
  filter?: unknown; // already parsed JSON or undefined
  statusValues?: string[];
  assignee?: string;
  updatedSince?: string;
  staleFor?: string;
  sort?: string;
  dir?: string;
}

export async function listDocuments(
  opts: ListDocumentsOptions,
): Promise<{ data: Document[]; nextCursor: string | null }> {
  const limit = Math.min(200, opts.limit ?? 50);

  const whereClauses = [eq(documents.projectId, opts.projectId)];
  // Apply the type filter for every known DocumentType. Previously this
  // branch was hard-coded to work_item/page, so when documents.type was
  // widened in Phase 2 to include agent + trigger, ?type=agent / ?type=trigger
  // silently degraded to "no type filter" and returned every doc on the
  // project. The set membership keeps the fix tight to the union members.
  // C1 (Phase-3 shake-out): an EXPLICIT `type=agent_run` must be rejected at
  // the source, not listed. agent_run rows are runner-owned and carry
  // operator-sensitive frontmatter (system_prompt, provider, tokens); every
  // other generic-document path (single GET, markdown, create, update, delete)
  // already rejects them with AGENT_RUN_REQUIRES_RUNNER_PATH, but this list
  // path treated `agent_run` as a queryable type — leaking system_prompt to any
  // documents:read bearer. Reject here so the wall is complete regardless of
  // caller (defense in depth; the route also early-rejects for a clean error).
  // The runs UI reads runs via GET /api/v1/w/:wslug/p/:pslug/runs.
  if ((opts.type as string) === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are runner-owned; list via the /runs endpoints, not the generic document endpoint',
      422,
    );
  }
  // `agent_run` is intentionally absent: it is rejected above, never listed.
  const KNOWN_TYPES: ReadonlySet<DocumentType> = new Set([
    'work_item',
    'page',
    'agent',
    'trigger',
  ]);
  if (opts.type && KNOWN_TYPES.has(opts.type as DocumentType)) {
    whereClauses.push(eq(documents.type, opts.type as DocumentType));
  } else {
    // R2 fix (post-review-of-review) — when no explicit type filter is
    // supplied, EXCLUDE agent_run rows from generic-document listings.
    // agent_run rows are runner-owned (mitigations 23-47); the runs UI
    // (Sub-phase D) reads them via /api/v1/p/:pslug/runs. Allowing
    // them through the default listing was the read-side counterpart
    // to the cross-route attack surface bundle 4 closed for writes —
    // FE consumers with a 4-member type union narrow would silently
    // drop or mis-route them, and a `documents:read` bearer could
    // enumerate them by slug.
    whereClauses.push(ne(documents.type, 'agent_run'));
  }
  // Table-scoping rules: work_items use the active table; pages, agents, and
  // triggers are project-scoped (tableId IS NULL is enforced at write time).
  if (opts.type === 'work_item') {
    if (opts.activeTableId) {
      whereClauses.push(eq(documents.tableId, opts.activeTableId));
    }
  } else if (opts.type === 'page') {
    whereClauses.push(isNull(documents.tableId));
  }

  const statusValues = (opts.statusValues ?? []).filter((s) => s.length > 0);
  if (statusValues.length === 1) {
    whereClauses.push(eq(documents.status, statusValues[0]!));
  } else if (statusValues.length > 1) {
    whereClauses.push(inArray(documents.status, statusValues));
  }

  if (opts.assignee) {
    whereClauses.push(
      sql`json_extract(${documents.frontmatter}, '$.assignee') = ${opts.assignee}`,
    );
  }

  if (opts.updatedSince) {
    const ts = new Date(opts.updatedSince);
    if (!Number.isNaN(ts.getTime())) {
      whereClauses.push(gte(documents.updatedAt, ts));
    }
  }

  if (opts.staleFor) {
    const m = opts.staleFor.match(/^(\d+)d$/);
    const days = m ? Number(m[1]) : NaN;
    if (!m || !Number.isFinite(days) || days < 1) {
      throw new HTTPError(
        'INVALID_STALE_FOR',
        'stale_for must be a positive integer followed by "d" (e.g. "7d")',
        422,
      );
    }
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const staleClause = or(
      isNull(documents.lastTouchedAt),
      lt(documents.lastTouchedAt, cutoff),
    );
    if (staleClause) whereClauses.push(staleClause);
  }

  if (opts.filter !== undefined && opts.filter !== null) {
    try {
      const ast = filterCompile(opts.filter as Parameters<typeof filterCompile>[0]);
      const where = compileFilterToWhere(ast, documents);
      if (where) whereClauses.push(where);
    } catch (e) {
      if (e instanceof FilterCompileError) {
        throw new HTTPError('INVALID_FILTER', e.message, 422);
      }
      throw e;
    }
  }

  const { key: sortKey, dir: sortDir } = resolveSort(opts.sort, opts.dir);
  const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
  const cursor = decoded && decoded.sortKey === sortKey ? decoded : null;

  if (cursor) {
    const cmpGt = sortDir === 'asc' ? gt : lt;
    if (sortKey === 'updated_at') {
      const ts = new Date(Number(cursor.sortValue));
      whereClauses.push(
        or(
          cmpGt(documents.updatedAt, ts),
          and(eq(documents.updatedAt, ts), cmpGt(documents.id, cursor.id)),
        ) as never,
      );
    } else {
      const col = sortExpr(sortKey);
      whereClauses.push(
        or(
          cmpGt(col, cursor.sortValue),
          and(eq(col, cursor.sortValue), cmpGt(documents.id, cursor.id)),
        ) as never,
      );
    }
  }

  const dirFn = sortDir === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(documents)
    .where(and(...whereClauses))
    .orderBy(dirFn(sortExpr(sortKey)), dirFn(documents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) {
    const sortValue =
      sortKey === 'updated_at'
        ? String(last.updatedAt.getTime())
        : sortKey === 'status'
          ? String(last.status ?? NULL_SENTINEL)
          : String((last as Record<string, unknown>)[sortKey] ?? '');
    nextCursor = encodeCursor(sortKey, sortValue, last.id);
  }
  return { data: page, nextCursor };
}

export async function getDocument(
  projectId: string,
  slug: string,
): Promise<Document | null> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, projectId), eq(documents.slug, slug)),
  });
  return row ?? null;
}

// ----- writes -----

export interface CreateDocumentInput {
  type: DocumentType;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  status: string | null;
}

export interface CreateDocumentArgs {
  workspace: Workspace;
  /**
   * Required for work_item / page (project-scoped types).
   * Must be null for agent / trigger (workspace-scoped — Phase 2.5).
   * The CHECK constraint on documents enforces the invariant at the DB layer;
   * the service asserts it up front for a clean error message.
   */
  project: Project | null;
  /** Required when input.type === 'work_item'. Null for non-table types. */
  table: TableEntity | null;
  actor: User;
  /** The bearer token for the request, or null for session-auth. Used by delegation guard. */
  token: ApiToken | null;
  /**
   * Set to true only when the caller routes through a table-scoped URL (e.g.
   * /t/:tslug/documents). The service then rejects agent/trigger creation.
   * MCP always passes false.
   */
  isTableScopedUrl?: boolean;
  input: CreateDocumentInput;
}

export interface CreateDocumentResult {
  document: Document;
  /** Plaintext bearer token, returned ONCE on agent creation. */
  agentTokenPlaintext?: string;
}

export async function createDocument(
  args: CreateDocumentArgs,
): Promise<CreateDocumentResult> {
  const { workspace: ws, project: p, actor: user, token } = args;
  const input: CreateDocumentInput = {
    ...args.input,
    frontmatter: stripReservedFrontmatter(args.input.frontmatter ?? {}),
  };

  // G15: comments are created through createComment (services/comments.ts),
  // which resolves the author context and parses mentions. The generic doc
  // path can't do either — the DB CHECK constraint blocks the actual insert
  // (comments require parent_id; this path hard-codes it to null) but the
  // resulting SQLITE_CONSTRAINT_CHECK error is opaque.
  //
  // The cast-to-string is intentional: the service-layer DocumentType union
  // excludes 'comment', but MCP coerces raw client strings via
  // `as DocumentType` (routes/mcp.ts createDocument), so a hostile/buggy
  // MCP caller can still drive this path with type='comment' at runtime.
  // The mcp.test.ts G15 test exercises that path — restoring this guard
  // (which appeared dead to TS-only analysis) is a real defense.
  if ((input.type as string) === 'comment') {
    throw new HTTPError(
      'COMMENT_REQUIRES_COMMENT_TOOL',
      "comment documents must be created via POST /comments (or MCP create_comment), not the generic document endpoint",
      422,
    );
  }

  // F9 fix (post-C.1 review) — same shape as the comment guard above.
  // agent_run rows have a fixed Zod schema, a fixed slug shape, and
  // the migration-0012 CHECK constraint requires table_id + parent_id
  // NOT NULL — none of which the generic createDocument path fills
  // for non-work_item types. createRun (services/agent-runs.ts) is
  // the only sound entry. A buggy MCP caller driving createDocument
  // with type='agent_run' would otherwise hit SQLITE_CONSTRAINT_CHECK
  // and surface an opaque 500.
  if ((input.type as string) === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are created by the runner (services/agent-runs.ts::createRun), not the generic document endpoint',
      422,
    );
  }

  // Phase 2.5 invariant: agent/trigger ⇒ project=null; work_item/page ⇒ project required.
  // The CHECK constraint also enforces this at the DB layer; the service-level guard
  // gives a clean error message instead of "SQLITE_CONSTRAINT_CHECK".
  const isWorkspaceScoped = input.type === 'agent' || input.type === 'trigger';
  if (isWorkspaceScoped && p !== null) {
    throw new HTTPError(
      'INVALID_DOCUMENT_SCOPE',
      `${input.type} documents are workspace-scoped; project must be null`,
      422,
    );
  }
  if (!isWorkspaceScoped && p === null) {
    throw new HTTPError(
      'INVALID_DOCUMENT_SCOPE',
      `${input.type} documents are project-scoped; project is required`,
      422,
    );
  }

  // Agents and triggers cannot be created on a table-scoped URL.
  if (isWorkspaceScoped) {
    if (args.isTableScopedUrl) {
      throw new HTTPError(
        'INVALID_BODY',
        `${input.type} documents cannot be created on a table-scoped URL`,
        422,
      );
    }
    const schema =
      input.type === 'agent' ? agentFrontmatterSchema : triggerFrontmatterSchema;
    const r = schema.safeParse(input.frontmatter ?? {});
    if (!r.success) {
      const code =
        input.type === 'agent'
          ? 'INVALID_AGENT_FRONTMATTER'
          : 'INVALID_TRIGGER_FRONTMATTER';
      throw new HTTPError(code, r.error.message, 422);
    }
    input.frontmatter = r.data as Record<string, unknown>;
  }

  // work_items live inside a table; pages have tableId=null.
  let tableId: string | null = null;
  if (input.type === 'work_item') {
    if (!args.table) {
      throw new HTTPError(
        'TABLE_NOT_FOUND',
        'work_item requires a table',
        404,
      );
    }
    tableId = args.table.id;
    await validateStatusForTable(tableId, input.status);
  }

  const id = nanoid();
  const baseSlug = slugify(input.title) || 'doc';
  // Agents/triggers dedupe slugs at workspace level (unique on workspace_id+type+slug);
  // work_items/pages stay project-scoped (unique on project_id+slug).
  const slug = isWorkspaceScoped
    ? await slugUniqueInWorkspaceDocuments(db, ws.id, input.type as 'agent' | 'trigger', baseSlug)
    : await slugUniqueInDocuments(db, p!.id, baseSlug);

  // For agents: mint a bearer token now so its id can be patched into the
  // frontmatter BEFORE the document insert. Plaintext is returned ONCE.
  let agentTokenPlaintext: string | undefined;
  let agentTokenHash: string | undefined;
  let agentApiTokenId: string | undefined;
  if (input.type === 'agent') {
    const { token: t, hash } = newApiToken();
    agentTokenPlaintext = t;
    agentTokenHash = hash;
    agentApiTokenId = nanoid();
    input.frontmatter = { ...input.frontmatter, api_token_id: agentApiTokenId };
  }

  const row = {
    id,
    projectId: p?.id ?? null,
    workspaceId: ws.id,
    tableId,
    type: input.type,
    slug,
    title: input.title,
    status: input.status,
    body: input.body,
    frontmatter: input.frontmatter,
    parentId: null as string | null,
    createdBy: user.id,
    updatedBy: user.id,
  };

  // Delegation guard: when a bearer-auth'd agent creates a work_item
  // assigning it to another agent, enforce the actor agent's
  // max_delegation_depth. Agents live at workspace scope (Phase 2.5), so look
  // them up by workspaceId + type, not by project.
  if (token && input.type === 'work_item') {
    const childAssignee = getAssignee(input.frontmatter);
    if (childAssignee?.startsWith('agent:')) {
      const allAgents = await db.query.documents.findMany({
        where: and(
          eq(documents.workspaceId, ws.id),
          eq(documents.type, 'agent'),
        ),
      });
      const ownerAgent = allAgents.find(
        (a) =>
          (a.frontmatter as Record<string, unknown>)['api_token_id'] ===
          token.id,
      );
      if (ownerAgent) {
        const ownerFm = ownerAgent.frontmatter as Record<string, unknown>;
        const maxDepth =
          (ownerFm['max_delegation_depth'] as number | undefined) ?? 2;
        const lookup = {
          findAgentBySlug: async (slugIn: string) => {
            const r = await db.query.documents.findFirst({
              where: and(
                eq(documents.workspaceId, ws.id),
                eq(documents.type, 'agent'),
                eq(documents.slug, slugIn),
              ),
            });
            if (!r) return null;
            const fm = r.frontmatter as Record<string, unknown>;
            return {
              parent: (fm['parent_agent'] as string | null | undefined) ?? null,
              max_delegation_depth:
                (fm['max_delegation_depth'] as number | undefined) ?? 2,
            };
          },
        };
        try {
          const ownerDepth = await walkParentChain(ownerAgent.slug, lookup);
          if (ownerDepth + 1 > maxDepth) {
            throw new HTTPError(
              'DELEGATION_DEPTH_EXCEEDED',
              `agent ${ownerAgent.slug} cannot delegate past max_delegation_depth ${maxDepth} (current ${ownerDepth + 1})`,
              403,
            );
          }
        } catch (err) {
          if (err instanceof HTTPError) throw err;
          throw new HTTPError('DELEGATION_GUARD_FAILED', String(err), 500);
        }
      }
    }
  }

  await txWithEvents(db, async (tx) => {
    await tx.insert(documents).values(row);
    if (input.type === 'agent' && agentApiTokenId && agentTokenHash) {
      const tools = (input.frontmatter as { tools: string[] }).tools;
      await tx.insert(apiTokens).values({
        id: agentApiTokenId,
        workspaceId: ws.id,
        name: `agent:${slug}`,
        tokenHash: agentTokenHash,
        scopes: toolsToScopes(tools),
        agentId: id,
        createdBy: user.id,
      });
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: p?.id ?? null,
        documentId: id,
        kind: 'agent.created',
        actor: user.id,
        payload: { slug, api_token_id: agentApiTokenId },
      });
    }
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p?.id ?? null,
      documentId: id,
      kind: 'document.created',
      actor: user.id,
      payload: { slug, type: input.type },
    });
    if (input.type === 'work_item' && p) {
      const assignee = getAssignee(input.frontmatter);
      if (assignee && assignee.startsWith('agent:')) {
        const agentSlug = assignee.slice('agent:'.length);
        // S2: enrich agent.task.assigned with agent_id. Slugs are mutable;
        // dispatchers consuming this event need an immutable handle so an
        // agent renamed between emit and consumption still resolves.
        // agent_id may be null when the slug doesn't (yet) resolve to a
        // workspace agent — assignment of an unknown slug is still a
        // legitimate UX (user types speculatively), so we emit anyway and
        // dispatchers must handle the unresolved case.
        const agentRow = await tx.query.documents.findFirst({
          where: and(
            eq(documents.workspaceId, ws.id),
            eq(documents.type, 'agent'),
            eq(documents.slug, agentSlug),
          ),
        });
        await emitEvent(tx, {
          workspaceId: ws.id,
          projectId: p.id,
          documentId: id,
          kind: 'agent.task.assigned',
          actor: user.id,
          payload: {
            slug,
            agent: agentSlug,
            agent_id: agentRow?.id ?? null,
          },
        });
      }
    }
  });

  return { document: row as unknown as Document, agentTokenPlaintext };
}

// ----- update -----

export interface DocumentPatch {
  title?: string;
  body?: string;
  status?: string | null;
  frontmatter?: Record<string, unknown>;
  parentId?: string | null;
}

export interface UpdateDocumentArgs {
  workspace: Workspace;
  /** Null for agent/trigger (workspace-scoped) — Phase 2.5. */
  project: Project | null;
  /** Required when existing.type === 'work_item' and existing.tableId is null. */
  fallbackTable: TableEntity | null;
  actor: User;
  existing: Document;
  patch: DocumentPatch;
}

// "Auto-derived" = the slug was generated from the previous title at create
// time (or auto-disambiguated with `-N`). Strip a trailing `-<digits>` and
// compare to slugify(oldTitle). The `untitled` special case covers fresh docs
// where the create-time slug is literally `untitled`.
function isSlugAutoDerived(slug: string, oldTitle: string): boolean {
  if (slug === 'untitled') return true;
  const base = slug.replace(/-\d+$/, '');
  return base === slugify(oldTitle);
}

export async function maybeRegenerateSlug(
  projectId: string,
  existing: { slug: string; title: string },
  nextTitle: string,
): Promise<string | null> {
  if (nextTitle === existing.title) return null;
  if (!isSlugAutoDerived(existing.slug, existing.title)) return null;
  const baseSlug = slugify(nextTitle) || 'doc';
  if (baseSlug === existing.slug.replace(/-\d+$/, '')) return null;
  return slugUniqueInDocuments(db, projectId, baseSlug);
}

export async function updateDocument(
  args: UpdateDocumentArgs,
): Promise<Document> {
  const { workspace: ws, project: p, actor: user, existing, patch } = args;

  // G5 — comments must be mutated through update_comment (services/comments.ts),
  // which enforces author-only, kind-immutable, edited_at, and soft-delete
  // semantics. The generic update path used to fall through for type='comment'
  // on the HTTP project-scoped route — bypassing all of that. Reject at the
  // service layer so EVERY entrypoint inherits the rule (HTTP, MCP, future
  // CLI/import jobs).
  if (existing.type === 'comment') {
    throw new HTTPError(
      'COMMENT_REQUIRES_COMMENT_TOOL',
      "comment documents must be updated via PATCH /comments/:slug (or MCP update_comment), not the generic document endpoint",
      422,
    );
  }

  // F3 fix (post-C.1 review) — agent_run rows are runner-owned. The
  // state machine + closed error_reason enum + sanitizer + agent.run.*
  // event emission live in services/agent-runs.ts::transitionRun. A
  // generic updateDocument that merged arbitrary frontmatter would
  // bypass all of those. Reject defensively at the service layer so
  // EVERY entry point (HTTP, MCP, future CLI) inherits the rule.
  if (existing.type === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are runner-owned and mutate only via the runner / approve / cancel endpoints (Sub-phase D), not the generic document update endpoint',
      422,
    );
  }

  if (patch.status !== undefined && existing.type === 'work_item') {
    const tId = existing.tableId ?? args.fallbackTable?.id;
    if (!tId) {
      throw new HTTPError('TABLE_NOT_FOUND', 'work_item requires a table', 404);
    }
    await validateStatusForTable(tId, patch.status);
  }

  // Phase 2.6 sub-phase D — builtin trigger lock. Only frontmatter.enabled is
  // mutable. Title, body, status, parent, and any other frontmatter key are
  // server-controlled. The check compares each frontmatter key against the
  // existing row's value (not just key presence) so a client echoing back
  // the full frontmatter shape — as the slideover does — succeeds as long
  // as only `enabled` actually differs.
  if (
    existing.type === 'trigger' &&
    (existing.frontmatter as Record<string, unknown>).builtin === true
  ) {
    const fmPatch = patch.frontmatter ?? {};
    const existingFm = existing.frontmatter as Record<string, unknown>;
    const protectedKeyDiffers = Object.keys(fmPatch).some((k) => {
      if (k === 'enabled') return false;
      return JSON.stringify(fmPatch[k]) !== JSON.stringify(existingFm[k]);
    });
    const touchesProtectedTop =
      patch.title !== undefined ||
      patch.body !== undefined ||
      patch.status !== undefined ||
      patch.parentId !== undefined;
    if (touchesProtectedTop || protectedKeyDiffers) {
      throw new HTTPError(
        'BUILTIN_TRIGGER_LOCKED',
        'only frontmatter.enabled is mutable on builtin triggers',
        422,
      );
    }
  }

  // For agents/triggers, validate the PATCH payload itself (not the merged
  // result). Server-managed fields like api_token_id and last_fired_at would
  // fail .strict() if merged-validated. The trigger schema is a ZodEffects;
  // unwrap via innerType() before .partial() and skip the refine.
  if (
    patch.frontmatter !== undefined &&
    (existing.type === 'agent' || existing.type === 'trigger')
  ) {
    const schema =
      existing.type === 'agent'
        ? agentFrontmatterSchema.partial()
        : triggerFrontmatterSchema.innerType().partial();
    const r = schema.safeParse(patch.frontmatter);
    if (!r.success) {
      const code =
        existing.type === 'agent'
          ? 'INVALID_AGENT_FRONTMATTER'
          : 'INVALID_TRIGGER_FRONTMATTER';
      throw new HTTPError(code, r.error.message, 422);
    }
  }

  const mergedFrontmatter = (() => {
    if (patch.frontmatter === undefined) return existing.frontmatter;
    const merged: Record<string, unknown> = {
      ...(existing.frontmatter as Record<string, unknown>),
    };
    for (const [k, v] of Object.entries(patch.frontmatter)) {
      if ((RESERVED_FRONTMATTER_KEYS as readonly string[]).includes(k)) continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    return merged;
  })();

  // BUG-016 — re-validate the cross-field refine on triggers after the merge.
  // The PATCH-payload validation above uses `triggerFrontmatterSchema.innerType().partial()`
  // (refine stripped, server-managed fields like last_fired_at exempt from
  // .strict()). A PATCH that clears the only timing field is valid against
  // partial() but the resulting document would be rejected by the create-time
  // schema — dispatch then never fires. Assert the refine here on the merged
  // shape and reject with INVALID_PATCH so the operator sees the error
  // instead of a silently broken trigger.
  if (existing.type === 'trigger') {
    const scheduleVal = (mergedFrontmatter as Record<string, unknown>).schedule;
    const onEventVal = (mergedFrontmatter as Record<string, unknown>).on_event;
    const hasSchedule = scheduleVal !== null && scheduleVal !== undefined;
    const hasOnEvent = onEventVal !== null && onEventVal !== undefined;
    if (!hasSchedule && !hasOnEvent) {
      throw new HTTPError(
        'INVALID_PATCH',
        'trigger must have at least one of schedule or on_event after the patch',
        422,
      );
    }
  }

  // Agents/triggers don't rename their slug on title change (URLs are sticky
  // and frontmatter references would break). Only project-scoped docs do.
  const nextSlug =
    patch.title !== undefined && p
      ? await maybeRegenerateSlug(p.id, existing, patch.title)
      : null;

  const updated = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(nextSlug ? { slug: nextSlug } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    frontmatter: mergedFrontmatter,
    ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    updatedBy: user.id,
    updatedAt: new Date(),
  };

  await txWithEvents(db, async (tx) => {
    await tx.update(documents).set(updated).where(eq(documents.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p?.id ?? null,
      documentId: existing.id,
      kind: 'document.updated',
      actor: user.id,
      payload: {
        changes: [
          ...Object.keys(patch),
          ...(nextSlug ? ['slug'] : []),
        ],
      },
    });
    if (existing.type === 'work_item' && p) {
      const prevAssignee = getAssignee(existing.frontmatter);
      const nextAssignee = getAssignee(updated.frontmatter);
      if (
        nextAssignee &&
        nextAssignee.startsWith('agent:') &&
        prevAssignee !== nextAssignee
      ) {
        const agentSlug = nextAssignee.slice('agent:'.length);
        const agentRow = await tx.query.documents.findFirst({
          where: and(
            eq(documents.workspaceId, ws.id),
            eq(documents.type, 'agent'),
            eq(documents.slug, agentSlug),
          ),
        });
        await emitEvent(tx, {
          workspaceId: ws.id,
          projectId: p.id,
          documentId: existing.id,
          kind: 'agent.task.assigned',
          actor: user.id,
          payload: {
            slug: updated.slug,
            agent: agentSlug,
            // S2: see createDocument for the immutable-handle rationale.
            agent_id: agentRow?.id ?? null,
          },
        });
      }
    }
  });

  return updated as Document;
}

// ----- delete -----

export interface DeleteDocumentArgs {
  workspace: Workspace;
  /** Null for agent/trigger (workspace-scoped) — Phase 2.5. */
  project: Project | null;
  actor: User;
  existing: Document;
}

export async function deleteDocument(args: DeleteDocumentArgs): Promise<void> {
  const { workspace: ws, project: p, actor: user, existing } = args;

  // G5 — comments must be deleted through delete_comment for soft-delete +
  // author-only semantics. Reject at the service layer.
  if (existing.type === 'comment') {
    throw new HTTPError(
      'COMMENT_REQUIRES_COMMENT_TOOL',
      "comment documents must be deleted via DELETE /comments/:slug (or MCP delete_comment), not the generic document endpoint",
      422,
    );
  }

  // F3 fix (post-C.1 review) — agent_run rows are runner-owned. Deleting
  // them through the generic path would orphan their events + skip the
  // provider-health flush that DELETE /runs/:id will handle in
  // Sub-phase D. See `tasks/retro-follow-ups.md` C.1-R-1 for the
  // events.document_id FK question that needs resolving before D-side
  // deletes ship.
  if (existing.type === 'agent_run') {
    throw new HTTPError(
      'AGENT_RUN_REQUIRES_RUNNER_PATH',
      'agent_run documents are runner-owned and delete only via the runs endpoints (Sub-phase D), not the generic document endpoint',
      422,
    );
  }

  // Phase 2.6 sub-phase D — builtin triggers are not deletable.
  if (
    existing.type === 'trigger' &&
    (existing.frontmatter as Record<string, unknown>).builtin === true
  ) {
    throw new HTTPError(
      'BUILTIN_TRIGGER_LOCKED',
      'builtin triggers cannot be deleted',
      422,
    );
  }

  await txWithEvents(db, async (tx) => {
    // F8/G8/H8 — cascade ALL descendant rows (comments AND nested pages).
    // documents.parent_id has no SQL foreign key (Phase 2.6 migration 0007
    // omitted it deliberately to keep the table self-referential and
    // SQLite-portable), so the app layer must purge orphan rows itself.
    //
    // BUG-010 — the prior shape was a single recursive-CTE DELETE that
    // emitted no per-row events. UIs caching comment threads stale-displayed
    // indefinitely; Phase 3 audit logs mis-counted cascade scope; the
    // author-only invariant on `comment.deleted` was dead-letter for
    // cascaded comments. Walk the descendants in TS instead and fan out
    // one `comment.deleted` per cascaded comment + one `document.deleted`
    // per cascaded page/work_item. All inside the same tx via emitEvent,
    // so subscribers either see EVERY cascade event or none (rollback).
    if (existing.type === 'work_item' || existing.type === 'page') {
      const descendantRows = await tx.all<{
        id: string;
        type: string;
        slug: string;
        title: string;
        parent_id: string | null;
        frontmatter: string;
      }>(sql`
        WITH RECURSIVE descendants(id, type, slug, title, parent_id, frontmatter) AS (
          SELECT id, type, slug, title, parent_id, frontmatter
            FROM documents
            WHERE parent_id = ${existing.id}
          UNION ALL
          SELECT documents.id, documents.type, documents.slug, documents.title,
                 documents.parent_id, documents.frontmatter
            FROM documents
            INNER JOIN descendants ON documents.parent_id = descendants.id
        )
        SELECT id, type, slug, title, parent_id, frontmatter FROM descendants
      `);

      if (descendantRows.length > 0) {
        const ids = descendantRows.map((r) => r.id);
        await tx.delete(documents).where(inArray(documents.id, ids));

        for (const d of descendantRows) {
          if (d.type === 'comment') {
            // Parse frontmatter to recover author for the event payload —
            // mirrors deleteComment's `comment.deleted` shape so any
            // subscriber that handles direct deletes also handles cascade.
            let author: string | undefined;
            try {
              const fm = JSON.parse(d.frontmatter) as { author?: string };
              author = typeof fm.author === 'string' ? fm.author : undefined;
            } catch {
              // ignore — payload's `author` will be undefined.
            }
            await emitEvent(tx, {
              workspaceId: ws.id,
              projectId: p?.id ?? null,
              documentId: d.id,
              kind: 'comment.deleted',
              actor: user.id,
              payload: { document_id: d.id, parent_id: d.parent_id, author },
            });
          } else {
            await emitEvent(tx, {
              workspaceId: ws.id,
              projectId: p?.id ?? null,
              documentId: d.id,
              kind: 'document.deleted',
              actor: user.id,
              payload: { id: d.id, slug: d.slug, type: d.type, title: d.title },
            });
          }
        }
      }
    }

    // Agents: api_tokens.agent_id ON DELETE CASCADE handles token revocation.
    // The explicit Phase 2 cleanup (delete by api_token_id from frontmatter)
    // is now redundant but harmless if any rows pre-date the cascade FK.
    await tx.delete(documents).where(eq(documents.id, existing.id));
    if (existing.type === 'agent') {
      const apiTokenId = (existing.frontmatter as Record<string, unknown>)[
        'api_token_id'
      ];
      if (typeof apiTokenId === 'string') {
        await tx.delete(apiTokens).where(eq(apiTokens.id, apiTokenId));
      }
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: p?.id ?? null,
        documentId: existing.id,
        kind: 'agent.deleted',
        actor: user.id,
        payload: { slug: existing.slug },
      });
    }
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p?.id ?? null,
      documentId: existing.id,
      kind: 'document.deleted',
      actor: user.id,
      payload: {
        id: existing.id,
        slug: existing.slug,
        type: existing.type,
        title: existing.title,
      },
    });
  });
}

// ----- workspace-scoped readers (Phase 2.5) -----

/** Workspace-scoped variant for agent/trigger lookup by slug. */
export async function getWorkspaceDocument(
  workspaceId: string,
  type: 'agent' | 'trigger',
  slug: string,
): Promise<Document | null> {
  const row = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.type, type),
      eq(documents.slug, slug),
    ),
  });
  return row ?? null;
}

/** List workspace-scoped agents/triggers, optionally narrowed to those allow-listed for a project. */
export async function listWorkspaceDocuments(opts: {
  workspaceId: string;
  type: 'agent' | 'trigger';
  /** When set, filter to docs whose frontmatter.projects includes '*' or this id. */
  projectFilter?: string | null;
}): Promise<Document[]> {
  const rows = await db.query.documents.findMany({
    where: and(
      eq(documents.workspaceId, opts.workspaceId),
      eq(documents.type, opts.type),
    ),
  });
  if (!opts.projectFilter) return rows;
  // BUG-018 — route through resolveAgentProjects so legacy / hand-edited
  // rows missing `frontmatter.projects` fall back to ['*'] (workspace-wide)
  // instead of being silently dropped. Mirrors the contract that bearer,
  // SSE, mention-parser, and the reconciler all share.
  const target = opts.projectFilter;
  return rows.filter((d) => {
    const projs = resolveAgentProjects(d);
    return projs.includes('*') || projs.includes(target);
  });
}

