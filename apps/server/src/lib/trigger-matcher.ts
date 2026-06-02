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
import { type Document, apiTokens, documents, projects, users, workspaces } from '../db/schema.ts';
import { env } from '../env.ts';
import {
  createRun,
  ensureRunsTable,
  getActiveRun,
  getPendingApprovalRun,
  nextChainId,
  transitionRun,
} from '../services/agent-runs.ts';
import { resolveAgentProjects } from './agent-projects.ts';
import { findSystemWorkspaceId, resolveAgentForRun } from './system-workspace.ts';
import type { AgentRunFrontmatter } from './agent-run-schema.ts';
import type { BusEvent } from './event-bus.ts';
import type { Reactor } from './event-dispatcher.ts';
import { emitChainSuppressed } from './autonomy-gate.ts';
import { rejectRun } from './runner.ts';
import { HTTPError } from './http.ts';

/**
 * Create a FRESH trigger-fired run, skipping (not throwing) when the agent has
 * no prompt. `createRun` throws `AGENT_PROMPT_EMPTY` (422) for an agent whose
 * body — the prompt — is empty; on the synchronous HTTP/MCP paths that 422 is
 * the right response, but here a throw escapes `react()` and the durable
 * dispatcher treats it as a HALT: it stops advancing this reactor's cursor and
 * replays the same event every tick forever, wedging ALL trigger processing
 * instance-wide. So a misconfigured (body-less) agent must be SKIPPED — the
 * same skip-and-return semantics as the sibling guards (unresolved agent/owner)
 * — not allowed to poison the reactor. Any OTHER error still propagates (a real
 * fault SHOULD halt for retry).
 *
 * FRESH-path only: there is no pre-existing run to strand, so a bare skip is
 * correct. The RESUME path does NOT use this — it must FAIL the stranded
 * awaiting_approval run instead of skipping (see handleResumeRun). No create-
 * time empty-body guard exists (a deliberate decision — see
 * tasks/retro-follow-ups.md); this reactor-side skip is the load-bearing fix.
 */
async function createRunSkippingEmptyPrompt(
  args: Parameters<typeof createRun>[0],
): Promise<void> {
  try {
    await createRun(args);
  } catch (err) {
    if (err instanceof HTTPError && err.code === 'AGENT_PROMPT_EMPTY') {
      console.log(
        `[trigger-matcher] agent '${args.agent.slug}' has an empty prompt (body); skipping the trigger-created run instead of halting the reactor`,
      );
      return;
    }
    throw err;
  }
}

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
 * Resolve the FK-valid owning User for a trigger-created run from the event's
 * actor. Mirrors maybeCreateRun's step-6 logic so both create paths
 * (assignment/mention dispatch AND the resume_run internal_action) own runs the
 * SAME way — never fabricating a `system:` user (which would violate
 * documents.updated_by → users.id).
 *
 *   a) actor IS a users.id (session path) → that user.
 *   b) actor is an api_tokens.id for a HUMAN PAT (agentId NULL) → the token's
 *      `createdBy` human. (Agent tokens emit `actor='agent:<slug>'`, caught by
 *      the autonomy gate upstream, so they never reach a create path.)
 *   c) neither resolves → null (caller logs + skips rather than fabricate one).
 */
async function resolveOwnerUser(actorId: string | null | undefined) {
  if (!actorId) return null;
  const direct = await db.query.users.findFirst({ where: eq(users.id, actorId) });
  if (direct) return direct;
  const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, actorId) });
  if (token && token.agentId === null && token.createdBy) {
    return (await db.query.users.findFirst({ where: eq(users.id, token.createdBy) })) ?? null;
  }
  return null;
}

/**
 * D-5 — the internal_action handlers for the builtin approval / rejection
 * triggers. The matcher matches `builtin-on-approval` (event_filter
 * `{kind:'approval'}` → `resume_run`) / `builtin-on-rejection`
 * (`{kind:'rejection'}` → `reject_run`) against a `comment.created` event, then
 * calls this. The comment.created payload (services/comments.ts) carries
 * `document_id` (the comment id), `parent_id` (the run's parent work_item/page)
 * and `target_agent` (the agent slug).
 *
 * `reject_run` — find the parent's awaiting_approval run for the target agent
 * and reject it. `rejectRun` itself catches the approval/rejection race
 * (mitigation 43) as a benign no-op.
 *
 * `resume_run` — create a NEW `planning` run with `frontmatter.resume_of` =
 * the original run id + the original's INHERITED `chain_id`. The poller then
 * claims it and routes to `runAgentResume`. Idempotent against the
 * dispatcher's at-least-once replay (mitigation 52): if a resume row already
 * exists for this (parent, agent) lineage we skip creating a second one.
 *
 * Robustness (mitigation 49 — a throw halts the reactor): "nothing to do"
 * (no pending run, unresolvable owner, missing scope) logs + returns; only
 * genuine errors propagate.
 */
/**
 * Strip a leading `agent:` prefix, yielding the bare slug. Mirrors the strip in
 * services/comments.ts:resolveKindAndTarget — `target_agent` stores one of three
 * forms (bare slug, `agent:<slug>`, or a doc id); the run frontmatter stores the
 * BARE `agent.slug`, so all lookups normalize to it.
 */
function normalizeAgentSlug(s: string): string {
  return s.startsWith('agent:') ? s.slice('agent:'.length) : s;
}

/**
 * Resolve the target agent's BARE slug from a comment.created payload. Prefers
 * the immutable `target_agent_id` doc-id handle (BUG-013) — looks up the agent
 * doc in this workspace and returns its slug, surviving renames — and falls back
 * to the `agent:`-stripped `target_agent`.
 */
async function resolveTargetAgentSlug(
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  // Home predicate {eventWs, __system}, local-shadows-library — Phase C C1;
  // reuses Phase B resolveAgentForRun. The id-handle branch resolves by doc id
  // (immutable, survives renames) but must assert the resolved agent's home ∈
  // {eventWs, __system} so a comment can't reach an agent in a THIRD workspace.
  const targetAgentId =
    typeof payload.target_agent_id === 'string' ? payload.target_agent_id : undefined;
  if (targetAgentId) {
    const agentDoc = await db.query.documents.findFirst({
      where: and(eq(documents.id, targetAgentId), eq(documents.type, 'agent')),
    });
    if (agentDoc) {
      const systemId = await findSystemWorkspaceId(db); // undefined when __system unseeded
      if (agentDoc.workspaceId === workspaceId || agentDoc.workspaceId === systemId) {
        return agentDoc.slug;
      }
    }
  }
  const raw = typeof payload.target_agent === 'string' ? payload.target_agent : undefined;
  if (!raw) return undefined;
  const agent = await resolveAgentForRun(db, workspaceId, normalizeAgentSlug(raw));
  return agent?.slug;
}

async function handleInternalAction(action: string, event: ReactorEvent): Promise<void> {
  if (!event.workspaceId) return;
  const payload = (
    typeof event.payload === 'object' && event.payload !== null ? event.payload : {}
  ) as Record<string, unknown>;

  const parentId = typeof payload.parent_id === 'string' ? payload.parent_id : undefined;
  const commentId = typeof payload.document_id === 'string' ? payload.document_id : undefined;

  // Finding 1 — resolve the target agent to its BARE slug before the lookups.
  // `getPendingApprovalRun`/`getActiveRun` match `frontmatter.agent_slug` (the
  // bare `agent.slug`), but `target_agent` can arrive PREFIXED (`agent:<slug>`):
  // the cancel route emits that form, and clients may supply it per the
  // comment-schema "three forms". Passing it raw found NO run → a silent no-op
  // (`## Approved` does nothing; the resume idempotency guard was defeated).
  //   1) prefer `target_agent_id` (BUG-013's immutable doc-id handle): resolve
  //      the agent doc by id → its slug, surviving renames.
  //   2) fall back to the stripped `target_agent` slug.
  const agentSlug = await resolveTargetAgentSlug(event.workspaceId, payload);
  if (!parentId || !agentSlug) {
    console.log(
      `[trigger-matcher] internal_action '${action}' missing parent_id/target_agent in payload; skipping`,
    );
    return;
  }

  // The single awaiting_approval run for (parent, agent). Absent → nothing to
  // act on (the at-least-once dispatcher may replay after the run already
  // moved on, or the comment targeted an agent with no pending run). Benign.
  const pending = await getPendingApprovalRun({ parentId, agentSlug });
  if (!pending) {
    console.log(
      `[trigger-matcher] internal_action '${action}': no awaiting_approval run for parent=${parentId} agent=${agentSlug}; skipping`,
    );
    return;
  }

  if (action === 'reject_run') {
    // rejectRun catches RUN_TRANSITION_RACED + INVALID_RUN_TRANSITION itself
    // (mitigation 43) — a replayed/raced rejection is a no-op there.
    await rejectRun({ runId: pending.id, rejectionCommentId: commentId ?? pending.id });
    return;
  }

  if (action === 'resume_run') {
    await handleResumeRun(event, pending, agentSlug, parentId);
    return;
  }

  console.log(`[trigger-matcher] unknown internal_action '${action}'; skipping`);
}

/**
 * resume_run create path. Creates a new `planning` run that resumes the
 * `pending` (awaiting_approval) original, then leaves it for the poller.
 */
async function handleResumeRun(
  event: ReactorEvent,
  pending: Document,
  agentSlug: string,
  parentId: string,
): Promise<void> {
  const workspaceId = event.workspaceId;
  if (!workspaceId) return;

  // Idempotency / at-least-once (mitigation 52). The dispatcher may replay the
  // same comment.created event; the original STAYS awaiting_approval until the
  // poller runs runAgentResume, so a naive replay could create a SECOND resume
  // row. getActiveRun excluding the original lineage row detects an
  // already-created resume peer — if present, a resume is already in flight.
  const inFlightResume = await getActiveRun({ parentId, agentSlug, excludeRunId: pending.id });
  if (inFlightResume) {
    console.log(
      `[trigger-matcher] resume_run: a resume is already in flight (${inFlightResume.id}) for parent=${parentId} agent=${agentSlug}; skipping`,
    );
    return;
  }

  // Resolve the agent doc under the home predicate {eventWs, __system},
  // local-shadows-library — Phase C C1; reuses Phase B resolveAgentForRun. A
  // resume of a __system library agent's run resolves the same way the fresh
  // path does.
  const agent = await resolveAgentForRun(db, workspaceId, agentSlug);
  if (!agent) {
    console.log(`[trigger-matcher] resume_run: agent '${agentSlug}' not found; skipping`);
    return;
  }

  // Owner: the resume row is owned by a real user — reuse the original run's
  // owner (it was created by the originating human in C-11), falling back to
  // resolving the event actor. Never fabricate `system:` (FK constraint).
  let ownerUser = pending.createdBy
    ? ((await db.query.users.findFirst({ where: eq(users.id, pending.createdBy) })) ?? null)
    : null;
  if (!ownerUser) ownerUser = await resolveOwnerUser(event.actor);
  if (!ownerUser) {
    console.log(
      '[trigger-matcher] resume_run: cannot resolve a FK-valid owner for the resume run; skipping',
    );
    return;
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!pending.projectId) return;
  const project = await db.query.projects.findFirst({ where: eq(projects.id, pending.projectId) });
  if (!workspace || !project) return;

  // Inherit the original run's chain_id — a resume CONTINUES the chain, it does
  // not start a fresh one.
  const originalFm = pending.frontmatter as AgentRunFrontmatter;
  const chainId = originalFm.chain_id;
  const projectId = project.id;

  const runsTable = await db.transaction(async (tx) =>
    ensureRunsTable(tx, { workspaceId, projectId }),
  );

  // RESUME path: do NOT silently skip a body-less agent the way the fresh-
  // trigger path does. The fresh path has no pre-existing run to strand, but
  // here the original `pending` run sits in awaiting_approval and its ONLY exit
  // is the resume row executing — a bare skip would leave it dangling forever
  // (no sweeper touches awaiting_approval) with zero operator feedback after
  // they approved. So on an empty prompt, FAIL the original run: transitionRun
  // emits agent.run.failed (the operator-visible signal, surfaced in the
  // activity feed), mirroring rejectRun's terminal-transition convention. Any
  // OTHER createRun error still propagates (a real fault halts for retry).
  try {
    await createRun({
      workspace,
      project,
      runsTable,
      agent,
      actor: ownerUser,
      input: {
        parentDocumentId: parentId,
        firedBy: `resume-of:${pending.id}`,
        chainId,
        triggerId: null,
        resumeOf: pending.id,
      },
    });
  } catch (err) {
    if (err instanceof HTTPError && err.code === 'AGENT_PROMPT_EMPTY') {
      console.log(
        `[trigger-matcher] resume_run: agent '${agentSlug}' has an empty prompt (body); failing the stranded awaiting_approval run ${pending.id} instead of leaving it dangling`,
      );
      await transitionRun(pending.id, {
        newStatus: 'failed',
        actor: ownerUser.id,
        errorReason: 'prompt_empty',
        errorDetail:
          "The agent's prompt (document body) was cleared before approval; restore it and re-run.",
      });
      return;
    }
    throw err;
  }
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

  // 2. Resolve the agent doc by slug under the home predicate {eventWs,
  //    __system}, local-shadows-library — Phase C C1; reuses Phase B
  //    resolveAgentForRun. A B trigger can thus fire a __system library agent
  //    (e.g. the operator); a B-local agent of the same slug wins. An unresolved
  //    slug is legitimate UX (a human typed a speculative slug) — just don't fire.
  const agent = await resolveAgentForRun(db, workspaceId, agentSlug);
  if (!agent) return;

  // 3. Allow-list (mitigation 50). Reuse the canonical `resolveAgentProjects`
  //    so the matcher normalizes `frontmatter.projects` IDENTICALLY to every
  //    other call site (bearer middleware, SSE replay, reconciler, comments,
  //    mcp). It guards non-array input (→ ['*']), drops non-string entries, and
  //    collapses mixed ['proj','*'] → ['*'] — none of which the old `as
  //    string[]` cast did (a string `projects` would substring-match). Skip
  //    (zero runs) when the list is narrowed and excludes this event's project.
  // C2 — a library agent's `projects` describe __system, not B, so they are NOT a
  // B-fire-gate. Skip the allow-list for a library agent (home __system); its
  // AUTHORITY in B is bounded at run time by loadContext's caller-sole narrowing
  // (Phase B B5), not at the fire decision. A LOCAL agent keeps the gate. (When
  // __system is unseeded, systemId is undefined and `agent.workspaceId ===
  // undefined` is false for every real agent, so the gate still applies.)
  const systemId = await findSystemWorkspaceId(db);
  const isLibraryAgent = systemId !== undefined && agent.workspaceId === systemId;
  if (!isLibraryAgent) {
    const allowList = resolveAgentProjects(agent);
    if (!allowList.includes('*') && (!event.projectId || !allowList.includes(event.projectId))) {
      return;
    }
  }

  // 4. Autonomy gate (mitigation 51). With the flag OFF, an agent-originated
  //    event creates ZERO runs and emits exactly one durable
  //    `agent.chain.suppressed`. Human-originated events fall through.
  if (isAgentOriginated(event) && !env.FOLIO_AGENT_CHAINS_ENABLED) {
    await emitChainSuppressed(db, {
      workspaceId,
      projectId: event.projectId ?? null,
      documentId: parentId,
      agentSlug,
      // `event.actor` is the agent identity (or upstream actor) that
      // originated the suppressed chain hop; `system` only if absent.
      actor: event.actor ?? 'system',
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
  //    Trigger-created runs are OWNED by the originating human. There is NO
  //    `system:` user — that would violate the documents.updated_by →
  //    users.id FK (this closes follow-up C.2-R-3). `event.actor` is set by
  //    routes' resolveActor: a `users.id` on a SESSION request, but the
  //    `api_tokens.id` on a BEARER request. So we resolve in two steps:
  //      a) actor IS a users.id (session path) → use it directly.
  //      b) actor is an api_tokens.id → for a HUMAN PAT (agentId NULL) the
  //         human owner is the token's `createdBy`. (Agent tokens emit
  //         `actor='agent:<slug>'`, caught by the autonomy gate / isAgent
  //         Originated upstream, so they never need token-id resolution here.)
  //    If neither resolves to a real user, we cannot own the run — return and
  //    log rather than fabricate an owner.
  const actorId = event.actor;
  if (!actorId) return;
  const actorUser = await resolveOwnerUser(actorId);
  if (!actorUser) {
    console.log(
      `[trigger-matcher] actor '${actorId}' does not resolve to a user (nor a human PAT creator); cannot own a trigger-created run (skipping)`,
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

  await createRunSkippingEmptyPrompt({
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
        await handleInternalAction(String(fm.internal_action), event);
        continue;
      }
      const agentSlug = resolveAgentPlaceholder(fm.agent, event.payload);
      if (!agentSlug) continue;
      await maybeCreateRun(event, agentSlug, trigger.id);
    }
  },
};
