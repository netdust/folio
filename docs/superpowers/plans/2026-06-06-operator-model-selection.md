# Operator Model Selection + Keyless-Ollama Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (solo/sequential — the tasks share context and are interdependent). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let an instance admin choose which configured provider+model the operator runs on (replacing the hardcoded `claude-sonnet-4-6`/`anthropic` constants), set from the AI tab; and make a keyless Ollama key configurable without a placeholder apiKey.

**Architecture:** A single instance-level setting `operator_model = {provider, model, ai_key_label}` persisted in a new tiny key/value `instance_settings` table (no such table exists today — verified). A new admin-gated route writes it; `getOperatorDefinition()` reads it and falls back to the current anthropic default when unset. The AI tab gains a "Use for operator" control per key (provider+label already known; the admin types the model string, since a key carries no single model). Separately, the AI-key POST schema makes `apiKey` optional for `ollama`.

**Tech Stack:** Bun, Hono, Drizzle/SQLite, React + TanStack Query, Zod.

---

## File Structure

- `apps/server/src/db/schema.ts` — add `instanceSettings` table (key TEXT PK, value JSON, updated_at).
- `apps/server/src/db/migrations/0031_instance_settings.sql` + journal entry — create the table.
- `apps/server/src/services/instance-settings.ts` (NEW) — `getOperatorModelSetting(db)` / `setOperatorModelSetting(db, v)` typed key/value accessors.
- `apps/server/src/lib/operator.ts` — `getOperatorDefinition` becomes async, reads the setting ?? the anthropic default.
- `apps/server/src/routes/instance-ai-keys.ts` — (a) `apiKey` optional for ollama; (b) NEW `PUT /operator-model` (admin-gated) to set the operator model; surface it on GET.
- `apps/web/src/lib/api/instance-ai-keys.ts` — client hook for the operator-model setting + a `useSetOperatorModel` mutation.
- `apps/web/src/components/settings/ai-tab.tsx` — a "Use for operator" control per key + a model input; shows which key is the operator's.

---

## Threat model

> For the operator-model-selection setting + the keyless-Ollama apiKey change (written 2026-06-06, BEFORE task breakdown). The surface is security-relevant: an instance-admin-gated write decides WHICH provider/host the operator's autonomous runs hit (spend + outbound destination) and relaxes credential validation for one provider. This section is the `/code-review` convergence target.

### What we're defending

- **The operator's outbound destination + spend.** `operator_model.{provider, ai_key_label}` selects which configured `ai_keys` row (and thus which baseUrl / which paid API) every operator run uses. A bad value redirects operator runs (and their tool-call context) to an attacker-chosen provider/host or silently runs up a paid bill.
- **The `ai_keys` credential store** (`encrypted_key`, the `FOLIO_MASTER_KEY`-decrypted secret) — unchanged by this feature but adjacent (the apiKey-optional change touches its write path).
- **The instance-admin authorization boundary** — only owner/admin may configure AI + the operator model.
- **The SSRF guard on `ai_keys.baseUrl`** (existing `validatePublicUrl` + loopback gate) — must not be weakened by the keyless-Ollama change.

### Who we're defending against

- **External / unauthenticated** — IN scope (route is session-only + admin-gated; no bearer reaches it).
- **An authenticated NON-admin member** — IN scope: must NOT be able to set the operator model or add AI keys.
- **A phished/compromised admin** — partially in scope (we can't stop a real admin doing admin things, but the value is constrained so even an admin can't point the operator at an unconfigured/garbage provider that bypasses the SSRF guard).
- **A compromised agent / minted token** — IN scope by construction: the route mounts on `v1` (session-only), so no agent token reaches the operator-model or ai-keys write surface (same gate as the existing ai-keys route, M4 inheritance).
- **Insider with stolen admin creds** — OUT of scope (acknowledged; standard).

### Attacks to defend against

1. **Operator pointed at an unconfigured provider/label.** Admin (or a bug) sets `operator_model.ai_key_label`/`provider` to a `(provider,label)` with no `ai_keys` row → operator runs fail at resolution, OR worse, fall through to a default that ISN'T what's shown.
2. **Operator-model value bypasses the SSRF/baseUrl guard.** The operator model points at an ollama provider whose `baseUrl` was never validated (if the setting could carry its own baseUrl). The setting must NOT carry a baseUrl — it references an existing, already-validated `ai_keys` row by `(provider, ai_key_label)`.
3. **Non-admin sets the operator model.** A member POSTs the operator-model route and redirects every operator run (spend + destination) instance-wide.
4. **Agent token reaches the operator-model write.** A minted/agent token sets the operator model (privilege escalation: an agent choosing its own brain/host).
5. **Keyless-Ollama change weakens paid-key validation.** Making `apiKey` optional accidentally lets a PAID provider (anthropic/openai/openrouter) be saved with no key → confusing failure, or a downstream nil-key path.
6. **Untrusted model/provider string injected downstream.** The `model`/`provider` strings flow into the provider call; an unconstrained value could break the provider request or be a vector. (Low: it's an admin-supplied string into our own provider client, not an outbound URL — but `provider` must be a known enum.)
7. **operator_model JSON parse / corrupt-row crash.** A malformed `instance_settings.value` aborts `getOperatorDefinition` → every operator run (and anything reading the operator def) breaks.

### Mitigations required

1. **Validate the referenced key exists at set-time OR fall back loudly.** `setOperatorModelSetting` does NOT verify the key exists (a key can be added after); instead `getOperatorDefinition` resolves the setting and, if the named `(provider, ai_key_label)` has no `ai_keys` row, the EXISTING runner key-resolution already fails with the clear "No AI key configured" in-thread message (verified in shakeout). The setter validates `provider` is a known enum + `model`/`ai_key_label` are non-empty strings (Zod). No silent wrong-default: when the setting is UNSET, fall back to the documented anthropic default; when SET, use it verbatim.
2. **The setting references a key by (provider, ai_key_label) ONLY — never carries a baseUrl.** The baseUrl lives solely on the `ai_keys` row, which already went through `validatePublicUrl`. The operator-model setting Zod schema has NO baseUrl field. So no new SSRF path: the operator can only use a baseUrl that was already validated at key-creation.
3. **Admin-gate the write.** `PUT /instance/operator-model` calls `requireInstanceAdmin(db, getUser(c).id)` exactly like the ai-keys routes; the route is on the same session-only `instanceAiKeysRoute` (or a sibling) mounted on `v1`.
4. **Session-only mount (no bearer).** Inherits the existing ai-keys mount: `instanceAiKeysRoute.use('*', requireSessionUser)` + v1 mount means `attachToken` never runs → no agent/minted token reaches it (M4 inheritance). Add an explicit test that a bearer is rejected.
5. **apiKey optional ONLY for ollama; still required for paid providers.** Zod: `apiKey: z.string().min(1).optional()` + a `.refine` requiring `apiKey` present when `provider !== 'ollama'`. A paid provider with no key → 422 with a clear message. Ollama with no key → stored as empty string.
6. **provider is the existing closed enum.** The operator-model setter reuses `z.enum(['anthropic','openai','openrouter','ollama'])`; `model`/`ai_key_label` are `z.string().min(1)`. No free-form provider.
7. **Tolerant read of the setting.** `getOperatorModelSetting` parses `value` defensively (try/catch → returns null on malformed JSON or shape mismatch), so a corrupt row degrades to the default rather than crashing every operator run. Mirrors the `parseMessagePayload` tolerance pattern.

### Out of scope (explicit deferrals)

- **Per-key spend caps / denial-of-wallet metering** — already a documented residual (M8 in the cockpit/AI threat model); unchanged here. The paid-residual warning still fires on paid-key add.
- **Verifying the model string is a real model the provider serves** — not validated (provider rejects an unknown model at call time; surfaced as the existing provider_error). v1 acceptable.
- **Env-var override (`FOLIO_OPERATOR_PROVIDER/MODEL`)** — NOT added; the DB setting is the single source. (The earlier idea; superseded by this UI-driven setting.)
- **Per-workspace operator model** — out of scope; the operator is instance-level, the setting is instance-level.

### How to use this section

- Controller pre-flight (Step 2.5): verify each mitigation is in the task's code before dispatch.
- `/code-review`: "Verify against the threat model. Check mitigations 1–7; report in-place / missing / out-of-scope per the deferrals."
- `/evaluate`: list any missing mitigation as a plan-correction defect.

---

## Architecture invariants touched

- **Authorization convergence (inv 4a, `lib/access.ts` / `requireInstanceAdmin`):** the operator-model write goes through `requireInstanceAdmin` — the same instance-admin gate as ai-keys. No new auth path.
- **Entity modeling / operator identity (`lib/operator.ts` `getOperatorDefinition`):** remains THE single place the operator definition is resolved. This task makes it read the setting; it stays the one convergence point (no caller reads the setting directly to build an operator def).
- New `instance_settings` table is a generic key/value config store; document it as the home for instance-level settings.

---

## Task 1: instance_settings table + migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0031_instance_settings.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json` (add idx 32 entry)
- Test: `apps/server/src/db/migrations/0031_instance_settings.test.ts`

- [ ] **Step 1: Write the failing migration test** — build an in-memory DB, `migrate()`, assert `instance_settings` table exists with columns `key`, `value`, `updated_at`. (Pattern: `0026_instance_skills.test.ts`.)

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../schema.ts';

test('0031 creates instance_settings', () => {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '.') });
  const cols = sqlite.query("PRAGMA table_info(instance_settings)").all().map((r: any) => r.name);
  expect(cols).toContain('key');
  expect(cols).toContain('value');
  expect(cols).toContain('updated_at');
});
```

- [ ] **Step 2: Run → FAIL** — `cd apps/server && bun test src/db/migrations/0031_instance_settings.test.ts` (no migration yet).

- [ ] **Step 3a: Add the schema table** (schema.ts, near the other instance-level tables):

```ts
export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
```

- [ ] **Step 3b: Hand-author the migration** `0031_instance_settings.sql` (DO NOT run db:generate — snapshot lags; hand-author + journal, per the house rule):

```sql
CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
```

- [ ] **Step 3c: Add the journal entry** — append to `meta/_journal.json` entries: `{ "idx": 32, "version": "6", "when": <a ms timestamp > the last entry's>, "tag": "0031_instance_settings", "breakpoints": true }`. (Match the existing entries' shape exactly; confirm the last idx at 2.5.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(db): instance_settings key/value table (migration 0031)`

**Unit test:** the migration test above (table + columns exist).

---

## Task 2: instance-settings service (typed operator-model accessor)

**Files:**
- Create: `apps/server/src/services/instance-settings.ts`
- Test: `apps/server/src/services/instance-settings.test.ts`

- [ ] **Step 1: Write the failing test** — round-trip set→get; tolerant read of a malformed row → null (mitigation 7).

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../db/schema.ts';
import { instanceSettings } from '../db/schema.ts';
import { getOperatorModelSetting, setOperatorModelSetting } from './instance-settings.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

test('round-trips the operator model setting', async () => {
  const db = makeDb();
  expect(await getOperatorModelSetting(db)).toBeNull();
  await setOperatorModelSetting(db, { provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'default' });
  expect(await getOperatorModelSetting(db)).toEqual({ provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'default' });
});

test('a malformed value row degrades to null (tolerant read)', async () => {
  const db = makeDb();
  await db.insert(instanceSettings).values({ key: 'operator_model', value: '"not-an-object"' as unknown as object });
  expect(await getOperatorModelSetting(db)).toBeNull();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `instance-settings.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { instanceSettings } from '../db/schema.ts';

const OPERATOR_MODEL_KEY = 'operator_model';

export interface OperatorModelSetting {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  aiKeyLabel: string;
}

const PROVIDERS = new Set(['anthropic', 'openai', 'openrouter', 'ollama']);

/** Read the operator model setting, tolerant of a missing/corrupt row (→ null). */
export async function getOperatorModelSetting(db: DB): Promise<OperatorModelSetting | null> {
  const row = await db.query.instanceSettings.findFirst({
    where: eq(instanceSettings.key, OPERATOR_MODEL_KEY),
  });
  if (!row) return null;
  const v = row.value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.provider !== 'string' ||
    !PROVIDERS.has(v.provider) ||
    typeof v.model !== 'string' ||
    v.model.length === 0 ||
    typeof v.aiKeyLabel !== 'string' ||
    v.aiKeyLabel.length === 0
  ) {
    return null;
  }
  return { provider: v.provider as OperatorModelSetting['provider'], model: v.model, aiKeyLabel: v.aiKeyLabel };
}

export async function setOperatorModelSetting(db: DB, v: OperatorModelSetting): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: OPERATOR_MODEL_KEY, value: v, updatedAt: new Date() })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: v, updatedAt: new Date() } });
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(server): instance-settings service + operator-model accessor`

**Unit test:** round-trip + tolerant-read-of-corrupt (mitigation 7).

---

> **⚠️ PLAN-CORRECTION (2026-06-06, Step 2.5).** Ground-truth: `getOperatorDefinition()` AND `getOperatorDocument()` are sync + parameterless, and `getOperatorDocument` (→ resolver `resolveAgentForRun`, 7 call sites, anti-impersonation identity) calls the former. Making `getOperatorDefinition` async ripples through the whole resolver chain for a field only the RUN needs. BETTER: the operator run's `provider`/`model`/`ai_key_label` are consumed in ONE place — `loadConversationContext` (runner.ts:~575-590), which is ALREADY async. Read `getOperatorModelSetting(db)` THERE and override the synthetic run fm's provider/model/ai_key_label; leave `getOperatorDefinition`/`getOperatorDocument` sync (identity unchanged). One file, no resolver-chain churn. Task 3 below is rewritten to this.

## Task 3: loadConversationContext applies the configured operator model

**Files:**
- Modify: `apps/server/src/lib/operator.ts` (make `getOperatorDefinition` async; read the setting)
- Modify: every caller of `getOperatorDefinition` (await it) — enumerate at 2.5 via grep
- Test: `apps/server/src/lib/operator.test.ts`

- [ ] **Step 1: Write the failing test** — with no setting, the def uses the anthropic default; with a setting, it uses the setting's provider/model.

```ts
test('getOperatorDefinition falls back to the default when unset', async () => {
  const db = makeDb();
  const def = await getOperatorDefinition(db);
  expect(def.provider).toBe('anthropic');
  expect(def.model).toBe('claude-sonnet-4-6');
});

test('getOperatorDefinition uses the configured operator model when set', async () => {
  const db = makeDb();
  await setOperatorModelSetting(db, { provider: 'ollama', model: 'llama3.1:8b', aiKeyLabel: 'default' });
  const def = await getOperatorDefinition(db);
  expect(def.provider).toBe('ollama');
  expect(def.model).toBe('llama3.1:8b');
  expect(def.aiKeyLabel).toBe('default');
});
```

- [ ] **Step 2: Run → FAIL** (getOperatorDefinition is currently sync + ignores the setting; signature confirmed at 2.5).

- [ ] **Step 3: Implement** — `getOperatorDefinition(db)` becomes async, reads `getOperatorModelSetting(db)`, applies it over the defaults. Add `aiKeyLabel` to `OperatorDefinition` (default `'default'`). Keep `OPERATOR_MODEL`/`OPERATOR_PROVIDER` constants as the fallback. **Confirm at 2.5 whether the def carries an ai_key_label today and how createConversationRun/runner consume `def.model`/`def.provider`.**

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(operator): getOperatorDefinition reads the configured operator model`

**Unit test:** default-when-unset + uses-setting-when-set.
**Sibling-site audit:** every `getOperatorDefinition(` call site must now `await` (it became async). Grep + update each; build the seam at the run-create path (the operator def → the actual run's provider/model).

---

## Task 4: routes — apiKey optional for ollama + PUT operator-model

**Files:**
- Modify: `apps/server/src/routes/instance-ai-keys.ts`
- Test: `apps/server/src/routes/instance-ai-keys.test.ts`

- [ ] **Step 1: Write the failing tests** —
  - ollama key with NO apiKey → 201 (mitigation 5);
  - paid provider with NO apiKey → 422 (mitigation 5);
  - `PUT /operator-model` as admin → 200, persists; as a non-admin member → 403 (mitigation 3); via bearer → 401 (mitigation 4);
  - GET surfaces the current operator-model setting.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3a: apiKey optional for ollama** — change the POST schema:

```ts
.object({
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  apiKey: z.string().min(1).optional(),
  label: z.string().min(1).default('default'),
  baseUrl: z.string().url().optional(),
})
.strict()
.refine((b) => b.baseUrl === undefined || b.provider === 'ollama', { message: 'baseUrl is only allowed for the ollama provider', path: ['baseUrl'] })
.refine((b) => b.provider === 'ollama' || (b.apiKey !== undefined && b.apiKey.length > 0), { message: 'apiKey is required for this provider', path: ['apiKey'] })
```
In the handler: `const encryptedKey = encryptSecret(apiKey ?? '');` (ollama keyless → empty ciphertext). Keep the loopback-rejected error; APPEND the FOLIO_ALLOW_LOOPBACK_AI hint to that error message (the gap from project_provider-setup-gap).

- [ ] **Step 3b: PUT /operator-model** — admin-gated, on the same session-only router:

```ts
instanceAiKeysRoute.put(
  '/operator-model',
  zValidator('json', z.object({
    provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
    model: z.string().min(1),
    aiKeyLabel: z.string().min(1).default('default'),
  }).strict()),
  async (c) => {
    await requireInstanceAdmin(db, getUser(c).id);
    const v = c.req.valid('json');
    await setOperatorModelSetting(db, v);
    return jsonOk(c, { ok: true, operator_model: v });
  },
);
```
And add the current setting to the GET response: `operator_model: await getOperatorModelSetting(db)`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `feat(api): operator-model route + apiKey optional for ollama`

**Unit test:** the 6 cases above.
**Sibling-site audit:** confirm the route mounts on the session-only `instanceAiKeysRoute` (v1, no bearer) — not wScope.

---

─────────────────── ── REVIEW GATE ── ───────────────────
**END OF CLUSTER 1 (T1–T4) — the server feature.** HALT. Commit, run `/integration`, hand to human for `/code-review` (verify threat model M1–M7) AND `/security-review` (the admin-gate + apiKey-optional change touch the credential surface). Do NOT begin T5 until clear.
──────────────────────────────────────────────────────────

## Task 5: web — operator-model control in the AI tab

**Files:**
- Modify: `apps/web/src/lib/api/instance-ai-keys.ts` (add `operator_model` to the GET type + `useSetOperatorModel`)
- Modify: `apps/web/src/components/settings/ai-tab.tsx` (the control)
- Test: `apps/web/src/components/settings/ai-tab.test.tsx`

- [ ] **Step 1: Failing test** — the AI tab shows a "Use for operator" affordance per key; clicking it (with a model entered) calls `useSetOperatorModel` with `{provider, model, aiKeyLabel}`; the key currently marked as the operator's is indicated.

- [ ] **Step 2: vitest → FAIL.**

- [ ] **Step 3: Implement** — `useSetOperatorModel` mutation (PUT `/api/v1/instance/ai-keys/operator-model`, invalidate the ai-keys query); a per-key "Use for operator" button + a small model input (defaulting to a sensible per-provider placeholder); badge the key whose `(provider,label)` matches `operator_model`. Confirm the ai-tab structure + the existing client hook shape at 2.5.

- [ ] **Step 4: → PASS.**

- [ ] **Step 5: Commit** `feat(web): mark a provider+model as the operator's in the AI tab`

**Unit test:** renders the control; click sends `{provider, model, aiKeyLabel}`; marks the active one.

---

─────────────────── ── REVIEW GATE ── ───────────────────
**END OF CLUSTER 2 (T5) — the web control.** HALT. Commit, `npx vitest run`, `/code-review` (M8: id-not-label n/a here; verify the mutation sends the right shape + no secret handling on the client). Then Stage 3 phase-close.
──────────────────────────────────────────────────────────

## Task 6 (not a code task): re-migrate the dev DB

Local hygiene, NOT committed. Back up then bring `apps/server/folio.db` onto the current chain.

- [ ] `cp apps/server/folio.db apps/server/folio.db.bak-<stamp>`
- [ ] Run the migrator against it; if the stale chain can't fast-forward, reset (delete + re-migrate) — it's local dev data.
- [ ] Verify `ai_keys` has the current shape + `instance_settings` exists.

---

## Phase close (Stage 3)

1. `/integration` (server + web + shared, tsc ×3).
2. `netdust-core:test-effectiveness` over the diff (the operator-model setter/reader guards + the apiKey refine — name the test that bites each).
3. `/shakeout` (real-HTTP: set operator-model as admin → reject as member/bearer; add a keyless ollama key; confirm getOperatorDefinition reflects the setting).
4. `superpowers:finishing-a-development-branch`.

---

## Self-review (writing-plans checklist)

**Spec coverage:** operator-model selection → T1 (table) + T2 (service) + T3 (read it) + T4 (route) + T5 (UI); keyless ollama → T4; dev-DB → T6. Every ask mapped.
**Placeholders:** none — code shown for each step; the two "confirm at 2.5" notes (journal idx, getOperatorDefinition consumers, ai-tab shape) are ground-truth points, not placeholders.
**Type consistency:** `OperatorModelSetting {provider, model, aiKeyLabel}` used identically in T2/T3/T4/T5; `getOperatorModelSetting`/`setOperatorModelSetting` named consistently; `getOperatorDefinition(db)` async everywhere after T3.
