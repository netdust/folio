import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';

export interface BacklinkRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  tableId: string | null;
}

export interface FindBacklinksArgs {
  workspaceId: string;
  projectId: string;
  slug: string;
}

/**
 * Query-time backlinks: documents in the workspace whose frontmatter contains
 * the wiki-link token `[[<slug>]]` in ANY value — a single relation string or
 * an element of a multi-relation array. Links live only in frontmatter (the
 * source of truth); nothing is stored in reverse, so this can't drift.
 */
export async function findBacklinks(args: FindBacklinksArgs): Promise<BacklinkRow[]> {
  const token = `[[${args.slug}]]`;
  const rows = await db.all<BacklinkRow>(sql`
    SELECT d.id AS id, d.slug AS slug, d.title AS title, d.type AS type, d.table_id AS tableId
    FROM ${documents} d
    WHERE d.workspace_id = ${args.workspaceId}
      AND d.type IN ('work_item','page')
      AND d.slug != ${args.slug}
      AND EXISTS (
        SELECT 1 FROM json_each(d.frontmatter) AS fm
        WHERE fm.value = ${token}
           OR (json_valid(fm.value) AND EXISTS (
                 SELECT 1 FROM json_each(fm.value) AS el WHERE el.value = ${token}
               ))
      )
    ORDER BY d.table_id, d.title
  `);
  return rows;
}
