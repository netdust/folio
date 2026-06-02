import { slugify } from '@folio/shared';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { documents, memberships, workspaces } from '../db/schema.ts';
import { env } from '../env.ts';
import { seedBuiltinTriggers } from '../lib/builtin-triggers.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { slugUniqueInWorkspaces } from '../lib/slug-unique.ts';
import { isReservedSlug } from '../lib/system-workspace.ts';
import { listWorkspaces } from '../services/workspaces.ts';
import {
  type AuthContext,
  getUser,
  requireSessionUser,
  requireUser,
} from '../middleware/auth.ts';
import { type ScopeContext, getRole, getWorkspace } from '../middleware/scope.ts';

/** Throw if a slug is reserved (underscore-prefixed). Defense-in-depth beyond
 *  the create zod regex (threat model M2/M3). Exported for unit test. */
export function assertSlugAllowed(slug: string): void {
  if (isReservedSlug(slug)) {
    throw new HTTPError('RESERVED_SLUG', `slug "${slug}" is reserved`, 400);
  }
}

const workspacesRoute = new Hono<AuthContext & ScopeContext>();

workspacesRoute.use('*', requireUser);

// --- collection ---

workspacesRoute.get('/', async (c) => {
  const user = getUser(c);
  return jsonOk(c, await listWorkspaces(user.id));
});

workspacesRoute.post(
  '/',
  // Round 7 #21 — explicit session-only gate. The route was previously
  // session-only by virtue of being mounted on v1 (not wScope) — attachToken
  // never runs at that mount level, so `authMethod` stays undefined and the
  // upstream `requireUser` rejects bearer-only callers. That's a routing
  // topology, not a contract. A future middleware consolidation that mounts
  // attachToken at app root would silently turn this bearer-reachable.
  // Pin the contract with the explicit composite. No-op for current
  // production but the test below asserts the gate fires.
  requireSessionUser,
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
  jsonOk(c, { ...getWorkspace(c), role: getRole(c), claude_code_enabled: env.FOLIO_CLAUDE_CODE_ENABLED }),
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
