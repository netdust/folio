import { nanoid } from 'nanoid';
import { events } from '../db/schema.ts';
import type { DB } from '../db/client.ts';

export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated';

export interface EmitArgs {
  workspaceId: string;
  projectId?: string;
  documentId?: string;
  kind: EventKind;
  actor: string;
  payload?: unknown;
}

// Drizzle transaction handles share the query API with DB; one shape works for both.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function emitEvent(tx: DBOrTx, args: EmitArgs): Promise<void> {
  await tx.insert(events).values({
    id: nanoid(),
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: (args.payload ?? {}) as unknown,
  });
}
