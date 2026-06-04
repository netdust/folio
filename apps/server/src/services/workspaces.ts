import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { memberships, projectAccess, projects, workspaceAccess, workspaces } from '../db/schema.ts';
import type { Workspace } from '../db/schema.ts';
import { userRole } from '../lib/access.ts';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';

/**
 * MCP-relevant service for listing workspaces a user can SEE.
 *
 * Post-tenancy (drop workspace-as-tenancy-boundary): the list is no longer
 * driven by per-workspace membership. It is the set of workspaces visible under
 * the access model (mirrors `canSeeWorkspace`, batched to avoid N+1):
 *   - `owner` → ALL workspaces
 *   - else    → workspaces with a direct `workspace_access` grant, UNION the
 *               workspaces of any project the user has a `project_access` grant
 *               to (the TRAVERSE clause — a project-only invitee still sees the
 *               parent workspace so they can navigate to that project).
 *
 * The HTTP route returns rows of `{ workspace, role }`; the MCP surface only
 * needs the workspace itself plus the role for permission display. Service
 * returns the same `{ workspace, role }` shape for parity. `role` is now the
 * user's INSTANCE role (`users.role`) — identical on every row, since role is an
 * instance-level axis, no longer per-workspace.
 *
 * Phase D (D1): the `__system` library workspace is EXCLUDED from this ambient
 * list — it is curated through its own member-gated settings entry, not the
 * workspace pin switcher. The exclusion lives ONLY here. Direct slug navigation
 * (`GET /w/__system`) resolves via the access-gated detail route, NOT via this
 * list, so a member can still reach the library; the filter only keeps it out of
 * the switcher.
 */
export async function listWorkspaces(
  userId: string,
): Promise<{ workspace: Workspace; role: string }[]> {
  const role = await userRole(db, userId);

  let rows: Workspace[];
  if (role === 'owner') {
    rows = await db.query.workspaces.findMany({
      where: ne(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
    });
  } else {
    // visible = direct ws grants UNION ws of any project grant (traverse).
    const direct = await db
      .select({ id: workspaceAccess.workspaceId })
      .from(workspaceAccess)
      .where(eq(workspaceAccess.userId, userId));
    const viaProject = await db
      .select({ id: projects.workspaceId })
      .from(projectAccess)
      .innerJoin(projects, eq(projects.id, projectAccess.projectId))
      .where(eq(projectAccess.userId, userId));
    const ids = [...new Set([...direct.map((r) => r.id), ...viaProject.map((r) => r.id)])];
    rows = ids.length
      ? await db.query.workspaces.findMany({
          where: and(inArray(workspaces.id, ids), ne(workspaces.slug, SYSTEM_WORKSPACE_SLUG)),
        })
      : [];
  }

  return rows.map((workspace) => ({ workspace, role }));
}

/**
 * Phase D (D1): whether `userId` is a member of the `__system` library
 * workspace. Drives the "System Library" settings entry, which is gated to
 * members only (the library is excluded from the ambient switcher). A single
 * join on the UNIQUE `workspaces.slug` column keeps this a one-shot lookup.
 */
export async function isSystemMember(userId: string): Promise<boolean> {
  const row = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
      ),
    )
    .limit(1);
  return row.length > 0;
}
