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

import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, type DB } from '../db/client.ts';
import {
  documents,
  statuses,
  tables,
  views,
  workspaces,
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
  providerSchema,
  runErrorReasonSchema,
  runStatusSchema,
  TERMINAL_STATUSES,
  type AgentRunFrontmatter,
  type RunDoneReason,
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
  /**
   * Set ONLY on an approved-plan resume (D-5): the original awaiting_approval
   * run's id. When present it is written to `frontmatter.resume_of`, which the
   * poller (poller.ts) reads to route the claimed planning row to
   * `runAgentResume` instead of `runAgent`. Omitted for fresh runs.
   */
  resumeOf?: string;
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
    // Resume lineage (D-5). Only stamped on an approved-plan resume; the poller
    // routes a planning row with this set to `runAgentResume`. Omitted entirely
    // (not null) for fresh runs so the `.strict()` schema's optional holds.
    ...(input.resumeOf !== undefined ? { resume_of: input.resumeOf } : {}),
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
  /**
   * Optional `frontmatter.done_reason` to persist atomically with the status
   * flip. Folded into the same `json_set` as status/error so the runner's
   * completed transition writes done_reason + status in ONE event-emitting tx
   * (no stranding done_reason on a still-running row). Closed-enum-validated
   * by the caller (runDoneReasonSchema); pass-through here.
   */
  doneReason?: RunDoneReason;
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
  //
  // Mitigation 37 (F2 fix, post-C.1 review) — every → running transition
  // stamps a fresh `worker_started_at`. claimNextPlanningRun is the usual
  // claim path, but direct planning → running (admin force-resume) and
  // awaiting_approval → running (approval-resume in Sub-phase D) ALSO
  // need a timestamp — otherwise `worker_started_at` stays NULL and
  // `recoverOrphanRuns` (predicate `worker_started_at < threshold`)
  // silently skips the row, leaving a phantom in-flight run.
  //
  // R12 evaluation (post-review-of-review): per the state machine at
  // agent-run-schema.ts:101-108, the COALESCE preserve-branch's
  // left-hand side (`json_extract(...worker_started_at)`) is ALWAYS
  // NULL through any production code path today:
  //   - planning → running: createRun inserts planning rows without
  //     worker_started_at; claimNextPlanningRun is the only writer that
  //     stamps it AND atomically transitions in the same UPDATE, so
  //     no observation of a planning row with a non-NULL
  //     worker_started_at is reachable.
  //   - awaiting_approval → running: awaiting_approval is reachable
  //     ONLY from planning (running → awaiting_approval is not in
  //     TRANSITIONS), so the same argument applies recursively.
  //
  // The COALESCE is therefore defense-in-depth for a FUTURE state
  // machine extension — e.g. a Sub-phase D `running → awaiting_approval`
  // pause-for-approval transition that would carry a real claim time
  // through to the resume. The test at agent-runs.test.ts:620-643
  // hand-seeds the precondition to pin the contract for that future
  // change. Removing the COALESCE today would be safe but breaks that
  // forward compatibility pin.
  // done_reason: ONLY touched when supplied (the completed path). When
  // absent, the '$.done_reason' pair is OMITTED from json_set entirely —
  // it is NOT a self-assign no-op. `json_set(fm, '$.done_reason',
  // json_extract(fm, '$.done_reason'))` on a row WITHOUT the key
  // MATERIALIZES `done_reason: null`, which is schema-INVALID:
  // agent-run-schema.ts has `done_reason: runDoneReasonSchema.optional()`
  // under `.strict()` (optional, NOT nullable). failRun / failRunLastResort
  // / rejectRun pass no doneReason and transition rows that never had one,
  // so the self-assign corrupted every failed/rejected run's frontmatter
  // source-of-truth (FIX #4 / commit 1486296 regression). The conditional
  // fragment below leaves the key absent for rows that never had it and
  // preserves the existing value for rows that do, while keeping the
  // completed-path write atomic with the status flip in the single UPDATE.
  const doneReasonPair = args.doneReason
    ? sql`, '$.done_reason', ${args.doneReason}`
    : sql``;

  const nowIsoForRunning = new Date().toISOString();
  const workerStartedAtArg = isTerminal
    ? sql`NULL`
    : to === 'running'
      ? sql`COALESCE(json_extract(${documents.frontmatter}, '$.worker_started_at'), ${nowIsoForRunning})`
      : sql`json_extract(${documents.frontmatter}, '$.worker_started_at')`;

  // UPDATE + event emission must be atomic for durable+bus parity. The
  // service owns the tx boundary via `txWithEvents` — rollback discards
  // both the column write AND the queued bus publish via the scrub path
  // in `lib/events.ts`.
  //
  // F1 fix (post-C.1 review) — the WHERE includes the `from`-status guard
  // as a TOCTOU defense. Without it, two concurrent transitionRun calls
  // both pass `isValidTransition(from, to)` against the same row snapshot
  // and both UPDATE — double-emitting `agent.run.<to>` events. The status
  // predicate makes the UPDATE a no-op for the loser; we detect that via
  // `.returning({id})` returning zero rows and throw INVALID_RUN_TRANSITION
  // (mitigation 43's "loser no-ops" pattern, generalized from the
  // claim-race shape claimNextPlanningRun already uses).
  await txWithEvents(db, async (tx) => {
    const claimed = await tx
      .update(documents)
      .set({
        status: to,
        frontmatter: sql`json_set(
          ${documents.frontmatter},
          '$.status', ${to},
          '$.completed_at', ${completedAt},
          '$.worker_started_at', ${workerStartedAtArg},
          '$.error_reason', ${errorReason ?? null},
          '$.error_detail', ${errorDetail ?? null}${doneReasonPair}
        )`,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, runId), eq(documents.status, from)))
      .returning({ id: documents.id });

    if (claimed.length === 0) {
      // R5 + R6 (post-review-of-review) — distinguish race-loss from
      // genuine state-machine violation:
      //   - Outer throw (line 230-238): isValidTransition returned false
      //     → caller passed an illegal `to` value for this `from`.
      //     Code: `INVALID_RUN_TRANSITION`.
      //   - Inner throw (here): UPDATE WHERE status=`from` affected 0
      //     rows → row's status changed between our read and our
      //     write (TOCTOU race-loser). Code: `RUN_TRANSITION_RACED`.
      //
      // Distinct codes let Sub-phase D approval handlers catch+ignore
      // RUN_TRANSITION_RACED (benign double-click) without masking
      // INVALID_RUN_TRANSITION (real ABI bug).
      //
      // R6 — attach `observedFrom` (the row's actual current status,
      // re-read inside the same tx so the snapshot is consistent with
      // the failed UPDATE). `from` remains the caller's intended-source
      // snapshot. Sentry / log keys can dedup on (code, from, to,
      // observedFrom) for race-loss without conflating with the
      // 4-tuple-with-only-3-fields outer throw.
      const observedRow = await tx.query.documents.findFirst({
        where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
      });
      // Read the COLUMN (not frontmatter.status) — the inner WHERE
      // guard predicates on `documents.status`, so the observed value
      // that caused the 0-rows-affected outcome is whatever's in the
      // column. Under mitigation 40 lockstep both are equal in
      // production, but the column is what matters for the predicate.
      // The `?? undefined` collapse turns null (row gone or status
      // cleared) into undefined so the err.observedFrom field has a
      // single `RunStatus | undefined` shape.
      const observedFrom = (observedRow?.status ?? undefined) as RunStatus | undefined;
      const err = new HTTPError(
        'RUN_TRANSITION_RACED',
        `agent_run ${runId} no longer at status ${from} (raced by another transition; observed ${observedFrom ?? 'gone'})`,
        409,
      ) as HTTPError & { from: RunStatus; to: RunStatus; observedFrom: RunStatus | undefined };
      err.from = from;
      err.to = to;
      err.observedFrom = observedFrom;
      throw err;
    }

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

    // Mitigation 45 — tipping-edge detection. Runs ONLY on terminal
    // transitions because the algorithm reads `agent.run.completed` /
    // `agent.run.failed` events that only emit on terminal transitions
    // (mid-flight running/awaiting_approval aren't degradation signals).
    // Provider source: the run row's snapshotted frontmatter.provider
    // (mitigation 46) — not the agent doc's current provider.
    if (isTerminal) {
      const provider = (row.frontmatter as AgentRunFrontmatter).provider;
      await maybeEmitProviderHealthEdge(tx, {
        workspaceId: row.workspaceId,
        provider,
        actor: args.actor,
      });
    }
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
 *
 * `excludeRunId` (optional) — drop a specific run id from the candidate set.
 * The resume path passes the ORIGINAL run's id here (the row the resuming run
 * is resuming, i.e. `frontmatter.resume_of`): during a resume there are TWO
 * non-terminal rows on the same (parent, agent_slug) — the original
 * `awaiting_approval` row AND the new `running` resuming row — but the original
 * is LINEAGE, not a competing peer, so it must not trip the resume's
 * idempotency check. Excluding it is order-independent (no reliance on
 * created_at tiebreaks). A genuine third peer is still returned.
 */
export async function getActiveRun(
  args: { parentId: string; agentSlug: string; excludeRunId?: string },
  tx: DBOrTx = db,
): Promise<Document | null> {
  const row = await tx.query.documents.findFirst({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, args.parentId),
      inArray(documents.status, [...ACTIVE_RUN_STATUSES]),
      sql`json_extract(${documents.frontmatter}, '$.agent_slug') = ${args.agentSlug}`,
      ...(args.excludeRunId ? [ne(documents.id, args.excludeRunId)] : []),
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
  // Two timestamps from the same instant in two encodings: ISO for the
  // JSON `worker_started_at` field (round-trips through json_set as text),
  // ms-epoch for `documents.updated_at` (declared `integer(...
  // mode:'timestamp_ms')`). Binding the ISO string into an INTEGER column
  // would store it as TEXT due to SQLite affinity, breaking ORDER BY
  // against the Drizzle-written `updatedAt: new Date()` rows.
  const nowMs = Date.now();
  const claimedAtIso = new Date(nowMs).toISOString();
  const rows = await tx.all<{ id: string }>(sql`
    UPDATE documents
       SET frontmatter = json_set(
             frontmatter,
             '$.status', 'running',
             '$.worker_started_at', ${claimedAtIso}
           ),
           status = 'running',
           updated_at = ${nowMs}
     WHERE id = (
       SELECT id FROM documents
        WHERE type = 'agent_run'
          AND status = 'planning'
        ORDER BY created_at ASC
        LIMIT 1
     )
       AND status = 'planning'
     RETURNING id
  `);
  if (rows.length === 0) return null;
  // RETURNING only `id` (cheap, snake_case-vs-camelCase agnostic); the
  // typed Document shape — with Date columns parsed + frontmatter parsed
  // as JSON — comes from the findFirst below. Tightening to RETURNING id
  // (vs RETURNING *) closes the type-lie that prior `tx.all<Document>`
  // typing introduced: the raw row only ever exposes the column we
  // actually read.
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
  // Threshold is an ISO string for lexicographic compare against
  // `worker_started_at` (also stored as ISO inside frontmatter JSON);
  // `nowMs` is the ms-epoch we bind into the INTEGER `updated_at` column.
  // Two encodings for one instant — same pattern as claimNextPlanningRun.
  const nowMs = Date.now();
  const threshold = new Date(nowMs - args.staleThresholdMs).toISOString();
  const completedAtIso = new Date(nowMs).toISOString();

  // Mitigation 39 — closed-enum values sourced from `runErrorReasonSchema.enum`
  // / `runStatusSchema.enum` rather than raw string literals. If a future
  // schema change drops or renames `worker_crash` OR `failed`, these
  // assignments stop compiling and BOTH the SQL writes AND the event
  // payload below break together.
  //
  // R7 fix (post-review-of-review) — the original A1 fix routed only
  // `error_reason` through the enum; `status='failed'` and the
  // matched-source `status='running'` were raw literals. Now the
  // terminal-status name + the running predicate are both compile-time
  // anchored against the Zod enum.
  const errorReason = runErrorReasonSchema.enum.worker_crash;
  const failedStatus = runStatusSchema.enum.failed;
  const runningStatus = runStatusSchema.enum.running;

  return txWithEvents(db, async (tx) => {
    // RETURNING includes the snapshotted provider from the run's
    // frontmatter so F7 can call maybeEmitProviderHealthEdge per
    // distinct (workspace, provider) pair below without re-querying.
    const updated = await tx.all<{
      id: string;
      workspace_id: string;
      project_id: string | null;
      provider: string | null;
    }>(sql`
      UPDATE documents
         SET frontmatter = json_set(
               frontmatter,
               '$.status', ${failedStatus},
               '$.error_reason', ${errorReason},
               '$.worker_started_at', NULL,
               '$.completed_at', ${completedAtIso}
             ),
             status = ${failedStatus},
             updated_at = ${nowMs}
       WHERE type = 'agent_run'
         AND status = ${runningStatus}
         AND json_extract(frontmatter, '$.worker_started_at') < ${threshold}
       RETURNING id, workspace_id, project_id,
                 json_extract(frontmatter, '$.provider') AS provider
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
          from: runningStatus,
          to: failedStatus,
          error_reason: errorReason,
        },
      });
    }

    // F7 fix (post-C.1 review) — fire the tipping-edge detector once
    // per distinct (workspace, provider) pair after recovery. F5
    // already ensures worker_crash events themselves don't influence
    // the computation; the call here exists to FLUSH stale persisted
    // state. Without it, a workspace that tipped degraded earlier
    // could carry that state for hours after the underlying provider
    // failures aged out of the window — until some unrelated
    // transitionRun call triggered a fresh check. Calling per
    // (workspace, provider) means recovery itself surfaces the
    // current truth.
    //
    // R14 evaluation (post-review-of-review) — this only fires when
    // a recovery actually happens (i.e. there were stale running
    // rows). A workspace that's totally idle (no runs, no recoveries)
    // still relies on R4's recency floor to reset state: once all
    // window-eligible events age out, the next ANY-event-driven
    // checkProviderHealth call returns healthy(0) and the edge flips
    // back. For a workspace that's idle on a specific PROVIDER but
    // active on others, F7's recovery flush + transitionRun's
    // terminal-edge call are both sufficient to surface the current
    // truth at the moment activity occurs. Periodic background
    // polling (e.g. C.3 sweeping ALL workspaces every minute) is
    // unnecessary and was rejected as over-engineering.
    const seen = new Set<string>();
    for (const r of updated) {
      if (!r.provider) continue;
      const key = `${r.workspace_id}::${r.provider}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const parsedProvider = providerSchema.safeParse(r.provider);
      if (!parsedProvider.success) continue;
      await maybeEmitProviderHealthEdge(tx, {
        workspaceId: r.workspace_id,
        provider: parsedProvider.data,
        actor: 'system:orphan-recovery',
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
 *
 * R3 fix (post-review-of-review) — predicate is `status = 'planning'` on
 * the indexed COLUMN, not `json_extract(frontmatter, '$.status')`. The
 * partial index `documents_runs_pending_idx (created_at ASC) WHERE
 * type='agent_run' AND status='planning'` requires the column predicate
 * to be planner-eligible. The F6 bundle 1 fix flipped two of the three
 * status read sites (claim + recovery) but missed this one. Once C.2
 * runs the poller every ~1s, the prior JSON predicate forced a full
 * type='agent_run' partition scan with per-row JSON eval. Mitigation 40
 * lockstep makes the values equivalent; only the index hit differs.
 */
export async function countPendingPlanning(tx: DBOrTx = db): Promise<number> {
  const rows = await tx.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM documents
     WHERE type = 'agent_run'
       AND status = 'planning'
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

// ----- provider health (Task C-5) -----

export type ProviderName = 'anthropic' | 'openai' | 'openrouter' | 'ollama';
const ALL_PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'openrouter', 'ollama'];

export interface ProviderHealthState {
  status: 'healthy' | 'degraded';
  consecutive_failures: number;
}

/**
 * Default threshold for degradation. Configurable per call via the
 * `threshold` arg (the poller / runner read `FOLIO_PROVIDER_DEGRADE_THRESHOLD`
 * at their call site). 3 is the spec default — high enough to ride out a
 * single API hiccup, low enough to alert on a real outage within ~3 runs.
 */
const DEFAULT_DEGRADE_THRESHOLD = 3;

/**
 * R4 fix (post-review-of-review) — recency floor for the provider-health
 * window. Events older than this are ignored: an idle workspace can't
 * stay locked in a stale `degraded` state because its window goes
 * empty + the insufficient-signal branch returns healthy. Default 24h
 * matches typical operator expectation ("if there's been no signal in
 * a day, treat the provider as unknown, not historically broken").
 *
 * Without this, the algorithm pre-R4 considered the last N
 * provider-relevant events for ALL TIME. A workspace that had 3
 * provider_errors then stopped using the provider entirely would
 * persist degraded indefinitely. Worse: a subsequent orphan-recovery
 * burst (via F7) would compute next.healthy(0) and emit a SPURIOUS
 * workspace.provider.recovered event sourced from observation gap,
 * not real recovery.
 */
const DEFAULT_PROVIDER_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Walks the workspace's persisted `provider_health` and returns the current
 * state for one provider. Missing keys default to `{healthy, 0}` — a
 * never-seen provider is healthy.
 */
async function getPersistedProviderHealth(
  args: { workspaceId: string; provider: ProviderName },
  tx: DBOrTx = db,
): Promise<ProviderHealthState> {
  const ws = await tx.query.workspaces.findFirst({
    where: eq(workspaces.id, args.workspaceId),
  });
  const state = ws?.providerHealth?.[args.provider];
  return state ?? { status: 'healthy', consecutive_failures: 0 };
}

/**
 * Compares persisted state against derived state (from the most recent N
 * provider-relevant terminal events) and returns both. Returns
 * `{current, next}`. Mitigation 45 — pure read; no side effects, no
 * edge emission. The `maybeEmitProviderHealthEdge` wrapper makes the
 * tipping-edge call.
 *
 * Algorithm (post-F5 fix, post-C.1 review):
 *   1. Fetch the last `threshold` PROVIDER-RELEVANT terminal events for
 *      (workspace, provider). A "provider-relevant" event is either
 *      `agent.run.completed` (positive provider signal) or
 *      `agent.run.failed` with `error_reason='provider_error'` (negative
 *      provider signal). All other error reasons are EXCLUDED at the
 *      SQL layer — they're either local guard hits (budget_exceeded,
 *      chain_*_exceeded, fanout_exceeded, depth_exceeded, rate_limited,
 *      idempotency_violation, no_ai_key), human actions (rejected),
 *      cancellations (cancelled), or infrastructure failures
 *      (worker_crash — from recoverOrphanRuns). None of those say
 *      anything about the provider's health.
 *   2. If fewer than `threshold` provider-relevant events available →
 *      next is healthy (insufficient signal).
 *   3. Walk newest-first counting trailing failures, breaking on a
 *      completed. If trailing count ≥ threshold → degraded with that
 *      count; else healthy.
 *
 * Pre-F5, the SQL excluded ONLY 'cancelled' and the loop broke on any
 * non-provider_error row. That meant a single worker_crash (or any
 * other infra failure) reset a still-degraded provider to healthy and
 * emitted a spurious workspace.provider.recovered event.
 */
export async function checkProviderHealth(
  args: {
    workspaceId: string;
    provider: ProviderName;
    threshold?: number;
    /**
     * R4 — events older than `now() - windowMs` are excluded from the
     * window. Defaults to `DEFAULT_PROVIDER_HEALTH_WINDOW_MS` (24h).
     * The C.3 poller may override per workspace if needed.
     */
    windowMs?: number;
  },
  tx: DBOrTx = db,
): Promise<{ current: ProviderHealthState; next: ProviderHealthState }> {
  const threshold = args.threshold ?? DEFAULT_DEGRADE_THRESHOLD;
  const windowMs = args.windowMs ?? DEFAULT_PROVIDER_HEALTH_WINDOW_MS;
  const cutoffMs = Date.now() - windowMs;
  const current = await getPersistedProviderHealth(
    { workspaceId: args.workspaceId, provider: args.provider },
    tx,
  );

  // events.seq is monotonic per-insert and unique across the workspace —
  // ordering by it newest-first is the canonical "last N" without ties
  // (created_at can collide at the same ms). The JOIN on document_id
  // takes the agent_run row's snapshotted provider (mitigation 46 — not
  // current agent state, the run's recorded provider).
  //
  // F5 filter: only provider-relevant events flow through. A completed
  // event has NULL error_reason → keeps the row. A failed event with
  // error_reason='provider_error' → keeps the row. Anything else
  // (cancelled, worker_crash, budget_exceeded, rate_limited,
  // depth_exceeded, fanout_exceeded, chain_*_exceeded,
  // idempotency_violation, no_ai_key, rejected) → dropped at the SQL
  // layer so the loop counts ONLY provider signals.
  //
  // R4 recency floor (post-review-of-review): `e.created_at >= cutoffMs`
  // drops events older than the window. Without it, an idle workspace
  // would stay degraded forever (last 3 provider_errors from week 1
  // count for all time) AND F7's per-recovery flush could emit a
  // spurious `recovered` based on an empty window (insufficient signal
  // returns healthy(0), edge detector then flips degraded→healthy).
  const rows = await tx.all<{ kind: string; error_reason: string | null }>(sql`
    SELECT e.kind AS kind,
           json_extract(e.payload, '$.error_reason') AS error_reason
      FROM events e
      JOIN documents d ON d.id = e.document_id
     WHERE e.workspace_id = ${args.workspaceId}
       AND e.kind IN ('agent.run.completed', 'agent.run.failed')
       AND e.created_at >= ${cutoffMs}
       AND d.type = 'agent_run'
       AND json_extract(d.frontmatter, '$.provider') = ${args.provider}
       AND (
         e.kind = 'agent.run.completed'
         OR json_extract(e.payload, '$.error_reason') = 'provider_error'
       )
     ORDER BY e.seq DESC
     LIMIT ${threshold}
  `);

  // Insufficient signal — not enough provider-relevant events to assert
  // degradation.
  if (rows.length < threshold) {
    return { current, next: { status: 'healthy', consecutive_failures: 0 } };
  }

  // Count trailing failures (newest-first). Since the SQL filter
  // already excluded non-provider rows, the only way the loop's else
  // branch triggers is an agent.run.completed event (genuine recovery
  // signal). Every other row in `rows` is by construction a
  // provider_error failure.
  //
  // R13 simplify (post-review-of-review) — the SQL filter above
  // guarantees that for any `failed` row in `rows`, `error_reason`
  // equals 'provider_error'. The previous JS condition checked both
  // — over-specified, and risked obscuring the contract: a future
  // "simplification" of the SQL filter could break both layers in one
  // stroke if the JS appeared to defend independently. Checking ONLY
  // `r.kind` makes the SQL→JS contract explicit.
  let trailingFailures = 0;
  for (const r of rows) {
    if (r.kind === 'agent.run.failed') {
      trailingFailures += 1;
    } else {
      // The else branch is reachable only on agent.run.completed —
      // the SQL filter excludes every other failed-but-not-provider
      // shape.
      break;
    }
  }

  const next: ProviderHealthState =
    trailingFailures >= threshold
      ? { status: 'degraded', consecutive_failures: trailingFailures }
      : { status: 'healthy', consecutive_failures: trailingFailures };

  return { current, next };
}

/**
 * Returns the persisted health state for all 4 known providers.
 * Missing keys default to `{healthy, 0}` — symmetric with the missing-key
 * default inside `getPersistedProviderHealth`. Used by the workspace
 * settings UI (Phase 3 D-6) and the runner-stats admin endpoint.
 */
export async function getProviderHealth(
  args: { workspaceId: string },
  tx: DBOrTx = db,
): Promise<Record<ProviderName, ProviderHealthState>> {
  const ws = await tx.query.workspaces.findFirst({
    where: eq(workspaces.id, args.workspaceId),
  });
  const persisted = ws?.providerHealth ?? {};
  return Object.fromEntries(
    ALL_PROVIDERS.map((p) => [
      p,
      persisted[p] ?? { status: 'healthy', consecutive_failures: 0 },
    ]),
  ) as Record<ProviderName, ProviderHealthState>;
}

/**
 * Tipping-edge detector — internal helper called from `transitionRun`
 * AFTER its own `agent.run.<status>` emit. Mitigation 45 — emits exactly
 * one `workspace.provider.degraded` on the healthy→degraded transition,
 * exactly one `workspace.provider.recovered` on the reverse. Continued
 * state (both ends agree) is a no-op.
 *
 * Provider name is the run's frontmatter.provider — mitigation 46. The
 * caller (transitionRun) sources this from the row's frontmatter, not
 * from the current agent doc.
 *
 * Same-tx persistence: the new state is written to workspaces.provider_health
 * inside the caller's `txWithEvents` block, so the column write + the
 * edge event commit (or roll back) atomically with the underlying
 * agent_run UPDATE.
 *
 * Not exported through the barrel — runner / dispatcher reach
 * provider-health state through `checkProviderHealth` and `getProviderHealth`.
 */
async function maybeEmitProviderHealthEdge(
  tx: Parameters<Parameters<DB['transaction']>[0]>[0],
  args: {
    workspaceId: string;
    provider: ProviderName;
    actor: string;
  },
): Promise<void> {
  const { current, next } = await checkProviderHealth(
    { workspaceId: args.workspaceId, provider: args.provider },
    tx,
  );

  // No transition → nothing to do. Covers both "still healthy" AND "still
  // degraded" (4th consecutive failure case from the tests).
  //
  // F11 evaluation (post-C.1 review): the original review claimed
  // consecutive_failures persists at the tipping-edge value and lies
  // about reality. False — checkProviderHealth caps `next.consecutive_failures`
  // at `threshold` via the SQL `LIMIT threshold`, so the persisted
  // value at the edge IS the algorithm's notion of "consecutive
  // failures." Dashboards reading this column should treat it as
  // "trailing failures up to threshold" (operator-readable as
  // "threshold+ consecutive failures") rather than a live counter
  // beyond threshold. Documenting here to lock the interpretation.
  if (current.status === next.status) return;
  await tx.update(workspaces)
    .set({
      providerHealth: sql`json_set(
        ${workspaces.providerHealth},
        ${'$.' + args.provider},
        json(${JSON.stringify(next)})
      )`,
    })
    .where(eq(workspaces.id, args.workspaceId));

  const kind: EventKind = next.status === 'degraded'
    ? 'workspace.provider.degraded'
    : 'workspace.provider.recovered';

  // F4 fix (post-C.1 review) — workspace.provider.* events are
  // WORKSPACE-WIDE per event-bus.ts BUG-021: they MUST emit with
  // `projectId: null` so SSE subscribers filtered to any specific
  // project still receive them. The earlier draft passed the triggering
  // run's projectId; the event-bus filter then dropped the event for
  // every OTHER project's subscriber, leaving sibling projects unaware
  // of the workspace-level provider state flip. No documentId either —
  // there's no single run-row this event points at; it's an aggregate
  // signal computed over the last N runs.
  await emitEvent(tx, {
    kind,
    workspaceId: args.workspaceId,
    projectId: null,
    actor: args.actor,
    payload: {
      provider: args.provider,
      consecutive_failures: next.consecutive_failures,
    },
  });
}

// ----- ensureRunsTable + nextChainId (Task C-6) -----

/**
 * Status rows seeded into a new `runs` table — mirror the agent_run state
 * machine. Categories map to existing status categories so kanban + filter
 * UI render correctly. `failed` and `rejected` use `cancelled` because
 * that's the closest semantic match in the existing enum (the state
 * machine treats both as terminal "did not complete normally").
 */
const RUNS_TABLE_STATUSES = [
  { key: 'planning',          name: 'Planning',          category: 'unstarted' as const, color: '#94a3b8', order: 0  },
  { key: 'awaiting_approval', name: 'Awaiting approval', category: 'unstarted' as const, color: '#f59e0b', order: 10 },
  { key: 'running',           name: 'Running',           category: 'started'   as const, color: '#3b82f6', order: 20 },
  { key: 'completed',         name: 'Completed',         category: 'completed' as const, color: '#10b981', order: 30 },
  { key: 'failed',            name: 'Failed',            category: 'cancelled' as const, color: '#ef4444', order: 40 },
  { key: 'rejected',          name: 'Rejected',          category: 'cancelled' as const, color: '#6b7280', order: 50 },
];

/**
 * View rows for the runs table — three pre-built filters operators will
 * reach for first. All `type='list'` because runs are time-series data
 * that reads naturally as a list, not a kanban.
 */
const RUNS_TABLE_VIEWS: Array<{
  name: string;
  filters: Record<string, unknown>;
  sort: Array<{ key: string; dir: 'asc' | 'desc' }>;
  visibleFields: string[];
  isDefault: boolean;
  order: number;
}> = [
  {
    name: 'All runs',
    filters: { type: { $eq: 'agent_run' } },
    sort: [{ key: 'created_at', dir: 'desc' }],
    visibleFields: ['title', 'status', 'agent_slug', 'provider', 'tokens_in', 'tokens_out', 'completed_at'],
    isDefault: true,
    order: 0,
  },
  {
    name: 'Failures',
    filters: { type: { $eq: 'agent_run' }, status: { $in: ['failed', 'rejected'] } },
    sort: [{ key: 'completed_at', dir: 'desc' }],
    visibleFields: ['title', 'status', 'agent_slug', 'error_reason', 'completed_at'],
    isDefault: false,
    order: 10,
  },
  {
    name: 'Awaiting approval',
    filters: { type: { $eq: 'agent_run' }, status: { $eq: 'awaiting_approval' } },
    sort: [{ key: 'started_at', dir: 'desc' }],
    visibleFields: ['title', 'agent_slug', 'started_at'],
    isDefault: false,
    order: 20,
  },
];

/**
 * Idempotent lazy-seed of a project's `runs` table + 6 statuses + 3 views.
 *
 * Mitigation 23 (verified inherited) — the `tables` row is scoped to
 * `projectId` (FK with `onDelete: cascade`), and the unique index
 * `tables_project_slug_idx (project_id, slug)` enforces "one runs table
 * per project." Status + view rows are scoped to `tableId` (cascade on
 * delete). Workspace scope is inherited via `project.workspace_id` —
 * we don't write workspaceId to tables/statuses/views directly because
 * those tables don't have a workspace_id column; the project FK is the
 * single source of truth for scope.
 *
 * Caller MUST pass a transaction handle. For the lazy-seed-inside-
 * createRun path (Sub-phase C.2), this lets the runs-table insert AND
 * the agent_run row insert commit (or roll back) atomically. Callers
 * that want bus delivery should wrap with `txWithEvents`; bare
 * `db.transaction` publishes inline (per lib/events.ts:130).
 *
 * Emits, on the create path only:
 *   - 1× `table.created`     (row id in payload)
 *   - 6× `status.created`    (one per status row)
 *   - 3× `view.created`      (one per view row)
 *   - 1× `runs_table.lazy_seeded` (the rail-refresh signal — its purpose
 *     is to let project SSE subscribers know a new leaf appeared)
 *
 * On the idempotent path, ZERO events emit. The caller can call this
 * once per run without burning event ids on a no-op.
 */
export async function ensureRunsTable(
  tx: Parameters<Parameters<DB['transaction']>[0]>[0],
  args: { workspaceId: string; projectId: string },
): Promise<TableEntity> {
  // Idempotency check. The unique index on (project_id, slug) means
  // there's at most one row to find; the type predicate is implicit.
  const existing = await tx.query.tables.findFirst({
    where: and(eq(tables.projectId, args.projectId), eq(tables.slug, 'runs')),
  });
  if (existing) return existing;

  // F14 fix (post-C.1 review) — TOCTOU race against the lookup above.
  // Two concurrent callers (Sub-phase C.2 runner instances on parallel
  // first-runs for the same project) could both miss the existing row
  // and both try to insert. The unique index
  // `tables_project_slug_idx (project_id, slug)` would then reject the
  // loser with SQLITE_CONSTRAINT_UNIQUE, rolling back its outer tx.
  //
  // Use `ON CONFLICT DO NOTHING` so the insert is a no-op when a
  // concurrent winner already committed the row. After the insert
  // (or the no-op), re-query the row — both winner and loser end up
  // with the SAME row id, AND the loser doesn't fire the per-status /
  // per-view inserts + 11 events below (the post-INSERT check ensures
  // only the winner's path proceeds).
  const tableId = nanoid();
  await tx
    .insert(tables)
    .values({
      id: tableId,
      projectId: args.projectId,
      slug: 'runs',
      name: 'Runs',
      icon: null,
      // Order 100 so it sorts after work-items (0) and any human-created
      // tables (typically inserted with order 10-50). Lazy-seeded tables
      // are system surfaces, not curated, so they land at the bottom.
      order: 100,
    })
    .onConflictDoNothing({ target: [tables.projectId, tables.slug] });

  // Re-fetch to learn which insert won. If our own attempt succeeded,
  // the row id matches `tableId`; if a concurrent caller raced ahead,
  // we get their id and the rest of this function short-circuits to
  // return without re-seeding statuses/views/events.
  const settled = await tx.query.tables.findFirst({
    where: and(eq(tables.projectId, args.projectId), eq(tables.slug, 'runs')),
  });
  if (!settled) {
    // Should be unreachable — insert with ON CONFLICT DO NOTHING either
    // wrote our row OR found a sibling. Defensive throw vs silently
    // returning undefined.
    throw new Error('ensureRunsTable: post-insert lookup returned null');
  }
  if (settled.id !== tableId) {
    // Lost the race — winner already seeded statuses + views + events.
    // Return their row without re-seeding to keep idempotency
    // (events emitted exactly once per project).
    return settled;
  }
  await emitEvent(tx, {
    kind: 'table.created',
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    documentId: tableId,
    actor: 'system:runs-table-seeder',
    payload: { slug: 'runs', name: 'Runs' },
  });

  for (const s of RUNS_TABLE_STATUSES) {
    const statusId = nanoid();
    await tx.insert(statuses).values({
      id: statusId,
      projectId: args.projectId,
      tableId,
      ...s,
    });
    await emitEvent(tx, {
      kind: 'status.created',
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      documentId: statusId,
      actor: 'system:runs-table-seeder',
      payload: { table_id: tableId, key: s.key, name: s.name },
    });
  }

  for (const v of RUNS_TABLE_VIEWS) {
    const viewId = nanoid();
    await tx.insert(views).values({
      id: viewId,
      projectId: args.projectId,
      tableId,
      name: v.name,
      type: 'list',
      filters: v.filters as unknown,
      sort: v.sort as unknown,
      visibleFields: v.visibleFields,
      isDefault: v.isDefault,
      order: v.order,
    });
    await emitEvent(tx, {
      kind: 'view.created',
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      documentId: viewId,
      actor: 'system:runs-table-seeder',
      payload: { table_id: tableId, name: v.name },
    });
  }

  // Final rail-refresh signal. Subscribers can listen for just this kind
  // (not the 10 sub-events) to know a new project surface is available.
  await emitEvent(tx, {
    kind: 'runs_table.lazy_seeded',
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    documentId: tableId,
    actor: 'system:runs-table-seeder',
    payload: { table_id: tableId, slug: 'runs' },
  });

  // Re-read so callers get the same row shape they'd get from a
  // findFirst (timestamps populated, etc.) — symmetric with the
  // idempotent branch's return.
  const created = await tx.query.tables.findFirst({ where: eq(tables.id, tableId) });
  return created!;
}

/**
 * Strict UUIDv4 shape: `xxxxxxxx-xxxx-4xxx-[8-b]xxx-xxxxxxxxxxxx`.
 * The 3rd group MUST start with `4` (version), and the 4th group MUST
 * start with 8/9/a/b (variant). `crypto.randomUUID()` produces this
 * shape by spec; we use it both to validate extracted ids and to mint
 * fresh ones. Mitigation 29 — no other shapes accepted.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Mint or extract the chain_id for a new run.
 *
 * Two paths:
 *  - `firedBy` matches `chain:<uuid>:...` AND the captured uuid is a
 *    valid UUIDv4 → return the captured uuid (joins the existing chain).
 *  - Anything else → mint fresh via `crypto.randomUUID()`.
 *
 * Mitigation 29 — chain_id format locked. Output is GUARANTEED to satisfy
 * `agent_run_schema.ts`'s `chain_id: z.string().uuid()` validator. A
 * mangled `chain:not-a-uuid:...` does NOT propagate; it falls through to
 * the fresh-mint path so the new run starts its own chain rather than
 * persisting an invalid id that the Zod parse on insert would reject
 * downstream.
 */
export function nextChainId(args: { firedBy: string }): string {
  // Match `chain:<token>:...` where <token> is the captured group.
  // Non-greedy in case the rest of firedBy contains another `:`.
  const match = args.firedBy.match(/^chain:([^:]+):/i);
  if (match) {
    const captured = match[1]!;
    if (UUID_V4_RE.test(captured)) return captured;
    // Fall through — captured token isn't a valid v4. Mint fresh rather
    // than propagate an invalid id (defense for mitigation 29).
  }
  return crypto.randomUUID();
}
