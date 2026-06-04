/**
 * Visibility convergence point.
 *
 * Step 3 of dropping workspace-as-tenancy-boundary (one instance = one team).
 * This is the SINGLE source of truth for "can this user SEE this workspace /
 * project?" — every route and service routes its visibility decision through
 * these functions (callers are rewired in later tasks; nothing reads this yet).
 *
 * The rules (security-critical — implement EXACTLY):
 *
 *   canSeeWorkspace(u, ws) :=
 *       userRole == 'owner'
 *    OR workspace_access(u, ws)
 *    OR EXISTS project_access(u, p) where p.workspace_id == ws   // TRAVERSE
 *
 *   canSeeProject(u, p) :=
 *       userRole == 'owner'
 *    OR project_access(u, p)
 *    OR workspace_access(u, p.workspace_id)                      // ws grant on parent
 *
 * The TRAVERSE clause lets a user invited to ONLY one project pass the
 * workspace gate so they can navigate to that project — otherwise they'd 403 at
 * the workspace boundary and never reach it. But traverse is STRICTLY WEAKER
 * than a workspace grant: it lets them through the workspace gate, yet
 * `canSeeProject` still returns false for the OTHER projects in that workspace.
 * Do not conflate the two: canSeeWorkspace (traverse-allowed) ≠ "can see all
 * projects in the workspace".
 *
 * Only `owner` bypasses grants. `admin` does NOT — admin needs explicit grants
 * to see workspace contents (deliberate product decision).
 *
 * All functions are pure: they take `db`, run one read each, and return a
 * boolean/role with no side effects.
 */

import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { projectAccess, projects, users, workspaceAccess } from '../db/schema.ts';

export type Role = 'owner' | 'admin' | 'member';

export async function userRole(db: DB, userId: string): Promise<Role> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return (u?.role as Role | undefined) ?? 'member';
}

export async function hasWorkspaceAccess(
  db: DB,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const r = await db.query.workspaceAccess.findFirst({
    where: and(eq(workspaceAccess.userId, userId), eq(workspaceAccess.workspaceId, workspaceId)),
  });
  return r !== undefined;
}

export async function hasProjectAccess(
  db: DB,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const r = await db.query.projectAccess.findFirst({
    where: and(eq(projectAccess.userId, userId), eq(projectAccess.projectId, projectId)),
  });
  return r !== undefined;
}

// owner || workspace_access || project_access to some project in this ws (TRAVERSE)
export async function canSeeWorkspace(
  db: DB,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  if ((await userRole(db, userId)) === 'owner') return true;
  if (await hasWorkspaceAccess(db, userId, workspaceId)) return true;
  const traverse = await db
    .select({ id: projectAccess.projectId })
    .from(projectAccess)
    .innerJoin(projects, eq(projects.id, projectAccess.projectId))
    .where(and(eq(projectAccess.userId, userId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  return traverse.length > 0;
}

// owner || workspace_access (NO traverse). Management of a workspace (rename /
// delete) requires a REAL workspace grant, not mere traverse-visibility: a
// project-only invitee can SEE the workspace (canSeeWorkspace traverse clause)
// to navigate to their project, but must NOT be able to manage the workspace.
// Distinct from canSeeWorkspace precisely because it OMITS the traverse clause.
export async function canManageWorkspace(
  db: DB,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  if ((await userRole(db, userId)) === 'owner') return true;
  return hasWorkspaceAccess(db, userId, workspaceId);
}

// owner || direct project_access || workspace_access on the parent ws
export async function canSeeProject(
  db: DB,
  userId: string,
  projectId: string,
): Promise<boolean> {
  if ((await userRole(db, userId)) === 'owner') return true;
  if (await hasProjectAccess(db, userId, projectId)) return true;
  const proj = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!proj) return false;
  return hasWorkspaceAccess(db, userId, proj.workspaceId);
}
