import { slugify } from '@folio/shared';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { documents, memberships, workspaces } from '../db/schema.ts';
import { seedBuiltinTriggers } from '../lib/builtin-triggers.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { slugUniqueInWorkspaces } from '../lib/slug-unique.ts';
import { isReservedSlug } from '../lib/system-workspace.ts';
import { isInstanceReach } from '../lib/token-reach.ts';
import { listWorkspaces } from '../services/workspaces.ts';
import {
  type AuthContext,
  getUser,
  requireSessionUser,
  requireUser,
} from '../middleware/auth.ts';
import { type ScopeContext, getRole, getWorkspace } from '../middleware/scope.ts';
import { attachToken } from '../middleware/bearer.ts';

/** Throw if a slug is reserved (underscore-prefixed). Defense-in-depth beyond
 *  the create zod regex (threat model M2/M3). Exported for unit test. */
export function assertSlugAllowed(slug: string): void {
  if (isReservedSlug(slug)) {
    throw new HTTPError('RESERVED_SLUG', `slug "${slug}" is reserved`, 400);
  }
}

const workspacesRoute = new Hono<AuthContext & ScopeContext>();

// This route mounts on v1 (not wScope), where attachToken does NOT run — so a
// bearer would otherwise be invisible here. attachToken runs FIRST so the
// bearer (and any user it hydrates from createdBy) is visible to requireUser
// and to the per-route composite gate on POST (A10). attachToken is a no-op
// when no Authorization header is present, so session-only callers are
// unaffected.
workspacesRoute.use('*', attachToken);
workspacesRoute.use('*', requireUser);

// --- collection ---

workspacesRoute.get('/', async (c) => {
  const user = getUser(c);
  return jsonOk(c, await listWorkspaces(user.id));
});

workspacesRoute.post(
  '/',
  // A10 — workspace creation accepts EITHER a session user OR an instance-reach
  // bearer (workspaceId null) holding `workspace:admin`, so the operator / an
  // instance admin's automation can provision workspaces. attachToken already
  // ran at the route level, so the bearer is visible here.
  //
  // Composite gate. Allow:
  //   - a session user (no bearer)                              → pass
  //   - an instance bearer (workspaceId null) with              → pass
  //     workspace:admin
  // Reject (M7 preserved):
  //   - a pinned/agent bearer, or an instance bearer lacking
  //     workspace:admin → 403
  //   - no auth at all → 401
  // The reserved-slug guard in the handler (assertSlugAllowed) is independent
  // of auth — even an authorized instance bearer cannot create a reserved slug.
  async (c, next) => {
    const token = c.get('token');
    const user = c.get('user');
    const instanceBearer =
      !!token && isInstanceReach(token) && token.scopes.includes('workspace:admin');
    if (!user && !instanceBearer) {
      throw new HTTPError('UNAUTHENTICATED', 'login required', 401);
    }
    // A bearer-authenticated request that is NOT an authorized instance bearer
    // (pinned, or missing workspace:admin) is rejected rather than falling
    // through on a hydrated user. A session request with a stray bearer is
    // fine — only reject when the request authenticated AS a token.
    if (token && !instanceBearer && c.get('authMethod') === 'token') {
      throw new HTTPError(
        'FORBIDDEN',
        'this bearer may not create workspaces; an instance bearer with workspace:admin or a session is required',
        403,
      );
    }
    return next();
  },
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      slug: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const { name, slug: explicit } = c.req.valid('json');
    const id = nanoid();

    const baseSlug = explicit ?? slugify(name);
    let slug = baseSlug;
    if (explicit) {
      const existing = await db.query.workspaces.findFirst({
        where: eq(workspaces.slug, explicit),
      });
      if (existing) throw new HTTPError('SLUG_CONFLICT', `slug "${explicit}" is taken`, 409);
    } else {
      slug = await slugUniqueInWorkspaces(db, baseSlug || 'workspace');
    }

    // Assert the FINAL resolved slug on both branches (M2/M3) — never depend on
    // slugify/regex behavior to keep the reserved namespace closed.
    assertSlugAllowed(slug);

    await txWithEvents(db, async (tx) => {
      await tx.insert(workspaces).values({ id, slug, name });
      await tx.insert(memberships).values({ workspaceId: id, userId: user.id, role: 'owner' });
      // Phase 2.6 sub-phase D — seed the 4 builtin triggers transactionally
      // with the workspace itself. Future refactor may move workspace create
      // into services/workspaces.ts::createWorkspace.
      await seedBuiltinTriggers(tx, id, user.id);
      await emitEvent(tx, {
        workspaceId: id,
        kind: 'workspace.created',
        actor: user.id,
        payload: { slug, name },
      });
    });

    return jsonOk(c, { id, slug, name }, 201);
  },
);

// --- item (mounted under `/api/v1/w/:wslug`; wScope already runs requireUser + resolveWorkspace) ---

const workspaceItemRoute = new Hono<AuthContext & ScopeContext>();

workspaceItemRoute.get('/', (c) =>
  // claude-code is hard-disabled at the runner preflight — never advertise it as
  // selectable; the env flag (env.FOLIO_CLAUDE_CODE_ENABLED) no longer enables
  // execution, so showing the cc provider option in the UI would be a footgun.
  jsonOk(c, { ...getWorkspace(c), role: getRole(c), claude_code_enabled: false }),
);

workspaceItemRoute.patch(
  '/',
  // B round 5 #3 — session-only. Pre-fix a stolen workspace Bearer whose
  // createdBy resolves to the workspace owner could rename the workspace
  // (destructive identity mutation). Threat model mitigation 11.
  // Round 6 #6 — composite swap (was `requireSession`).
  requireSessionUser,
  zValidator('json', z.object({ name: z.string().min(1).max(80) })),
  async (c) => {
    if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
    const ws = getWorkspace(c);
    const { name } = c.req.valid('json');
    const user = getUser(c);
    const now = new Date();
    await txWithEvents(db, async (tx) => {
      await tx.update(workspaces).set({ name, updatedAt: now }).where(eq(workspaces.id, ws.id));
      await emitEvent(tx, {
        workspaceId: ws.id,
        kind: 'workspace.updated',
        actor: user.id,
        payload: { changes: ['name'] },
      });
    });
    return jsonOk(c, { ...ws, name, updatedAt: now });
  },
);

// B round 5 #3 — session-only. Pre-fix a stolen workspace Bearer whose
// createdBy resolves to the workspace owner could DELETE the workspace.
// Threat model mitigation 11.
// Round 6 #6 — composite swap (was `requireSession`).
workspaceItemRoute.delete('/', requireSessionUser, async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const ws = getWorkspace(c);
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  return c.body(null, 204);
});

workspaceItemRoute.get('/members', async (c) => {
  const ws = getWorkspace(c);
  // Round 7 #22 — agent-bound bearers narrowed to specific projects must NOT
  // receive the full workspace membership. F3 (events.ts) already narrows
  // event visibility for the same caller class; this route had no parallel.
  // An agent allow-listed to one project was previously receiving the
  // emails of users on every project in the workspace — a PII leak that
  // ignored the F3-style narrowing contract.
  //
  // v1 implementation: project-narrowed agent-bound bearers receive an
  // EMPTY list. They have no business knowing workspace membership; their
  // work is scoped to docs in the allow-list projects. Session callers and
  // wildcard-allow-list agents continue to see the full list. v1.1 would
  // refine this to "members of at least one allowed project" once
  // project-scoped memberships exist in the schema (currently workspace-
  // level only).
  //
  // Threat model attack 21 + mitigation 22.
  const token = c.get('token') ?? null;
  if (token?.agentId) {
    const agent = await db.query.documents.findFirst({
      where: eq(documents.id, token.agentId),
    });
    const projects =
      (agent?.frontmatter as { projects?: unknown } | undefined)?.projects;
    const projectList = Array.isArray(projects)
      ? (projects.filter((p) => typeof p === 'string') as string[])
      : [];
    const isWildcard = projectList.includes('*');
    if (!isWildcard) {
      // Project-narrowed agent → no member visibility in v1.
      return jsonOk(c, { members: [] });
    }
  }

  const rows = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
    })
    .from(memberships)
    .where(eq(memberships.workspaceId, ws.id));
  const ids = rows.map((r) => r.userId);
  const userRows = ids.length
    ? await db.query.users.findMany({
        where: (u, { inArray }) => inArray(u.id, ids),
      })
    : [];
  const byId = new Map(userRows.map((u) => [u.id, u]));
  const members = rows
    .map((r) => {
      const u = byId.get(r.userId);
      if (!u) return null;
      return { id: u.id, email: u.email, name: u.name, role: r.role };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return jsonOk(c, { members });
});

export { workspacesRoute, workspaceItemRoute };
