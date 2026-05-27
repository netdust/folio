/**
 * Phase 2.6 — comment CRUD service layer.
 *
 * Mutations are transactional and emit events through the existing
 * `emitEvent(tx, args)` helper. The route layer resolves auth and passes a
 * pre-resolved AuthorContext; the service does not touch HTTP.
 *
 * Soft delete: body → '', frontmatter.deleted_at → ISO. Row stays in DB.
 * `getComment` and `listComments` still return soft-deleted rows; UI mutes them.
 *
 * Approval-keyword priority on createComment (per spec §3a):
 *  1. If parseMentions returns approvalIntent, server OVERRIDES kind to
 *     approval/rejection and uses intent.targetAgent for target_agent.
 *  2. Otherwise, if client supplied kind=approval/rejection without
 *     target_agent → TARGET_AGENT_REQUIRED.
 *  3. If client supplied target_agent on a kind that is not approval/rejection
 *     → TARGET_AGENT_FORBIDDEN.
 *
 * Update is author-only; kind is immutable. Update re-parses mentions and
 * fires comment.mentioned ONLY for newly resolved agents not previously
 * mentioned. There is no comment.updated event (spec doesn't require one).
 */

import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import {
  documents,
  memberships,
  users,
} from '../db/schema.ts';
import type {
  Document,
  Project,
  Workspace,
} from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import {
  commentFrontmatterSchema,
  type CommentKind,
  type CommentVisibility,
  type ResolvedMention,
} from '../lib/comment-schema.ts';
import { parseMentions } from '../lib/mention-parser.ts';

const MAX_BODY_BYTES = 64 * 1024;

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type AuthorContext =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentSlug: string; agentId?: string };

/** Returns "user:<id>" or "agent:<slug>" — the canonical author string for frontmatter. */
function authorString(ctx: AuthorContext): string {
  return ctx.type === 'user' ? `user:${ctx.userId}` : `agent:${ctx.agentSlug}`;
}

export interface CreateCommentInput {
  workspace: Workspace;
  /** The owning project (inherited from parent). Required: comments live on project-scoped parents. */
  project: Project;
  /** The parent document (must be type=work_item or type=page, same workspace). */
  parent: Document;
  authorContext: AuthorContext;
  /** Actor id passed through to event.actor. Usually session userId or token id. */
  actor: string;
  body: string;
  kind?: CommentKind;
  targetAgent?: string;
  visibility?: CommentVisibility;
}

export interface UpdateCommentInput {
  workspace: Workspace;
  project: Project;
  existing: Document;
  authorContext: AuthorContext;
  actor: string;
  body?: string;
  visibility?: CommentVisibility;
  /** Presence of this field triggers KIND_IMMUTABLE; never apply. */
  kind?: CommentKind;
}

export interface DeleteCommentInput {
  workspace: Workspace;
  project: Project;
  existing: Document;
  authorContext: AuthorContext;
  actor: string;
}

export interface ListCommentsInput {
  parentId: string;
  kind?: CommentKind | CommentKind[];
  /** ISO timestamp; filter to createdAt > since. */
  since?: string;
  /** Defaults to ['normal'] — internal rows excluded unless explicitly requested. */
  visibility?: CommentVisibility[];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function bodyByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function validateBody(body: string): void {
  if (body.trim().length === 0) {
    throw new HTTPError('EMPTY_COMMENT_BODY', 'comment body is empty', 422);
  }
  if (bodyByteLength(body) > MAX_BODY_BYTES) {
    throw new HTTPError(
      'COMMENT_BODY_TOO_LARGE',
      `comment body exceeds ${MAX_BODY_BYTES} bytes`,
      422,
    );
  }
}

/** Author-only guard for update/delete. Returns the canonical author string. */
function assertAuthor(existing: Document, ctx: AuthorContext): void {
  const fm = existing.frontmatter as Record<string, unknown>;
  const author = typeof fm.author === 'string' ? fm.author : '';
  const expected = authorString(ctx);
  if (author !== expected) {
    throw new HTTPError(
      'COMMENT_AUTHOR_ONLY',
      'only the comment author can modify this comment',
      403,
    );
  }
}

interface AgentForParser {
  id: string;
  slug: string;
  allowedProjectIds: string[] | ['*'];
}

interface MemberForParser {
  id: string;
  email: string;
}

/** Load workspace agents (with allow-list) in the shape parseMentions expects. */
async function loadWorkspaceAgents(workspaceId: string): Promise<AgentForParser[]> {
  const rows = await db.query.documents.findMany({
    where: and(eq(documents.workspaceId, workspaceId), eq(documents.type, 'agent')),
  });
  return rows.map((r) => {
    const fm = r.frontmatter as Record<string, unknown>;
    const projs = fm.projects;
    // Default missing/malformed `projects` to ['*']. Phase 2.5 agent schema
    // requires `projects` as a string array, so this branch only triggers
    // for pre-2.5 rows or hand-edited frontmatter. Treating them as wildcard
    // matches the legacy Phase 2 behavior (agents were workspace-wide before
    // 2.5 introduced the allow-list). If a row reaches here with a malformed
    // `projects` field it is almost certainly a pre-2.5 agent, not a security
    // threat, so full access is the correct backward-compatible default.
    const allowed = Array.isArray(projs)
      ? (projs as unknown[]).filter((x) => typeof x === 'string') as string[]
      : ['*'];
    return {
      id: r.id,
      slug: r.slug,
      allowedProjectIds: (allowed[0] === '*' ? ['*'] : allowed) as string[] | ['*'],
    };
  });
}

/** Load workspace members (id + email) for parseMentions's member resolution. */
async function loadWorkspaceMembers(workspaceId: string): Promise<MemberForParser[]> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, workspaceId));
  return rows;
}

/** Resolve the kind/target_agent pair per the priority rules in the file header. */
function resolveKindAndTarget(args: {
  approvalIntent: ReturnType<typeof parseMentions>['approvalIntent'];
  clientKind: CommentKind | undefined;
  clientTargetAgent: string | undefined;
}): { kind: CommentKind; targetAgent: string | undefined } {
  const { approvalIntent, clientKind, clientTargetAgent } = args;

  // 1. Keyword wins.
  if (approvalIntent !== null) {
    return { kind: approvalIntent.kind, targetAgent: approvalIntent.targetAgent };
  }

  const kind: CommentKind = clientKind ?? 'comment';
  const isApprovalish = kind === 'approval' || kind === 'rejection';

  // 2. target_agent only valid on approval/rejection.
  if (clientTargetAgent !== undefined && !isApprovalish) {
    throw new HTTPError(
      'TARGET_AGENT_FORBIDDEN',
      'target_agent is only valid when kind is approval or rejection',
      422,
    );
  }

  // 3. approval/rejection requires target_agent (and there was no keyword to fill it).
  if (isApprovalish && !clientTargetAgent) {
    throw new HTTPError(
      'TARGET_AGENT_REQUIRED',
      'target_agent is required when kind is approval or rejection',
      422,
    );
  }

  return { kind, targetAgent: isApprovalish ? clientTargetAgent : undefined };
}

// -----------------------------------------------------------------------------
// createComment
// -----------------------------------------------------------------------------

export async function createComment(input: CreateCommentInput): Promise<Document> {
  const { workspace: ws, project: p, parent, authorContext, actor, body } = input;

  // Parent validation — type, workspace, scope. Defense-in-depth even if the
  // route layer already enforced it.
  if (parent.type !== 'work_item' && parent.type !== 'page') {
    throw new HTTPError(
      'INVALID_COMMENT_PARENT',
      'comment parent must be a work_item or page',
      422,
    );
  }
  if (parent.workspaceId !== ws.id) {
    throw new HTTPError(
      'INVALID_COMMENT_PARENT',
      'comment parent must live in the same workspace',
      422,
    );
  }

  // Body validation (trim then size — order matters; per spec).
  validateBody(body);

  // Mention parsing requires workspace agents + members + the current project id.
  const [workspaceAgents, workspaceMembers] = await Promise.all([
    loadWorkspaceAgents(ws.id),
    loadWorkspaceMembers(ws.id),
  ]);
  const parsed = parseMentions({
    body,
    workspaceAgents,
    workspaceMembers,
    currentProjectId: p.id,
  });

  // Resolve final kind + target_agent (keyword-wins; otherwise enforce client rules).
  const { kind, targetAgent } = resolveKindAndTarget({
    approvalIntent: parsed.approvalIntent,
    clientKind: input.kind,
    clientTargetAgent: input.targetAgent,
  });

  const author = authorString(authorContext);
  const visibility: CommentVisibility = input.visibility ?? 'normal';

  // Build + validate frontmatter through the Zod schema so the persisted shape
  // is guaranteed to match what reads/round-trip code expects.
  const frontmatterRaw: Record<string, unknown> = {
    author,
    kind,
    visibility,
    mentions: parsed.mentions,
  };
  if (targetAgent !== undefined) frontmatterRaw.target_agent = targetAgent;
  const frontmatter = commentFrontmatterSchema.parse(frontmatterRaw);

  const id = nanoid();
  const slug = `c-${nanoid(8)}`;
  const createdAt = new Date();
  const title = `Comment by ${author} at ${createdAt.toISOString()}`;

  const row = {
    id,
    workspaceId: ws.id,
    projectId: p.id,
    tableId: null as string | null,
    type: 'comment' as const,
    slug,
    title,
    status: null,
    body,
    frontmatter: frontmatter as unknown as Record<string, unknown>,
    parentId: parent.id,
    createdBy: authorContext.type === 'user' ? authorContext.userId : null,
    updatedBy: authorContext.type === 'user' ? authorContext.userId : null,
    createdAt,
    updatedAt: createdAt,
  };

  await txWithEvents(db, async (tx) => {
    await tx.insert(documents).values(row);

    // comment.created — always.
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      documentId: id,
      kind: 'comment.created',
      actor,
      payload: {
        document_id: id,
        parent_id: parent.id,
        author,
        kind,
        ...(targetAgent !== undefined ? { target_agent: targetAgent } : {}),
      },
    });

    // comment.mentioned — once per resolved-agent mention.
    for (const m of parsed.mentions) {
      if (m.resolved && m.resolvedType === 'agent') {
        const agentSlug = m.target.startsWith('agent:')
          ? m.target.slice('agent:'.length)
          : m.target;
        await emitEvent(tx, {
          workspaceId: ws.id,
          projectId: p.id,
          documentId: id,
          kind: 'comment.mentioned',
          actor,
          payload: {
            comment_id: id,
            parent_id: parent.id,
            agent_slug: agentSlug,
          },
        });
      }
    }
  });

  return row as unknown as Document;
}

// -----------------------------------------------------------------------------
// updateComment
// -----------------------------------------------------------------------------

export async function updateComment(input: UpdateCommentInput): Promise<Document> {
  const { workspace: ws, project: p, existing, authorContext, actor } = input;

  // Author-only check FIRST (before any other validation reveals state to non-authors).
  assertAuthor(existing, authorContext);

  // kind is immutable. Spec error code applies even if value would have been the same.
  if (input.kind !== undefined) {
    throw new HTTPError('KIND_IMMUTABLE', 'kind cannot be changed after creation', 422);
  }

  const existingFm = existing.frontmatter as Record<string, unknown>;
  const existingMentions = Array.isArray(existingFm.mentions)
    ? (existingFm.mentions as ResolvedMention[])
    : [];

  let nextBody = existing.body;
  let nextMentions = existingMentions;
  let nextVisibility = (existingFm.visibility as CommentVisibility) ?? 'normal';
  let editedAt: string | undefined;
  let newlyMentionedAgents: { slug: string }[] = [];

  if (input.body !== undefined) {
    validateBody(input.body);
    nextBody = input.body;
    editedAt = new Date().toISOString();

    // Re-parse mentions; diff for newly resolved agents.
    const [workspaceAgents, workspaceMembers] = await Promise.all([
      loadWorkspaceAgents(ws.id),
      loadWorkspaceMembers(ws.id),
    ]);
    // Re-parse mentions for the diff below. We deliberately do NOT recompute
    // kind/target_agent on update: kind is immutable (enforced at the top of
    // this function) and target_agent is bound to creation-time intent.
    // Spec §3c's nuance about "editing an approval recomputes target_agent" is
    // intentionally deferred — the body-change branch here is where that logic
    // would go once confirmed.
    const parsed = parseMentions({
      body: input.body,
      workspaceAgents,
      workspaceMembers,
      currentProjectId: p.id,
    });
    nextMentions = parsed.mentions;

    // Diff new mentions vs old to fire comment.mentioned only for net-new
    // resolved agents. Note: this diff runs inside the transaction but the
    // mention list itself was computed from a snapshot of the prior frontmatter;
    // two concurrent updates could each see the same "old" list and double-fire
    // for the same agent. Accepted: consumers (agent runner) must be idempotent.
    const oldAgentTargets = new Set(
      existingMentions
        .filter((m) => m.resolved && m.resolvedType === 'agent')
        .map((m) => m.target),
    );
    newlyMentionedAgents = parsed.mentions
      .filter((m) => m.resolved && m.resolvedType === 'agent' && !oldAgentTargets.has(m.target))
      .map((m) => ({
        slug: m.target.startsWith('agent:') ? m.target.slice('agent:'.length) : m.target,
      }));
  }

  if (input.visibility !== undefined) {
    nextVisibility = input.visibility;
  }

  // Build merged frontmatter via the Zod schema so we get the same guarantees as create.
  const targetAgent = existingFm.target_agent as string | undefined;
  const kindFromExisting = (existingFm.kind as CommentKind) ?? 'comment';
  const mergedRaw: Record<string, unknown> = {
    author: existingFm.author,
    kind: kindFromExisting,
    visibility: nextVisibility,
    mentions: nextMentions,
    ...(editedAt !== undefined ? { edited_at: editedAt } : existingFm.edited_at !== undefined ? { edited_at: existingFm.edited_at } : {}),
    ...(targetAgent !== undefined ? { target_agent: targetAgent } : {}),
    ...(existingFm.run_id !== undefined ? { run_id: existingFm.run_id } : {}),
    ...(existingFm.deleted_at !== undefined ? { deleted_at: existingFm.deleted_at } : {}),
  };
  const mergedFrontmatter = commentFrontmatterSchema.parse(mergedRaw);

  const updated = {
    ...existing,
    body: nextBody,
    frontmatter: mergedFrontmatter as unknown as Record<string, unknown>,
    updatedBy: authorContext.type === 'user' ? authorContext.userId : existing.updatedBy,
    updatedAt: new Date(),
  };

  await txWithEvents(db, async (tx) => {
    await tx.update(documents).set(updated).where(eq(documents.id, existing.id));

    // No comment.updated event per spec. Only fresh comment.mentioned for newly
    // resolved agents.
    for (const a of newlyMentionedAgents) {
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: p.id,
        documentId: existing.id,
        kind: 'comment.mentioned',
        actor,
        payload: {
          comment_id: existing.id,
          parent_id: existing.parentId,
          agent_slug: a.slug,
        },
      });
    }
  });

  return updated as Document;
}

// -----------------------------------------------------------------------------
// deleteComment — soft delete
// -----------------------------------------------------------------------------

export async function deleteComment(input: DeleteCommentInput): Promise<Document> {
  const { workspace: ws, project: p, existing, authorContext, actor } = input;

  assertAuthor(existing, authorContext);

  const existingFm = existing.frontmatter as Record<string, unknown>;

  // Idempotency guard: if already soft-deleted, return the row as-is without
  // re-bumping deleted_at or re-firing comment.deleted. The route layer may
  // already 404 on a second call, but the service should be safe on its own.
  if (existingFm.deleted_at) {
    return existing as Document;
  }
  const author = (existingFm.author as string) ?? authorString(authorContext);

  const mergedRaw: Record<string, unknown> = {
    ...existingFm,
    deleted_at: new Date().toISOString(),
  };
  // Re-validate through the schema so unknown fields are rejected and shape stays canonical.
  const mergedFrontmatter = commentFrontmatterSchema.parse(mergedRaw);

  const updated = {
    ...existing,
    body: '',
    frontmatter: mergedFrontmatter as unknown as Record<string, unknown>,
    updatedBy: authorContext.type === 'user' ? authorContext.userId : existing.updatedBy,
    updatedAt: new Date(),
  };

  await txWithEvents(db, async (tx) => {
    await tx.update(documents).set(updated).where(eq(documents.id, existing.id));
    await emitEvent(tx, {
      workspaceId: ws.id,
      projectId: p.id,
      documentId: existing.id,
      kind: 'comment.deleted',
      actor,
      payload: {
        document_id: existing.id,
        parent_id: existing.parentId,
        author,
      },
    });
  });

  return updated as Document;
}

// -----------------------------------------------------------------------------
// getComment
// -----------------------------------------------------------------------------

/**
 * Look up a comment by slug, scoped to a workspace.
 * Comment slugs are nanoid-prefixed (`c-<nanoid(8)>`) so collisions across
 * workspaces are vanishingly unlikely, but the workspace scope keeps the lookup
 * tight to the caller's workspace anyway.
 */
export async function getComment(
  workspaceId: string,
  slug: string,
): Promise<Document | null> {
  const row = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.type, 'comment'),
      eq(documents.slug, slug),
    ),
  });
  return row ?? null;
}

// -----------------------------------------------------------------------------
// listComments
// -----------------------------------------------------------------------------

const DEFAULT_VISIBILITY: readonly CommentVisibility[] = ['normal'];

export async function listComments(input: ListCommentsInput): Promise<Document[]> {
  const { parentId, kind, since } = input;
  const visibility = input.visibility ?? DEFAULT_VISIBILITY;

  const whereClauses = [
    eq(documents.parentId, parentId),
    eq(documents.type, 'comment'),
  ];

  if (kind !== undefined) {
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (kinds.length === 1) {
      whereClauses.push(
        sql`json_extract(${documents.frontmatter}, '$.kind') = ${kinds[0]}`,
      );
    } else if (kinds.length > 1) {
      // SQLite IN over a json_extract — drizzle's `inArray` doesn't bind a SQL
      // expression on the left side, so build it via raw sql.
      const placeholders = sql.join(
        kinds.map((k) => sql`${k}`),
        sql`, `,
      );
      whereClauses.push(
        sql`json_extract(${documents.frontmatter}, '$.kind') IN (${placeholders})`,
      );
    }
  }

  if (since !== undefined) {
    const ts = new Date(since);
    if (!Number.isNaN(ts.getTime())) {
      whereClauses.push(gt(documents.createdAt, ts));
    }
  }

  // Visibility filter: default = ['normal']. When the caller explicitly opts in
  // to ['normal','internal'] (or any superset), skip the WHERE clause.
  const includesNormal = visibility.includes('normal');
  const includesInternal = visibility.includes('internal');
  if (includesNormal && includesInternal) {
    // no filter
  } else if (includesNormal) {
    // Treat missing frontmatter.visibility as 'normal' (schema default), so we
    // need rows where the value is 'normal' OR the field is unset.
    whereClauses.push(
      sql`(json_extract(${documents.frontmatter}, '$.visibility') = 'normal'
           OR json_extract(${documents.frontmatter}, '$.visibility') IS NULL)`,
    );
  } else if (includesInternal) {
    whereClauses.push(
      sql`json_extract(${documents.frontmatter}, '$.visibility') = 'internal'`,
    );
  } else {
    // Caller explicitly passed []; return nothing.
    return [];
  }

  const rows = await db
    .select()
    .from(documents)
    .where(and(...whereClauses))
    .orderBy(desc(documents.createdAt), desc(documents.id));

  return rows;
}
