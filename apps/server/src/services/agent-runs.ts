/**
 * Phase 3 Sub-phase C.1 — agent-runs service layer.
 *
 * Public surface: createRun, transitionRun, incrementTokens.
 *
 * Threat-model mitigations bound here:
 *  - 23 — workspace + project scope on agent_run rows (createRun derives both
 *    from the inputs and the agent's allow-list is validated upstream).
 *  - 28 — error_reason comes from the closed `runErrorReasonSchema` enum;
 *    error_detail is whitelist-sanitized through `sanitizeProviderError`.
 *  - 39 — code never builds error_reason from raw string literals; values are
 *    validated via `runErrorReasonSchema.parse()`.
 *  - 40 — `transitionRun` writes status, completed_at, worker_started_at, and
 *    error_{reason,detail} in a SINGLE UPDATE so no intermediate state is
 *    observable (no completed-but-still-claimed window).
 *
 * The runner (Task C-2+) calls these directly; routes (Task C-7) wrap them.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, type DB } from '../db/client.ts';
import {
  documents,
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
} from '../db/schema.ts';

// Drizzle tx and DB share the same query API. Mirrored verbatim from
// `services/comments.ts` so read helpers can be called from inside a tx.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
import { HTTPError } from '../lib/http.ts';
import { emitEvent, txWithEvents, type EventKind } from '../lib/events.ts';
import {
  agentRunFrontmatterSchema,
  isValidTransition,
  runErrorReasonSchema,
  TERMINAL_STATUSES,
  type AgentRunFrontmatter,
  type RunErrorReason,
  type RunStatus,
} from '../lib/agent-run-schema.ts';
import { sanitizeProviderError } from '../lib/ai/sanitize-error.ts';

// ----- createRun -----

export interface CreateRunInput {
  /** The work_item or page the run is targeted at. */
  parentDocumentId: string;
  /** Free-form provenance string ('agent.task.assigned', 'trigger:foo', 'manual', 'retry-of:<id>'). */
  firedBy: string;
  /** Conversation chain id; new chain at top-of-thread, inherited on resume/retry. */
  chainId: string;
  /** Trigger that fired this run, or null for non-trigger origins. */
  triggerId: string | null;
}

export interface CreateRunArgs {
  workspace: Workspace;
  project: Project;
  /**
   * The project's lazy-seeded `runs` table. Required because the DB CHECK
   * constraint on `documents` mandates `table_id IS NOT NULL` for `agent_run`
   * rows. Callers obtain this via `ensureRunsTable` (Task C-6).
   */
  runsTable: TableEntity;
  agent: Document;
  actor: User;
  input: CreateRunInput;
}

export interface CreateRunResult {
  document: Document;
}

/**
 * Slug shape: `<agentSlug>-<isoStrippedColons>-<nanoid(8)>`. The colons in
 * the ISO timestamp are flipped to dashes so the slug doubles as a
 * filesystem-safe filename (markdown export). The 8-char nanoid suffix is
 * what guarantees uniqueness — no need to walk `-N` like generic createDocument.
 */
function generateRunSlug(agentSlug: string, isoTimestamp: string): string {
  const isoStripped = isoTimestamp.replace(/:/g, '-');
  return `${agentSlug}-${isoStripped}-${nanoid(8)}`;
}

export async function createRun(
  args: CreateRunArgs,
): Promise<CreateRunResult> {
  const { workspace, project, runsTable, agent, actor, input } = args;

  // Snapshot provider/model/system_prompt/max_tokens from the agent at
  // run-create time so a later edit of the agent doesn't mutate historical
  // runs (mitigation 23 — the run is its own scope).
  const agentFm = agent.frontmatter as Record<string, unknown>;
  const provider = agentFm.provider as AgentRunFrontmatter['provider'];
  const model = agentFm.model as string;
  const systemPrompt = agentFm.system_prompt as string;
  const maxTokens = agentFm.max_tokens_per_run as number;

  const id = nanoid();
  const startedAt = new Date().toISOString();
  const slug = generateRunSlug(agent.slug, startedAt);

  const runFm: AgentRunFrontmatter = {
    assignee: `agent:${agent.slug}`,
    status: 'planning',
    agent_slug: agent.slug,
    provider,
    model,
    system_prompt: systemPrompt,
    max_tokens: maxTokens,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: input.triggerId,
    chain_id: input.chainId,
    fired_by: input.firedBy,
    started_at: startedAt,
  };

  // Schema-validate before insert so a misconfigured agent (or a future
  // schema drift) is rejected up-front with a usable error instead of a
  // downstream constraint violation. `.strict()` rejects extra keys.
  const parsed = agentRunFrontmatterSchema.parse(runFm);

  const row = {
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: runsTable.id,
    type: 'agent_run' as const,
    slug,
    title: `${agent.slug} run ${startedAt}`,
    status: parsed.status,
    body: '',
    frontmatter: parsed as unknown as Record<string, unknown>,
    parentId: input.parentDocumentId,
    createdBy: actor.id,
    updatedBy: actor.id,
  };

  // Insert + event emission must be atomic for durable+bus parity. The
  // service owns the tx boundary via `txWithEvents` — rollback discards
  // both the row AND the queued bus publish via the scrub path in
  // `lib/events.ts`.
  await txWithEvents(db, async (tx) => {
    await tx.insert(documents).values(row);
    await emitEvent(tx, {
      workspaceId: workspace.id,
      projectId: project.id,
      documentId: id,
      kind: 'agent.run.started',
      actor: actor.id,
      payload: {
        slug,
        agent: agent.slug,
        chain_id: input.chainId,
        fired_by: input.firedBy,
        trigger_id: input.triggerId,
      },
    });
  });

  // Re-read so callers get the full DB-side row shape (timestamps, default
  // columns) instead of the in-memory pre-insert shape.
  const inserted = await db.query.documents.findFirst({
    where: eq(documents.id, id),
  });
  return { document: inserted! };
}

// ----- transitionRun -----

export interface TransitionRunArgs {
  newStatus: RunStatus;
  /**
   * Identity that performed the transition. Written to documents.updatedBy
   * AND the emitted event's `actor` field so callers (polling worker,
   * approver, admin force-fail) record provenance accurately. Required —
   * no default — so the caller cannot accidentally lose identity.
   */
  actor: string;
  /** ISO timestamp; defaults to "now" when transitioning to a terminal state. */
  completedAt?: string;
  errorReason?: RunErrorReason;
  errorDetail?: string;
}

/**
 * State-machine guard + atomic write of status, completed_at,
 * worker_started_at clear, and sanitized error fields. Emits
 * `agent.run.<newStatus>` in the same tx. Callers MUST wrap with
 * `txWithEvents(db, async (tx) => ...)` so the bus publish is deferred to
 * commit (and scrubbed on rollback).
 *
 * Errors:
 *  - 404 AGENT_RUN_NOT_FOUND when the row doesn't exist.
 *  - 409 INVALID_RUN_TRANSITION (with `.from` / `.to` props on the thrown
 *    HTTPError) on illegal moves. Callers in the approval-race (mitigation
 *    43) catch this and no-op.
 */
export async function transitionRun(
  runId: string,
  args: TransitionRunArgs,
): Promise<Document> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  if (!row) {
    throw new HTTPError(
      'AGENT_RUN_NOT_FOUND',
      `agent_run ${runId} not found`,
      404,
    );
  }

  const fm = row.frontmatter as AgentRunFrontmatter;
  const from = fm.status;
  const to = args.newStatus;

  if (!isValidTransition(from, to)) {
    const err = new HTTPError(
      'INVALID_RUN_TRANSITION',
      `invalid run transition ${from} -> ${to}`,
      409,
    ) as HTTPError & { from: RunStatus; to: RunStatus };
    err.from = from;
    err.to = to;
    throw err;
  }

  // Closed-enum validation. Throws ZodError on unknown values (mitigation 39 —
  // no raw string literals at any caller, since the value comes back through
  // this parser before persistence).
  const errorReason = args.errorReason
    ? runErrorReasonSchema.parse(args.errorReason)
    : undefined;

  // Mitigation 28 — sanitizeProviderError is whitelist-based: it ignores the
  // input err's string body and returns a fixed message based on `.status`.
  // Passing a free-form string yields "Network error or unreachable host." —
  // attacker-supplied apiKey/baseUrl fragments cannot survive into the
  // persisted error_detail. Provider name comes from the run row's snapshot.
  const errorDetail = args.errorDetail !== undefined
    ? sanitizeProviderError(args.errorDetail, fm.provider)
    : undefined;

  const isTerminal = (TERMINAL_STATUSES as readonly RunStatus[]).includes(to);
  const completedAt = isTerminal
    ? (args.completedAt ?? new Date().toISOString())
    : null;

  // Mitigation 40 — ONE UPDATE that flips status (column + frontmatter
  // lockstep), sets completed_at, clears worker_started_at on terminal, and
  // writes error_{reason,detail}. No intermediate state observable to a
  // concurrent reader. The `json_set` keeps non-touched frontmatter keys
  // intact (e.g. tokens_in/out continue to accumulate even mid-transition).
  const workerStartedAtArg = isTerminal
    ? sql`NULL`
    : sql`json_extract(${documents.frontmatter}, '$.worker_started_at')`;

  // UPDATE + event emission must be atomic for durable+bus parity. The
  // service owns the tx boundary via `txWithEvents` — rollback discards
  // both the column write AND the queued bus publish via the scrub path
  // in `lib/events.ts`.
  await txWithEvents(db, async (tx) => {
    await tx
      .update(documents)
      .set({
        status: to,
        frontmatter: sql`json_set(
          ${documents.frontmatter},
          '$.status', ${to},
          '$.completed_at', ${completedAt},
          '$.worker_started_at', ${workerStartedAtArg},
          '$.error_reason', ${errorReason ?? null},
          '$.error_detail', ${errorDetail ?? null}
        )`,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, runId));

    await emitEvent(tx, {
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      documentId: row.id,
      kind: `agent.run.${to}` as EventKind,
      actor: args.actor,
      payload: {
        from,
        to,
        error_reason: errorReason ?? null,
      },
    });
  });

  const updated = await db.query.documents.findFirst({
    where: eq(documents.id, runId),
  });
  return updated!;
}

// ----- incrementTokens -----

/**
 * Atomic JSON-patch increment of `frontmatter.tokens_in/out`. Two concurrent
 * callers can't lose updates (mitigation 39 — read-modify-write race) because
 * the read + write happen inside one SQL statement. COALESCE handles
 * legacy/old-shape rows missing the keys.
 *
 * Per `[[falsy-zero-bug-class]]`: calling with `{in:0, out:0}` is allowed —
 * the UPDATE still runs (json_set is a no-op delta) and the returned totals
 * reflect the (unchanged) row state.
 *
 * Single-statement UPDATE; no events emitted, so no `txWithEvents` wrap
 * needed. Drizzle's `db.update(...)` and `tx.update(...)` share the API.
 */
export async function incrementTokens(
  runId: string,
  args: { in: number; out: number },
): Promise<{ tokens_in: number; tokens_out: number }> {
  await db
    .update(documents)
    .set({
      frontmatter: sql`json_set(
        ${documents.frontmatter},
        '$.tokens_in',  COALESCE(json_extract(${documents.frontmatter}, '$.tokens_in'),  0) + ${args.in},
        '$.tokens_out', COALESCE(json_extract(${documents.frontmatter}, '$.tokens_out'), 0) + ${args.out}
      )`,
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, runId), eq(documents.type, 'agent_run')));

  // Read-back MUST also filter by type='agent_run'. The UPDATE above no-ops on
  // non-run rows, but without the type guard here the read would return the
  // wrong row (e.g. a work_item with a colliding id) and the NOT_FOUND throw
  // would never fire. Symmetric with transitionRun's row lookup.
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  if (!row) {
    throw new HTTPError(
      'AGENT_RUN_NOT_FOUND',
      `agent_run ${runId} not found`,
      404,
    );
  }
  const fm = row.frontmatter as Record<string, unknown>;
  const tokensIn = typeof fm.tokens_in === 'number' ? fm.tokens_in : 0;
  const tokensOut = typeof fm.tokens_out === 'number' ? fm.tokens_out : 0;
  return { tokens_in: tokensIn, tokens_out: tokensOut };
}

// ----- read helpers (getActiveRun, getPendingApprovalRun, listRuns) -----
//
// Read-only — no event emission. Accept an optional `tx: DBOrTx = db` so
// internal callers from inside a transaction (e.g. the runner about to claim
// or transition a run) can pass their tx handle for read-your-writes
// consistency. Same pattern as `comments.ts:loadWorkspaceAgents`.

/** Non-terminal statuses — what `getActiveRun` considers "active". */
const ACTIVE_RUN_STATUSES = ['planning', 'awaiting_approval', 'running'] as const;

/**
 * Most recent non-terminal agent_run row for a given (parent, agent_slug).
 *
 * Storage shape (per C-1 createRun):
 *  - `documents.parentId` column holds the parent work_item/page id.
 *  - `documents.status` column mirrors `frontmatter.status` in lockstep
 *    (mitigation 40 — set in a single UPDATE).
 *  - `frontmatter.agent_slug` holds the agent slug.
 *
 * Mitigation 23 — the parent_id boundary IS the workspace+project boundary
 * because the parent row is already scope-checked by upstream document
 * routes (the documents-list path scope-check covers `type='agent_run'`).
 * Therefore predicating on `parentId` is sufficient and avoids the planner
 * picking a different index than we expect.
 *
 * Index hit (EXPLAIN-verified): `documents_runs_by_parent_idx` on
 * `(parent_id, created_at DESC) WHERE type='agent_run'` covers
 * `WHERE type='agent_run' AND parent_id = ? ORDER BY created_at DESC`.
 * Status + agent_slug predicates are residual filters on the candidate set.
 */
export async function getActiveRun(
  args: { parentId: string; agentSlug: string },
  tx: DBOrTx = db,
): Promise<Document | null> {
  const row = await tx.query.documents.findFirst({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, args.parentId),
      inArray(documents.status, [...ACTIVE_RUN_STATUSES]),
      sql`json_extract(${documents.frontmatter}, '$.agent_slug') = ${args.agentSlug}`,
    ),
    orderBy: [desc(documents.createdAt)],
  });
  return row ?? null;
}

/**
 * The single `awaiting_approval` agent_run row for a (parent, agent_slug),
 * if any. Used by the approval-resume code path (Sub-phase D).
 *
 * Same storage + scope conventions as getActiveRun.
 */
export async function getPendingApprovalRun(
  args: { parentId: string; agentSlug: string },
  tx: DBOrTx = db,
): Promise<Document | null> {
  const row = await tx.query.documents.findFirst({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, args.parentId),
      eq(documents.status, 'awaiting_approval'),
      sql`json_extract(${documents.frontmatter}, '$.agent_slug') = ${args.agentSlug}`,
    ),
    orderBy: [desc(documents.createdAt)],
  });
  return row ?? null;
}

/**
 * Filterable list of agent_run rows.
 *
 * Mitigation 24 — `callerAgentProjectsAllowList` narrows results to rows in
 * the caller's allowed projects when the caller is a project-narrowed
 * agent-bound bearer. Semantics:
 *  - `undefined` → no narrowing (admin / non-agent caller).
 *  - `['*']`     → no narrowing (agent has wildcard allow-list).
 *  - `[]`        → SHORT-CIRCUIT, return empty array. SQLite's
 *                  `WHERE projectId IN ()` is a parse error, so we never
 *                  issue the query. This is also the desired semantics: an
 *                  agent with no allowed projects sees no runs.
 *  - `[a, b]`    → narrow `documents.projectId` to that allow-list.
 */
export interface ListRunsFilter {
  workspaceId?: string;
  projectId?: string;
  parentId?: string;
  agentSlug?: string;
  status?: RunStatus;
  chainId?: string;
  /** ISO timestamp — returns rows with `started_at >= since`. */
  since?: string;
  /**
   * Project ids the calling bearer is allowed to read runs from. See
   * mitigation 24 semantics above.
   */
  callerAgentProjectsAllowList?: string[];
}

export async function listRuns(
  filter: ListRunsFilter,
  tx: DBOrTx = db,
): Promise<Document[]> {
  // Mitigation 24 short-circuit — never issue `WHERE IN ()`.
  if (
    filter.callerAgentProjectsAllowList !== undefined &&
    !filter.callerAgentProjectsAllowList.includes('*') &&
    filter.callerAgentProjectsAllowList.length === 0
  ) {
    return [];
  }

  const whereClauses = [eq(documents.type, 'agent_run')];

  if (filter.workspaceId !== undefined) {
    whereClauses.push(eq(documents.workspaceId, filter.workspaceId));
  }
  if (filter.projectId !== undefined) {
    whereClauses.push(eq(documents.projectId, filter.projectId));
  }
  if (filter.parentId !== undefined) {
    whereClauses.push(eq(documents.parentId, filter.parentId));
  }
  if (filter.status !== undefined) {
    whereClauses.push(eq(documents.status, filter.status));
  }
  if (filter.agentSlug !== undefined) {
    whereClauses.push(
      sql`json_extract(${documents.frontmatter}, '$.agent_slug') = ${filter.agentSlug}`,
    );
  }
  if (filter.chainId !== undefined) {
    whereClauses.push(
      sql`json_extract(${documents.frontmatter}, '$.chain_id') = ${filter.chainId}`,
    );
  }
  if (filter.since !== undefined) {
    // `started_at` is the frontmatter timestamp the run was created at; we
    // filter on the column-backed `createdAt` because it's index-friendly
    // and is set to the same moment by createRun (both come from the same
    // `new Date()` call in the same transaction).
    //
    // Invalid `since` used to silently fall through (no filter applied), so a
    // polling worker that passed a bad ISO got the FULL list back and would
    // re-process every historical row. Mirrors `listComments` (services/
    // comments.ts) — surface clearly so the caller fixes the input.
    const ts = new Date(filter.since);
    if (Number.isNaN(ts.getTime())) {
      throw new HTTPError(
        'INVALID_QUERY',
        `invalid since timestamp: ${filter.since}`,
        422,
      );
    }
    whereClauses.push(gte(documents.createdAt, ts));
  }

  // Mitigation 24 allow-list narrowing. The short-circuit above already
  // handled `[]`; here we narrow only when the list is non-empty AND does
  // not contain the wildcard.
  if (
    filter.callerAgentProjectsAllowList !== undefined &&
    !filter.callerAgentProjectsAllowList.includes('*')
  ) {
    whereClauses.push(inArray(documents.projectId, filter.callerAgentProjectsAllowList));
  }

  const rows = await tx.query.documents.findMany({
    where: and(...whereClauses),
    orderBy: [desc(documents.createdAt)],
  });
  return rows;
}
