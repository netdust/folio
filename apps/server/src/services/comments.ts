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
import type { DB } from '../db/client.ts';

// Drizzle tx and DB share the same query API.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
import {
  documents,
  users,
  workspaceAccess,
  workspaces,
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
import { authorString as sharedAuthorString } from '@folio/shared';
import { resolveAgentProjects } from '../lib/agent-projects.ts';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';

const MAX_BODY_BYTES = 64 * 1024;

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type AuthorContext =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentSlug: string; agentId?: string };

/**
 * Returns the canonical author string for frontmatter.
 *
 * - Session/PAT user → "user:<id>"
 * - Agent → "agent:<id>"
 *
 * F11: switched from agent slug to agent id so a slug rename doesn't break
 * the author-only guard. The slug-based fallback used to exist for the
 * brief window before migration 0008 backfilled all pre-F11 rows; now that
 * backfill runs at boot, every row in the DB is guaranteed to be id-canonical.
 * If `agentId` is absent for an 'agent' context, something is wrong upstream
 * (token resolution should always carry the id) — fail loud rather than
 * silently writing a slug.
 */
function authorString(ctx: AuthorContext): string {
  if (ctx.type === 'user') return sharedAuthorString({ type: 'user', userId: ctx.userId });
  if (!ctx.agentId) {
    throw new HTTPError(
      'INTERNAL',
      'agent author context is missing agentId — token resolution bug',
      500,
    );
  }
  return sharedAuthorString({ type: 'agent', agentId: ctx.agentId });
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
  /**
   * Links a kind=plan comment to its agent run. Set by API callers posting a
   * plan comment (the runner only consumes plan comments, never stamps them).
   * Run ids are nanoid, not UUID.
   */
  run_id?: string;
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

/**
 * Author-only guard for update/delete.
 *
 * After migration 0008, every comment row's author is id-canonical
 * (`user:<id>` or `agent:<id>`). The slug back-compat path that previously
 * allowed `agent:<slug>` matches has been removed — it was a hijack vector
 * (delete agent A, create new agent B with same slug, B inherits A's
 * comments). A pre-0008 row that the backfill couldn't resolve (the original
 * agent was already gone at backfill time) intentionally stays unmatchable —
 * no live token should own it.
 */
function assertAuthor(existing: Document, ctx: AuthorContext): void {
  const fm = existing.frontmatter as Record<string, unknown>;
  const author = typeof fm.author === 'string' ? fm.author : '';
  if (author !== authorString(ctx)) {
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
  allowedProjectIds: string[];
}

interface MemberForParser {
  id: string;
  email: string;
}

/**
 * Load workspace agents (with allow-list) in the shape parseMentions expects.
 *
 * Accepts an optional tx handle so callers can re-resolve mentions INSIDE
 * the same transaction that persists the comment row — closing the TOCTOU
 * window where an agent could be deleted between snapshot and insert (H9).
 */
async function loadWorkspaceAgents(
  workspaceId: string,
  tx: DBOrTx = db,
): Promise<AgentForParser[]> {
  // S4: narrow projection — pull only the columns the parser needs (id, slug,
  // frontmatter for resolveAgentProjects). The previous findMany loaded the
  // full row including the agent body (potentially many KB of markdown
  // instructions per agent). Mention parsing runs on every comment write;
  // dragging multi-KB bodies through the parser path was wasted I/O + JSON
  // (de)serialization at scale.
  const rows = await tx
    .select({ id: documents.id, slug: documents.slug, frontmatter: documents.frontmatter })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), eq(documents.type, 'agent')));

  // Phase B B8 — UNION the `__system` library's agents so an @-mention of a
  // library agent (`@agent:<library-slug>`) RESOLVES in any workspace's
  // comments. Library agents are mentionable instance-wide. The union is SOFT
  // (no `__system` → local agents only, no throw) and SKIPPED when the comment's
  // workspace IS `__system` (no self-union). A workspace-local agent SHADOWS a
  // library agent of the same slug (dedupe by slug, local wins — mirrors the
  // run-create precedence). Resolution still flows through the same allow-list
  // gate (resolveAgentProjects + caller's allowed-project set) downstream.
  let merged = rows;
  const systemRow = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG))
    .limit(1);
  const systemId = systemRow[0]?.id;
  if (systemId && systemId !== workspaceId) {
    const systemRows = await tx
      .select({ id: documents.id, slug: documents.slug, frontmatter: documents.frontmatter })
      .from(documents)
      .where(and(eq(documents.workspaceId, systemId), eq(documents.type, 'agent')));
    const localSlugs = new Set(rows.map((r) => r.slug));
    merged = [...rows, ...systemRows.filter((r) => !localSlugs.has(r.slug))];
  }

  // S1: resolveAgentProjects centralizes the fail-closed wildcard collapse
  // and the missing/malformed → ['*'] back-compat default. Three call sites
  // (this loader, SSE replay, bearer middleware) previously each parsed
  // `agent.frontmatter.projects` by hand and drifted (G11).
  return merged.map((r) => ({
    id: r.id,
    slug: r.slug,
    allowedProjectIds: resolveAgentProjects(r),
  }));
}

/**
 * Load workspace members (id + email) for parseMentions's member resolution.
 *
 * Post-tenancy (drop workspace-as-tenancy-boundary): "members" = the holders of
 * a `workspace_access` grant on this workspace, not rows in the legacy
 * `memberships` table. @-mention name→user resolution lists exactly those users.
 */
async function loadWorkspaceMembers(workspaceId: string): Promise<MemberForParser[]> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(workspaceAccess)
    .innerJoin(users, eq(workspaceAccess.userId, users.id))
    .where(eq(workspaceAccess.workspaceId, workspaceId));
  return rows;
}

/**
 * Resolve the kind/target_agent/target_agent_id triple per the priority rules
 * in the file header.
 *
 * BUG-013 — target_agent has been slug-form forever; the agent id was
 * discarded. After a rename the persisted slug no longer resolves. Now we
 * also return `targetAgentId` (the immutable handle) so the caller can
 * persist both. Lookup strategy:
 *   - keyword path: parseMentions already resolved the agent → use its id.
 *   - client path: client may pass `agent:<slug>` or `<slug>` or `agent:<id>`.
 *     Try to match against workspaceAgents by id then by slug. If neither
 *     matches, leave targetAgentId undefined (back-compat with rows that
 *     name an agent the service can't see, e.g. an ambient/cross-workspace
 *     reference). The slug-form `target_agent` is still persisted regardless.
 */
function resolveKindAndTarget(args: {
  approvalIntent: ReturnType<typeof parseMentions>['approvalIntent'];
  clientKind: CommentKind | undefined;
  clientTargetAgent: string | undefined;
  workspaceAgents: AgentForParser[];
}): { kind: CommentKind; targetAgent: string | undefined; targetAgentId: string | undefined } {
  const { approvalIntent, clientKind, clientTargetAgent, workspaceAgents } = args;

  // 1. Keyword wins.
  if (approvalIntent !== null) {
    return {
      kind: approvalIntent.kind,
      targetAgent: approvalIntent.targetAgent,
      targetAgentId: approvalIntent.targetAgentId,
    };
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

  if (!isApprovalish) {
    return { kind, targetAgent: undefined, targetAgentId: undefined };
  }

  // Resolve clientTargetAgent → agent id when possible.
  const raw = clientTargetAgent!; // ensured by guard above
  // Strip optional `agent:` prefix per S10 (target_agent stores one of three forms).
  const bare = raw.startsWith('agent:') ? raw.slice('agent:'.length) : raw;
  const match = workspaceAgents.find((a) => a.id === bare || a.slug === bare);

  return { kind, targetAgent: raw, targetAgentId: match?.id };
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

  // Pre-fetch members outside the tx — they don't change often and aren't a
  // TOCTOU concern (member removal doesn't poison a comment in flight).
  const workspaceMembers = await loadWorkspaceMembers(ws.id);

  const author = authorString(authorContext);
  const visibility: CommentVisibility = input.visibility ?? 'normal';

  const id = nanoid();
  const slug = `c-${nanoid(8)}`;
  const createdAt = new Date();
  const title = `Comment by ${author} at ${createdAt.toISOString()}`;

  // S14: txWithEvents is generic over T; return the row directly instead
  // of the `let row | null` workaround.
  const row = await txWithEvents(db, async (tx) => {
    // H9: load workspace agents INSIDE the tx and re-resolve mentions
    // against the tx-scoped snapshot. SQLite's writer lock + the rest of
    // the comment-insert in the same tx means an agent deleted between
    // resolution and insert cannot create a phantom-resolved mention.
    const workspaceAgents = await loadWorkspaceAgents(ws.id, tx);
    const parsed = parseMentions({
      body,
      workspaceAgents,
      workspaceMembers,
      currentProjectId: p.id,
    });

    // Resolve final kind + target_agent + target_agent_id (keyword-wins;
    // otherwise enforce client rules). BUG-013: persist both fields so
    // downstream resolvers can prefer the immutable id and fall back to slug.
    const { kind, targetAgent, targetAgentId } = resolveKindAndTarget({
      approvalIntent: parsed.approvalIntent,
      clientKind: input.kind,
      clientTargetAgent: input.targetAgent,
      workspaceAgents,
    });

    // Build + validate frontmatter through the Zod schema so the persisted shape
    // is guaranteed to match what reads/round-trip code expects.
    const frontmatterRaw: Record<string, unknown> = {
      author,
      kind,
      visibility,
      mentions: parsed.mentions,
    };
    if (targetAgent !== undefined) frontmatterRaw.target_agent = targetAgent;
    if (targetAgentId !== undefined) frontmatterRaw.target_agent_id = targetAgentId;
    if (input.run_id !== undefined) frontmatterRaw.run_id = input.run_id;
    const frontmatter = commentFrontmatterSchema.parse(frontmatterRaw);

    const inserted = {
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
    await tx.insert(documents).values(inserted);

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
        // BUG-013 — emit the immutable handle too so Phase 3 subscribers
        // can resolve target by id and survive renames.
        ...(targetAgentId !== undefined ? { target_agent_id: targetAgentId } : {}),
      },
    });

    // comment.mentioned — once per resolved-agent mention.
    //
    // S2: include `agent_id` alongside `agent_slug`. Subscribers (dispatcher,
    // trigger fan-out) need an immutable handle: if the agent gets renamed
    // between event emit and consumption, slug-only payloads orphan the
    // dispatch. Keep the slug for human-readable trigger placeholders
    // (`$event.agent_slug`); the id is the canonical key.
    for (const m of parsed.mentions) {
      if (m.resolved && m.resolvedType === 'agent' && m.resolvedId) {
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
            agent_id: m.resolvedId,
            agent_slug: agentSlug,
          },
        });
      }
    }

    return inserted;
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

  // F7 — soft-deleted comments are read-only. Without this guard an author
  // could DELETE then PATCH the body back: deleted_at stays set, but body
  // becomes the new content. UI hides via deleted_at; raw export / GET / SSE
  // consumers see the resurrected body. Soft-delete contract broken.
  if (existingFm.deleted_at != null && existingFm.deleted_at !== '') {
    throw new HTTPError('COMMENT_DELETED', 'cannot edit a deleted comment', 422);
  }
  const existingMentions = Array.isArray(existingFm.mentions)
    ? (existingFm.mentions as ResolvedMention[])
    : [];

  let nextBody = existing.body;
  let nextMentions = existingMentions;
  let nextVisibility = (existingFm.visibility as CommentVisibility) ?? 'normal';
  let editedAt: string | undefined;
  let newlyMentionedAgents: { id: string; slug: string }[] = [];

  // Members are pre-fetched outside the tx — not a TOCTOU concern.
  const workspaceMembersOuter =
    input.body !== undefined ? await loadWorkspaceMembers(ws.id) : null;
  if (input.body !== undefined) {
    validateBody(input.body);
    nextBody = input.body;
    editedAt = new Date().toISOString();
  }
  if (input.visibility !== undefined) {
    nextVisibility = input.visibility;
  }

// S14: see createComment for the txWithEvents-return-value rationale.
  const updatedRow = await txWithEvents(db, async (tx) => {
    // H9: mention parsing must happen inside the tx so an agent deleted
    // between resolution and insert can't leave a phantom-resolved
    // mention in frontmatter or emit comment.mentioned for a dead agent.
    if (input.body !== undefined) {
      const workspaceAgents = await loadWorkspaceAgents(ws.id, tx);
      // Re-parse mentions for the diff below. We deliberately do NOT recompute
      // kind/target_agent on update: kind is immutable (enforced at the top of
      // this function) and target_agent is bound to creation-time intent.
      // Spec §3c's nuance about "editing an approval recomputes target_agent" is
      // intentionally deferred — the body-change branch here is where that logic
      // would go once confirmed.
      const parsed = parseMentions({
        body: input.body,
        workspaceAgents,
        workspaceMembers: workspaceMembersOuter!,
        currentProjectId: p.id,
      });
      nextMentions = parsed.mentions;

      // Diff new mentions vs old to fire comment.mentioned only for net-new
      // resolved agents.
      const oldAgentTargets = new Set(
        existingMentions
          .filter((m) => m.resolved && m.resolvedType === 'agent')
          .map((m) => m.target),
      );
      newlyMentionedAgents = parsed.mentions
        .filter((m): m is ResolvedMention & { resolvedId: string } =>
          m.resolved &&
          m.resolvedType === 'agent' &&
          !!m.resolvedId &&
          !oldAgentTargets.has(m.target),
        )
        .map((m) => ({
          id: m.resolvedId,
          slug: m.target.startsWith('agent:') ? m.target.slice('agent:'.length) : m.target,
        }));
    }

    // Build merged frontmatter via the Zod schema so we get the same guarantees as create.
    const targetAgent = existingFm.target_agent as string | undefined;
    const targetAgentId = existingFm.target_agent_id as string | undefined;
    const kindFromExisting = (existingFm.kind as CommentKind) ?? 'comment';
    const mergedRaw: Record<string, unknown> = {
      author: existingFm.author,
      kind: kindFromExisting,
      visibility: nextVisibility,
      mentions: nextMentions,
      ...(editedAt !== undefined ? { edited_at: editedAt } : existingFm.edited_at !== undefined ? { edited_at: existingFm.edited_at } : {}),
      ...(targetAgent !== undefined ? { target_agent: targetAgent } : {}),
      ...(targetAgentId !== undefined ? { target_agent_id: targetAgentId } : {}),
      ...(existingFm.run_id !== undefined ? { run_id: existingFm.run_id } : {}),
      ...(existingFm.deleted_at !== undefined ? { deleted_at: existingFm.deleted_at } : {}),
    };
    const mergedFrontmatter = commentFrontmatterSchema.parse(mergedRaw);

    const next = {
      ...existing,
      body: nextBody,
      frontmatter: mergedFrontmatter as unknown as Record<string, unknown>,
      updatedBy: authorContext.type === 'user' ? authorContext.userId : existing.updatedBy,
      updatedAt: new Date(),
    };
    await tx.update(documents).set(next).where(eq(documents.id, existing.id));

    // No comment.updated event per spec. Only fresh comment.mentioned for newly
    // resolved agents.
    // S2: same payload shape as createComment — agent_id is the canonical
    // immutable handle for downstream dispatchers; agent_slug stays for
    // human-readable trigger placeholders.
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
          agent_id: a.id,
          agent_slug: a.slug,
        },
      });
    }

    return next;
  });

  return updatedRow as unknown as Document;
}

// -----------------------------------------------------------------------------
// deleteComment — soft delete
// -----------------------------------------------------------------------------

export async function deleteComment(input: DeleteCommentInput): Promise<Document> {
  const { workspace: ws, project: p, existing, authorContext, actor } = input;

  const existingFm = existing.frontmatter as Record<string, unknown>;

  // BUG-011 — idempotency guard FIRST, before assertAuthor. The prior order
  // (assertAuthor → idempotency) leaked authorship: a non-author deleting
  // an already-soft-deleted comment got 403 (revealing "not the author")
  // while the original author got 200 (revealing "is the author"). A hostile
  // narrowed agent could enumerate the workspace and fingerprint historical
  // authorship one DELETE at a time. Returning the row as-is for any caller
  // on an already-soft-deleted row closes that channel; assertAuthor only
  // fires on the live-delete path.
  //
  // F7-companion: tighten from truthy to "is a non-empty string" so malformed
  // imports (deleted_at='') don't trigger a phantom re-delete + duplicate
  // comment.deleted event.
  if (typeof existingFm.deleted_at === 'string' && existingFm.deleted_at.length > 0) {
    return existing as Document;
  }

  assertAuthor(existing, authorContext);

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

/**
 * S13: project-scoped variant. Replaces the F4 inline pattern
 *
 *   const row = await getComment(ws.id, slug);
 *   if (!row || row.projectId !== project.id) throw 404;
 *
 * which had drifted across three route handlers and one MCP handler.
 * Returns null on miss OR cross-project mismatch — callers throw 404 once.
 * The cross-project case MUST become a 404 (not a 403): leaking existence
 * lets a hostile narrowed agent enumerate other projects' comment slugs.
 */
export async function getCommentScoped(
  workspaceId: string,
  projectId: string,
  slug: string,
): Promise<Document | null> {
  const row = await getComment(workspaceId, slug);
  if (!row || row.projectId !== projectId) return null;
  return row;
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
    if (Number.isNaN(ts.getTime())) {
      // F14: invalid `since` used to silently fall through (no filter
      // applied), so polling consumers got the FULL list and treated it as
      // "new since X" — re-processing every historical row. Surface clearly
      // so the caller can fix the input.
      throw new HTTPError(
        'INVALID_QUERY',
        `invalid since timestamp: ${since}`,
        422,
      );
    }
    whereClauses.push(gt(documents.createdAt, ts));
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
