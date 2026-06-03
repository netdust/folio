/**
 * Phase 2.6 sub-phase D: EventKind + KNOWN_EVENT_KINDS live in @folio/shared
 * so both the server and the web UI can import them. The server keeps a
 * re-export from apps/server/src/lib/events.ts for source-compat with the
 * existing many `EventKind` import sites.
 *
 * Phase 3 (Task A-1): added agent.run.*, ai.action, runs_table.lazy_seeded,
 * workspace.provider.{degraded,recovered}.
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
  | 'agent.allow_list.reconciled'
  // Phase 3:
  | 'agent.run.started'
  | 'agent.run.awaiting_approval'
  | 'agent.run.running'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.rejected'
  // Phase 3.x — emitted when a claude-code run's full session transcript is
  // persisted onto the run document body (setRunBody). Honors rule #4: the
  // body write is never eventless, and transcript consumers get a dedicated
  // signal independent of the terminal transitionRun event.
  | 'agent.run.transcript'
  | 'ai.action'
  | 'runs_table.lazy_seeded'
  | 'workspace.provider.degraded'
  | 'workspace.provider.recovered'
  | 'reactor.halted'
  | 'reactor.recovered'
  // Emitted when the trigger-matcher reactor declines to fan out an
  // agent-originated chain because FOLIO_AGENT_CHAINS_ENABLED is off (V1
  // autonomy gate). Workspace-scoped, durable.
  | 'agent.chain.suppressed'
  // Piece B (T8) — emitted by setSkillTrust when a __system skill's `trusted`
  // flag is flipped. The flag is server-managed; this is the single audit
  // signal for a bless/unbless. Scoped to (__system, skills project, skill doc).
  | 'skill.trust.changed';

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
  // Phase 3:
  'agent.run.started',
  'agent.run.awaiting_approval',
  'agent.run.running',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.rejected',
  'agent.run.transcript',
  'ai.action',
  'runs_table.lazy_seeded',
  'workspace.provider.degraded',
  'workspace.provider.recovered',
  // Phase 3 C.3 — Reaction Plane system-level events (workspaceId: null):
  'reactor.halted',
  'reactor.recovered',
  // Phase 3 C-11 — autonomy-gate suppression signal (trigger-matcher).
  'agent.chain.suppressed',
  // Piece B (T8) — skill bless/unbless audit signal.
  'skill.trust.changed',
];
