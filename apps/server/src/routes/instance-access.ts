import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { projectAccess, projects, users, workspaceAccess, workspaces } from '../db/schema.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { SYSTEM_WORKSPACE_SLUG, requireInstanceAdmin } from '../lib/system-workspace.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';

/**
 * Task 11 (T-B) — invitation routes: grant/revoke the explicit access rows that
 * replaced membership-implied access (drop-workspace-tenancy: one instance = one
 * team; reaching a specific workspace or project is now an explicit grant).
 *
 *   POST   /api/v1/instance/access   { userId, workspaceId? | projectId? }  grant
 *   DELETE /api/v1/instance/access   { userId, workspaceId? | projectId? }  revoke
 *
 * Security boundary (T-B threat model):
 *  - SESSION-only. This route mounts on `v1` (NOT under wScope), where
 *    `attachToken` never runs — so a Bearer is never parsed and `c.get('user')`
 *    is set only by a valid session cookie. `requireSessionUser`'s `!user → 401`
 *    is therefore the operative gate: a stolen bearer cannot grant itself or
 *    anyone access. (requireSessionUser also rejects authMethod==='token' as
 *    defense-in-depth, but that branch is unreachable at this mount.)
 *  - owner+admin may invite: each handler calls `requireInstanceAdmin` (throws
 *    403 for a member) — the single instance-admin boundary.
 *  - exactly ONE of workspaceId|projectId (Zod `.refine`) — never both/neither.
 *  - every referent (user, workspace, project) is FK-validated to EXIST before
 *    any insert → 404, so a grant can never create a dangling row.
 *  - both writes go through `txWithEvents` + `emitEvent` (invariant 5: every
 *    write emits an event), kind `access.granted` / `access.revoked`. A project
 *    grant's event is scoped to the project's workspace (emitEvent requires a
 *    workspaceId).
 *
 * Idempotent grant: the insert uses `.onConflictDoNothing()` on the composite
 * PK, so re-granting an existing access pair is a no-op (201), not an error.
 */
const instanceAccessRoute = new Hono<AuthContext>();

// Session-only (see header). A bearer-only request has no user at this mount and
// is rejected by requireSessionUser before any handler runs.
instanceAccessRoute.use('*', requireSessionUser);

// EXACTLY ONE of workspaceId | projectId. The refine rejects both-present and
// neither-present (a Zod refine failure surfaces as a 400 via zValidator).
const accessBody = z
  .object({
    userId: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .refine((b) => (b.workspaceId == null) !== (b.projectId == null), {
    message: 'exactly one of workspaceId or projectId is required',
  });

/**
 * FK-validate the grant target + scope. Returns the resolved scope so the caller
 * can use it (a project grant needs the project's workspaceId for the event).
 * Throws 404 (USER_NOT_FOUND / WORKSPACE_NOT_FOUND / PROJECT_NOT_FOUND) if any
 * referent is missing — BEFORE any write, so no dangling row can be inserted.
 */
async function resolveGrant(body: {
  userId: string;
  workspaceId?: string;
  projectId?: string;
}): Promise<
  | { kind: 'workspace'; userId: string; workspaceId: string }
  | { kind: 'project'; userId: string; projectId: string; workspaceId: string }
> {
  const user = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
  if (!user) {
    throw new HTTPError('USER_NOT_FOUND', `no user with id ${body.userId}`, 404);
  }

  if (body.workspaceId != null) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, body.workspaceId),
    });
    if (!ws) {
      throw new HTTPError('WORKSPACE_NOT_FOUND', `no workspace with id ${body.workspaceId}`, 404);
    }
    // CR-11 defense-in-depth: the reserved __system library is NOT a grant
    // target. The invite-target picker already hides it, but a direct
    // grant-by-id bypassed the picker — and a __system grant lets a plain member
    // traverse into the library. 403 (it exists, but is not grantable), distinct
    // from the 404 for a non-existent ws.
    assertNotReservedTarget(ws.slug);
    return { kind: 'workspace', userId: body.userId, workspaceId: ws.id };
  }

  // projectId branch (the refine guarantees exactly one is set).
  const proj = await db.query.projects.findFirst({
    where: eq(projects.id, body.projectId!),
  });
  if (!proj) {
    throw new HTTPError('PROJECT_NOT_FOUND', `no project with id ${body.projectId}`, 404);
  }
  // A project IN __system is likewise not a grant target (its Skills/Reference
  // projects must not be invited into). Resolve the parent ws slug to check.
  const parentWs = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, proj.workspaceId),
  });
  assertNotReservedTarget(parentWs?.slug);
  return {
    kind: 'project',
    userId: body.userId,
    projectId: proj.id,
    // The event needs a workspaceId; a project's workspace scopes its event.
    workspaceId: proj.workspaceId,
  };
}

/** Reject a grant whose (parent) workspace is the reserved __system library. */
function assertNotReservedTarget(workspaceSlug: string | undefined): void {
  if (workspaceSlug === SYSTEM_WORKSPACE_SLUG) {
    throw new HTTPError(
      'RESERVED_WORKSPACE',
      'the __system library is reserved and cannot be a grant target',
      403,
    );
  }
}

/**
 * GET /instance/access — the grant roster (owner+admin). Lists every
 * workspace_access + project_access row joined to the user + the resource for
 * display. Drives the Invitations UI's "who has access" view.
 *
 * Security: the roster is an INSTANCE-ADMIN fact (who-can-see-what). Same gate
 * as grant/revoke — session-only (v1 mount, no attachToken → a bearer never
 * reaches it) + requireInstanceAdmin (403 for a member). SELECTs only display
 * columns (user id/email/name + resource id/slug/name); no secrets.
 */
instanceAccessRoute.get('/', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);

  // The two roster queries are independent — run them concurrently.
  const [wsRows, projRows] = await Promise.all([
    db
      .select({
        userId: workspaceAccess.userId,
        userEmail: users.email,
        userName: users.name,
        workspaceId: workspaceAccess.workspaceId,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.name,
      })
      .from(workspaceAccess)
      .innerJoin(users, eq(users.id, workspaceAccess.userId))
      .innerJoin(workspaces, eq(workspaces.id, workspaceAccess.workspaceId)),
    db
      .select({
        userId: projectAccess.userId,
        userEmail: users.email,
        userName: users.name,
        projectId: projectAccess.projectId,
        projectSlug: projects.slug,
        projectName: projects.name,
        workspaceId: projects.workspaceId,
      })
      .from(projectAccess)
      .innerJoin(users, eq(users.id, projectAccess.userId))
      .innerJoin(projects, eq(projects.id, projectAccess.projectId)),
  ]);

  const grants = [
    ...wsRows.map((r) => ({ kind: 'workspace' as const, ...r })),
    ...projRows.map((r) => ({ kind: 'project' as const, ...r })),
  ];
  return jsonOk(c, { grants });
});

instanceAccessRoute.post('/', zValidator('json', accessBody), async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);
  const actor = getUser(c).id;
  const grant = await resolveGrant(c.req.valid('json'));

  await txWithEvents(db, async (tx) => {
    if (grant.kind === 'workspace') {
      // Idempotent: re-granting an existing pair is a no-op (composite PK).
      await tx
        .insert(workspaceAccess)
        .values({ userId: grant.userId, workspaceId: grant.workspaceId })
        .onConflictDoNothing();
    } else {
      await tx
        .insert(projectAccess)
        .values({ userId: grant.userId, projectId: grant.projectId })
        .onConflictDoNothing();
    }
    await emitEvent(tx, {
      workspaceId: grant.workspaceId,
      projectId: grant.kind === 'project' ? grant.projectId : null,
      kind: 'access.granted',
      actor,
      payload:
        grant.kind === 'workspace'
          ? { userId: grant.userId, workspaceId: grant.workspaceId }
          : { userId: grant.userId, projectId: grant.projectId },
    });
  });

  return jsonOk(c, { ok: true }, 201);
});

instanceAccessRoute.delete('/', zValidator('json', accessBody), async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);
  const actor = getUser(c).id;
  // Revoke FK-validates the same way: revoking against a ghost user/scope is a
  // 404, not a silent success on a non-existent referent. Revoking an existing
  // referent whose access row is absent is a legitimate no-op (delete matches 0).
  const grant = await resolveGrant(c.req.valid('json'));

  await txWithEvents(db, async (tx) => {
    if (grant.kind === 'workspace') {
      await tx
        .delete(workspaceAccess)
        .where(
          and(
            eq(workspaceAccess.userId, grant.userId),
            eq(workspaceAccess.workspaceId, grant.workspaceId),
          ),
        );
    } else {
      await tx
        .delete(projectAccess)
        .where(
          and(eq(projectAccess.userId, grant.userId), eq(projectAccess.projectId, grant.projectId)),
        );
    }
    await emitEvent(tx, {
      workspaceId: grant.workspaceId,
      projectId: grant.kind === 'project' ? grant.projectId : null,
      kind: 'access.revoked',
      actor,
      payload:
        grant.kind === 'workspace'
          ? { userId: grant.userId, workspaceId: grant.workspaceId }
          : { userId: grant.userId, projectId: grant.projectId },
    });
  });

  return jsonOk(c, { ok: true });
});

export { instanceAccessRoute };
