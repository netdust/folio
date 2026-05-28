import { slugify } from '@folio/shared';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { memberships, workspaces } from '../db/schema.ts';
import { seedBuiltinTriggers } from '../lib/builtin-triggers.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { slugUniqueInWorkspaces } from '../lib/slug-unique.ts';
import { listWorkspaces } from '../services/workspaces.ts';
import { type AuthContext, getUser, requireSession, requireUser } from '../middleware/auth.ts';
import { type ScopeContext, getRole, getWorkspace } from '../middleware/scope.ts';

const workspacesRoute = new Hono<AuthContext & ScopeContext>();

workspacesRoute.use('*', requireUser);

// --- collection ---

workspacesRoute.get('/', async (c) => {
  const user = getUser(c);
  return jsonOk(c, await listWorkspaces(user.id));
});

workspacesRoute.post(
  '/',
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

workspaceItemRoute.get('/', (c) => jsonOk(c, { ...getWorkspace(c), role: getRole(c) }));

workspaceItemRoute.patch(
  '/',
  // B round 5 #3 — session-only. Pre-fix a stolen workspace Bearer whose
  // createdBy resolves to the workspace owner could rename the workspace
  // (destructive identity mutation). Threat model mitigation 11.
  requireSession,
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
workspaceItemRoute.delete('/', requireSession, async (c) => {
  if (getRole(c) !== 'owner') throw new HTTPError('FORBIDDEN', 'owner only', 403);
  const ws = getWorkspace(c);
  await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  return c.body(null, 204);
});

workspaceItemRoute.get('/members', async (c) => {
  const ws = getWorkspace(c);
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
