import { nanoid } from 'nanoid';
import { statuses, tables, views } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function seedProjectDefaults(
  tx: DBOrTx,
  projectId: string,
): Promise<{ tableId: string }> {
  const tableId = nanoid();
  await tx.insert(tables).values({
    id: tableId,
    projectId,
    slug: 'work-items',
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
    visibleFields: ['status', 'priority'],
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
