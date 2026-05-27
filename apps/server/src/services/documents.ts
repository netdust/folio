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

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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
import { newApiToken } from '../lib/auth.ts';
import { walkParentChain } from '../lib/delegation-guard.ts';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
import { slugUniqueInDocuments, slugUniqueInWorkspaceDocuments } from '../lib/slug-unique.ts';

// ----- shared types & helpers (kept service-private; routes don't import) -----

export type DocumentType = 'work_item' | 'page' | 'agent' | 'trigger';

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

function encodeCursor(updatedAt: number, id: string): string {
  return Buffer.from(`${updatedAt}:${id}`).toString('base64');
}

function decodeCursor(s: string): { updatedAt: number; id: string } | null {
  try {
    const raw = Buffer.from(s, 'base64').toString('utf8');
    const [t, id] = raw.split(':');
    const updatedAt = Number(t);
    if (!Number.isFinite(updatedAt) || !id) return null;
    return { updatedAt, id };
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
}

export async function listDocuments(
  opts: ListDocumentsOptions,
): Promise<{ data: Document[]; nextCursor: string | null }> {
  const limit = Math.min(200, opts.limit ?? 50);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const whereClauses = [eq(documents.projectId, opts.projectId)];
  // Apply the type filter for every known DocumentType. Previously this
  // branch was hard-coded to work_item/page, so when documents.type was
  // widened in Phase 2 to include agent + trigger, ?type=agent / ?type=trigger
  // silently degraded to "no type filter" and returned every doc on the
  // project. The set membership keeps the fix tight to the union members.
  const KNOWN_TYPES: ReadonlySet<DocumentType> = new Set([
    'work_item',
    'page',
    'agent',
    'trigger',
  ]);
  if (opts.type && KNOWN_TYPES.has(opts.type as DocumentType)) {
    whereClauses.push(eq(documents.type, opts.type as DocumentType));
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

  if (cursor) {
    const ts = new Date(cursor.updatedAt);
    whereClauses.push(
      or(
        lt(documents.updatedAt, ts),
        and(eq(documents.updatedAt, ts), lt(documents.id, cursor.id)) as never,
      ) as never,
    );
  }

  const rows = await db
    .select()
    .from(documents)
    .where(and(...whereClauses))
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.updatedAt.getTime(), last.id) : null;
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
        await emitEvent(tx, {
          workspaceId: ws.id,
          projectId: p.id,
          documentId: id,
          kind: 'agent.task.assigned',
          actor: user.id,
          payload: { slug, agent: assignee.slice('agent:'.length) },
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

  if (patch.status !== undefined && existing.type === 'work_item') {
    const tId = existing.tableId ?? args.fallbackTable?.id;
    if (!tId) {
      throw new HTTPError('TABLE_NOT_FOUND', 'work_item requires a table', 404);
    }
    await validateStatusForTable(tId, patch.status);
  }

  // Phase 2.6 sub-phase D — builtin trigger lock. Only frontmatter.enabled is
  // mutable. Title, body, status, parent, and any other frontmatter key are
  // server-controlled. This check runs BEFORE strict schema validation so the
  // lock error fires first.
  if (
    existing.type === 'trigger' &&
    (existing.frontmatter as Record<string, unknown>).builtin === true
  ) {
    const fmPatch = patch.frontmatter ?? {};
    const fmKeysOtherThanEnabled = Object.keys(fmPatch).filter(
      (k) => k !== 'enabled',
    );
    const touchesProtectedTop =
      patch.title !== undefined ||
      patch.body !== undefined ||
      patch.status !== undefined ||
      patch.parentId !== undefined;
    if (touchesProtectedTop || fmKeysOtherThanEnabled.length > 0) {
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
        await emitEvent(tx, {
          workspaceId: ws.id,
          projectId: p.id,
          documentId: existing.id,
          kind: 'agent.task.assigned',
          actor: user.id,
          payload: {
            slug: updated.slug,
            agent: nextAssignee.slice('agent:'.length),
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
  return rows.filter((d) => {
    const projs = (d.frontmatter as { projects?: unknown }).projects;
    if (!Array.isArray(projs)) return false;
    return projs.includes('*') || projs.includes(opts.projectFilter!);
  });
}

