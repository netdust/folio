/**
 * Phase 2.6 — comment REST endpoints.
 *
 * Mounted under `pScope` (i.e. `/api/v1/w/:wslug/p/:pslug/*`) so that
 * `resolveProject` + `requireResource()` run upstream. This file is a thin
 * wrapper around `services/comments.ts`: parse → resolve auth context → call
 * the service → shape the response.
 *
 * Five endpoints:
 *   POST   /documents/:parentSlug/comments
 *   GET    /documents/:parentSlug/comments       (?kind=&since=&visibility=)
 *   GET    /comments/:slug
 *   PATCH  /comments/:slug
 *   DELETE /comments/:slug
 *
 * Author context resolution: a bearer with `agent_id` posts as `agent:<slug>`;
 * everything else posts as `user:<id>`. The `actor` event field is the user id
 * for session calls and the token id for bearer calls.
 */

import { and, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import {
  type CommentKind,
  type CommentVisibility,
  commentKindSchema,
  commentVisibilitySchema,
} from '../lib/comment-schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import type { AuthContext } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { type ScopeContext, getProject, getWorkspace } from '../middleware/scope.ts';
import {
  type AuthorContext,
  createComment,
  deleteComment,
  getComment,
  listComments,
  updateComment,
} from '../services/comments.ts';

const commentsRoute = new Hono<AuthContext & ScopeContext>();

// -----------------------------------------------------------------------------
// Zod input shapes — route validates SHAPE; service does deep validation.
// -----------------------------------------------------------------------------

const PostBody = z
  .object({
    body: z.string(),
    kind: commentKindSchema.optional(),
    target_agent: z.string().optional(),
    visibility: commentVisibilitySchema.optional(),
  })
  .strict();

// `kind` is intentionally accepted here so the route exercises the service's
// KIND_IMMUTABLE rejection rather than silently stripping the field.
const PatchBody = z
  .object({
    body: z.string().optional(),
    visibility: commentVisibilitySchema.optional(),
    kind: commentKindSchema.optional(),
  })
  .strict();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Resolve the author context for the current request.
 *
 * - Bearer with `agent_id` → `{ type: 'agent', agentSlug }`. We re-query the
 *   agent doc to get its slug because `requireResource()` loads but does not
 *   attach the row to the context.
 * - Session OR human PAT → `{ type: 'user', userId }`.
 */
async function resolveAuthorContext(
  c: Context<AuthContext & ScopeContext>,
): Promise<AuthorContext> {
  const token = c.get('token');
  const user = c.get('user');

  if (token?.agentId) {
    const agent = await db.query.documents.findFirst({
      where: eq(documents.id, token.agentId),
    });
    if (!agent || agent.type !== 'agent') {
      // requireResource would have caught this for project-scoped requests;
      // belt-and-braces here.
      throw new HTTPError('UNAUTHENTICATED', 'agent for this token no longer exists', 401);
    }
    return { type: 'agent', agentSlug: agent.slug, agentId: token.agentId };
  }

  if (user) return { type: 'user', userId: user.id };
  // attachToken substitutes the token's creator as `user` for bearer requests,
  // so this branch only fires if neither a session nor a token resolved a user.
  // Should be unreachable behind requireUserOrToken at wScope.
  throw new HTTPError('UNAUTHENTICATED', 'no actor resolved', 401);
}

/** `actor` for emitted events: user.id on session, token.id on bearer. */
function resolveActor(c: Context<AuthContext & ScopeContext>): string {
  const token = c.get('token');
  if (token) return token.id;
  const user = c.get('user');
  if (user) return user.id;
  throw new HTTPError('UNAUTHENTICATED', 'no actor resolved', 401);
}

/** Comma-split a query param into a typed list, mirroring routes/events.ts. */
function csv(param: string | undefined): string[] | undefined {
  if (!param) return undefined;
  const parts = param
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

// -----------------------------------------------------------------------------
// POST /documents/:parentSlug/comments
// -----------------------------------------------------------------------------

commentsRoute.post(
  '/documents/:parentSlug/comments',
  requireScope('documents:write'),
  async (c) => {
    const ws = getWorkspace(c);
    const project = getProject(c);
    const parentSlug = c.req.param('parentSlug');

    const parent = await db.query.documents.findFirst({
      where: and(eq(documents.projectId, project.id), eq(documents.slug, parentSlug)),
    });
    if (!parent) {
      throw new HTTPError('NOT_FOUND', `parent "${parentSlug}" not found`, 404);
    }

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HTTPError('INVALID_BODY', 'JSON body required', 422);
    }
    const parsed = PostBody.safeParse(json);
    if (!parsed.success) {
      throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
    }

    const authorContext = await resolveAuthorContext(c);
    const actor = resolveActor(c);

    const doc = await createComment({
      workspace: ws,
      project,
      parent,
      authorContext,
      actor,
      body: parsed.data.body,
      kind: parsed.data.kind,
      targetAgent: parsed.data.target_agent,
      visibility: parsed.data.visibility,
    });
    return jsonOk(c, doc, 201);
  },
);

// -----------------------------------------------------------------------------
// GET /documents/:parentSlug/comments
// -----------------------------------------------------------------------------

commentsRoute.get('/documents/:parentSlug/comments', requireScope('documents:read'), async (c) => {
  const project = getProject(c);
  const parentSlug = c.req.param('parentSlug');

  const parent = await db.query.documents.findFirst({
    where: and(eq(documents.projectId, project.id), eq(documents.slug, parentSlug)),
  });
  if (!parent) {
    throw new HTTPError('NOT_FOUND', `parent "${parentSlug}" not found`, 404);
  }

  const kind = csv(c.req.query('kind')) as CommentKind[] | undefined;
  const since = c.req.query('since');
  const visibility = csv(c.req.query('visibility')) as CommentVisibility[] | undefined;

  const rows = await listComments({
    parentId: parent.id,
    kind,
    since,
    visibility,
  });
  return jsonOk(c, rows);
});

// -----------------------------------------------------------------------------
// GET /comments/:slug
// -----------------------------------------------------------------------------

commentsRoute.get('/comments/:slug', requireScope('documents:read'), async (c) => {
  const ws = getWorkspace(c);
  const project = getProject(c);
  const slug = c.req.param('slug');
  const row = await getComment(ws.id, slug);
  // F4: defense-in-depth — getComment is workspace-scoped only. Verify the
  // resolved row belongs to THIS project (matches mcp.ts:887). Treat
  // cross-project as 404 rather than 403 so we don't leak existence.
  if (!row || row.projectId !== project.id) {
    throw new HTTPError('NOT_FOUND', `comment "${slug}" not found`, 404);
  }
  return jsonOk(c, row);
});

// -----------------------------------------------------------------------------
// PATCH /comments/:slug
// -----------------------------------------------------------------------------

commentsRoute.patch('/comments/:slug', requireScope('documents:write'), async (c) => {
  const ws = getWorkspace(c);
  const project = getProject(c);
  const slug = c.req.param('slug');

  const existing = await getComment(ws.id, slug);
  // F4: defense-in-depth — comment must belong to the :pslug from the URL.
  if (!existing || existing.projectId !== project.id) {
    throw new HTTPError('NOT_FOUND', `comment "${slug}" not found`, 404);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HTTPError('INVALID_BODY', 'JSON body required', 422);
  }
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    throw new HTTPError('INVALID_BODY', parsed.error.message, 422);
  }

  const authorContext = await resolveAuthorContext(c);
  const actor = resolveActor(c);

  const updated = await updateComment({
    workspace: ws,
    project,
    existing,
    authorContext,
    actor,
    body: parsed.data.body,
    visibility: parsed.data.visibility,
    kind: parsed.data.kind,
  });
  return jsonOk(c, updated);
});

// -----------------------------------------------------------------------------
// DELETE /comments/:slug
// -----------------------------------------------------------------------------

commentsRoute.delete('/comments/:slug', requireScope('documents:delete'), async (c) => {
  const ws = getWorkspace(c);
  const project = getProject(c);
  const slug = c.req.param('slug');

  const existing = await getComment(ws.id, slug);
  // F4: defense-in-depth — comment must belong to the :pslug from the URL.
  if (!existing || existing.projectId !== project.id) {
    throw new HTTPError('NOT_FOUND', `comment "${slug}" not found`, 404);
  }

  const authorContext = await resolveAuthorContext(c);
  const actor = resolveActor(c);

  const updated = await deleteComment({
    workspace: ws,
    project,
    existing,
    authorContext,
    actor,
  });
  return jsonOk(c, updated);
});

export { commentsRoute };
