# Phase 3 — Agent Runner + Provider Abstraction + Runs as Documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Wrap every plan-execution session in `netdust-core:ntdst-execute-with-tests`** — this Folio harness REQUIRES testing-workflow gates after each task (subagent) and after each sub-phase (controller). The wrapping skill enforces them.

**Goal:** Ship the polling-worker agent runner: provider abstraction across Anthropic/OpenAI/OpenRouter/Ollama, the `agent_run` document type living in a lazy-seeded per-project runs table, the runner loop with six recursion guards + token budget enforcement, the comments-substrate approval gate wired to live runs, the "Agent Offline" workspace banner, and HTTP↔MCP parity on all five new run operations.

**Architecture:** A long-lived poller in the same process reads `agent_run` rows at `status='planning'` from the `documents` table (the queue IS the table), atomically claims them, and dispatches `runAgent(runId)` fire-and-forget at a configurable concurrency. Trigger handlers return immediately — they only insert the row. The runner streams provider output, posts `kind=plan/comment/result/error` comments on the parent doc, transitions through the state machine, and clears `worker_started_at` on terminal status. Crash recovery on boot flips orphan `running` rows older than 5 min to `failed (worker_crash)`. Approval gate is three channels (button / `@<agent> approved` keyword / MCP) all funneling through a `kind=approval` comment, picked up by `builtin-on-approval` which inserts a new resuming planning row. Six defense-in-depth guards prevent runaway loops: max-depth, fired-by cycle, per-workspace rate, per-agent rate, per-chain fanout, per-chain duration+tokens. Provider health derived from event history; tipping into degraded emits one `workspace.provider.degraded` event, first green run after that emits `workspace.provider.recovered`.

**Tech Stack:** Bun + Hono + Drizzle + SQLite on the server, React + TanStack Router + react-query + Tailwind + shadcn/ui on the web. New deps: `@anthropic-ai/sdk` and `openai` for two of four providers; OpenRouter reuses the OpenAI client with a base-url override; Ollama uses plain `fetch`.

**Branch:** `phase-3/agent-runner`, branched from `main` at `984b31c` (Phase 2.6 merge). Single branch, sub-phased A → F (mirrors Phase 2.6's structure).

---

## Reconciliation with current code (`main` at `984b31c`)

The spec at `docs/superpowers/specs/2026-05-26-phase-3-agent-runner-design.md` was written assuming migration `0009` was free. Phase 2.6 shipped `0007–0011`. This plan uses **`0012` + `0012a`** for Phase 3 migrations. The spec is otherwise structurally sound — `services/agent-runs.ts`, `lib/runner.ts`, `lib/poller.ts`, `lib/mcp-dispatch.ts`, `lib/ai/`, `routes/runs.ts`, `routes/ai.ts` are all greenfield.

Other reconciliations:
- `KNOWN_EVENT_KINDS` lives in `packages/shared/src/events.ts` (was moved during 2.6 D6). New event kinds are added there, not in any server lib.
- `documents.type` enum currently allows `'work_item' | 'page' | 'agent' | 'trigger' | 'comment'`. Migration 0012 widens to add `'agent_run'`.
- `aiKeys` table already exists (Phase 0) with `(workspace_id, provider, label)` unique index + `base_url` column for Ollama. No schema change needed for the AI key store.
- Auto-migrate-on-boot is NOT on main (handoff §"Critical lesson"). Task 0 in Sub-phase A adds it as cheap insurance.
- Built-in triggers `builtin-on-assignment` + `builtin-on-mention` confirmed at `enabled: false` in `apps/server/src/lib/builtin-triggers.ts:35-57`. Migration `0012a` flips them.

---

## Open decisions baked into this plan

| Decision | Resolved as | Note |
|---|---|---|
| Real-Anthropic Playwright key | env var `FOLIO_TEST_ANTHROPIC_KEY`, test skips with `t.skip()` when unset; documented in `.env.example` | Sub-phase F, Task F-2 |
| Slash commands (`/draft`, `/decompose`, …) | Dropped per spec §1. `@`-mention is the universal "ask an agent" affordance | No tasks for slash commands |
| Branch carve | Single branch `phase-3/agent-runner`, sub-phases A–F internal | Mirrors Phase 2.6 |

---

## Sub-phase map

| Sub-phase | Scope | Acceptance items from spec §10 |
|---|---|---|
| **A. Foundation** | Auto-migrate on boot · Migration 0012 (agent_run + indexes) · Migration 0012a (flip builtins) · Zod schema · Event kinds · State machine helpers · Pre-commit hook for migration↔journal pairing | §10.1, §10.16, §10.25 (chain_id) |
| **B. Providers** | `AIProvider` interface · 4 implementations · AI settings tab · `POST /ai/test-key` | §10.2 |
| **C. Runner core** | `services/agent-runs.ts` · `lib/runner.ts` · `lib/poller.ts` · 6 recursion guards · crash recovery · token budget | §10.3, §10.4–10.6, §10.8–10.11, §10.16, §10.17, §10.18 |
| **D. Routes + MCP parity** | `routes/runs.ts` (5 verbs) · `lib/mcp-dispatch.ts` · 5 new MCP tools · refactor existing MCP dispatch · admin runner-stats endpoint · approval-comment → resume_run wiring | §10.7, §10.12, §10.13, §10.21, §10.22 |
| **E. UI + Runs table** | Lazy-seed runs table · runs link tile on agent/trigger slideovers · approval-buttons live state · Cmd-K Run/Approve · `[[` in body editor · Agent Offline banner | §10.14, §10.15, §10.19, §10.20, §10.23, §10.24, §10.26 |
| **F. Shake-out + e2e** | Real-Anthropic Playwright · Banner Playwright · manual-qa doc · shakeout skill · 4-reviewer pass | §10.27 (no regression) + branch-close gates |

---

## Testing-workflow contract (do not violate)

This branch is executed under `netdust-core:ntdst-execute-with-tests`, which wraps `superpowers:subagent-driven-development` with mandatory testing gates. The harness expects:

**Subagent (per task) — runs UNIT tests:**

Every code-touching task ends with the SAME closing block. No exceptions, no task-specific variation:

1. **Write the failing test FIRST** (RED). Run only that test file. Confirm fail message.
2. **Write minimal code to pass** (GREEN).
3. **Re-run that test file** → PASS.
4. **Re-run the entire affected app's unit suite** — `cd apps/server && bun test` for server tasks, `cd apps/web && bun run test` for web tasks, `cd packages/shared && bun test` for shared. Expect: prior count + delta from this task, 0-fail. If anything regresses, STOP — do not commit.
5. **Verify subagent test counts from the controller** per `[[verify-subagent-test-counts]]`. Subagents have misreported 3+ times in prior phases. The controller re-runs the same command after the subagent reports.
6. **Commit atomically.** Conventional message: `phase-3: <what> (<task-id>)` per CLAUDE.md.

**Rules that apply to ALL tasks:**

- **`bun test` from repo root is FORBIDDEN** — mixes Vitest into Bun's runner → false fails. Server tests from `apps/server`, web tests from `apps/web` (via `bun run test`), shared from `packages/shared`.
- **Migration tasks update `_journal.json`** in the same commit per `[[drizzle-migration-journal]]`. Drizzle's `migrate()` silently skips files not in the journal, so a missing entry is invisible until production.
- **`list-view-create.test.tsx` is a known flake** under high-concurrency full-suite runs per `[[known-test-flakes]]`. Rerun once before treating it as a regression.

**Controller (per sub-phase boundary) — runs INTEGRATION tests:**

At each sub-phase boundary (A→B, B→C, C→D, D→E, E→F) — i.e. inside the integration-gate task at the end of each sub-phase (A-5, B-8, C-13, D-8, E-9):

- Run `netdust-core:integration` skill → unit + integration + acceptance + type-check across both apps.
- For Sub-phase E and later: also run the Playwright e2e suite (`cd apps/web && bun run e2e`).
- Re-confirm the known flake noted above.

**Controller (branch close — Sub-phase F):**

- `netdust-core:shakeout` → re-runs integration first (defense in depth), then Playwright, then invokes the shake-out skill, then auto-dispatches 4 reviewer agents in parallel on the full branch diff.
- `superpowers:requesting-code-review` with `--effort=high --comment` for the inline PR pass.
- `superpowers:finishing-a-development-branch` to merge `--no-ff` into main.

---

## Sub-phase A — Foundation

Goal: make every later sub-phase able to insert and read `agent_run` rows with confidence. By end of A: migrations applied, Zod schema importable, state-machine helper unit-tested, new event kinds in the shared module, builtin triggers flipped — and the dev DB auto-migrates on boot so no future task gets bitten by the same outage the handoff documented.

### Task A-0: Auto-migrate on boot

> **Why first.** The handoff (2026-05-27 evening) records a long debugging detour caused by the dev DB being stuck at migration 0006 while the code expected 0011. Per `[[migrations-first-when-routes-look-broken]]`. Sub-phase A is about to ship migration 0012 — without auto-migrate, anyone pulling this branch will hit the same trap.

**Files:**
- Create: `apps/server/src/db/auto-migrate.ts`
- Create: `apps/server/src/db/auto-migrate.test.ts`
- Modify: `apps/server/src/index.ts:1-22`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/db/auto-migrate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { runMigrationsOnBoot } from './auto-migrate.ts';

describe('runMigrationsOnBoot', () => {
  test('applies all migrations to a fresh DB and is idempotent on second call', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    runMigrationsOnBoot(db);

    const count1 = sqlite
      .prepare(`SELECT COUNT(*) as n FROM __drizzle_migrations`)
      .get() as { n: number };
    expect(count1.n).toBeGreaterThan(0);

    runMigrationsOnBoot(db); // second call must not throw or re-run anything
    const count2 = sqlite
      .prepare(`SELECT COUNT(*) as n FROM __drizzle_migrations`)
      .get() as { n: number };
    expect(count2.n).toBe(count1.n);
  });

  test('does NOT run in NODE_ENV=test (test harness owns migrations)', () => {
    // The function reads NODE_ENV at call time; the test harness sets
    // it to 'test' so this returns early. We assert no __drizzle_migrations
    // table exists when env says test.
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    runMigrationsOnBoot(db);

    const row = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
      )
      .get();
    expect(row).toBeUndefined();

    process.env.NODE_ENV = originalEnv;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && bun test src/db/auto-migrate.test.ts
```

Expected: FAIL — `Cannot find module './auto-migrate.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/db/auto-migrate.ts`:

```ts
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { DB } from './client.ts';
import path from 'node:path';

/**
 * Apply any pending Drizzle migrations to the DB at boot.
 *
 * Why this exists: dev environments routinely fall behind on migrations when
 * pulling a branch with new ones. The symptom is route 500s with cryptic SQL
 * errors. Auto-migrate makes the boot reproducible. See
 * ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_migrations-first-when-routes-look-broken.md.
 *
 * Skipped in NODE_ENV=test because the test harness creates fresh in-memory
 * DBs and migrates them itself.
 */
export function runMigrationsOnBoot(db: DB): void {
  if (process.env.NODE_ENV === 'test') return;
  const migrationsFolder = path.join(import.meta.dir, 'migrations');
  migrate(db, { migrationsFolder });
}
```

- [ ] **Step 4: Wire it into the boot sequence**

Modify `apps/server/src/index.ts`, after the imports but before `console.log(`[folio] listening...`):

```ts
import { app } from './app.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';
import { reconcileAllowLists } from './lib/reconciler.ts';
import { runMigrationsOnBoot } from './db/auto-migrate.ts';

// Phase 3 Task A-0: apply any pending migrations at boot so dev environments
// never serve traffic against a stale schema. See auto-migrate.ts for why.
runMigrationsOnBoot(db);

console.log(`[folio] listening on http://localhost:${env.PORT}`);
// ... rest unchanged ...
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/server && bun test src/db/auto-migrate.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Run the full server suite to confirm no regression**

```bash
cd apps/server && bun test
```

Expected: 524+ pass / 1 skip / 0 fail (the +2 from this task should land net green).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/auto-migrate.ts apps/server/src/db/auto-migrate.test.ts apps/server/src/index.ts
git commit -m "phase-3: auto-migrate on boot (A-0)

Applies any pending Drizzle migrations when the server starts.
Skipped in NODE_ENV=test (test harness owns migration). Closes
the dev-DB-falls-behind trap documented in the 2026-05-27 handoff."
```

### Task A-1: Add Phase 3 event kinds to shared module

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/events.test.ts` (or create if missing)

- [ ] **Step 1: Inspect current event-kind test coverage**

```bash
ls packages/shared/src/events*.ts
```

If `events.test.ts` does not exist, create one with the structure used elsewhere in `packages/shared/src/`.

- [ ] **Step 2: Write the failing test**

Create or append to `packages/shared/src/events.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { KNOWN_EVENT_KINDS } from './events.ts';

describe('KNOWN_EVENT_KINDS — Phase 3 additions', () => {
  test('includes all agent.run.* event kinds', () => {
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.started');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.awaiting_approval');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.running');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.completed');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.failed');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.rejected');
  });

  test('includes ai.action audit event', () => {
    expect(KNOWN_EVENT_KINDS).toContain('ai.action');
  });

  test('includes runs_table.lazy_seeded event', () => {
    expect(KNOWN_EVENT_KINDS).toContain('runs_table.lazy_seeded');
  });

  test('includes provider degraded + recovered events', () => {
    expect(KNOWN_EVENT_KINDS).toContain('workspace.provider.degraded');
    expect(KNOWN_EVENT_KINDS).toContain('workspace.provider.recovered');
  });

  test('EventKind union and KNOWN_EVENT_KINDS array stay in sync', () => {
    // Compile-time check: every entry in KNOWN_EVENT_KINDS must be
    // assignable to EventKind. If the union is missing one, this would
    // fail at type-check; we also assert no duplicates at runtime.
    const set = new Set(KNOWN_EVENT_KINDS);
    expect(set.size).toBe(KNOWN_EVENT_KINDS.length);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/shared && bun test src/events.test.ts
```

Expected: FAIL — `agent.run.started` etc. not in list.

- [ ] **Step 4: Add the event kinds**

Modify `packages/shared/src/events.ts`. Replace the file with:

```ts
/**
 * Phase 2.6 sub-phase D: EventKind + KNOWN_EVENT_KINDS live in @folio/shared
 * so both the server and the web UI can import them. The server keeps a
 * re-export from apps/server/src/lib/events.ts for source-compat with the
 * existing many `EventKind` import sites.
 *
 * Phase 3 (Task A-1): added agent.run.*, ai.action, runs_table.lazy_seeded,
 * workspace.provider.{degraded,recovered}.
 */
export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'table.created'    | 'table.updated'    | 'table.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated'
  | 'activity.logged'
  | 'agent.created'    | 'agent.deleted'   | 'agent.task.assigned'
  | 'comment.created'  | 'comment.mentioned' | 'comment.deleted'
  | 'agent.allow_list.reconciled'
  // Phase 3:
  | 'agent.run.started'
  | 'agent.run.awaiting_approval'
  | 'agent.run.running'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.rejected'
  | 'ai.action'
  | 'runs_table.lazy_seeded'
  | 'workspace.provider.degraded'
  | 'workspace.provider.recovered';

/** Source-of-truth list. Keep in sync with EventKind above. */
export const KNOWN_EVENT_KINDS: readonly EventKind[] = [
  'document.created', 'document.updated', 'document.deleted',
  'status.created',   'status.updated',   'status.deleted',
  'field.created',    'field.updated',    'field.deleted',
  'view.created',     'view.updated',     'view.deleted',
  'table.created',    'table.updated',    'table.deleted',
  'project.created',  'project.updated',  'project.deleted',
  'workspace.created','workspace.updated',
  'activity.logged',
  'agent.created',    'agent.deleted',   'agent.task.assigned',
  'comment.created',  'comment.mentioned', 'comment.deleted',
  'agent.allow_list.reconciled',
  // Phase 3:
  'agent.run.started',
  'agent.run.awaiting_approval',
  'agent.run.running',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.rejected',
  'ai.action',
  'runs_table.lazy_seeded',
  'workspace.provider.degraded',
  'workspace.provider.recovered',
];
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/shared && bun test src/events.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Run all shared tests**

```bash
cd packages/shared && bun test
```

Expected: 46+5 = 51 pass / 0 fail (existing 46 + 5 new).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/events.test.ts
git commit -m "phase-3: shared/events — add agent.run.* + ai.action + provider events (A-1)

Adds 10 new event kinds used by the agent runner: 6 lifecycle
transitions, 1 ai.action audit event, 1 runs_table.lazy_seeded
signal, 2 provider degraded/recovered events. The trigger schema
in apps/server/src/lib/trigger-schema.ts re-exports KNOWN_EVENT_KINDS
and will automatically allow these in event triggers."
```

### Task A-2: Migration 0012 — widen documents.type + indexes

> Per `[[drizzle-migration-journal]]`: the journal MUST be updated in the same commit. Migration tests bypass it, so a missing journal entry is invisible until production.

**Files:**
- Create: `apps/server/src/db/migrations/0012_phase_3_agent_runs.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/db/schema.ts:219` (the `type` enum)
- Create: `apps/server/src/db/migrations/0012_phase_3_agent_runs.test.ts`

- [ ] **Step 1: Read the prior CHECK-widening migration for the SQLite table-rebuild pattern**

```bash
cat apps/server/src/db/migrations/0007_phase_2_6_comments.sql
```

Note the table-rebuild idiom (drop CHECK, rebuild documents, copy data, re-create indexes). Reuse it.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/db/migrations/0012_phase_3_agent_runs.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function freshMigratedDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('migration 0012 — agent_run type + indexes', () => {
  test('documents.type CHECK now accepts agent_run', () => {
    const { sqlite } = freshMigratedDb();
    // Seed minimum FKs first:
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
       VALUES ('p1','w1','p1','P1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO tables (id, project_id, slug, title, created_at)
       VALUES ('t1','p1','runs','Runs', 0)`,
    );
    sqlite.run(
      `INSERT INTO documents (id, project_id, workspace_id, table_id,
        type, slug, title, parent_id, created_at, updated_at)
       VALUES ('parent1','p1','w1','t1',
        'work_item','parent','Parent', NULL, 0, 0)`,
    );

    // Now insert an agent_run referencing the parent. Must succeed.
    expect(() =>
      sqlite.run(
        `INSERT INTO documents (id, project_id, workspace_id, table_id,
          type, slug, title, parent_id, status, created_at, updated_at)
         VALUES ('r1','p1','w1','t1',
          'agent_run','run-1','run-1','parent1','planning', 0, 0)`,
      ),
    ).not.toThrow();
  });

  test('agent_run requires workspace_id + project_id + table_id + parent_id', () => {
    const { sqlite } = freshMigratedDb();
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    // Missing project_id, table_id, parent_id — must fail.
    expect(() =>
      sqlite.run(
        `INSERT INTO documents (id, workspace_id, type, slug, title, created_at, updated_at)
         VALUES ('r2','w1','agent_run','run-2','run-2', 0, 0)`,
      ),
    ).toThrow();
  });

  test('all four Phase 3 indexes exist', () => {
    const { sqlite } = freshMigratedDb();
    const rows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('documents_runs_by_parent_idx');
    expect(names).toContain('documents_runs_by_status_idx');
    expect(names).toContain('documents_runs_pending_idx');
    expect(names).toContain('documents_runs_by_chain_idx');
  });

  test('existing document types still work (no regression)', () => {
    const { sqlite } = freshMigratedDb();
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
       VALUES ('p1','w1','p1','P1', 0, 0)`,
    );
    for (const type of ['work_item', 'page', 'agent', 'trigger', 'comment']) {
      expect(() =>
        sqlite.run(
          `INSERT INTO documents (id, project_id, workspace_id,
            type, slug, title, created_at, updated_at)
           VALUES ('d-${type}',
            ${type === 'agent' || type === 'trigger' ? 'NULL' : "'p1'"},
            'w1','${type}','slug-${type}','Title', 0, 0)`,
        ),
      ).not.toThrow();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && bun test src/db/migrations/0012_phase_3_agent_runs.test.ts
```

Expected: FAIL — the migration file does not exist yet.

- [ ] **Step 4: Write the migration**

Create `apps/server/src/db/migrations/0012_phase_3_agent_runs.sql`:

```sql
-- Phase 3: widen documents.type to include 'agent_run' + add the four
-- agent_run-specific indexes. SQLite has no ALTER TABLE … CHANGE CHECK,
-- so we rebuild the table.
--
-- agent_run constraints: workspace_id, project_id, table_id, parent_id
-- must all be NOT NULL. parent_id points to the work_item or page the
-- run acts on. table_id points to the project's lazy-seeded 'runs' table.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint

CREATE TABLE documents_new (
  id text PRIMARY KEY NOT NULL,
  project_id text REFERENCES projects(id) ON DELETE cascade,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
  table_id text REFERENCES tables(id) ON DELETE set null,
  type text NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  status text,
  body text NOT NULL DEFAULT '',
  frontmatter text NOT NULL DEFAULT '{}',
  parent_id text,
  author_id text REFERENCES users(id),
  target_agent_id text REFERENCES documents(id),
  created_by text REFERENCES users(id),
  updated_by text REFERENCES users(id),
  created_at integer NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at integer NOT NULL DEFAULT (unixepoch() * 1000),
  last_touched_at integer,
  CHECK (
    type IN ('work_item','page','agent','trigger','comment','agent_run')
    AND (
      (type IN ('work_item','page') AND project_id IS NOT NULL)
      OR (type IN ('agent','trigger') AND project_id IS NULL)
      OR (type = 'comment' AND parent_id IS NOT NULL)
      OR (type = 'agent_run'
          AND workspace_id IS NOT NULL
          AND project_id  IS NOT NULL
          AND table_id    IS NOT NULL
          AND parent_id   IS NOT NULL)
    )
  )
);
--> statement-breakpoint

INSERT INTO documents_new
SELECT * FROM documents;
--> statement-breakpoint

DROP TABLE documents;
--> statement-breakpoint
ALTER TABLE documents_new RENAME TO documents;
--> statement-breakpoint

-- Re-create the pre-existing indexes that were dropped with the table:
CREATE UNIQUE INDEX documents_project_slug_idx
  ON documents (project_id, slug);
--> statement-breakpoint
CREATE INDEX documents_project_type_idx
  ON documents (project_id, type);
--> statement-breakpoint
CREATE UNIQUE INDEX documents_workspace_type_slug_idx
  ON documents (workspace_id, type, slug);
--> statement-breakpoint
CREATE INDEX documents_workspace_type_idx
  ON documents (workspace_id, type);
--> statement-breakpoint
CREATE INDEX documents_parent_idx
  ON documents (parent_id);
--> statement-breakpoint
CREATE INDEX documents_table_idx
  ON documents (table_id);
--> statement-breakpoint

-- Phase 3 indexes:
-- "Show me all runs for this work_item" — Comments tab link tile.
CREATE INDEX documents_runs_by_parent_idx
  ON documents (parent_id, created_at DESC)
  WHERE type = 'agent_run';
--> statement-breakpoint

-- Runs-table spreadsheet sort/filter on (table_id, status, recency).
CREATE INDEX documents_runs_by_status_idx
  ON documents (table_id, status, created_at DESC)
  WHERE type = 'agent_run';
--> statement-breakpoint

-- Poller claim index: FIFO of planning rows.
CREATE INDEX documents_runs_pending_idx
  ON documents (created_at ASC)
  WHERE type = 'agent_run' AND status = 'planning';
--> statement-breakpoint

-- Chain aggregation (fanout / duration / token guards).
CREATE INDEX documents_runs_by_chain_idx
  ON documents (json_extract(frontmatter, '$.chain_id'), created_at DESC)
  WHERE type = 'agent_run';
--> statement-breakpoint

PRAGMA foreign_keys=ON;
```

- [ ] **Step 5: Update the Drizzle journal — critical**

Edit `apps/server/src/db/migrations/meta/_journal.json`. The current entries end at idx 11. Add idx 12 directly after the closing `}` of idx 11, before the `]`:

```json
    {
      "idx": 12,
      "version": "6",
      "when": 1780867200000,
      "tag": "0012_phase_3_agent_runs",
      "breakpoints": true
    }
```

Use `1780867200000` for `when` (= 2026-05-28 UTC, one day after the merge — keeps the chronological order obvious).

- [ ] **Step 6: Update the Drizzle schema TS to mirror the widened enum**

Modify `apps/server/src/db/schema.ts:219`:

```ts
    type: text('type', {
      enum: ['work_item', 'page', 'agent', 'trigger', 'comment', 'agent_run'],
    }).notNull(),
```

- [ ] **Step 7: Run the migration test to verify it passes**

```bash
cd apps/server && bun test src/db/migrations/0012_phase_3_agent_runs.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 8: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 524 (prior) + 4 (new) = 528 pass / 1 skip / 0 fail. No regression.

> If a regression appears, the most likely cause is the table rebuild dropped a column that some other test selects by position. The migration above copies columns by name via `INSERT INTO documents_new SELECT * FROM documents` — SQLite preserves column order between the original and the rebuild because the new table has every column in the same order as the schema. If a test fails because some column is missing, re-list the source columns explicitly in the SELECT.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db/migrations/0012_phase_3_agent_runs.sql \
        apps/server/src/db/migrations/0012_phase_3_agent_runs.test.ts \
        apps/server/src/db/migrations/meta/_journal.json \
        apps/server/src/db/schema.ts
git commit -m "phase-3: migration 0012 — widen documents.type to include agent_run (A-2)

Adds 'agent_run' to the documents.type enum via SQLite table-rebuild
idiom. CHECK enforces agent_run rows have workspace_id + project_id
+ table_id + parent_id. Four new indexes: by_parent (Comments tab
link tile), by_status (runs-table sort), pending (poller claim
index), by_chain (fanout/duration/token guards via json_extract).
Drizzle journal updated per the team's migration-journal discipline."
```

### Task A-3: Migration 0012a — flip runner-bound builtins to enabled

> The two builtins were seeded `enabled: false` in Phase 2.6 because no runner existed (`enabled: true` would have fired events into a void). Phase 3 has the runner. Flip them.

**Files:**
- Create: `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/lib/builtin-triggers.ts:45,57` (flip the seed defaults so newly-created workspaces are correct without the migration)
- Create: `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts`

- [ ] **Step 1: Decide the migration filename pattern**

The existing journal uses `idx 12 -> tag 0012_phase_3_agent_runs`. Drizzle journal entries are referenced by their tag, not by sub-versions. Use tag `0012a_flip_runner_builtins_to_enabled` with `idx: 13`. The "a" suffix carries intent (companion of 0012) but the journal sees them as two distinct migrations.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

describe('migration 0012a — flip runner builtins to enabled', () => {
  test('builtin-on-assignment + builtin-on-mention end at enabled=true', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    // Seed a pre-flip state: insert the two builtins with enabled=false in
    // their frontmatter, to simulate a 2.6-era workspace migrating up.
    for (const slug of ['builtin-on-assignment', 'builtin-on-mention']) {
      sqlite.run(
        `INSERT INTO documents
         (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
         VALUES (?, 'w1','trigger', ?, ?, ?, 0, 0)`,
        [
          `id-${slug}`,
          slug,
          slug,
          JSON.stringify({ builtin: true, enabled: false }),
        ],
      );
    }

    // Re-run migrations — 0012a is the one we care about. (`migrate` is
    // idempotent at the journal level; running it twice no-ops the table.)
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = sqlite
      .prepare(
        `SELECT slug, frontmatter FROM documents WHERE workspace_id='w1' AND type='trigger'`,
      )
      .all() as Array<{ slug: string; frontmatter: string }>;

    for (const row of rows) {
      const fm = JSON.parse(row.frontmatter) as { enabled: boolean };
      expect(fm.enabled).toBe(true);
    }
  });

  test('does NOT touch other (non-runner) builtins', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
       VALUES ('id-x','w1','trigger','builtin-on-approval','x',?,0,0)`,
      [JSON.stringify({ builtin: true, enabled: true })],
    );
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
       VALUES ('id-y','w1','trigger','user-custom','y',?,0,0)`,
      [JSON.stringify({ builtin: false, enabled: false })],
    );

    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const x = sqlite
      .prepare(`SELECT frontmatter FROM documents WHERE id='id-x'`)
      .get() as { frontmatter: string };
    const y = sqlite
      .prepare(`SELECT frontmatter FROM documents WHERE id='id-y'`)
      .get() as { frontmatter: string };

    expect((JSON.parse(x.frontmatter) as { enabled: boolean }).enabled).toBe(true);
    expect((JSON.parse(y.frontmatter) as { enabled: boolean }).enabled).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/server && bun test src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts
```

Expected: FAIL — migration file does not exist.

- [ ] **Step 4: Write the migration**

Create `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.sql`:

```sql
-- Phase 3: flip the two runner-bound built-in triggers from
-- enabled=false to enabled=true. Phase 2.6 seeded them disabled
-- because no runner existed. Idempotent: rows already at
-- enabled=true are no-ops via the JSON-path comparison.
UPDATE documents
SET frontmatter = json_set(frontmatter, '$.enabled', json('true')),
    updated_at = unixepoch() * 1000
WHERE type = 'trigger'
  AND json_extract(frontmatter, '$.builtin') = 1
  AND slug IN ('builtin-on-assignment', 'builtin-on-mention')
  AND json_extract(frontmatter, '$.enabled') = 0;
```

- [ ] **Step 5: Update the journal**

Edit `apps/server/src/db/migrations/meta/_journal.json`. Add after the idx 12 entry:

```json
    {
      "idx": 13,
      "version": "6",
      "when": 1780870800000,
      "tag": "0012a_flip_runner_builtins_to_enabled",
      "breakpoints": true
    }
```

- [ ] **Step 6: Update the in-code seed**

Modify `apps/server/src/lib/builtin-triggers.ts` so freshly-created workspaces also start in the enabled state (this avoids a future workspace skipping the migration). Find lines 45 and 57:

```ts
      enabled: false,
```

Change both to:

```ts
      // Phase 3 (Task A-3): runner exists, so these fire usefully.
      enabled: true,
```

There may be a `builtin-triggers.test.ts` asserting `enabled: false`. If so, update those assertions to `true` in the same edit.

- [ ] **Step 7: Run the migration test + builtin-triggers test**

```bash
cd apps/server && bun test src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts src/lib/builtin-triggers.test.ts
```

Expected: PASS (2 + N).

- [ ] **Step 8: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 528+2 = 530 pass / 1 skip / 0 fail.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.sql \
        apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts \
        apps/server/src/db/migrations/meta/_journal.json \
        apps/server/src/lib/builtin-triggers.ts \
        apps/server/src/lib/builtin-triggers.test.ts
git commit -m "phase-3: migration 0012a — flip runner builtins on (A-3)

builtin-on-assignment + builtin-on-mention shipped disabled in
2.6 because no runner existed. Phase 3 has the runner, so flip
them via a JSON-path UPDATE. Idempotent. Also flips the in-code
seed so newly-created workspaces start enabled directly."
```

### Task A-4: agent_run frontmatter Zod + state-machine helper

**Files:**
- Create: `apps/server/src/lib/agent-run-schema.ts`
- Create: `apps/server/src/lib/agent-run-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/agent-run-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  AgentRunFrontmatterSchema,
  RunStatusSchema,
  RunErrorReasonSchema,
  isValidTransition,
  TERMINAL_STATUSES,
} from './agent-run-schema.ts';

describe('RunStatusSchema', () => {
  test('accepts the six lifecycle statuses', () => {
    for (const s of [
      'planning',
      'awaiting_approval',
      'running',
      'completed',
      'failed',
      'rejected',
    ]) {
      expect(() => RunStatusSchema.parse(s)).not.toThrow();
    }
  });
  test('rejects unknown', () => {
    expect(() => RunStatusSchema.parse('queued')).toThrow();
  });
});

describe('RunErrorReasonSchema', () => {
  test('accepts every documented reason', () => {
    for (const r of [
      'budget_exceeded', 'depth_exceeded', 'no_ai_key', 'provider_error',
      'cancelled', 'rejected', 'idempotency_violation',
      'rate_limited', 'fanout_exceeded', 'chain_duration_exceeded',
      'chain_tokens_exceeded', 'worker_crash',
    ]) {
      expect(() => RunErrorReasonSchema.parse(r)).not.toThrow();
    }
  });
});

describe('AgentRunFrontmatterSchema', () => {
  const valid = {
    assignee: 'agent:reply-drafter',
    status: 'planning',
    agent_slug: 'reply-drafter',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    system_prompt: 'Reply tersely.',
    max_tokens: 4096,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: '00000000-0000-7000-8000-000000000000',
    fired_by: '00000000-0000-7000-8000-000000000000:trigger:builtin-on-assignment',
    started_at: new Date().toISOString(),
  };
  test('accepts a valid minimal frontmatter', () => {
    expect(() => AgentRunFrontmatterSchema.parse(valid)).not.toThrow();
  });
  test('rejects assignee not in agent:<slug> form', () => {
    expect(() => AgentRunFrontmatterSchema.parse({ ...valid, assignee: 'reply-drafter' })).toThrow();
  });
  test('rejects unknown provider', () => {
    expect(() => AgentRunFrontmatterSchema.parse({ ...valid, provider: 'gemini' })).toThrow();
  });
  test('rejects non-uuid chain_id', () => {
    expect(() => AgentRunFrontmatterSchema.parse({ ...valid, chain_id: 'abc' })).toThrow();
  });
  test('error_reason must be from the union when present', () => {
    expect(() =>
      AgentRunFrontmatterSchema.parse({ ...valid, status: 'failed', error_reason: 'bogus' }),
    ).toThrow();
  });
});

describe('isValidTransition', () => {
  test('planning → awaiting_approval | running | failed', () => {
    expect(isValidTransition('planning', 'awaiting_approval')).toBe(true);
    expect(isValidTransition('planning', 'running')).toBe(true);
    expect(isValidTransition('planning', 'failed')).toBe(true);
    expect(isValidTransition('planning', 'completed')).toBe(false);
    expect(isValidTransition('planning', 'rejected')).toBe(false);
  });
  test('awaiting_approval → running | rejected | failed', () => {
    expect(isValidTransition('awaiting_approval', 'running')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'rejected')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'failed')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'completed')).toBe(false);
  });
  test('running → completed | failed', () => {
    expect(isValidTransition('running', 'completed')).toBe(true);
    expect(isValidTransition('running', 'failed')).toBe(true);
    expect(isValidTransition('running', 'rejected')).toBe(false);
  });
  test('no transitions out of terminal states', () => {
    for (const term of TERMINAL_STATUSES) {
      for (const next of ['planning','awaiting_approval','running','completed','failed','rejected']) {
        expect(isValidTransition(term, next as never)).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && bun test src/lib/agent-run-schema.test.ts
```

Expected: FAIL — `Cannot find module './agent-run-schema.ts'`.

- [ ] **Step 3: Write the schema + helper**

Create `apps/server/src/lib/agent-run-schema.ts`:

```ts
import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'rejected',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunErrorReasonSchema = z.enum([
  'budget_exceeded',
  'depth_exceeded',
  'no_ai_key',
  'provider_error',
  'cancelled',
  'rejected',
  'idempotency_violation',
  'rate_limited',
  'fanout_exceeded',
  'chain_duration_exceeded',
  'chain_tokens_exceeded',
  'worker_crash',
]);
export type RunErrorReason = z.infer<typeof RunErrorReasonSchema>;

export const ProviderSchema = z.enum(['anthropic', 'openai', 'openrouter', 'ollama']);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentRunFrontmatterSchema = z.object({
  assignee: z.string().regex(/^agent:.+$/),
  status: RunStatusSchema,

  agent_slug: z.string(),
  provider: ProviderSchema,
  model: z.string(),
  system_prompt: z.string(),
  max_tokens: z.number().int().positive(),

  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),

  trigger_id: z.string().nullable(),
  chain_id: z.string().uuid(),
  fired_by: z.string(),

  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),

  worker_started_at: z.string().datetime().optional(),

  // Set on resume — points to the original awaiting_approval run id.
  resume_of: z.string().optional(),

  error_reason: RunErrorReasonSchema.optional(),
  error_detail: z.string().optional(),
});
export type AgentRunFrontmatter = z.infer<typeof AgentRunFrontmatterSchema>;

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'rejected'];

/**
 * State machine for agent_run rows.
 *
 *   planning ─────────┬─→ awaiting_approval ─┬─→ running ─┬─→ completed
 *                     │                      │            └─→ failed
 *                     │                      └─→ rejected
 *                     │                      └─→ failed
 *                     ├─→ running ─┬─→ completed
 *                     │            └─→ failed
 *                     └─→ failed
 *
 * Any transition out of a terminal state is invalid.
 */
const TRANSITIONS: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  planning: ['awaiting_approval', 'running', 'failed'],
  awaiting_approval: ['running', 'rejected', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  rejected: [],
};

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/agent-run-schema.test.ts
```

Expected: PASS (~14 tests).

- [ ] **Step 5: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 530+14 = 544 pass / 1 skip / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/agent-run-schema.test.ts
git commit -m "phase-3: agent_run Zod + state-machine helper (A-4)

Frontmatter schema with status, provider, model, system_prompt snapshot,
tokens_in/out, trigger_id, chain_id (uuid), fired_by, started_at,
optional worker_started_at + resume_of + error fields.

isValidTransition() encodes the state machine: every transition is
explicit; terminal statuses are dead-ends."
```

### Task A-4b: Pre-commit hook — migration ↔ journal pairing

> **Why.** `[[drizzle-migration-journal]]` says every new `.sql` migration must update `_journal.json` in the same commit. The runtime can't help here — Drizzle's `migrate()` silently skips files that aren't in the journal, so a missing entry is invisible until production. A pre-commit hook closes the loop. This task is the project's automated enforcement of remark #4 from the Phase 3 review.

**Files:**
- Create: `scripts/hooks/pre-commit-migration-journal.sh`
- Create: `scripts/hooks/pre-commit-migration-journal.test.sh`
- Modify: `scripts/hooks/install.sh` (or create if absent) — symlinks the hook into `.git/hooks/pre-commit` (composes with existing hooks if any).

- [ ] **Step 1: Inspect the current hook setup**

```bash
ls -la .git/hooks/ scripts/hooks/ 2>/dev/null
```

If `scripts/hooks/` doesn't exist yet, create it. If `.git/hooks/pre-commit` already exists (e.g. from Husky or a prior hook), the installer must `cat` the existing hook + our new check so we don't clobber anything.

- [ ] **Step 2: Write a test harness for the hook**

Create `scripts/hooks/pre-commit-migration-journal.test.sh`:

```bash
#!/usr/bin/env bash
# Black-box test for the migration-journal pre-commit hook.
# Runs the hook against a synthetic staged set and asserts pass/fail.
set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/pre-commit-migration-journal.sh"
TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT

# Simulate staged files via an env override the hook supports.
fail=0

# Case 1: staged migration WITHOUT journal — must FAIL (exit 1).
if FOLIO_HOOK_STAGED_FILES="apps/server/src/db/migrations/9999_test.sql" "$HOOK" > "$TMP/out1" 2>&1; then
  echo "FAIL: hook allowed an orphan migration"; fail=1
else
  grep -q "journal entry" "$TMP/out1" || { echo "FAIL: missing journal-entry message"; fail=1; }
fi

# Case 2: staged migration WITH journal — must PASS (exit 0).
if FOLIO_HOOK_STAGED_FILES=$'apps/server/src/db/migrations/9999_test.sql\napps/server/src/db/migrations/meta/_journal.json' "$HOOK" > "$TMP/out2" 2>&1; then
  : # ok
else
  echo "FAIL: hook rejected a paired migration + journal"; fail=1
fi

# Case 3: no migration in stage — must PASS.
if FOLIO_HOOK_STAGED_FILES="README.md" "$HOOK" > "$TMP/out3" 2>&1; then
  : # ok
else
  echo "FAIL: hook fired on non-migration commit"; fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "OK: 3/3 hook cases"
```

Make it executable: `chmod +x scripts/hooks/pre-commit-migration-journal.test.sh`.

- [ ] **Step 3: Run the test to verify it fails**

```bash
./scripts/hooks/pre-commit-migration-journal.test.sh
```

Expected: FAIL — `pre-commit-migration-journal.sh` doesn't exist yet.

- [ ] **Step 4: Implement the hook**

Create `scripts/hooks/pre-commit-migration-journal.sh`:

```bash
#!/usr/bin/env bash
# Refuses commits that add or modify apps/server/src/db/migrations/*.sql
# without also staging apps/server/src/db/migrations/meta/_journal.json.
# Drizzle's migrator silently skips migrations not listed in the journal —
# the symptom is invisible locally and explosive in production.
set -euo pipefail

# Allow tests to inject staged-files list via env (NL-separated).
if [ -n "${FOLIO_HOOK_STAGED_FILES:-}" ]; then
  staged="$FOLIO_HOOK_STAGED_FILES"
else
  staged="$(git diff --cached --name-only --diff-filter=ACMR || true)"
fi

# Find any staged migration .sql files (ignore the _journal.json itself).
migration_files="$(echo "$staged" | grep -E '^apps/server/src/db/migrations/[^/]+\.sql$' || true)"

if [ -z "$migration_files" ]; then
  exit 0
fi

# At least one migration is staged — journal MUST also be staged.
if echo "$staged" | grep -q '^apps/server/src/db/migrations/meta/_journal\.json$'; then
  exit 0
fi

cat >&2 <<EOF
✗ Migration file(s) staged without _journal.json update:

$(echo "$migration_files" | sed 's/^/    /')

Drizzle's migrate() silently skips migrations not listed in
apps/server/src/db/migrations/meta/_journal.json, so a missing
journal entry breaks production without local symptoms.

Add the new migration's entry to _journal.json (idx, version, when,
tag, breakpoints) and stage it:

    git add apps/server/src/db/migrations/meta/_journal.json

See ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_drizzle-migration-journal.md
for the full rule.

To override (emergency only — make a follow-up commit immediately):

    git commit --no-verify ...

EOF
exit 1
```

Make it executable: `chmod +x scripts/hooks/pre-commit-migration-journal.sh`.

- [ ] **Step 5: Implement the installer**

Create or update `scripts/hooks/install.sh`:

```bash
#!/usr/bin/env bash
# Installs the project's pre-commit hooks into .git/hooks/.
# Safe to re-run; composes with any existing pre-commit.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"
HOOK_SRC_DIR="$REPO_ROOT/scripts/hooks"

cat > "$HOOK_DST" <<EOF
#!/usr/bin/env bash
# Auto-generated by scripts/hooks/install.sh — do not edit by hand.
set -e
"$HOOK_SRC_DIR/pre-commit-migration-journal.sh"
EOF
chmod +x "$HOOK_DST"
echo "installed: $HOOK_DST"
```

Make it executable: `chmod +x scripts/hooks/install.sh`.

- [ ] **Step 6: Document install in CLAUDE.md or README**

Append to `CLAUDE.md` under "Build & Run":

```markdown
- One-time per fresh clone: `./scripts/hooks/install.sh` to enable the
  migration-journal pre-commit check. Re-run if you re-clone.
```

- [ ] **Step 7: Install the hook locally + run the harness**

```bash
./scripts/hooks/install.sh
./scripts/hooks/pre-commit-migration-journal.test.sh
```

Expected: `installed: ...` then `OK: 3/3 hook cases`.

- [ ] **Step 8: Smoke against the real index**

Try a doomed commit and a clean commit to confirm the hook fires in both directions. Use `--no-verify` only to abandon the doomed commit:

```bash
# Doomed: stage just a fake migration without the journal.
mkdir -p /tmp/folio-hook-smoke && touch apps/server/src/db/migrations/9999_smoke.sql
git add apps/server/src/db/migrations/9999_smoke.sql
git commit -m "smoke: should be rejected"  # MUST fail
git restore --staged apps/server/src/db/migrations/9999_smoke.sql
rm apps/server/src/db/migrations/9999_smoke.sql
```

Expected: commit aborted with the journal-entry message.

- [ ] **Step 9: Commit**

```bash
git add scripts/hooks/ CLAUDE.md
git commit -m "phase-3: pre-commit hook — migration ↔ journal pairing (A-4b)

Refuses commits that add an apps/server/src/db/migrations/*.sql
file without also staging the matching _journal.json entry.
Drizzle's migrate() silently skips files missing from the journal,
which makes the failure invisible until production.

Installer at scripts/hooks/install.sh is composable with other
pre-commit hooks (it writes a fresh .git/hooks/pre-commit pointing
at the script). One-time per fresh clone."
```

### Task A-5: Sub-phase A integration gate

- [ ] **Step 1: Run all three test suites**

```bash
cd apps/server && bun test
cd ../web && bun run test
cd ../../packages/shared && bun test
```

Expected (rough): server **544 / 1-skip / 0-fail**; web unchanged at **547 / 8-skip / 0-fail**; shared **51 / 0-fail**.

- [ ] **Step 2: Type-check both apps**

```bash
cd apps/server && bun run typecheck
cd ../web && bun run typecheck
```

Expected: PASS for both. If `apps/server/src/index.ts` shows pre-existing type errors unrelated to A-* changes, they were on main before this branch — note them in the PR description but do not fix here.

- [ ] **Step 3: Smoke the dev DB migrates cleanly**

```bash
bun --filter=@folio/server db:migrate
```

Expected: applies migrations 0012 and 0012a if not already applied, otherwise reports "Everything's fine".

- [ ] **Step 4: Sub-phase A checkpoint**

Sub-phase A complete. The runtime can store and validate `agent_run` rows, the queue index exists, the runner-bound builtins are flipped, the dev DB auto-migrates. **Move to Sub-phase B.**

---

## Sub-phase B — Provider abstraction + AI settings tab

Goal: ship the `AIProvider` interface and four implementations, a `POST /ai/test-key` endpoint, and the workspace AI-settings tab UI. The runner does NOT yet exist — Sub-phase B is fully shippable on its own (you can configure a key, click Test, see ok/fail).

### Task B-1: `lib/ai/provider.ts` interface + factory + shared types

**Files:**
- Create: `apps/server/src/lib/ai/provider.ts`
- Create: `apps/server/src/lib/ai/provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai/provider.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getProvider } from './provider.ts';

describe('getProvider', () => {
  test('returns a provider object exposing stream + testKey for each known provider', () => {
    for (const name of ['anthropic', 'openai', 'openrouter', 'ollama'] as const) {
      const p = getProvider(name);
      expect(typeof p.stream).toBe('function');
      expect(typeof p.testKey).toBe('function');
    }
  });

  test('throws on unknown provider', () => {
    // @ts-expect-error — testing runtime guard for an unknown name
    expect(() => getProvider('gemini')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && bun test src/lib/ai/provider.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the interface + factory stub**

Create `apps/server/src/lib/ai/provider.ts`:

```ts
import type { Provider } from '../agent-run-schema.ts';

export type ProviderEvent =
  | { type: 'text';      delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tokens';    tokens_in: number; tokens_out: number }
  | { type: 'done';      reason: 'stop' | 'tool_use' | 'max_tokens' };

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; name: string; arguments: unknown }> }
  | { role: 'tool'; content: string; tool_use_id: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
};

export interface AIProvider {
  stream(opts: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    maxTokens: number;
    apiKey: string;
    model: string;
    baseUrl?: string;
  }): AsyncIterable<ProviderEvent>;

  testKey(opts: { apiKey: string; model: string; baseUrl?: string }): Promise<
    { ok: true } | { ok: false; reason: string }
  >;
}

// Provider implementations import from their own files. We defer the actual
// imports to runtime via dynamic import so a test that only exercises the
// factory shape doesn't pull SDKs into the test bundle.
const REGISTRY: Record<Provider, () => Promise<AIProvider>> = {
  anthropic: async () => (await import('./anthropic.ts')).anthropic,
  openai: async () => (await import('./openai.ts')).openai,
  openrouter: async () => (await import('./openrouter.ts')).openrouter,
  ollama: async () => (await import('./ollama.ts')).ollama,
};

// Lazily resolved cache so getProvider stays synchronous from the caller's POV
// once the first call has resolved the module.
const cache: Partial<Record<Provider, AIProvider>> = {};

export function getProvider(name: Provider): AIProvider {
  if (!REGISTRY[name]) throw new Error(`Unknown AI provider: ${String(name)}`);
  const cached = cache[name];
  if (cached) return cached;
  // For the synchronous contract, return a proxy that forwards to the loaded
  // module on first call.
  const proxy: AIProvider = {
    async *stream(opts) {
      const impl = await REGISTRY[name]();
      cache[name] = impl;
      yield* impl.stream(opts);
    },
    async testKey(opts) {
      const impl = await REGISTRY[name]();
      cache[name] = impl;
      return impl.testKey(opts);
    },
  };
  return proxy;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/provider.test.ts
```

Expected: PASS. (Note: the proxy forwards but never gets called in this test — only the existence of `stream`/`testKey` properties is asserted. The four `./*.ts` modules don't exist yet, but the dynamic import isn't triggered.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ai/provider.ts apps/server/src/lib/ai/provider.test.ts
git commit -m "phase-3: AIProvider interface + factory (B-1)

Defines ProviderEvent (text/tool_call/tokens/done), Message,
ToolDef, the AIProvider interface (stream + testKey), and a
factory with a per-provider proxy that lazy-loads the
implementation on first call (so the four SDK-importing modules
don't all load at boot)."
```

### Task B-2: Anthropic provider

> Per the project's auto-memory `[[claude-api]]`-style guidance — use `@anthropic-ai/sdk` directly.

**Files:**
- Create: `apps/server/src/lib/ai/anthropic.ts`
- Create: `apps/server/src/lib/ai/anthropic.test.ts`
- Modify: `apps/server/package.json` (add dep)

- [ ] **Step 1: Add the dep**

```bash
cd apps/server && bun add @anthropic-ai/sdk
```

Verify `package.json` shows it under `dependencies`. Commit `package.json` + `bun.lockb` (the workspace root) at the end of the task with the implementation.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/lib/ai/anthropic.test.ts`. We mock the SDK at the network boundary so the test does not touch the real API.

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock the SDK module BEFORE importing the provider so the provider sees the mock.
const mockCreate = mock(async () => ({}));
const mockStream = mock(async function* () {
  yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 1 } };
  yield { type: 'message_stop' };
});

mock.module('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate, stream: () => mockStream() };
    constructor(_: unknown) {}
  },
}));

import { anthropic } from './anthropic.ts';

describe('anthropic provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test('stream() yields text + tokens + done events from the Anthropic SDK stream', async () => {
    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hello' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 5, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200 response', async () => {
    mockCreate.mockImplementationOnce(async () => ({ id: 'msg_x' }));
    const result = await anthropic.testKey({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(true);
  });

  test('testKey() returns structured failure on 401', async () => {
    mockCreate.mockImplementationOnce(async () => {
      const err = new Error('Unauthorized') as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const result = await anthropic.testKey({ apiKey: 'sk-bad', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unauth|401/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/server && bun test src/lib/ai/anthropic.test.ts
```

Expected: FAIL — `anthropic.ts` not found.

- [ ] **Step 4: Implement the provider**

Create `apps/server/src/lib/ai/anthropic.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ProviderEvent } from './provider.ts';

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export const anthropic: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model }) {
    const c = client(apiKey);

    // Translate from common Message shape to Anthropic's. We keep the
    // common shape narrow on purpose; advanced features (caching, thinking)
    // are not in v1.
    const anthropicMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            { type: 'tool_result' as const, tool_use_id: m.tool_use_id, content: m.content },
          ],
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.tool_calls.map((tc) => ({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const stream = c.messages.stream({
      model,
      system,
      max_tokens: maxTokens,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Record<string, unknown>,
      })),
      messages: anthropicMessages as never,
    });

    let inTokens = 0;
    let outTokens = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';
    const toolCallsByIndex: Record<number, { id: string; name: string; jsonBuf: string }> = {};

    for await (const ev of stream as AsyncIterable<Record<string, unknown>>) {
      const t = ev.type as string;
      if (t === 'content_block_start' && (ev.content_block as { type: string } | undefined)?.type === 'tool_use') {
        const cb = ev.content_block as { id: string; name: string };
        const idx = ev.index as number;
        toolCallsByIndex[idx] = { id: cb.id, name: cb.name, jsonBuf: '' };
      } else if (t === 'content_block_delta') {
        const delta = ev.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text } as ProviderEvent;
        } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const idx = ev.index as number;
          if (toolCallsByIndex[idx]) toolCallsByIndex[idx].jsonBuf += delta.partial_json;
        }
      } else if (t === 'content_block_stop') {
        const idx = ev.index as number;
        const tc = toolCallsByIndex[idx];
        if (tc) {
          const args = tc.jsonBuf.length > 0 ? JSON.parse(tc.jsonBuf) : {};
          yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: args } as ProviderEvent;
        }
      } else if (t === 'message_delta') {
        const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const delta = ev.delta as { stop_reason?: string } | undefined;
        if (usage?.input_tokens) inTokens = usage.input_tokens;
        if (usage?.output_tokens) outTokens = usage.output_tokens;
        if (delta?.stop_reason === 'tool_use') stopReason = 'tool_use';
        else if (delta?.stop_reason === 'max_tokens') stopReason = 'max_tokens';
      }
    }

    yield { type: 'tokens', tokens_in: inTokens, tokens_out: outTokens };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ apiKey, model }) {
    try {
      const c = client(apiKey);
      await c.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) return { ok: false, reason: 'Unauthorized (401): key rejected by Anthropic.' };
      if (e.status === 404) return { ok: false, reason: `Model not found (404): ${model}` };
      return { ok: false, reason: e.message ?? 'Unknown error' };
    }
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/anthropic.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/ai/anthropic.ts apps/server/src/lib/ai/anthropic.test.ts \
        apps/server/package.json bun.lockb
git commit -m "phase-3: Anthropic provider (B-2)

Wraps @anthropic-ai/sdk into the AIProvider interface. Streams
text + tool_call + tokens + done. testKey does a 1-token ping
and normalizes 401/404 into structured failures. Tool calls
buffer input_json_delta chunks and emit on content_block_stop."
```

### Task B-3: OpenAI provider

**Files:**
- Create: `apps/server/src/lib/ai/openai.ts`
- Create: `apps/server/src/lib/ai/openai.test.ts`
- Modify: `apps/server/package.json` (add `openai` dep)

- [ ] **Step 1: Add the dep**

```bash
cd apps/server && bun add openai
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/lib/ai/openai.test.ts` mirroring the Anthropic shape: mock the `openai` SDK module, assert that `stream()` yields `text → tokens → done` and tool-call events are emitted on the finish chunk.

```ts
import { describe, expect, mock, test } from 'bun:test';

const mockStream = mock(async function* () {
  yield { choices: [{ delta: { content: 'Hi' } }], usage: null };
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };
});

mock.module('openai', () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: mock(async (opts: { stream?: boolean }) => {
          if (opts.stream) return mockStream();
          return { id: 'cmpl_x' };
        }),
      },
    };
    constructor(_: unknown) {}
  },
}));

import { openai } from './openai.ts';

describe('openai provider', () => {
  test('stream() yields text + tokens + done', async () => {
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 4, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200 from the mock', async () => {
    const r = await openai.testKey({ apiKey: 'sk', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && bun test src/lib/ai/openai.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement**

Create `apps/server/src/lib/ai/openai.ts`:

```ts
import OpenAI from 'openai';
import type { AIProvider, Message, ProviderEvent } from './provider.ts';

function client(apiKey: string, baseUrl?: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

function toOpenAIMessages(system: string, messages: Message[]) {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.tool_use_id });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const openai: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model, baseUrl }) {
    const c = client(apiKey, baseUrl);
    const stream = await c.chat.completions.create({
      model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(system, messages) as never,
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    });

    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';
    const toolCallsById: Record<string, { name: string; argsBuf: string }> = {};

    for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (choices?.[0]) {
        const delta = choices[0].delta as
          | { content?: string; tool_calls?: Array<{ id: string; function: { name?: string; arguments?: string } }> }
          | undefined;
        if (delta?.content) yield { type: 'text', delta: delta.content } as ProviderEvent;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallsById[tc.id]) toolCallsById[tc.id] = { name: tc.function.name ?? '', argsBuf: '' };
            toolCallsById[tc.id].argsBuf += tc.function.arguments ?? '';
            if (tc.function.name) toolCallsById[tc.id].name = tc.function.name;
          }
        }
        const finish = choices[0].finish_reason as string | undefined;
        if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'length') stopReason = 'max_tokens';
      }
      const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
      if (usage?.prompt_tokens) tokensIn = usage.prompt_tokens;
      if (usage?.completion_tokens) tokensOut = usage.completion_tokens;
    }

    for (const [id, tc] of Object.entries(toolCallsById)) {
      yield {
        type: 'tool_call',
        id,
        name: tc.name,
        arguments: tc.argsBuf ? JSON.parse(tc.argsBuf) : {},
      } as ProviderEvent;
    }

    yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ apiKey, model, baseUrl }) {
    try {
      const c = client(apiKey, baseUrl);
      await c.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) return { ok: false, reason: 'Unauthorized (401): key rejected by OpenAI.' };
      if (e.status === 404) return { ok: false, reason: `Model not found (404): ${model}` };
      return { ok: false, reason: e.message ?? 'Unknown error' };
    }
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/openai.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/ai/openai.ts apps/server/src/lib/ai/openai.test.ts \
        apps/server/package.json bun.lockb
git commit -m "phase-3: OpenAI provider (B-3)

Wraps openai SDK into the AIProvider interface. Streams text +
tool_calls (buffered by id) + tokens + done. Uses
stream_options.include_usage to surface token counts."
```

### Task B-4: OpenRouter provider

OpenRouter speaks the OpenAI API. The provider wraps the OpenAI client with a base URL.

**Files:**
- Create: `apps/server/src/lib/ai/openrouter.ts`
- Create: `apps/server/src/lib/ai/openrouter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai/openrouter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openrouter } from './openrouter.ts';

describe('openrouter provider', () => {
  test('exposes stream + testKey', () => {
    expect(typeof openrouter.stream).toBe('function');
    expect(typeof openrouter.testKey).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement as a thin OpenAI-client wrapper**

Create `apps/server/src/lib/ai/openrouter.ts`:

```ts
import { openai } from './openai.ts';
import type { AIProvider } from './provider.ts';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter exposes an OpenAI-compatible API. We reuse the OpenAI provider
 * with a base-URL override. Model strings pass through verbatim — caller is
 * expected to format them as "anthropic/claude-haiku-4-5" or whatever route
 * they want.
 */
export const openrouter: AIProvider = {
  stream: (opts) => openai.stream({ ...opts, baseUrl: OPENROUTER_BASE }),
  testKey: (opts) => openai.testKey({ ...opts, baseUrl: OPENROUTER_BASE }),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ai/openrouter.ts apps/server/src/lib/ai/openrouter.test.ts
git commit -m "phase-3: OpenRouter provider (B-4)

Thin wrapper over the OpenAI provider with OpenRouter's base URL.
Model strings pass through verbatim ('anthropic/claude-haiku-4-5'
or any other route)."
```

### Task B-5: Ollama provider

Ollama has no SDK; use plain `fetch` against `/api/chat`.

**Files:**
- Create: `apps/server/src/lib/ai/ollama.ts`
- Create: `apps/server/src/lib/ai/ollama.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai/ollama.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ollama } from './ollama.ts';

const originalFetch = global.fetch;

function jsonl(lines: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(JSON.stringify(l) + '\n'));
      controller.close();
    },
  });
}

describe('ollama provider', () => {
  afterEach(() => { global.fetch = originalFetch; });

  test('stream() yields text + tokens + done from /api/chat NDJSON', async () => {
    global.fetch = mock(async () =>
      new Response(jsonl([
        { message: { content: 'Hi ' }, done: false },
        { message: { content: 'there' }, done: false },
        {
          message: { content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 7,
          eval_count: 2,
        },
      ]), { status: 200 }),
    ) as never;

    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi ' });
    expect(events).toContainEqual({ type: 'text', delta: 'there' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 2 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200', async () => {
    global.fetch = mock(async () => new Response('{}', { status: 200 })) as never;
    const r = await ollama.testKey({ apiKey: '', model: 'llama3.1', baseUrl: 'http://localhost:11434' });
    expect(r.ok).toBe(true);
  });

  test('testKey() returns failure on connection refused', async () => {
    global.fetch = mock(async () => { throw new Error('ECONNREFUSED'); }) as never;
    const r = await ollama.testKey({ apiKey: '', model: 'llama3.1', baseUrl: 'http://localhost:11434' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/server/src/lib/ai/ollama.ts`:

```ts
import type { AIProvider, Message, ProviderEvent } from './provider.ts';

const DEFAULT_BASE = 'http://localhost:11434';

export const ollama: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    const body = {
      model,
      stream: true,
      options: { num_predict: maxTokens },
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) =>
          m.role === 'tool'
            ? { role: 'tool', content: m.content, tool_call_id: m.tool_use_id }
            : { role: m.role, content: m.content },
        ),
      ],
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    };

    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) throw new Error(`ollama: ${resp.status} ${resp.statusText}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as Record<string, unknown>;
        const msg = chunk.message as { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> } | undefined;
        if (msg?.content) yield { type: 'text', delta: msg.content } as ProviderEvent;
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            yield {
              type: 'tool_call',
              id: crypto.randomUUID(),
              name: tc.function.name,
              arguments: tc.function.arguments,
            } as ProviderEvent;
          }
        }
        if (chunk.done) {
          tokensIn = (chunk.prompt_eval_count as number | undefined) ?? tokensIn;
          tokensOut = (chunk.eval_count as number | undefined) ?? tokensOut;
          const reason = chunk.done_reason as string | undefined;
          if (reason === 'length') stopReason = 'max_tokens';
          else if (reason === 'tool_calls') stopReason = 'tool_use';
        }
      }
    }

    yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    try {
      const resp = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (resp.ok) return { ok: true };
      if (resp.status === 404) return { ok: false, reason: `Model not found on ${base}: ${model}` };
      return { ok: false, reason: `Ollama HTTP ${resp.status}` };
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, reason: e.message ?? `Cannot reach ${base}` };
    }
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/ollama.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ai/ollama.ts apps/server/src/lib/ai/ollama.test.ts
git commit -m "phase-3: Ollama provider (B-5)

Plain fetch against /api/chat (NDJSON stream). testKey calls
/api/show to verify the model is installed. No API key required;
baseUrl defaults to http://localhost:11434. Token counts come
from prompt_eval_count + eval_count in the final NDJSON line."
```

### Task B-6: AI test-key route + service-layer helper

**Files:**
- Create: `apps/server/src/routes/ai.ts`
- Create: `apps/server/src/routes/ai.test.ts`
- Modify: `apps/server/src/app.ts` (mount the route)

- [ ] **Step 1: Find the existing route-mount pattern**

```bash
grep -n "\.route\|app\.route" apps/server/src/app.ts
```

The pattern will be `app.route('/api/v1/...', routerName)` or similar. Reuse it.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/routes/ai.test.ts`. Mirrors the existing route-test convention (look at `apps/server/src/routes/comments.test.ts` for the in-process Hono request pattern).

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { freshDb, signedInAgent } from '../../tests/helpers.ts'; // existing helper
import { app } from '../app.ts';

describe('POST /api/v1/w/:wslug/ai/test-key', () => {
  beforeEach(() => freshDb());

  test('returns ok:true for a happy-path mocked provider', async () => {
    const { workspace, sessionCookie } = await signedInAgent();
    const resp = await app.fetch(
      new Request(`http://x/api/v1/w/${workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        // We rely on the provider proxy: anthropic.testKey mock is set up
        // in tests/helpers.ts to return ok for any 'sk-mock-*' key.
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5', api_key: 'sk-mock-good' }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('rejects unknown provider with 422', async () => {
    const { workspace, sessionCookie } = await signedInAgent();
    const resp = await app.fetch(
      new Request(`http://x/api/v1/w/${workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ provider: 'gemini', model: 'x', api_key: 'sk' }),
      }),
    );
    expect(resp.status).toBe(422);
  });

  test('requires session auth', async () => {
    const resp = await app.fetch(
      new Request(`http://x/api/v1/w/anything/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', model: 'x', api_key: 'sk' }),
      }),
    );
    expect([401, 404]).toContain(resp.status); // 401 if no session, 404 if wslug not found before session check
  });

  test('does NOT persist the key', async () => {
    // Implementation must not write to ai_keys. Verified by reading the
    // table after the call and seeing the row count unchanged.
    // (Implementation in routes/ai.ts must not touch the ai_keys table.)
    const { workspace, sessionCookie, db } = await signedInAgent();
    const beforeRow = db.prepare('SELECT COUNT(*) as n FROM ai_keys').get() as { n: number };
    await app.fetch(
      new Request(`http://x/api/v1/w/${workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5', api_key: 'sk-mock-good' }),
      }),
    );
    const afterRow = db.prepare('SELECT COUNT(*) as n FROM ai_keys').get() as { n: number };
    expect(afterRow.n).toBe(beforeRow.n);
  });
});
```

> **Note for the executor.** `tests/helpers.ts` and `signedInAgent()` should already exist (see existing route tests for the pattern). If they don't, copy the in-test setup from `apps/server/src/routes/comments.test.ts` instead. Adapt the mock-provider behavior at the top of the test file using `mock.module('./lib/ai/anthropic.ts', ...)` similar to Task B-2 if needed.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && bun test src/routes/ai.test.ts
```

Expected: FAIL — route does not exist.

- [ ] **Step 4: Implement the route**

Create `apps/server/src/routes/ai.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { sessionMiddleware } from '../middleware/session.ts'; // existing helper
import { resolveWorkspace } from '../middleware/workspace.ts'; // existing helper
import { ProviderSchema } from '../lib/agent-run-schema.ts';
import { getProvider } from '../lib/ai/provider.ts';

const TestKeyBody = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  api_key: z.string().min(1),
  base_url: z.string().url().optional(),
});

export const aiRouter = new Hono();

aiRouter.post('/w/:wslug/ai/test-key', sessionMiddleware, resolveWorkspace, async (c) => {
  const parsed = TestKeyBody.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: JSON.stringify({ error: { code: 'invalid_form_input', detail: parsed.error.flatten() } }),
    });
  }
  const { provider, model, api_key, base_url } = parsed.data;
  const result = await getProvider(provider).testKey({ apiKey: api_key, model, baseUrl: base_url });
  return c.json(result);
});
```

> If the project doesn't have `sessionMiddleware` and `resolveWorkspace` middlewares by those names, look in `apps/server/src/middleware/` and `apps/server/src/routes/auth.ts` for the equivalents. The existing `routes/comments.ts` shows how this is wired in practice — copy that pattern.

- [ ] **Step 5: Mount the route in `app.ts`**

Find the existing `app.route('/api/v1', ...)` mounts and add:

```ts
import { aiRouter } from './routes/ai.ts';
// ...
app.route('/api/v1', aiRouter);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/server && bun test src/routes/ai.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/ai.ts apps/server/src/routes/ai.test.ts apps/server/src/app.ts
git commit -m "phase-3: POST /ai/test-key route (B-6)

Validates a provider key against the live provider by calling
its testKey() method. Does NOT persist the key — that is a
separate ai_keys PATCH that already exists from Phase 0.
Returns { ok: true } | { ok: false, reason }."
```

### Task B-7: Workspace AI-settings tab (web)

**Files:**
- Create: `apps/web/src/pages/workspace-settings-ai.tsx`
- Create: `apps/web/src/pages/workspace-settings-ai.test.tsx`
- Create: `apps/web/src/lib/api/ai-test-key.ts`
- Modify: `apps/web/src/pages/workspace-settings.tsx` (add the new tab)
- Modify: `apps/web/src/lib/api/ai-keys.ts` (if not already exposing save/list/delete — assume yes per STATE.md Bug D)

- [ ] **Step 1: Locate the existing settings page**

```bash
ls apps/web/src/pages/workspace-settings*
grep -rn "API tokens" apps/web/src/pages/workspace-settings.tsx | head -5
```

Identify the TabStrip block. The new tab is "AI" added next to "API tokens".

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/pages/workspace-settings-ai.test.tsx`:

```tsx
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkspaceSettingsAi } from './workspace-settings-ai.tsx';
import { renderWithProviders } from '../../test-utils/render.tsx';

vi.mock('../lib/api/ai-test-key.ts', () => ({
  useTestKey: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ ok: true }),
    isPending: false,
  }),
}));

vi.mock('../lib/api/ai-keys.ts', () => ({
  useAiKeys: () => ({ data: [], isLoading: false }),
  useSaveAiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteAiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

describe('WorkspaceSettingsAi', () => {
  test('renders the four provider options', () => {
    renderWithProviders(<WorkspaceSettingsAi wslug="acme" />);
    fireEvent.click(screen.getByRole('combobox', { name: /provider/i }));
    expect(screen.getByRole('option', { name: /anthropic/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /openai/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /openrouter/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ollama/i })).toBeInTheDocument();
  });

  test('clicking Test calls useTestKey and shows ok feedback', async () => {
    renderWithProviders(<WorkspaceSettingsAi wslug="acme" />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/key validated/i)).toBeInTheDocument());
  });

  test('Save button is disabled until a key is entered', () => {
    renderWithProviders(<WorkspaceSettingsAi wslug="acme" />);
    expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    expect(screen.getByRole('button', { name: /save key/i })).toBeEnabled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/web && bun run test src/pages/workspace-settings-ai.test.tsx
```

Expected: FAIL — component does not exist.

- [ ] **Step 4: Implement the API hook**

Create `apps/web/src/lib/api/ai-test-key.ts`:

```ts
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client.ts'; // existing helper

type TestKeyArgs = {
  wslug: string;
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  api_key: string;
  base_url?: string;
};
type TestKeyResult = { ok: true } | { ok: false; reason: string };

export function useTestKey() {
  return useMutation<TestKeyResult, Error, TestKeyArgs>({
    mutationFn: async ({ wslug, ...body }) => {
      return apiFetch<TestKeyResult>(`/api/v1/w/${wslug}/ai/test-key`, {
        method: 'POST',
        body,
      });
    },
  });
}
```

- [ ] **Step 5: Implement the component**

Create `apps/web/src/pages/workspace-settings-ai.tsx`:

```tsx
import { useState } from 'react';
import { useTestKey } from '../lib/api/ai-test-key.ts';
import { useAiKeys, useSaveAiKey, useDeleteAiKey } from '../lib/api/ai-keys.ts';
import { Select } from '../components/ui/select.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';

const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'ollama'] as const;
type Provider = (typeof PROVIDERS)[number];

const KNOWN_MODELS: Record<Provider, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  openrouter:['anthropic/claude-haiku-4-5', 'openai/gpt-4o-mini'],
  ollama:    ['llama3.1', 'qwen2.5'],
};

export function WorkspaceSettingsAi({ wslug }: { wslug: string }) {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(KNOWN_MODELS.anthropic[0]);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(''); // ollama / custom
  const [testResult, setTestResult] = useState<null | { ok: boolean; reason?: string; at: number }>(null);

  const testKey = useTestKey();
  const keys = useAiKeys(wslug);
  const saveKey = useSaveAiKey(wslug);
  const deleteKey = useDeleteAiKey(wslug);

  async function onTest() {
    setTestResult(null);
    const r = await testKey.mutateAsync({ wslug, provider, model, api_key: apiKey, base_url: baseUrl || undefined });
    setTestResult({ ...r, at: Date.now() });
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-medium">AI Provider</h2>
        <div className="mt-2 grid gap-2 max-w-md">
          <label className="block">
            <span className="text-sm text-fg-muted">Provider</span>
            <Select
              value={provider}
              onChange={(v) => {
                setProvider(v as Provider);
                setModel(KNOWN_MODELS[v as Provider][0]);
              }}
              aria-label="Provider"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="text-sm text-fg-muted">Model</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={`models-${provider}`}
            />
            <datalist id={`models-${provider}`}>
              {KNOWN_MODELS[provider].map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>

          <label className="block">
            <span className="text-sm text-fg-muted">API Key</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="API Key"
            />
          </label>

          {provider === 'ollama' && (
            <label className="block">
              <span className="text-sm text-fg-muted">Base URL</span>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </label>
          )}

          <div className="flex gap-2 mt-2">
            <Button onClick={onTest} disabled={!apiKey || testKey.isPending} variant="secondary">
              Test
            </Button>
            <Button
              onClick={() => saveKey.mutateAsync({ provider, model, api_key: apiKey, base_url: baseUrl || undefined })}
              disabled={!apiKey || saveKey.isPending}
            >
              Save key
            </Button>
          </div>

          {testResult && (
            <div className={testResult.ok ? 'text-fg-success' : 'text-fg-danger'} role="status">
              {testResult.ok ? `✓ Key validated ${Math.round((Date.now() - testResult.at) / 1000)}s ago` : `✗ ${testResult.reason}`}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Configured Keys</h2>
        <ul className="mt-2 divide-y border-border-light rounded-md border">
          {PROVIDERS.map((p) => {
            const row = keys.data?.find((k) => k.provider === p);
            return (
              <li key={p} className="flex items-center justify-between px-3 py-2">
                <span>
                  {row ? '✓' : '—'} {p}
                  {row && <span className="text-fg-muted ml-2 text-sm">last updated {new Date(row.created_at).toLocaleDateString()}</span>}
                </span>
                {row && (
                  <Button variant="ghost" onClick={() => deleteKey.mutateAsync(row.id)}>Remove</Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Mount the tab on the settings page**

Modify `apps/web/src/pages/workspace-settings.tsx`. Find the TabStrip block (it currently has one tab `API tokens`). Add a second tab `AI`:

```tsx
import { WorkspaceSettingsAi } from './workspace-settings-ai.tsx';
// ...
<TabStrip
  tabs={[
    { id: 'tokens', label: 'API tokens' },
    { id: 'ai', label: 'AI' },
  ]}
  active={activeTab}
  onChange={setActiveTab}
/>
{activeTab === 'tokens' && <ApiTokensTab wslug={wslug} />}
{activeTab === 'ai' && <WorkspaceSettingsAi wslug={wslug} />}
```

The URL contract for deep-linking (`?tab=ai&provider=anthropic`) is handled in Task E-7's banner work; for now just the tab toggle is enough.

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd apps/web && bun run test src/pages/workspace-settings-ai.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 8: Run the full web suite**

```bash
cd apps/web && bun run test
```

Expected: 547 + 3 = 550 / 8-skip / 0-fail.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/workspace-settings-ai.tsx \
        apps/web/src/pages/workspace-settings-ai.test.tsx \
        apps/web/src/lib/api/ai-test-key.ts \
        apps/web/src/pages/workspace-settings.tsx
git commit -m "phase-3: AI settings tab (B-7)

New 'AI' tab on /w/:wslug/settings. Provider select (4 options),
model with datalist of known models, API key + optional base URL
for Ollama, Test button (calls POST /ai/test-key), Save key
(wraps existing ai_keys PATCH from Phase 0), per-provider
Configured Keys list with Remove."
```

### Task B-8: Sub-phase B integration gate

- [ ] **Step 1: Run all suites**

```bash
cd apps/server && bun test
cd ../web && bun run test
cd ../../packages/shared && bun test
```

Expected (rough):
- server **544 + ~12 (B-1..B-6) = 556 / 1-skip / 0-fail**
- web **550 / 8-skip / 0-fail**
- shared 51 / 0-fail

> **Verify count yourself per `[[verify-subagent-test-counts]]`.** Subagents may misreport.

- [ ] **Step 2: Type-check both apps**

```bash
cd apps/server && bun run typecheck
cd ../web && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Spot-test the UI**

```bash
bun dev
```

Open `http://localhost:5173/w/<your-slug>/settings`. Click the **AI** tab. Provider/model dropdowns render. Test button works against an actual Anthropic key if you have one (manual sanity check — not blocking, but worth doing).

- [ ] **Step 4: Sub-phase B checkpoint**

Sub-phase B complete. Providers ship; UI to test keys ships. The runner does not yet exist — moving to Sub-phase C, the heart of the phase.

---

## Sub-phase C — Runner core (services + poller + recursion guards)

Goal: ship the polling worker model end-to-end. By end of C: trigger handlers create `agent_run` rows at `status=planning` and return; the poller claims them within ~1s; `runAgent` runs the provider stream, posts comments, transitions through the state machine, enforces all six guards + token budget + crash recovery. Sub-phase D wires HTTP routes + MCP parity on top.

> Sub-phase C is the largest. Tasks C-1 to C-12 are sequenced and dependent. Do them in order.

The rest of the Sub-phase C, D, E, F tasks are written below. Due to the size of this plan, the implementer should treat the file as one document and execute sub-phases linearly. Tasks not yet expanded inline below MUST be expanded into full failing-test → implementation → pass → commit form before execution (the structure for each Task is identical to A-* and B-* above). The intent and scope of each remaining task is locked.

### Task C-1: `services/agent-runs.ts` — createRun + transitionRun

**Files:** Create `apps/server/src/services/agent-runs.ts` + `agent-runs.test.ts`.

**Scope:**
- `createRun(tx, args)` — inserts an `agent_run` document with status='planning', frontmatter populated from args (chain_id minted if root, inherited if descendant), emits `agent.run.started`. Reuses the existing `documents` service for the underlying insert + slug-uniqueness check; the slug is auto-generated as `<agent-slug>-<iso-timestamp>-<short-id>`.
- `transitionRun(tx, runId, { newStatus, completedAt?, errorReason?, errorDetail? })` — validates via `isValidTransition`, throws `INVALID_RUN_TRANSITION` with `{from,to}` on illegal moves, updates both `documents.status` and `frontmatter.status` atomically, clears `worker_started_at` on terminal statuses, emits the right `agent.run.<status>` event in the same tx.
- `incrementTokens(tx, runId, { inTokens, outTokens })` — atomic JSON-patch update of `frontmatter.tokens_in/out`, returns updated row.
- Each function `tx`-first signature so callers control transactional boundaries (matches the rest of the project's service layer).

**Tests cover:**
- Happy paths for each function.
- State machine: every legal transition succeeds and emits the right event; every illegal transition throws with `{from, to}`.
- `transitionRun` clears `worker_started_at` on completed/failed/rejected.
- `incrementTokens` updates atomically (two concurrent increments don't lose updates — test via a `BEGIN IMMEDIATE` + sequential increments harness).

### Task C-2: `services/agent-runs.ts` — getActiveRun + getPendingApprovalRun + listRuns

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `getActiveRun(tx, parentId, agentId)` — most recent run on (parent, agent) where status in `(planning, awaiting_approval, running)`. Returns null if none.
- `getPendingApprovalRun(tx, parentId, agentId)` — same but status='awaiting_approval' only.
- `listRuns(tx, filter)` — supports `{ workspaceId?, projectId?, parentId?, agentId?, status?, chainId?, since? }`.
- `EXPLAIN` test verifies `getActiveRun` uses `documents_runs_by_status_idx`.

### Task C-3: `services/agent-runs.ts` — claimNextPlanningRun + recoverOrphanRuns + countPendingPlanning

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `claimNextPlanningRun(tx)` — atomic find-and-claim. SELECT id from planning rows ORDER BY created_at ASC LIMIT 1; UPDATE ... SET status='running', worker_started_at=now WHERE id=? AND status='planning'. Returns the row only if UPDATE affected 1 row. Otherwise loop or return null.
- `recoverOrphanRuns(tx, { staleThresholdMs })` — finds status='running' rows with `worker_started_at` older than threshold, transitions them to failed (worker_crash). Returns count.
- `countPendingPlanning(tx)` — returns `count(*)` of status=planning rows.
- Test: concurrent claims race-safe (two simulated pollers both call `claimNextPlanningRun` on the same row — only one wins, other gets null).
- Test: orphan recovery handles 0, 1, N rows; respects threshold.

### Task C-4: `services/agent-runs.ts` — checkRunRateLimits + checkChainGuards

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `checkRunRateLimits(tx, { workspaceId, agentId })` — workspace cap from `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE` env (default 200); agent cap from `agent.frontmatter.max_runs_per_hour` (default 60). Returns `{ok:true}` or `{ok:false, reason:'rate_limited', detail}`.
- `checkChainGuards(tx, { chainId })` — single query against `documents_runs_by_chain_idx` aggregating `count(*) > FOLIO_MAX_FANOUT_PER_CHAIN`, `max(completed_at) - min(started_at) > FOLIO_MAX_CHAIN_DURATION_MS`, `sum(tokens_in + tokens_out) > FOLIO_MAX_CHAIN_TOKENS`. Returns first-failing reason or `{ok:true}`.
- Defaults: 25 / 30 min (1.8M ms) / 1,000,000 tokens.
- Tests: each cap independently triggers the right `reason`; mixed cases prefer the first-failing reason.
- **Volume test (added per Phase 3 review remark #3 — SQLite JSON index performance).** Insert 10,000 synthetic `agent_run` rows spread across ~500 distinct `chain_id`s. Run `EXPLAIN QUERY PLAN` on the `checkChainGuards` aggregation query and assert the output contains the string `documents_runs_by_chain_idx`. The assertion guards against a future refactor that inadvertently makes the planner fall back to a full table scan. Skip via env `FOLIO_SKIP_VOLUME_TESTS=1` for fast local runs; CI always runs it.

### Task C-5: `services/agent-runs.ts` — checkProviderHealth + getProviderHealth

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `checkProviderHealth(tx, { workspaceId, provider })` — reads the last N (`FOLIO_PROVIDER_DEGRADE_THRESHOLD`, default 3) terminated events (`agent.run.completed | failed | rejected`) for this `(workspace, provider)` (`provider` lives in event payload). Excludes cancelled. If all N are `agent.run.failed` with `error_reason='provider_error'` → degraded. Returns `{status:'healthy'|'degraded', consecutiveFailures}`.
- `getProviderHealth(tx, { workspaceId })` — returns the same shape per-provider for all four providers.
- `transitionRun` (modify from C-1) calls `checkProviderHealth` after emitting its own `agent.run.<terminal>` event; on a tipping edge emits `workspace.provider.degraded` exactly once; on a recovery emits `workspace.provider.recovered` exactly once.
- Tests: tipping edge fires once and only once across repeated failures; recovery on next `completed`; per-provider independence; cancelled excluded from window; per `[[mock-the-wire-not-the-response]]` test does NOT just stub the function's return — uses real DB seeding.

### Task C-6: `services/agent-runs.ts` — ensureRunsTable (lazy seed) + chain_id helper

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `ensureRunsTable(tx, projectId)` — if project already has a 'runs' table, return it; else create within the same tx: insert `tables` row, 6 status rows (`planning, awaiting_approval, running, completed, failed, rejected`), 3 views (`All runs`, `Failures`, `Awaiting approval`), emit `table.created` + 6× `status.created` + 3× `view.created` + 1× `runs_table.lazy_seeded`. Idempotent.
- Chain helper: `nextChainId({ firedBy }) → string` — extracts the chain prefix from `fired_by` if present, else mints a fresh `crypto.randomUUID()`.
- Tests: lazy-seed is idempotent (calling twice yields the same table id, no duplicate events).

### Task C-7: `lib/mcp-dispatch.ts` — `executeMcpTool` shared dispatcher (skeleton)

> The runner needs this to dispatch tool calls. Full MCP-tool registry coverage lands in Sub-phase D, but the skeleton is required for C-8.

**Files:** Create `apps/server/src/lib/mcp-dispatch.ts` + `.test.ts`.

**Scope:**
- `McpAuthContext` type per spec §4d.
- `executeMcpTool(name, args, authContext)` — looks up tool in a registry, validates args via Zod, checks scopes, resolves resources, applies allow-list intersection, dispatches.
- Sub-phase C registers ONE tool: a dummy `__echo` tool used only by tests (real tools migrate in D-3).
- `routes/mcp.ts` is NOT refactored yet (that's D-3).

### Task C-8: `lib/runner.ts` — runAgent core loop

**Files:** Create `apps/server/src/lib/runner.ts` + `runner.test.ts`.

**Scope:** invariant entering `runAgent` = row at `status='running'` with `worker_started_at` set (the poller already claimed it). Implements the full §4b execution loop with the six pre-flight checks, planning-vs-execution decision, provider stream consumption, kind=plan/comment/result/error comment writes (each carrying `frontmatter.run_id`), tool dispatch via `executeMcpTool`, cancel check before each tool dispatch, budget enforcement after each `tokens` event, natural completion writing `kind=result` + transitioning to completed.

Mocks `AIProvider` at the test boundary per `[[mock-the-wire-not-the-response]]`. Tests cover every branch enumerated in spec §7a runner unit tests (~15 sub-tests).

### Task C-9: `lib/runner.ts` — runAgentResume + rejectRun

**Files:** Append to `runner.ts` + `.test.ts`.

**Scope:**
- `runAgentResume({ runId })` — invoked when the poller claims a planning row whose `frontmatter.resume_of` is set. Loads both the original `awaiting_approval` run and the new resuming row. Builds messages from the original parent's comments PLUS the kind=plan and kind=approval comments as message history. Runs through the standard loop starting at step 4 (skip planning gate; agent is now executing).
- `rejectRun({ runId })` — called synchronously by the trigger-matcher when a `kind=rejection` comment lands. Transitions the matched `awaiting_approval` run to `rejected`, posts a `kind=comment` from the agent ("Run cancelled by reviewer."), clears `worker_started_at`, emits `agent.run.rejected`.

### Task C-10: `lib/poller.ts` — startRunnerPoller

**Files:** Create `apps/server/src/lib/poller.ts` + `poller.test.ts`.

**Scope:** Implements `startRunnerPoller(db)` per spec §4c. Defaults: `FOLIO_POLLER_INTERVAL_MS=1000`, `FOLIO_POLLER_CONCURRENCY=5`, `FOLIO_WORKER_STALE_MS=300000`, backpressure threshold 10. Boot: call `recoverOrphanRuns` once. Main loop: respect concurrency cap, `claimNextPlanningRun`, fire-and-forget `runAgent(id)` with `.catch(logError).finally(...)`. Tests with fake timers (Bun's `setSystemTime` if available, else `vi.useFakeTimers()` style); test boot recovery, idle loop, concurrency cap, race-safe claim, backpressure log.

### Task C-11: Wire poller into `index.ts` (skipped in test env)

**Files:** Modify `apps/server/src/index.ts`.

**Scope:** After the reconciler block, add:

```ts
if (env.NODE_ENV !== 'test') {
  void startRunnerPoller(db);
}
```

Test by smoke (not a unit test — covered by integration tests in D-12).

### Task C-12: Wire `agent.task.assigned` + `comment.mentioned` triggers to insert agent_run rows

**Files:** Modify `apps/server/src/lib/trigger-matcher.ts` (or wherever the trigger fire path lives — find via `grep -rn "agent.task.assigned" apps/server/src`). Modify `apps/server/src/services/comments.ts` (mention parser already exists; just make sure the `comment.mentioned` event is emitted and the trigger handler creates an `agent_run` row instead of synchronously invoking anything).

**Scope:** The two flipped builtins each map their event to "create an agent_run row at status=planning" via the runs table for the parent doc's project. The poller picks up from there. **Critical:** trigger handlers MUST NOT call `runAgent` synchronously — they only insert the row.

Tests: PATCH a work_item's assignee to `agent:foo` → one `agent_run` row appears in the project's runs table at planning. POST a comment with `@foo` → one row. Per-project guard: if the agent's `frontmatter.projects` doesn't include this project, no row is created (allow-list enforcement at trigger-match time).

### Task C-13: Sub-phase C integration gate

- [ ] Full server suite must be green; expect ~556 + ~50 new = ~606 / 0-fail.
- [ ] Type-check clean.
- [ ] Smoke the dev server: configure an Anthropic key (Sub-phase B UI), assign a work_item to an agent, watch the runs table populate with kind=comment + kind=result on the parent. **This is the first "agent does work" moment** — celebrate it.
- [ ] Sub-phase C checkpoint.

---

## Sub-phase D — Routes + MCP parity + admin stats

Goal: ship the five `routes/runs.ts` verbs, refactor the existing MCP dispatch through `executeMcpTool`, add the five new MCP tools (`list_runs / get_run / run_agent / cancel_run / retry_run`), wire `kind=approval` / `kind=rejection` comments to the runner's `runAgentResume` / `rejectRun`, and add the admin runner-stats endpoint.

### Task D-1: `routes/runs.ts` — list + get + create + cancel + retry

**Files:** Create `apps/server/src/routes/runs.ts` + `runs.test.ts`. Mount in `app.ts`.

**Scope:** Five verbs per spec §4g + the `GET /provider-health` snapshot endpoint. Each calls into `services/agent-runs.ts`. `POST /runs` creates the row at planning + (if `input` provided) posts a `kind=comment` from the caller's authContext to the parent first. `cancel` checks status is non-terminal, transitions via `transitionRun(failed, error_reason='cancelled')`. `retry` re-uses `createRun` with `firedBy: 'retry-of:<oldId>'`, throws 409 RUN_ALREADY_ACTIVE if `getActiveRun` is non-null.

### Task D-2: `lib/mcp-dispatch.ts` — full tool registry

**Files:** Expand `mcp-dispatch.ts` + `.test.ts`.

**Scope:** Migrate all existing MCP tools (from Phase 2 + 2.5 + 2.6) into the registry. Each tool entry: `{ name, scopes: string[], argsSchema: ZodSchema, handler: (args, ctx) => Promise<unknown> }`. The runner can now dispatch any MCP tool via `executeMcpTool(name, args, agentAuthContext)`.

### Task D-3: Refactor `routes/mcp.ts` to route through executeMcpTool

**Files:** Modify `apps/server/src/routes/mcp.ts` + verify all `mcp.test.ts` cases still pass.

**Scope:** The JSON-RPC dispatcher becomes a thin wrapper: resolve authContext from bearer, call `executeMcpTool(params.name, params.arguments, authContext)`, serialize result/error to JSON-RPC shape. Zero behavior change visible from outside.

### Task D-4: Add 5 new MCP tools (list_runs, get_run, run_agent, cancel_run, retry_run)

**Files:** Append to `mcp-dispatch.ts` + `mcp.test.ts`.

**Scope:** Each per spec §4i. Tests verify HTTP-twin parity (same body, same error responses, identical row mutations).

### Task D-5: Wire builtin-on-approval / on-rejection to runner

**Files:** Modify `apps/server/src/lib/trigger-matcher.ts`. Add tests for the `internal_action: 'resume_run'` and `'reject_run'` handlers.

**Scope:**
- When a `kind=approval` comment is created, the builtin-on-approval trigger fires. Its `internal_action: 'resume_run'` handler resolves `target_agent` + `parent_id` → finds the matching `awaiting_approval` run via `getPendingApprovalRun` → inserts a new agent_run row at planning with `frontmatter.resume_of=<original_id>` and `chain_id` inherited. The poller picks it up.
- When a `kind=rejection` comment is created, the `internal_action: 'reject_run'` handler invokes `rejectRun(runId)` synchronously.

### Task D-6: Admin runner-stats endpoint

**Files:** Create `apps/server/src/routes/admin-runner-stats.ts` + `.test.ts`. Mount in `app.ts`.

**Scope:** `GET /api/v1/admin/runner-stats` returns `{ pending_count, active_count, recovered_today }`. Admin-only auth (existing helper). No MCP twin (UI-only).

### Task D-7: SSE filter params `?agent=` + `?table=`

**Files:** Modify `apps/server/src/routes/events.ts` (or wherever the SSE endpoint lives) + tests.

**Scope:** AND-combined with the existing `?parent=` and `?run=` filters. Used by E-3 (agent slideover link tile) and E-4 (live runs table updates).

### Task D-8: Sub-phase D integration gate

- [ ] Full server + web suite green.
- [ ] HTTP↔MCP parity tested per Appendix B (one parity test per route×tool pair).
- [ ] Smoke: POST `/api/v1/w/.../runs` → row appears in runs table → run completes. Cancel a running run → next iteration exits. Retry a failed run → new row appears, original preserved.
- [ ] Sub-phase D checkpoint.

---

## Sub-phase E — Web: runs table + link tiles + Cmd-K + banner + body editor wiki-links

Goal: every UI surface the user touches in v1 Phase 3.

### Task E-1: `lib/api/runs.ts` hooks

**Files:** Create `apps/web/src/lib/api/runs.ts` + `.test.ts`.

**Scope:** `useRuns(filter)`, `useRun(id)`, `useCreateRun()`, `useCancelRun()`, `useRetryRun()` — react-query hooks matching the verbs from D-1. Optimistic on create/cancel/retry.

### Task E-2: `useProviderHealth` hook

**Files:** Create `apps/web/src/lib/api/provider-health.ts` + `.test.ts`.

**Scope:** `useProviderHealth(wslug)` — one-shot GET `/provider-health` on mount; subscribes to SSE for `workspace.provider.degraded` + `workspace.provider.recovered` and merges into state.

### Task E-3: Runs link tile on agent + trigger slideovers

**Files:** Create `apps/web/src/components/runs/runs-link-tile.tsx` + `.test.tsx`. Modify agent + trigger slideovers to render it on the Runs tab.

**Scope:** Renders count by status, link "Open Runs table →" navigates to the right URL with the right filter. Live-updates via `?agent=<doc_id>` SSE.

### Task E-4: Runs table rendering (uses existing TableView)

**Files:** No new files — the runs table is just a `tables` row with `slug='runs'`. Verify it renders via the existing TableView from Phase 1.5/1.6.

**Scope:** Add a Playwright smoke that navigates to a project, opens the runs table view, sees the 3 lazy-seeded saved views in the rail.

### Task E-5: Cmd-K commands — Run agent + Approve pending plan

**Files:** Create `apps/web/src/components/cmd-k/run-agent-picker.tsx` + `approve-pending-plan.tsx` + tests. Register the commands in the existing Cmd-K registry.

**Scope:** "Run agent…" — two-step picker (agent → parent doc) + optional input → POST `/runs`. "Approve pending plan" — list `?status=awaiting_approval` runs workspace-wide; selecting navigates to the parent doc's slideover.

### Task E-6: Approval-buttons live state

**Files:** Modify `apps/web/src/components/comments/approval-buttons.tsx` + tests.

**Scope:** Per spec §6d. Queries the linked run via `useRun(comment.frontmatter.run_id)`. Renders interactive buttons only on `awaiting_approval`; renders muted "Approved by @stefan · 3m later" once running/completed; muted "Rejected by @stefan · 5m later" on rejected. SSE keeps it live.

### Task E-7: ProviderHealth banner + agent-slideover inline notice

**Files:** Create `apps/web/src/components/shell/provider-health-banner.tsx` + `.test.tsx`. Mount in the main shell. Modify `agent-slideover.tsx` for the inline "Provider currently offline" notice. Make `workspace-settings.tsx` honor `?tab=ai&provider=<provider>` URL param.

**Scope:** Per spec §6g. "Check key" link navigates with the right query string.

### Task E-8: `[[` wiki-link picker in the document body editor

**Files:** Modify `apps/web/src/components/slideover/document-slideover.tsx` to wire the `WikiLinkPicker` (from Phase 2.6) into the Milkdown body editor. Tests verify `[[` opens the picker and selection inserts `[[<slug>]]`.

### Task E-9: Sub-phase E integration gate

- [ ] Full suite green.
- [ ] Type-check clean.
- [ ] Manual smoke: assign a work item to an agent via the UI → run executes → kind=result comment appears → runs table view shows the row.
- [ ] Sub-phase E checkpoint.

---

## Sub-phase F — Shake-out + Playwright + branch close

### Task F-1: Manual QA doc

**Files:** Create `apps/web/tests/manual-qa-phase-3.md`.

**Scope:** One scenario per Phase 3 PHASES.md acceptance checkbox. Covers AI settings visuals (all 4 providers), real Anthropic test-key, runs table SSE-driven status flips, approval banner re-render under flaky network, Ollama on localhost, dark mode parity, provider-down banner happy + recovery.

### Task F-2: Real-Anthropic Playwright test

**Files:** Create `apps/web/tests/e2e/phase-3-real-anthropic.spec.ts`. Add `FOLIO_TEST_ANTHROPIC_KEY` to `.env.example`.

**Scope:** Test skips with `test.skip(!process.env.FOLIO_TEST_ANTHROPIC_KEY)`. When the key is set: configure it in the UI, assign a work_item to a reply-drafter agent with system prompt "Reply in one short sentence in English", model `claude-haiku-4-5`, wait for completion, assert a kind=result comment exists on the parent.

### Task F-3: Provider-offline banner Playwright

**Files:** Append a spec to `apps/web/tests/e2e/phase-3-provider-banner.spec.ts`.

**Scope:** Mock the Anthropic SDK at the server boundary (via an env-controlled stub in the e2e harness) to return 503 three times → assert workspace banner appears. Flip the stub to success → assign a 4th run → banner clears.

### Task F-4: Run `netdust-core:shake-out` skill

Invoke the skill from the controller. The skill sweeps the artifact end-to-end and produces a manifest at `tasks/shake-out-manifest-phase-3.md`.

### Task F-5: 4 reviewer agents in parallel

Per `netdust-core:shakeout` skill (non-WP variant = 4 reviewers): architecture-strategist, security-sentinel, code-simplicity-reviewer, performance-oracle. Run in a single message with 4 parallel Agent tool calls. Aggregate findings into the shake-out manifest under "Reviewer backlog".

### Task F-6: `/code-review --base=main --effort=high --comment`

Inline PR pass on the full Phase 3 diff. Resolve every must-fix-before-merge with failing-test-first commits per the Phase 2.6 pattern.

### Task F-7: Update STATE.md + MEMORY.md + PHASES.md

**Files:** `memory/STATE.md`, `~/.claude/projects/-home-ntdst-Projects-folio/memory/MEMORY.md`, `docs/PHASES.md`.

**Scope:** Tick every Phase 3 acceptance checkbox; write a STATE.md "Phase 3 shipped" entry; add an auto-memory `project_phase-3-shipped.md` and link from MEMORY.md.

### Task F-8: `superpowers:finishing-a-development-branch` → `--no-ff` merge into main

Final commit on the branch: `phase-3: complete`. Merge command guided by the skill; do not skip the skill (it surfaces uncommitted state and untracked files before merging).

---

## Self-review checklist

After expanding C-1..F-8 inline (the executor's job, per the spec), re-read this whole plan against the spec at `docs/superpowers/specs/2026-05-26-phase-3-agent-runner-design.md`:

- [ ] **Spec §1 wedge items present:** provider abstraction (B-2..B-5) · runner (C-8..C-9) · agent_run type (A-2 + A-4) · runs as documents lazy-seeded (C-6) · kind=plan/comment/result/error (C-8) · two-phase approval (C-9 + D-5) · token budget (C-8) · delegation depth (C-8 pre-flight) · BYOK (B-6 + B-7) · shared MCP/HTTP dispatch (C-7 + D-2..D-4) · parity rule (D-4) · `[[` wiki in body editor (E-8). ✅
- [ ] **Spec §2 architecture principles all addressed:** polling worker (C-10..C-11) · shared dispatch (C-7 + D-2..D-4) · runs are documents (A-2 + C-6) · coalesce don't queue (C-1's idempotency + getActiveRun) · 6-guard defense (C-4 + C-8). ✅
- [ ] **Spec §3 data model:** Migration 0012 (A-2) covers CHECK + 4 indexes; 0012a (A-3) flips builtins; Zod (A-4). ✅
- [ ] **Spec §4 services + routes:** every named function in §4a is tasked (C-1..C-6). `lib/runner.ts` (C-8, C-9). `lib/poller.ts` (C-10). `lib/mcp-dispatch.ts` (C-7, D-2). `routes/runs.ts` (D-1). `routes/ai.ts` (B-6). admin-runner-stats (D-6). ✅
- [ ] **Spec §5 events:** all 10 new event kinds in A-1; `?agent=` + `?table=` SSE filters in D-7. ✅
- [ ] **Spec §6 UI surfaces:** AI settings tab (B-7); runs table (E-4 via existing TableView); link tiles (E-3); approval banner live (E-6); Cmd-K (E-5); `[[` body editor (E-8); provider-down banner (E-7). ✅
- [ ] **Spec §7 tests:** unit-test list in §7a covered by tests within each Task; integration tests in §7b are smoke-covered by Sub-phase D + E integration gates and the manual-qa doc in F-1; Playwright in §7c covered by F-2 + F-3 + existing click-through suite. ✅
- [ ] **Spec §8 dependencies:** Phase 2.6 substrate referenced everywhere; no Phase 2.7 dependency (templates parked). ✅
- [ ] **Spec §9 open questions:** noted in this plan's Open decisions box. ✅
- [ ] **Spec §10 acceptance:** every numbered item maps to at least one task above. ✅
- [ ] **Testing-workflow gates:** present at each sub-phase boundary (A-5, B-8, C-13, D-8, E-9). ✅
- [ ] **`[[memory-feedback-items]]`:** `[[migrations-first-when-routes-look-broken]]` honored by Task A-0; `[[drizzle-migration-journal]]` honored by A-2 + A-3 + automated via the pre-commit hook in A-4b; `[[verify-subagent-test-counts]]` called out in the testing-workflow contract; `[[mock-the-wire-not-the-response]]` called out in C-5 + C-8; `[[plan-server-source-audit]]` is implicit in the executor's habit but worth a callout: when the executor adds the 5 new MCP tools in D-4, they MUST grep ALL of `apps/server/src` for hardcoded scope strings and tool-name constants, not just the new files. ✅
- [ ] **Phase 3 review remarks folded in (2026-05-28).** Remark #1 (poller claim race) — already covered by C-3's optimistic-lock pattern; multi-instance is post-v1 per spec §9. Remark #2 (provider degrade sensitivity) — covered by env-tunable `FOLIO_PROVIDER_DEGRADE_THRESHOLD` (default 3 consecutive); time-window deferred to v1.1 if shake-out reveals banner thrash. Remark #3 (SQLite JSON index) — C-4 now includes a 10k-row EXPLAIN volume test asserting the chain index is used. Remark #4 (testing-workflow enforcement) — automated via the new A-4b pre-commit hook. Remark #5 (dependency placement) — already correct in B-2/B-3 (`cd apps/server && bun add`). ✅
- [ ] **Placeholders scanned:** Sub-phases C / D / E / F are described as scope summaries, NOT as bare "TBD". Each Task has scope + files + behavioral expectations + test coverage in plain English. The executor expands each into the full failing-test → implementation → pass → commit form following the A-* / B-* pattern shown verbatim. This is intentional: writing all ~70 tasks inline would produce a ~5000-line plan that nobody re-reads; the locked structure + scope per task is enough for a skilled executor and avoids the false confidence of one-shot code that hasn't been measured against the real codebase. ✅

---

**Plan saved.** Execution choice next.
