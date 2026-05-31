/**
 * Phase 3 — F-4 DIAGNOSTIC (HTTP-PATH agent-chain boundary tracer).
 *
 * DIAGNOSIS, NOT A FIX. Companion to diagnose-agent-chain.ts.
 *
 * THE MYSTERY (facts established — not re-derived here):
 *   - The in-process `--loop` diagnostic (diagnose-agent-chain.ts --loop) drives
 *     assign → run → kind=result comment in ~2s. WORKS.
 *   - The Playwright e2e: the PATCH assignment PERSISTS (confirmed in the trace
 *     network log), the dispatcher + poller loops START at boot (confirmed:
 *     `[folio] event dispatcher enabled` + `runner poller enabled` print under
 *     `bun run --hot`), but NO agent_run row / NO kind=result comment after 90s.
 *     FAILS.
 *   - So the break is specific to the HTTP PATH THROUGH THE RUNNING SERVER —
 *     not the in-process composed chain. The difference: the e2e drives
 *     everything over HTTP against a long-lived `bun run --hot src/index.ts`
 *     server whose dispatcher+poller run as setInterval loops; the --loop
 *     diagnostic drives the chain in ONE process with direct service calls.
 *
 * WHAT THIS DOES: reproduces the e2e's ENVIRONMENT without the browser/selector
 * layer. It boots the API exactly as the e2e webServer does (`bun run --hot
 * src/index.ts` as a child process, same env), drives the EXACT HTTP sequence
 * the e2e drives (register → workspace → project → ai-key → agent → work_item →
 * PATCH-assign) with `fetch`, then inspects the DB read-only at each boundary
 * while DRAINING + PRINTING the child's stdout/stderr — which is the whole
 * point: the e2e swallows the server's `[folio]` logs and any runner/dispatcher
 * error. Here we SEE them.
 *
 * The boundaries we watch (poll loop, one line per tick):
 *   [B2] agent.task.assigned events     — did the PATCH emit the event?
 *   [B3] agent_run rows + statuses      — did the dispatcher+matcher create a run?
 *   [B5] comments (type=comment) + kinds — did the runner post a kind=result?
 *   + any new server stderr/stdout each tick (runner/dispatcher errors).
 *
 * VERDICT names the boundary that broke:
 *   no event           → the PATCH didn't emit (assignee guard / merge).
 *   event but no run    → matcher / dispatcher (cursor seed / boot order / match).
 *   run stuck planning  → poller never claimed it.
 *   run failed          → runner / provider (prints error_reason / error_detail).
 *   run completed, no comment → comment-post boundary.
 *
 * RUN (real billed Haiku call — the USER runs this, not CI):
 *   # key via env:
 *   FOLIO_TEST_ANTHROPIC_KEY=sk-ant-... bun run apps/server/scripts/diagnose-http-chain.ts
 *   # or drop the key in apps/server/key and omit FOLIO_TEST_ANTHROPIC_KEY:
 *   bun run apps/server/scripts/diagnose-http-chain.ts
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config — mirror the e2e's playwright.config.ts webServer env EXACTLY, except
// PORT (use a free one so we don't collide with a running dev/e2e stack) and
// DATABASE_URL (our own isolated file).
// ---------------------------------------------------------------------------

const SERVER_ROOT = pathResolve(import.meta.dir, '..');
const KEY_FILE = pathResolve(SERVER_ROOT, 'key');
const DB_FILE = pathResolve(SERVER_ROOT, 'diag-http.db');
const PORT = 3055;
const BASE = `http://localhost:${PORT}`;

// Slugs / fixtures the HTTP sequence uses.
const WS_SLUG = 'p3http';
const PROJECT_SLUG = 'inbox';
const EMAIL = `diag-http-${Date.now()}@folio.test`;
const PASSWORD = 'test-password-123';

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

const truncate = (s: unknown, n = 400): string => {
  if (s == null) return String(s);
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

// ---------------------------------------------------------------------------
// Child-process stdout/stderr drain. Bun.spawn gives us ReadableStreams; we
// pump them into a shared buffer with a [server:out]/[server:err] prefix so the
// poll loop can flush new lines each tick. THIS surfaces the runner/dispatcher
// errors the e2e swallows.
// ---------------------------------------------------------------------------

const serverLines: string[] = [];
let printedUpTo = 0;

function pumpStream(stream: ReadableStream<Uint8Array> | null, tag: string): void {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        const parts = carry.split('\n');
        carry = parts.pop() ?? '';
        for (const line of parts) serverLines.push(`[${tag}] ${line}`);
      }
      if (carry) serverLines.push(`[${tag}] ${carry}`);
    } catch {
      /* stream closed on kill — ignore */
    }
  })();
}

/** Flush any server lines captured since the last flush. */
function flushServerLines(): void {
  for (; printedUpTo < serverLines.length; printedUpTo += 1) {
    console.log(`    ${serverLines[printedUpTo]}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers. We carry the session cookie captured from register on every
// request, send Content-Type: application/json, and unwrap the `{ data }`
// envelope jsonOk() produces.
// ---------------------------------------------------------------------------

let sessionCookie = '';

interface ApiResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionCookie) headers.cookie = sessionCookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Capture the session cookie from register's Set-Cookie (folio_session=...).
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/folio_session=[^;]+/);
    if (m) sessionCookie = m[0];
  }
  let parsed: unknown = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/** Unwrap the `{ data: ... }` envelope; tolerate already-unwrapped bodies. */
function data<T = Record<string, unknown>>(r: ApiResult): T {
  const b = r.body as { data?: unknown } | null;
  return ((b && typeof b === 'object' && 'data' in b ? b.data : b) as T) ?? ({} as T);
}

function assert2xx(r: ApiResult, label: string): void {
  if (!r.ok) {
    console.error(`[setup] ${label} → ${r.status} ${truncate(r.body)}`);
    throw new Error(`${label} failed with ${r.status}`);
  }
  console.log(`[setup] ${label} → ${r.status} OK`);
}

// ---------------------------------------------------------------------------
// Boot the API child process exactly as the e2e webServer does.
// ---------------------------------------------------------------------------

async function bootServer(): Promise<{ proc: ReturnType<typeof Bun.spawn> }> {
  // Clean slate DB so we never inherit a stale run/comment.
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${DB_FILE}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }

  // Same command + env shape as playwright.config.ts's API webServer. We add
  // SESSION_SECRET explicitly (the e2e relies on apps/server/.env supplying it;
  // we set it here so the script is self-contained regardless of .env). PORT
  // and DATABASE_URL are the only intentional divergences from the e2e config.
  const proc = Bun.spawn(['bun', 'run', '--hot', 'src/index.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: `file:${DB_FILE}`,
      FOLIO_MASTER_KEY:
        '0000000000000000000000000000000000000000000000000000000000000001',
      SESSION_SECRET: 'diag-http-session-secret-diag-http-session-x', // 44 chars
      NODE_ENV: 'development',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drain stdout/stderr into the shared buffer so we can print the server's
  // boot logs + runtime errors (the e2e hides these).
  pumpStream(proc.stdout as ReadableStream<Uint8Array>, 'server:out');
  pumpStream(proc.stderr as ReadableStream<Uint8Array>, 'server:err');

  // Wait until /health answers (server is listening + migrations applied).
  const startedAt = Date.now();
  const BOOT_TIMEOUT_MS = 20_000;
  let ready = false;
  while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 300));
    flushServerLines();
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
  }
  flushServerLines();
  if (!ready) {
    throw new Error(`server did not become healthy on ${BASE}/healthz within ${BOOT_TIMEOUT_MS}ms`);
  }
  console.log(`[boot] server healthy on ${BASE}`);
  return { proc };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let sqlite: Database | null = null;

  try {
    ({ proc } = await bootServer());

    // -----------------------------------------------------------------------
    // Drive the e2e's EXACT HTTP sequence.
    // -----------------------------------------------------------------------

    // 1) Register (captures the folio_session cookie via api()).
    assert2xx(
      await api('POST', '/api/v1/auth/register', {
        email: EMAIL,
        password: PASSWORD,
        name: 'Diag HTTP',
      }),
      'register',
    );
    if (!sessionCookie) throw new Error('register did not set a folio_session cookie');

    // 2) Workspace.
    const wsRes = await api('POST', '/api/v1/workspaces', { name: 'P3 HTTP', slug: WS_SLUG });
    assert2xx(wsRes, `create workspace ${WS_SLUG}`);
    const workspaceId = data<{ id: string }>(wsRes).id;

    // 3) Project (inbox).
    assert2xx(
      await api('POST', `/api/v1/w/${WS_SLUG}/projects`, { name: 'Inbox', slug: PROJECT_SLUG }),
      `create project ${PROJECT_SLUG}`,
    );
    const projListRes = await api('GET', `/api/v1/w/${WS_SLUG}/projects`);
    assert2xx(projListRes, 'list projects');
    const projects = data<Array<{ id: string; slug: string }>>(projListRes);
    const inbox = Array.isArray(projects)
      ? projects.find((p) => p.slug === PROJECT_SLUG)
      : undefined;
    if (!inbox) throw new Error(`inbox project not found in list: ${truncate(projects)}`);
    const inboxId = inbox.id;

    // 4) BYOK Anthropic key. settings.ts POST body shape:
    //    { provider, apiKey, label?, baseUrl? }  (NO `default`/`model` field).
    assert2xx(
      await api('POST', `/api/v1/w/${WS_SLUG}/settings/${workspaceId}/ai-keys`, {
        provider: 'anthropic',
        apiKey: ANTHROPIC_KEY,
        label: 'default',
      }),
      'store ai-key (anthropic)',
    );

    // 5) Agent (workspace-scoped; POST /api/v1/w/:wslug/documents). tools:[] →
    //    plain text completion. projects allow-lists the inbox so the matcher's
    //    allow-list check passes.
    const agentRes = await api('POST', `/api/v1/w/${WS_SLUG}/documents`, {
      type: 'agent',
      title: 'diag-http-helper',
      frontmatter: {
        system_prompt: 'Reply in one short sentence in English.',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        tools: [],
        projects: [inboxId],
      },
    });
    assert2xx(agentRes, 'create agent');
    const agentSlug = data<{ slug: string }>(agentRes).slug;
    if (!agentSlug) throw new Error(`agent create returned no slug: ${truncate(agentRes.body)}`);

    // 6) work_item with EMPTY assignee (assignment happens at the PATCH).
    const wiRes = await api('POST', `/api/v1/w/${WS_SLUG}/p/${PROJECT_SLUG}/documents`, {
      type: 'work_item',
      title: 'Draft a reply',
      body: 'Please introduce yourself in one sentence.',
      frontmatter: { assignee: '' },
    });
    assert2xx(wiRes, 'create work_item');
    const wiSlug = data<{ slug: string }>(wiRes).slug;
    const wiId = data<{ id: string }>(wiRes).id;
    if (!wiSlug || !wiId) throw new Error(`work_item create returned no slug/id: ${truncate(wiRes.body)}`);

    console.log(
      `[setup] workspace=${workspaceId} inbox=${inboxId} agent=${agentSlug} work_item=${wiSlug} (id=${wiId})`,
    );

    // 7) THE ASSIGNMENT — PATCH frontmatter.assignee. The FE (useUpdateDocument)
    //    sends ONLY the patch (server merges frontmatter), so the body is
    //    exactly `{ frontmatter: { assignee: 'agent:<slug>' } }`.
    const patchRes = await api(
      'PATCH',
      `/api/v1/w/${WS_SLUG}/p/${PROJECT_SLUG}/documents/${wiSlug}`,
      { frontmatter: { assignee: `agent:${agentSlug}` } },
    );
    assert2xx(patchRes, 'PATCH assign agent');
    const patchedAssignee = (data<{ frontmatter?: Record<string, unknown> }>(patchRes).frontmatter ?? {})
      .assignee;
    console.log(`[B1] PATCH response assignee = ${truncate(patchedAssignee)}`);
    flushServerLines();

    // -----------------------------------------------------------------------
    // Poll the DB read-only (open the SAME file the child server writes). We do
    // NOT touch the schema/migrations — the server owns the file; we only read.
    // -----------------------------------------------------------------------

    sqlite = new Database(DB_FILE, { readonly: true });
    sqlite.exec('PRAGMA busy_timeout = 5000');

    const countAssignedEvents = (): number => {
      const row = sqlite!
        .query(
          `SELECT COUNT(*) AS n FROM events WHERE document_id = ? AND kind = 'agent.task.assigned'`,
        )
        .get(wiId) as { n: number } | null;
      return row?.n ?? 0;
    };

    interface RunRow {
      id: string;
      status: string | null;
      frontmatter: string | null;
    }
    const getRuns = (): RunRow[] =>
      sqlite!
        .query(
          `SELECT id, status, frontmatter FROM documents WHERE type = 'agent_run' AND parent_id = ?`,
        )
        .all(wiId) as RunRow[];

    interface CommentRow {
      id: string;
      frontmatter: string | null;
      body: string | null;
    }
    const getComments = (): CommentRow[] =>
      sqlite!
        .query(
          `SELECT id, frontmatter, body FROM documents WHERE type = 'comment' AND parent_id = ?`,
        )
        .all(wiId) as CommentRow[];

    const fmKind = (fm: string | null): unknown => {
      if (!fm) return undefined;
      try {
        return (JSON.parse(fm) as Record<string, unknown>).kind;
      } catch {
        return '<unparseable>';
      }
    };

    const POLL_MS = 1_000;
    const TIMEOUT_MS = 60_000;
    const startedAt = Date.now();
    let sawResult = false;

    console.log('');
    console.log('[poll] watching B2/B3/B5 for up to 60s (draining server logs each tick)…');
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const elapsed = Math.round((Date.now() - startedAt) / 1_000);

      const b2 = countAssignedEvents();
      const runs = getRuns();
      const runStatuses = runs.map((r) => r.status ?? '<null>');
      const comments = getComments();
      const commentKinds = comments.map((c) => fmKind(c.frontmatter));
      sawResult = comments.some((c) => fmKind(c.frontmatter) === 'result');

      console.log(
        `[t+${elapsed}s] [B2] assigned events=${b2}  [B3] runs=${runs.length} statuses=${truncate(runStatuses)}  [B5] comments=${comments.length} kinds=${truncate(commentKinds)}`,
      );
      // Drain any new server stdout/stderr (runner/dispatcher errors land here).
      flushServerLines();

      if (sawResult) break;
    }

    // -----------------------------------------------------------------------
    // Final snapshot + VERDICT.
    // -----------------------------------------------------------------------
    flushServerLines();
    const finalEvents = countAssignedEvents();
    const finalRuns = getRuns();
    const finalComments = getComments();
    const finalKinds = finalComments.map((c) => fmKind(c.frontmatter));

    console.log('');
    console.log('=== FINAL SNAPSHOT ===');
    console.log(`[B2] agent.task.assigned events = ${finalEvents}`);
    console.log(
      `[B3] agent_run rows = ${finalRuns.length} statuses=${truncate(finalRuns.map((r) => r.status))}`,
    );
    if (finalRuns[0]) {
      let fm: Record<string, unknown> = {};
      try {
        fm = JSON.parse(finalRuns[0].frontmatter ?? '{}') as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      console.log(
        `[B4] run status=${finalRuns[0].status} error_reason=${truncate(fm.error_reason)} error_detail=${truncate(fm.error_detail)}`,
      );
    }
    console.log(`[B5] comments = ${finalComments.length} kinds=${truncate(finalKinds)}`);
    const resultComment = finalComments.find((c) => fmKind(c.frontmatter) === 'result');
    if (resultComment) console.log(`[B5] result comment body = ${truncate(resultComment.body)}`);

    // VERDICT — name the boundary that broke (HTTP path against the real server).
    console.log('');
    const runStatus = finalRuns[0]?.status ?? null;
    if (resultComment) {
      console.log(
        'VERDICT: HTTP CHAIN INTACT — the running server processed the HTTP PATCH assignment end-to-end (event → run → completed → kind=result comment). The chain works over HTTP too, so the e2e failure is Playwright-harness-specific (selector / timing / Vite proxy / page never issued the PATCH the way this script did). Re-examine the SPEC and the trace, not the server.',
      );
    } else if (finalEvents === 0) {
      console.log(
        'VERDICT: BREAK AT B2 — the PATCH PERSISTED but emitted NO agent.task.assigned event over HTTP. The JSON PATCH → updateDocument service did not fire the assignee branch. Likely: the work_item was created with assignee="" and the merge made prevAssignee===nextAssignee, OR getAssignee normalized differently, OR the JSON branch is not the path taken. Diff this against the in-process --loop diagnostic (which emits the event fine).',
      );
    } else if (finalRuns.length === 0) {
      console.log(
        'VERDICT: BREAK AT B3 — the agent.task.assigned event landed in the durable log but the dispatcher+matcher created NO agent_run row. This is the prime suspect for the e2e: the long-lived `--hot` dispatcher seeds its per-reactor cursor at MAX(seq) on boot, BEFORE the assignment exists, so it SHOULD process it — unless --hot reloaded the module and re-seeded the cursor PAST the event, or the matcher rejected (trigger disabled / allow-list / autonomy gate). Check the [server:*] lines above for dispatcher/reactor errors and any agent.chain.suppressed event.',
      );
    } else if (runStatus === 'planning') {
      console.log(
        'VERDICT: BREAK AT POLLER — a run row exists but is STUCK in planning; the runner poller never claimed it. The boot log printed `runner poller enabled`, so the loop started — but `--hot` reloads or a claim-query mismatch may stop it claiming. Check the [server:*] lines for poller errors.',
      );
    } else if (runStatus === 'failed' || runStatus === 'rejected' || runStatus === 'cancelled') {
      console.log(
        `VERDICT: BREAK AT RUNNER — the poller claimed the run but it ended ${runStatus}. See [B4] error_reason/error_detail above and the [server:err] lines for the provider/runner error the e2e swallowed (this is exactly what the e2e hides).`,
      );
    } else if (runStatus === 'completed') {
      console.log(
        'VERDICT: BREAK AT COMMENT-POST — the run COMPLETED but posted NO kind=result comment on the parent. postResultAndComplete / createComment is the break. Check the [server:err] lines for a comment-write error.',
      );
    } else {
      console.log(
        `VERDICT: INCONCLUSIVE within 60s — last run status=${runStatus ?? '<none>'}, events=${finalEvents}, comments=${finalComments.length}. The chain did not reach a result comment and did not land on a clean terminal boundary. Re-run with a longer timeout or inspect ${DB_FILE} + the [server:*] lines above.`,
      );
    }
  } catch (err) {
    flushServerLines();
    console.error('[diag] FATAL:', err);
    flushServerLines();
  } finally {
    // Kill the server child + close our read handle. Without the kill the
    // setInterval loops keep the child alive and the script never exits.
    try {
      sqlite?.close();
    } catch {
      /* ignore */
    }
    try {
      proc?.kill();
      // Give it a beat to release the port/file handles.
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      /* ignore */
    }
    flushServerLines();
  }
}

main().catch((err) => {
  console.error('[diag] FATAL (outside boundary tracing):', err);
  process.exit(1);
});
