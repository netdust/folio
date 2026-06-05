import { zValidator } from '@hono/zod-validator';
import { count, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { apiTokens, documents, magicLinks, projects, users, workspaces } from '../db/schema.ts';
import { hashToken, newMagicToken } from '../lib/auth.ts';
import { sendInvite } from '../lib/email.ts';
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
 * The role write is a plain `users.role` UPDATE. The prior `user.role.changed`
 * event was scoped to `__system` (events require a non-null workspace_id) and
 * had NO consumer beyond SSE; it was DROPPED with the `__system` teardown
 * (Phase 4, D-B — this also closed the __system-grantee role-change leak,
 * CR-11). Clients learn a role change on their next /auth/me refetch. Guarded:
 * self-demotion (CANNOT_SELF_DEMOTE) + last-owner (LAST_OWNER) refused.
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
  // no-op owner→owner is fine. Count owners via users.role (rare write path).
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
 * DELETE /instance/users/:id — OWNER-ONLY hard delete (offboarding).
 *
 * Closes the symmetric gap to invites: an owner could ADD a member but never
 * REMOVE one — a demoted ex-teammate kept a login and could be re-granted access.
 * This removes the account and everything that authenticates as / was minted by
 * them, fully locking them out.
 *
 * SECURITY (threat model):
 *  - T1 owner-gate: session-only mount + requireInstanceOwner (removing a user is
 *    at least as sensitive as re-roling one — admin/member/bearer cannot).
 *  - T2 no self-delete: CANNOT_SELF_DELETE (409) — a one-click instance lockout.
 *  - T3 no last-owner delete: LAST_OWNER (409) — never leave the instance ownerless.
 *  - T4 no residual access: auth_sessions + workspace_access + project_access
 *    CASCADE on the users delete; api_tokens the user MINTED are deleted in-txn
 *    (NOT nulled — a live token with no owner would be an orphaned credential).
 *  - T5 atomic: one db.transaction — all-or-nothing.
 *  - T6 FK RESTRICT: documents.created_by/updated_by have NO onDelete (RESTRICT),
 *    so the raw user delete would THROW once they've authored anything. Null those
 *    refs in-txn first — authored content survives, only its author ref is cleared.
 */
instanceUsersRoute.delete('/users/:id', async (c) => {
  const actorId = getUser(c).id;
  await requireInstanceOwner(db, actorId);

  const targetId = c.req.param('id');
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) {
    throw new HTTPError('USER_NOT_FOUND', `no user with id ${targetId}`, 404);
  }

  // T2: you cannot delete yourself (instant lockout footgun).
  if (targetId === actorId) {
    throw new HTTPError('CANNOT_SELF_DELETE', 'you cannot delete your own account', 409);
  }

  // T3: never delete the only owner.
  if (target.role === 'owner') {
    const [{ n: ownerCount } = { n: 0 }] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'owner'));
    if (ownerCount <= 1) {
      throw new HTTPError('LAST_OWNER', 'cannot delete the only instance owner', 409);
    }
  }

  // One transaction: clear RESTRICT refs (T6), revoke minted tokens (T4), then
  // delete the user (cascades sessions + grants).
  db.transaction((tx) => {
    // T6: documents.created_by / updated_by are RESTRICT — null them so the user
    // delete doesn't throw; authored documents are preserved (author ref cleared).
    tx.update(documents).set({ createdBy: null }).where(eq(documents.createdBy, targetId)).run();
    tx.update(documents).set({ updatedBy: null }).where(eq(documents.updatedBy, targetId)).run();
    // T4: tokens MINTED by this user are revoked (deleting the user would otherwise
    // hit the api_tokens.created_by RESTRICT, and a nulled-owner live token is an
    // orphaned credential). Agent-bound tokens already cascade via their agentId.
    tx.delete(apiTokens).where(eq(apiTokens.createdBy, targetId)).run();
    // The user delete cascades auth_sessions + workspace_access + project_access.
    tx.delete(users).where(eq(users.id, targetId)).run();
  });

  return jsonOk(c, { ok: true, id: targetId });
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

/**
 * POST /instance/invites — admin-initiated invite by email (owner+admin).
 *
 * The gap this closes: an owner could previously only GRANT access to a user who
 * had ALREADY self-registered — there was no way to bring in a teammate who isn't
 * here yet. This issues a magic link to the email (same machinery as sign-in;
 * `magic-link/consume` upserts the user as a plain MEMBER on click), invite-worded.
 *
 * SECURITY (threat model):
 *  - T1 admin-gate: session-only mount + requireInstanceAdmin. No bearer can
 *    invite (no user at this mount), no member can invite.
 *  - T2 no role escalation: the invite carries NO role; consume creates 'member'
 *    only. Promotion stays the owner-only PATCH above. v1 attaches NO grant — the
 *    admin grants access from the Invitations list once the user appears (the
 *    user doesn't exist until consume, so there's nothing to grant to yet).
 *  - T3 link integrity: reuses the existing single-use, 15-min, server-hashed
 *    magic-link/consume — no new consume path, no open-redirect surface.
 *  - Already-a-user: if the email already has a user, this is just a (re)send of a
 *    sign-in link — harmless, and we don't leak whether they existed (always 200).
 *  - T5 (deferred): no per-admin invite rate-limit in v1 — bounded by the admin
 *    gate; revisit if abused.
 */
instanceUsersRoute.post(
  '/invites',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const inviter = getUser(c);
    await requireInstanceAdmin(db, inviter.id);
    const { email } = c.req.valid('json');

    const token = newMagicToken();
    await db.insert(magicLinks).values({
      id: nanoid(),
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 15), // 15 min, matches sign-in
    });
    await sendInvite(email, token, inviter.name ?? 'A teammate');

    // Always 200 — never disclose whether the email already had an account.
    return jsonOk(c, { ok: true });
  },
);

export { instanceUsersRoute };
