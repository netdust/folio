import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { statuses } from '../db/schema.ts';
import type { Status } from '../db/schema.ts';

/**
 * MCP-relevant read service. List statuses for a table, ordered by `order`.
 */
export async function listStatuses(tableId: string): Promise<Status[]> {
  return db.query.statuses.findMany({
    where: eq(statuses.tableId, tableId),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
}
