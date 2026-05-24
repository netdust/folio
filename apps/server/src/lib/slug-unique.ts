import { and, eq, like } from 'drizzle-orm';
import { documents, projects, tables, workspaces } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

async function pickFree(taken: Set<string>, base: string): Promise<string> {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not find a free slug for base "${base}"`);
}

export async function slugUniqueInDocuments(
  tx: DBOrTx,
  projectId: string,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: documents.slug })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), like(documents.slug, `${base}%`)));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}

export async function slugUniqueInProjects(
  tx: DBOrTx,
  workspaceId: string,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), like(projects.slug, `${base}%`)));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}

export async function slugUniqueInWorkspaces(
  tx: DBOrTx,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(like(workspaces.slug, `${base}%`));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}

export async function slugUniqueInTables(
  tx: DBOrTx,
  projectId: string,
  base: string,
): Promise<string> {
  const rows = await tx
    .select({ slug: tables.slug })
    .from(tables)
    .where(and(eq(tables.projectId, projectId), like(tables.slug, `${base}%`)));
  return pickFree(new Set(rows.map((r) => r.slug)), base);
}
