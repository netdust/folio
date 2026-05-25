import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { projects } from '../db/schema.ts';
import type { Project } from '../db/schema.ts';

/**
 * MCP-relevant service for listing projects in a workspace.
 */
export async function listProjects(workspaceId: string): Promise<Project[]> {
  return db.query.projects.findMany({
    where: eq(projects.workspaceId, workspaceId),
  });
}
