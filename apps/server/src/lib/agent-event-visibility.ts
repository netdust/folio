/**
 * Visibility predicate for agent-bound tokens reading workspace-level events.
 *
 * H1/H2/H7 superseded G9. The original `isCrossAgentLeak` filtered on
 * `kind.startsWith('agent.')` which had two bugs:
 *
 *   1. **False positive** — `agent.task.assigned` is emitted with
 *      `documentId = <work_item id>`, not the agent's id. The kind-prefix
 *      filter dropped these events for the very agent they were addressed
 *      to. Agents listening for assignments via SSE saw nothing.
 *   2. **False negative** — `document.created` for `type='agent'` (and
 *      `activity.logged` on an agent doc) don't start with `agent.` but
 *      still expose other agents' identifiers (api_token_id, free-form
 *      notes). They slipped past the kind-prefix filter.
 *
 * The correct shape is **subject-based**: workspace-level events
 * (projectId=null) are visible to a narrowed agent token only when they
 * are ABOUT that agent. The "subject" is either the row's `documentId`
 * (for events emitted against the agent's row directly: agent.created,
 * agent.deleted, agent.allow_list.reconciled, activity.logged, plus the
 * generic document.created/updated/deleted on a type=agent row) OR the
 * payload's assignee slug (for agent.task.assigned, whose documentId is
 * the work_item but whose subject is the assigned agent).
 *
 * Project-scoped events (projectId !== null) are not the concern of this
 * predicate — the F3 allow-list filter handles them upstream.
 *
 * Non-agent-bound tokens (session auth, human PAT) bypass — they see
 * everything in the workspace.
 */
import type { EventKind } from './events.ts';

export interface AgentEventContext {
  /** The agent doc id this token is bound to. Null = not an agent-bound token (bypass). */
  agentId: string | null;
  /** The agent's CURRENT slug. Used to match payload.agent on assignment events. */
  agentSlug: string | null;
}

export interface VisibilityArgs {
  kind: EventKind;
  /** null for workspace-scoped rows; project id otherwise. This predicate
   *  is meant for projectId === null events; callers must check projectId
   *  separately and apply F3 allow-list narrowing for project-scoped rows. */
  projectId: string | null;
  /** The event's documentId — usually the row the event is "about" (an
   *  agent for agent.created, a work_item for agent.task.assigned, etc.). */
  documentId: string | null;
  /** The event's payload — read to extract the assignee slug on
   *  agent.task.assigned. */
  payload: unknown;
}

/**
 * Should this event be visible to the given agent token?
 *
 * Contract:
 * - Returns `true` when the agent should see the event.
 * - Returns `false` when the event must be hidden (cross-agent leak).
 * - Non-agent tokens (`ctx.agentId === null`) always see everything.
 * - Project-scoped events (`projectId !== null`) always return true here;
 *   the caller applies its own allow-list narrowing. Project-scoped
 *   assignment events are still narrowed correctly because the F3
 *   allow-list passes them only when the agent owns the project, and this
 *   predicate then confirms the agent is the assignee.
 */
export function isAgentEventVisible(
  ctx: AgentEventContext,
  args: VisibilityArgs,
): boolean {
  // Non-agent token: no narrowing applied here.
  if (!ctx.agentId) return true;

  // Project-scoped event: leave the decision to the caller's F3 narrowing.
  // (Project-scoped agent.task.assigned for OUR agent in OUR project is
  // legit; project-scoped agent.task.assigned for another agent in our
  // project is also legit metadata — the agent allow-list owns the
  // project, so they can see all events in it.)
  if (args.projectId !== null) return true;

  // Workspace-level event. Visible only when it's about this agent.

  // Case 1: documentId matches the agent's own row. Covers agent.created,
  // agent.deleted, agent.allow_list.reconciled, activity.logged on the
  // agent doc, and document.created/updated/deleted for type='agent'.
  if (args.documentId !== null && args.documentId === ctx.agentId) return true;

  // Case 2: agent.task.assigned has documentId = work_item but payload.agent
  // = the assignee slug. Match on slug so the assignee learns of their
  // assignment.
  if (args.kind === 'agent.task.assigned') {
    const p = args.payload as { agent?: unknown } | null | undefined;
    const assigneeSlug = p && typeof p.agent === 'string' ? p.agent : null;
    if (assigneeSlug && ctx.agentSlug && assigneeSlug === ctx.agentSlug) {
      return true;
    }
  }

  // Otherwise: workspace-level event about a different agent (or no agent
  // at all — e.g. workspace.created). Hide from narrowed agents.
  //
  // Note: workspace.created and workspace.updated are about the workspace
  // itself, not any one agent. We hide them too — a narrowed agent doesn't
  // need to know about workspace lifecycle events.
  return false;
}
