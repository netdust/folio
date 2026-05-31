# Claude Code Runner Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `claude-code` as a runner backend so a Folio agent can be executed by the local `claude` CLI (which runs its own agentic loop using host SSH/files/MCP), capturing the final result as a comment and the full transcript on the run, governed by the same scope + approval model as any agent.

**Architecture:** When a run's `provider === 'claude-code'`, `runAgent` takes a **separate branch** (`ccExecute`) instead of the provider-stream `runLoop`. `claude-code` is deliberately NOT an `AIProvider` and NOT in the provider `REGISTRY` (CC owns its own tool loop; the `stream()` contract doesn't fit). A new env flag `FOLIO_CLAUDE_CODE_ENABLED` (default off) gates the whole backend. The provider-key preflight check becomes conditional so a keyless local backend passes. CC's final stdout → `kind=result` comment; CC's full transcript → the run document's `body` (no schema change).

**Tech Stack:** Bun (`Bun.spawn`), Hono, Drizzle, Zod, `bun test`. Spec: `docs/superpowers/specs/2026-05-31-claude-code-runner-backend-design.md`.

---

## Spec decisions locked (do not re-litigate)

1. **Output fidelity = C** — final result as `kind=result` comment + full transcript written to run `body`.
2. **CC→Folio auth = reuse the per-run minted token** (`ctx.token`), identical scope envelope to an API agent.
3. **Autonomy = pre-run gate only** (`requires_approval` → `awaiting_approval` before spawn). No mid-run approval.
4. **Working dir = Folio's own cwd.** Host context comes from the prompt, not the cwd. No per-agent `working_dir` in v1.
5. **Enablement** = `FOLIO_CLAUDE_CODE_ENABLED=false` by default.
6. **Integration shape = a branch in the runner, NOT an `AIProvider` impl.**

## Key existing anchors (read before starting)

- `apps/server/src/lib/runner.ts`
  - `runAgent()` entry — l.131. Branch point goes after preflight (l.149), before `buildInitialMessages`/`runLoop` (l.154–155).
  - `preflight()` — l.342; the `no_ai_key` check is l.350–357. This is the conditional to relax.
  - `runLoop()` — l.543 (the EXISTING provider path — leave untouched).
  - `postResultAndComplete()` — l.788; `postAgentComment(ctx, text, 'result'|'comment')` — l.821; `failRun(ctx, reason, detail)` — l.948.
  - `RunContext` carries `run, fm, parent, agent, agentFm, workspace, project, token, actor, transitionActor, authorContext, apiKey, baseUrl` (l.308–323).
- `apps/server/src/lib/ai/provider.ts` — `Provider` type (l.1, from agent-run-schema), `REGISTRY` (l.42), `AIProvider` (l.24). **`claude-code` must NOT be added here.**
- `apps/server/src/lib/agent-run-schema.ts` — `providerSchema = z.enum([...])` (l.63), run fm `model: z.string()` (l.73).
- `apps/server/src/lib/agent-schema.ts` — agent `provider` enum (l.12), `model: z.string().min(1)` (l.11).
- `apps/server/src/services/agent-runs.ts` — `transitionRun(runId, args)` (l.248), `incrementTokens` (l.488). `transitionRun` writes terminal status + emits the event.
- `apps/server/src/env.ts` — Zod `envSchema` (l.4–60), `FOLIO_AGENT_CHAINS_ENABLED` boolean pattern (l.56–59), `export const env = envSchema.parse(...)` (l.62).
- `PROVIDER_LABELS: Record<ProviderName, string>` — runner.ts l.86.

> **Note on `Provider` vs `ProviderName`:** `Provider` (agent-run-schema) is the closed set the `AIProvider` REGISTRY resolves. `claude-code` is added to the **schema enums** (so a run/agent can name it) but must be excluded from anything that calls `getProvider()`. The branch in Task 4 ensures `getProvider` is never called for `claude-code`.

---

### Task 1: Add `FOLIO_CLAUDE_CODE_ENABLED` env flag

**Files:**
- Modify: `apps/server/src/env.ts:56-60` (add a sibling to `FOLIO_AGENT_CHAINS_ENABLED`)
- Test: `apps/server/src/env.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `apps/server/src/env.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { envSchema } from './env.ts';

describe('FOLIO_CLAUDE_CODE_ENABLED', () => {
  test("defaults to false when unset", () => {
    const parsed = envSchema.parse({});
    expect(parsed.FOLIO_CLAUDE_CODE_ENABLED).toBe(false);
  });

  test("'false' string yields false", () => {
    const parsed = envSchema.parse({ FOLIO_CLAUDE_CODE_ENABLED: 'false' });
    expect(parsed.FOLIO_CLAUDE_CODE_ENABLED).toBe(false);
  });

  test("'true' string yields true", () => {
    const parsed = envSchema.parse({ FOLIO_CLAUDE_CODE_ENABLED: 'true' });
    expect(parsed.FOLIO_CLAUDE_CODE_ENABLED).toBe(true);
  });
});
```

> If `envSchema` is not exported, add `export` to its declaration in `env.ts` (it currently exports `env` + `Env`; export the schema too).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/env.test.ts`
Expected: FAIL — `FOLIO_CLAUDE_CODE_ENABLED` undefined / `envSchema` not exported.

- [ ] **Step 3: Add the flag**

In `apps/server/src/env.ts`, add inside `envSchema` (right after the `FOLIO_AGENT_CHAINS_ENABLED` block, before the closing `})` on l.60):

```ts
  // Gates the `claude-code` runner backend (spawns a local `claude` CLI with
  // host SSH/file access). OFF by default — only safe on local/personal installs,
  // NEVER on a shared/hosted Folio that holds fleet credentials. Same explicit
  // string→boolean transform as FOLIO_AGENT_CHAINS_ENABLED (z.coerce.boolean
  // treats 'false' as true).
  FOLIO_CLAUDE_CODE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
```

And ensure the schema is exported: `export const envSchema = z.object({ ... })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/env.test.ts
git commit -m "phase-3.x: add FOLIO_CLAUDE_CODE_ENABLED env flag"
```

---

### Task 2: Widen provider enums to accept `claude-code`; make `model` optional for it

**Files:**
- Modify: `apps/server/src/lib/agent-run-schema.ts:63` (providerSchema) + `:72-73` (run fm `provider`/`model`)
- Modify: `apps/server/src/lib/agent-schema.ts:11-12` (agent `model`/`provider`)
- Test: `apps/server/src/lib/agent-run-schema.test.ts` (append) and `apps/server/src/lib/agent-schema.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/lib/agent-run-schema.test.ts`:

```ts
import { providerSchema } from './agent-run-schema.ts';

test("providerSchema accepts claude-code", () => {
  expect(providerSchema.parse('claude-code')).toBe('claude-code');
});
```

Append to (or create) `apps/server/src/lib/agent-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { agentFrontmatterSchema } from './agent-schema.ts';

describe('claude-code agent', () => {
  test('accepts provider=claude-code with NO model', () => {
    const parsed = agentFrontmatterSchema.parse({
      provider: 'claude-code',
      tools: [],
      projects: ['*'],
    });
    expect(parsed.provider).toBe('claude-code');
    expect(parsed.model).toBeUndefined();
  });

  test('still requires model for an API provider', () => {
    expect(() =>
      agentFrontmatterSchema.parse({ provider: 'anthropic', tools: [], projects: ['*'] }),
    ).toThrow();
  });
});
```

> Confirm the exported schema name in `agent-schema.ts` (it may be `agentFrontmatterSchema` or `agentSchema`). Use the actual export.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/lib/agent-run-schema.test.ts apps/server/src/lib/agent-schema.test.ts`
Expected: FAIL — `'claude-code'` rejected; model still required.

> **PLAN CORRECTION (2026-05-31, controller ground-truth gate) — three drifts vs source:**
>
> 1. **`ProviderName` ≠ `providerSchema`.** `apps/server/src/services/agent-runs.ts:1129` defines a SEPARATE hand-maintained `ProviderName = 'anthropic'|'openai'|'openrouter'|'ollama'` + `ALL_PROVIDERS` — used ONLY by provider-HEALTH-checking (`checkProviderHealth`, `getProviderHealth`). `claude-code` is keyless/local and has NO health to check, so it must **NOT** be added to `ProviderName`/`ALL_PROVIDERS`. Add it ONLY to `providerSchema` (agent-run-schema) + the agent `provider` enum. The plan's earlier "add `claude-code` to `PROVIDER_LABELS`" was WRONG.
> 2. **`PROVIDER_LABELS` (runner.ts:86) is typed `Record<ProviderName, string>`** — since `ProviderName` stays the 4 API providers, do NOT add a claude-code key (it would be a type error). Instead make the lookup tolerate claude-code where it's indexed by `fm.provider` (e.g. `PROVIDER_LABELS[fm.provider as ProviderName] ?? 'Claude Code'`). The claude-code branch (Task 7) never reaches the provider-error label path anyway, but the type must still compile.
> 3. **`agentFrontmatterSchema.partial()` is consumed at `documents.ts:806`.** `.partial()` is a `ZodObject` method that does NOT exist on the `ZodEffects` a `.superRefine` produces. The codebase already handles this for triggers: `triggerFrontmatterSchema.innerType().partial()` (l.807). So IF you add `.superRefine`, you MUST also change `documents.ts:806` from `agentFrontmatterSchema.partial()` to `agentFrontmatterSchema.innerType().partial()` (mirroring the trigger line). Add a `safeParse` test for the agent PATCH path to prove `.partial()` still works.
> 4. **Run fm `model` (agent-run-schema) is `z.string()` (required); `createRun` does `const model = agentFm.model as string` (agent-runs.ts:114).** For a claude-code agent with no `model`, that's `undefined`. Change run fm to `model: z.string().default('')` AND `createRun` to `const model = (agentFm.model as string | undefined) ?? ''`.

- [ ] **Step 3: Widen the enums + conditionally require model**

In `apps/server/src/lib/agent-run-schema.ts` l.63:

```ts
export const providerSchema = z.enum(['anthropic', 'openai', 'openrouter', 'ollama', 'claude-code']);
```

And change run fm `model: z.string()` → `model: z.string().default('')` (claude-code runs may have no pinned model).

In `apps/server/src/lib/agent-schema.ts`, change the `provider` enum (l.12) to include `'claude-code'`, make `model` optional (l.11), and add the refinement (placed on the exported schema — note the `.innerType()` consumer fix in `documents.ts` per the correction above):

```ts
  model: z.string().min(1).optional(),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama', 'claude-code']),
```

Then, on the object schema, append a `.superRefine` — place it on the schema being exported:

```ts
.superRefine((fm, ctx) => {
  if (fm.provider !== 'claude-code' && !fm.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'model is required for API providers' });
  }
});
```

> For the **run** fm schema (`agent-run-schema.ts:73`), keep `model: z.string()` but allow empty when provider is claude-code, OR change to `model: z.string().default('')`. The run fm is produced by `createRun` from the agent; choose `.default('')` so a claude-code run with no pinned model snapshots an empty string. Update `createRun` (Task 3) to pass `''` when the agent has no model.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/lib/agent-run-schema.test.ts apps/server/src/lib/agent-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `bun --filter=server tsc --noEmit`
Expected: no new errors. (If `PROVIDER_LABELS` in runner.ts now misses a `claude-code` key and is typed `Record<ProviderName, string>`, add `'claude-code': 'Claude Code'` to it — l.86.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/agent-schema.ts apps/server/src/lib/runner.ts apps/server/src/lib/agent-run-schema.test.ts apps/server/src/lib/agent-schema.test.ts
git commit -m "phase-3.x: accept provider=claude-code; model optional for it"
```

---

### Task 3: Make the provider-key preflight conditional (keyless backend passes)

**Files:**
- Modify: `apps/server/src/lib/runner.ts:350-357` (the `no_ai_key` check in `preflight`)
- Test: `apps/server/src/lib/runner.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/lib/runner.test.ts` a test that seeds a `claude-code` run with NO ai_key and asserts preflight does NOT fail it with `no_ai_key`. Follow the existing seed helpers in that file (look for how other runner.test.ts cases create a run + agent). Assert the run is NOT transitioned to `failed`/`no_ai_key`:

```ts
test('claude-code run is not blocked by missing AI key', async () => {
  // ...seed workspace/project/agent(provider:'claude-code')/run via the file's existing helpers...
  // With FOLIO_CLAUDE_CODE_ENABLED unset, the run should fail with `claude_code_disabled`
  // (Task 4), NOT `no_ai_key`. Assert the failure reason is not 'no_ai_key'.
  const after = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  const fm = after!.frontmatter as AgentRunFrontmatter;
  expect(fm.error_reason).not.toBe('no_ai_key');
});
```

> Reuse the seeding pattern already present in `runner.test.ts`. Do not invent new helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/lib/runner.test.ts -t "not blocked by missing AI key"`
Expected: FAIL — current preflight fails any keyless run with `no_ai_key`.

- [ ] **Step 3: Relax the check**

In `apps/server/src/lib/runner.ts`, change the l.350 block from:

```ts
  if (!ctx.apiKey) {
```

to:

```ts
  // claude-code is a keyless local backend — it spawns the `claude` CLI, which
  // authenticates itself. Skip the BYOK key requirement for it.
  if (ctx.fm.provider !== 'claude-code' && !ctx.apiKey) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/lib/runner.test.ts -t "not blocked by missing AI key"`
Expected: PASS (the run is no longer failed with `no_ai_key`; it will fail with the Task-4 disabled reason until the flag is on).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-3.x: skip no_ai_key preflight for claude-code backend"
```

---

### Task 4: Add the `error_reason` value `claude_code_disabled` and gate the backend in preflight

**Files:**
- Modify: `apps/server/src/lib/agent-run-schema.ts` (`runErrorReasonSchema` enum — grep for `runErrorReasonSchema`)
- Modify: `apps/server/src/lib/runner.ts` (preflight — add the gate after the key check, ~l.357)
- Test: `apps/server/src/lib/runner.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `runner.test.ts`:

```ts
test('claude-code run fails with claude_code_disabled when flag is off', async () => {
  const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
  (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = false;
  try {
    // ...seed a claude-code run via existing helpers, call runAgent({ runId })...
    const after = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
    const fm = after!.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('claude_code_disabled');
  } finally {
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
  }
});
```

> Mutating `env.FOLIO_CLAUDE_CODE_ENABLED` in-test mirrors the `FOLIO_AGENT_CHAINS_ENABLED` test pattern in `agent-tools.test.ts:835`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/lib/runner.test.ts -t "claude_code_disabled"`
Expected: FAIL — `claude_code_disabled` is not a valid `error_reason` yet; no gate exists.

- [ ] **Step 3: Add the enum value + the preflight gate**

In `agent-run-schema.ts`, add `'claude_code_disabled'` to the `runErrorReasonSchema` enum members.

In `runner.ts` `preflight`, immediately AFTER the relaxed key check (after l.357), add:

```ts
  // claude-code backend gate: refuse to spawn a local CLI unless explicitly
  // enabled for this install (spec decision 5).
  if (ctx.fm.provider === 'claude-code' && !env.FOLIO_CLAUDE_CODE_ENABLED) {
    await failRun(
      ctx,
      runErrorReasonSchema.enum.claude_code_disabled,
      'The claude-code backend is disabled. Set FOLIO_CLAUDE_CODE_ENABLED=true to enable it.',
    );
    return true;
  }
```

Ensure `env` is imported in `runner.ts` (grep — `import { env } from '../env.ts'` likely already present via trigger-matcher's pattern; if not, add it).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/lib/runner.test.ts -t "claude_code_disabled"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-3.x: gate claude-code backend behind FOLIO_CLAUDE_CODE_ENABLED"
```

---

### Task 5: The `ccExecute` executor — spawn, capture, map exit (pure unit, mocked spawn)

**Files:**
- Create: `apps/server/src/lib/cc-executor.ts`
- Test: `apps/server/src/lib/cc-executor.test.ts`

This is the meaty part. The executor takes a loaded `RunContext`, spawns `claude`, captures stdout (transcript), and returns a structured outcome. **Spawning is injected** so the test never launches a real process.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/cc-executor.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { runClaudeCode, type SpawnFn, type CcOutcome } from './cc-executor.ts';

function fakeSpawn(opts: { stdout: string; exitCode: number }): SpawnFn {
  return () => ({
    stdoutText: async () => opts.stdout,
    exited: Promise.resolve(opts.exitCode),
    kill: () => {},
  });
}

describe('runClaudeCode', () => {
  test('clean exit returns completed + transcript + final result', async () => {
    const outcome: CcOutcome = await runClaudeCode(
      { systemPrompt: 'do the thing', model: undefined, mcpToken: 'tok_123', cwd: '/tmp' },
      { spawn: fakeSpawn({ stdout: 'line1\nFINAL RESULT', exitCode: 0 }) },
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.transcript).toContain('line1');
    expect(outcome.result).toContain('FINAL RESULT');
  });

  test('non-zero exit returns failed with detail', async () => {
    const outcome = await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 't', cwd: '/tmp' },
      { spawn: fakeSpawn({ stdout: 'boom', exitCode: 1 }) },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toMatch(/exit code 1/i);
  });

  test('passes --model when provided', async () => {
    let capturedArgs: string[] = [];
    const spy: SpawnFn = (args) => {
      capturedArgs = args.argv;
      return { stdoutText: async () => 'ok', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: 'claude-opus-4-8', mcpToken: 't', cwd: '/tmp' },
      { spawn: spy },
    );
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('claude-opus-4-8');
  });

  test('omits --model when not provided', async () => {
    let capturedArgs: string[] = [];
    const spy: SpawnFn = (args) => {
      capturedArgs = args.argv;
      return { stdoutText: async () => 'ok', exited: Promise.resolve(0), kill: () => {} };
    };
    await runClaudeCode(
      { systemPrompt: 'x', model: undefined, mcpToken: 't', cwd: '/tmp' },
      { spawn: spy },
    );
    expect(capturedArgs).not.toContain('--model');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/lib/cc-executor.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `cc-executor.ts`**

```ts
/**
 * claude-code backend executor. Spawns the local `claude` CLI in print mode,
 * captures its full stdout as the run transcript, and derives a final result
 * line for the run's kind=result comment. Spawning is injected (SpawnFn) so the
 * logic is unit-testable without launching a process.
 *
 * Folio-side auth: the per-run minted token is wired into CC's MCP config via
 * env, so CC's callbacks into Folio's MCP server carry the agent's exact scopes
 * (spec decision 2). Host-side powers (SSH, wp, files) are governed by the
 * machine, outside Folio's envelope (spec).
 */

export interface SpawnHandle {
  stdoutText: () => Promise<string>;
  exited: Promise<number>;
  kill: () => void;
}

export type SpawnFn = (args: { argv: string[]; cwd: string; env: Record<string, string> }) => SpawnHandle;

export interface CcInput {
  systemPrompt: string;
  model: string | undefined;
  mcpToken: string;
  cwd: string;
}

export type CcOutcome =
  | { status: 'completed'; transcript: string; result: string }
  | { status: 'failed'; transcript: string; detail: string };

/** Default spawn using Bun.spawn. */
const defaultSpawn: SpawnFn = ({ argv, cwd, env }) => {
  const proc = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdoutText: () => new Response(proc.stdout).text(),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

export async function runClaudeCode(
  input: CcInput,
  deps: { spawn?: SpawnFn } = {},
): Promise<CcOutcome> {
  const spawn = deps.spawn ?? defaultSpawn;

  const argv = ['claude', '-p', input.systemPrompt];
  if (input.model) argv.push('--model', input.model);

  // The minted token is exposed to CC's MCP client config. The exact env var
  // name is the one CC's Folio MCP server entry reads; FOLIO_MCP_TOKEN is the
  // agreed contract (documented in INSTALL/API).
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    FOLIO_MCP_TOKEN: input.mcpToken,
  };

  const handle = spawn({ argv, cwd: input.cwd, env: childEnv });
  const transcript = await handle.stdoutText();
  const exitCode = await handle.exited;

  if (exitCode !== 0) {
    return { status: 'failed', transcript, detail: `claude exited with exit code ${exitCode}` };
  }

  // Final result = the trimmed transcript (CC's -p prints its answer to stdout).
  // The whole transcript is preserved separately on the run body.
  const result = transcript.trim().length > 0 ? transcript.trim() : '(no output)';
  return { status: 'completed', transcript, result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/lib/cc-executor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check + commit**

Run: `bun --filter=server tsc --noEmit` — expect clean.

```bash
git add apps/server/src/lib/cc-executor.ts apps/server/src/lib/cc-executor.test.ts
git commit -m "phase-3.x: cc-executor — spawn/capture/map claude CLI (injected spawn)"
```

---

### Task 6: Persist the transcript to the run `body`

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts` (add `setRunBody(runId, body)` helper near `incrementTokens`, l.488)
- Test: `apps/server/src/services/agent-runs.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { setRunBody } from './agent-runs.ts';

test('setRunBody writes the transcript to the run document body', async () => {
  // ...seed an agent_run document via existing helpers, capture runId...
  await setRunBody(runId, 'FULL TRANSCRIPT TEXT');
  const row = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  expect(row!.body).toBe('FULL TRANSCRIPT TEXT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/services/agent-runs.test.ts -t "setRunBody"`
Expected: FAIL — `setRunBody` not exported.

- [ ] **Step 3: Implement `setRunBody`**

In `apps/server/src/services/agent-runs.ts`, add (mirror the existing update style in this file — it already imports `db`, `documents`, `eq`):

```ts
/**
 * Persist a claude-code run's full session transcript onto the run document's
 * body (unused for API-loop runs). Plain update — NOT event-emitting; the
 * transcript is metadata, the terminal transition (transitionRun) carries the
 * event. Caller invokes this BEFORE transitionRun so the body is present when
 * `agent.run.completed` fires.
 */
export async function setRunBody(runId: string, body: string): Promise<void> {
  await db
    .update(documents)
    .set({ body })
    .where(and(eq(documents.id, runId), eq(documents.type, 'agent_run')));
}
```

> Confirm `and` is imported in this file (it is used by `transitionRun`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/services/agent-runs.test.ts -t "setRunBody"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/agent-runs.ts apps/server/src/services/agent-runs.test.ts
git commit -m "phase-3.x: setRunBody — persist CC transcript on the run document"
```

---

### Task 7: Wire the branch into `runAgent` (ccExecute path)

> **PLAN CORRECTION (2026-05-31, controller ground-truth gate) — the run's token has no recoverable plaintext.** The plan said `mcpToken: ctx.token.token`. VERIFIED FALSE: `apiTokens` stores only `tokenHash` (sha256 of the bearer); the plaintext is shown once at mint and discarded (`documents.ts:556` `newApiToken()` → plaintext used then dropped). `ctx.token` is an `ApiToken` row (runner.ts:107) with NO `.token` field. So Folio cannot recover the run-token plaintext to hand to CC.
> **Scope decision (user, 2026-05-31): "Minimal branch now, MCP token as fast-follow."** Task 7 ships the executor branch WITHOUT an MCP token: spawn → transcript→body → result comment → `completed`. Pass `mcpToken: ''` (CC gets no Folio token; its MCP callbacks would 401, acceptable for v1 — host-side work still runs). The fresh-token mint/scope/revoke lifecycle is split out to **Task 7b** (deferred; uses `newApiToken()` + `toolsToScopes(agent.tools)` + agent `projectIds`, then revoke post-run). Update the self-review's "token reuse" claim accordingly.

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (branch after preflight — current branch point is the `const messages = await buildInitialMessages(ctx); await runLoop(ctx, messages);` pair at ~l.153-155, post Tasks 2–4)
- Test: `apps/server/src/lib/runner.test.ts` (append — integration over the runner with an injected spawn)

The branch calls the executor, persists the transcript, posts the result comment, and transitions the run. To keep the executor injectable in the runner test, expose a module-level spawn override on the runner (mirroring the provider `__INTERNAL_TEST_ONLY__` pattern already in `provider.ts`).

- [ ] **Step 1: Write the failing test**

Append to `runner.test.ts`:

```ts
test('claude-code run: end-to-end completes, posts result, stores transcript', async () => {
  const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
  (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = true;
  __setCcSpawnForTest(() => ({
    stdoutText: async () => 'did health check\nALL GOOD',
    exited: Promise.resolve(0),
    kill: () => {},
  }));
  try {
    // ...seed agent(provider:'claude-code', requires_approval:false)/run via helpers...
    await runAgent({ runId });

    const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
    const fm = run!.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('completed');
    expect(run!.body).toContain('did health check');

    // a kind=result comment exists on the parent
    const comments = await db.query.documents.findMany({
      where: and(eq(documents.parentId, parentId), eq(documents.type, 'comment')),
    });
    const result = comments.find((c) => (c.frontmatter as { kind?: string }).kind === 'result');
    expect(result?.body).toContain('ALL GOOD');
  } finally {
    __setCcSpawnForTest(undefined);
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/lib/runner.test.ts -t "end-to-end completes"`
Expected: FAIL — no branch; `__setCcSpawnForTest` undefined.

- [ ] **Step 3: Implement the branch + test hook**

In `runner.ts`, add imports:

```ts
import { runClaudeCode, type SpawnFn } from './cc-executor.ts';
import { setRunBody } from '../services/agent-runs.ts';
```

Add a module-level test override near the top of `runner.ts`:

```ts
// Test-only spawn override for the claude-code branch (mirrors provider.ts).
let __ccSpawnOverride: SpawnFn | undefined;
export function __setCcSpawnForTest(fn: SpawnFn | undefined): void {
  __ccSpawnOverride = fn;
}
```

In `runAgent`, replace l.154–155 (`const messages = await buildInitialMessages(ctx); await runLoop(ctx, messages);`) with:

```ts
    if (ctx.fm.provider === 'claude-code') {
      await ccExecute(ctx);
    } else {
      const messages = await buildInitialMessages(ctx);
      await runLoop(ctx, messages);
    }
```

Add `ccExecute` near `postResultAndComplete` (l.788):

```ts
/**
 * claude-code execution branch. CC runs its own agentic loop to completion; we
 * capture the transcript onto the run body, post the final result as a
 * kind=result comment, and transition the run. Pre-run approval (requires_approval)
 * is already handled by the existing awaiting_approval gate before this point.
 */
async function ccExecute(ctx: RunContext): Promise<void> {
  const outcome = await runClaudeCode(
    {
      systemPrompt: ctx.fm.system_prompt,
      model: ctx.fm.model && ctx.fm.model.length > 0 ? ctx.fm.model : undefined,
      mcpToken: '', // Task 7b will mint a fresh scoped token; v1 ships no MCP callback (see correction above)
      cwd: process.cwd(),
    },
    __ccSpawnOverride ? { spawn: __ccSpawnOverride } : {},
  );

  // Always persist the transcript (even on failure) for audit.
  await setRunBody(ctx.run.id, outcome.transcript);

  if (outcome.status === 'failed') {
    await failRun(ctx, runErrorReasonSchema.enum.provider_error, outcome.detail);
    return;
  }

  await postAgentComment(ctx, outcome.result, 'result');
  await transitionRun(ctx.run.id, { newStatus: 'completed', actor: ctx.transitionActor });
}
```

> `transitionRun(runId, { newStatus, actor })` is already imported in runner.ts (l.47); `actor` is required, `doneReason`/`completedAt` optional — the call above is valid. `mcpToken` is intentionally `''` in v1 per the correction above.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/lib/runner.test.ts -t "end-to-end completes"`
Expected: PASS.

- [ ] **Step 5: Type-check + full server suite + commit**

Run: `bun --filter=server tsc --noEmit` — expect clean.
Run: `bun test apps/server` — expect no regressions (all prior runner/schema tests green).

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-3.x: wire ccExecute branch into runAgent"
```

---

### Task 8: Pre-run approval gate works for claude-code (verify, don't rebuild)

The `awaiting_approval` gate already runs in `createRun`/the trigger path BEFORE `runAgent` reaches the branch. This task adds a regression test proving a `requires_approval: true` claude-code agent does NOT spawn until approved.

**Files:**
- Test only: `apps/server/src/lib/runner.test.ts` (append)

- [ ] **Step 1: Write the test**

```ts
test('claude-code with requires_approval does not spawn before approval', async () => {
  const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
  (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = true;
  let spawned = false;
  __setCcSpawnForTest(() => {
    spawned = true;
    return { stdoutText: async () => '', exited: Promise.resolve(0), kill: () => {} };
  });
  try {
    // ...seed agent(provider:'claude-code', requires_approval:true) + create a run
    //    through the SAME path that normally yields awaiting_approval...
    // The run should be at awaiting_approval and the spawn must NOT have run.
    const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
    const fm = run!.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('awaiting_approval');
    expect(spawned).toBe(false);
  } finally {
    __setCcSpawnForTest(undefined);
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
  }
});
```

> Use the file's existing helper that creates an approval-gated run (grep `awaiting_approval` in runner.test.ts for the pattern). If the gate lives in `createRun`, drive it through that; do not call `runAgent` directly for the planning row.

- [ ] **Step 2: Run test**

Run: `bun test apps/server/src/lib/runner.test.ts -t "does not spawn before approval"`
Expected: PASS immediately (gate already exists). If it FAILS because the run auto-advanced, the gate ordering is wrong for claude-code — fix by ensuring the branch in Task 7 is only reachable for `running` runs (it is: `runAgent` is only invoked by the poller for claimed `planning`/approved rows, and the approval gate holds the run at `awaiting_approval` before claim).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/runner.test.ts
git commit -m "phase-3.x: regression — claude-code respects pre-run approval gate"
```

---

### Task 9: UI — show `claude-code` as a provider option only when enabled

**Files:**
- Modify: `apps/web/src/.../ProviderModelField` (grep `ProviderModelField` — it lives in the agent FrontmatterForm; the spec references it)
- Modify: a server-exposed flag the web can read (add `claudeCodeEnabled` to the existing bootstrap/config endpoint the web already fetches — grep for where `FOLIO_*` or instance config reaches the client; if none, expose via the existing `/api/v1/me` or workspace config response)
- Test: `apps/web/src/.../provider-model-field.test.tsx` (append)

- [ ] **Step 1: Write the failing test**

In the ProviderModelField test, assert: when `claudeCodeEnabled` is false the select has no `claude-code` option; when true it does, and selecting it hides/relaxes the model requirement (model becomes optional / shows "uses Claude Code default").

```tsx
test('claude-code option hidden when disabled', () => {
  render(<ProviderModelField value={{ provider: 'anthropic' }} claudeCodeEnabled={false} onChange={() => {}} />);
  expect(screen.queryByRole('option', { name: /claude code/i })).toBeNull();
});

test('claude-code option shown when enabled', () => {
  render(<ProviderModelField value={{ provider: 'anthropic' }} claudeCodeEnabled={true} onChange={() => {}} />);
  expect(screen.getByRole('option', { name: /claude code/i })).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/**/provider-model-field.test.tsx` (web uses vitest, not bun test)
Expected: FAIL — prop/option absent.

- [ ] **Step 3: Implement**

- Add `claudeCodeEnabled?: boolean` prop to `ProviderModelField`; conditionally include the `claude-code` option.
- When `provider === 'claude-code'`: render the model select as optional with a "uses Claude Code's default model" placeholder, and a "no key needed" annotation (reuse the existing "no key" badge styling).
- Thread `claudeCodeEnabled` from wherever the form gets instance/workspace config. Source it from the server flag exposed in this task. If wiring the server flag is non-trivial, expose it minimally on the existing config/me response as `claude_code_enabled: env.FOLIO_CLAUDE_CODE_ENABLED` and read it in the web config hook.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/src/**/provider-model-field.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `bun x tsc --noEmit` (from `apps/web`) — expect clean.

```bash
git add apps/web apps/server/src
git commit -m "phase-3.x: surface claude-code provider option only when enabled"
```

---

### Task 10: Docs — document the backend, the env flag, and the MCP token contract

**Files:**
- Modify: `docs/INSTALL.md` (add `FOLIO_CLAUDE_CODE_ENABLED`)
- Modify: `docs/API.md` (document the `claude-code` provider, the keyless behavior, the `FOLIO_MCP_TOKEN` env contract CC reads, and that the run `body` holds the transcript)
- Modify: `docs/PHASES.md` (add a "Phase 3.x — claude-code runner backend — SHIPPED" subsection under the Phase 3 area)

- [ ] **Step 1: Write the docs**

Add to `docs/INSTALL.md` an env-var row:

```
| `FOLIO_CLAUDE_CODE_ENABLED` | `false` | Enable the `claude-code` runner backend (spawns the local `claude` CLI with host SSH/file access). Local/personal installs only — NEVER on a shared host with fleet credentials. Requires the `claude` binary on PATH. |
```

Add to `docs/API.md` a "claude-code backend" section covering: provider value `claude-code`; no AI key required; CC authenticates itself; Folio passes the per-run minted token via `FOLIO_MCP_TOKEN` so CC's MCP callbacks carry the agent's scopes; the full session transcript is stored on the run document's `body`, the final answer as a `kind=result` comment.

Add to `docs/PHASES.md` under Phase 3:

```markdown
## Phase 3.x — claude-code runner backend — SHIPPED 2026-05-31

A fifth runner backend: execute an agent via the local `claude` CLI instead of a BYOK API provider. Off by default (`FOLIO_CLAUDE_CODE_ENABLED`). CC runs its own loop using host SSH/files/MCP; final result → kind=result comment, full transcript → run body. Pre-run approval gate only. Spec: `docs/superpowers/specs/2026-05-31-claude-code-runner-backend-design.md`. Plan: `docs/superpowers/plans/2026-05-31-claude-code-runner-backend.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INSTALL.md docs/API.md docs/PHASES.md
git commit -m "docs: claude-code runner backend — install, API, phases"
```

---

### Task 7b: Wire CC's MCP callback into Folio (mint token + --mcp-config)

> **Added 2026-05-31** after the user asked "can the agent do work via MCP?" — answer was NO: v1 shipped one-way (CC does host work; can't write back into Folio). This task wires the callback loop. **Ground-truthed against the real machine:** `claude 2.1.158` supports `--mcp-config <json-string-or-file>` + `--strict-mcp-config`. The HTTP MCP config shape (verified from the user's own `~/.claude.json` `stitch` entry) is `{ "type": "http", "url": "...", "headers": { "Authorization": "Bearer <tok>" } }`. Folio's MCP endpoint is `POST /mcp` — **root-level, NOT under `/api/v1`, NOT workspace-scoped in the URL** (`app.ts:100`); the bearer resolves workspace+agent. So the URL is `${env.PUBLIC_URL}/mcp`.

**Files:**
- Modify: `apps/server/src/lib/cc-executor.ts` (add `mcpUrl` to `CcInput`; build `--mcp-config` argv when token+url present)
- Modify: `apps/server/src/lib/runner.ts` (`ccExecute` mints a token, passes url, revokes after)
- Test: `cc-executor.test.ts` (argv includes `--mcp-config` + `--strict-mcp-config` with the right JSON) + `runner.test.ts` (token minted with same scopes/workspace/agent/projectIds as `ctx.token`, and revoked after the run)

**Design (verified):**
- Mint in `ccExecute` via `newApiToken()` (`auth.ts:54` → `{ token, hash }`). Insert an `apiTokens` row mirroring `ctx.token`: same `workspaceId`, `agentId`, `scopes`, `projectIds`, `name: 'cc-run:<runId>'`, `tokenHash: hash`. This guarantees the IDENTICAL scope envelope (locked decision #2) without recomputing scopes.
- Build inline config string: `JSON.stringify({ mcpServers: { folio: { type: 'http', url: `${env.PUBLIC_URL}/mcp`, headers: { Authorization: `Bearer ${token}` } } } })`.
- In `cc-executor.ts`: when `mcpToken` AND `mcpUrl` are present, push `'--mcp-config', <configString>, '--strict-mcp-config'` to argv. Keep `FOLIO_MCP_TOKEN` env too (belt-and-suspenders / future). When absent, omit (preserves the v1 no-callback behavior + existing tests).
- After the run completes (success OR fail), revoke: `db.delete(apiTokens).where(eq(apiTokens.id, <minted id>))`. Wrap in try/finally so a thrown run still revokes. (The agent-delete cascade is the backstop, but explicit revoke is the short-lived-token contract.)

**TDD:** unit-test the argv shaping in cc-executor (config JSON parses, contains the URL + Bearer); integration-test in runner that the minted token row exists during the run and is gone after. Keep all existing tests green (they pass `mcpToken: ''` / no url → no `--mcp-config`).

**Commit:** `phase-3.x: wire CC MCP callback — mint scoped token + --mcp-config (Task 7b)`

---

## Final verification (run after all tasks)

- [ ] `bun test apps/server` — full server suite green (no regressions).
- [ ] `npx vitest run` in `apps/web` — web suite green.
- [ ] `bun --filter=server tsc --noEmit` and `bun x tsc --noEmit` (web) — clean.
- [ ] **Manual local-only smoke (real `claude`):** set `FOLIO_CLAUDE_CODE_ENABLED=true`, create a `claude-code` agent whose body says "use the Folio MCP `get_document` tool to read document X and report its title", assign it to a work item, and confirm: run completes, `kind=result` comment carries the title, run `body` holds the transcript, and the MCP callback was scoped to the agent's allow-list. This proves the loop end-to-end on a READ-ONLY task before any maintenance runbook touches a site.

---

## Self-review notes (author)

- **Spec coverage:** fidelity-C (Tasks 5–7), token reuse (Task 7 `mcpToken: ctx.token.token`), pre-run gate (Task 8), Folio cwd (Task 7 `process.cwd()`), flag-off default (Tasks 1, 4, 9), branch-not-provider (Task 7; `claude-code` never added to REGISTRY). All six decisions covered.
- **Deferrals respected:** no file-sync, no mid-run approval, no live streaming, no per-agent working_dir, no WP content. None appear as tasks.
- **Open verification points flagged inline** (not placeholders — confirmations against source): exact exported schema name in `agent-schema.ts`; `apiTokens` bearer column name for `ctx.token.token`; whether `env` is already imported in `runner.ts`; the existing approval-gate helper in `runner.test.ts`; the web config channel for `claude_code_enabled`. Each task says to grep/confirm the real symbol before relying on it.
