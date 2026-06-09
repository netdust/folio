import { nanoid } from 'nanoid';
import { statuses, tables, views } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

/**
 * The slug of the table every project auto-seeds and that the no-`/t/<tslug>`
 * default resolves to. THE single source of truth for "the default table" —
 * both the HTTP scope middleware (`middleware/scope.ts`) and the MCP resolver
 * (`agent-tools-registry.ts resolveTableForArgs`) import this so a rename can't
 * silently diverge the two surfaces (the B1/D2 convergence point).
 */
export const DEFAULT_TABLE_SLUG = 'work-items';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function seedProjectDefaults(
  tx: DBOrTx,
  projectId: string,
): Promise<{ tableId: string }> {
  const tableId = nanoid();
  await tx.insert(tables).values({
    id: tableId,
    projectId,
    slug: DEFAULT_TABLE_SLUG,
    name: 'Work Items',
    icon: null,
    order: 0,
  });

  const statusRows = [
    { key: 'backlog',     name: 'Backlog',     category: 'backlog'   as const, color: '#94a3b8', order: 0  },
    { key: 'todo',        name: 'Todo',        category: 'unstarted' as const, color: '#3b82f6', order: 10 },
    { key: 'in_progress', name: 'In Progress', category: 'started'   as const, color: '#f59e0b', order: 20 },
    { key: 'done',        name: 'Done',        category: 'completed' as const, color: '#10b981', order: 30 },
  ];
  for (const s of statusRows) {
    await tx.insert(statuses).values({ id: nanoid(), projectId, tableId, ...s });
  }
  await tx.insert(views).values({
    id: nanoid(),
    projectId,
    tableId,
    name: 'All work items',
    type: 'list',
    filters: { type: { $eq: 'work_item' } },
    sort: [{ key: 'updated_at', dir: 'desc' }],
    visibleFields: ['title', 'status', 'priority', 'assignee', 'due_date', 'updated_at'],
    isDefault: true,
    order: 0,
  });
  await tx.insert(views).values({
    id: nanoid(),
    projectId,
    tableId,
    name: 'Board',
    type: 'kanban',
    filters: { type: { $eq: 'work_item' } },
    sort: [],
    groupBy: 'status',
    visibleFields: ['priority', 'assignee'],
    isDefault: false,
    order: 10,
  });

  return { tableId };
}
