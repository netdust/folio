import { and, desc, eq, isNull } from 'drizzle-orm';
import { filterCompile, FilterCompileError } from '@folio/shared';
import { db } from '../db/client.ts';
import { documents, views } from '../db/schema.ts';
import type { Document, View } from '../db/schema.ts';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
import { HTTPError } from '../lib/http.ts';

/**
 * MCP-relevant read service. List views for a table, ordered by `order`.
 */
export async function listViews(tableId: string): Promise<View[]> {
  return db.query.views.findMany({
    where: eq(views.tableId, tableId),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
}

/**
 * Apply a stored view's filters/sort to documents in a project/table.
 *
 * Decision: re-use compileFilterToWhere from the documents list path so the
 * view filter language stays a single AST (no second compiler). The view's
 * `filters` JSON is treated as a FilterAST root. Sort is not applied at the
 * SQL layer in v1 because the MCP read path uses default `updatedAt desc, id
 * desc` like the HTTP list endpoint — keeping the surface symmetric. Custom
 * `view.sort` is wired in via a future task once frontmatter sort lands.
 */
export async function runView(opts: {
  view: View;
  projectId: string;
  tableId: string | null;
  limit?: number;
}): Promise<Document[]> {
  const { view, projectId, tableId } = opts;
  const limit = Math.min(200, opts.limit ?? 50);

  const whereClauses = [eq(documents.projectId, projectId)];
  if (tableId) {
    whereClauses.push(eq(documents.tableId, tableId));
  } else {
    // Pages-style view (project-scoped) — match docs with NULL tableId.
    whereClauses.push(isNull(documents.tableId));
  }

  const filters = view.filters as unknown;
  if (filters && typeof filters === 'object' && Object.keys(filters as object).length > 0) {
    try {
      const ast = filterCompile(filters as Parameters<typeof filterCompile>[0]);
      const where = compileFilterToWhere(ast, documents);
      if (where) whereClauses.push(where);
    } catch (e) {
      if (e instanceof FilterCompileError) {
        throw new HTTPError('INVALID_FILTER', e.message, 422);
      }
      throw e;
    }
  }

  return db
    .select()
    .from(documents)
    .where(and(...whereClauses))
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit);
}

