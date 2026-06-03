# Agent Authority Model + Skill Reach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admin agents (outside MCP + operator) full instance reach and worker agents project-scope, by making token reach a nullable field + capability-gated at creation; and make `__system` skills reachable by every agent via push + a narrow `get_skill` pull, with a trust flag separating skill authoring from blessing.

**Architecture:** Two pieces. **Piece A** — `api_tokens.workspace_id` becomes nullable (`null` = instance-wide); reach is chosen at creation (only an instance-admin human may mint `null`); a per-run `effective_reach = token_reach ∩ caller_reach` replaces the runner's line-410 workspace rebind; new scopes (`settings:write`, `members:write`, `workspace:admin`) make `folio_api` HIGH ops scope-gated with default-deny; the operator becomes a code-provisioned token (`workspaceId/agentId/createdBy` all null). **Piece B** — `loadAgentDefinition` always resolves skills from `__system`; a narrow read-only `get_skill` tool; a `trusted` skill-frontmatter flag with `set_skill_trust` gated on system origin (`createdBy IS NULL`).

**Tech Stack:** Bun, Hono, Drizzle (SQLite), Zod. Tests: `bun test` (run from `apps/server`). Source spec: `docs/superpowers/specs/2026-06-03-agent-authority-and-skill-disclosure-design.md`.

**Threat model:** See the full `## Threat model` section below (after File Structure) — 6 assets, 7 actor classes with IN/OUT markers, 14 attacks paired 1:1 with code-checkable mitigations, explicit deferrals. The T1–T8 invariants referenced in task bodies map into it: T1→mitigation 1, T2→3, T3→12 (operator combo invariant), T4→4 (load-bearing), T5→8, T6→7, T7→9, T8→12.

**Architecture invariants touched** (from `ARCHITECTURE-INVARIANTS.md`): authorization convergence (the reach + scope gates), data-access (resolvers), event emission (`skill.trust.changed`). The invariant-auditor verifies no resolver reads the raw `token.workspaceId` on a run path (T4) and every write path maps to a scope (T5).

---

## File Structure

**Piece A — authority:**
- `apps/server/src/db/migrations/0022_nullable_token_workspace.sql` (create) — make `api_tokens.workspace_id` nullable; update `meta/_journal.json`.
- `apps/server/src/db/schema.ts` (modify) — drop `.notNull()` on `apiTokens.workspaceId`.
- `apps/server/src/lib/token-reach.ts` (create) — `effectiveReach(tokenReach, callerReach)` pure helper + `isInstanceReach(token)`.
- `apps/server/src/lib/agent-schema.ts` (modify) — add the three admin scopes to the vocabulary + `roleToScopes`.
- `apps/server/src/lib/folio-api-tool.ts` (modify) — path→scope map + default-deny + secret-refuse predicate; drop admin-keyed risk carve-out.
- `apps/server/src/lib/agent-tools-registry.ts` (modify) — `resolveWorkspaceForToken` + `list_workspaces` reach branches.
- `apps/server/src/middleware/scope.ts` (modify) — reach + membership bypass for instance tokens.
- `apps/server/src/routes/tokens.ts` (modify) — accept `workspaceId`/null, creation capability gate, new-scope ceiling.
- `apps/server/src/routes/workspaces.ts` (modify) — allow instance bearer to create workspaces.
- `apps/server/src/lib/runner.ts` (modify) — replace line-410 rebind with effective-reach intersection.
- `apps/server/src/lib/system-workspace.ts` (modify) — provision operator token with `createdBy: null`.

**Piece B — skills:**
- `apps/server/src/lib/runner.ts` (modify) — `loadAgentDefinition` reads `__system`; thread `trusted` into push/data channel.
- `apps/server/src/lib/agent-tools-registry.ts` (modify) — `get_skill` tool.
- `apps/server/src/lib/skill-trust.ts` (create) — `canBlessSkill(token, sessionUser)` + `set_skill_trust` service.
- `apps/server/src/lib/system-skills.ts` (modify) — `folio` skill seeds `trusted: true` + `description`/`when_to_use`.

**UI (Piece A, after server):**
- `apps/web/src/components/settings/token-create-modal.tsx` (modify) — reach toggle + new scope checkboxes.

---

## Threat model

> For the agent-authority + skill-reach feature (2026-06-03). This feature WIDENS the multi-tenancy boundary — it lets a token reach across workspaces and lets agents reach the `__system` library. That is the highest-stakes surface in Folio, so this section is the convergence target: `/code-review` verifies against the numbered mitigations instead of re-discovering them. It INHERITS the Phase A/B/C baseline (system-library + cross-workspace execution + caller-delegation threat models) and extends it; do not re-litigate inherited mitigations, extend them. Written at plan time (retrospectively, after task breakdown — the section header in the spec was a placeholder; this is the real one).

### What we're defending

1. **The instance-reach token** — an `api_tokens` row with `workspace_id IS NULL` + full scopes. A single such token is near-total instance authority (all workspaces, create/read/write). Its `token_hash` (sha256) is the bearer; leaking the plaintext = instance takeover (minus secrets).
2. **The operator token specifically** — the code-provisioned instance token with `created_by IS NULL` (system origin). Its null `created_by` is BOTH its bless capability (T8) and a value no API call can produce — so it is an unforgeable privilege marker that must never be settable through any route.
3. **Workspace isolation** — the integrity property that a workspace's documents/config are reachable only by tokens authorized for that workspace. The whole feature relaxes this *for admin tokens by design*; the defense is that the relaxation is exactly bounded (reach field + creation gate + per-run floor), never broader.
4. **The `__system` skill TRUSTED channel** — a skill page with `trusted: true` is loaded as system-prompt instructions into every run that declares/pulls it. This is persistent, cross-agent, trusted instruction — the same class as a credential. Its integrity (who can make a skill trusted) is an asset.
5. **BYOK secrets** (`ai_keys.encrypted_key`) + **standing credentials** (`api_tokens`) — inherited from Phase 3. The feature must NOT open their creation to any agent (the one hard carve-out).
6. **The per-run authority floor** — the property that a run is bounded to `min(token, caller)`. The feature replaces the mechanism enforcing it (line-410 → effectiveReach); the asset is that the floor still holds.

### Who we're defending against

- **External attacker, no account** — IN scope. (Can't mint tokens; can only attack via a leaked token or an injection path.)
- **Authenticated member without instance-admin** — IN scope. Must NOT be able to mint a reach=null token or grant themselves admin scopes.
- **A prompt-injected MCP admin agent** — IN scope. Holds instance reach + write scopes; the danger is it plants a trusted skill or escalates. The most externally-reachable steerable actor.
- **A prompt-injected operator** — IN scope but NARROWER. Internal, not directly externally-reachable; can author AND bless skills (accepted residual, see deferrals).
- **A worker agent (pinned token) trying to cross its workspace or the `__system` boundary** — IN scope.
- **An insider with a stolen instance/operator token** — OUT of scope (a leaked near-omnipotent credential is game-over by design; the secret carve-out limits blast radius by preventing NEW credential minting, but we do not defend against the leak itself).
- **DNS-rebinding / TOCTOU on workspace existence** — OUT of scope (reach checks resolve by id at call time; no remote URL fetch is added by THIS feature).

### Attacks to defend against

1. **Privilege escalation at mint — a member mints a reach=null token.** A non-admin sets `workspaceId: null` on `POST /tokens` and gains instance authority.
2. **Scope escalation at mint — a member mints `workspace:admin`/`settings:write`/`members:write`.** A low-priv human grants their own token admin scopes it then uses directly.
3. **Reach mutation after mint.** Any edit path that flips a pinned token's `workspace_id` to `null` (or to a different workspace) bypasses the creation gate entirely.
4. **Per-run privilege borrow (T4 — the load-bearing one).** A member triggers the operator (reach=null); if the resolver reads the raw token field (null = any workspace) instead of the narrowed effective reach, the run acts in a THIRD workspace the member can't reach. Deleting line-410 without the intersection causes exactly this.
5. **Run-target rubber-stamp.** If a run can DECLARE a target workspace outside the caller's authority, `token ∩ target` rubber-stamps it (the intersection is only safe if `caller_reach` is the caller's clamped authority, not a free declaration).
6. **Worker reaches another workspace.** A pinned worker token names a different `workspace_slug` and the resolver fails to reject it.
7. **Secret minting by an agent.** An admin agent uses `folio_api` to `POST /tokens` or `/ai-keys` — minting a credential (persistence / exfil).
8. **Default-allow on an unmapped write.** A future `folio_api` write route with no path→scope entry slips through as low-risk and applies without a scope check.
9. **`get_skill` as a general cross-workspace read primitive.** An agent uses `get_skill` to read a non-skill `__system` doc (an agent's prompt, settings) or a doc in another workspace, bypassing its reach.
10. **Stored trusted-channel injection (skill supply-chain).** A prompt-injected MCP agent writes a poisoned `__system` skill and marks it `trusted`; it then executes as system instructions in every worker that loads it.
11. **Self-bless via a normal write.** An agent sets `trusted: true` as a side-effect of a normal `create_document`/`update_document`/`folio_api` write to a skill page (no separate, gated action required).
12. **Operator-marker forgery.** A human-minted token obtains `created_by: null` (the bless/system marker) through some route — gaining operator-equivalent trust.
13. **Instance token leaks via per-workspace read surfaces (or the inverse — vanishes from management).** A null-`workspace_id` token either leaks into a per-workspace listing it shouldn't, or (the real risk) silently drops out of EVERY management/audit surface so it can never be revoked.
14. **Workspace-create by a non-admin bearer.** A pinned/member bearer reaches `POST /workspaces` after the gate is loosened for instance bearers.

### Mitigations required (numbered to match attacks)

1. **Creation capability gate (Task A7).** `POST /tokens` permits `workspaceId: null` ONLY when the caller holds `owner`/`admin` membership in `__system`. Else 403. Single evaluation point; checkable in `tokens.ts`.
2. **Scope ceiling extended (A5 + A7).** `roleToScopes` grants admin scopes ONLY to owner/admin; `POST /tokens` rejects any scope outside `roleToScopes(callerRole)`. `toolsToScopes` (worker path) NEVER yields admin scopes. Test: member minting `workspace:admin` → 403.
3. **Reach immutability (A7).** No route updates `api_tokens.workspace_id` (tokens are mint+revoke only). A test asserts no PATCH path alters reach. `grep` for `update(apiTokens)` touching `workspace_id` must return nothing.
4. **Per-run effective-reach written into the narrowed token (A8).** `effectiveReach(token.workspaceId, run.workspaceId)` is computed once and stored as `narrowedToken.workspaceId`; every resolver reads the NARROWED token, never the raw field. The invariant-auditor verifies no resolver reads raw `token.workspaceId` on a run path. Integration scenario (Phase Gate A #1) is the regression test.
5. **`caller_reach` is the caller-clamped target (A8 precondition).** Run-creation routes through the same reach/scope gate (`scope.ts` + `requireScope`), so a caller cannot create a run targeting a workspace it can't reach. Test: a member cannot create-and-target a run in a non-member workspace.
6. **`resolveWorkspaceForToken` rejects non-matching pinned reach (A3).** `isInstanceReach(token) || ws.id === token.workspaceId`, else throw. Pinned worker → its workspace only.
7. **Secret carve-out (A6).** `isSecretWrite(method, path)` → `/tokens` + `/ai-keys` writes return refused for EVERY token, no scope grants them. Checkable in `folio-api-tool.ts`.
8. **Default-deny on unmapped (A6).** `pathToScope` returns `'UNMAPPED'` for any unrecognized write; the handler refuses on `'UNMAPPED'`. No "else apply". Test: invented path → refused.
9. **`get_skill` narrow exemption (B2).** Hard-wired to `(workspace=__system, project=skills, type=page)`; does NOT call `resolveWorkspaceForToken`, cannot name another workspace or a non-skill doc. Tests: a `__system` agent doc / a B-only doc → not found.
10. **Author/bless separation + unblessed-as-data (B1+B3).** A written skill lands `trusted:false`; loaded as untrusted DATA (the BEGIN/END envelope), inert as instructions. Blessing is a separate `set_skill_trust` call (mitigation 11), denied to MCP (mitigation 12). So a planted skill cannot self-execute.
11. **`trusted` is server-managed on writes (B3).** `create_document`/`update_document`/`folio_api` STRIP `trusted` from incoming frontmatter for skill pages (reserved-key handling). Only `set_skill_trust` flips it. Test: a normal update cannot set `trusted:true`.
12. **Bless gated on system origin (B3).** `canBlessSkill` = `(session) OR (token.createdBy === null)`. `POST /tokens` ALWAYS stamps `createdBy: <human>` (tokens.ts:82), so no API-minted token can be null-`createdBy`. The operator is the ONLY null-`createdBy` token, code-provisioned (A9). Test: MCP PAT (createdBy human) → set_skill_trust refused; a human-minted token can never be null-createdBy.
13. **Read-site audit + instance-token listing (A12).** Every per-workspace `api_tokens`/`events` query is audited for null-`workspace_id` behavior; a dedicated instance-token listing surface (gated to `__system` admins) ensures instance tokens are revocable. Test: instance token absent from per-workspace list, present in instance list.
14. **Workspace-create gate (A10).** `POST /workspaces` allows a bearer ONLY when `token.workspaceId === null AND token.scopes.includes('workspace:admin')`; else session user. Test: pinned/member bearer → 403.

### Out of scope (explicit deferrals)

- **A leaked instance/operator token.** A near-omnipotent credential, once stolen, is game-over by design. We bound the blast radius (no NEW secret minting — mitigation 7) but do not defend against the leak itself. Mitigated operationally (token rotation, the instance-token listing for revocation).
- **Operator self-bless.** The operator can author AND bless a skill, so an injection that specifically steers the operator could self-bless (mitigation 10/12 stop the EXTERNAL MCP path, not the internal operator). Accepted residual; narrower (internal); audited via `skill.trust.changed`. Future tightening to human-only blessing is a localized `set_skill_trust` change.
- **Progressive disclosure / context-cost of whole-body skill push.** A scaling concern, not a security one; deferred.
- **DNS-rebinding / remote-fetch SSRF.** This feature adds NO outbound-URL fetch; the Phase 3 baseUrl SSRF mitigations are unchanged and inherited.
- **Cross-workspace cache-key collisions.** Inherited concern; this feature does not add new caches keyed on workspace.

### How to use this section

- **Controller pre-flight (before dispatching tasks):** verify each mitigation 1–14 has a home in the plan's task code; a mitigation with no task is a plan gap.
- **`/code-review` on the implementing diff:** "Verify the code against the threat model. Each numbered mitigation (1–14) should be checked: in place / missing / out-of-scope per the deferrals. Flag any bypass of a named convergence point." Expect ONE convergence round, not three.
- **`/evaluate` retro:** list any mitigation that shipped unimplemented as a plan-correction defect; if a NEW critical-class attack emerges that's not numbered here, the threat model was too shallow — extend it.
- **Downstream / future work:** cross-reference, don't re-litigate. The instance-reach token + the trusted-skill channel are the two surfaces most likely to grow — extend mitigations 1–4 and 10–12 if they do.

---

# Piece A — Authority (reach + scopes + operator)

> Ship Piece A as one mergeable increment. All tasks run from `apps/server` for tests (`cd apps/server && bun test <path>`). Typecheck: `bun x tsc --noEmit` from `apps/server`.

### Task A1: Make `api_tokens.workspace_id` nullable (migration + schema)

**Files:**
- Create: `apps/server/src/db/migrations/0022_nullable_token_workspace.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/db/schema.ts` (the `apiTokens.workspaceId` column)
- Test: `apps/server/src/db/migrations.test.ts` (existing migration test file — add a case)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/db/migrations.test.ts` (a test that an instance token with NULL workspace_id can be inserted):

```ts
test('0022: api_tokens.workspace_id accepts NULL (instance token)', () => {
  const sqlite = new Database(':memory:');
  applyAllMigrations(sqlite); // existing helper that runs migrator
  // Insert a token with NULL workspace_id — must NOT throw.
  sqlite.exec(`INSERT INTO api_tokens (id, workspace_id, name, token_hash, scopes, created_by)
               VALUES ('t-inst', NULL, 'instance', 'hash-x', '[]', NULL)`);
  const row = sqlite.query("SELECT workspace_id FROM api_tokens WHERE id='t-inst'").get() as { workspace_id: string | null };
  expect(row.workspace_id).toBeNull();
});
```

(If `applyAllMigrations` is named differently in the file, match the existing helper — read the top of `migrations.test.ts` first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/db/migrations.test.ts -t "accepts NULL"`
Expected: FAIL — `NOT NULL constraint failed: api_tokens.workspace_id`.

- [ ] **Step 3: Write the migration**

Drizzle/SQLite makes a column nullable via table-rebuild. Create `apps/server/src/db/migrations/0022_nullable_token_workspace.sql`. Mirror the rebuild shape of `0006_phase_2_5_workspace_agents.sql` (read it for the exact PRAGMA + `__new_api_tokens` pattern), changing ONLY `workspace_id` from `NOT NULL` to nullable:

```sql
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`agent_id` text,
	`project_ids` text,
	`created_by` text,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_api_tokens`("id", "workspace_id", "name", "token_hash", "scopes", "agent_id", "project_ids", "created_by", "last_used_at", "created_at") SELECT "id", "workspace_id", "name", "token_hash", "scopes", "agent_id", "project_ids", "created_by", "last_used_at", "created_at" FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);
```

(Confirm FK/column lines against your real `0006` rebuild — copy that file's exact FK clauses for the other columns so nothing else changes.)

- [ ] **Step 4: Register the migration in the journal**

Append the 0022 entry to `apps/server/src/db/migrations/meta/_journal.json` (drizzle's `migrate()` SKIPS files not in the journal — see `[[drizzle-migration-journal]]`). Match the existing entry shape; bump `idx`, set `"tag": "0022_nullable_token_workspace"`, and use a fixed timestamp (do not call Date.now). Read the last journal entry and increment.

- [ ] **Step 5: Drop `.notNull()` in the schema**

In `apps/server/src/db/schema.ts`, the `apiTokens` table, change:

```ts
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
```
to:
```ts
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
```

- [ ] **Step 6: Run test + typecheck**

Run: `cd apps/server && bun test src/db/migrations.test.ts -t "accepts NULL"`
Expected: PASS.
Run: `cd apps/server && bun x tsc --noEmit`
Expected: type errors WHERE code assumed `workspaceId` non-null (e.g. resolvers). These are EXPECTED — they are fixed in A3-A6. Note them; do not fix yet.

- [ ] **Step 7: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/db/migrations/0022_nullable_token_workspace.sql apps/server/src/db/migrations/meta/_journal.json apps/server/src/db/schema.ts apps/server/src/db/migrations.test.ts
git commit -m "phase-auth A1: api_tokens.workspace_id nullable (instance reach)"
```

### Task A2: The reach helper (`token-reach.ts`)

**Files:**
- Create: `apps/server/src/lib/token-reach.ts`
- Test: `apps/server/src/lib/token-reach.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/token-reach.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { effectiveReach, isInstanceReach } from './token-reach.ts';

describe('isInstanceReach', () => {
  test('null workspaceId is instance reach', () => {
    expect(isInstanceReach({ workspaceId: null } as any)).toBe(true);
  });
  test('concrete workspaceId is pinned', () => {
    expect(isInstanceReach({ workspaceId: 'w1' } as any)).toBe(false);
  });
});

describe('effectiveReach (tokenReach ∩ callerReach)', () => {
  test('instance ∩ B = B (member triggers operator)', () => {
    expect(effectiveReach(null, 'B')).toEqual({ ok: true, workspaceId: 'B' });
  });
  test('instance ∩ instance = instance (admin trigger)', () => {
    expect(effectiveReach(null, null)).toEqual({ ok: true, workspaceId: null });
  });
  test('pinned B ∩ B = B', () => {
    expect(effectiveReach('B', 'B')).toEqual({ ok: true, workspaceId: 'B' });
  });
  test('pinned B ∩ C = DENY', () => {
    expect(effectiveReach('B', 'C')).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/token-reach.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `apps/server/src/lib/token-reach.ts`:

```ts
import type { ApiToken } from '../db/schema.ts';

/** A token with null workspaceId reaches every workspace (instance-wide). */
export function isInstanceReach(token: Pick<ApiToken, 'workspaceId'>): boolean {
  return token.workspaceId === null;
}

export type EffectiveReach = { ok: true; workspaceId: string | null } | { ok: false };

/**
 * The per-run workspace floor: tokenReach ∩ callerReach.
 *  - null  = instance (any workspace)
 *  - id    = pinned to that workspace
 * Intersection rules:
 *  - null ∩ X      = X     (instance token narrowed to the caller's reach)
 *  - id  ∩ null    = id    (a pinned token's caller is unbounded → keep the pin)
 *  - id  ∩ same id = id
 *  - id  ∩ other   = DENY  (a pinned token cannot reach outside its pin)
 */
export function effectiveReach(
  tokenReach: string | null,
  callerReach: string | null,
): EffectiveReach {
  if (tokenReach === null) return { ok: true, workspaceId: callerReach };
  if (callerReach === null || callerReach === tokenReach) {
    return { ok: true, workspaceId: tokenReach };
  }
  return { ok: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/token-reach.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/token-reach.ts apps/server/src/lib/token-reach.test.ts
git commit -m "phase-auth A2: token-reach helper (isInstanceReach + effectiveReach intersection)"
```

### Task A3: Reach branches in the tool resolvers

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (`resolveWorkspaceForToken` ~line 147; `list_workspaces` handler ~line 350)
- Test: `apps/server/src/lib/agent-tools.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/agent-tools.test.ts` (use the existing seed helpers in that file — read the top for `seed`/workspace-creation patterns; adapt names):

```ts
test('instance token (workspaceId null) resolves any workspace via get_document path', async () => {
  // Seed two workspaces A and B; mint an INSTANCE token (workspaceId: null, full scopes).
  // executeTool('list_documents', { workspace_slug: <B.slug>, ... }) must NOT throw 'workspace not accessible'.
  // (Reuse the file's executeTool harness; assert no throw + rows returned.)
});

test('list_workspaces returns ALL workspaces for an instance token', async () => {
  // With workspaces A and B seeded and an instance token,
  // executeTool('list_workspaces', {}) returns both A and B.
});

test('list_workspaces returns only its own for a pinned token', async () => {
  // A pinned-to-A token → list_workspaces returns [A] only.
});
```

(Match the file's existing harness: how it builds an `ApiToken`, how it calls `executeTool`. Set `workspaceId: null` on the token object for the instance cases.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts -t "instance token"`
Expected: FAIL — `workspace not accessible` (resolver still requires id match); `list_workspaces` returns only one.

- [ ] **Step 3: Implement the reach branches**

In `apps/server/src/lib/agent-tools-registry.ts`, add the import at the top (near other lib imports):

```ts
import { isInstanceReach } from './token-reach.ts';
```

Change `resolveWorkspaceForToken` (was: `if (!ws || ws.id !== token.workspaceId)`):

```ts
async function resolveWorkspaceForToken(
  token: ApiToken,
  args: Record<string, unknown>,
): Promise<Workspace> {
  const slug = requireString(args, 'workspace_slug');
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, slug),
  });
  if (!ws) throw new Error('workspace not accessible');
  // Instance-reach token (workspaceId null) reaches any existing workspace.
  // A pinned token must match its own workspace. NOTE: during an agent RUN the
  // token passed here is the NARROWED run token (effective reach), so this also
  // enforces the per-run floor — see runner.ts effectiveReach (Task A8).
  if (!isInstanceReach(token) && ws.id !== token.workspaceId) {
    throw new Error('workspace not accessible');
  }
  return ws;
}
```

Change the `list_workspaces` handler:

```ts
    handler: async (_args, ctx) => {
      const all = isInstanceReach(ctx.token)
        ? await db.query.workspaces.findMany()
        : await db.query.workspaces
            .findFirst({ where: eq(workspaces.id, ctx.token.workspaceId!) })
            .then((ws) => (ws ? [ws] : []));
      return textResult({
        workspaces: all.map((ws) => ({ id: ws.id, slug: ws.slug, name: ws.name })),
      });
    },
```

(The `ctx.token.workspaceId!` non-null assertion is sound in the else branch — `isInstanceReach` is false there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts -t "instance token"` and `-t "list_workspaces"`
Expected: PASS.

- [ ] **Step 5: Regression — pinned tokens unchanged**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts`
Expected: all existing pinned/worker tests still PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/agent-tools-registry.ts apps/server/src/lib/agent-tools.test.ts
git commit -m "phase-auth A3: instance-reach branches in resolveWorkspaceForToken + list_workspaces"
```

### Task A4: Reach + membership bypass in the REST scope middleware

**Files:**
- Modify: `apps/server/src/middleware/scope.ts` (`resolveWorkspace`, lines 33 + 39-42)
- Test: `apps/server/src/middleware/scope.test.ts` (create if absent; else add cases) — or an integration test in `apps/server/src/routes/*.test.ts` that drives a folio_api/REST call with an instance token.

- [ ] **Step 1: Write the failing test**

Add a route-level test (instance token can hit a workspace it isn't a member of). Use the existing route test harness (e.g. the pattern in `src/routes/workspaces.test.ts`):

```ts
test('instance token (workspaceId null) passes resolveWorkspace for a non-member workspace', async () => {
  // Seed workspace B with NO membership for the token's creator.
  // Mint an instance token (workspaceId null, documents:read).
  // GET /api/v1/w/<B.slug>/documents with that bearer → 200 (not 403).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test <that test file> -t "instance token"`
Expected: FAIL — 403 ('token does not belong to this workspace' or 'not a member').

- [ ] **Step 3: Implement the bypass**

In `apps/server/src/middleware/scope.ts`, add import:

```ts
import { isInstanceReach } from '../lib/token-reach.ts';
```

Replace the token-pin check (lines ~30-35) and the membership requirement (lines ~39-42):

```ts
  // Instance-reach token (workspaceId null) may target any workspace; a pinned
  // token must match. (Run paths pass the NARROWED token, so this enforces the
  // per-run floor too — runner.ts Task A8.)
  if (token && !isInstanceReach(token) && token.workspaceId !== ws.id) {
    throw new HTTPError('FORBIDDEN', 'token does not belong to this workspace', 403);
  }

  if (!user) throw new HTTPError('UNAUTHENTICATED', 'login required', 401);

  // Membership is NOT required for an instance-reach token — it acts instance-
  // wide by capability, not by per-workspace membership. Pinned tokens + session
  // users still require membership.
  if (!(token && isInstanceReach(token))) {
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, user.id)),
    });
    if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);
    c.set('role', m.role as Role);
  } else {
    // Instance token: role is owner-equivalent for downstream getRole() consumers.
    c.set('role', 'owner');
  }

  c.set('workspace', ws);
  return next();
```

(Remove the old standalone `c.set('role', ...)` / `c.set('workspace', ...)` lines this replaces — read the current tail of `resolveWorkspace` and fold them in so `role` + `workspace` are set on both branches exactly once.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test <that test file> -t "instance token"`
Expected: PASS.

- [ ] **Step 5: Regression**

Run: `cd apps/server && bun test src/routes/ src/middleware/`
Expected: existing membership/pin tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/middleware/scope.ts <test file>
git commit -m "phase-auth A4: instance-reach bypass in resolveWorkspace (reach + membership)"
```

### Task A5: New admin scopes in the vocabulary

**Files:**
- Modify: `apps/server/src/lib/agent-schema.ts` (the scope list + `roleToScopes`)
- Test: `apps/server/src/lib/agent-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/agent-schema.test.ts`:

```ts
test('roleToScopes(owner) includes the admin scopes', () => {
  const s = roleToScopes('owner');
  expect(s).toContain('settings:write');
  expect(s).toContain('members:write');
  expect(s).toContain('workspace:admin');
});
test('roleToScopes(member) excludes admin scopes', () => {
  const s = roleToScopes('member');
  expect(s).not.toContain('settings:write');
  expect(s).not.toContain('workspace:admin');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts -t "admin scopes"`
Expected: FAIL — admin scopes absent from `roleToScopes`.

- [ ] **Step 3: Implement**

In `apps/server/src/lib/agent-schema.ts`: read the current `roleToScopes` (around line 95) and the canonical scope list. Add the three scopes to the owner/admin branch. Current:

```ts
export function roleToScopes(role: 'owner' | 'admin' | 'member'): string[] {
  if (role === 'owner' || role === 'admin') return [...ALL_DOCUMENT_SCOPES];
  // member branch...
}
```

Define an `ADMIN_SCOPES` constant near `ALL_DOCUMENT_SCOPES` and include it for owner/admin ONLY:

```ts
export const ADMIN_SCOPES = ['settings:write', 'members:write', 'workspace:admin'] as const;

export function roleToScopes(role: 'owner' | 'admin' | 'member'): string[] {
  if (role === 'owner' || role === 'admin') return [...ALL_DOCUMENT_SCOPES, ...ADMIN_SCOPES];
  return [/* existing member scopes — unchanged */];
}
```

(Do NOT add admin scopes to `toolsToScopes` — worker agents derive scopes from tools and must never receive admin scopes. Per spec "Worker agents — document scopes only".)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/lib/agent-schema.test.ts -t "admin scopes"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/agent-schema.ts apps/server/src/lib/agent-schema.test.ts
git commit -m "phase-auth A5: settings:write/members:write/workspace:admin scopes (owner/admin only)"
```

### Task A6: folio_api path→scope map + default-deny + secret-refuse

**Files:**
- Modify: `apps/server/src/lib/folio-api-tool.ts` (`classifyRisk` → replace with `pathToScope` + `isSecretWrite`; the handler)
- Test: `apps/server/src/lib/folio-api-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/lib/folio-api-tool.test.ts`:

```ts
import { pathToScope, isSecretWrite } from './folio-api-tool.ts';

test('pathToScope maps the write surfaces', () => {
  expect(pathToScope('PATCH', '/api/v1/w/acme/settings/x/ai-keys')).toBe('SECRET'); // ai-keys = secret
  expect(pathToScope('POST',  '/api/v1/w/acme/tokens')).toBe('SECRET');
  expect(pathToScope('PATCH', '/api/v1/w/acme')).toBe('workspace:admin');
  expect(pathToScope('POST',  '/api/v1/w/acme/members')).toBe('members:write');
  expect(pathToScope('POST',  '/api/v1/w/acme/p/x/tables')).toBe('config:write');
  expect(pathToScope('POST',  '/api/v1/w/acme/p/x/documents')).toBe('documents:write');
  expect(pathToScope('GET',   '/api/v1/w/acme/p/x/tables')).toBe(null); // reads not gated here
});

test('an UNMAPPED write path returns UNMAPPED (default-deny signal)', () => {
  expect(pathToScope('POST', '/api/v1/w/acme/p/x/some-future-route')).toBe('UNMAPPED');
});

test('isSecretWrite is true only for tokens + ai-keys writes', () => {
  expect(isSecretWrite('POST', '/api/v1/w/acme/tokens')).toBe(true);
  expect(isSecretWrite('PATCH', '/api/v1/w/acme/settings/x/ai-keys')).toBe(true);
  expect(isSecretWrite('PATCH', '/api/v1/w/acme/settings/x')).toBe(false); // settings != secret
  expect(isSecretWrite('GET', '/api/v1/w/acme/tokens')).toBe(false); // read
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/folio-api-tool.test.ts -t "pathToScope"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement pathToScope + isSecretWrite**

In `apps/server/src/lib/folio-api-tool.ts`, replace the `classifyRisk` export with these. The return `'UNMAPPED'` is the default-deny signal (T5):

```ts
export type ScopeTarget = string | 'SECRET' | 'UNMAPPED' | null;

/** Secret-class writes: never grantable to any token (T6). */
export function isSecretWrite(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET') return false;
  return /\/tokens(\/|$)/.test(path) || /\/ai-keys(\/|$)/.test(path);
}

/**
 * Map a write to its required scope. Reads (GET) → null (gated elsewhere).
 * Secret writes → 'SECRET' (always refused). A write path with NO mapping →
 * 'UNMAPPED' (the handler refuses — default-deny, T5). Every NEW write route
 * MUST add a branch here or it fails closed.
 */
export function pathToScope(method: string, path: string): ScopeTarget {
  const m = method.toUpperCase();
  if (m === 'GET') return null;
  if (isSecretWrite(m, path)) return 'SECRET';
  if (/^\/api\/v1\/w\/[^/]+$/.test(path)) return 'workspace:admin'; // rename/delete
  if (/\/members?(\/|$)/.test(path)) return 'members:write';
  if (/\/settings(\/|$)/.test(path)) return 'settings:write';
  if (/\/(tables|fields|views|statuses)(\/|$)/.test(path)) return 'config:write';
  if (/^\/api\/v1\/w\/[^/]+\/projects(\/[^/]+)?$/.test(path)) return 'config:write';
  if (/^\/api\/v1\/w\/[^/]+\/p\/[^/]+$/.test(path)) return 'config:write';
  if (/\/documents(\/|$)/.test(path)) return 'documents:write';
  return 'UNMAPPED';
}
```

- [ ] **Step 4: Rewire the handler to scope-gate + default-deny**

In the `folio_api` write handler (the body that currently calls `classifyRisk` and refuses HIGH), replace the risk logic with:

```ts
      const scopeTarget = pathToScope(args.method, args.path);
      // Default-deny (T5): an unmapped write path is refused by construction.
      if (scopeTarget === 'UNMAPPED') {
        return { refused: true, reason: 'no scope mapping for this write path; refused', plan: { method: args.method, path: args.path } };
      }
      // Secret carve-out (T6): never applied for ANY token.
      if (scopeTarget === 'SECRET') {
        return { refused: true, reason: 'secret-class write (tokens/ai-keys) is never applied by an agent', plan: { method: args.method, path: args.path } };
      }
      // Scope check: the token + caller must both hold the required scope.
      if (scopeTarget !== null && (!ctx.token.scopes.includes(scopeTarget) || !ctx.callerScopes.includes(scopeTarget))) {
        return { refused: true, reason: `missing scope ${scopeTarget}; refused`, plan: { method: args.method, path: args.path } };
      }
      // dryRun preview path — unchanged (keep the existing dryRun handling here).
      const res = await dispatchAsCaller(ctx.token, args.method, args.path, body);
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
```

(Read the current handler to keep the existing `body`/`dryRun` plumbing; only the risk-tier/refuse block changes. Remove the now-dead `classifyRisk`, the `tier === 'high'` and `tier === 'medium' && unattended` blocks — their behavior is subsumed: secrets → SECRET refuse; settings/members/workspace → scope-gated; unmapped → refuse.)

- [ ] **Step 5: Update callers of classifyRisk**

Run: `cd apps/server && grep -rn "classifyRisk" src/` — update or remove every reference (the `executeTool` floor in `agent-tools.ts` that floored HIGH-risk native tools may reference the risk tiers; reconcile so the new scope check is the single gate). Keep the `UNATTENDED_FLOORED_SCOPES` behavior for native agent-lifecycle tools if still desired, but the folio_api carve-out now lives in `pathToScope`/`isSecretWrite`.

- [ ] **Step 6: Run tests + regression**

Run: `cd apps/server && bun test src/lib/folio-api-tool.test.ts`
Expected: new tests PASS; update any existing test that asserted the old `classifyRisk` 'high'/'medium' strings (they now assert refuse-reasons/scope behavior).

- [ ] **Step 7: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/folio-api-tool.ts apps/server/src/lib/folio-api-tool.test.ts apps/server/src/lib/agent-tools.ts
git commit -m "phase-auth A6: folio_api path->scope map, default-deny on unmapped, secret-refuse"
```

### Task A7: Token-create capability gate (reach=null) + new-scope ceiling + reach immutability

**Files:**
- Modify: `apps/server/src/routes/tokens.ts` (POST handler ~line 36)
- Test: `apps/server/src/routes/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/routes/tokens.test.ts`:

```ts
test('instance-admin (owner of __system) may mint a reach=null token', async () => {
  // Seed: user U is owner of __system. POST /api/v1/w/__system/tokens
  //   body { name, scopes:['documents:read'], workspaceId: null } → 201; row.workspace_id IS NULL.
});

test('a non-admin (member, not __system owner) requesting workspaceId:null → 403', async () => {
  // member of workspace A (not __system). POST with workspaceId:null → 403 FORBIDDEN.
});

test('omitting workspaceId pins to the URL workspace (back-compat)', async () => {
  // POST /api/v1/w/<A>/tokens with no workspaceId → row.workspace_id === A.id.
});

test('member cannot mint a workspace:admin scope (ceiling)', async () => {
  // member POST scopes:['workspace:admin'] → 403 FORBIDDEN_SCOPE.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/routes/tokens.test.ts -t "reach"` and `-t "ceiling"`
Expected: FAIL — body has no `workspaceId` field; null not handled; new scopes rejected by old ceiling only if roleToScopes already updated (A5 done, so the ceiling test may pass — keep it as a regression guard).

- [ ] **Step 3: Implement the gate**

In `apps/server/src/routes/tokens.ts`: add imports:

```ts
import { getSystemWorkspaceId } from '../lib/system-workspace.ts';
```

Extend the zod body and the handler:

```ts
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      scopes: z.array(z.string()).default(['documents:read', 'documents:write']),
      // null = instance-wide reach (capability-gated below); omitted = pin to URL ws.
      workspaceId: z.string().nullable().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const urlWorkspaceId = c.req.param('workspaceId');
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, urlWorkspaceId), eq(memberships.userId, user.id)),
    });
    if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);

    const { name, scopes, workspaceId: requestedReach } = c.req.valid('json');

    // Reach: omitted → pin to the URL workspace (back-compat). Explicit null →
    // instance reach, allowed ONLY for an instance-admin (owner/admin of __system).
    let reach: string | null = urlWorkspaceId;
    if (requestedReach === null) {
      const systemId = await getSystemWorkspaceId(db);
      const sysMembership = await db.query.memberships.findFirst({
        where: and(eq(memberships.workspaceId, systemId), eq(memberships.userId, user.id)),
      });
      const isInstanceAdmin = sysMembership?.role === 'owner' || sysMembership?.role === 'admin';
      if (!isInstanceAdmin) {
        throw new HTTPError('FORBIDDEN', 'only an instance admin may mint an instance-wide (reach=null) token', 403);
      }
      reach = null;
    } else if (typeof requestedReach === 'string' && requestedReach !== urlWorkspaceId) {
      // Don't allow minting a token pinned to a DIFFERENT workspace via this URL.
      throw new HTTPError('FORBIDDEN', 'workspaceId must be null (instance) or match the URL workspace', 403);
    }

    // Scope ceiling: caller may only mint scopes their __system OR url-ws role grants.
    // For instance reach, the ceiling is the __system role; for a pinned token, the url-ws role.
    const allowed = roleToScopes(m.role);
    const over = scopes.filter((s) => !allowed.includes(s));
    if (over.length > 0) {
      throw new HTTPError('FORBIDDEN_SCOPE', `role '${m.role}' cannot mint a token with scope(s): ${over.join(', ')}`, 403);
    }

    const { token, hash } = newApiToken();
    const id = nanoid();
    await db.insert(apiTokens).values({ id, workspaceId: reach, name, tokenHash: hash, scopes, createdBy: user.id });
    return jsonOk(c, { id, name, token, scopes, instance: reach === null }, 201);
  },
```

- [ ] **Step 4: Reach immutability (T2)**

Confirm there is NO token-PATCH route. Run: `cd apps/server && grep -rn "tokensRoute.patch\|apiTokens.*update\|update(apiTokens)" src/` — there must be no path that updates `workspace_id`. Add a regression test asserting the route surface is mint + delete only:

```ts
test('there is no token mutation route that alters workspace_id (reach immutable)', async () => {
  // Assert PATCH /api/v1/w/<ws>/tokens/<id> → 404/405 (no such route).
});
```

- [ ] **Step 5: Run tests + regression**

Run: `cd apps/server && bun test src/routes/tokens.test.ts`
Expected: PASS, including the existing mint/ceiling tests.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/routes/tokens.ts apps/server/src/routes/tokens.test.ts
git commit -m "phase-auth A7: token-create reach gate (instance-admin mints null) + immutability guard"
```

### Task A8: Per-run effective-reach intersection (replaces line-410 rebind) — LOAD-BEARING

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (the `narrowedToken` block ~lines 399-412)
- Test: `apps/server/src/lib/runner.test.ts` (or `src/services/agent-runs.test.ts` if run-context tests live there)

> This is T4 — the per-run workspace floor. The resolver must read the NARROWED reach, never the raw token. A member triggering the operator must NOT reach a third workspace mid-run.

- [ ] **Step 1: Write the failing test**

```ts
test('operator run triggered by a member in B cannot reach workspace C', async () => {
  // Seed: operator token (workspaceId null). A run whose target (caller_reach) is B,
  // triggered by a member whose reach is B. Build the run context (loadContext),
  // then drive a tool call (e.g. list_documents { workspace_slug: C }) using the
  // run's narrowed token → must throw 'workspace not accessible'.
  // And the SAME call with workspace_slug: B → succeeds.
});

test('operator run triggered by an instance-admin can reach any workspace', async () => {
  // caller_reach null → effective_reach null → list_documents in C succeeds.
});
```

(Use the runner/loadContext harness already in the test file. The key assertion: the token the resolver sees during the run has `workspaceId === B` for the member case, not null.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test <runner test file> -t "cannot reach workspace C"`
Expected: FAIL — with line-410 still present and operator reach=null, the run resolves any workspace → C call succeeds (the bug).

- [ ] **Step 3: Implement the intersection**

In `apps/server/src/lib/runner.ts`, add import:

```ts
import { effectiveReach } from './token-reach.ts';
```

The run must know `caller_reach` = the run's target workspace authority. It is `run.workspaceId` (the run's target, which is caller-clamped at run-creation — see spec precondition). Replace line 410's `workspaceId: isLibraryAgent ? run.workspaceId : token.workspaceId` with the intersection:

```ts
  // Per-run workspace floor (T4): the run token's reach = token reach ∩ caller reach.
  // caller_reach is the run's target workspace (run.workspaceId), which is itself
  // clamped to the caller at run-creation. The resolver reads THIS narrowed reach,
  // never token.workspaceId. Replaces the old isLibraryAgent rebind.
  const reach = effectiveReach(token.workspaceId, run.workspaceId);
  if (!reach.ok) {
    // The token's pin excludes the run's target — fail the run closed.
    await transitionRun(ctx.run.id, 'failed', /* reason */ 'reach_denied', ctx.transitionActor);
    return null; // (match the function's existing early-return contract)
  }
  const agentProjectSide = isLibraryAgent ? ['*'] : (token.projectIds ?? ['*']);
  const narrowedToken = {
    ...token,
    workspaceId: reach.workspaceId,
    projectIds: intersectAgentProjects(agentProjectSide, callerProjectIds),
  };
```

(Read the exact surrounding code: keep `agentProjectSide`/`callerProjectIds`/`intersectAgentProjects` exactly as-is — only the `workspaceId` line changes from the rebind to `reach.workspaceId`, plus the deny guard. Match the real `transitionRun` signature + early-return shape used elsewhere in this function.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test <runner test file> -t "reach"`
Expected: PASS — member-triggered run denied in C, allowed in B; admin-triggered reaches C.

- [ ] **Step 5: Regression — existing library/local agent runs**

Run: `cd apps/server && bun test src/lib/runner.test.ts src/services/agent-runs.test.ts`
Expected: PASS. A local agent (token pinned to its own ws, run.workspaceId === that ws) → `effectiveReach(ws, ws)` = ws — a no-op, matching old behavior.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/runner.ts <runner test file>
git commit -m "phase-auth A8: per-run effective-reach intersection (T4) — replaces line-410 rebind"
```

### Task A9: Provision the operator as a code-provisioned instance token (workspaceId/agentId/createdBy null)

**Files:**
- Modify: `apps/server/src/lib/system-workspace.ts` (the operator-agent token mint, ~line 384-415)
- Test: `apps/server/src/lib/system-workspace.test.ts`

> Spec: the operator token is `workspaceId: null, agentId: null, createdBy: null, full scopes`. The `createdBy: null` is the bless marker (T8). Today the operator-agent token is owner-stamped + workspace-bound — this changes it.

- [ ] **Step 1: Write the failing test**

```ts
test('operator token is provisioned instance-wide with system origin', async () => {
  // After bootstrap/designate, find the operator's token.
  // Assert: workspaceId === null, agentId === null, createdBy === null,
  //   scopes ⊇ roleToScopes('owner') (full), and it is NOT mintable via POST /tokens.
});

test('workspaceId===null ⟹ agentId===null holds for the operator token (T3)', async () => {
  // assert the combo-invariant on the provisioned row.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/system-workspace.test.ts -t "operator token"`
Expected: FAIL — today's operator token has a workspaceId (+ owner createdBy, + agentId to the operator agent).

- [ ] **Step 3: Implement**

In `apps/server/src/lib/system-workspace.ts`, find where the operator agent's bearer token is auto-minted (the `ensureOperatorAgent` path / createDocument auto-mint). The operator must be provisioned as a STANDALONE instance token, decoupled from the agent doc's auto-mint:

```ts
// Provision the operator's instance token: code-minted, system origin, full reach.
// workspaceId null (instance), agentId null (NOT agent-bound — the combo invariant),
// createdBy null (SYSTEM origin — the unforgeable bless marker, T8). Idempotent.
async function ensureOperatorToken(db: DB): Promise<void> {
  const existing = await db.query.apiTokens.findFirst({
    where: and(isNull(apiTokens.workspaceId), isNull(apiTokens.createdBy), isNull(apiTokens.agentId)),
  });
  if (existing) return; // already provisioned
  const { hash } = newApiToken(); // plaintext handed to the runner via the operator-token plumbing
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    agentId: null,
    createdBy: null,
    name: 'folio-operator',
    tokenHash: hash,
    scopes: roleToScopes('owner'),
  });
  // NOTE: the runner's operator-token plumbing (handing the operator its token)
  // must read THIS token, not the agent-doc auto-mint. Reconcile the runner's
  // operator-token lookup to find (workspaceId null AND createdBy null AND agentId null).
}
```

(Read the current operator seeding to see how the runner currently obtains the operator token, and repoint that lookup. The agent DOC still exists — its prompt/skills are unchanged; only the TOKEN identity changes. Confirm `isNull` is imported from drizzle-orm.)

- [ ] **Step 4: Reconcile the runner's operator-token lookup**

Run: `cd apps/server && grep -rn "apiTokens.agentId\|eq(apiTokens.agentId" src/lib/runner.ts` — wherever the runner loads the operator's token by `agentId`, change it to load the system-origin instance token. Add a runner test that an operator run uses the instance token (reach=null).

- [ ] **Step 5: Run tests + regression**

Run: `cd apps/server && bun test src/lib/system-workspace.test.ts src/lib/runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/system-workspace.ts apps/server/src/lib/runner.ts apps/server/src/lib/system-workspace.test.ts
git commit -m "phase-auth A9: operator = code-provisioned instance token (workspaceId/agentId/createdBy null)"
```

### Task A10: Allow an instance bearer to create workspaces

**Files:**
- Modify: `apps/server/src/routes/workspaces.ts` (POST `/` ~line 42, `requireSessionUser`)
- Test: `apps/server/src/routes/workspaces.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('an instance bearer with workspace:admin can create a workspace', async () => {
  // mint instance token (workspaceId null, scopes incl workspace:admin) → POST /api/v1/workspaces → 201.
});
test('a pinned member bearer cannot create a workspace', async () => {
  // pinned token → POST /api/v1/workspaces → 403.
});
test('session user still creates workspaces (unchanged)', async () => { /* existing */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/routes/workspaces.test.ts -t "instance bearer"`
Expected: FAIL — `requireSessionUser` rejects all bearer tokens with 403.

- [ ] **Step 3: Implement**

Replace the `requireSessionUser` gate on POST `/` with a composite that allows EITHER a session user OR an instance bearer holding `workspace:admin`. Add a small middleware or inline check (read the route; `attachToken` must run at this mount — if it doesn't, the bearer is invisible, so add it). Implementation:

```ts
// Allow: session user, OR an instance-reach bearer (workspaceId null) holding workspace:admin.
workspacesRoute.post('/', async (c, next) => {
  const token = c.get('token');
  const user = c.get('user');
  const instanceBearer = token && token.workspaceId === null && token.scopes.includes('workspace:admin');
  if (!user && !instanceBearer) {
    throw new HTTPError('FORBIDDEN', 'workspace creation requires a session or an instance bearer with workspace:admin', 403);
  }
  return next();
}, zValidator(/* existing */), async (c) => { /* existing create handler — keep as-is */ });
```

(Verify `attachToken` runs before this route so `c.get('token')` is populated; if the route is mounted on `v1` without `attachToken`, mount it or read the token explicitly. Keep the existing reserved-slug + membership-insert logic. The createdBy on the new workspace's owner membership: for an instance bearer there is no human user — insert the membership against `token.createdBy` if present, else skip owner-membership for instance-created workspaces, or assign to the instance-admin who owns __system. Decide and TEST: simplest is to make the __system owner the new workspace owner.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/routes/workspaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/routes/workspaces.ts apps/server/src/routes/workspaces.test.ts
git commit -m "phase-auth A10: instance bearer with workspace:admin can create workspaces"
```

### Task A11: UI — reach toggle + admin scope checkboxes

**Files:**
- Modify: `apps/web/src/components/settings/token-create-modal.tsx`
- Test: `apps/web/src/components/settings/token-create-modal.test.tsx` (vitest — run `cd apps/web && npx vitest run <file>`)

- [ ] **Step 1: Write the failing test**

**Unit test verifies:** the reach control is admin-gated AND (per testing-workflow "no UI assertion without a data check") selecting "instance" actually reaches the create mutation as `workspaceId: null` — render + submit, not render alone.

```tsx
// HAPPY: admin can pick instance → it reaches the mutation as null.
test('selecting "Whole instance" submits workspaceId:null to the create mutation', async () => {
  const mutate = vi.fn();
  // render isInstanceAdmin=true, mutation mocked. Pick instance radio, name, a scope, submit.
  expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: null }));
});
// EDGE: non-admin has no instance option → default submit omits workspaceId (pins to URL ws).
test('non-admin: instance option absent; submit omits workspaceId', async () => {
  const mutate = vi.fn();
  expect(mutate).toHaveBeenCalledWith(expect.not.objectContaining({ workspaceId: null }));
});
// HAPPY: admin scopes are ticks, never in a preset.
test('admin scopes are offered as checkboxes but not bundled into a preset', () => {
  // settings:write / members:write / workspace:admin appear as ticks; assert NO PRESETS entry contains them.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/settings/token-create-modal.test.tsx`
Expected: FAIL — no reach control; admin scopes absent.

- [ ] **Step 3: Implement**

In `token-create-modal.tsx`: add the three admin scopes to `ALL_SCOPES`; do NOT add them to any `PRESETS` entry (mirror the `agents:write` BUG-007 rule). Add a reach radio (`'workspace' | 'instance'`), defaulting to `'workspace'`; show `'instance'` only when an `isInstanceAdmin` prop/flag is true. On submit, send `workspaceId: reach === 'instance' ? null : undefined` to the create mutation. Wire the `isInstanceAdmin` flag from the settings page (the user's `__system` role — fetch or pass down). Add help text: "Whole instance — all workspaces (instance admins only)".

- [ ] **Step 4: Run test + typecheck**

Run: `cd apps/web && npx vitest run src/components/settings/token-create-modal.test.tsx`
Expected: PASS.
Run: `cd apps/web && bun x tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/web/src/components/settings/token-create-modal.tsx apps/web/src/components/settings/token-create-modal.test.tsx
git commit -m "phase-auth A11: token-create UI — reach toggle + admin scope checkboxes"
```

### Task A12: Read-site audit for nullable workspace_id (#4) + Piece A integration

**Files:**
- Modify: `apps/server/src/routes/tokens.ts` (GET list — instance tokens), and any per-workspace token/event query that must not silently drop null-workspace rows.
- Test: `apps/server/src/routes/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('instance tokens do not vanish: a listing surface includes null-workspace tokens', async () => {
  // GET the per-workspace token list for A → does NOT include the instance token (correct).
  // GET the instance-token listing surface (new) → includes it.
});
```

- [ ] **Step 2: Audit every read site**

Run: `cd apps/server && grep -rn "workspace_id\|workspaceId" src/ | grep -iE "apiTokens|api_tokens|events" | grep -iE "eq\(|where"` — for each, decide: should an instance (null) token/row appear? Add an instance-token listing surface (e.g. `GET /api/v1/instance/tokens` for `__system` admins) so instance tokens are manageable. Confirm event grouping handles null workspace (events already allow null workspaceId for system events per event-bus.ts:42 — verify).

- [ ] **Step 3: Implement the instance-token listing**

Add a route returning tokens with `workspace_id IS NULL`, gated to `__system` owner/admin (session). Minimal — list id/name/scopes/createdAt, never the hash.

- [ ] **Step 4: Run Piece A integration**

Run: `cd apps/server && bun test` (full suite from apps/server).
Expected: 0 fail. Then `bun x tsc --noEmit` clean from apps/server.
Then run `/integration` (or the project's integration gate) on the Piece A diff.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/routes/tokens.ts apps/server/src/routes/tokens.test.ts
git commit -m "phase-auth A12: instance-token listing surface (nullable workspace_id read-site audit)"
```

---

# Piece B — Skills (reach + trust)

> Ship after Piece A merges (B1's `__system` resolution is independent of reach, but `get_skill`'s narrow exemption + the trust gate read cleanest on top of A's token model). Tests from `apps/server`.

### Task B1: `loadAgentDefinition` resolves skills from `__system` + threads the trust flag

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (`loadAgentDefinition` ~line 493; the skills-preamble builder)
- Test: `apps/server/src/lib/runner.test.ts`

> Fix: today it reads `agent.workspaceId`; it must read `__system`. And it must thread each skill's `trusted` flag so an unblessed skill loads as DATA, not instructions.

- [ ] **Step 1: Write the failing test**

```ts
test('a worker agent in workspace B loads a __system skill (push)', async () => {
  // Seed __system skills project with page 'seo' (trusted:true). A worker agent
  // in workspace B with frontmatter.skills:['seo']. loadAgentDefinition → returns
  // the seo skill body (previously MISSING_SKILL because it looked in B).
});

test('an unblessed (trusted:false) skill is returned as untrusted, not system-channel', async () => {
  // skill 'draft' trusted:false in __system. loadAgentDefinition marks it trusted:false;
  // the run assembles it into the DATA envelope, not the system prompt.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/runner.test.ts -t "worker agent in workspace B loads"`
Expected: FAIL — MISSING_SKILL (resolver looks in B).

- [ ] **Step 3: Implement __system resolution + trust flag**

In `loadAgentDefinition`, replace the `agent.workspaceId` skills-project lookup with `__system`, and carry `trusted`:

```ts
async function loadAgentDefinition(
  db: DB,
  agent: Document,
): Promise<{ prompt: string; skills: Array<{ slug: string; body: string; trusted: boolean }> }> {
  const fm = agent.frontmatter as { skills?: string[] };
  const slugs = fm.skills ?? [];
  if (slugs.length === 0) return { prompt: agent.body ?? '', skills: [] };
  // Skills live ONLY in __system (not the agent's home). Always resolve there.
  const systemId = await getSystemWorkspaceId(db);
  const skillsProject = await db.query.projects.findFirst({
    where: and(eq(projectsTable.workspaceId, systemId), eq(projectsTable.slug, 'skills')),
  });
  if (!skillsProject) throw new HTTPError('MISSING_SKILL', 'skills project not found in __system', 500);
  const skills: Array<{ slug: string; body: string; trusted: boolean }> = [];
  for (const slug of slugs) {
    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, systemId),
        eq(documents.projectId, skillsProject.id),
        eq(documents.slug, slug),
        eq(documents.type, 'page'),
      ),
    });
    if (!doc) throw new HTTPError('MISSING_SKILL', `skill "${slug}" not found in __system Skills project`, 500);
    const sfm = (doc.frontmatter ?? {}) as { trusted?: boolean };
    skills.push({ slug, body: doc.body ?? '', trusted: sfm.trusted === true });
  }
  return { prompt: agent.body ?? '', skills };
}
```

(Import `getSystemWorkspaceId` if not already imported in runner.ts.)

- [ ] **Step 4: Route trusted vs untrusted skills into the right channel**

Find where the runner assembles `definition.skills` into the prompt (the `buildSkillsPreamble` / `ccSkillsPreamble` path). Split: `trusted:true` skills → the trusted system channel (as today); `trusted:false` skills → the untrusted-DATA envelope (the same wrapper used for document/comment content, see runner.ts:110/1124). Show the split explicitly:

```ts
const trustedSkills = definition.skills.filter((s) => s.trusted);
const untrustedSkills = definition.skills.filter((s) => !s.trusted);
// trustedSkills → prepend to system prompt (existing buildSkillsPreamble path)
// untrustedSkills → fold into taskContext under the BEGIN/END untrusted markers
```

- [ ] **Step 5: Run tests + regression**

Run: `cd apps/server && bun test src/lib/runner.test.ts`
Expected: PASS. The operator (`skills:['folio']`, seeded trusted:true in B4) still gets folio in the trusted channel.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/runner.ts apps/server/src/lib/runner.test.ts
git commit -m "phase-skills B1: loadAgentDefinition reads __system + threads skill trust flag"
```

### Task B2: `get_skill` tool — narrow `__system` skills-page read

**Files:**
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (register the tool)
- Modify: `packages/shared/src/index.ts` (add `get_skill` to `V1_MCP_TOOLS` if the tool list is enumerated there)
- Test: `apps/server/src/lib/agent-tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('get_skill returns a __system skill body for a worker token', async () => {
  // worker token pinned to B. get_skill({ slug: 'seo' }) → seo body (cross-__system read).
});
test('get_skill CANNOT read a non-skill __system doc', async () => {
  // get_skill({ slug: '<a __system agent slug>' }) → not found (type=page + skills project pinned).
});
test('get_skill cannot read another workspace doc', async () => {
  // get_skill({ slug: '<a doc in workspace B, not __system>' }) → not found.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts -t "get_skill"`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Register get_skill (narrow exemption, T7)**

In `agent-tools-registry.ts`:

```ts
registerTool({
  name: 'get_skill',
  description: 'Load a skill from the __system library by slug. Read-only; reaches only __system skills pages.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  requiredScope: 'documents:read',
  schema: z.object({ slug: z.string() }).strict(),
  handler: async (args, _ctx) => {
    // Hard-wired narrow read (T7): __system + skills project + type=page ONLY.
    // Bypasses the reach gate by construction; reaches nothing else in __system.
    const systemId = await getSystemWorkspaceId(db);
    const skillsProject = await db.query.projects.findFirst({
      where: and(eq(projects.workspaceId, systemId), eq(projects.slug, 'skills')),
    });
    if (!skillsProject) throw new Error('skills library not found');
    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, systemId),
        eq(documents.projectId, skillsProject.id),
        eq(documents.slug, args.slug),
        eq(documents.type, 'page'),
      ),
    });
    if (!doc) throw new Error('skill not found');
    const sfm = (doc.frontmatter ?? {}) as { trusted?: boolean; description?: string; when_to_use?: string };
    return textResult({ slug: args.slug, body: doc.body ?? '', trusted: sfm.trusted === true });
  },
});
```

(`get_skill` does NOT call `resolveWorkspaceForToken` — that's the point; it ignores the token's reach by construction but is pinned to the skills project + type=page. Import `getSystemWorkspaceId` if needed.)

- [ ] **Step 4: Add to the tool whitelist constants**

If `V1_MCP_TOOLS` (packages/shared) enumerates the allowed tools, add `'get_skill'`. Run `cd apps/server && grep -rn "V1_MCP_TOOLS" src/ ../../packages/shared/src` and update. Add `get_skill` to OPERATOR_TOOLS and to any worker-agent default tool set that should pull skills.

- [ ] **Step 5: Run tests + regression**

Run: `cd apps/server && bun test src/lib/agent-tools.test.ts -t "get_skill"` and the full file.
Expected: PASS; the negative cases (non-skill doc, other workspace) return not-found.

- [ ] **Step 6: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/agent-tools-registry.ts packages/shared/src/index.ts apps/server/src/lib/agent-tools.test.ts
git commit -m "phase-skills B2: get_skill — narrow __system skills-page read (T7)"
```

### Task B3: Skill trust gate — `set_skill_trust` (separation of duties, T8)

**Files:**
- Create: `apps/server/src/lib/skill-trust.ts` (`canBlessSkill` + the trust service)
- Modify: `apps/server/src/lib/agent-tools-registry.ts` (register `set_skill_trust`) and the document-write path to make `trusted` server-managed on normal writes.
- Test: `apps/server/src/lib/skill-trust.test.ts`

> T8: bless iff (session) OR (token is the system-provisioned operator — `createdBy IS NULL`). An MCP PAT (`createdBy` = human) may NOT bless. A normal skill write may NOT set `trusted`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/skill-trust.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { canBlessSkill } from './skill-trust.ts';

describe('canBlessSkill (T8)', () => {
  test('session user (no token) may bless', () => {
    expect(canBlessSkill(null, { id: 'u1' } as any)).toBe(true);
  });
  test('operator token (createdBy null, system origin) may bless', () => {
    expect(canBlessSkill({ createdBy: null } as any, null)).toBe(true);
  });
  test('MCP admin PAT (createdBy = a human) may NOT bless', () => {
    expect(canBlessSkill({ createdBy: 'u-human' } as any, null)).toBe(false);
  });
  test('worker token (createdBy = human) may NOT bless', () => {
    expect(canBlessSkill({ createdBy: 'u-human', agentId: 'a1' } as any, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/skill-trust.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement canBlessSkill**

Create `apps/server/src/lib/skill-trust.ts`:

```ts
import type { ApiToken, User } from '../db/schema.ts';

/**
 * Skill-blessing separation of duties (T8). Authoring a skill is open; flipping
 * `trusted` is restricted to:
 *   - a session user (no token), OR
 *   - the system-provisioned operator token, identified by SYSTEM ORIGIN
 *     (createdBy IS NULL — unforgeable: POST /tokens always stamps a human).
 * An MCP admin PAT (createdBy = a human) is excluded by construction, so the
 * externally-reachable agent cannot self-bless a planted skill.
 */
export function canBlessSkill(
  token: Pick<ApiToken, 'createdBy'> | null,
  sessionUser: Pick<User, 'id'> | null,
): boolean {
  if (sessionUser && !token) return true;            // session auth
  if (token && token.createdBy === null) return true; // system-origin operator
  return false;
}
```

- [ ] **Step 4: Run the unit test**

Run: `cd apps/server && bun test src/lib/skill-trust.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register set_skill_trust + make `trusted` server-managed on writes**

Add a `set_skill_trust` tool/route that: resolves the `__system` skill page by slug; checks `canBlessSkill(ctx.token, sessionUser)` → refuse if false; updates `frontmatter.trusted`; emits a `skill.trust.changed` event via `emitEvent`/`txWithEvents` (actor + slug + value). And in the document-write path (`update_document`/`create_document`/`folio_api` writing a `__system` skill page), STRIP `trusted` from incoming frontmatter (server-managed key — like the existing reserved-key handling). Add tests:

```ts
test('set_skill_trust by an MCP PAT (createdBy human) is refused', async () => { /* … → refused */ });
test('set_skill_trust by the operator token (createdBy null) flips trusted + emits skill.trust.changed', async () => { /* … */ });
test('a normal update_document to a skill cannot set trusted:true', async () => { /* trusted stays false */ });
```

(Read the reserved-frontmatter-key handling already used for `api_token_id`/`last_fired_at` and add `trusted` to that server-managed set for skill pages. Reuse the `emitEvent` signature from events.ts.)

- [ ] **Step 6: Run tests + regression**

Run: `cd apps/server && bun test src/lib/skill-trust.test.ts src/lib/agent-tools.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/skill-trust.ts apps/server/src/lib/skill-trust.test.ts apps/server/src/lib/agent-tools-registry.ts
git commit -m "phase-skills B3: set_skill_trust (T8 separation of duties) + trusted server-managed"
```

### Task B4: Seed the `folio` skill `trusted: true` + description/when_to_use

**Files:**
- Modify: `apps/server/src/lib/system-skills.ts` (FOLIO_SKILL frontmatter)
- Modify: `apps/server/src/lib/system-workspace.ts` (`ensureSystemPage` — accept + write frontmatter)
- Test: `apps/server/src/lib/system-skills.test.ts`, `system-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('seeded folio skill carries trusted:true + description + when_to_use', async () => {
  // after bootstrap, the __system/skills/folio page frontmatter has
  //   trusted === true, description (non-empty), when_to_use (non-empty).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/lib/system-workspace.test.ts -t "folio skill carries trusted"`
Expected: FAIL — `ensureSystemPage` writes `frontmatter: {}`.

- [ ] **Step 3: Implement**

In `system-skills.ts`, export the folio skill's frontmatter:

```ts
export const FOLIO_SKILL_FRONTMATTER = {
  trusted: true,
  description: 'Folio API manual — drive projects, tables, fields, views, statuses, providers.',
  when_to_use: 'Before shaping a workspace or adding a provider; whenever you need the resource→route→scope map or the risk-gate protocol.',
};
```

In `system-workspace.ts`, give `ensureSystemPage` a `frontmatter` param (default `{}`) and write it on insert; pass `FOLIO_SKILL_FRONTMATTER` for the folio page:

```ts
await ensureSystemPage(db, sys.id, skillsProject.id, 'folio', FOLIO_SKILL_BODY, FOLIO_SKILL_FRONTMATTER);
```

(NOTE the seed-once limitation: an already-seeded `__system` keeps the old `frontmatter: {}`. Add a one-time reconcile step OR document that fresh installs only get this — see the plan's "Seed-once" note. For a live install, the trust flag must be set via `set_skill_trust` once.)

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/lib/system-workspace.test.ts src/lib/system-skills.test.ts`
Expected: PASS (the existing skill-body content tests still pass).

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/lib/system-skills.ts apps/server/src/lib/system-workspace.ts apps/server/src/lib/system-skills.test.ts
git commit -m "phase-skills B4: seed folio skill trusted:true + description/when_to_use"
```

### Task B5: Piece B integration + MCP instructions pointer (deferred-light)

**Files:**
- Modify: `apps/server/src/routes/mcp.ts` (add `instructions` to `initialize`) — small, the outside-agent discovery pointer.
- Test: `apps/server/src/routes/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('MCP initialize returns an instructions pointer mentioning get_skill', async () => {
  // POST /mcp initialize → result.instructions is a non-empty string mentioning get_skill / skills.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/routes/mcp.test.ts -t "instructions"`
Expected: FAIL — no instructions field.

- [ ] **Step 3: Implement**

In `mcp.ts` `initialize` result, add:

```ts
        instructions:
          'Folio is markdown-native and agent-first. A skill library lives in __system. ' +
          'Call get_skill(slug) to load a skill body (e.g. get_skill("folio") for the API manual) ' +
          'before shaping projects, tables, views, or adding a provider. Reads via folio_api_get; writes via folio_api.',
```

- [ ] **Step 4: Piece B integration**

Run: `cd apps/server && bun test` (full suite) → 0 fail. `bun x tsc --noEmit` from apps/server, packages/shared, apps/web → clean. Run `/shakeout` (or the project's spec-complete gate) on the full branch diff — it dispatches the invariant-auditor (verify T4: no resolver reads raw `token.workspaceId` on a run path; T5: every write maps to a scope) + the security/threat reviewers.

- [ ] **Step 5: Commit**

```bash
cd /home/ntdst/Projects/folio
git add apps/server/src/routes/mcp.ts apps/server/src/routes/mcp.test.ts
git commit -m "phase-skills B5: MCP initialize instructions pointer (get_skill discovery)"
```

---

## Phase Gate A — Piece A integration + acceptance (run after A1–A12, before merge)

> Per `netdust-core:testing-workflow` phase-complete: cross-task INTEGRATION scenarios (real HTTP, real DB), not just a regression run. Each scenario asserts BOTH the response AND persisted state. Then a smoke checklist for the user.

- [ ] **Integration scenario 1 — the load-bearing privilege-borrow guard (spans A7+A8+A9)**

```
SCENARIO: a member-triggered operator run cannot reach a third workspace
  GIVEN: workspaces B and C; user M is a member of B only (not C, not __system);
         the operator is provisioned (A9, reach=null, createdBy null).
  WHEN:  M triggers an operator run whose target is B; mid-run the agent attempts a
         tool call against workspace C (real executeTool through the run's narrowed token).
  THEN:  - the C tool call is REFUSED ('workspace not accessible')
         - the SAME call against B SUCCEEDS
         - DB: no agent_run side effect landed in C (assert no documents/events written to C)
```
Implement as an integration test driving `loadContext` + a real tool dispatch (not mocked). This is the T4 regression that must never silently pass.

- [ ] **Integration scenario 2 — instance admin cross-workspace, via real HTTP (spans A4+A7)**

```
SCENARIO: an instance bearer reads + writes a workspace it isn't a member of
  GIVEN: an instance-admin human mints a reach=null token with config:write (A7);
         workspace B exists; the token's creator has NO membership in B.
  WHEN:  curl-equivalent GET /api/v1/w/<B>/documents then POST a config write to B
         using that bearer (real Hono request, not a direct handler call).
  THEN:  - GET → 200; POST → applies (200/201)
         - DB: the written row exists in B
         - a member PAT (pinned to A) doing the same against B → 403 (control)
```
(Mock-the-wire discipline: at least one REAL request per server-filtered surface — do not assert against a pre-filtered mock.)

- [ ] **Integration scenario 3 — secret + default-deny floor holds for the most-privileged token (spans A6)**

```
SCENARIO: even a full-scope instance token cannot mint secrets or hit unmapped writes
  GIVEN: instance token with ALL scopes incl workspace:admin.
  WHEN:  folio_api POST /api/v1/w/<B>/tokens ; folio_api POST .../ai-keys ;
         folio_api POST an invented unmapped write path.
  THEN:  - all three REFUSED (secret-refuse ×2, default-deny ×1)
         - DB: no token row, no ai_keys row, no write from the unmapped path
```

- [ ] **Acceptance (browser, A11) — happy / error / edge, UI + persistence**

```
HAPPY: an instance-admin opens Settings → Tokens, picks "Whole instance", creates a token.
  THEN browser shows the one-time token AND GET instance-token list shows it with workspace_id null.
ERROR: a member opens the same modal → the "Whole instance" option is absent; creating a token
  pins it to the current workspace (assert the created row's workspace_id === current ws).
EDGE:  ticking workspace:admin as a member is impossible (scope not offered to their role); if forced
  via the API, POST /tokens → 403 (already covered in A7 — assert the UI never surfaces it).
```
Run: `cd apps/web && npx playwright test <token-flow spec>` (if a Playwright config exists; else assert the create-mutation payload + a follow-up GET in a vitest integration test).

- [ ] **Phase A gate: full regression + static analysis + invariant audit**

Run, all must be green:
```bash
cd apps/server && bun test && bun x tsc --noEmit
cd ../web && npx vitest run && bun x tsc --noEmit
cd ../../packages/shared && bun test && bun x tsc --noEmit
```
Then `/shakeout` (or `/integration`) on the Piece-A diff — the invariant-auditor must confirm: no resolver reads raw `token.workspaceId` on a run path (T4), every folio_api write maps to a scope (T5).

- [ ] **Smoke test checklist (hand to the user before merge)**

```markdown
## Smoke Test — Piece A
- [ ] Settings → Tokens (as instance admin): "Whole instance" option visible. Create one.
      Expected: token shown once; appears in the instance-token list with no workspace.
- [ ] Settings → Tokens (as a plain member): no "Whole instance" option.
      Expected: any token created is pinned to the current workspace.
- [ ] Use an instance token (curl) against a workspace you're not a member of:
      Expected: reads/writes work; a pinned member token gets 403 on the same.
- [ ] Ask the operator (in-app) to do something in another workspace, triggered by a member.
      Expected: it acts only within that member's reach — not instance-wide.
- [ ] Console: DevTools > Console on the Tokens page. Expected: no red errors.
```

---

## Phase Gate B — Piece B integration + acceptance (run after B1–B5, before merge)

- [ ] **Integration scenario 1 — worker pulls + pushes a __system skill (spans B1+B2)**

```
SCENARIO: a worker agent in workspace B uses a __system skill it doesn't own
  GIVEN: __system/skills/'seo' (trusted:true). A worker agent in B with skills:['seo']
         and a worker token pinned to B.
  WHEN:  (push) start a run → loadAgentDefinition; (pull) call get_skill('seo') with the worker token.
  THEN:  - push: the seo body is in the run's TRUSTED system channel
         - pull: get_skill returns the seo body
         - NEGATIVE: get_skill('<a __system agent slug>') → not found; get_skill('<a B-only doc>') → not found
```

- [ ] **Integration scenario 2 — trust separation of duties end-to-end (spans B3)**

```
SCENARIO: MCP authors a skill, cannot bless it; operator can; unblessed loads as DATA
  GIVEN: an MCP admin PAT (createdBy = a human) and the operator token (createdBy null).
  WHEN:  MCP creates __system/skills/'evil' with trusted-in-body; then MCP calls set_skill_trust('evil', true);
         then the operator calls set_skill_trust('evil', true).
  THEN:  - the create lands trusted:false (server-managed; body cannot self-bless)
         - MCP set_skill_trust → REFUSED (createdBy = human)
         - operator set_skill_trust → applied; a skill.trust.changed event is emitted (assert the event row)
         - a run loading 'evil' BEFORE blessing gets it as untrusted DATA (not instructions)
```

- [ ] **Acceptance — happy / error / edge**

```
HAPPY: operator run with skills:['folio'] (trusted) → folio guidance is in the system channel; the run uses it.
ERROR: a worker declares skills:['does-not-exist'] → run fails MISSING_SKILL with a clear message (not a 500 leak).
EDGE:  get_skill from an outside MCP PAT works (read), but set_skill_trust from it is refused.
```

- [ ] **Phase B gate: full regression + static analysis + invariant audit**

Same commands as Phase A. The invariant-auditor confirms: get_skill reads only `(__system, skills, type=page)` (T7); set_skill_trust gates on system origin (T8); `skill.trust.changed` flows through the one event path (architecture-invariant 4).

- [ ] **Smoke test checklist (hand to the user before merge)**

```markdown
## Smoke Test — Piece B
- [ ] Give a worker agent (any workspace) a research/SEO skill via frontmatter; run it.
      Expected: the skill's guidance is in effect (no MISSING_SKILL).
- [ ] As the outside MCP agent: get_skill("folio") → returns the manual.
      As the outside MCP agent: try to mark a skill trusted → refused.
- [ ] As the operator (in-app) or as yourself in the browser: mark a skill trusted → succeeds.
- [ ] Author a new skill via MCP, don't bless it, have an agent load it.
      Expected: it informs but cannot override the agent's instructions (untrusted).
```

---

## Self-review notes (for the executor)

- **T1–T8 coverage:** A7 (T1 creation gate, T2 immutability), A9 (T3 combo invariant on operator), A8 (T4 per-run reach — the load-bearing one), A6 (T5 default-deny, T6 secret-refuse), B2 (T7 get_skill narrow), B3 (T8 bless origin).
- **Seed-once caveat:** B4's frontmatter + the operator-token re-provision (A9) reach FRESH installs. A LIVE `__system` keeps old seeded rows — the executor must, on a live install, (a) re-provision the operator token (A9's `ensureOperatorToken` is idempotent on the system-origin token, so it mints if absent), and (b) `set_skill_trust('folio', true)` once. Note this in the merge/deploy step.
- **Run from `apps/server`** for all server tests (root-cwd triggers a spurious init cascade). Web tests: `npx vitest run`. tsc per-app.
- **Order dependency:** A1→A2→(A3,A4,A5)→A6→A7→A8→A9→A10→A11→A12, then Phase Gate A, then B1→B2→B3→B4→B5, then Phase Gate B. A8 depends on A2 (effectiveReach) + A9's operator reach; A9 depends on A1 (nullable) + A5 (full scopes). B3 depends on A9 (createdBy-null operator) for the bless test.
- **testing-workflow conformance:** Per `netdust-core:testing-workflow`: (1) every TASK = unit tests, RED→GREEN, derived from the spec's acceptance criteria (not the code) — each subagent runs `task-complete` (file test green + full suite green + tsc clean) before reporting done. (2) every PHASE = the Phase Gate sections above — cross-task INTEGRATION scenarios (real HTTP/DB, assert response AND persistence), happy/error/edge ACCEPTANCE, full regression, and a SMOKE checklist handed to the user. (3) Anti-patterns avoided: no UI-assertion-without-data-check (A11 asserts the mutation payload; Phase A acceptance asserts the persisted row); mock-the-wire (Phase gates use at least one real request per server-filtered surface, not pre-filtered mocks); happy+error+edge on every unit (negative cases are explicit in A6/A10/B2/B3). (4) Stack = TypeScript → Vitest unit (`bun test` server / `npx vitest run` web) + Playwright acceptance where a config exists.
