/**
 * Phase 3 Sub-phase D (Task D-1) — HTTP transport for agent runs.
 *
 * Six verbs across two scope mounts:
 *   - GET  list                  — PROJECT-scoped (pScope); resolveProject +
 *                                  requireResource() already enforced the
 *                                  allow-list upstream.
 *   - GET  single / POST create /
 *     cancel / retry / health    — WORKSPACE-scoped (wScope). A run id is
 *                                  globally unique, so the caller needn't know
 *                                  the project. The id-addressed verbs derive
 *                                  the allow-list inline (same shape as
 *                                  routes/events.ts) and re-scope (mitigation
 *                                  58) on every load.
 *
 * Bound mitigations: 24 (list narrowing), 54 (autonomy gate), 55 (allow-list
 * on parent), 56 (idempotency), 58 (id re-scope → 404), 59 (input-comment
 * ordering), 63 (retry idempotency).
 *
 * The route only CREATES runs (planning rows). The poller (C-10) is what
 * actually executes them — runAgent is NEVER called from here, retry included.
 */

import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { documents, projects } from '../db/schema.ts';
import type { Document, Project, User, Workspace } from '../db/schema.ts';
import { env } from '../env.ts';
import { intersectAgentProjects, resolveAgentProjects } from '../lib/agent-projects.ts';
import type { AgentRunFrontmatter, RunStatus } from '../lib/agent-run-schema.ts';
import { runStatusSchema } from '../lib/agent-run-schema.ts';
import { emitEvent, txWithEvents } from '../lib/events.ts';
import { HTTPError } from '../lib/http.ts';
import { jsonOk } from '../lib/http.ts';
import type { AuthContext } from '../middleware/auth.ts';
import { requireScope } from '../middleware/bearer.ts';
import { type ScopeContext, getProject, getWorkspace } from '../middleware/scope.ts';
import {
  createRun,
  ensureRunsTable,
  getActiveRun,
  getProviderHealth,
  listRuns,
  nextChainId,
  transitionRun,
} from '../services/agent-runs.ts';
import { createComment } from '../services/comments.ts';
import type { AuthorContext } from '../services/comments.ts';

// -----------------------------------------------------------------------------
// Shared helpers (replicated small — mirror routes/comments.ts)
// -----------------------------------------------------------------------------

/** Resolve the author context for the current request (agent bearer vs user). */
async function resolveAuthorContext(
  c: Context<AuthContext & ScopeContext>,
): Promise<AuthorContext> {
  const token = c.get('token');
  const user = c.get('user');
  if (token?.agentId) {
    const agent = await db.query.documents.findFirst({
      where: eq(documents.id, token.agentId),
    });
    if (!agent || agent.type !== 'agent') {
      throw new HTTPError('UNAUTHENTICATED', 'agent for this token no longer exists', 401);
    }
    return { type: 'agent', agentSlug: agent.slug, agentId: token.agentId };
  }
  if (user) return { type: 'user', userId: user.id };
  throw new HTTPError('UNAUTHENTICATED', 'no actor resolved', 401);
}

/** `actor` for emitted events: token.id on bearer, user.id on session. */
function resolveActor(c: Context<AuthContext & ScopeContext>): string {
  const token = c.get('token');
  if (token) return token.id;
  const user = c.get('user');
  if (user) return user.id;
  throw new HTTPError('UNAUTHENTICATED', 'no actor resolved', 401);
}

/**
 * Resolve the calling agent-bound bearer's effective project allow-list.
 * Returns `null` when there is no narrowing (session, human PAT, or wildcard
 * agent). Verbatim shape from routes/events.ts.
 */
async function resolveAgentAllowList(
  c: Context<AuthContext & ScopeContext>,
): Promise<string[] | null> {
  const token = c.get('token') ?? null;
  if (!token?.agentId) return null;
  const agent = await db.query.documents.findFirst({
    where: eq(documents.id, token.agentId),
  });
  if (!agent || agent.type !== 'agent') {
    throw new HTTPError('FORBIDDEN_RESOURCE', 'agent for this token no longer exists', 403);
  }
  const effective = intersectAgentProjects(resolveAgentProjects(agent), token.projectIds ?? null);
  return effective.includes('*') ? null : effective;
}

/**
 * Context-free core of the run re-scope (mitigation 58). Loads an agent_run by
 * id and gates it against a caller's `workspaceId` + project `allowList`. Throws
 * 404 AGENT_RUN_NOT_FOUND on any mismatch — never 403, so cross-tenant existence
 * is not confirmed.
 *
 * D-4 seam — BOTH the HTTP route (via `loadRunScoped`, which derives
 * `{workspaceId, allowList}` from the Hono Context) and the MCP run tools (which
 * derive the same from the bearer token) call this ONE implementation. `null`
 * allowList means no project narrowing (session / human PAT / wildcard agent).
 */
export async function loadRunScopedByToken(
  runId: string,
  scope: { workspaceId: string; allowList: string[] | null },
): Promise<Document> {
  const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  const notFound = () => new HTTPError('AGENT_RUN_NOT_FOUND', `agent_run ${runId} not found`, 404);
  if (!run || run.type !== 'agent_run' || run.workspaceId !== scope.workspaceId) throw notFound();
  if (
    scope.allowList !== null &&
    (run.projectId === null || !scope.allowList.includes(run.projectId))
  ) {
    throw notFound();
  }
  return run;
}

/**
 * Load an agent_run by id and re-scope it (mitigation 58). Derives the
 * `{workspaceId, allowList}` from the Hono Context, then delegates to the
 * context-free `loadRunScopedByToken` so the HTTP route and the MCP tools share
 * one re-scope implementation.
 */
async function loadRunScoped(
  c: Context<AuthContext & ScopeContext>,
  runId: string,
): Promise<Document> {
  const ws = getWorkspace(c);
  const allowList = await resolveAgentAllowList(c);
  return loadRunScopedByToken(runId, { workspaceId: ws.id, allowList });
}

/**
 * Resolve the `actor` User row for createRun: the session user directly, or
 * the human PAT's creator. Agent bearers never reach here as creators (the
 * autonomy gate fires first), but if no user resolves we 400 rather than
 * fabricate provenance — mirrors trigger-matcher's owner resolution.
 */
async function resolveActorUser(c: Context<AuthContext & ScopeContext>): Promise<User> {
  const user = c.get('user');
  if (user) return user;
  // attachToken substitutes the token's creator as `user` for bearer requests,
  // so this branch should be unreachable. Defensive.
  throw new HTTPError('NO_ACTOR_USER', 'no user resolves for this run', 400);
}

/** Resolve a project row by id (404s if gone). */
async function getProjectRow(projectId: string): Promise<Project> {
  const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!row) throw new HTTPError('PARENT_NOT_FOUND', 'project missing', 404);
  return row;
}

/**
 * Shared create tail used by both the POST-create verb and the retry verb (and
 * the seam D-4's `run_agent` / `retry_run` MCP tools will reuse). It performs
 * ONLY the resolve + idempotency + createRun steps both verbs share:
 *
 *   getActiveRun idempotency (m56 / m63) → resolve project row → ensureRunsTable
 *   (own tx) → createRun.
 *
 * It deliberately does NOT include the autonomy gate (m54), the allow-list
 * check (m55), or the input-comment (m59): those are create-verb-specific and
 * ordering-sensitive, so they stay inline at each call site. The caller is
 * responsible for resolving `agent`, `parent`, and `actorUser` first.
 */
export async function createRunForParent(args: {
  workspace: Workspace;
  parent: Document;
  agent: Document;
  actorUser: User;
  firedBy: string;
}): Promise<Document> {
  const { workspace, parent, agent, actorUser, firedBy } = args;

  // Idempotency (m56 on create, m63 on retry). Retry does NOT pass an
  // excludeRunId — see the retry call site for why.
  const active = await getActiveRun({ parentId: parent.id, agentSlug: agent.slug });
  if (active) {
    throw new HTTPError('RUN_ALREADY_ACTIVE', 'a run is already active for this parent', 409);
  }

  if (parent.projectId === null) {
    // Runs are project-scoped (DB CHECK mandates table_id); a parent without
    // a project can't host one.
    throw new HTTPError('PARENT_NOT_FOUND', 'parent has no project', 404);
  }
  const project = await getProjectRow(parent.projectId);

  // Lazy-seed the runs table (own tx), then create the run.
  const runsTable = await db.transaction(async (tx) =>
    ensureRunsTable(tx, { workspaceId: workspace.id, projectId: project.id }),
  );
  const { document } = await createRun({
    workspace,
    project,
    runsTable,
    agent,
    actor: actorUser,
    input: {
      parentDocumentId: parent.id,
      firedBy,
      chainId: nextChainId({ firedBy }),
      triggerId: null,
    },
  });
  return document;
}

// -----------------------------------------------------------------------------
// List router — mounted under pScope (project-scoped).
// -----------------------------------------------------------------------------

export const runsListRoute = new Hono<AuthContext & ScopeContext>();

runsListRoute.get('/', requireScope('documents:read'), async (c) => {
  const project = getProject(c);
  const allowList = await resolveAgentAllowList(c);

  const statusRaw = c.req.query('status');
  const agent = c.req.query('agent');
  const since = c.req.query('since');

  // Validate ?status= against the enum (consistent with how `since` is
  // validated inside listRuns). Unknown value → 422 rather than a silent
  // no-match.
  let status: RunStatus | undefined;
  if (statusRaw !== undefined) {
    const parsed = runStatusSchema.safeParse(statusRaw);
    if (!parsed.success) {
      throw new HTTPError('INVALID_QUERY', `invalid status: ${statusRaw}`, 422);
    }
    status = parsed.data;
  }

  const rows = await listRuns({
    projectId: project.id,
    status,
    agentSlug: agent || undefined,
    since: since || undefined,
    callerAgentProjectsAllowList: allowList ?? undefined,
  });
  return jsonOk(c, rows);
});

// -----------------------------------------------------------------------------
// Workspace router — single / create / cancel / retry (all wScope).
// -----------------------------------------------------------------------------

export const runsRoute = new Hono<AuthContext & ScopeContext>();

// GET /runs/:runId
runsRoute.get('/:runId', requireScope('documents:read'), async (c) => {
  const run = await loadRunScoped(c, c.req.param('runId'));
  return jsonOk(c, run);
});

// POST /runs
runsRoute.post('/', requireScope('agents:write'), async (c) => {
  const ws = getWorkspace(c);

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HTTPError('INVALID_BODY', 'JSON body required', 422);
  }
  const body = json as { agent_slug?: string; parent_slug?: string; input?: string };
  if (!body.agent_slug || !body.parent_slug) {
    throw new HTTPError('INVALID_BODY', 'agent_slug and parent_slug are required', 422);
  }

  // 1. Resolve parent within the workspace.
  const parent = await db.query.documents.findFirst({
    where: and(eq(documents.workspaceId, ws.id), eq(documents.slug, body.parent_slug)),
  });
  if (!parent) {
    throw new HTTPError('PARENT_NOT_FOUND', `parent "${body.parent_slug}" not found`, 404);
  }

  // 2. Autonomy gate (mitigation 54). An agent-bound bearer create is an
  //    agent-ORIGINATED chain hop — gate behind FOLIO_AGENT_CHAINS_ENABLED.
  const token = c.get('token') ?? null;
  const agentOriginated = !!token?.agentId;
  if (agentOriginated && !env.FOLIO_AGENT_CHAINS_ENABLED) {
    const actor = resolveActor(c);
    await txWithEvents(db, async (tx) => {
      await emitEvent(tx, {
        workspaceId: ws.id,
        projectId: parent.projectId ?? null,
        documentId: parent.id,
        kind: 'agent.chain.suppressed',
        actor,
        payload: { agent_slug: body.agent_slug, reason: 'autonomy_gate' },
      });
    });
    throw new HTTPError('AGENT_CHAINS_DISABLED', 'agent-originated chains are disabled', 403);
  }

  // 3. Allow-list (mitigation 55) — parent.projectId must be in the caller's
  //    allowed projects. BEFORE the input comment (mitigation 59 ordering).
  const allowList = await resolveAgentAllowList(c);
  if (allowList !== null && (parent.projectId === null || !allowList.includes(parent.projectId))) {
    throw new HTTPError('FORBIDDEN_RESOURCE', 'not allow-listed for that project', 403);
  }

  // 4. Resolve agent doc.
  const agent = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, ws.id),
      eq(documents.slug, body.agent_slug),
      eq(documents.type, 'agent'),
    ),
  });
  if (!agent) {
    throw new HTTPError('AGENT_NOT_FOUND', `agent "${body.agent_slug}" not found`, 404);
  }

  // 5. Early idempotency check (m56). Duplicated against the backstop inside
  //    createRunForParent ON PURPOSE: this early check governs ORDERING — a
  //    duplicate-active create must 409 BEFORE we side-effect the input comment
  //    (step 6), otherwise a double-click POST leaves a stray comment on the
  //    parent before rejecting. The helper's own check remains the shared
  //    contract backstop (and serves retry, which has no comment side-effect).
  const earlyActive = await getActiveRun({ parentId: parent.id, agentSlug: agent.slug });
  if (earlyActive) {
    throw new HTTPError('RUN_ALREADY_ACTIVE', 'a run is already active for this parent', 409);
  }

  // 6. Optional input comment (mitigation 59) — posted AFTER the early
  //    idempotency gate so a duplicate create never side-effects a comment, and
  //    BEFORE the createRun tail (which owns idempotency m56 + the planning row).
  if (body.input) {
    if (parent.projectId === null) {
      throw new HTTPError('PARENT_NOT_FOUND', 'parent has no project', 404);
    }
    await createComment({
      workspace: ws,
      project: await getProjectRow(parent.projectId),
      parent,
      authorContext: await resolveAuthorContext(c),
      actor: resolveActor(c),
      body: body.input,
    });
  }

  // 7. Idempotency backstop (m56) + resolve project + ensureRunsTable + createRun.
  const actorUser = await resolveActorUser(c);
  const document = await createRunForParent({
    workspace: ws,
    parent,
    agent,
    actorUser,
    firedBy: 'manual',
  });
  return jsonOk(c, { run_id: document.id, status: 'planning' }, 201);
});

// POST /runs/:runId/cancel
runsRoute.post('/:runId/cancel', requireScope('agents:write'), async (c) => {
  const run = await loadRunScoped(c, c.req.param('runId'));
  const status = run.status as RunStatus;
  const actor = resolveActor(c);

  if (status === 'planning' || status === 'awaiting_approval') {
    await transitionRun(run.id, {
      newStatus: 'failed',
      actor,
      errorReason: 'cancelled',
    });
    return jsonOk(c, { run_id: run.id, status: 'failed' });
  }

  if (status === 'running') {
    // Mitigation 44 — ONE cancel path. The comment schema has no `cancel`
    // kind; a post-start `kind=rejection` comment is the runner's in-loop
    // cancel signal (see lib/runner.ts wasCancelled). Post it on the parent;
    // the runner's next loop iteration aborts.
    if (run.parentId === null || run.projectId === null) {
      throw new HTTPError('AGENT_RUN_NOT_FOUND', 'run has no parent', 404);
    }
    const parent = await db.query.documents.findFirst({
      where: eq(documents.id, run.parentId),
    });
    const project = await getProjectRow(run.projectId);
    if (!parent) throw new HTTPError('AGENT_RUN_NOT_FOUND', 'parent missing', 404);
    // A `kind=rejection` comment requires a target_agent (comments.ts). The
    // run's own agent is the target — the runner's `wasCancelled` only filters
    // on kind=rejection (any target), so this satisfies both the comment
    // schema AND the in-loop cancel detector.
    const runAgentSlug = (run.frontmatter as AgentRunFrontmatter).agent_slug;
    await createComment({
      workspace: getWorkspace(c),
      project,
      parent,
      authorContext: await resolveAuthorContext(c),
      actor,
      body: 'Cancellation requested.',
      kind: 'rejection',
      targetAgent: `agent:${runAgentSlug}`,
    });
    return jsonOk(c, { run_id: run.id, status: 'running' });
  }

  // Terminal — no-op.
  return jsonOk(c, { run_id: run.id, status });
});

// POST /runs/:runId/retry
runsRoute.post('/:runId/retry', requireScope('agents:write'), async (c) => {
  const ws = getWorkspace(c);
  const runId = c.req.param('runId');
  const original = await loadRunScoped(c, runId);
  const fm = original.frontmatter as AgentRunFrontmatter;
  const agentSlug = fm.agent_slug;

  if (original.parentId === null || original.projectId === null) {
    throw new HTTPError('AGENT_RUN_NOT_FOUND', 'run has no parent', 404);
  }

  // Re-resolve the original's parent + agent, then delegate to the shared
  // create tail (which runs the m63 idempotency check).
  const parent = await db.query.documents.findFirst({
    where: eq(documents.id, original.parentId),
  });
  if (!parent) {
    throw new HTTPError('AGENT_RUN_NOT_FOUND', 'parent missing', 404);
  }
  const agent = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, ws.id),
      eq(documents.slug, agentSlug),
      eq(documents.type, 'agent'),
    ),
  });
  if (!agent) {
    throw new HTTPError('AGENT_NOT_FOUND', `agent "${agentSlug}" not found`, 404);
  }
  const actorUser = await resolveActorUser(c);

  // m63 — the idempotency check inside createRunForParent intentionally does
  // NOT exclude the original run. A still-active original SHOULD block a retry
  // (409), so do NOT "fix" this by threading an excludeRunId: runId through.
  const document = await createRunForParent({
    workspace: ws,
    parent,
    agent,
    actorUser,
    firedBy: `retry-of:${runId}`,
  });
  return jsonOk(c, { run_id: document.id, status: 'planning' }, 201);
});

// -----------------------------------------------------------------------------
// Provider-health router — wScope.
// -----------------------------------------------------------------------------

export const providerHealthRoute = new Hono<AuthContext & ScopeContext>();

providerHealthRoute.get('/', requireScope('documents:read'), async (c) => {
  const ws = getWorkspace(c);
  const health = await getProviderHealth({ workspaceId: ws.id });
  const mapped = Object.fromEntries(
    Object.entries(health).map(([provider, state]) => [
      provider,
      { status: state.status, consecutiveFailures: state.consecutive_failures },
    ]),
  );
  return jsonOk(c, mapped);
});
