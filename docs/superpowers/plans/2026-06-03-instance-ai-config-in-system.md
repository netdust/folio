# Instance AI Config in `__system` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Run server tests from INSIDE `apps/server` (`cd apps/server && bun test <path>`) — root-cwd triggers a spurious init cascade. Web tests: `cd apps/web && npx vitest run`. tsc per-app. **Verify `git branch --show-current` before EVERY commit** — the session auto-memory hook has moved HEAD mid-work; if not on the working branch, `git checkout` it first.

**Goal:** Move AI providers/keys from per-workspace to workspace-independent **instance credentials**; the runner resolves an agent's key by `(provider, ai_key_label)` with no workspace tie; the operator/production agent's provider/model/key is editable via UI.

**Architecture:** `ai_keys.workspace_id` is **dropped** (credentials are instance-level; unique `(provider, label)`). Every agent's frontmatter references a key via `provider` + `ai_key_label` (default `'default'`); the run snapshots the label; `loadContext` resolves+decrypts the key server-side (replaces the B6 run-workspace lookup) and injects it into the provider call only — the secret never reaches a token/tool/response/frontmatter. AI-key CRUD moves to an instance route gated by `requireInstanceAdmin`. Per-workspace usage metering ships (record, don't enforce); per-key caps are a deferred residual with a fail-loud trigger on paid-key creation.

**Tech Stack:** Bun, Hono, Drizzle (SQLite), Zod, React + TanStack (web). Source spec: `docs/superpowers/specs/2026-06-03-instance-ai-config-in-system-design.md` (threat model T-mitigations 1–8 are the convergence target).

**Branch:** create `spec/instance-ai-config` off `main` before Task 1 (use `superpowers:using-git-worktrees` if isolating).

---

## Threat model (inherited — convergence target)

From the spec's `## Threat model`. Tasks below enforce: (M1) no tool returns key material; (M2) key never in run messages/prompt/response/log; (M3) frontmatter holds a label reference, never the secret; (M4) key-store routes gated `requireInstanceAdmin` (MERGED — `system-workspace.ts:282`); (M6) B6 reversal doesn't widen document reach; (M7) migration carries no key into a deletable place (here: drops the column, fails loud if rows exist); (M8) denial-of-wallet = metered residual + fail-loud trigger, caps deferred. `/code-review` + `/shakeout` verify against these.

## Architecture invariants touched

Invariant 4 (HTTP authz — AI routes → `requireInstanceAdmin`), invariant 5 (key CRUD through `txWithEvents`). The B6 Deliberate-exception entry in `ARCHITECTURE-INVARIANTS.md` is REPLACED — Task 11 updates it.

---

## File structure

**Server:**
- `apps/server/src/db/migrations/0023_ai_keys_drop_workspace.sql` (create) + `meta/_journal.json` (modify) — table-rebuild dropping `workspace_id`, fail-loud guard.
- `apps/server/src/db/schema.ts` (modify) — `aiKeys`: drop `workspaceId`, unique `(provider,label)`; new `aiUsage` table (metering).
- `apps/server/src/lib/agent-schema.ts` (modify) — `ai_key_label` on `agentFrontmatterSchema`.
- `apps/server/src/lib/agent-run-schema.ts` (modify) — `ai_key_label` on the run frontmatter (snapshot).
- `apps/server/src/services/agent-runs.ts` (modify ~113-120) — snapshot `ai_key_label` onto the run.
- `apps/server/src/lib/runner.ts` (modify ~447) — resolve key by `(provider, ai_key_label)`, no workspace predicate (B6 reversal); record usage post-run.
- `apps/server/src/routes/instance-ai-keys.ts` (create) — instance AI-key CRUD (`/api/v1/system/ai-keys`), `requireInstanceAdmin`, fail-loud trigger on paid key.
- `apps/server/src/app.ts` (modify) — mount the new route; unmount the old per-workspace AI-key routes from `settings.ts`.
- `apps/server/src/routes/settings.ts` (modify) — remove the AI-key handlers (moved out).
- `apps/server/src/lib/ai-usage.ts` (create) — `recordAiUsage()` metering helper.

**Web:**
- `apps/web/src/lib/api/instance-ai-keys.ts` (create) — client + keys for the instance store.
- `apps/web/src/components/settings/ai-tab.tsx` (modify) — repoint at the instance store.
- `apps/web/src/components/settings/production-agent-tab.tsx` (create) — assign operator provider/model/ai_key_label.
- agent-create form (modify) — offer `(provider, label)` from the instance store.

---

# Server

### Task 1: Migration — drop `ai_keys.workspace_id` (fail-loud guard)

**Files:**
- Create: `apps/server/src/db/migrations/0023_ai_keys_drop_workspace.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Create test: `apps/server/src/db/migrations/0023_ai_keys_drop_workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/db/migrations/0023_ai_keys_drop_workspace.test.ts` (mirror the `0020`/`0022` harness — `Database(':memory:')` + `drizzle` + `migrate(db, { migrationsFolder })`):

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

describe('migration 0023 — ai_keys drops workspace_id', () => {
  test('after migration ai_keys has no workspace_id column + unique (provider,label)', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    const cols = sqlite.query("PRAGMA table_info(ai_keys)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain('workspace_id');
    // a NULL-workspace insert (no such column) + (provider,label) unique:
    sqlite.exec(`INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('k1','ollama','default','x')`);
    expect(() =>
      sqlite.exec(`INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('k2','ollama','default','y')`),
    ).toThrow(); // unique (provider,label)
  });

  test('FAIL LOUD: a pre-existing ai_keys row makes the migration throw (no silent resolve)', () => {
    // Run the chain UP TO 0022, seed a row into the OLD ai_keys, then exec 0023 directly.
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER }); // full chain → 0023 already applied on empty: OK
    // Re-create the pre-0023 shape + a row to prove the guard SQL throws on non-empty.
    // (Direct guard check: the 0023 file's guard is `SELECT RAISE(ABORT,...) WHERE EXISTS(SELECT 1 FROM ai_keys)`.)
    sqlite.exec(`INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('pre','anthropic','default','z')`);
    const { readFileSync } = require('node:fs');
    const sql = readFileSync(path.join(MIGRATIONS_FOLDER, '0023_ai_keys_drop_workspace.sql'), 'utf8');
    expect(() => sqlite.exec(sql)).toThrow(); // guard aborts because a row exists
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/db/migrations/0023_ai_keys_drop_workspace.test.ts`
Expected: FAIL — migration file doesn't exist (`no such file` / column still present).

- [ ] **Step 3: Write the migration**

Create `apps/server/src/db/migrations/0023_ai_keys_drop_workspace.sql`. **Fail-loud guard FIRST** (abort if any row exists — the spec's premise is zero rows; a non-empty table means the premise broke), then the table-rebuild dropping `workspace_id` (mirror `0022`'s `__new_` rebuild shape):

```sql
SELECT RAISE(ABORT, 'migration 0023: ai_keys is non-empty — instance-key consolidation expected zero rows; aborting (resolve keys manually, do not auto-drop)') WHERE EXISTS (SELECT 1 FROM ai_keys);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text DEFAULT 'default' NOT NULL,
	`encrypted_key` text NOT NULL,
	`base_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_ai_keys`("id", "provider", "label", "encrypted_key", "base_url", "created_at") SELECT "id", "provider", "label", "encrypted_key", "base_url", "created_at" FROM `ai_keys`;--> statement-breakpoint
DROP TABLE `ai_keys`;--> statement-breakpoint
ALTER TABLE `__new_ai_keys` RENAME TO `ai_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_provider_label_idx` ON `ai_keys` (`provider`, `label`);
```

(The `INSERT...SELECT` is a no-op on the empty table; it's only reachable if the guard didn't fire, which on an empty table it won't. The `RAISE(ABORT)` aborts the whole migration transaction if a row exists.)

- [ ] **Step 4: Register in the journal**

Append to `apps/server/src/db/migrations/meta/_journal.json` after idx 23 (`0022_…`): a new entry `{ "idx": 24, "version": "6", "when": 1780980000000, "tag": "0023_ai_keys_drop_workspace", "breakpoints": true }`. Match the existing entry shape (comma after the prior entry). Do NOT call Date.now — use the fixed `1780980000000`.

- [ ] **Step 5: Run test (GREEN) + drift check + auto-migrate**

Run: `cd apps/server && bun test src/db/migrations/0023_ai_keys_drop_workspace.test.ts` → PASS (2 tests).
Run: `cd apps/server && bun test scripts/check-migration-drift.test.ts src/db/auto-migrate.test.ts` → PASS (drops no always-keep index; chain applies clean).

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/db/migrations/0023_ai_keys_drop_workspace.sql apps/server/src/db/migrations/meta/_journal.json apps/server/src/db/migrations/0023_ai_keys_drop_workspace.test.ts
git commit -m "phase-aikeys T1: migration — drop ai_keys.workspace_id, fail-loud guard, unique (provider,label)"
```

### Task 2: Schema — drop `workspaceId` on `aiKeys` + add `ai_usage` table

**Files:**
- Modify: `apps/server/src/db/schema.ts` (the `aiKeys` table; add `aiUsage`)
- Test: covered by Task 1 migration test + Task 6 metering test (no standalone schema test).

- [ ] **Step 1: Edit the `aiKeys` table**

In `apps/server/src/db/schema.ts`, replace the `aiKeys` definition with the workspace-free shape:

```ts
export const aiKeys = sqliteTable(
  'ai_keys',
  {
    id: text('id').primaryKey(),
    provider: text('provider', {
      enum: ['anthropic', 'openai', 'openrouter', 'ollama'],
    }).notNull(),
    label: text('label').notNull().default('default'),
    encryptedKey: text('encrypted_key').notNull(),
    baseUrl: text('base_url'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    providerLabelIdx: uniqueIndex('ai_keys_provider_label_idx').on(t.provider, t.label),
  }),
);
```

(Drop the `workspaceId` column + its FK + the old `ai_keys_workspace_provider_idx`. `workspaces` may now be unimported by this table — leave other tables' imports intact.)

- [ ] **Step 2: Add the `ai_usage` metering table**

Add after `aiKeys` (records usage; record-only, never enforces — M8):

```ts
/** Per-run AI usage record (M8 metering — record, do not enforce). Attributes
 *  shared-instance-key usage to the workspace that incurred it, so the
 *  denial-of-wallet residual is detectable + attributable. */
export const aiUsage = sqliteTable('ai_usage', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(), // the RUN's target workspace (attribution)
  runId: text('run_id').notNull(),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
```

Add a migration for `ai_usage` (CREATE TABLE) — append to the SAME `0023` file as a trailing `CREATE TABLE` statement-breakpoint (one migration, two related changes), OR a `0024_ai_usage.sql`. Prefer folding into `0023` (atomic with the key reshape). Update the Task-1 migration + its test to assert `ai_usage` exists.

- [ ] **Step 3: tsc**

Run: `cd apps/server && bun x tsc --noEmit` → EXPECT errors where code reads `aiKeys.workspaceId` (runner.ts, settings.ts). Those are FIXED in Tasks 4–5. Note them; do not fix here.

- [ ] **Step 4: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/0023_ai_keys_drop_workspace.sql apps/server/src/db/migrations/0023_ai_keys_drop_workspace.test.ts
git commit -m "phase-aikeys T2: schema — aiKeys workspace-free (provider,label) + ai_usage metering table"
```

### Task 3: Frontmatter — `ai_key_label` on agent + run schemas

**Files:**
- Modify: `apps/server/src/lib/agent-schema.ts` (`agentFrontmatterSchema`)
- Modify: `apps/server/src/lib/agent-run-schema.ts` (the run frontmatter schema)
- Test: `apps/server/src/lib/agent-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/agent-schema.test.ts`:

```ts
test('agentFrontmatterSchema accepts ai_key_label, defaults to "default"', () => {
  const fm = agentFrontmatterSchema.parse({ provider: 'ollama', model: 'qwen2.5-coder:7b', tools: [] });
  expect(fm.ai_key_label).toBe('default');
  const fm2 = agentFrontmatterSchema.parse({ provider: 'ollama', model: 'm', tools: [], ai_key_label: 'cheap' });
  expect(fm2.ai_key_label).toBe('cheap');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts -t "ai_key_label"` → FAIL (`.strict()` rejects unknown key / no default).

- [ ] **Step 3: Add the field to `agentFrontmatterSchema`**

In `apps/server/src/lib/agent-schema.ts`, inside the `z.object({...})` (before `.strict()`), add:

```ts
  // Which __system AI key this agent uses, by (provider, label). The provider
  // field above selects the provider; this selects the key label (a __system
  // may hold multiple keys per provider). Default 'default'. The reference is a
  // non-secret label — the key MATERIAL is read server-side by the runner only.
  ai_key_label: z.string().min(1).default('default'),
```

- [ ] **Step 4: Add `ai_key_label` to the run frontmatter schema (the snapshot)**

In `apps/server/src/lib/agent-run-schema.ts`, add `ai_key_label` to the run frontmatter object (snapshotted at create-time, like `provider`/`model`). Read the file's existing `provider`/`model` fields and mirror: `ai_key_label: z.string().min(1).default('default'),` (or `.optional()` if the schema treats snapshot fields as optional — match the file's convention for `model`).

- [ ] **Step 5: Run tests + tsc**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts` → PASS. `bun x tsc --noEmit` → no NEW errors from this file.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/agent-schema.ts apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/agent-schema.test.ts
git commit -m "phase-aikeys T3: ai_key_label on agent + run frontmatter schemas (default 'default')"
```

### Task 4: Snapshot `ai_key_label` onto the run at createRun

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts` (~113-120 + the run-insert values)
- Test: `apps/server/src/services/agent-runs.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/services/agent-runs.test.ts` (mirror an existing createRun test that asserts on `result.document.frontmatter`):

```ts
test('createRun snapshots ai_key_label from the agent frontmatter (default when absent)', async () => {
  // Seed an agent with frontmatter.ai_key_label='cheap'; create a run; assert the
  // run fm carries ai_key_label==='cheap'. A second agent with no ai_key_label →
  // run fm ai_key_label==='default'.
});
```

(Use the file's existing agent-seed + `createRun` harness — read the top for the pattern; assert `(result.document.frontmatter as AgentRunFrontmatter).ai_key_label`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/agent-runs.test.ts -t "ai_key_label"` → FAIL (field not snapshotted/undefined).

- [ ] **Step 3: Snapshot the field**

In `apps/server/src/services/agent-runs.ts`, near the provider/model snapshot (~113-118):

```ts
  const provider = agentFm.provider as AgentRunFrontmatter['provider'];
  const model = (agentFm.model as string | undefined) ?? '';
  const aiKeyLabel = (agentFm.ai_key_label as string | undefined) ?? 'default';
```

Then add `ai_key_label: aiKeyLabel` to the run-frontmatter object built for the insert (find the object literal that already sets `provider`, `model` ~line 205 and add the field alongside).

- [ ] **Step 4: Run test + regression**

Run: `cd apps/server && bun test src/services/agent-runs.test.ts` → PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/services/agent-runs.ts apps/server/src/services/agent-runs.test.ts
git commit -m "phase-aikeys T4: snapshot ai_key_label onto the run at createRun"
```

### Task 5: Runner — resolve key by `(provider, ai_key_label)`, no workspace (B6 reversal) — LOAD-BEARING

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (~447-451, the `keyRow` lookup)
- Test: `apps/server/src/lib/runner.test.ts`

> This is the B6 reversal (M6). The key is read by `(provider, label)` with NO workspace predicate; the secret is injected into the provider call only (M1/M2). The worker token's document reach is UNCHANGED — this only changes key resolution.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/runner.test.ts`. Seed an instance key `(provider:'ollama', label:'default')` with NO workspace; a run in workspace B whose agent fm has `provider:'ollama', ai_key_label:'default'`; assert `loadContext` resolves the key (ctx.apiKey decrypts to the seeded value, ctx.baseUrl matches) **even though no key exists scoped to B**:

```ts
test('loadContext resolves the AI key by (provider, ai_key_label), no workspace tie (B6 reversal)', async () => {
  // seed ai_keys row: provider ollama, label default, base_url localhost, encrypted 'k'.
  // run in B (operator or local agent) with fm.provider=ollama, fm.ai_key_label=default.
  // loadContext → ctx.baseUrl === 'http://localhost:11434' (resolved by provider+label,
  // NOT by run.workspaceId). And a second-label key 'cheap' is NOT picked.
});
test('loadContext picks the labelled key when ai_key_label != default', async () => {
  // two ollama keys: default + cheap (different base_url). run fm ai_key_label=cheap →
  // ctx.baseUrl is cheap's, proving label disambiguation.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/runner.test.ts -t "B6 reversal"` → FAIL (old lookup filters by `run.workspaceId`; the instance key has none → no match → no_ai_key).

- [ ] **Step 3: Rewrite the lookup**

In `apps/server/src/lib/runner.ts` (~447-451), replace the keyRow block:

```ts
  // AI key resolution: by (provider, ai_key_label) — instance credential, NO
  // workspace tie (replaces the B6 run-workspace lookup). The secret is read
  // here with system authority and injected into the provider call ONLY; it
  // never reaches a token, tool, response, or the run messages. The worker
  // token's document reach is unchanged — this only resolves the key.
  const aiKeyLabel = (fm.ai_key_label as string | undefined) ?? 'default';
  const keyRow = await db.query.aiKeys.findFirst({
    where: and(
      eq(aiKeys.provider, fm.provider as ProviderName),
      eq(aiKeys.label, aiKeyLabel),
    ),
  });
  const apiKey = keyRow ? decryptSecret(keyRow.encryptedKey) : '';
  const baseUrl = keyRow?.baseUrl ?? undefined;
```

(Remove the B6 comment block. `aiKeys` + `and`/`eq` already imported. Pre-flight `no_ai_key` semantics unchanged — missing `(provider,label)` → empty apiKey → no_ai_key preflight.)

- [ ] **Step 4: Run test (GREEN) + regression**

Run: `cd apps/server && bun test src/lib/runner.test.ts -t "B6 reversal"` and `-t "label"` → PASS.
Run: `cd apps/server && bun test src/lib/runner.test.ts` → existing run tests PASS (the B6 tests are inverted in Task 5b).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-aikeys T5: runner resolves AI key by (provider,ai_key_label), no workspace (B6 reversal)"
```

### Task 5b: Invert (do NOT delete) the B6 tests

**Files:**
- Modify: `apps/server/src/lib/runner.test.ts`, `apps/server/src/routes/phase-gate-b.integration.test.ts` (any test asserting the OLD B6 rule)

- [ ] **Step 1: Find the old-rule tests**

Run: `cd apps/server && grep -rn "run.workspaceId.*aiKeys\|customer.*key\|B6\|no __system fallback\|run-workspace.*key" src/lib/runner.test.ts src/routes/phase-gate-b.integration.test.ts`. Each test that asserts "the AI key comes from the run's workspace" or "library agent uses the customer key" encodes the OLD rule.

- [ ] **Step 2: Invert them**

For each: change the assertion to the new resolution — the key is resolved by `(provider, ai_key_label)` regardless of the run's workspace. Do NOT delete (a deleted test loses the coverage; an un-inverted one will silently assert the wrong thing). Keep the test name but update its body + a comment: `// INVERTED 2026-06-03: AI key is instance-scoped by (provider,label), not the run workspace (B6 reversed).`

- [ ] **Step 3: Run + commit**

Run: `cd apps/server && bun test src/lib/runner.test.ts src/routes/phase-gate-b.integration.test.ts` → PASS.

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/runner.test.ts apps/server/src/routes/phase-gate-b.integration.test.ts
git commit -m "phase-aikeys T5b: invert the B6 key-resolution tests to the (provider,label) rule"
```

### Task 6: Usage metering — `recordAiUsage()` (M8, record-only)

**Files:**
- Create: `apps/server/src/lib/ai-usage.ts`
- Modify: `apps/server/src/lib/runner.ts` (call it after a run's provider usage is known)
- Test: `apps/server/src/lib/ai-usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai-usage.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { recordAiUsage } from './ai-usage.ts';
// use a test DB (mirror other lib tests that import db/client + run migrations)
describe('recordAiUsage (M8 — record, not enforce)', () => {
  test('inserts an ai_usage row attributed to the run workspace', async () => {
    // recordAiUsage(db, { workspaceId:'w', runId:'r', provider:'ollama', label:'default', tokensIn:10, tokensOut:5 })
    // → an ai_usage row exists with those values.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/ai-usage.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `recordAiUsage`**

Create `apps/server/src/lib/ai-usage.ts`:

```ts
import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { aiUsage } from '../db/schema.ts';

/** M8 metering — RECORD usage, do NOT enforce. Attributes shared-instance-key
 *  usage to the run's workspace so the denial-of-wallet residual is detectable.
 *  Caps/enforcement are a deferred phase (see the spec). Failure here must NOT
 *  fail the run — log + continue (metering is best-effort observability). */
export async function recordAiUsage(
  db: DB,
  args: { workspaceId: string; runId: string; provider: string; label: string; tokensIn: number; tokensOut: number },
): Promise<void> {
  try {
    await db.insert(aiUsage).values({ id: nanoid(), ...args });
  } catch (err) {
    console.warn('[ai-usage] failed to record usage:', err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 4: Call it from the runner where final token counts are known**

In `apps/server/src/lib/runner.ts`, find where the run's final `tokens_in`/`tokens_out` are written to the run frontmatter at completion (grep `tokens_in`/`tokensIn`). After that, call:

```ts
  await recordAiUsage(db, {
    workspaceId: run.workspaceId,
    runId: run.id,
    provider: fm.provider,
    label: (fm.ai_key_label as string | undefined) ?? 'default',
    tokensIn: <finalTokensIn>,
    tokensOut: <finalTokensOut>,
  });
```

(Use the actual final-count variables in scope. Place it on the completion path; do NOT block the run on a metering failure — `recordAiUsage` already swallows+logs.)

- [ ] **Step 5: Run test + regression + commit**

Run: `cd apps/server && bun test src/lib/ai-usage.test.ts src/lib/runner.test.ts` → PASS.

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/ai-usage.ts apps/server/src/lib/runner.ts apps/server/src/lib/ai-usage.test.ts
git commit -m "phase-aikeys T6: ai_usage metering (record-only, M8) wired into the runner completion path"
```

### Task 7: Instance AI-key routes — `/api/v1/system/ai-keys` (requireInstanceAdmin) + paid-key fail-loud trigger

**Files:**
- Create: `apps/server/src/routes/instance-ai-keys.ts`
- Modify: `apps/server/src/app.ts` (mount new; unmount old)
- Modify: `apps/server/src/routes/settings.ts` (remove the AI-key handlers)
- Test: `apps/server/src/routes/instance-ai-keys.test.ts`

> M4: gated `requireInstanceAdmin`. M7/route-truth: instance path, no `:workspaceId`. M8: on a PAID (non-ollama) key create, log the fail-loud residual warning.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/routes/instance-ai-keys.test.ts` (mirror `instance-tokens.test.ts` harness — `makeTestApp`, `bootstrapSystemWorkspace`, a `__system`-owner session cookie):

```ts
// GET /api/v1/system/ai-keys
test('a __system owner lists instance AI keys; encrypted_key never returned', async () => { /* 200; no encrypted_key field */ });
test('POST /api/v1/system/ai-keys creates a key (no workspace), 201', async () => { /* ollama+localhost; row has no workspace_id */ });
test('a non-__system user is forbidden on every route incl GET (403)', async () => { /* GET + POST + DELETE → 403 */ });
test('a bearer cannot reach the instance AI-key routes (session-only)', async () => { /* Authorization: Bearer → 401/403 */ });
test('DELETE removes an instance key', async () => { /* 200; row gone */ });
test('creating a PAID (non-ollama) key logs the denial-of-wallet residual trigger (M8)', async () => {
  // spy console.warn (or assert via a returned flag); POST provider:anthropic →
  // a warning mentioning 'denial-of-wallet' / 'caps not built' is emitted.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/routes/instance-ai-keys.test.ts` → FAIL (route 404 / not mounted).

- [ ] **Step 3: Implement the route**

Create `apps/server/src/routes/instance-ai-keys.ts` (mirror `instance-tokens.ts` structure + the validation logic moved from `settings.ts` — keep the `validatePublicUrl` loopback hatch + the ollama-baseUrl rules + the SECRET-class behavior):

```ts
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { aiKeys } from '../db/schema.ts';
import { env } from '../env.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { requireInstanceAdmin } from '../lib/system-workspace.ts';
import { validatePublicUrl } from '../lib/url-allow-list.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';

const instanceAiKeysRoute = new Hono<AuthContext>();
instanceAiKeysRoute.use('*', requireSessionUser);

instanceAiKeysRoute.get('/', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);
  const rows = await db.query.aiKeys.findMany();
  return jsonOk(c, { keys: rows.map(({ encryptedKey: _omit, ...k }) => k) }); // M1/M3 — never the secret
});

instanceAiKeysRoute.post(
  '/',
  zValidator('json', z.object({
    provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
    apiKey: z.string().min(1),
    label: z.string().min(1).default('default'),
    baseUrl: z.string().url().optional(),
  }).strict().refine((b) => b.baseUrl === undefined || b.provider === 'ollama', {
    message: 'baseUrl is only allowed for the ollama provider', path: ['baseUrl'],
  })),
  async (c) => {
    await requireInstanceAdmin(db, getUser(c).id);
    const { provider, apiKey, label, baseUrl } = c.req.valid('json');
    if (provider === 'ollama' && baseUrl === undefined) {
      throw new HTTPError('INVALID_BODY', 'baseUrl is required for the ollama provider', 422);
    }
    if (baseUrl !== undefined) {
      const allowLoopback = provider === 'ollama' && env.FOLIO_ALLOW_LOOPBACK_AI;
      const v = validatePublicUrl(baseUrl, { allowLoopback });
      if (!v.ok) throw new HTTPError('INVALID_BODY', v.reason, 422);
    }
    // M8 fail-loud trigger: a PAID provider makes the denial-of-wallet residual live.
    if (provider !== 'ollama') {
      console.warn(
        `[ai-keys] denial-of-wallet residual is now LIVE: a paid provider key (${provider}/${label}) ` +
        `was added to the instance store. Per-key usage CAPS are NOT built (metered residual — see spec). ` +
        `Any agent in any workspace can now draw on this key.`,
      );
    }
    const id = nanoid();
    await db.insert(aiKeys).values({ id, provider, label, encryptedKey: encryptSecret(apiKey), baseUrl })
      .onConflictDoUpdate({ target: [aiKeys.provider, aiKeys.label], set: { encryptedKey: encryptSecret(apiKey), baseUrl } });
    return jsonOk(c, { id, provider, label, paid_residual_live: provider !== 'ollama' }, 201);
  },
);

instanceAiKeysRoute.delete('/:keyId', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);
  const deleted = await db.delete(aiKeys).where(eq(aiKeys.id, c.req.param('keyId'))).returning({ id: aiKeys.id });
  if (deleted.length === 0) throw new HTTPError('NOT_FOUND', 'AI key not found', 404);
  return jsonOk(c, { ok: true });
});

export { instanceAiKeysRoute };
```

(If key CRUD must emit events per invariant 5, wrap the insert/delete in `txWithEvents` + `emitEvent` mirroring the old settings.ts — check whether the old AI-key handlers emitted events; if they did, preserve that.)

- [ ] **Step 4: Mount it; remove the old per-workspace AI-key routes**

In `apps/server/src/app.ts`: add `import { instanceAiKeysRoute } from './routes/instance-ai-keys.ts';` and `v1.route('/system/ai-keys', instanceAiKeysRoute);` (near the other `v1.route` system routes, e.g. `instance-tokens`). Then REMOVE the AI-key handlers from `apps/server/src/routes/settings.ts` (the GET/POST/DELETE `/:workspaceId/ai-keys` — they're replaced). If `settings.ts` becomes empty, delete it + its mount; if it has other settings, leave those.

- [ ] **Step 5: Run tests + regression**

Run: `cd apps/server && bun test src/routes/instance-ai-keys.test.ts` → PASS. `cd apps/server && bun test src/routes/settings.test.ts` → reconcile/relocate the old AI-key route tests (move the loopback/SSRF default-closed tests — with the hermetic `FOLIO_ALLOW_LOOPBACK_AI=false` pin from `4c1be37` — into `instance-ai-keys.test.ts`; delete the now-dead per-workspace ones).

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/routes/instance-ai-keys.ts apps/server/src/app.ts apps/server/src/routes/settings.ts apps/server/src/routes/instance-ai-keys.test.ts apps/server/src/routes/settings.test.ts
git commit -m "phase-aikeys T7: instance AI-key routes (/system/ai-keys, requireInstanceAdmin) + paid-key residual trigger; remove per-workspace AI-key routes"
```

### Task 8: T6 secret-refuse re-verification on the new path

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (`isSecretWrite`/`pathToScope` — confirm `/system/ai-keys` is SECRET) + test.
- Test: `apps/server/src/lib/folio-api-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/folio-api-tool.test.ts`:

```ts
test('the instance AI-key route is SECRET-classed (M1 — never agent-writable)', () => {
  expect(pathToScope('POST', '/api/v1/system/ai-keys')).toBe('SECRET');
  expect(pathToScope('DELETE', '/api/v1/system/ai-keys/k1')).toBe('SECRET');
  expect(isSecretWrite('POST', '/api/v1/system/ai-keys')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/folio-api-tool.test.ts -t "instance AI-key route is SECRET"` → likely FAIL (the existing `isSecretWrite` matches `/ai-keys` via `/\/ai-keys(\/|$)/`, which DOES match `/system/ai-keys` — so it may PASS already; if it passes, this is a guard test confirming the new path stays covered).

- [ ] **Step 3: Confirm/extend the regex**

In `apps/server/src/lib/folio-api-tool.ts`, the `isSecretWrite` regex `/\/ai-keys(\/|$)/` already matches `/system/ai-keys`. Confirm; if the new path somehow isn't covered, extend the regex. No change likely needed — the test is the guard.

- [ ] **Step 4: Run + commit**

Run: `cd apps/server && bun test src/lib/folio-api-tool.test.ts` → PASS.

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts
git commit -m "phase-aikeys T8: guard-test that /system/ai-keys is SECRET-classed (T6/M1)"
```

### Task 9: Operator seed — `ai_key_label` + keep provider editable

**Files:**
- Modify: `apps/server/src/lib/system-skills.ts` (operator agent frontmatter defaults, if it pins provider)
- Test: `apps/server/src/lib/system-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/system-workspace.test.ts`:

```ts
test('seeded operator agent frontmatter carries ai_key_label (default)', async () => {
  // after bootstrap+designate, the operator agent doc fm has ai_key_label === 'default'
  // (provider/model remain whatever the seed sets; they are editable via UI per the spec).
});
```

- [ ] **Step 2: Run + fail**

Run: `cd apps/server && bun test src/lib/system-workspace.test.ts -t "ai_key_label"` → FAIL (field absent in seed).

- [ ] **Step 3: Add to the operator seed**

In `apps/server/src/lib/system-skills.ts` (the operator `createDocument` frontmatter in `ensureOperatorAgent`, currently sets `provider`, `model`, `tools`, `skills`...), add `ai_key_label: 'default'`. Leave `provider`/`model` at their current seeded values (the spec makes them UI-editable; the seed is just the starting point). Note the SEED-ONCE caveat in a comment: a live install's already-seeded operator keeps the old fm; the UI (Task 10/11) is how an operator's provider/model/label is changed post-seed.

- [ ] **Step 4: Run + commit**

Run: `cd apps/server && bun test src/lib/system-workspace.test.ts` → PASS.

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/system-skills.ts apps/server/src/lib/system-workspace.test.ts
git commit -m "phase-aikeys T9: operator seed carries ai_key_label='default'"
```

### Task 10: Phase Gate — server integration + full regression

- [ ] **Step 1: Cross-task integration test**

Create `apps/server/src/routes/phase-aikeys.integration.test.ts` (real DB):

```
SCENARIO: an instance key drives a cross-workspace operator run, resolved by (provider,label), and usage is metered.
  GIVEN: __system bootstrapped; an instance ai_keys row (ollama, default, localhost) via POST /system/ai-keys as a __system admin; workspace B + a parent doc; the operator agent fm.provider=ollama, ai_key_label=default.
  WHEN:  build the run context for an operator run targeting B (loadContext).
  THEN:  - ctx resolves the ollama key (baseUrl localhost) by (provider,label), NOT by B's workspace (B has no key).
         - a non-__system session GET /system/ai-keys → 403.
         - the GET list never includes encrypted_key.
         - (metering) after a simulated completion, an ai_usage row attributes tokens to B.
         - (M2 — load-bearing) the decrypted key string does NOT appear anywhere in the assembled run messages / system prompt / tool envelopes (assert the secret substring is absent from the serialized run context). This is the no-key-leak regression.
```

- [ ] **Step 2: Full server suite + tsc**

Run: `cd apps/server && bun test` → 0 fail. `cd apps/server && bun x tsc --noEmit` → clean. (Expect the old per-workspace AI-key tests to be gone/relocated; the inverted B6 tests green.)

- [ ] **Step 3: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/routes/phase-aikeys.integration.test.ts
git commit -m "phase-aikeys T10: server phase gate — instance-key cross-workspace resolution + metering integration"
```

---

# Web

### Task 11: Web — repoint AI settings at the instance store + operator provider/model/key UI

**Files:**
- Create: `apps/web/src/lib/api/instance-ai-keys.ts`
- Modify: `apps/web/src/components/settings/ai-tab.tsx`
- Create: `apps/web/src/components/settings/production-agent-tab.tsx` (or fold into ai-tab — implementer's call per existing settings structure)
- Modify: the agent-create form (offer `(provider, label)` from the instance store)
- Test: vitest for each touched component

- [ ] **Step 1: Client**

Create `apps/web/src/lib/api/instance-ai-keys.ts` mirroring `apps/web/src/lib/api/settings.ts`'s old AI-key client but pointed at `/api/v1/system/ai-keys` (no workspaceId): `useInstanceAiKeys()`, `useCreateInstanceAiKey()`, `useDeleteInstanceAiKey()`, with a `instanceAiKeysKeys` factory. Write a vitest that the create mutation POSTs to `/api/v1/system/ai-keys` with the body (no workspaceId) — mock fetch + assert the call (mock-the-wire discipline).

- [ ] **Step 2: AI tab repoint**

Modify `apps/web/src/components/settings/ai-tab.tsx` to use the instance client; drop the `workspaceId` prop from the key CRUD path. Gate the tab/section on `useIsSystemMember()` (instance admin) — non-admins don't see the key store. Vitest: renders the instance keys; a non-admin sees the gated/empty state.

- [ ] **Step 3: Operator provider/model/key assignment**

Add a surface (production-agent tab OR the `__system` operator slideover already supports frontmatter edit) to set the operator's `provider` + `model` + `ai_key_label`. Reuse the existing agent frontmatter-edit path (the slideover already edits agent fm). For the dedicated tab: a form that PATCHes the operator agent doc's frontmatter (provider/model/ai_key_label) via the existing document-update client. Vitest: selecting ollama + a label submits `{ provider:'ollama', model, ai_key_label }` to the agent-update mutation (assert the payload).

- [ ] **Step 4: Agent-create form**

Modify the worker agent-create form to offer the instance `(provider, label)` list (from `useInstanceAiKeys()`) so a new worker pins `provider` + `ai_key_label`. Vitest: the create payload includes the chosen `ai_key_label`.

- [ ] **Step 5: Web suite + tsc**

Run: `cd apps/web && npx vitest run` → 0 fail. `cd apps/web && bun x tsc --noEmit` → clean.

- [ ] **Step 6: Update ARCHITECTURE-INVARIANTS.md (B6 exception replaced)**

In `ARCHITECTURE-INVARIANTS.md`, update the Deliberate-exceptions entry for the runner AI-key read: it now reads by `(provider, label)` (instance credential), not the run-workspace key. Keep it a ratified narrow server-side read (mirrors `loadAgentDefinition`).

- [ ] **Step 7: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/lib/api/instance-ai-keys.ts apps/web/src/components/settings/ apps/web/src/components/<agent-create> ARCHITECTURE-INVARIANTS.md
git commit -m "phase-aikeys T11: web — instance AI-key store + operator/worker provider+label assignment; B6 invariant updated"
```

---

## Phase Gate (run after T1–T11, before merge)

- [ ] **Integration scenarios** (real HTTP/DB, assert response AND persistence): the server integration (T10) + a web acceptance — create an instance ollama key in Settings → assign the operator to it → confirm an operator run resolves it cross-workspace (the Ollama e2e, like the manual run done 2026-06-03). Mock-the-wire: at least one real request per server-filtered surface.
- [ ] **Full regression + static analysis:** `cd apps/server && bun test && bun x tsc --noEmit`; `cd apps/web && npx vitest run && bun x tsc --noEmit`; `cd packages/shared && bun test && bun x tsc --noEmit`.
- [ ] **`/shakeout`** on the full branch diff — the invariant-auditor (M4 admin-gate, M6 no-reach-widening, B6 exception updated) + security-sentinel (M1/M2 no key leak path, M8 metering+trigger present, caps-deferred residual recorded). Real-key/real-model gate: the Ollama operator run, end to end.
- [ ] **Smoke checklist (hand to user before merge):**
  ```markdown
  ## Smoke — instance AI config
  - [ ] Settings → AI (as __system admin): add an Ollama provider key (localhost). Appears in the list; no secret shown.
  - [ ] Settings → AI (as a plain member): the key store is not visible.
  - [ ] Assign the operator to ollama + a model via its surface; run it cross-workspace → it executes (the Ollama e2e).
  - [ ] Add a PAID key (e.g. anthropic) → server log shows the denial-of-wallet residual warning.
  - [ ] An ai_usage row appears per run, attributed to the run's workspace.
  - [ ] DevTools console: no red errors on the AI settings page.
  ```

---

## Self-review notes (for the executor)

- **Settled decisions (from the spec):** `ai_key_label` default `'default'` (T3); table-rebuild migration not native DROP COLUMN (T1); denial-of-wallet = metered residual (T6) + fail-loud trigger on paid-key create (T7), caps DEFERRED to their own phase.
- **Threat-model coverage:** M1 (T7 GET strips secret + T8 SECRET-class), M2 (T5 inject-only + T10 key-never-in-messages assertion — ADD that assertion to T10), M3 (T3 label-reference), M4 (T7 requireInstanceAdmin — MERGED), M6 (T5 only resolves key, T10 asserts no reach widening), M7 (T1 drop column + fail-loud), M8 (T6 metering + T7 trigger).
- **B6 reversal is the load-bearing change** (T5) — the inverted tests (T5b) are the regression guard; never delete them.
- **Run from `apps/server`** for server tests. Web: `npx vitest run`. tsc per-app. Verify branch before each commit (auto-memory-hook risk).
- **Order:** T1→T2→T3→T4→T5→T5b→T6→T7→T8→T9→T10 (server gate) → T11 → Phase Gate. T5 depends on T1-T4; T7 depends on T2 (schema) + the merged `requireInstanceAdmin`; T8 depends on T7's path.
- **testing-workflow conformance:** every task = RED→GREEN unit tests derived from the spec's acceptance criteria; every PHASE = the gate (integration real-HTTP/DB asserting response+persistence, full regression, smoke checklist). The metering-on-paid-key trigger + the key-never-leaks assertion are the must-not-skip security checks.
