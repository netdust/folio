# Re-enable the local Claude Code provider (attended-only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-enable the existing `claude-code` runner backend so an attended operator/cockpit run on an explicitly opted-in local install can drive the host's own `claude -p` subprocess — while trigger (unattended) runs stay refused.

**Architecture:** The `claude-code` backend (`cc-executor.ts` + `ccExecute` in `runner.ts`) is reused unchanged. The change is three narrow edits: (1) widen the shared operator-model schema's provider enum to accept `claude-code` (without widening `AI_PROVIDERS`) and exempt cc from the route's key-referential check; (2) replace the runner's blanket cc deny with an attended-operator + env-opt-in allow, threaded into the conversation path (the operator path) and keeping the document/trigger path a hard deny — plus a keyless exemption so a missing `ai_keys` row for cc is not a preflight failure; (3) surface a keyless "Claude Code (local)" operator option in Settings → AI. No schema change, no migration.

**Tech Stack:** Bun, Hono, Drizzle, Zod, React + Vite, Vitest (web) / `bun test` (server + shared), Biome.

## Global Constraints

- **TypeScript everywhere, `strict: true`.** No `any` — use `unknown` and narrow. (`noExplicitAny` is `warn`, not a commit blocker — never `--no-verify` on a warning.)
- **No new default exports** (routers/route components excepted).
- **`AI_PROVIDERS` (`packages/shared/src/ai-providers.ts`) is the 4 KEYED providers** — `['anthropic','openai','openrouter','ollama']`. It feeds keyed-provider logic elsewhere and MUST NOT be widened to include `claude-code`. Widen only the operator-model provider union, in `operator-model-schema.ts`, via a dedicated `[...AI_PROVIDERS, 'claude-code']`.
- **cc carries no secret and gets no `ai_keys` row.** `aiKeys.provider` (`schema.ts:427`) is the TS enum `['anthropic','openai','openrouter','ollama']` (no SQL CHECK) — leave it untouched. cc is keyless like Ollama but stores nothing.
- **The gate condition is exactly:** `attended = ctx.conversationId != null && ctx.unattended !== true`, AND `env.FOLIO_CLAUDE_CODE_ENABLED === true`. Both must hold. `env.FOLIO_CLAUDE_CODE_ENABLED` is already a parsed boolean (`env.ts:68-71`, defaults `false`).
- **`claude_code_disabled` is the failure reason** (`runErrorReasonSchema.enum.claude_code_disabled`, `agent-run-schema.ts:25`) and its message MUST distinguish "flag off" from "not an attended run."
- **Model sentinel:** the operator-model `model` may be the literal `'default'` → the cc path must omit `--model` (map `'default'`→undefined). Do NOT relax `operatorModelSettingSchema.model`'s `.min(1)`.
- **Build/test commands (run from the exact dirs — a repo-root `bun test` fakes ~650 failures):**
  - Server: `cd apps/server && bun test`
  - Shared: `cd packages/shared && bun test`
  - Web: `cd apps/web && npx vitest run` (NOT `bun test`)
  - Typecheck: `bun x tsc --noEmit` from EACH of `apps/server`, `apps/web`, `packages/shared` (no root tsconfig)
- **No migration** is created by this plan. If you believe one is needed, STOP — re-read the Global Constraints; the operator-model setting is a JSON value in `instance_settings`, the flag is env, and cc needs no `ai_keys` row.
- **Commits:** `phase-*: <what>` or `feat:` — atomic, one per task.

---

## Plan corrections from Stage 1c ground-truth (read before starting)

These are verified deltas from the design spec. The spec's section references were checked against live source; where they drift, **this plan's signatures win**.

1. **The gate moves to the conversation path — it does NOT stay at `runner.ts:882`.** The spec says "rewrite the runner preflight gate at `runner.ts:882`." That gate lives in `preflight()` (the **document/trigger** path). **Operator/cockpit runs route through `conversationPreflight()` instead** (`runner.ts:342` chooses `ctx.runSink.isConversation ? conversationPreflight(ctx) : preflight(ctx)`), which has **no cc gate today** — cc was simply unselectable for the operator. The attended-allow + trigger-denial logic therefore belongs in a shared helper both paths call: `preflight()` keeps a **hard deny** (a document/trigger run is never attended), and `conversationPreflight()` gets the **attended-allow** branch. Task 2 implements both.
2. **The keyless exemption site is `conversationPreflight` (`runner.ts:1037-1038`), not `preflight` step-1.** Both of its blocking clauses — `ctx.keyRowMissing` and `requiresKey && !ctx.apiKey` (where `requiresKey = ctx.fm.provider !== 'ollama'`) — would block cc. Both must treat cc as keyless.
3. **The PUT /operator-model route has a second gate the spec missed.** `instance-ai-keys.ts:63-68` does a referential `ai_keys` lookup by `(v.provider, v.aiKeyLabel)` and returns 422 if no row exists. cc has no row → setting the operator to cc would be rejected there even after the schema widens. Task 1 must exempt `provider === 'claude-code'` from that referential check.
4. **Web surface: `ProviderModelField`'s `claude_code_enabled` plumbing is a red herring for the operator selector.** The operator model is set in `ai-tab.tsx` via a per-`ai_keys`-row "Use for operator" button (`ai-tab.tsx:397-421`), and cc has no row, so there is structurally no operator-cc affordance there today. `provider-model-field.tsx`'s workspace-flag gate is the **per-agent** provider picker — a different surface, not touched. Task 3 adds a synthesized keyless "Claude Code (local)" operator entry directly in `ai-tab.tsx`. **No server-sent `claude_code_enabled` signal is needed** for the operator selector (decision: always show, fail loud at run).
5. **The `'default'` model sentinel is not stripped today.** `ccExecute` (`runner.ts:1895`) maps only empty/missing → undefined: `ctx.fm.model && ctx.fm.model.length > 0 ? ctx.fm.model : undefined`. A literal `'default'` would pass through as `--model default`. Task 2 maps `'default'` (case-insensitive, trimmed) → undefined at that line so the local Claude Code picks its own model.
6. **Stale doc comments (fix opportunistically, not load-bearing):** the `preflight` step-0 comment references `runner.ts:209/293` — the real cc branch points are `runAgent` `348` and `runAgentResume` `460`. The `ccExecute` header (`runner.ts:1823`) still says "v1 passes no MCP token (mcpToken: '')" but the mint exists at `1835-1846`. Update these comments where you edit the surrounding code.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/shared/src/operator-model-schema.ts` | The single operator-model contract (provider/model/aiKeyLabel). | Widen the provider enum to `[...AI_PROVIDERS, 'claude-code']` via a local `OPERATOR_MODEL_PROVIDERS` const. |
| `packages/shared/src/operator-model-schema.test.ts` | Unit tests for the schema (create if absent). | Add cc-accept + garbage-reject + key-creation-misuse cases. |
| `apps/server/src/routes/instance-ai-keys.ts` | PUT/GET `/operator-model`; POST/DELETE/GET `/ai-keys`. | Exempt `claude-code` from the PUT referential `ai_keys` check. |
| `apps/server/src/routes/instance-ai-keys.test.ts` | Route tests (create-or-extend). | Add: PUT cc with no key row → 200 (not 422); PUT a keyed provider with no row → still 422. |
| `apps/server/src/lib/runner.ts` | Run lifecycle, preflight, conversationPreflight, ccExecute, the model-string read. | New `ccGateBlocks(ctx)` helper; wire into `preflight` (hard deny) + `conversationPreflight` (attended-allow + keyless exemption); map `'default'`→undefined at the cc model read. |
| `apps/server/src/lib/runner.test.ts` | Runner tests incl. the existing cc cases. | UPDATE the existing "hard-disabled" cc tests to the new contract; ADD the conversation-path RED cases (incl. the S-1 trigger-denial guard). |
| `apps/web/src/components/settings/ai-tab.tsx` | Settings → AI: key CRUD + operator-model selection. | Add a synthesized keyless "Claude Code (local)" operator option + a "Use for operator" affordance for it. |
| `apps/web/src/components/settings/ai-tab.test.tsx` | AI-tab component test. | Extend: the cc operator option renders and calls `setOperatorModel` with `{provider:'claude-code', model:'default', aiKeyLabel:'default'}`. |

---

## Review-group plan (1f / 1h)

One tight cluster, **3 tasks**, **FULL review tier** — it touches the AI-provider boundary + a security gate (the attended/trigger refusal) + subprocess execution, all 1a threat-model trigger surfaces. The `── REVIEW GATE ──` marker sits after Task 3. `/security-review` is mandatory at the gate (an approved `## Threat model` exists in the design spec — it is the review convergence target).

---

### Task 1: Widen the operator-model provider enum to accept `claude-code` (keyless)

Accept `provider: 'claude-code'` on the operator-model setting (schema + route), without widening `AI_PROVIDERS` and without requiring an `ai_keys` row. This is a validation/parsing boundary → **Tier A**.

**Files:**
- Modify: `packages/shared/src/operator-model-schema.ts`
- Test: `packages/shared/src/operator-model-schema.test.ts` (create if absent)
- Modify: `apps/server/src/routes/instance-ai-keys.ts:56-70` (the PUT `/operator-model` referential check)
- Test: `apps/server/src/routes/instance-ai-keys.test.ts` (create-or-extend)

**Interfaces:**
- Consumes: `AI_PROVIDERS` (`['anthropic','openai','openrouter','ollama'] as const`) from `packages/shared/src/ai-providers.ts`.
- Produces:
  - `OPERATOR_MODEL_PROVIDERS = [...AI_PROVIDERS, 'claude-code'] as const` (exported from `operator-model-schema.ts`).
  - `operatorModelSettingSchema` now validates `provider: z.enum(OPERATOR_MODEL_PROVIDERS)`.
  - `OperatorModelSetting.provider` is now `'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'claude-code'`. (The web type follows automatically — `apps/web/src/lib/api/instance-ai-keys.ts` imports `OperatorModelSetting` from `@folio/shared`.)
  - PUT `/operator-model` accepts `{provider:'claude-code', model, aiKeyLabel}` with **no** `ai_keys` row (returns 200); a non-cc provider with no matching row still returns 422.

- [ ] **Step 1: Write the failing shared-schema test**

Create/extend `packages/shared/src/operator-model-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { operatorModelSettingSchema } from './operator-model-schema.ts';

describe('operatorModelSettingSchema — claude-code provider', () => {
  test('accepts provider: claude-code with the default model sentinel', () => {
    const r = operatorModelSettingSchema.safeParse({
      provider: 'claude-code',
      model: 'default',
      aiKeyLabel: 'default',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.provider).toBe('claude-code');
  });

  test('still accepts the four keyed providers', () => {
    for (const p of ['anthropic', 'openai', 'openrouter', 'ollama'] as const) {
      expect(operatorModelSettingSchema.safeParse({ provider: p, model: 'm' }).success).toBe(true);
    }
  });

  test('rejects an unknown provider (e.g. a per-customer-style misuse)', () => {
    expect(
      operatorModelSettingSchema.safeParse({ provider: 'openai-customer-acme', model: 'm' }).success,
    ).toBe(false);
  });

  test('still rejects an empty model (min(1) preserved — the default sentinel is a non-empty string)', () => {
    expect(
      operatorModelSettingSchema.safeParse({ provider: 'claude-code', model: '' }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bun test operator-model-schema.test.ts`
Expected: FAIL — the cc-accept case fails (`provider` enum currently excludes `claude-code`).

- [ ] **Step 3: Widen the schema enum**

Edit `packages/shared/src/operator-model-schema.ts`:

```ts
import { z } from 'zod';
import { AI_PROVIDERS } from './ai-providers.ts';

/**
 * The provider set the OPERATOR may run on: the four keyed providers PLUS the
 * keyless local `claude-code` backend (attended-only, env-gated at runtime —
 * see runner.ts ccGateBlocks). This is INTENTIONALLY wider than `AI_PROVIDERS`
 * (which stays the keyed set used for key-CRUD + key-resolution logic): cc
 * carries no secret and gets no `ai_keys` row, so it must never enter the keyed
 * paths — only this operator-selection contract.
 */
export const OPERATOR_MODEL_PROVIDERS = [...AI_PROVIDERS, 'claude-code'] as const;

export const operatorModelSettingSchema = z
  .object({
    provider: z.enum(OPERATOR_MODEL_PROVIDERS),
    model: z.string().min(1),
    aiKeyLabel: z.string().min(1).default('default'),
  })
  .strict();

export type OperatorModelSetting = z.infer<typeof operatorModelSettingSchema>;
```

- [ ] **Step 4: Run the shared test + typecheck to verify GREEN**

Run: `cd packages/shared && bun test operator-model-schema.test.ts`
Expected: PASS.
Run: `cd packages/shared && bun x tsc --noEmit`
Expected: clean (0 errors).

- [ ] **Step 5: Write the failing route test (referential exemption)**

Extend `apps/server/src/routes/instance-ai-keys.test.ts` (match the file's existing app/seed harness — use `makeTestApp()`/the existing request helper; the snippet below shows the assertions, adapt the request mechanics to the file's conventions):

```ts
test('PUT /operator-model accepts claude-code with NO ai_keys row (keyless)', async () => {
  const { app, seed } = await makeTestApp(); // existing harness
  const res = await app.request('/api/v1/instance/operator-model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...seed.adminAuthHeaders },
    body: JSON.stringify({ provider: 'claude-code', model: 'default', aiKeyLabel: 'default' }),
  });
  expect(res.status).toBe(200);
});

test('PUT /operator-model still 422s for a KEYED provider with no matching key row', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/instance/operator-model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...seed.adminAuthHeaders },
    body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6', aiKeyLabel: 'default' }),
  });
  expect(res.status).toBe(422);
});
```

- [ ] **Step 6: Run it to verify the cc case fails**

Run: `cd apps/server && bun test instance-ai-keys.test.ts`
Expected: the cc-keyless case FAILS with 422 (the referential check rejects cc because it has no `ai_keys` row).

- [ ] **Step 7: Exempt cc from the route's referential check**

In `apps/server/src/routes/instance-ai-keys.ts`, the PUT `/operator-model` handler (around lines 56-68) currently does:

```ts
.put(
  '/operator-model',
  zValidator('json', operatorModelSettingSchema),
  async (c) => {
    const v = c.req.valid('json');
    const existing = await db.query.aiKeys.findFirst({
      where: and(eq(aiKeys.provider, v.provider), eq(aiKeys.label, v.aiKeyLabel)),
    });
    if (!existing) {
      throw new HTTPError(
        'INVALID_BODY',
        `no AI key configured for ${v.provider}/${v.aiKeyLabel} — add it in Settings → AI first`,
        422,
      );
    }
    await setOperatorModelSetting(db, v);
    return jsonOk(c, { ok: true, operator_model: v });
  },
)
```

Change the referential check to skip cc (cc is keyless — no row exists or should). Replace the `const existing = ...; if (!existing) { ... }` block with:

```ts
    // claude-code is the KEYLESS local backend: it carries no secret and has no
    // `ai_keys` row (its provider is intentionally absent from the ai_keys enum).
    // The referential "key must exist" check applies only to the keyed providers;
    // for cc, selecting it merely records the operator-model setting. Runtime
    // enforcement (attended-only + FOLIO_CLAUDE_CODE_ENABLED) lives in the runner
    // (ccGateBlocks), not here. (Note: `as ProviderName` narrows the keyed enum;
    // cc is excluded from this branch so the cast is only reached for keyed values.)
    if (v.provider !== 'claude-code') {
      const existing = await db.query.aiKeys.findFirst({
        where: and(eq(aiKeys.provider, v.provider as ProviderName), eq(aiKeys.label, v.aiKeyLabel)),
      });
      if (!existing) {
        throw new HTTPError(
          'INVALID_BODY',
          `no AI key configured for ${v.provider}/${v.aiKeyLabel} — add it in Settings → AI first`,
          422,
        );
      }
    }
```

(If `ProviderName` is not already imported in this file, the `eq(aiKeys.provider, v.provider)` call may now need a cast because `v.provider` is the wider union — narrow it inside the non-cc branch as shown. Confirm the existing import; `aiKeys.provider`'s column type is the keyed enum.)

- [ ] **Step 8: Run the route test + typecheck to verify GREEN**

Run: `cd apps/server && bun test instance-ai-keys.test.ts`
Expected: both cases PASS (cc → 200, keyed-with-no-row → 422).
Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/operator-model-schema.ts packages/shared/src/operator-model-schema.test.ts \
        apps/server/src/routes/instance-ai-keys.ts apps/server/src/routes/instance-ai-keys.test.ts
git commit -m "feat: accept claude-code as a keyless operator-model provider"
```

**Unit test:** Tier A — operator-model schema validation boundary + the route's referential exemption. RED-first; asserts the accept path, the keyed-reject path (garbage provider), the min(1) preservation, and the route's keyless-vs-keyed referential split.

---

### Task 2: Allow attended-operator cc runs at the runner gate (trigger runs stay refused)

Replace the runner's blanket cc deny with an attended-operator + env-opt-in allow on the conversation path, keep the document/trigger path a hard deny, exempt cc from the keyless preflight block, and strip the `'default'` model sentinel. This touches a security gate + subprocess execution → **Tier A, RED-first, including the denial path** (the S-1 trigger-denial is the load-bearing test).

**Files:**
- Modify: `apps/server/src/lib/runner.ts`
  - `preflight()` step 0 (lines 866-889) — hard deny via the shared helper
  - `conversationPreflight()` (lines 1017-1048) — attended-allow + keyless exemption
  - the cc model read in `ccExecute` (line 1895) — `'default'`→undefined
  - new helper `ccGateBlocks(ctx)` (place near the preflight helpers)
- Test: `apps/server/src/lib/runner.test.ts` — UPDATE the existing cc cases + ADD the conversation-path cases

**Interfaces:**
- Consumes:
  - `RunContext` carries `unattended?: boolean` (`runner.ts:228`) and `conversationId?: string` (`runner.ts:245`). On the operator/cockpit path `loadConversationContext` sets `unattended: false` (`runner.ts:799`) and a real `conversationId` (`runner.ts:800`); document/trigger runs set neither (trigger runs set `unattended: fm.unattended === true` at `runner.ts:664`).
  - `env.FOLIO_CLAUDE_CODE_ENABLED: boolean` (`env.ts:68`).
  - `runErrorReasonSchema.enum.claude_code_disabled` (`agent-run-schema.ts:25`).
  - `failRun(ctx, reason, detail)` (existing; used by both preflights).
  - `ctx.runSink.post(body, 'comment')` (the conversation failure-surface; `conversationPreflight` already uses it).
  - `__ccSpawnOverride` via `__setCcSpawnForTest(fn)` (`runner.ts:152`) — the test seam that injects the spawn so no real `claude` process launches.
- Produces:
  - `ccGateBlocks(ctx: RunContext): { blocked: boolean; reason?: string }` — pure decision: returns `{blocked:false}` for a non-cc provider; for cc, `{blocked:true, reason}` unless `env.FOLIO_CLAUDE_CODE_ENABLED && ctx.conversationId != null && ctx.unattended !== true`. The `reason` distinguishes flag-off from not-attended.
  - After this task: an attended operator cc run with the flag on reaches `ccExecute`; a flag-off cc run, OR any document/trigger cc run (even flag-on), fails `claude_code_disabled`.

- [ ] **Step 1: Write the failing conversation-path tests (RED-first)**

Add a new `describe` block in `apps/server/src/lib/runner.test.ts`. These drive the **operator/conversation** path using the existing conversation harness (mirror the setup at `runner.test.ts:3116-3143`: `seedInstanceSkills`, `createConversation`, `createConversationRun`, set `activeRunId`, then `runAgent({runId})`). The operator provider is set to cc via `setOperatorModelSetting`.

```ts
describe('claude-code operator gate (conversation path)', () => {
  // Helper: stand up an operator conversation run whose operator-model is
  // claude-code, then run it. Returns the conversation id so the caller can
  // read the appended thread message.
  async function runOperatorCc(db: DB, seed: TestSeed): Promise<{ convId: string; runId: string }> {
    await seedInstanceSkills(db); // operator's `folio` skill (loadContext hard-fails MISSING_SKILL otherwise)
    await setOperatorModelSetting(db, {
      provider: 'claude-code',
      model: 'default',
      aiKeyLabel: 'default',
    });
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, { conversation: { id: conv.id, createdBy: seed.user.id }, runId });
    await db.update(conversations).set({ activeRunId: runId }).where(eq(conversations.id, conv.id));
    await runAgent({ runId });
    return { convId: conv.id, runId };
  }

  test('attended operator + flag ON → reaches ccExecute (the CLI is spawned)', async () => {
    const { db, seed } = await makeTestApp();
    let spawned = false;
    let capturedArgv: string[] = [];
    const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = true;
    __setCcSpawnForTest((args) => {
      spawned = true;
      capturedArgv = args.argv;
      return {
        stdoutText: async () => 'cc did the work',
        stderrText: async () => '',
        exited: Promise.resolve(0),
        kill: () => {},
      };
    });
    try {
      await runOperatorCc(db, seed);
    } finally {
      __setCcSpawnForTest(undefined);
      (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
    }
    expect(spawned).toBe(true);
    // 'default' sentinel → no --model flag (the local Claude Code picks its own).
    expect(capturedArgv).not.toContain('--model');
  });

  test('attended operator + flag OFF → claude_code_disabled, message names the FLAG', async () => {
    const { db, seed } = await makeTestApp();
    let spawned = false;
    const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = false;
    __setCcSpawnForTest(() => {
      spawned = true;
      return { stdoutText: async () => '', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    });
    let convId = '';
    try {
      ({ convId } = await runOperatorCc(db, seed));
    } finally {
      __setCcSpawnForTest(undefined);
      (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
    }
    expect(spawned).toBe(false);
    // The failure surfaces as a thread message on a conversation run (failRun's
    // agent_run transition is a no-op here). The message must name the flag.
    const msgs = await listConversationMessages(db, convId); // use the file's existing thread-read helper
    const failure = msgs.map((m) => m.body).join('\n');
    expect(failure).toMatch(/FOLIO_CLAUDE_CODE_ENABLED/);
  });

  test('attended operator + flag ON + NO ai_keys row for cc → NOT blocked by keyRowMissing (reaches ccExecute)', async () => {
    const { db, seed } = await makeTestApp();
    // Deliberately seed NO ai_keys row at all — cc is keyless.
    let spawned = false;
    const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = true;
    __setCcSpawnForTest(() => {
      spawned = true;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    });
    try {
      await runOperatorCc(db, seed);
    } finally {
      __setCcSpawnForTest(undefined);
      (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
    }
    expect(spawned).toBe(true); // keyRowMissing did NOT block cc
  });
});

describe('claude-code S-1 guard — an unattended/trigger run is ALWAYS refused (the load-bearing denial)', () => {
  test('document/trigger cc run, flag ON → claude_code_disabled, ccExecute never reached', async () => {
    // The document path: a trigger-fired (unattended, no conversationId) run.
    // This is the S-1 case — even with the flag ON it must be refused.
    const { db, run } = await scaffold({
      withAiKey: false,
      agentOverrides: { provider: 'claude-code' },
      runOverrides: { provider: 'claude-code', unattended: true },
    });
    let spawned = false;
    const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = true;
    __setCcSpawnForTest(() => {
      spawned = true;
      return { stdoutText: async () => 'ok', stderrText: async () => '', exited: Promise.resolve(0), kill: () => {} };
    });
    try {
      await runAgent({ runId: run.id });
    } finally {
      __setCcSpawnForTest(undefined);
      (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
    }
    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('claude_code_disabled');
    expect(spawned).toBe(false);
  });
});
```

(If `listConversationMessages` is not the exact helper name in the file, use whatever the existing cockpit tests use to read the thread — e.g. the `listComments`/conversation-message reader near `runner.test.ts:3200`. The assertion is: the failure text reaches the thread and contains `FOLIO_CLAUDE_CODE_ENABLED`.)

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd apps/server && bun test runner.test.ts`
Expected: the new "reaches ccExecute" + "keyRowMissing does not block" cases FAIL (cc is currently blocked on the conversation path by `conversationPreflight`'s `keyRowMissing`/`requiresKey` clauses, and there is no attended-allow). The S-1 document case may already pass (the existing `preflight` deny), and the flag-off message case will FAIL until the message is rewritten to name the flag.

- [ ] **Step 3: Add the shared gate decision helper**

In `apps/server/src/lib/runner.ts`, add near the preflight helpers (e.g. just above `preflight`):

```ts
/**
 * The SINGLE decision for whether a claude-code run is allowed. cc is the
 * keyless local subprocess backend; it is permitted ONLY on an ATTENDED operator
 * run (a human is in the cockpit — `conversationId` set, `unattended !== true`)
 * AND only when the install explicitly opts in via FOLIO_CLAUDE_CODE_ENABLED.
 *
 * Both halves are required:
 *  - The env flag keeps cc OFF on any hosted/shared/per-customer image (it never
 *    sets the flag) — threat model T2.
 *  - The attended check keeps an UNATTENDED trigger run from re-entering Folio
 *    over MCP without the C3 unattended floor — threat model T1 (gap S-1). A
 *    trigger run has no conversationId and `unattended === true`, so it is
 *    refused even with the flag on. S-1 stays unreachable by construction.
 *
 * Returns {blocked:false} for any non-cc provider (the caller proceeds normally),
 * and a flag-distinguishing reason when cc is blocked.
 */
function ccGateBlocks(ctx: RunContext): { blocked: boolean; reason?: string } {
  if (ctx.fm.provider !== 'claude-code') return { blocked: false };
  if (!env.FOLIO_CLAUDE_CODE_ENABLED) {
    return {
      blocked: true,
      reason:
        'The claude-code backend is OFF on this install. An instance admin must set FOLIO_CLAUDE_CODE_ENABLED=true (only on a local/personal install — never on a shared/hosted Folio).',
    };
  }
  const attended = ctx.conversationId != null && ctx.unattended !== true;
  if (!attended) {
    return {
      blocked: true,
      reason:
        'The claude-code backend is allowed only on an ATTENDED operator/cockpit run (a human in the cockpit). Unattended trigger runs cannot use claude-code.',
    };
  }
  return { blocked: false };
}
```

- [ ] **Step 4: Replace the `preflight` step-0 hard deny with the shared helper (document/trigger path stays a deny)**

In `preflight()`, replace the existing step-0 block (`runner.ts:870-889`) with:

```ts
  // 0 — claude-code backend gate (document/trigger path). A document or
  // trigger-fired run is NEVER attended (no conversationId), so ccGateBlocks
  // always blocks it here — keeping the unattended-floor bypass (S-1) unreachable
  // on this path. The ATTENDED operator path runs conversationPreflight instead,
  // where ccGateBlocks performs the same check and may ALLOW. Cheapest check —
  // runs before any DB work. (cc branch points: runAgent runner.ts:348,
  // runAgentResume runner.ts:460.)
  {
    const gate = ccGateBlocks(ctx);
    if (gate.blocked) {
      await failRun(ctx, runErrorReasonSchema.enum.claude_code_disabled, gate.reason);
      return true;
    }
  }
```

(Leave the step-1 key-presence comment as-is, but drop/soften the line claiming "claude-code … can no longer reach here": a flag-on attended cc run does not reach `preflight` at all — it goes through `conversationPreflight`. A document cc run is still blocked at step 0. No keyed-provider invariant changes on this path.)

- [ ] **Step 5: Add the attended-allow + keyless exemption to `conversationPreflight`**

In `conversationPreflight()` (`runner.ts:1017`), add the cc gate FIRST (before the key checks), and make the key checks cc-exempt. Replace the body with:

```ts
async function conversationPreflight(ctx: RunContext): Promise<boolean> {
  // 0 — claude-code gate (operator path). cc is allowed only attended + opt-in;
  // ccGateBlocks decides. When it blocks, surface the reason on the thread (a
  // human is watching — failRun's agent_run transition is a no-op on a
  // conversation run, so the thread message IS the failure report). The reason
  // distinguishes "flag off" from "not an attended run".
  {
    const gate = ccGateBlocks(ctx);
    if (gate.blocked) {
      if (ctx.runSink.isConversation) await ctx.runSink.post(gate.reason ?? 'claude-code is disabled.', 'comment');
      // Also record the failure reason on any agent_run row (no-op for the
      // pure-conversation slot, faithful for the lifecycle transition).
      await failRun(ctx, runErrorReasonSchema.enum.claude_code_disabled, gate.reason);
      return true;
    }
    // cc that PASSES the gate is keyless — skip the key-presence checks below.
    if (ctx.fm.provider === 'claude-code') return false;
  }

  if (ctx.keyDecryptFailed) {
    if (ctx.runSink.isConversation) {
      await ctx.runSink.post(
        'The stored AI key could not be decrypted (the server encryption key may have changed). Ask an instance admin to re-enter it in Settings → AI.',
        'comment',
      );
    }
    return true;
  }
  const requiresKey = ctx.fm.provider !== 'ollama';
  if (ctx.keyRowMissing || (requiresKey && !ctx.apiKey)) {
    if (ctx.runSink.isConversation) {
      await ctx.runSink.post(
        'No AI key is configured for this provider. Ask an instance admin to add one in Settings → AI, then try again.',
        'comment',
      );
    }
    return true;
  }
  return false;
}
```

(The early `if (ctx.fm.provider === 'claude-code') return false;` after the gate is the keyless exemption — cc that passed the gate never hits the `keyRowMissing`/`requiresKey` block. This is correction #2. Confirm `failRun` is safe to call on a conversation ctx — it is already used elsewhere on this path via `failRunLastResort`; here it records `claude_code_disabled` and the thread `post` is the user-visible surface.)

- [ ] **Step 6: Strip the `'default'` model sentinel at the cc model read**

In `ccExecute` (`runner.ts:1895`), change the `model` argument so the `'default'` sentinel (and empty) omit `--model`:

```ts
        model: (() => {
          const m = (ctx.fm.model ?? '').trim();
          // Empty OR the literal 'default' sentinel → omit --model (the local
          // Claude Code picks its own model). cc-executor only adds --model when
          // this is a non-empty string (cc-executor.ts:69).
          return m.length > 0 && m.toLowerCase() !== 'default' ? m : undefined;
        })(),
```

(While here, fix the stale header comment at `runner.ts:1823` — the MCP token IS minted at 1835; remove the "v1 passes no MCP token (mcpToken: '')" line. Non-load-bearing; do it in this edit.)

- [ ] **Step 7: UPDATE the existing document-path cc tests to the new contract**

The existing tests at `runner.test.ts` (≈559-651, 2180-2232, 2324-2457, 3000-3050) assert "cc is hard-disabled even when the flag is ON" on the **document** path. Under the new contract a document/trigger cc run is **still refused** (it's never attended), so those tests stay GREEN in outcome — but their comments/intent ("hard-disabled, flag does nothing") are now wrong. Update each test's comment to: "document/trigger cc runs are refused because they are never attended (ccGateBlocks); the flag alone does not enable a document run." Keep the assertions (`status==='failed'`, `error_reason==='claude_code_disabled'`, `spawned===false`). For the two that assert the flag-OFF case, leave as-is (still correct). Do NOT delete any — they are the document-path denial coverage.

- [ ] **Step 8: Run the full runner suite + typecheck to verify GREEN**

Run: `cd apps/server && bun test runner.test.ts`
Expected: all cc tests PASS — the 3 new conversation-path cases (reaches ccExecute, flag-off names the flag, keyRowMissing doesn't block), the S-1 trigger-denial, and the updated document-path denials.
Run: `cd apps/server && bun test` (full server suite — confirm no collateral break)
Expected: no new failures (mind the known `list-view-create` web flake is web-only; server suite is the gate here).
Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "feat: allow attended-operator claude-code runs (triggers stay refused)"
```

**Unit test:** Tier A (security gate + subprocess) — RED-first. The denial path is load-bearing: the unattended/trigger-with-flag-on → `claude_code_disabled` case (S-1 guard) is a dedicated test and MUST be RED before Step 5/6 land the allow. Also asserts the keyless exemption (no `ai_keys` row does not block) and the `'default'`→no-`--model` mapping.

---

### Task 3: Surface a keyless "Claude Code (local)" operator option in Settings → AI

Add an operator-model affordance for claude-code in the AI tab, since cc has no `ai_keys` row and the per-row "Use for operator" button cannot reach it. Presentational/glue React with no bespoke logic → **Tier B** (extend the existing component test; no new logic-unit test).

**Files:**
- Modify: `apps/web/src/components/settings/ai-tab.tsx`
- Test: `apps/web/src/components/settings/ai-tab.test.tsx` (extend)

**Interfaces:**
- Consumes:
  - `useOperatorModel()` → `{ data: OperatorModelSetting | null }` and `useSetOperatorModel()` → mutation taking `OperatorModelSetting` (`apps/web/src/lib/api/instance-ai-keys.ts`). After Task 1, `OperatorModelSetting.provider` includes `'claude-code'`.
  - The existing `onUseForOperator(p, model)` shape (`ai-tab.tsx:194`) — generalize it (or add a sibling `onUseClaudeCodeForOperator()`) to set `{provider:'claude-code', model:'default', aiKeyLabel:'default'}`.
- Produces:
  - A new "Claude Code (local)" section/row in the AI tab, ALWAYS rendered (the decision is show + fail-loud at run time). Marking it calls `setOperatorModel.mutateAsync({ provider: 'claude-code', model: 'default', aiKeyLabel: 'default' })`. When the operator is currently cc, the row shows an "operator" badge (mirroring the per-provider badge at `ai-tab.tsx:373`).

- [ ] **Step 1: Write the failing component test**

Extend `apps/web/src/components/settings/ai-tab.test.tsx` (match the file's existing render/mock harness — it mocks the instance-ai-keys hooks; adapt the spy mechanics to the file's conventions):

```ts
it('offers a Claude Code (local) operator option that sets the keyless operator model', async () => {
  const setOperatorModel = vi.fn().mockResolvedValue({ ok: true });
  // ... wire the file's existing hook-mock so useSetOperatorModel().mutateAsync === setOperatorModel,
  //     useOperatorModel().data === null, useInstanceAiKeys().data === [] (no keys at all).
  render(<AiTab />, { wrapper: /* the file's existing wrapper */ });
  const btn = await screen.findByRole('button', { name: /claude code/i });
  await userEvent.click(btn);
  expect(setOperatorModel).toHaveBeenCalledWith({
    provider: 'claude-code',
    model: 'default',
    aiKeyLabel: 'default',
  });
});

it('marks Claude Code as the operator when the operator-model is claude-code', async () => {
  // useOperatorModel().data === { provider: 'claude-code', model: 'default', aiKeyLabel: 'default' }
  render(<AiTab />, { wrapper: /* the file's existing wrapper */ });
  const section = await screen.findByText(/claude code/i);
  expect(section).toBeInTheDocument();
  // The operator badge appears somewhere in the cc section.
  expect(screen.getByText(/operator/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run ai-tab.test.tsx`
Expected: FAIL — no element matching `/claude code/i` is rendered.

- [ ] **Step 3: Render the keyless Claude Code operator option**

In `apps/web/src/components/settings/ai-tab.tsx`, add a dedicated section AFTER the "Configured keys" `<section>` (it is NOT a `PROVIDERS`/`KNOWN_MODELS` member — those are typed `AiProvider`, which excludes cc; cc is a synthesized keyless entry). Add a handler near `onUseForOperator` (≈line 194):

```tsx
  // Claude Code is the KEYLESS local backend — it has no ai_keys row, so it
  // can't be marked via the per-provider key rows above. Always offered (the
  // operator-model picker shows it regardless of FOLIO_CLAUDE_CODE_ENABLED;
  // the run fails loudly at preflight if the flag is off — that error is the
  // affordance that teaches the operator to set the flag). 'default' model →
  // the runner omits --model and the local Claude Code picks its own.
  async function onUseClaudeCodeForOperator() {
    try {
      await setOperatorModel.mutateAsync({
        provider: 'claude-code',
        model: 'default',
        aiKeyLabel: 'default',
      });
      toast.success('Operator now uses Claude Code (local subprocess)');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }
```

Then the section (place after the keys `</section>`, before the component's closing `</div>`):

```tsx
      <section>
        <h2 className="text-sm font-medium">Claude Code (local)</h2>
        <p className="mt-0.5 text-xs text-fg-2">
          Run the operator through this machine's own <code>claude</code> CLI (your Claude
          subscription, your seat). No API key needed. Requires the install to set{' '}
          <code>FOLIO_CLAUDE_CODE_ENABLED=true</code> — safe only on a local/personal install,
          never on a shared/hosted Folio. Attended (cockpit) runs only.
        </p>
        <div className="mt-2 flex items-center gap-2 rounded-md border border-border-light bg-content px-3 py-2 text-sm">
          <span className="font-medium">Claude Code</span>
          <span className="rounded-full bg-fg-3/15 px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
            no key needed
          </span>
          {operatorModel.data?.provider === 'claude-code' ? (
            <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              operator
            </span>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="secondary"
            disabled={setOperatorModel.isPending}
            onClick={onUseClaudeCodeForOperator}
          >
            {operatorModel.data?.provider === 'claude-code' ? 'In use' : 'Use for operator'}
          </Button>
        </div>
      </section>
```

(If `onUseClaudeCodeForOperator` triggers a `noExplicitAny`/unused-var Biome warning, fix it — but remember warnings are not commit blockers; `bun run lint` exits 0 on warnings. Only error-severity blocks.)

- [ ] **Step 4: Run the component test + typecheck to verify GREEN**

Run: `cd apps/web && npx vitest run ai-tab.test.tsx`
Expected: both new cases PASS.
Run: `cd apps/web && bun x tsc --noEmit`
Expected: clean (`OperatorModelSetting` now admits `'claude-code'` from Task 1, so `mutateAsync({provider:'claude-code', ...})` typechecks).

- [ ] **Step 5: Run the full web suite once (catch collateral)**

Run: `cd apps/web && npx vitest run`
Expected: green (the `list-view-create.test.tsx` flake may need one rerun in isolation — known flake, not a regression).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/ai-tab.tsx apps/web/src/components/settings/ai-tab.test.tsx
git commit -m "feat: offer Claude Code (local) as a keyless operator model in Settings"
```

**Unit test:** no bespoke logic test — Tier B, presentational React (renders a static option, calls an existing mutation with fixed args). Coverage is the extended component test asserting the option renders and dispatches the correct keyless `OperatorModelSetting`.

---

── REVIEW GATE ── (tier: FULL — the cluster re-enables a subprocess-execution backend behind a security gate on the AI-provider boundary; all three 1a trigger surfaces)

**Review tier: FULL.** At this gate run the full reviewer panel + `security-sentinel`, and **`/security-review` is mandatory** (an approved `## Threat model` exists in `docs/superpowers/specs/2026-06-18-local-claude-code-provider-design.md` — it is the convergence target). The reviewers verify against the named mitigations T1–T5, specifically:
- **T1 / S-1 (the load-bearing one):** confirm an unattended/trigger cc run is refused on BOTH paths even with the flag on — `ccGateBlocks` blocks when `unattended === true` or `conversationId == null`, and it is wired into `preflight` (document/trigger) AND `conversationPreflight` (operator). A finding here PROMOTES nothing — it is already FULL.
- **T2:** `FOLIO_CLAUDE_CODE_ENABLED` defaults off; the allow requires it true. No code path enables cc without it.
- **T3 residual:** untrusted context stays in the existing `ccExecute` BEGIN/END DATA envelope (unchanged); host power is the accepted, documented residual.
- **The two extra gates** (correction #2 keyless exemption, correction #3 route referential exemption) do not widen authority — cc never enters the keyed key-resolution paths, and `AI_PROVIDERS` is unchanged.
- Tier escalation is one-way: any finding on a 1a surface keeps the cluster FULL.

---

## Stage 3 — Shake-out (drives the acceptance matrix)

Run `/shakeout` on the branch before finishing. It drives the design spec's `## Acceptance flows` matrix:

- **Operator runs on claude-code (attended)** — through the REAL browser (Playwright spec if present, else `superpowers-chrome` `use_browser` against the dev server, logged in as Stefan since CDP must clear the login wall): set the operator model to "Claude Code (local)" in Settings → AI; open the cockpit; send a task; confirm `claude -p` runs and a transcript/result posts. Edge: empty task (identity-only) → cc gets the system prompt, no context envelope.
- **denied — flag off** — through the browser with `FOLIO_CLAUDE_CODE_ENABLED` unset: the run fails with a thread message naming `FOLIO_CLAUDE_CODE_ENABLED` (the show-and-fail-loud affordance).
- **mid-flow-fail** — `claude` binary missing / non-zero exit → run fails `provider_error` with the stderr tail (existing `cc-executor` behavior; un-mocked).
- **Trigger tries to fire a claude-code agent (unattended)** — through the **un-mocked runner** (this is the S-1 guard; no browser): an unattended trigger run with `provider:'claude-code'` and the flag ON fails `claude_code_disabled` at preflight. This must also be covered by the Task 2 unit test, but the acceptance pass exercises it end-to-end.
- **Set operator model to claude-code** — through the wire: PUT `/operator-model` with `{provider:'claude-code',...}` returns 200 with no `ai_keys` row; a keyed provider with no row still 422s.

Emit the pass/fail/not-reachable/unverified-no-browser manifest. `/shakeout` also auto-dispatches the `invariant-auditor` against `ARCHITECTURE-INVARIANTS.md` — confirm no path bypasses a convergence point (the cc gate is the single who-can-run-cc decision; the operator-model setting is the single operator-provider decision).

---

## Self-review (writing-plans checklist)

**Spec coverage:**
- Re-enable existing cc unchanged → Tasks 2/3 reuse `cc-executor`/`ccExecute`; no rebuild. ✓
- Attended-only + env opt-in; triggers refused → Task 2 `ccGateBlocks` (both halves) on both paths; S-1 guard test. ✓
- Transcript execution, no streaming → unchanged `ccExecute`; not touched. ✓
- Off-state UI: show + fail loud, message distinguishes flag-off vs not-attended → Task 3 always-render option; Task 2 two distinct `ccGateBlocks` reasons. ✓
- `default` sentinel → omit `--model`, no schema-min widening → Task 1 keeps `min(1)`; Task 2 maps `'default'`→undefined. ✓
- Threat model T1–T5 → review-gate convergence + S-1 unit test + keyless/route exemptions that don't widen authority. ✓
- Acceptance flows (3 flows + edges) → Stage 3 shake-out section. ✓
- Ground-truth corrections (gate-on-conversation-path, keyless site, route referential check, web red-herring, `'default'` strip, no migration) → all embedded in the Plan Corrections section + the tasks. ✓

**Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling". The only intentional adapt-points are test-harness mechanics (the exact mock-wiring / thread-read helper names in the existing test files) — flagged inline with the concrete assertion that must hold, not left vague. All implementation code blocks are concrete.

**Type consistency:** `OPERATOR_MODEL_PROVIDERS` / `operatorModelSettingSchema` / `OperatorModelSetting` (Task 1) → consumed by the runner, the route, and the web hook (which imports the type from `@folio/shared`). `ccGateBlocks(ctx): {blocked, reason?}` (Task 2) used identically in `preflight` and `conversationPreflight`. `onUseClaudeCodeForOperator` dispatches the exact `{provider:'claude-code', model:'default', aiKeyLabel:'default'}` the schema now admits and the runner's `'default'`-strip expects. Consistent throughout.

---

**Migration:** none. The operator-model selection is a JSON value in `instance_settings`; the gate is the env var `FOLIO_CLAUDE_CODE_ENABLED` (already parsed); cc needs no `ai_keys` row (`aiKeys.provider` is a TS-only enum with no SQL CHECK and is intentionally left excluding cc). No `.sql` file, no `_journal.json` edit.
