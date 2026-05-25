import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { memberships, workspaces } from '../db/schema.ts';
import type { Workspace } from '../db/schema.ts';

/**
 * MCP-relevant service for listing workspaces a user is a member of.
 *
 * The HTTP route returns rows of `{ workspace, role }`; the MCP surface
 * only needs the workspace itself plus the role for permission display.
 * Service returns the same `{ workspace, role }` shape for parity.
 */
export async function listWorkspaces(
  userId: string,
): Promise<{ workspace: Workspace; role: string }[]> {
  return db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId));
}
