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

// ----- claim + orphan recovery + count (Task C-3) -----

/**
 * Atomically claim the oldest `planning` agent_run row and flip it to
 * `running` + stamp `worker_started_at`. Returns the claimed row, or null
 * when no planning rows exist.
 *
 * Mitigation 36 — exactly-once claim under SQLite's transaction semantics.
 * The atomicity hinges on a SINGLE UPDATE statement combining:
 *   - inner SELECT that picks the oldest planning row
 *   - outer UPDATE that re-checks `frontmatter.status = 'planning'` so
 *     between the SELECT and the UPDATE another claimer's commit can't
 *     race in and re-claim the same row.
 *   - RETURNING * yields 1 row when this caller claimed it, 0 rows when
 *     a concurrent claimer beat us — drives the race-test invariant.
 *
 * Caller MUST pass a transaction handle (not the bare `db`). The poller
 * (C-10) chains claim + preflight + transitionRun inside ONE tx so a
 * process crash mid-preflight leaves NO orphaned `running` row.
 *
 * No event emission: the runner emits `agent.run.running` AFTER preflight
 * succeeds (C-8). Claim alone is not yet a state worth broadcasting.
 */
export async function claimNextPlanningRun(tx: DBOrTx): Promise<Document | null> {
  const claimedAt = new Date().toISOString();
  const rows = await tx.all<Document>(sql`
    UPDATE documents
       SET frontmatter = json_set(
             frontmatter,
             '$.status', 'running',
             '$.worker_started_at', ${claimedAt}
           ),
           status = 'running',
           updated_at = ${claimedAt}
     WHERE id = (
       SELECT id FROM documents
        WHERE type = 'agent_run'
          AND json_extract(frontmatter, '$.status') = 'planning'
        ORDER BY created_at ASC
        LIMIT 1
     )
       AND json_extract(frontmatter, '$.status') = 'planning'
     RETURNING *
  `);
  if (rows.length === 0) return null;
  // Re-read via the typed query so callers get the same row shape as the
  // other helpers (Date columns parsed, frontmatter typed as JSON, etc.) —
  // RETURNING * yields raw SQLite columns.
  const raw = rows[0]!;
  const row = await tx.query.documents.findFirst({
    where: eq(documents.id, raw.id),
  });
  return row ?? null;
}

/**
 * Recover orphaned `running` agent_run rows whose worker_started_at is
 * older than `staleThresholdMs`. Transitions them to `failed` with
 * `error_reason = 'worker_crash'`, clears `worker_started_at`, sets
 * `completed_at`, and emits one `agent.run.failed` per row.
 *
 * Mitigation 37 — recovery is bounded by TWO predicates:
 *  - `status = 'running'` so a row that has ALREADY transitioned (e.g. to
 *    completed) won't be incorrectly re-failed.
 *  - `worker_started_at < threshold` so genuinely-active runners aren't
 *    interrupted mid-stream.
 *
 * Owns its own tx via `txWithEvents` so the row UPDATE and the bus
 * publishes commit (or roll back) together. Same shape as `transitionRun`
 * (Task C-1) — callers do not pass a tx.
 *
 * Returns the ids of the recovered runs (empty array when none).
 */
export async function recoverOrphanRuns(
  args: { staleThresholdMs: number },
): Promise<string[]> {
  const threshold = new Date(Date.now() - args.staleThresholdMs).toISOString();
  const completedAt = new Date().toISOString();

  return txWithEvents(db, async (tx) => {
    const updated = await tx.all<{ id: string; workspace_id: string; project_id: string | null }>(sql`
      UPDATE documents
         SET frontmatter = json_set(
               frontmatter,
               '$.status', 'failed',
               '$.error_reason', 'worker_crash',
               '$.worker_started_at', NULL,
               '$.completed_at', ${completedAt}
             ),
             status = 'failed',
             updated_at = ${completedAt}
       WHERE type = 'agent_run'
         AND json_extract(frontmatter, '$.status') = 'running'
         AND json_extract(frontmatter, '$.worker_started_at') < ${threshold}
       RETURNING id, workspace_id, project_id
    `);

    for (const r of updated) {
      await emitEvent(tx, {
        kind: 'agent.run.failed',
        workspaceId: r.workspace_id,
        projectId: r.project_id,
        documentId: r.id,
        // Recovery runs as the system — no user actor available. The
        // emitted event's `actor` field carries the provenance so the
        // operator can grep `actor:system` for forced recoveries.
        actor: 'system:orphan-recovery',
        payload: {
          from: 'running',
          to: 'failed',
          error_reason: 'worker_crash',
        },
      });
    }

    return updated.map((r) => r.id);
  });
}

/**
 * COUNT(*) of `agent_run` rows at status='planning'. Used by the poller
 * to decide whether to bother with a claim attempt (cheap pre-check) and
 * by the admin runner-stats endpoint (D-6).
 *
 * Single-statement SELECT; accepts a tx for read-your-writes consistency
 * inside the poller's claim tx, defaults to `db` for external callers.
 */
export async function countPendingPlanning(tx: DBOrTx = db): Promise<number> {
  const rows = await tx.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM documents
     WHERE type = 'agent_run'
       AND json_extract(frontmatter, '$.status') = 'planning'
  `);
  return rows[0]?.count ?? 0;
}

// ----- rate limits + chain guards (Task C-4) -----

/**
 * Result shape for both rate-limit + chain-guard checks. `reason: null`
 * means OK; a non-null reason means the caller should NOT proceed.
 */
export type GuardResult =
  | { ok: true; reason: null }
  | { ok: false; reason: 'rate_limited'; detail: string }
  | {
      ok: false;
      reason: 'fanout_exceeded' | 'chain_duration_exceeded' | 'chain_tokens_exceeded';
      detail: string;
    };

export interface CheckRunRateLimitsArgs {
  workspaceId: string;
  agentSlug: string;
  /** Hourly cap across the whole workspace, all agents. */
  workspaceMaxRunsPerHour: number;
  /** Hourly cap for THIS agent slug in this workspace. */
  agentMaxRunsPerHour: number;
}

/**
 * Counts `agent.run.started` events in the last hour for (workspace) AND
 * (workspace, agent_slug). Compares against the caller-supplied caps; the
 * caller (poller in C-10) sources defaults from env vars
 * `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE` / `_PER_AGENT`.
 *
 * Mitigation 30 — per-workspace + per-agent hourly cap, checked BEFORE
 * `claimNextPlanningRun`. A workspace at cap doesn't even claim the row;
 * the row stays `planning` for the next poller tick.
 *
 * Ordering: workspace failure is reported BEFORE agent failure when both
 * caps are hit. Deterministic so the operator sees the highest-blast-radius
 * cause first.
 *
 * The query reads `events.kind = 'agent.run.started'` + matches the
 * agent slug from `payload.agent` (set in C-1 createRun's emission).
 *
 * Read-only — defaults `tx` to bare `db`. The poller passes its own tx
 * for read-your-writes inside the claim transaction.
 */
export async function checkRunRateLimits(
  args: CheckRunRateLimitsArgs,
  tx: DBOrTx = db,
): Promise<GuardResult> {
  // events.created_at is stored as ms epoch (INTEGER, timestamp_ms mode).
  // bun:sqlite refuses Date objects as bound parameters — pass a number.
  const hourAgoMs = Date.now() - 60 * 60_000;

  const workspaceRows = await tx.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM events
     WHERE kind = 'agent.run.started'
       AND workspace_id = ${args.workspaceId}
       AND created_at >= ${hourAgoMs}
  `);
  const workspaceCount = workspaceRows[0]?.count ?? 0;

  if (workspaceCount >= args.workspaceMaxRunsPerHour) {
    return {
      ok: false,
      reason: 'rate_limited',
      detail: `workspace cap ${args.workspaceMaxRunsPerHour}/hour exceeded (${workspaceCount} observed)`,
    };
  }

  const agentRows = await tx.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM events
     WHERE kind = 'agent.run.started'
       AND workspace_id = ${args.workspaceId}
       AND created_at >= ${hourAgoMs}
       AND json_extract(payload, '$.agent') = ${args.agentSlug}
  `);
  const agentCount = agentRows[0]?.count ?? 0;

  if (agentCount >= args.agentMaxRunsPerHour) {
    return {
      ok: false,
      reason: 'rate_limited',
      detail: `agent cap ${args.agentMaxRunsPerHour}/hour exceeded (${agentCount} observed)`,
    };
  }

  return { ok: true, reason: null };
}

export interface CheckChainGuardsArgs {
  chainId: string;
  maxFanout: number;
  maxChainDurationMs: number;
  maxChainTokens: number;
}

/**
 * Single SELECT aggregating fanout (COUNT), chain wall-time
 * (max(completed_at) - min(started_at)), and total tokens (SUM of
 * tokens_in + tokens_out) for one chain. Returns the FIRST-failing cap
 * in deterministic order: fanout → duration → tokens. Returns
 * `{reason: null}` when all are under cap.
 *
 * Mitigation 29 — chain fan-out cap. The aggregating query rides
 * `documents_runs_by_chain_idx` (partial index on
 * `(json_extract(frontmatter, '$.chain_id'), created_at DESC) WHERE
 * type='agent_run'`) which scales to chains across millions of total
 * rows. The volume test in `agent-runs.test.ts` asserts EXPLAIN QUERY
 * PLAN names this index so a future planner regression that drops it
 * surfaces in CI, not production.
 *
 * Non-completed rows (no `completed_at`) contribute their `started_at`
 * to the MAX expression via COALESCE — the chain's wall-time treats an
 * in-flight run as "completing now."
 *
 * Read-only — defaults `tx` to bare `db`. Poller (C-10) and runner
 * (C-8) pass their tx for read-consistency.
 */
export async function checkChainGuards(
  args: CheckChainGuardsArgs,
  tx: DBOrTx = db,
): Promise<GuardResult> {
  const rows = await tx.all<{
    fanout: number;
    first_started: string | null;
    last_completed: string | null;
    tokens_total: number;
  }>(sql`
    SELECT COUNT(*) AS fanout,
           MIN(json_extract(frontmatter, '$.started_at')) AS first_started,
           MAX(
             COALESCE(
               json_extract(frontmatter, '$.completed_at'),
               json_extract(frontmatter, '$.started_at')
             )
           ) AS last_completed,
           COALESCE(SUM(
             COALESCE(json_extract(frontmatter, '$.tokens_in'),  0) +
             COALESCE(json_extract(frontmatter, '$.tokens_out'), 0)
           ), 0) AS tokens_total
      FROM documents
     WHERE type = 'agent_run'
       AND json_extract(frontmatter, '$.chain_id') = ${args.chainId}
  `);

  const row = rows[0];
  const fanout = row?.fanout ?? 0;
  const tokensTotal = row?.tokens_total ?? 0;

  // Fanout first — highest-blast-radius signal; an exploding chain is
  // the canonical worst-case attack on the runner queue.
  if (fanout > args.maxFanout) {
    return {
      ok: false,
      reason: 'fanout_exceeded',
      detail: `chain has ${fanout} runs, cap ${args.maxFanout}`,
    };
  }

  // Duration second — only meaningful when both ends are populated.
  // Date.parse on an ISO string returns NaN on bad input; we guard but
  // a bad timestamp here implies a corrupt agent_run row that other
  // paths (Zod schema, createRun) would have already caught.
  if (row?.first_started && row.last_completed) {
    const firstMs = Date.parse(row.first_started);
    const lastMs = Date.parse(row.last_completed);
    if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
      const durationMs = lastMs - firstMs;
      if (durationMs > args.maxChainDurationMs) {
        return {
          ok: false,
          reason: 'chain_duration_exceeded',
          detail: `chain wall-time ${durationMs}ms, cap ${args.maxChainDurationMs}ms`,
        };
      }
    }
  }

  if (tokensTotal > args.maxChainTokens) {
    return {
      ok: false,
      reason: 'chain_tokens_exceeded',
      detail: `chain total ${tokensTotal} tokens, cap ${args.maxChainTokens}`,
    };
  }

  return { ok: true, reason: null };
}
