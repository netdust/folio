/**
 * Phase 3 — F-4 DIAGNOSTIC (headless agent-chain boundary tracer).
 *
 * DIAGNOSIS, NOT A FIX. The Sub-phase D e2e fails because no `kind=result`
 * comment ever appears (Comments tab shows "0 comments" after 90s). This script
 * drives the REAL composed agent loop end-to-end with a REAL Anthropic key and
 * logs EVERY component boundary so we can pinpoint which one dies.
 *
 * The chain (one log line per boundary, in order):
 *   UI assign
 *     → PATCH frontmatter.assignee='agent:<slug>' (services/documents updateDocument)
 *     → emits `agent.task.assigned` event
 *     → dispatcher fans it to the trigger-matcher reactor
 *     → matcher creates a `planning` agent_run row
 *     → poller claims it
 *     → runner (runAgent) calls Anthropic → posts a `kind=result` comment on the parent.
 *
 * TWO MODES:
 *
 *   DEFAULT (manual ticks) — drives the chain with explicit
 *     `runDispatcherOnce(db, REACTORS)` + `runPollerOnce(db, deps)` calls so each
 *     boundary is observable in isolation. PROVES the product chain works.
 *     This reuses the C-13 wiring smoke's setup with TWO differences:
 *       1. Assign via the REAL `updateDocument` service (the UI's PATCH path that
 *          must emit `agent.task.assigned`), not a direct emitEvent.
 *       2. Use the REAL `runAgent` in the poller deps (the actual billed
 *          Anthropic call happens), not the smoke's stub.
 *
 *   --loop (REAL interval loops) — instead of manual ticks, starts the REAL
 *     `setInterval` dispatcher + poller EXACTLY as index.ts boot does
 *     (`startEventDispatcher(db)` + `startRunnerPoller(db)`), THEN assigns, then
 *     polls for ~90s (the e2e's timeout) for a result comment. This is the
 *     mechanism the failing Playwright e2e relies on. The decisive question:
 *     **do the real interval loops process an assignment emitted AFTER they
 *     start?** If --loop produces a result comment → loops + product are fine and
 *     the e2e failure is Playwright-harness-specific (selector/timing/proxy). If
 *     --loop stalls (0 comments) → we've reproduced the e2e bug headlessly and
 *     isolated it to the loop wiring (cursor seed / boot order / --hot reload).
 *
 * RUN (real billed Haiku call — the USER runs this, not CI):
 *   # manual-tick mode (default):
 *   FOLIO_TEST_ANTHROPIC_KEY=sk-ant-... bun run apps/server/scripts/diagnose-agent-chain.ts
 *   # real-interval-loop mode (reproduces the e2e mechanism):
 *   FOLIO_TEST_ANTHROPIC_KEY=sk-ant-... bun run apps/server/scripts/diagnose-agent-chain.ts --loop
 *   # or drop the key in ./key (relative to apps/server) and omit FOLIO_TEST_ANTHROPIC_KEY.
 */

// ---------------------------------------------------------------------------
// 1) ENV — set BEFORE any local import. env.ts parses its singleton at import
//    time, and crypto.ts derives the master key at import time. These MUST be
//    in process.env before `await import(...)` runs below.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

// Mode selection: --loop drives the REAL setInterval dispatcher+poller loops
// (the mechanism the failing e2e relies on); default drives manual ticks.
const LOOP_MODE = process.argv.includes('--loop');

// Resolve paths relative to THIS file so it works from repo root or apps/server.
const SERVER_ROOT = pathResolve(import.meta.dir, '..');
const KEY_FILE = pathResolve(SERVER_ROOT, 'key');
// Isolated DB per mode so a loop run never collides with a manual run's file.
const DB_FILE = pathResolve(
  SERVER_ROOT,
  LOOP_MODE ? 'diag-agent-chain-loop.db' : 'diag-agent-chain.db',
);
const MIGRATIONS_DIR = pathResolve(SERVER_ROOT, 'src/db/migrations');

// --- Anthropic key: env first, then ./key file. Hard-fail if absent. ---
function loadAnthropicKey(): string {
  const fromEnv = process.env.FOLIO_TEST_ANTHROPIC_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(KEY_FILE)) {
    const fromFile = readFileSync(KEY_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  console.error(
    '[diag] No Anthropic key. Set FOLIO_TEST_ANTHROPIC_KEY=sk-ant-... or put it in apps/server/key',
  );
  process.exit(1);
}
const ANTHROPIC_KEY = loadAnthropicKey();

// --- Fixed test master key (same value playwright.config.ts uses). 64 hex. ---
process.env.FOLIO_MASTER_KEY =
  '0000000000000000000000000000000000000000000000000000000000000001';
// SESSION_SECRET must be >= 32 chars for env.ts to parse (auth import side-effect).
process.env.SESSION_SECRET ??= 'diag-session-secret-diag-session-secret-xx';
// Isolated DB file (deleted below for a clean run). We open it ourselves and
// install it as the test DB override, so DATABASE_URL is informational here.
process.env.DATABASE_URL = `file:${DB_FILE}`;
// REAL paths (development), NOT 'test'. We drive the pollers manually, so we
// must NOT let index.ts start its own — and we never import index.ts.
process.env.NODE_ENV = 'development';
// Autonomy gate: a HUMAN assignment (actor = seeded user) fires regardless of
// this flag, but set it on so nothing in the matcher's gate suppresses us.
process.env.FOLIO_AGENT_CHAINS_ENABLED = 'true';

// ---------------------------------------------------------------------------
// 2) Fresh DB + migrations. Mirror the harness: build the Database ourselves,
//    migrate, then set globalThis.__folioTestDb so the singleton `db` proxy in
//    db/client.ts (which the runner, services, crypto all import) resolves to
//    THIS db. We do this via dynamic import AFTER env is set.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Clean slate.
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${DB_FILE}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }

  const { drizzle } = await import('drizzle-orm/bun-sqlite');
  const { migrate } = await import('drizzle-orm/bun-sqlite/migrator');
  const schema = await import('../src/db/schema.ts');

  const sqlite = new Database(DB_FILE);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // Install BEFORE importing anything that touches the `db` proxy.
  globalThis.__folioTestDb = db as unknown as typeof globalThis.__folioTestDb;
  const { __resetDbForTests } = await import('../src/db/client.ts');
  __resetDbForTests();

  // Now safe to import the real wiring (they all resolve `db` through the proxy).
  const { and, eq, sql } = await import('drizzle-orm');
  const { nanoid } = await import('nanoid');
  const { toolsToScopes } = await import('../src/lib/agent-schema.ts');
  const { newApiToken } = await import('../src/lib/auth.ts');
  const { seedBuiltinTriggers } = await import('../src/lib/builtin-triggers.ts');
  const { seedProjectDefaults } = await import('../src/lib/seed-project-defaults.ts');
  const { encryptSecret } = await import('../src/lib/crypto.ts');
  const { runDispatcherOnce, startEventDispatcher } = await import(
    '../src/lib/event-dispatcher.ts'
  );
  const { REACTORS } = await import('../src/lib/reactors.ts');
  const { runPollerOnce, startRunnerPoller } = await import('../src/lib/poller.ts');
  const { runAgent, runAgentResume } = await import('../src/lib/runner.ts');
  const { updateDocument } = await import('../src/services/documents.ts');
  const { documents, apiTokens, events, tables, aiKeys } = schema;

  const truncate = (s: unknown, n = 300): string => {
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    if (str == null) return String(str);
    return str.length > n ? `${str.slice(0, n)}…` : str;
  };

  // -------------------------------------------------------------------------
  // 3) Setup: user, workspace, project (+ defaults), agent, BYOK key, triggers,
  //    work_item with EMPTY assignee.
  // -------------------------------------------------------------------------

  const AGENT_SLUG = 'diag-helper';
  let workItemId = '';
  let agentId = '';
  let workspaceId = '';
  let projectId = '';
  let userId = '';

  try {
    userId = nanoid();
    const { hashPassword } = await import('../src/lib/auth.ts');
    await db.insert(schema.users).values({
      id: userId,
      email: 'diag@test.local',
      name: 'Diag',
      passwordHash: await hashPassword('password123'),
    });

    workspaceId = nanoid();
    await db.insert(schema.workspaces).values({ id: workspaceId, slug: 'diag-ws', name: 'Diag WS' });
    await db.insert(schema.memberships).values({ workspaceId, userId, role: 'owner' });

    projectId = nanoid();
    await db.insert(schema.projects).values({ id: projectId, workspaceId, slug: 'diag-proj', name: 'Diag Proj' });
    await seedProjectDefaults(db, projectId);

    // BYOK key: store the REAL Anthropic key, encrypted exactly the way the
    // settings route does (encryptSecret). The runner decrypts via decryptSecret
    // using the same FOLIO_MASTER_KEY — so the key path must match or B4 would
    // false-fail with no_ai_key / a decrypt error.
    await db.insert(aiKeys).values({
      id: nanoid(),
      workspaceId,
      provider: 'anthropic',
      label: 'default',
      encryptedKey: encryptSecret(ANTHROPIC_KEY),
    });

    // Agent — workspace-scoped (projectId/tableId null). tools:[] so the runner
    // makes a plain text completion (no tool rounds). projects allow-lists this
    // project so the matcher's allow-list check passes.
    agentId = nanoid();
    const { hash } = newApiToken();
    const apiTokenId = nanoid();
    await db.insert(documents).values({
      id: agentId,
      workspaceId,
      projectId: null,
      tableId: null,
      type: 'agent',
      slug: AGENT_SLUG,
      title: AGENT_SLUG,
      status: null,
      body: '',
      frontmatter: {
        system_prompt: 'Reply in one short sentence in English.',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        tools: [],
        projects: [projectId],
        max_delegation_depth: 2,
        max_tokens_per_run: 1_000,
        requires_approval: false,
        api_token_id: apiTokenId,
      },
      createdBy: userId,
      updatedBy: userId,
    });
    await db.insert(apiTokens).values({
      id: apiTokenId,
      workspaceId,
      name: `agent:${AGENT_SLUG}`,
      tokenHash: hash,
      scopes: toolsToScopes([]),
      agentId,
      createdBy: userId,
    });

    // Builtin triggers (the on-assignment trigger the matcher checks).
    await db.transaction(async (tx) => {
      await seedBuiltinTriggers(tx, workspaceId, userId);
    });

    // work_item with EMPTY assignee (assignment happens at B1).
    const workItemsTable = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
    });
    if (!workItemsTable) throw new Error('setup: work-items table missing after seedProjectDefaults');
    workItemId = nanoid();
    await db.insert(documents).values({
      id: workItemId,
      workspaceId,
      projectId,
      tableId: workItemsTable.id,
      type: 'work_item',
      slug: `wi-${nanoid(6)}`,
      title: 'Diag parent work item',
      status: null,
      body: 'Please introduce yourself in one sentence.',
      frontmatter: {},
      createdBy: userId,
      updatedBy: userId,
    });
    console.log(`[setup] workspace=${workspaceId} project=${projectId} agent=${AGENT_SLUG} work_item=${workItemId}`);
  } catch (err) {
    console.error('[SETUP] FAILED — cannot run the chain:', err);
    process.exit(1);
  }

  // Track which boundary first broke, for the final VERDICT.
  let firstBreak: string | null = null;
  const markBreak = (label: string) => {
    if (!firstBreak) firstBreak = label;
  };

  // Shared B1 — assign via the REAL updateDocument (the UI's PATCH path that
  // must emit agent.task.assigned). Used by both modes.
  const assignWorkItemToAgent = async (): Promise<void> => {
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const [actorUser] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const existing = await db.query.documents.findFirst({ where: eq(documents.id, workItemId) });
    if (!ws || !proj || !actorUser || !existing) throw new Error('B1: setup rows missing for updateDocument');
    await updateDocument({
      workspace: ws,
      project: proj,
      fallbackTable: null,
      actor: actorUser,
      existing,
      patch: { frontmatter: { assignee: `agent:${AGENT_SLUG}` } },
    });
  };

  // ===========================================================================
  // --loop MODE — drive the chain with the REAL setInterval loops (the exact
  // mechanism the failing Playwright e2e relies on), then poll ~90s for a
  // result comment. Mirrors index.ts boot order: loops start FIRST (seeding
  // their cursors at MAX(seq)), THEN the assignment arrives as live traffic.
  // ===========================================================================
  if (LOOP_MODE) {
    let stopDispatcher: (() => void) | null = null;
    let stopPoller: (() => void) | null = null;

    // Clean shutdown helper — setInterval handles MUST be cleared or the
    // process never exits.
    const stopLoops = () => {
      try {
        stopDispatcher?.();
      } catch {
        /* ignore */
      }
      try {
        stopPoller?.();
      } catch {
        /* ignore */
      }
    };

    try {
      // STEP 2 — start the REAL loops exactly as index.ts does (db-only args;
      // they read FOLIO_DISPATCHER_INTERVAL_MS / FOLIO_POLLER_INTERVAL_MS and
      // wire the real runAgent internally). Capture the stop fns.
      stopDispatcher = startEventDispatcher(db);
      stopPoller = startRunnerPoller(db);

      // STEP 3 — wait briefly so the dispatcher does its FIRST tick and seeds
      // its per-reactor cursor at MAX(seq) BEFORE any assignment exists. This
      // mirrors production: loops boot, THEN traffic arrives.
      await new Promise((r) => setTimeout(r, 1_500));
      console.log('[loop] dispatcher+poller started, cursor seeded');

      // STEP 4 — NOW assign (live traffic emitted AFTER the loops are running).
      await assignWorkItemToAgent();
      const reread = await db.query.documents.findFirst({ where: eq(documents.id, workItemId) });
      const persisted = (reread?.frontmatter as Record<string, unknown> | undefined)?.assignee;
      console.log(`[B1] assignee persisted = ${truncate(persisted)}`);
      if (persisted !== `agent:${AGENT_SLUG}`) markBreak('B1');

      const evRows = await db
        .select()
        .from(events)
        .where(and(eq(events.documentId, workItemId), eq(events.kind, 'agent.task.assigned')));
      console.log(`[B2] agent.task.assigned emitted = ${evRows.length} payload=${truncate(evRows[0]?.payload)}`);
      if (evRows.length === 0) markBreak('B2');

      // STEP 5 — poll up to ~90s (the e2e timeout). Every 2s re-query the run
      // row + the parent's comments. Stop early on a result comment OR a
      // terminal run state. NO manual runDispatcherOnce/runPollerOnce — the
      // real setInterval loops must do ALL the work.
      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
      const POLL_MS = 2_000;
      const TIMEOUT_MS = 90_000;
      const startedAt = Date.now();
      let sawResultComment = false;
      let lastRunStatus: string | null | undefined;

      while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const elapsedS = Math.round((Date.now() - startedAt) / 1_000);

        const runRow = await db.query.documents.findFirst({
          where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, workItemId)),
        });
        lastRunStatus = runRow?.status;

        const commentRows = await db.query.documents.findMany({
          where: and(eq(documents.type, 'comment'), eq(documents.parentId, workItemId)),
        });
        sawResultComment = commentRows.some(
          (c) => (c.frontmatter as Record<string, unknown>)?.kind === 'result',
        );

        console.log(
          `[wait ${elapsedS}s] run status=${runRow?.status ?? '<none>'} comments=${commentRows.length}`,
        );

        if (sawResultComment) break;
        if (runRow && TERMINAL.has(String(runRow.status))) {
          // Terminal but no result comment yet — one more poll picks up a
          // late comment write; otherwise the next iteration's check ends it.
          if (runRow.status === 'completed') {
            await new Promise((r) => setTimeout(r, POLL_MS));
            const recheck = await db.query.documents.findMany({
              where: and(eq(documents.type, 'comment'), eq(documents.parentId, workItemId)),
            });
            sawResultComment = recheck.some(
              (c) => (c.frontmatter as Record<string, unknown>)?.kind === 'result',
            );
          }
          break;
        }
      }

      // STEP 6 — final boundary snapshot + VERDICT.
      const finalRun = await db.query.documents.findFirst({
        where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, workItemId)),
      });
      const fm = (finalRun?.frontmatter ?? {}) as Record<string, unknown>;
      console.log(`[B3] planning/run row = ${finalRun ? 1 : 0} status=${truncate(finalRun?.status)}`);
      console.log(
        `[B4] run status = ${finalRun?.status} error_reason=${truncate(fm.error_reason)} error_detail=${truncate(fm.error_detail)}`,
      );

      const finalComments = await db.query.documents.findMany({
        where: and(eq(documents.type, 'comment'), eq(documents.parentId, workItemId)),
      });
      const kinds = finalComments.map((c) => (c.frontmatter as Record<string, unknown>)?.kind);
      console.log(`[B5] comments on parent = ${finalComments.length} kinds=${truncate(kinds)}`);
      const resultComment = finalComments.find(
        (c) => (c.frontmatter as Record<string, unknown>)?.kind === 'result',
      );
      if (resultComment) console.log(`[B5] result comment body = ${truncate(resultComment.body)}`);

      console.log('');
      if (resultComment) {
        console.log(
          'VERDICT: LOOPS WORK — the REAL setInterval dispatcher+poller processed an assignment emitted AFTER they started and produced a kind=result comment. The product chain + loop wiring are fine. The Sub-phase D e2e failure is Playwright-harness-specific (selector / timing / proxy / dev-vs-built server) — fix the SPEC, not the loops.',
        );
      } else {
        console.log(
          `VERDICT: LOOPS STALLED — E2E REPRODUCED HEADLESSLY. After ${Math.round((Date.now() - startedAt) / 1_000)}s the real interval loops produced NO kind=result comment (last run status=${lastRunStatus ?? '<no run row>'}). The assignment was emitted AFTER the loops started, so this isolates the failure to the loop wiring: the dispatcher seeded its cursor at MAX(seq) on boot and the assignment seq is at/below it (boot-order / cursor-seed bug), OR the poller never claimed the run, OR --hot reload restarted the loops mid-run. This is a REAL product/ops bug, not a Playwright artifact.`,
        );
      }
    } catch (err) {
      console.error('[loop] FATAL during loop-mode driving:', err);
    } finally {
      // STEP 7 — clear the setInterval handles so the process can exit, then
      // close the DB. Without this the loops keep the event loop alive forever.
      stopLoops();
      sqlite.close();
    }
    return;
  }

  // -------------------------------------------------------------------------
  // PRIME THE DISPATCHER (production boot order). A reactor's cursor seeds at
  // MAX(seq) on first registration and does NOT replay history (loadOrSeedCursor
  // in event-dispatcher.ts). In production the dispatcher is already running
  // BEFORE live traffic, so its cursor sits below any assignment seq. Here the
  // assignment is emitted at B1 (the real UI path) — so we MUST prime the
  // cursor now (before B1), exactly as index.ts starts the dispatcher before
  // traffic. Skipping this primes the cursor AT/ABOVE the assignment and the
  // matcher legitimately skips it — a FALSE B3 break. (This is the boot-order
  // note the c13 smoke documents; the smoke primes before its emitAssignment.)
  // -------------------------------------------------------------------------
  try {
    await runDispatcherOnce(db, REACTORS);
    console.log('[prime] dispatcher cursor seeded at MAX(seq) before assignment (boot order)');
  } catch (err) {
    console.error('[prime] dispatcher priming threw (chain may false-break at B3):', err);
  }

  // -------------------------------------------------------------------------
  // BOUNDARY 1 — assign via the REAL updateDocument (the UI's PATCH path).
  // -------------------------------------------------------------------------
  try {
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const [actorUser] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const existing = await db.query.documents.findFirst({ where: eq(documents.id, workItemId) });
    if (!ws || !proj || !actorUser || !existing) throw new Error('B1: setup rows missing for updateDocument');

    await updateDocument({
      workspace: ws,
      project: proj,
      fallbackTable: null,
      actor: actorUser,
      existing,
      patch: { frontmatter: { assignee: `agent:${AGENT_SLUG}` } },
    });

    const reread = await db.query.documents.findFirst({ where: eq(documents.id, workItemId) });
    const persisted = (reread?.frontmatter as Record<string, unknown> | undefined)?.assignee;
    console.log(`[B1] assignee persisted = ${truncate(persisted)}`);
    if (persisted !== `agent:${AGENT_SLUG}`) markBreak('B1');
  } catch (err) {
    markBreak('B1');
    console.error('[B1] THREW:', err);
  }

  // -------------------------------------------------------------------------
  // BOUNDARY 2 — the agent.task.assigned event landed in the durable log.
  // -------------------------------------------------------------------------
  try {
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.documentId, workItemId), eq(events.kind, 'agent.task.assigned')));
    console.log(
      `[B2] agent.task.assigned emitted = ${rows.length} payload=${truncate(rows[0]?.payload)}`,
    );
    if (rows.length === 0) markBreak('B2');
  } catch (err) {
    markBreak('B2');
    console.error('[B2] THREW:', err);
  }

  // -------------------------------------------------------------------------
  // BOUNDARY 3 — dispatcher fans to the trigger-matcher reactor → planning run.
  //   The cursor was already primed during setup (before B1), so this tick
  //   processes the assignment emitted at B1. Two ticks for belt-and-suspenders
  //   (the matcher's own work may emit events a second tick would surface).
  //   If B3 still shows 0 runs after this, the matcher genuinely did not match —
  //   NOT a cursor-seeding artifact (priming ruled that out).
  // -------------------------------------------------------------------------
  try {
    await runDispatcherOnce(db, REACTORS); // processes the B1 assignment
    await runDispatcherOnce(db, REACTORS); // surfaces any follow-on matcher work

    const runRows = await db.query.documents.findMany({
      where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, workItemId)),
    });
    const statuses = runRows.map((r) => r.status);
    console.log(`[B3] planning runs created = ${runRows.length} statuses=${truncate(statuses)}`);

    // Diagnostic context: suppression events (autonomy gate) + the matcher's
    // own diagnostic kinds, if any landed on the durable log.
    const diagKinds = ['agent.chain.suppressed', 'reactor.halted', 'reactor.recovered'];
    for (const kind of diagKinds) {
      const k = await db.select().from(events).where(eq(events.kind, kind));
      if (k.length > 0) {
        console.log(`[B3] diagnostic event ${kind} = ${k.length} payload=${truncate(k[0]?.payload)}`);
      }
    }
    if (runRows.length === 0) markBreak('B3');
  } catch (err) {
    markBreak('B3');
    console.error('[B3] THREW:', err);
  }

  // -------------------------------------------------------------------------
  // BOUNDARY 4 — poller claims the planning run, REAL runAgent calls Anthropic.
  //   This is the only billed call. runAgent NEVER throws out — it transitions
  //   the run to a terminal state on any failure — so we inspect the run row's
  //   status + error_reason + error_detail afterward.
  // -------------------------------------------------------------------------
  try {
    const inFlight = { count: 0 };
    const deps = {
      runAgent,
      runAgentResume,
      maxConcurrent: 5,
      inFlight,
    };
    await runPollerOnce(db, deps); // claims + fire-and-forget dispatches runAgent

    // The poller dispatches fire-and-forget. Wait for the in-flight count to
    // drain (the real Anthropic call takes a few seconds), with a hard ceiling.
    const startedWaiting = Date.now();
    const MAX_WAIT_MS = 60_000;
    while (inFlight.count > 0 && Date.now() - startedWaiting < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (inFlight.count > 0) {
      console.log(`[B4] WARNING: runAgent still in-flight after ${MAX_WAIT_MS}ms (count=${inFlight.count})`);
    }

    const runRow = await db.query.documents.findFirst({
      where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, workItemId)),
    });
    const fm = (runRow?.frontmatter ?? {}) as Record<string, unknown>;
    console.log(
      `[B4] run status after poller = ${runRow?.status} error_reason=${truncate(fm.error_reason)} error_detail=${truncate(fm.error_detail)}`,
    );
    if (!runRow || runRow.status !== 'completed') markBreak('B4');
  } catch (err) {
    markBreak('B4');
    console.error('[B4] THREW:', err);
  }

  // -------------------------------------------------------------------------
  // BOUNDARY 5 — the kind=result comment on the parent work_item.
  // -------------------------------------------------------------------------
  try {
    const comments = await db.query.documents.findMany({
      where: and(eq(documents.type, 'comment'), eq(documents.parentId, workItemId)),
    });
    const kinds = comments.map((c) => (c.frontmatter as Record<string, unknown>)?.kind);
    console.log(`[B5] comments on parent = ${comments.length} kinds=${truncate(kinds)}`);
    const resultComment = comments.find(
      (c) => (c.frontmatter as Record<string, unknown>)?.kind === 'result',
    );
    if (resultComment) {
      console.log(`[B5] result comment body = ${truncate(resultComment.body)}`);
    } else {
      markBreak('B5');
    }
  } catch (err) {
    markBreak('B5');
    console.error('[B5] THREW:', err);
  }

  // -------------------------------------------------------------------------
  // VERDICT — name the FIRST boundary that failed.
  // -------------------------------------------------------------------------
  const VERDICT_DESC: Record<string, string> = {
    B1: 'updateDocument did not persist the agent assignee — the UI PATCH path is broken.',
    B2: 'assignee persisted but NO agent.task.assigned event emitted — updateDocument did not emit (check the work_item/project guard or prevAssignee !== nextAssignee).',
    B3: 'agent.task.assigned emitted but no planning run created — the matcher did not match (trigger disabled? allow-list? autonomy gate? cursor seeded past the event?).',
    B4: 'planning run created but did not complete — the poller claimed it but runAgent failed (see error_reason / error_detail above: no_ai_key, provider_error, etc.).',
    B5: 'run completed but NO kind=result comment on the parent — postResultAndComplete / createComment is the break.',
  };
  console.log('');
  if (firstBreak) {
    console.log(`VERDICT: BREAK AT ${firstBreak}: ${VERDICT_DESC[firstBreak]}`);
  } else {
    console.log('VERDICT: CHAIN INTACT — assign → event → run → completed → result comment all fired. No break.');
  }

  sqlite.close();
}

main().catch((err) => {
  console.error('[diag] FATAL (outside boundary tracing):', err);
  process.exit(1);
});
