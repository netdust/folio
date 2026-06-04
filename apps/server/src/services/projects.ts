import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { projects } from '../db/schema.ts';
import type { Project } from '../db/schema.ts';
import { type Role, hasWorkspaceAccess, userRole, visibleProjectIds } from '../lib/access.ts';

/**
 * MCP-relevant service for listing projects in a workspace, filtered to what the
 * CALLER can SEE under the access model (drop workspace-as-tenancy-boundary).
 *
 * - `owner` or a `workspace_access` grant holder → ALL projects in the ws.
 * - a project-only (traverse) caller → ONLY the projects they hold a direct
 *   `project_access` grant to. The traverse clause lets them PAST the workspace
 *   gate (so they can navigate to their project), but it is strictly weaker than
 *   a workspace grant: they must NOT receive the sibling projects. Narrowing to
 *   `visibleProjectIds` (their direct grants in this ws) is what closes that leak.
 *
 * CR-5: `effectiveRole` lets the caller override the per-user derivation with
 * the CONTEXT role. An instance-reach token (reach=null) is owner-EQUIVALENT by
 * capability — resolveWorkspace sets `c.get('role')==='owner'` — yet `userId` is
 * the token CREATOR (possibly an instance-member with no grant), so re-deriving
 * from the creator would wrongly narrow to []. The route passes `getRole(c)`; an
 * 'owner' effective role returns ALL projects (correct for both an instance
 * token and an actual owner). For non-owner sessions getRole is the real role
 * and the existing per-user filter applies.
 */
export async function listProjects(
  workspaceId: string,
  userId: string,
  effectiveRole?: Role,
): Promise<Project[]> {
  const all = await db.query.projects.findMany({
    where: eq(projects.workspaceId, workspaceId),
  });
  // owner (or owner-equivalent context) / ws-grant holder sees everything.
  // (Kept inline rather than canManageWorkspace: the CR-5 `effectiveRole`
  // override carries instance-token owner-equivalence that re-deriving the role
  // would lose.)
  const role = effectiveRole ?? (await userRole(db, userId));
  if (role === 'owner' || (await hasWorkspaceAccess(db, userId, workspaceId))) return all;
  // Otherwise narrow to the projects the caller holds a direct grant to in this
  // ws (CR-10 batched helper — was a per-item canSeeProject loop).
  const visible = await visibleProjectIds(db, userId, workspaceId);
  return all.filter((p) => visible.has(p.id));
}
