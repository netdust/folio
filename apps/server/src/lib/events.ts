import { nanoid } from 'nanoid';
import { events } from '../db/schema.ts';
import type { DB } from '../db/client.ts';
import { eventBus } from './event-bus.ts';

export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'table.created'    | 'table.updated'    | 'table.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated'
  | 'activity.logged'
  | 'agent.created'    | 'agent.deleted'   | 'agent.task.assigned';

export interface EmitArgs {
  workspaceId: string;
  /** null for workspace-scoped resources (agent/trigger); a project id otherwise. */
  projectId?: string | null;
  documentId?: string;
  kind: EventKind;
  actor: string;
  payload?: unknown;
}

// Drizzle transaction handles share the query API with DB; one shape works for both.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function emitEvent(tx: DBOrTx, args: EmitArgs): Promise<void> {
  const id = nanoid();
  const createdAt = Date.now();
  await tx.insert(events).values({
    id,
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: (args.payload ?? {}) as unknown,
    // Explicit createdAt so the DB row and the bus event share one value —
    // SQL-default `unixepoch() * 1000` would fire later and drift sub-ms,
    // which could put Task 4's Last-Event-Id replay out of order with live
    // events on a busy server.
    createdAt: new Date(createdAt),
  });
  // Publish to the in-process bus after the row insert. SSE subscribers see
  // this event; the table row is the durable backstop for Last-Event-Id replay.
  eventBus.publish({
    id,
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: args.payload ?? {},
    createdAt,
  });
}
