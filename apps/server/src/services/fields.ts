import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { fields } from '../db/schema.ts';
import type { Field } from '../db/schema.ts';

/**
 * MCP-relevant read service. List fields for a table, ordered by `order`.
 */
export async function listFields(tableId: string): Promise<Field[]> {
  return db.query.fields.findMany({
    where: eq(fields.tableId, tableId),
    orderBy: (t, { asc }) => [asc(t.order)],
  });
}
