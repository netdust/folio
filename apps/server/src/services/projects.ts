import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { projects } from '../db/schema.ts';
import type { Project } from '../db/schema.ts';
import { canSeeProject, hasWorkspaceAccess, userRole } from '../lib/access.ts';

/**
 * MCP-relevant service for listing projects in a workspace, filtered to what the
 * CALLER can SEE under the access model (drop workspace-as-tenancy-boundary).
 *
 * - `owner` or a `workspace_access` grant holder → ALL projects in the ws.
 * - a project-only (traverse) caller → ONLY the projects they hold a direct
 *   `project_access` grant to. The traverse clause lets them PAST the workspace
 *   gate (so they can navigate to their project), but it is strictly weaker than
 *   a workspace grant: they must NOT receive the sibling projects. Filtering
 *   per-item through `canSeeProject` here is what closes that leak.
 */
export async function listProjects(workspaceId: string, userId: string): Promise<Project[]> {
  const all = await db.query.projects.findMany({
    where: eq(projects.workspaceId, workspaceId),
  });
  // owner / ws-grant holder sees everything in the workspace.
  const role = await userRole(db, userId);
  if (role === 'owner' || (await hasWorkspaceAccess(db, userId, workspaceId))) return all;
  // Otherwise filter to projects the caller can see (direct project grant). The
  // per-project loop is acceptable: project counts per workspace are small.
  const visible: Project[] = [];
  for (const p of all) {
    if (await canSeeProject(db, userId, p.id)) visible.push(p);
  }
  return visible;
}
