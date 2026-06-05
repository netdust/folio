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

// owner || workspace_access || project_access to some project in this ws (TRAVERSE).
// `role` may be passed pre-resolved (e.g. from the scope middleware that already
// read it) to skip the redundant userRole query on the hot path.
export async function canSeeWorkspace(
  db: DB,
  userId: string,
  workspaceId: string,
  role?: Role,
): Promise<boolean> {
  if ((role ?? (await userRole(db, userId))) === 'owner') return true;
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
  role?: Role,
): Promise<boolean> {
  if ((role ?? (await userRole(db, userId))) === 'owner') return true;
  return hasWorkspaceAccess(db, userId, workspaceId);
}

/**
 * The set of workspace ids a NON-owner user can see: direct `workspace_access`
 * grants UNION the workspaces of any `project_access` grant (the traverse). The
 * workspace-level analog of `visibleProjectIds` — the single place the "which
 * workspaces may this user see" rule lives (invariant 4a), so the switcher list
 * and the per-request `canSeeWorkspace` gate share one definition. Owners are
 * unrestricted (callers short-circuit on role before calling this). The two
 * independent reads run concurrently.
 */
export async function visibleWorkspaceIds(db: DB, userId: string): Promise<Set<string>> {
  const [direct, viaProject] = await Promise.all([
    db
      .select({ id: workspaceAccess.workspaceId })
      .from(workspaceAccess)
      .where(eq(workspaceAccess.userId, userId)),
    db
      .select({ id: projects.workspaceId })
      .from(projectAccess)
      .innerJoin(projects, eq(projects.id, projectAccess.projectId))
      .where(eq(projectAccess.userId, userId)),
  ]);
  return new Set([...direct.map((r) => r.id), ...viaProject.map((r) => r.id)]);
}

// owner || direct project_access || workspace_access on the parent ws
export async function canSeeProject(
  db: DB,
  userId: string,
  projectId: string,
  role?: Role,
): Promise<boolean> {
  if ((role ?? (await userRole(db, userId))) === 'owner') return true;
  if (await hasProjectAccess(db, userId, projectId)) return true;
  const proj = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!proj) return false;
  return hasWorkspaceAccess(db, userId, proj.workspaceId);
}

/**
 * The set of project ids IN `workspaceId` that `userId` holds a DIRECT
 * `project_access` grant to — the batched, set-based form of the per-item
 * `canSeeProject` loop a non-whole-ws caller used to run (one join query instead
 * of N+1).
 *
 * CR-10 convergence helper. The "visible project set for a user in a workspace"
 * is the run ceiling (agent-runs), the SSE filter (events), AND the project list
 * (listProjects) — three security-relevant surfaces. It was hand-rolled (and
 * re-ran `userRole` per row) in all three; this is the single place it now
 * lives.
 *
 * IMPORTANT — this deliberately does NOT short-circuit owner / `workspace_access`
 * holders (whole-ws callers). Each caller handles the whole-ws branch
 * differently (events → unrestricted/null, listProjects → all rows, agent-runs →
 * null reach), so the whole-ws decision stays with the caller via
 * `canManageWorkspace`. This helper answers only "which projects in this ws does
 * this user have a direct grant to" — call it ONLY after `canManageWorkspace`
 * returns false (else a ws-grant holder would wrongly narrow to their direct
 * grants, which may be none).
 */
export async function visibleProjectIds(
  db: DB,
  userId: string,
  workspaceId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: projectAccess.projectId })
    .from(projectAccess)
    .innerJoin(projects, eq(projects.id, projectAccess.projectId))
    .where(and(eq(projectAccess.userId, userId), eq(projects.workspaceId, workspaceId)));
  return new Set(rows.map((r) => r.id));
}
