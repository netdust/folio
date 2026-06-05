/**
 * Operator cockpit chat (Task 5) — the SEPARATE conversation-run path.
 *
 * WHY a separate path (plan-correction 2026-06-05, Step 2.5): `createRun`
 * hard-refuses the operator (`OPERATOR_RUN_UNSUPPORTED`) and requires a
 * parent/project/runsTable/persisted-token row that a conversation run has NONE
 * of. Forcing the operator through `createRun` would write conversation runs
 * into the `agent_run`/documents space — the exact event/trigger surface
 * invariant 10 + the walled-off conversation tables exist to AVOID. So a
 * conversation run is its OWN thing:
 *
 *   - It writes NO `agent_run` document. Its liveness is tracked solely by the
 *     conversation's `active_run_id` slot (the M14 CAS in the routes, T6).
 *   - Its "run id" is a generated id, NOT a document id.
 *   - It mints an EPHEMERAL in-memory operator token (never persisted to
 *     `api_tokens` — no token-row pollution; mirrors how ccExecute mints
 *     ephemeral tokens).
 *
 * CARRIER MECHANISM (stated choice). The runner entry point is
 * `runAgent({ runId })` → `loadContext(runId)`, which loads a `RunContext` from
 * the `documents` table by id. A conversation run has no such row, so we hand
 * `loadContext` the context out-of-band via a MODULE-LEVEL PENDING REGISTRY: a
 * `Map<runId, PendingConversationRun>` that `createConversationRun` populates and
 * `loadContext`'s conversation branch reads (and consumes) BEFORE its document
 * lookup. This is the simplest carrier given the `{ runId }`-only entry signature
 * — it keeps the runner's public API unchanged and routes the conversation run
 * through the same `runAgent` the route already kicks. The registry is in-process
 * (single-binary; no sidecar), bounded by the single-active-turn CAS (one live
 * conversation run per conversation at a time), and the entry is deleted on load
 * so it cannot leak.
 *
 * AUTHORITY (M1/M2). The operator's effective authority on a turn is the
 * agent ∩ caller floor:
 *   scopes  = toolsToScopes(OPERATOR_TOOLS) ∩ roleToScopes(callerRole)
 *   project = owner → null (no narrowing → operator `['*']` stands);
 *             non-owner → the UNION of visibleProjectIds across the caller's
 *             visibleWorkspaceIds (each project id is globally unique, so a flat
 *             union is a safe ceiling — same flat-snapshot tradeoff createRun
 *             already accepts for `caller_project_ids`).
 * A viewer-owned conversation therefore drives a READ-ONLY operator; an owner
 * drives the full operator reach. The ephemeral token's scopes ARE the floor,
 * and `RunContext.callerScopes` is set to the same set, so `executeTool`'s
 * double-membership check (`token.scopes ∩ callerScopes ∋ required`) holds.
 *
 * AUTHORITY-OVER-TIME (Option A). Authority is resolved FRESH at every turn from
 * the owner's CURRENT `users.role`. A promotion between turns grants the new
 * ability on the next turn; a demotion removes it. (A resumed run still inherits
 * its own original snapshot via the persisted thread; a NEW turn re-derives.)
 */

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { type DB } from '../db/client.ts';
import { type ApiToken, projects } from '../db/schema.ts';
import {
  callerProjectsFor,
  intersectAgentProjects,
} from '../lib/agent-projects.ts';
import { roleToScopes, toolsToScopes } from '../lib/agent-schema.ts';
import {
  canManageWorkspace,
  userRole,
  visibleProjectIds,
  visibleWorkspaceIds,
} from '../lib/access.ts';
import { OPERATOR_SLUG } from '../lib/operator.ts';
import { OPERATOR_TOOLS } from '../lib/system-skills.ts';

/**
 * The sentinel agent id stamped on the ephemeral operator token. The operator
 * has no `documents` row (it is a code singleton), so this is the synthetic id
 * from `getOperatorDocument()` (`operator:_operator`) — never a real FK. The
 * ephemeral token is held directly by the run (the conversation registry), never
 * looked up by hash, so the id need only be stable + non-colliding.
 */
const OPERATOR_AGENT_SENTINEL_ID = `operator:${OPERATOR_SLUG}`;

/** Default per-turn token budget for the operator (mirrors the agent-schema
 *  `max_tokens_per_run` default). The conversation run has no agent row to read
 *  it from, so it is fixed here. */
const OPERATOR_MAX_TOKENS = 10_000;

/**
 * Everything `loadContext`'s conversation branch needs to build a `RunContext`
 * for a conversation run WITHOUT touching the documents/parent/project/token-row
 * lookups. Held in the pending registry, keyed by `runId`.
 */
export interface PendingConversationRun {
  runId: string;
  conversationId: string;
  /** The ephemeral, in-memory operator token (NOT persisted). */
  token: ApiToken;
  /** The agent ∩ caller scope floor — identical to `token.scopes`. */
  callerScopes: string[];
  /** The conversation owner's user id — FK-valid actor for any provenance write. */
  callerUserId: string;
}

/**
 * In-process pending-conversation-run registry. `createConversationRun` inserts;
 * `loadContext` reads + consumes. See the module header for why this carrier.
 * NOT exported as a mutable map — only the typed accessors below are public so a
 * caller can never corrupt the registry shape.
 */
const pending = new Map<string, PendingConversationRun>();

/** loadContext's conversation branch reads this (and consumes it) by run id. */
export function takePendingConversationRun(
  runId: string,
): PendingConversationRun | undefined {
  const entry = pending.get(runId);
  if (entry) pending.delete(runId);
  return entry;
}

/**
 * Test-only: drop a registered pending run without consuming it via loadContext
 * (used by route tests that mock the runner and never reach loadContext, so the
 * registry would otherwise leak across tests). Production code consumes via
 * `takePendingConversationRun` in loadContext.
 */
export function __dropPendingConversationRunForTest(runId: string): void {
  pending.delete(runId);
}

/**
 * Build (and register) a conversation run for `conversation`, authorized as its
 * owner (`conversation.created_by`). Returns the generated `runId` the caller
 * passes to `runAgent({ runId })` (and stamps as the conversation's
 * `active_run_id` via the CAS in the route).
 *
 * The owner's CURRENT role is read fresh (Option A). If the owner can see no
 * projects at all (non-owner with zero grants) the project ceiling is `[]`
 * (deny) — the operator can still read instance-level surfaces its read scopes
 * allow but writes nothing into a project it can't see (caller-bounded).
 */
export async function createConversationRun(
  db: DB,
  input: {
    conversation: { id: string; createdBy: string };
    /** Pre-generated run id — the route generates it for the M14 CAS so the slot
     *  it acquires and the run it kicks share one id. */
    runId: string;
  },
): Promise<{ runId: string }> {
  const { conversation, runId } = input;
  const callerUserId = conversation.createdBy;

  // Fresh per-turn authority derivation (Option A).
  const callerRole = await userRole(db, callerUserId);

  // M1/M2 scope floor: operator capability ∩ caller authority. NEVER just the
  // caller (the operator can't exceed its own tool whitelist) and NEVER just the
  // operator (a viewer's operator can't write).
  const operatorScopes = new Set(toolsToScopes(OPERATOR_TOOLS));
  const scopes = roleToScopes(callerRole).filter((s) => operatorScopes.has(s));

  // Project ceiling. owner → null (no narrowing → operator `['*']` stands);
  // non-owner → the flat union of visible projects across visible workspaces.
  let callerProjectIds: string[] = [];
  if (callerRole !== 'owner') {
    const wsIds = await visibleWorkspaceIds(db, callerUserId);
    const projectIdSet = new Set<string>();
    for (const wsId of wsIds) {
      // Cluster-3 /code-review fix: mirror the canonical agent-runs.ts ceiling.
      // A WORKSPACE-grant holder (canManageWorkspace) can SEE every project in
      // that workspace, so their ceiling there is ALL ws projects — NOT just their
      // direct project_access grants. visibleProjectIds returns only direct grants
      // (its own header warns: call it only AFTER canManageWorkspace is false,
      // else a ws-grant holder wrongly narrows to their direct grants, which may
      // be none). Without this branch, a whole-workspace invitee with no per-project
      // grants got [] = deny-all and their operator could write NOWHERE.
      if (await canManageWorkspace(db, callerUserId, wsId, callerRole)) {
        const wsProjects = await db.query.projects.findMany({
          where: eq(projects.workspaceId, wsId),
          columns: { id: true },
        });
        for (const p of wsProjects) projectIdSet.add(p.id);
      } else {
        for (const pid of await visibleProjectIds(db, callerUserId, wsId)) {
          projectIdSet.add(pid);
        }
      }
    }
    callerProjectIds = [...projectIdSet];
  }
  // callerProjectsFor: owner → null (no narrowing); non-owner → the union list.
  const tokenProjectIds = callerProjectsFor({
    role: callerRole,
    projectIds: callerProjectIds,
  });

  // The operator's own project reach is `['*']`; intersect with the caller's
  // ceiling so the persisted token reach is already agent ∩ caller (mirrors
  // loadContext's narrowedToken fold for document runs). owner → null intersect
  // = `['*']`; non-owner → the union list (or [] = deny).
  const projectIds = intersectAgentProjects(['*'], tokenProjectIds);

  // The EPHEMERAL operator token — constructed in memory, never persisted. The
  // run holds it directly (via the registry → loadContext), so `tokenHash` is a
  // sentinel that is never looked up. `workspaceId: null` = instance reach (the
  // operator is instance-wide); the project ceiling above is the real bound.
  const token: ApiToken = {
    id: `convrun-token:${runId}`,
    workspaceId: null,
    name: `operator-conversation:${conversation.id}`,
    tokenHash: `ephemeral:${nanoid()}`,
    scopes,
    agentId: OPERATOR_AGENT_SENTINEL_ID,
    projectIds: projectIds.includes('*') ? null : projectIds,
    createdBy: callerUserId,
    lastUsedAt: null,
    createdAt: new Date(),
  };

  pending.set(runId, {
    runId,
    conversationId: conversation.id,
    token,
    // callerScopes === token.scopes: the ephemeral token already encodes
    // operator ∩ caller, so the executeTool double-membership check is satisfied
    // when both sides equal the floor.
    callerScopes: scopes,
    callerUserId,
  });

  return { runId };
}

export { OPERATOR_MAX_TOKENS, OPERATOR_AGENT_SENTINEL_ID };
