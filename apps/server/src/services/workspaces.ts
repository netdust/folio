import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { memberships, workspaces } from '../db/schema.ts';
import type { Workspace } from '../db/schema.ts';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';

/**
 * MCP-relevant service for listing workspaces a user is a member of.
 *
 * The HTTP route returns rows of `{ workspace, role }`; the MCP surface
 * only needs the workspace itself plus the role for permission display.
 * Service returns the same `{ workspace, role }` shape for parity.
 *
 * Phase D (D1): the `__system` library workspace is EXCLUDED from this ambient
 * list — it is curated through its own member-gated settings entry, not the
 * workspace pin switcher. The exclusion lives ONLY here. Direct slug navigation
 * (`GET /w/__system`) resolves via the membership-gated detail route, NOT via
 * this list, so a member can still reach the library; the filter only keeps it
 * out of the switcher.
 */
export async function listWorkspaces(
  userId: string,
): Promise<{ workspace: Workspace; role: string }[]> {
  return db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, userId),
        ne(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
      ),
    );
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
