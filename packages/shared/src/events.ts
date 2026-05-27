/**
 * Phase 2.6 sub-phase D: EventKind + KNOWN_EVENT_KINDS live in @folio/shared
 * so both the server and the web UI can import them. The server keeps a
 * re-export from apps/server/src/lib/events.ts for source-compat with the
 * existing many `EventKind` import sites.
 */
export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'table.created'    | 'table.updated'    | 'table.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated'
  | 'activity.logged'
  | 'agent.created'    | 'agent.deleted'   | 'agent.task.assigned'
  | 'comment.created'  | 'comment.mentioned' | 'comment.deleted'
  | 'agent.allow_list.reconciled';

/** Source-of-truth list. Keep in sync with EventKind above. */
export const KNOWN_EVENT_KINDS: readonly EventKind[] = [
  'document.created', 'document.updated', 'document.deleted',
  'status.created',   'status.updated',   'status.deleted',
  'field.created',    'field.updated',    'field.deleted',
  'view.created',     'view.updated',     'view.deleted',
  'table.created',    'table.updated',    'table.deleted',
  'project.created',  'project.updated',  'project.deleted',
  'workspace.created','workspace.updated',
  'activity.logged',
  'agent.created',    'agent.deleted',   'agent.task.assigned',
  'comment.created',  'comment.mentioned', 'comment.deleted',
  'agent.allow_list.reconciled',
];
