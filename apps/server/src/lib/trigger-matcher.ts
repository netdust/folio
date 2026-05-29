/**
 * Phase 3 Sub-phase C.3 (Task C-11) — trigger-matcher: the FIRST reactor on the
 * Reaction Plane.
 *
 * The dispatcher (C-10b) polls the durable `events` table and fans each event
 * to registered reactors. This reactor reads trigger DOCUMENTS
 * (`type='trigger'`) for the event's workspace and honors them. Matching logic
 * is authored as CONTENT (the trigger frontmatter), not hard-coded here — this
 * is where "behavior is authored as content" meets the durable event log.
 *
 * When a trigger matches a human assignment / @mention of an agent, the matcher
 * durably creates a `planning` agent_run via `createRun`.
 *
 * Threat-model mitigations bound here:
 *  - 50 — agent allow-list: a run is created only if the agent's
 *    `frontmatter.projects` includes '*' OR the event's projectId.
 *  - 51 — autonomy gate: with `FOLIO_AGENT_CHAINS_ENABLED` OFF (the V1
 *    default), an agent-ORIGINATED event creates ZERO runs and emits exactly
 *    one durable `agent.chain.suppressed` signal. Human-originated events still
 *    fire. This draws the V1↔autonomous line.
 *  - 52 — idempotency: `getActiveRun` short-circuits the create when a
 *    non-terminal peer run already exists for (parent, agent). This is ALSO the
 *    safety net for the dispatcher's at-least-once replay — a crash between the
 *    react-effect and the cursor-write replays the event, and this guard makes
 *    the replay a no-op.
 *
 * Idempotency note: the matcher is idempotent by construction (the getActiveRun
 * guard + createRun's own atomic tx). The dispatcher only advances a reactor's
 * cursor AFTER a successful react(), so a replay re-enters here harmlessly.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, projects, users, workspaces } from '../db/schema.ts';
import { env } from '../env.ts';
import { createRun, ensureRunsTable, getActiveRun, nextChainId } from '../services/agent-runs.ts';
import type { BusEvent } from './event-bus.ts';
import type { Reactor } from './event-dispatcher.ts';
import { emitEvent, txWithEvents } from './events.ts';

type ReactorEvent = BusEvent & { seq: number };

/**
 * Shallow filter match: every key in `filter` must equal the same key in the
 * event payload. Used for `event_filter` (e.g. `{ kind: 'approval' }` matched
 * against the comment payload). The approval/rejection comment-kind wiring is
 * a Sub-phase D concern; the internal_action path these filters guard is a
 * stub here, so a best-effort shallow match is sufficient for C-11.
 */
function matchesFilter(filter: unknown, payload: unknown): boolean {
  if (typeof filter !== 'object' || filter === null) return true;
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  for (const [k, v] of Object.entries(filter as Record<string, unknown>)) {
    if (p[k] !== v) return false;
  }
  return true;
}

/**
 * Resolve a trigger's `agent` placeholder against the event payload.
 *  - `'$event.agent'`       → payload.agent       (agent.task.assigned)
 *  - `'$event.agent_slug'`  → payload.agent_slug  (comment.mentioned)
 *  - a literal non-`$` slug → itself
 *  - null / undefined / unknown placeholder → undefined
 */
function resolveAgentPlaceholder(agent: unknown, payload: unknown): string | undefined {
  if (typeof agent !== 'string' || agent.length === 0) return undefined;
  if (!agent.startsWith('$')) return agent;
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  if (agent === '$event.agent') {
    return typeof p.agent === 'string' ? p.agent : undefined;
  }
  if (agent === '$event.agent_slug') {
    return typeof p.agent_slug === 'string' ? p.agent_slug : undefined;
  }
  return undefined;
}

/**
 * Resolve the PARENT document id per event kind. CRITICAL: only
 * `agent.task.assigned` carries the parent in `documentId`. For `comment.*`
 * events `documentId` is the COMMENT; the parent work_item/page is in
 * `payload.parent_id`.
 */
function resolveParentId(event: ReactorEvent): string | undefined {
  if (event.kind === 'agent.task.assigned') {
    return event.documentId ?? undefined;
  }
  const p = (
    typeof event.payload === 'object' && event.payload !== null ? event.payload : {}
  ) as Record<string, unknown>;
  return typeof p.parent_id === 'string' ? p.parent_id : undefined;
}

/**
 * An event is "agent-originated" when an agent produced it — either the actor
 * is an `agent:<slug>` identity, OR the payload carries a `run_id` (the event
 * was emitted from inside an agent run, e.g. a comment an agent posted).
 */
function isAgentOriginated(event: ReactorEvent): boolean {
  if (typeof event.actor === 'string' && event.actor.startsWith('agent:')) return true;
  const p = event.payload as Record<string, unknown> | undefined;
  return typeof p?.run_id === 'string';
}

/**
 * D-5 fills the internal_action handlers (resume_run / reject_run for the
 * approval / rejection builtin triggers). For C-11 this is a documented no-op:
 * the approval flow isn't wired yet, so honoring the trigger here would have
 * nothing to act on.
 */
function handleInternalActionStub(action: string, event: ReactorEvent): void {
  // D-5 fills this in (resume_run / reject_run). Logged so a misfire during
  // bring-up is visible without changing behavior.
  console.log(
    `[trigger-matcher] internal_action '${action}' is a stub (D-5 fills it); event kind=${event.kind}`,
  );
}

async function maybeCreateRun(
  event: ReactorEvent,
  agentSlug: string,
  triggerId: string,
): Promise<void> {
  if (!event.workspaceId) return;
  const workspaceId = event.workspaceId;

  // 1. Resolve the parent (work_item / page). Per-event-kind: assignment →
  //    documentId; comment.* → payload.parent_id.
  const parentId = resolveParentId(event);
  if (!parentId) return;

  // 2. Resolve the agent doc by slug within the event's workspace. An
  //    unresolved slug is a legitimate UX (a human typed a speculative slug);
  //    just don't fire.
  const agent = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.type, 'agent'),
      eq(documents.slug, agentSlug),
    ),
  });
  if (!agent) return;

  // 3. Allow-list (mitigation 50). Default ['*'] when unset. Skip (zero runs)
  //    when the list is narrowed and excludes this event's project.
  const agentFm = agent.frontmatter as Record<string, unknown>;
  const allowList = (agentFm.projects as string[] | undefined) ?? ['*'];
  if (!allowList.includes('*') && (!event.projectId || !allowList.includes(event.projectId))) {
    return;
  }

  // 4. Autonomy gate (mitigation 51). With the flag OFF, an agent-originated
  //    event creates ZERO runs and emits exactly one durable
  //    `agent.chain.suppressed`. Human-originated events fall through.
  if (isAgentOriginated(event) && !env.FOLIO_AGENT_CHAINS_ENABLED) {
    await txWithEvents(db, async (tx) => {
      await emitEvent(tx, {
        workspaceId,
        projectId: event.projectId ?? null,
        documentId: parentId,
        kind: 'agent.chain.suppressed',
        // `event.actor` is the agent identity (or upstream actor) that
        // originated the suppressed chain hop; `system` only if absent.
        actor: event.actor ?? 'system',
        payload: { agent_slug: agentSlug, reason: 'autonomy_gate' },
      });
    });
    return;
  }

  // 5. Idempotency (mitigation 52). A non-terminal peer for (parent, agent)
  //    means a run is already in flight — short-circuit. Also the at-least-once
  //    replay safety net.
  const active = await getActiveRun({ parentId, agentSlug });
  if (active) return;

  // 6. Resolve workspace + project rows + the originating-human owner.
  //
  //    Trigger-created runs are OWNED by the originating human (resolved from
  //    `event.actor`, a users.id for human-originated events). There is NO
  //    `system:` user — that would violate the documents.updated_by →
  //    users.id FK (this closes follow-up C.2-R-3). For V1 with the flag OFF,
  //    only human-originated events reach this point, so `event.actor` always
  //    resolves to a real user. When the flag is ON and the event is
  //    agent-originated, the owner must STILL be a real user: a genuine
  //    agent-chain hop carries the originating human through `event.actor`
  //    (the chain's owner), while `payload.run_id` marks it agent-originated.
  //    If no user resolves (e.g. `actor='agent:foo'` with the flag ON), we
  //    cannot own the run — return and log rather than fabricate an owner.
  const actorId = event.actor;
  if (!actorId) return;
  const actorUser = await db.query.users.findFirst({ where: eq(users.id, actorId) });
  if (!actorUser) {
    console.log(
      `[trigger-matcher] actor '${actorId}' does not resolve to a user; cannot own a trigger-created run (skipping)`,
    );
    return;
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!event.projectId) return;
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, event.projectId),
  });
  if (!workspace || !project) return;

  // 7. Lazy-seed the project's runs table (own tx — ensureRunsTable requires a
  //    transaction handle), THEN create the run (createRun owns its OWN
  //    txWithEvents internally and emits agent.run.started — do NOT wrap it).
  const projectId = project.id;
  const runsTable = await db.transaction(async (tx) =>
    ensureRunsTable(tx, { workspaceId, projectId }),
  );

  await createRun({
    workspace,
    project,
    runsTable,
    agent,
    actor: actorUser,
    input: {
      parentDocumentId: parentId,
      firedBy: event.kind,
      chainId: nextChainId({ firedBy: event.kind }),
      triggerId,
    },
  });
}

export const triggerMatcher: Reactor = {
  id: 'trigger-matcher',
  kinds: ['agent.task.assigned', 'comment.mentioned', 'comment.created'],
  async react(event: ReactorEvent): Promise<void> {
    if (!event.workspaceId) return;
    const triggers = await db.query.documents.findMany({
      where: and(eq(documents.workspaceId, event.workspaceId), eq(documents.type, 'trigger')),
    });
    for (const trigger of triggers) {
      const fm = trigger.frontmatter as Record<string, unknown>;
      if (fm.enabled !== true) continue;
      if (fm.on_event !== event.kind) continue;
      if (fm.event_filter && !matchesFilter(fm.event_filter, event.payload)) continue;
      if (fm.internal_action) {
        handleInternalActionStub(String(fm.internal_action), event);
        continue;
      }
      const agentSlug = resolveAgentPlaceholder(fm.agent, event.payload);
      if (!agentSlug) continue;
      await maybeCreateRun(event, agentSlug, trigger.id);
    }
  },
};
