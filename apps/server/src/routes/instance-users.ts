import { zValidator } from '@hono/zod-validator';
import { count, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { projects, users, workspaces } from '../db/schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  requireInstanceAdmin,
  requireInstanceOwner,
} from '../lib/system-workspace.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';

/**
 * Task 12 (drop-workspace-tenancy) — instance-user administration:
 *
 *   PATCH /api/v1/instance/users/:id/role   { role }   OWNER-ONLY (role change)
 *   GET   /api/v1/instance/invite-targets               owner+admin (enumeration)
 *   GET   /api/v1/instance/users                         owner+admin (roles list)
 *
 * MOUNT NOTE: this router is mounted at `/instance` (NOT `/instance/users`),
 * because `invite-targets` is a SIBLING of `users` under `/instance`, not a
 * child of it — a router mounted at `/instance/users` could never serve
 * `/instance/invite-targets`. The internal handler paths below (`/users/...`,
 * `/invite-targets`) compose with the `/instance` mount to produce exactly the
 * three URLs above. It coexists with the `/instance/tokens` and `/instance/access`
 * routers (distinct subpaths; Hono routers at the same prefix don't collide).
 *
 * Security boundary:
 *  - SESSION-only. Mounted on `v1` (NOT under wScope), where `attachToken` never
 *    runs — a Bearer is never parsed and `c.get('user')` is set only by a valid
 *    session cookie (attachUser). `requireSessionUser`'s `!user → 401` is the
 *    operative gate: a stolen bearer has no user here and cannot change roles or
 *    enumerate targets. (requireSessionUser also rejects authMethod==='token' as
 *    defense-in-depth; that branch is unreachable at this mount.)
 *
 *  - Role change is OWNER-ONLY (`requireInstanceOwner`, stricter than the
 *    owner+admin `requireInstanceAdmin`). This is the load-bearing escalation
 *    guard: an admin must NOT be able to promote a member → admin, or themselves
 *    → owner. Only the instance owner re-assigns instance roles.
 *
 *  - Last-owner guard: demoting the LAST remaining owner to a non-owner role is
 *    refused (409 LAST_OWNER), so the instance is never left without an owner who
 *    can administer it.
 *
 *  - invite-targets / users are owner+admin (`requireInstanceAdmin`). This is the
 *    "existence vs contents" split: an admin can ENUMERATE the workspaces/projects
 *    that exist (to grant access into them) and see the user roster, WITHOUT being
 *    able to read any workspace's CONTENTS — content access still requires an
 *    explicit grant via the access gates (`canSeeWorkspace`/`canSeeProject`).
 *    invite-targets returns id/slug/name (+ workspaceId on projects) ONLY: no
 *    documents, no bodies, no events. The `__system` library workspace is excluded
 *    (it is not an invite target).
 */
const instanceUsersRoute = new Hono<AuthContext>();

// Session-only (see header). A bearer-only request has no user at this mount and
// is rejected by requireSessionUser before any handler runs.
instanceUsersRoute.use('*', requireSessionUser);

const roleBody = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

/**
 * PATCH /instance/users/:id/role — OWNER-ONLY instance role change.
 *
 * The role write goes through `txWithEvents` + `emitEvent('user.role.changed')`
 * (rule #4: every write emits an event). The event is an INSTANCE-level concern
 * with no natural workspace, so it is scoped to the `__system` workspace (the
 * instance's home workspace, always bootstrapped at boot) because the events
 * model requires a non-null workspace_id.
 */
instanceUsersRoute.patch('/users/:id/role', zValidator('json', roleBody), async (c) => {
  const actor = getUser(c).id;
  // OWNER-ONLY. requireInstanceOwner throws 403 for admin/member — the escalation
  // guard that stops an admin from re-assigning roles.
  await requireInstanceOwner(db, actor);

  const targetId = c.req.param('id');
  const { role } = c.req.valid('json');

  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) {
    throw new HTTPError('USER_NOT_FOUND', `no user with id ${targetId}`, 404);
  }

  // Self-demotion guard: an owner cannot strip their OWN owner role. It is a
  // silent footgun (one click and you lose every owner-only surface, including
  // the one you'd use to undo it). Promoting yourself is impossible anyway (you
  // are already owner). A different owner must demote you.
  if (targetId === actor && target.role === 'owner' && role !== 'owner') {
    throw new HTTPError(
      'CANNOT_SELF_DEMOTE',
      'you cannot remove your own owner role; another owner must do it',
      409,
    );
  }

  // Last-owner guard: never demote the only instance owner. Fires only when the
  // target is CURRENTLY an owner AND the new role drops them out of owner; a
  // no-op owner→owner is fine. Count via the indexed users.role.
  if (target.role === 'owner' && role !== 'owner') {
    const [{ n: ownerCount } = { n: 0 }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'owner'));
    if (ownerCount <= 1) {
      throw new HTTPError('LAST_OWNER', 'cannot demote the only instance owner', 409);
    }
  }

  // Phase 4 (D-B): the role write is the side effect; the prior
  // `user.role.changed` event was scoped to `__system` (now torn down) and had
  // NO consumer beyond SSE — it is dropped (this also closes CR-11, the
  // __system-grantee role-change leak, by construction). Clients learn a role
  // change on their next /auth/me refetch.
  await db.update(users).set({ role }).where(eq(users.id, targetId));

  return jsonOk(c, { id: targetId, role });
});

/**
 * GET /instance/invite-targets — ENUMERATION (owner+admin). Returns the id/slug/
 * name of every workspace + project so the invite picker can target them. This is
 * the existence half of the existence-vs-contents split: NO documents, NO bodies,
 * NO events. `__system` is excluded (not an invite target).
 */
instanceUsersRoute.get('/invite-targets', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);

  // ALL workspaces except the reserved __system library. Select only the
  // enumeration columns — no contents.
  const wsRows = await db
    .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
    .from(workspaces)
    .where(ne(workspaces.slug, SYSTEM_WORKSPACE_SLUG));

  // ALL projects EXCEPT those in __system (its Skills/Reference projects must not
  // leak through the projects list). Join to the workspace and filter by slug so
  // the exclusion is keyed to the same reserved slug as the workspace filter.
  const projRows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      workspaceId: projects.workspaceId,
    })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(ne(workspaces.slug, SYSTEM_WORKSPACE_SLUG));

  return jsonOk(c, { workspaces: wsRows, projects: projRows });
});

/**
 * GET /instance/users — user roster + roles (owner+admin), for the Roles tab.
 * Selects id/email/name/role ONLY — never password_hash.
 */
instanceUsersRoute.get('/users', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(users);

  return jsonOk(c, { users: rows });
});

export { instanceUsersRoute };
