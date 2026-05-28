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

import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import {
  documents,
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
} from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import { emitEvent, type EventKind } from '../lib/events.ts';
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

// Drizzle tx and DB share the same query API; one shape works for both.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

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
  txOrDb: DBOrTx,
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

  // Use the caller's tx if they passed one; otherwise open one ourselves so
  // the insert + event emission are atomic (mitigation: durable+bus parity).
  await runInTx(txOrDb, async (tx) => {
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
  const inserted = await txOrDb.query.documents.findFirst({
    where: eq(documents.id, id),
  });
  return { document: inserted! };
}

// ----- transitionRun -----

export interface TransitionRunArgs {
  newStatus: RunStatus;
  /** ISO timestamp; defaults to "now" when transitioning to a terminal state. */
  completedAt?: string;
  errorReason?: RunErrorReason;
  errorDetail?: string;
}

/**
 * State-machine guard + atomic write of status, completed_at,
 * worker_started_at clear, and sanitized error fields. Emits
 * `agent.run.<newStatus>` in the same tx (subject to txWithEvents semantics
 * at the caller; passing `db` is fine for inline publish).
 *
 * Errors:
 *  - 404 AGENT_RUN_NOT_FOUND when the row doesn't exist.
 *  - 409 INVALID_RUN_TRANSITION (with `.from` / `.to` props on the thrown
 *    HTTPError) on illegal moves. Callers in the approval-race (mitigation
 *    43) catch this and no-op.
 */
export async function transitionRun(
  txOrDb: DBOrTx,
  runId: string,
  args: TransitionRunArgs,
): Promise<Document> {
  const row = await txOrDb.query.documents.findFirst({
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

  await runInTx(txOrDb, async (tx) => {
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
        updatedBy: row.updatedBy,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, runId));

    await emitEvent(tx, {
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      documentId: row.id,
      kind: `agent.run.${to}` as EventKind,
      actor: row.updatedBy ?? row.createdBy ?? 'system',
      payload: {
        from,
        to,
        error_reason: errorReason ?? null,
      },
    });
  });

  const updated = await txOrDb.query.documents.findFirst({
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
 */
export async function incrementTokens(
  txOrDb: DBOrTx,
  runId: string,
  args: { in: number; out: number },
): Promise<{ tokens_in: number; tokens_out: number }> {
  await txOrDb
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

  const row = await txOrDb.query.documents.findFirst({
    where: eq(documents.id, runId),
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

// ----- helpers (private) -----

/**
 * Run `fn` inside a transaction. If the caller already passed a tx (the
 * Drizzle tx handle has no `.transaction` method matching DB's signature
 * in practice), run inline. Otherwise open a fresh tx. This lets callers
 * compose multiple service calls into one tx while preserving atomicity
 * for direct callers.
 */
async function runInTx(
  txOrDb: DBOrTx,
  fn: (tx: Parameters<Parameters<DB['transaction']>[0]>[0]) => Promise<void>,
): Promise<void> {
  // Heuristic: a DB has `.transaction` as a callable that returns a Promise.
  // Tx handles also expose `.transaction` (Drizzle supports nested savepoints)
  // but we don't want to open a nested savepoint here — we want to inline.
  // The safest discriminator is the presence of the bun-sqlite session;
  // since both surfaces share the query API, treat a DB-shaped caller as
  // the one to wrap. Practically, callers that already hold a tx pass it
  // intentionally — we trust that and just call fn(tx) directly.
  //
  // Discriminator: DB has `_.session` per drizzle internals; a tx handle
  // doesn't. Casting through `unknown` avoids exposing drizzle internals
  // in the public type.
  const looksLikeDb = typeof (txOrDb as { transaction?: unknown }).transaction === 'function'
    && (txOrDb as { _?: { session?: unknown } })._?.session !== undefined;
  if (looksLikeDb) {
    await (txOrDb as DB).transaction(async (tx) => {
      await fn(tx);
    });
  } else {
    await fn(txOrDb as Parameters<Parameters<DB['transaction']>[0]>[0]);
  }
}
