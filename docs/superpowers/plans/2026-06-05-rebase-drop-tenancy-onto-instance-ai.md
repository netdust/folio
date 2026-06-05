# Rebase `drop-workspace-tenancy` onto post-instance-ai `main`

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans` (sequential — a rebase is inherently ordered). Append the netdust addendum to any subagent dispatch. This is a Class-B integration task with a security-boundary surface (auth + BYOK AI-keys + migrations) → the threat model below is the `/code-review` convergence target.

**Goal:** bring `spec/drop-workspace-tenancy` (91 commits, the `__system`/`memberships` teardown) onto the new `main` (`4ddf8f6`), which now contains `spec/instance-ai-config` (AI keys moved per-workspace → instance level; `ai_keys.workspace_id` dropped; a dedicated instance `/settings` route + `/instance/ai-keys`; `routes/settings.ts` DELETED; `is_instance_admin` on `/me`). After the rebase, the teardown's deletions (`memberships`, `__system`, `getSystemWorkspaceId`, …) resolve once against the instance-ai code that was written against the OLD model — so this is a reconciliation, not a replay.

**Decision (user, 2026-06-05):** instance-ai-config merged to main FIRST (done, FF). Now rebase drop-tenancy onto it.

**Mechanic:** `git rebase main` on `spec/drop-workspace-tenancy` (replays the 91 commits onto `main`). Conflicts resolve per-commit. Alternative if per-commit replay is too noisy: a single `git merge main` into drop-tenancy with one batched conflict-resolution commit. **Default to `merge main` here** — the 91 commits include many memory/auto-commits and intermediate states that already resolved each other; replaying them individually re-surfaces intermediate conflicts that the branch tip already settled. A single merge resolves against the *final* state of both sides once. (Rebase gives linear history but at high conflict-replay cost across 91 commits, many of which are noise.)

## Threat model (the /code-review convergence target)

This rebase reconciles two independent rewrites of the SAME security surfaces. The risk is a guard from one side silently lost when resolving against the other.

### Assets
- **BYOK AI-key secrets** (`ai_keys`, libsodium-encrypted). instance-ai moved them to instance scope (`(provider, label)`, no `workspace_id`) + an admin-gated `/instance/ai-keys` route that NEVER returns the secret.
- **Instance authority** (`users.role`) — drop-tenancy's single source; instance-ai also reads it (`is_instance_admin`, `requireInstanceAdmin`).
- **Workspace/project read+write authorization** — drop-tenancy replaced `memberships` reads with `canSeeWorkspace`/`userRole`/access grants across many files; instance-ai still had per-workspace AI-key gates reading `memberships`.
- **Migration integrity** — both added migrations off the same base; the journal must apply each exactly once, in order.

### Attacks → mitigations (verify each AFTER conflict resolution)
- **T-R1 (lost auth downgrade):** a conflict resolution keeps instance-ai's OLD `memberships`-based AI-key gate instead of drop-tenancy's `canSeeWorkspace`+`userRole`. → Mitigation: every AI-key read/write gate routes through the new access helpers (no surviving `memberships` read anywhere — the Phase-4 DEAD-grep must still be clean post-rebase).
- **T-R2 (settings.ts resurrection):** drop-tenancy MODIFIED `routes/settings.ts`; instance-ai DELETED it (its AI-key route supersedes). A naive resolve could resurrect the deleted file with a stale per-workspace AI-key route + a now-broken `aiKeys.workspace_id` reference. → Mitigation: TAKE THE DELETE. Any non-AI-key logic drop-tenancy added to settings.ts must be re-homed onto the surviving instance route, NOT kept in a resurrected file. Confirm `routes/settings.ts` does not exist post-rebase; confirm app.ts doesn't mount it.
- **T-R3 (migration double-apply / skip):** drop-tenancy's `0023..0028` collide with instance-ai's `0023_ai_keys_drop_workspace` (now on main). → Mitigation: RENUMBER drop-tenancy's six migrations to `0024..0029` (after instance-ai's 0023), reconcile `_journal.json` so idx is contiguous + each tag appears once, and the migration TEST (full `migrate()` over the folder) passes. The `ai_keys` table shape is instance-ai's (no workspace_id) — drop-tenancy must NOT re-add it.
- **T-R4 (schema divergence):** `schema.ts` — instance-ai changed `aiKeys` (dropped workspace_id, added label + ai_usage); drop-tenancy dropped `memberships` + added access tables + instance_skills. → Mitigation: the merged schema has BOTH sets of changes; `aiKeys` = instance-ai's shape, `memberships` GONE, access/instance_skills tables PRESENT. tsc clean.
- **T-R5 (ai_key_label run-snapshot vs operator singleton):** instance-ai snapshots `ai_key_label` onto runs + the operator seed carries it. drop-tenancy made the operator a CODE SINGLETON (no seed). → Mitigation: the operator's `ai_key_label` (if instance-ai relied on the seeded operator carrying it) moves into `operator.ts` getOperatorDefinition/Document, OR the run resolves the default label when absent (instance-ai's T4 default). Verify an operator (code singleton) resolves an AI key by `(provider, default-label)`.

### Deferred / out of scope
- Phase 5 frontend (the instance /settings Roles+Invitations tabs) — happens AFTER this rebase, on the unified surface.
- The real-key end-to-end AI run — the user's shake-out gate at spec close.

## Tasks

### Task R0: Pre-flight + branch safety
- [ ] Confirm clean tree, on `spec/drop-workspace-tenancy`, main = `4ddf8f6` (instance-ai merged).
- [ ] **Create a safety tag**: `git tag pre-rebase/drop-tenancy spec/drop-workspace-tenancy` (escape hatch — reset here if the merge goes wrong; per global rule, never `git stash` to park).
- [ ] Read instance-ai's shape of every conflicted file (`git show main:<file>`) so resolution builds to the real merged target.

### Task R1: Do the merge, resolve conflicts file-by-file
**Conflicted files (from dry-run):** `app.ts`, `db/schema.ts`, `db/migrations/meta/_journal.json`, `lib/runner.test.ts`, `lib/system-workspace.ts`, `lib/system-workspace.test.ts`, `routes/auth.ts`, `routes/auth.test.ts`, `routes/settings.ts` (modify/delete), `routes/settings.test.ts` (modify/delete), `web/lib/api/auth.ts`, `docs/.../plan` (add/add), `memory/STATE.md`.
- [ ] `git merge main` (single batched resolution).
- [ ] **settings.ts / settings.test.ts (T-R2):** `git rm` both — take instance-ai's delete. Re-home drop-tenancy's `canSeeWorkspace`/`userRole` AI-key gate logic ONLY IF instance-ai's `/instance/ai-keys` route lacks an equivalent gate (it has `requireInstanceAdmin` — verify it covers read+write; if drop-tenancy's per-ws read gate has no instance-route equivalent, that's a deliberate scope change to confirm with the user, not silently drop).
- [ ] **schema.ts (T-R4):** keep BOTH — instance-ai's `aiKeys` (no workspace_id) + `ai_usage`; drop-tenancy's NO `memberships` + access tables + instance_skills.
- [ ] **auth.ts / auth.test.ts / web auth.ts:** merge `is_instance_admin` (instance-ai) + the drop-tenancy `/me` changes (no `is_system_member`, `users.role`). Both removed `is_system_member`? Reconcile to the union.
- [ ] **system-workspace.ts:** drop-tenancy gutted it; instance-ai may still call `getSystemWorkspaceId` for AI-key scoping — but instance-ai DROPPED workspace from ai_keys, so check whether its AI-key code even needs it post-merge. Any instance-ai caller of a deleted fn must move to the new model.
- [ ] **app.ts:** mount instance-ai's `/instance/ai-keys` route; do NOT mount the deleted `settings` route.
- [ ] **_journal.json (T-R3):** resolve to instance-ai's 0023 + drop-tenancy's renumbered 0024..0029 (Task R2 does the file renames).
- [ ] **plan doc / STATE.md:** keep both histories (union; these are append-only logs).

### Task R2: Renumber drop-tenancy migrations 0023→0024..0028→0029 (T-R3)
- [ ] `git mv` each: `0023_add_user_role`→`0024_…`, `0024_access_tables`→`0025_…`, `0025_instance_skills`→`0026_…`, `0026_backfill_roles_and_access`→`0027_…`, `0027_drop_system_workspace`→`0028_…`, `0028_drop_memberships`→`0029_…`.
- [ ] Rewrite `_journal.json`: instance-ai's `0023_ai_keys_drop_workspace` at idx 24, then the renumbered six at idx 25..30, contiguous, each tag once.
- [ ] **Watch the backfill migration:** `0026_backfill_roles_and_access` reads `memberships` (still present at that point in the chain) — its position relative to instance-ai's ai_keys migration doesn't matter (disjoint tables), but confirm the full chain still runs.
- [ ] Update the `0028→0029_drop_memberships.test.ts` (the test-effectiveness teardown test) for the new filename + any `applyMigration('0027_…')`→`0028_…` reference.
- [ ] Run the migration test: full `migrate()` over the folder is green; `memberships` gone; `ai_keys` has no workspace_id; `__system` torn down.

### Task R3: Green the suite + DEAD-grep
- [ ] `cd apps/server && bun test` → 0 fail. Fix stragglers (tests from instance-ai that seeded `memberships`/per-ws ai-keys; tests from drop-tenancy that assumed no ai_usage table).
- [ ] `bun x tsc --noEmit` per workspace clean.
- [ ] DEAD-grep clean: no `memberships`, `getSystemWorkspaceId`, `__system` machinery, no per-workspace `ai_keys.workspace_id` reference.
- [ ] `cd apps/web && npx vitest run` → green (instance-ai's web AI tab + drop-tenancy web changes coexist).

### Task R4: Threat-model verification (the convergence pass)
- [ ] Verify T-R1..T-R5 against the merged source (each mitigation holds). This is the `/code-review` target.
- [ ] `/integration` gate green on the rebased branch.

**Gate:** suite green ×3, tsc clean, DEAD-grep clean, T-R1..T-R5 verified, migration chain applies once. THEN Phase 5 (frontend) resumes on the unified surface — and `routes/settings.tsx` (instance) now exists to extend, making the original Phase 5 plan's premise TRUE.
