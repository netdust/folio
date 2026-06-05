# Drop Workspace Tenancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Append the netdust addendum (testing-workflow + Test-evidence/STATUS blocks) to every implementer dispatch** — see `netdust-core:harnessed-development`.

**Goal:** Remove workspace-as-security-boundary. One instance = one team: roles move to `users.role`, access becomes invitation-based (`workspace_access` + `project_access`), `__system` is deleted with its load-bearing pieces rehomed at instance level, and the operator becomes a code-resolved runtime singleton.

**Architecture:** Expand-contract migration — add new columns/tables + backfill first, migrate every read/write off `memberships` in code, drop `memberships` LAST. Authorization rewrites the convergence points named in `ARCHITECTURE-INVARIANTS.md` (1 identity, 4 HTTP-authz, 7 token-ceiling, 11 skill-trust) — every rewrite routes *through* the convergence point, never around it. Cross-member visibility is now by-design, so the three boundaries that stay real (agent-run authority, token reach, `/events` project-scope) are pinned by explicit regression tests (the replacement for the isolation safety-net the multi-tenant model gave for free).

**Tech Stack:** Bun, Hono, Drizzle (SQLite), Zod, React + Vite + TanStack Router, Vitest (web), bun test (server). Tests: server from `apps/server`, web via `npx vitest run`, typecheck `bun x tsc --noEmit` per app.

**Spec:** `docs/superpowers/specs/2026-06-04-drop-workspace-tenancy-design.md` — read it first. Threat model = §7 (T-A…T-F), mandatory boundary tests = §8.1, invariants = §6, decisions = §2 (incl. OQ-1 = (d) runtime singleton, OQ-3 = owner-only role changes).

> **PLAN CORRECTION (discovered at T1 execution, 2026-06-04): HAND-AUTHOR all migrations; do NOT run `bun run db:generate`.** The on-disk drizzle snapshot chain is stale (lags at idx 0006 on this branch — migrations 0007..0022 were all hand-authored). `db:generate` therefore diffs against the 0006 baseline and emits a **destructive recreate-everything** migration (recreates `api_tokens`, re-adds `board_position`/`events.seq`/`provider_health`, etc.) which would double-apply on any real DB. Every migration task below that says "generate the migration" is OVERRIDDEN: write the `.sql` by hand (a single focused statement set), hand-register it in `meta/_journal.json` (idx = next, tag = filename), number it as the next integer after the highest EXISTING `.sql` on THIS branch. The migration TEST (runs all migrations in the folder via `migrate()`) is the correctness check.

> **BRANCH BASELINE (verified at execution):** off `main`, the suite is **server 1391 / shared 63 / web 762**, all green. Measure deltas from these, NOT the plan's earlier "~1011" estimate. T1 landed `0023_add_user_role.sql` (server now 1392). `0023_ai_keys_drop_workspace.sql` + the instance-AI feature are NOT on this branch.

> **CODE-REVIEW FINDINGS (`/code-review high` at Phase-3 close, 2026-06-04) — 6 CONFIRMED. Tasks CR-1..CR-5 added; finding 6 already tracked at Task 20.**
> - **CR-1 (agent-runs.ts admin ceiling):** the T-9.5 member-narrowing was NOT applied to `admin` — an instance admin with a single project_access grant gets a run ceiling over ALL ws projects (`callerProjectsFor` returns null for admin). Fix: clamp any non-owner to `canSeeProject`-visible projects (generalize the member fix to admin). [Phase 3 fix, before Phase 4]
> - **CR-2/3 (getRole owner-gates):** `getRole(c)!=='owner'` on PATCH/DELETE `/w` (workspaces.ts:195,218) + project DELETE (projects.ts:131) silently shifted meaning from per-workspace owner → instance owner, locking creators/admins out of managing their own workspaces/projects. **DECISION (user, 2026-06-04): management = `owner || hasWorkspaceAccess(user, ws)`; project delete also allows `hasProjectAccess(user, project)`.** Add a `requireWorkspaceManage`-style check via the access helpers; fix the 3 gates + tests. [Phase 3 fix]
> - **CR-4 (grant-less owner omitted):** comments.loadWorkspaceMembers + workspaces members-list show `workspace_access` holders; the owner bypasses grants so is omitted (@mention won't resolve to owner; roster incomplete). Entangled with `grantOwner` still writing legacy `memberships` not `users.role`/grants. **Resolve WITH Task 19** (owner-designation reconciliation): decide owner's appearance in workspace member contexts; re-verify both call sites. [tie to Phase 4 T19]
> - **CR-5 (instance-token listProjects under-permit):** an instance-reach token gets role='owner' from resolveWorkspace but listProjects re-derives `userRole(tokenCreator)` → a non-owner creator's token sees []. Fix: honor the context role / isInstanceReach in the route's listProjects call. [Phase 3 fix]
> - **Finding 6:** `user.role.changed` scoped to `__system` → Phase-4 teardown 500s role changes. Already documented at Task 20.
>
> **CODE-REVIEW FINDINGS — ROUND 2 (`/code-review high --base=main` on the full Phase-1→3 diff, 2026-06-04) — 6 CONFIRMED (all verified against source, 1-vote recall-biased). Round 1 capped at the first cluster; round 2 found the rest. Tasks CR-6..CR-11 added.**
> **✅ ALL 6 FIXED (2026-06-04, harnessed: threat-model on the diff → systematic-debugging per finding → TDD RED-first incl. denial path → per-fix testing-workflow close → `/integration` green). Commits `e2464e2`(CR-10)·`a4a0306`(CR-7)·`bad98e2`(CR-8/CR-11)·`adb4dcb`(CR-9)·`f196874`(CR-6). Threat model = the "CR-6..CR-11 fix surface" section above. Each fix RED-proven against the pre-fix code; CR-9 ALSO surfaced + fixed the same hole on the single-run-by-id load (Finder C only flagged the list). Gates: server 1488/1-skip/0, shared 63/0, web 762/8-skip/0, tsc ×3 clean.**
> The dominant root: **the `canSeeWorkspace` TRAVERSE clause (new in `access.ts`) makes a project-only invitee reach the workspace shell, but the per-user project narrowing (fix #2) was applied to exactly ONE surface (`/events`) and ONE auth method (session).** Every other workspace-scoped read surface, and the human-PAT path on `/events`, now leaks cross-project data to a project-only invitee. These are real widenings of the 3 boundaries the spec keeps REAL (§8.1). **(All closed — see the ✅ line above; status notes inline below.)**
> - **CR-6 (BLOCKER — `grantOwner` never sets `users.role`):** `grantOwner` (system-workspace.ts:444) inserts only a `memberships(__system, owner)` row; `requireInstanceAdmin`/`requireInstanceOwner` were refactored THIS branch to read `users.role` (default `'member'`). On a **fresh install** (register-as-first-user at auth.ts:68 omits `role`, OR boot `designateInstanceOwner`→`grantOwner`), the designated owner has `users.role='member'` → 403 on EVERY instance-admin surface; the only `users.role='owner'` writer (`PATCH /instance/users/:id/role`) is itself owner-gated → instance is **un-administrable from boot**. Migration 0026 fixes only UPGRADED instances, not fresh ones. Masked in tests because harness.ts:112 sets `users.role='owner'` directly. **Fix:** `grantOwner` (and/or register-first-user) must set `users.role='owner'`. Entangled with CR-4 + Task 19 (owner-designation reconciliation). [Phase-3 BLOCKER — pull the `users.role` write forward from Task 19, or fix in a Phase-3 patch before more building]
> - **CR-7 (BLOCKER — `/events` human-PAT bypass):** the per-user `userVisibleProjects` narrowing is gated `if (user && token === null)` (events.ts:112) → SESSION-only; the agent allow-list is gated `if (token?.agentId)` (events.ts:69). A **human PAT** (token≠null, agentId=null) skips BOTH → both filters null → every project's events delivered. A project-only invitee can mint a workspace-pinned PAT (`POST /w/:wslug/tokens`, gated only by `canSeeWorkspace` which they pass via traverse). **Fix:** compute `userVisibleProjects` for human-PAT callers too (token present, agentId null), not just sessions. [Phase-3 fix — §8.1 token-reach + traverse]
> - **CR-8 (BLOCKER — `/events` workspace-level `projectId=null` rows un-narrowed):** both replay (events.ts:183) and live (events.ts:280) filters only drop rows where `projectId !== null`; null-projectId rows fall through to `isAgentEventVisible`, which returns `true` for ALL session callers (agentId null). So a project-only session invitee receives every workspace-level event: `access.granted`/`access.revoked` (the **grant roster** — other users' ids + resources), agent doc create/update, `activity.logged`, `workspace.updated`. The plan's "workspace-level rows follow the agent-subject rule" is hollow — that rule is a no-op for humans. **Fix:** gate null-projectId rows for session/PAT humans on a real visibility predicate (owner/ws-grant see all; project-only invitee sees only workspace-level rows whose subject they can see, or none). [Phase-3 fix — §8.1 grant-visibility; existing fix#2 test at events-route.test.ts:819 does NOT cover this]
> - **CR-9 (BLOCKER — `runs.ts` ws-scoped list leaks cross-project runs):** `runsRoute.get('/')` (under wScope) narrows ONLY by `resolveAgentAllowList` (null for session+PAT) — NO `canSeeProject`/`userVisibleProjects`. The traverse clause (new) makes a project-only invitee reach it; the project-scoped twin (under pScope→`canSeeProject`) is protected, the ws-scoped one is not. Leaks run titles/agent-slugs/status across all projects in the ws. **Fix:** apply the same per-user project narrowing `/events` needs (CR-7/8) to the ws-scoped `listRuns` call — likely the shared `visibleProjectIds` helper below. [Phase-3 fix — same root as CR-7/8]
> - **CR-10 (cleanup/altitude — triplicated `visibleProjectIds` + N+1, the shared root-fix for CR-7/8/9):** the per-project `canSeeProject` loop is copy-pasted in `events.ts` (~116-124), `services/projects.ts` (~40-44), and `services/agent-runs.ts` (~200-208) — each an N+1 (canSeeProject re-runs `userRole` per row though the caller already knows the role), each reducible to ONE join query (the form `listWorkspaces` already uses). The "visible project set for a user in a ws" IS a convergence concern (it's the run ceiling, the SSE filter, AND the project list — 3 security surfaces) yet isn't converged. Also: `seesWholeWs = role==='owner' || hasWorkspaceAccess(...)` is inlined in events.ts + projects.ts (=`canManageWorkspace`, already in access.ts, not reused). **Fix:** add `visibleProjectIds(db, userId, workspaceId)` to access.ts (one set-based query); route events/projects/agent-runs/runs through it; reuse `canManageWorkspace` for the see-whole-ws short-circuit. This is the right-altitude fix that closes CR-7/8/9 at one convergence point. [Phase-3 — do this FIRST, then CR-7/8/9 fall out]
> - **CR-11 (`user.role.changed` leaks to a `__system`-project grantee — distinct from finding-6):** `user.role.changed` (projectId=null, `__system`-scoped) is delivered over SSE to any **non-admin** session holding a `project_access` grant to a `__system` project — `instance-access.ts` does NOT exclude `__system` as a grant target (only the invite-target *picker* hides it; a direct grant-by-id succeeds), so a library contributor can open `?workspace=__system` (traverse) and receive every promotion/demotion payload (an admin-only fact). Different from finding-6 (which is the teardown-500). **Fix options:** exclude `__system` from grantable resources; OR gate null-projectId admin-class event rows on instance-admin in the SSE filter (folds into CR-8's predicate); OR re-home the event off `__system`. [tie to CR-8 + Task 20 event re-home]
>
> **PLAN CORRECTION (discovered at Phase-2 gate, 2026-06-04): the live `memberships`-reader set was UNDER-ENUMERATED.** §8's sibling-sweep named these abstractly; the Phase-2 gate grep found a concrete cluster that MUST migrate before Phase 4 drops `memberships`. Added **Task 8.5** (below, Phase 2) to migrate them. The full live-reader set (excluding the transitional harness insert + the system-workspace.ts functions Phase 4 deletes): `services/workspaces.ts` (listWorkspaces + isSystemMember — handled by Task 9), `services/comments.ts` (loadWorkspaceMembers), `services/agent-runs.ts:163` (caller-role derivation), `routes/workspaces.ts` (create-seeds-membership + member-list), `routes/settings.ts` (3 per-workspace AI-key gates — this is the on-branch per-workspace AI-keys route, NOT the instance-AI route from the other branch). The Phase-4 drop test will FAIL if any of these still reads `memberships` — Task 8.5 + Task 9 must clear them all.

---

## Threat model (inherited from spec §7 — the /code-review convergence target)

This plan does NOT re-author the threat model; it inherits the spec's. Implementers verify their diff against these named mitigations, not free-form. Summary of what each phase must satisfy:

- **T-A (lost safety net):** every `WHERE workspace_id` classified isolation-vs-scoping; the 3 real boundaries pinned by §8.1 tests. (Phases 1–4.)
- **T-B (invitation attack surface):** grant routes session-only, role-gated, FK-validated; a `member` cannot self-grant; an `admin` cannot grant into something it can't enumerate. (Phase 3.)
- **T-C (agent over-reach, 3 paths):** project ceiling + caller-bounded authority hold on `handleTriggerFired` / assignment / `handleCommentMentioned` after the `__system` detour is gone. (Phase 4.)
- **T-D (token meaning):** `api_tokens.workspace_id` semantics re-derived; reach-null = instance, still `requireInstanceAdmin` to mint. (Phase 2–3.)
- **T-E (skill-trust forging):** `instance_skills.trusted` is a TYPED COLUMN; only `setSkillTrust` writes it; import/restore physically cannot. (Phase 4.)
- **T-F (privilege collapse in migration):** `users.role` sourced ONLY from `__system` role else `member`; per-ws owner/admin → `workspace_access`, NEVER instance-owner. (Phase 1.)

## Threat model — CR-6..CR-11 fix surface (the round-2 convergence target)

> Written 2026-06-04 for the CR-6..CR-11 fix work (Class C/D remediation). The round-2 `/code-review` already enumerated the attacks (6 CONFIRMED findings); this section converts each into a **code-checkable mitigation** and pins the out-of-scope boundary so the fix doesn't over-narrow. This is the convergence target for the fix-verification review: it verifies against the numbered mitigations, not free-form. Source was ground-truthed at authoring (access.ts, events.ts, agent-event-visibility.ts, runs.ts, instance-access.ts, system-workspace.ts). **Root cause:** the `canSeeWorkspace` TRAVERSE clause (access.ts:77-83) makes a project-only invitee reach the ws shell, but the fix#2 per-user narrowing was wired into ONE surface (`/events`) and ONE auth method (session). Every other ws-scoped read + the human-PAT/null-projectId paths leak cross-project data.

### What we're defending
- **Project-scoped data confidentiality**: a project-only invitee (a `project_access` grant to P1 in workspace B, NO `workspace_access`) must see ONLY P1's content. The leaking carriers are: SSE rows on `GET /w/:wslug/events` (`document.*`, `comment.*`, `agent.run.*`) and `agent_run` list rows on `GET /w/:wslug/runs` (titles, agent slugs, status).
- **The access-grant roster + instance role audit trail**: `access.granted`/`access.revoked` payloads (`{userId, workspaceId|projectId}` — who-was-granted-what) and `user.role.changed` payloads (`{userId, role, previousRole}` — who was promoted/demoted). Both emit at workspace-level (`projectId=null`) and are an instance-admin-only fact.
- **Instance administrability from boot**: the designated instance owner MUST be able to administer the instance on a FRESH install. The asset is `users.role='owner'` being set for the bootstrapped owner (the gate every admin surface reads).

### Who we're defending against
- **A project-only invitee (IN scope)** — the primary actor. Holds exactly one `project_access` grant, legitimately authenticated (session OR a workspace-pinned human PAT they can mint), and uses the traverse clause to reach ws-scoped read surfaces. Not malicious-by-assumption, but MUST be confined to their grant.
- **A non-admin `__system`-project grantee (IN scope)** — a library contributor granted `project_access` to a `__system` project; must NOT receive instance role-change events by traversing into `?workspace=__system`.
- **A fresh-install operator (IN scope, availability)** — the boot/register path must leave the owner administrable, not locked out.
- **Owner / instance admin (OUT of scope)** — they legitimately see everything (owner) or are explicitly grant-bounded for content but trusted for administration (admin). We do not defend against them.
- **External attacker with no account (OUT of scope here)** — covered by the existing session/bearer auth; this fix doesn't change that surface.

### Attacks to defend against
1. **Boot lockout (CR-6)**: `grantOwner` (system-workspace.ts:444) inserts only a `memberships(__system, owner)` row; `requireInstanceAdmin`/`requireInstanceOwner` read `users.role` (default `'member'`). Fresh install → designated owner has `users.role='member'` → 403 on every instance-admin surface; the only `users.role` writer (`PATCH /instance/users/:id/role`) is itself owner-gated → un-administrable. The register-first-user path (auth.ts:68 inserts a user with no `role`) has the identical hole.
2. **`/events` human-PAT bypass (CR-7)**: the per-user narrowing is gated `if (user && token === null)` (events.ts:112) → session-only; the agent allow-list is gated `if (token?.agentId)` (events.ts:69). A human PAT (token≠null, agentId=null) skips BOTH → both filters null → every project's events delivered. The PAT is mintable by a project-only invitee (`POST /w/:wslug/tokens`, gated only by `canSeeWorkspace` → traverse passes).
3. **`/events` workspace-level (projectId=null) leak (CR-8)**: replay (events.ts:183) + live (events.ts:280) narrowing only drops rows where `projectId !== null`; null-projectId rows fall to `isAgentEventVisible`, which returns `true` for ALL non-agent callers (agent-event-visibility.ts:72). A project-only session invitee receives the grant roster + agent-doc + activity + ws-lifecycle rows.
4. **`runs.ts` ws-scoped list leak (CR-9)**: `runsRoute.get('/')` (runs.ts) narrows only by `resolveAgentAllowList` (null for session+PAT) — no per-user project narrowing. Traverse makes it reachable; the project-scoped twin (under pScope→`canSeeProject`) is protected, this one isn't.
5. **Role-change SSE leak to a `__system` grantee (CR-11)**: `user.role.changed` (projectId=null, `__system`-scoped) reaches any non-admin holding `project_access` to a `__system` project — `instance-access.ts` doesn't exclude `__system` as a grant target (only the invite-target *picker* hides it; a direct grant-by-id succeeds), and the null-projectId path (attack 3) delivers it.
6. **Drift re-leak via triplication (CR-10, the systemic one)**: the "visible project set for a user in a ws" is hand-rolled in 3 places (events.ts, services/projects.ts, services/agent-runs.ts), each an N+1. It IS the run ceiling + SSE filter + project list — 3 security surfaces — yet isn't converged. A future fix to one silently leaves the other two on old semantics → a visibility leak, not just a list bug.

### Mitigations required (numbered to match attacks)
1. **CR-6 — owner gets `users.role='owner'` on every fresh-owner path.** `grantOwner` (system-workspace.ts) sets `users.role='owner'` for the resolved user (alongside/instead of the legacy membership insert — pulling the Task-19 reconciliation forward is acceptable and preferred). The register-first-user path (auth.ts) must also set `role:'owner'` for the bootstrap user. **Checkable:** a NON-harness test that drives the real boot path (`runBootTasks` with `FOLIO_INSTANCE_OWNER` set, OR register-as-first-user) and asserts `userRole(db, owner) === 'owner'` AND that `requireInstanceOwner(db, owner)` resolves — NOT the harness shortcut (harness.ts:112 sets role directly and masks this; the test must exercise grantOwner/register).
2. **CR-7 — `userVisibleProjects` computed for human-PAT callers too.** Drop the `token === null` gate at events.ts:112; compute the per-user visible set whenever the principal is a HUMAN (session OR a token with `agentId === null`), keyed on the hydrated `c.get('user')`. Agent tokens (`token.agentId != null`) stay on the F3 allow-list path (unchanged). **Checkable:** a test where a project-only invitee mints a ws-pinned PAT and subscribes — asserts they receive P1 events and ZERO P2 events (the existing session-only test extended to the PAT path).
3. **CR-8 — null-projectId rows narrowed for a project-only human.** A human who is NOT `seesWholeWs` (not owner, no `workspace_access`) must be treated as a narrowed principal for workspace-level rows: such rows are delivered ONLY when the subject is one they can see, else dropped. Implement at the RIGHT ALTITUDE — extend the ONE visibility predicate, not a bolted-on second filter. Options (pick the one that converges with CR-11): (a) pass a "human is whole-ws?" flag into `isAgentEventVisible` so a non-whole-ws human is subject to the same subject-narrowing as a narrowed agent for null-projectId rows; OR (b) a sibling predicate `isWorkspaceEventVisibleToHuman` applied in both replay+live for non-`seesWholeWs` humans. Either way, `access.granted`/`access.revoked`/`user.role.changed`/`workspace.*` rows MUST NOT reach a project-only invitee. **Checkable:** a test — project-only invitee subscribes, an admin grants someone ELSE access (emits `access.granted`, projectId=null) and an owner changes a role (emits `user.role.changed`) → the invitee's stream receives NEITHER; a whole-ws grant holder DOES.
4. **CR-9 — ws-scoped runs list narrows by the same per-user visible set.** `runsRoute.get('/')` computes the caller's `visibleProjectIds` (mitigation 6's helper) for a non-whole-ws human and passes it to `listRuns` so cross-project runs are excluded (the same narrowing `/events` gets). Owner/whole-ws → unrestricted (null). **Checkable:** a test — project-only invitee `GET /w/:wslug/runs` returns only P1 runs, not P2's; positive control: a whole-ws grant holder sees both.
5. **CR-11 — converged with mitigation 3** (the null-projectId narrowing stops the role-change leak to a `__system` grantee). ADDITIONALLY, as defense-in-depth, `instance-access.ts`'s `resolveGrant` SHOULD reject a `__system` workspace/project as a grant target (mirror the invite-target picker exclusion at the write path, not just the read), so a `__system` `project_access` grant can't be minted by id in the first place. **Checkable:** a test — a direct `POST /instance/access {userId, projectId:<__system project id>}` is rejected (400/404), AND (belt-and-suspenders) even if such a grant existed, the CR-8 narrowing drops `user.role.changed` for that grantee.
6. **CR-10 — one `visibleProjectIds(db, userId, workspaceId)` helper in access.ts; 3 callers route through it.** Add the helper as ONE set-based query (the form `listWorkspaces` already uses: select `project_access`-join-`projects` ids where the user is granted in this ws — owner/whole-ws short-circuit handled by the caller via `canManageWorkspace`, already in access.ts). Replace the N+1 `canSeeProject` loops in events.ts (~116-124), services/projects.ts (~40-44), services/agent-runs.ts (~200-208) with it. Reuse `canManageWorkspace` for the `seesWholeWs` short-circuit (don't re-inline `role==='owner' || hasWorkspaceAccess`). This is the convergence-point fix that makes CR-7/8/9 a one-line "route this surface through the helper." **Checkable:** the loop is gone from all 3 sites (grep `canSeeProject` inside a `for`); `visibleProjectIds` has a unit test (owner→null/all, ws-grant→all, project-only→{granted ids}, no-access→∅).

### Out of scope (explicit deferrals — do NOT raise as findings)
- **`findSystemOwnerId` reading `memberships` (Finder E candidate)** — a SECOND owner source-of-truth that diverges from `users.role`. **Plan-deferred to Phase 4 Task 19** (owner-designation reconciliation, spec §4.4). CR-6 fixes the *administrability* hole (owner gets `users.role`); the `findSystemOwnerId` rewrite stays Phase 4. Acceptable interim: operator-created workspaces may be mis-owned on a post-PATCH instance until Phase 4 — accepted residual, tracked. (Do not re-fix here; it folds into Task 19's collapse.)
- **The live-delivery gap for a user's OWN just-granted access (Finder G minor)** — `userVisibleProjects` is snapshotted at stream-open, so a grant during an open stream isn't self-delivered until reconnect. Accepted UX residual (client reconciles via REST / reconnects); NOT a confidentiality leak. Out of scope for this fix.
- **DNS rebinding, master-key rotation, CSRF** — unrelated to this surface; covered (or deferred) by the spec's inherited threat model.
- **CR-4 + finding-6** — already tracked (CR-4 = roster display at Task 19; finding-6 = `user.role.changed` teardown-500 at Task 20). CR-11 is the LEAK consequence and is fixed here; the teardown re-home stays Task 20.

### How to use this section
- **Controller pre-flight:** before dispatching each CR fix, confirm the task's plan-supplied code names the mitigation above (helper signature, the narrowing gate, the boot-test shape).
- **Fix-verification review (`/code-review` / two-stage):** verify the diff against mitigations 1-6 by number. Report each as in-place / missing / out-of-scope-per-deferrals. CR-10's helper + the 3 routed call sites is the convergence anchor — if a surface still hand-rolls the visible set, that's a finding.
- **`/shakeout` (Stage 3):** the `invariant-auditor` checks inv 4 (authz) routes through `access.ts`/`visibleProjectIds`; `security-sentinel` checks the 3 real boundaries (§8.1) hold for BOTH session and human-PAT principals. The mandatory §8.1 events traverse-leak test must now cover null-projectId rows + the PAT path (the existing test covered only session sibling-project).
- **Downstream (Phase 4):** inherit, don't re-litigate. Task 19 collapses `findSystemOwnerId` onto `users.role` (CR-6 already set the column); Task 20 re-homes `user.role.changed` off `__system` (CR-11 already stopped the leak).

## Architecture invariants touched (spec §6)

1 (identity), 4 (HTTP authz), 7 (token ceiling), 11 (skill trust) are rewritten — route through the convergence point. 10 (data-before-tables) has a **deliberate justified exception** for the two access join-tables (relational, not document attributes) — record it in `ARCHITECTURE-INVARIANTS.md` in Phase 6. 2/3/8 touched at edges (agent resolution, event scope).

---

## File structure (what each file is responsible for)

**New files:**
- `apps/server/src/lib/access.ts` — the access convergence point: `canSeeWorkspace`, `canSeeProject`, `hasWorkspaceAccess`, `hasProjectAccess`, `userRole`. Single source for the visibility rules (spec §3). Every route/service reads these, never re-derives.
- `apps/server/src/lib/instance-skills.ts` — `instance_skills` loader/seeder: `seedInstanceSkills(db)`, `getInstanceSkill(db, name)`. Replaces the `__system` Skills-project read in `loadAgentDefinition`.
- `apps/server/src/lib/operator.ts` — the operator runtime singleton: `OPERATOR_SLUG`, `isOperator(slug)`, `getOperatorDefinition()` (returns prompt/tools from constants). The unspoofable predicate (spec §4.5): resolve-from-code, never a `documents` row.
- `apps/server/src/routes/instance-access.ts` — invitation routes (grant/revoke `workspace_access` + `project_access`), session-only + `requireInstanceAdmin`.
- `apps/server/src/routes/instance-users.ts` — instance role management (`PATCH …/users/:id/role`), session-only + **owner-only**; plus the invite-target enumeration endpoint (names+ids, owner+admin).
- Migrations (authored across phases, drop LAST): `00XX_add_user_role.sql`, `00XX_workspace_access.sql`, `00XX_project_access.sql`, `00XX_instance_skills.sql`, `00XX_backfill_roles_and_access.sql`, `00XX_drop_system_workspace.sql`, `00XX_drop_memberships.sql`.

**Modified (high-fan-out — call out in dispatch):**
- `apps/server/src/db/schema.ts` — add `users.role`, `workspace_access`, `project_access`, `instance_skills.trusted` column; (memberships removed last).
- `apps/server/src/test/harness.ts` — **seeds `memberships` today (lines 101-105); MUST migrate to `users.role` + `workspace_access`.** Touched before the drop or the whole suite breaks.
- `apps/server/src/middleware/scope.ts` — `resolveWorkspace`/`resolveProject` → access-based.
- `apps/server/src/middleware/auth.ts` + `bearer.ts` — `requireInstanceAdmin` (+ new owner-only gate); `roleToScopes` source.
- `apps/server/src/lib/system-workspace.ts` — DEAD deletions + REWORK rehoming (spec §4.4).
- `apps/server/src/lib/runner.ts`, `lib/trigger-matcher.ts` — collapse `resolveAgentForRun`; operator branch; skill load from `instance_skills`.
- `apps/server/src/routes/events.ts` — add per-user `canSeeProject` narrowing (replay line ~137 + live ~225).
- `apps/server/src/routes/{tokens,auth,workspaces,workspace-documents}.ts`, `services/{workspaces,projects,documents}.ts` — visibility filters; `/me` signals.
- `apps/web/src/...` — instance Settings (roles + invitations), remove per-ws role UI + library badge, point cockpit-chat at the operator singleton.

---

## Pre-flight (do once, before Task 1)

- [ ] **Branch off main, not the current branch.** The spec sits on `spec/instance-ai-config` (unmerged). Per branch-hygiene: `git checkout main && git pull && git checkout -b spec/drop-workspace-tenancy`. Verify HEAD before the first commit (the auto-memory hook can move HEAD back to main mid-session — re-check before every commit).
- [ ] **One-time:** confirm `./scripts/hooks/install.sh` ran (migration-journal pre-commit check).
- [ ] **Baseline green:** `cd apps/server && bun test` (expect ~1011 pass), `cd packages/shared && bun test` (63), `cd apps/web && npx vitest run`. Record the counts; every phase asserts a delta from here.

---

## Phase 1 — EXPAND: additive schema + backfill (NO drops)

> Goal: `users.role`, `workspace_access`, `project_access`, `instance_skills` exist and are backfilled from `memberships`. **`memberships` STAYS** (live code still reads it). Suite stays green because nothing yet reads the new columns and nothing is dropped.
>
> **Integration gate (phase close):** full server suite green; new tables present; backfill test proves T-F (no per-ws owner → instance-owner).

### Task 1: Add `users.role` column (schema + migration)

**Files:**
- Modify: `apps/server/src/db/schema.ts:25-33` (users table)
- Create: `apps/server/src/db/migrations/00XX_add_user_role.sql` (next number after 0023)
- Modify: `apps/server/src/db/migrations/meta/_journal.json` (add the entry — `migrate()` SKIPS files not in the journal)
- Test: `apps/server/src/db/migrations/00XX_add_user_role.test.ts`

- [ ] **Step 1: Write the failing test** — assert the column exists with default 'member'.

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../schema.ts';

describe('migration: add users.role', () => {
  test('users has a role column defaulting to member', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(import.meta.dir, '.') });
    const cols = sqlite.query(`PRAGMA table_info('users')`).all() as Array<{ name: string; dflt_value: string | null }>;
    const role = cols.find((c) => c.name === 'role');
    expect(role).toBeDefined();
    expect(role?.dflt_value).toContain('member');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd apps/server && bun test src/db/migrations/00XX_add_user_role.test.ts` → FAIL (no `role` column).

- [ ] **Step 3: Add the column to the schema.** In `schema.ts` users table, after `name`:

```ts
  role: text('role', { enum: ['owner', 'admin', 'member'] })
    .notNull()
    .default('member'),
```

- [ ] **Step 4: Generate the migration.** `cd apps/server && bun run db:generate` (root script also works). Confirm a new `00XX_*.sql` appeared AND `_journal.json` gained its entry. If `db:generate` names it oddly, rename to `00XX_add_user_role.sql` and fix the journal `tag` to match.

- [ ] **Step 5: Run it, verify it passes** — same command → PASS.

- [ ] **Step 6: Typecheck + commit.** `bun x tsc --noEmit` (clean), then:

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-1: add users.role column"
```

### Task 2: Add `workspace_access` + `project_access` tables

**Files:**
- Modify: `apps/server/src/db/schema.ts` (add two tables after `memberships`)
- Create migration + journal entry (via `db:generate`)
- Test: `apps/server/src/db/migrations/00XX_access_tables.test.ts`

- [ ] **Step 1: Failing test** — both tables exist with composite PKs.

```ts
test('workspace_access and project_access exist with composite PKs', () => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: resolve(import.meta.dir, '.') });
  const wa = sqlite.query(`PRAGMA table_info('workspace_access')`).all() as Array<{ name: string; pk: number }>;
  const pa = sqlite.query(`PRAGMA table_info('project_access')`).all() as Array<{ name: string; pk: number }>;
  expect(wa.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['user_id', 'workspace_id']);
  expect(pa.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['project_id', 'user_id']);
});
```

- [ ] **Step 2: Run, verify fail** → FAIL (no tables).

- [ ] **Step 3: Add the tables** to `schema.ts` (mirror the `memberships` idiom — composite PK + reverse-lookup index on the non-leading column):

```ts
export const workspaceAccess = sqliteTable(
  'workspace_access',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.workspaceId] }),
    // reverse lookup: "who is in this workspace" filters by workspaceId (non-leading)
    wsIdx: index('workspace_access_ws_idx').on(t.workspaceId),
  }),
);

export const projectAccess = sqliteTable(
  'project_access',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.projectId] }),
    projIdx: index('project_access_proj_idx').on(t.projectId),
  }),
);
```

- [ ] **Step 4: Generate migration + journal.** `bun run db:generate`; confirm `_journal.json` updated.

- [ ] **Step 5: Run, verify pass** → PASS.

- [ ] **Step 6: Typecheck + commit.**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-1: add workspace_access + project_access tables"
```

### Task 3: Add `instance_skills` table with TYPED `trusted` column

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create migration + journal entry
- Test: `apps/server/src/db/migrations/00XX_instance_skills.test.ts`

> **SECURITY (spec §4.1 / T-E):** `trusted` MUST be a typed column, NOT a frontmatter key. This is what makes forging structurally impossible (import/restore write body+frontmatter, cannot reach `trusted`). Do NOT put trust in the JSON blob.

- [ ] **Step 1: Failing test** — table exists; `trusted` is its own column defaulting to 0.

```ts
test('instance_skills has a typed trusted column default 0', () => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: resolve(import.meta.dir, '.') });
  const cols = sqlite.query(`PRAGMA table_info('instance_skills')`).all() as Array<{ name: string; dflt_value: string | null }>;
  const trusted = cols.find((c) => c.name === 'trusted');
  expect(trusted).toBeDefined();           // a real column, not buried in frontmatter json
  expect(trusted?.dflt_value).toBe('0');
  expect(cols.find((c) => c.name === 'name')).toBeDefined();
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add the table:**

```ts
export const instanceSkills = sqliteTable(
  'instance_skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    frontmatter: text('frontmatter', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    // T-E: typed column — only setSkillTrust writes it; import/restore cannot reach it.
    trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ nameIdx: uniqueIndex('instance_skills_name_idx').on(t.name) }),
);
```

- [ ] **Step 4: Generate migration + journal.** `bun run db:generate`. (Note: `mode: 'boolean'` stores as integer 0/1; the PRAGMA default reads as `'0'`.)

- [ ] **Step 5: Run, verify pass.**

- [ ] **Step 6: Typecheck + commit.**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations/
git commit -m "phase-1: add instance_skills table with typed trusted column"
```

### Task 4: Backfill migration — roles + access from memberships (the T-F-critical one)

**Files:**
- Create: `apps/server/src/db/migrations/00XX_backfill_roles_and_access.sql` (hand-written data migration — `db:generate` won't author data moves)
- Modify: `_journal.json`
- Test: `apps/server/src/db/migrations/00XX_backfill_roles_and_access.test.ts`

> **THE PRIVILEGE-ESCALATION GUARD (T-F).** `users.role` ← the user's `__system` role if any, ELSE `member`. A per-workspace `owner`/`admin` becomes a `workspace_access` grant, NEVER instance-owner. Sourcing from "highest role across all workspaces" would silently escalate. The migration must run BEFORE `memberships` is dropped (it reads it) and AFTER the system workspace slug is known.

- [ ] **Step 1: Write the failing test** — seed memberships under the OLD model, run the backfill SQL against the pre-seeded DB, assert the corrected mapping. Use the `drizzle migrate() is idempotent` pattern: run the migrator once, then `sqlite.exec(readFileSync(<this migration>))` after seeding to test UPDATEs against pre-seeded rows. **Split the file on `--> statement-breakpoint` and exec each statement** — `sqlite.exec(wholeFile)` silently no-ops guarded multi-statement files (per memory `feedback_bun-sqlite-exec-no-ops-migration-guard`).

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Apply every migration EXCEPT the backfill, seed old-model rows, then run the
// backfill SQL statement-by-statement and assert the mapping.
function execMigrationByStatements(sqlite: Database, file: string) {
  const sql = readFileSync(file, 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}

describe('backfill: roles + access (T-F)', () => {
  test('a per-workspace owner does NOT become instance-owner; __system owner does', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    // ... apply schema up to (not incl) the backfill via the migrator or a fixed snapshot ...
    // Seed: system workspace '__system'; ws 'galleries'; users bob (owner of galleries only),
    // sys (owner of __system). Insert memberships rows accordingly.
    // (exact seed SQL spelled out in the real task — uses the __system slug constant.)
    execMigrationByStatements(sqlite, resolve(import.meta.dir, '00XX_backfill_roles_and_access.sql'));

    const bob = sqlite.query(`SELECT role FROM users WHERE email='bob@test.local'`).get() as { role: string };
    const sys = sqlite.query(`SELECT role FROM users WHERE email='sys@test.local'`).get() as { role: string };
    expect(bob.role).toBe('member');   // per-ws owner -> instance member (NOT owner)
    expect(sys.role).toBe('owner');    // __system owner -> instance owner

    const bobGrant = sqlite.query(
      `SELECT 1 FROM workspace_access wa JOIN workspaces w ON w.id=wa.workspace_id
       JOIN users u ON u.id=wa.user_id WHERE u.email='bob@test.local' AND w.slug='galleries'`
    ).get();
    expect(bobGrant).toBeTruthy();     // folder authority became a plain access grant

    // __system membership must NOT become a workspace_access grant (it's being deleted)
    const sysSysGrant = sqlite.query(
      `SELECT 1 FROM workspace_access wa JOIN workspaces w ON w.id=wa.workspace_id
       JOIN users u ON u.id=wa.user_id WHERE u.email='sys@test.local' AND w.slug='__system'`
    ).get();
    expect(sysSysGrant).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run, verify fail** (no backfill file yet) → FAIL.

- [ ] **Step 3: Write the backfill SQL.** Statement-broken, journal-registered. The `__system` slug is `'__system'` (constant `SYSTEM_WORKSPACE_SLUG`). NOTE: `UPDATE … FROM` is supported in modern SQLite (bun:sqlite); if the runtime balks, use a correlated subquery form.

```sql
-- users.role <- __system role if any, else leave default 'member'
UPDATE users SET role = (
  SELECT m.role FROM memberships m
  JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = users.id AND w.slug = '__system'
)
WHERE EXISTS (
  SELECT 1 FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = users.id AND w.slug = '__system'
);
--> statement-breakpoint
-- per-workspace memberships (NON-__system) become workspace_access grants
INSERT OR IGNORE INTO workspace_access (user_id, workspace_id, created_at)
SELECT m.user_id, m.workspace_id, (unixepoch() * 1000)
FROM memberships m
JOIN workspaces w ON w.id = m.workspace_id
WHERE w.slug <> '__system';
```

- [ ] **Step 4: Register in `_journal.json`** (hand-add the entry; data migrations aren't produced by `db:generate`). Tag must match the filename.

- [ ] **Step 5: Run, verify pass** → PASS (bob=member+grant, sys=owner, no __system grant).

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/db/migrations/
git commit -m "phase-1: backfill users.role + workspace_access from memberships (T-F guard)"
```

### Task 5: Migrate the test harness off `memberships` (UNBLOCKS the whole suite)

**Files:**
- Modify: `apps/server/src/test/harness.ts:101-105` (the `memberships` seed)

> Today `makeTestApp` seeds `schema.memberships` with `role:'owner'`. Every server test depends on this. When `memberships` is dropped (Phase 4) this breaks unless migrated now. Move it to the new model so the harness seeds an owner via `users.role` + a `workspace_access` grant — keeping existing tests' "Alice can see Acme/Web" assumption true.

- [ ] **Step 1: Update the seed.** Replace lines 101-105:

```ts
  // OLD: await db.insert(schema.memberships).values({ workspaceId, userId, role: 'owner' });
  // NEW: instance role on the user + workspace access grant (post-tenancy model)
  await db.update(schema.users).set({ role: 'owner' }).where(eq(schema.users.id, userId));
  await db.insert(schema.workspaceAccess).values({ userId, workspaceId });
```

(Owner sees everything anyway, but seed the grant too so non-owner test variants can branch off this harness.)

- [ ] **Step 2: Run the full server suite** — `cd apps/server && bun test`. **Expected: still green** (Alice is now instance-owner with a grant; `resolveWorkspace` still reads `memberships` at this point, and `memberships` still EXISTS, but the harness no longer seeds it — so any test that relied on the seeded membership row will fail HERE if the auth code hasn't migrated yet). 

> **Sequencing note:** because `resolveWorkspace` still reads `memberships` until Phase 2, this task may turn some tests red (they lose their membership row). That is expected and is the trigger to do Phase 2 next — do NOT add a compensating `memberships` insert. If too many tests break to bisect cleanly, split: keep BOTH the new grant AND a transitional `memberships` insert in the harness through Phase 2, then remove the `memberships` insert at the start of Phase 2 Task 6. Decide based on the red count; document the choice in the commit.

- [ ] **Step 3: Typecheck + commit.**

```bash
git add apps/server/src/test/harness.ts
git commit -m "phase-1: migrate test harness seed to users.role + workspace_access"
```

**Phase 1 integration gate:** run `/integration` (or: server suite + shared suite + tsc per-app). The backfill T-F test is the load-bearing assertion. Proceed to Phase 2 only when the new tables exist and the backfill mapping is proven correct.

---

## Phase 2 — Auth/scope rewrite (migrate READS off memberships)

> Goal: every *read* of `memberships` is replaced by `users.role` (role) + the new access helpers (visibility). `memberships` still EXISTS (dropped in Phase 4) but nothing reads it after this phase. Rewrites invariants 1/4/7 — route through the convergence points, do not hand-roll.
>
> **Sibling-site rule:** grep `db.query.memberships` / `memberships.findFirst` / `from(memberships)` / `memberships` import across ALL of `apps/server` before declaring this phase done. Each hit is either a role read (→ `users.role`) or an access read (→ `access.ts`). Zero may remain.
>
> **Integration gate:** server suite green; `grep -rn "memberships" apps/server/src --include=*.ts | grep -v "\.test\." | grep -v "schema.ts" | grep -v migrations` returns only the (soon-to-be-deleted) backfill references, no live reads.

### Task 6: Create the access convergence point (`lib/access.ts`)

**Files:**
- Create: `apps/server/src/lib/access.ts`
- Test: `apps/server/src/lib/access.test.ts`

> Single source for spec §3 visibility rules. `canSeeWorkspace` MUST include the 3rd clause (project-access traverse) or project-only invitees 403 at `resolveWorkspace` (spec #3). `listProjects`/`/events` will gate on `canSeeProject` per item (not this) — see Phases 2/3.

- [ ] **Step 1: Failing test** — the rules table from spec §3.

```ts
import { describe, expect, test } from 'bun:test';
import { makeBareTestDb } from '../test/harness.ts';
import { canSeeWorkspace, canSeeProject } from './access.ts';
import * as schema from '../db/schema.ts';
import { nanoid } from 'nanoid';

describe('access rules (spec §3)', () => {
  test('owner sees all; ws-grant sees ws+all projects; project-grant traverses ws but sees only that project', async () => {
    const { db } = await makeBareTestDb();
    const mk = async (email: string, role: 'owner'|'admin'|'member') => {
      const id = nanoid();
      await db.insert(schema.users).values({ id, email, name: email, role });
      return id;
    };
    const owner = await mk('o@t', 'owner');
    const wsUser = await mk('w@t', 'member');
    const projUser = await mk('p@t', 'member');
    const wsA = nanoid(); await db.insert(schema.workspaces).values({ id: wsA, slug: 'a', name: 'A' });
    const p1 = nanoid(); await db.insert(schema.projects).values({ id: p1, workspaceId: wsA, slug: 'p1', name: 'P1' });
    const p2 = nanoid(); await db.insert(schema.projects).values({ id: p2, workspaceId: wsA, slug: 'p2', name: 'P2' });
    await db.insert(schema.workspaceAccess).values({ userId: wsUser, workspaceId: wsA });
    await db.insert(schema.projectAccess).values({ userId: projUser, projectId: p1 });

    // owner: everything
    expect(await canSeeWorkspace(db, owner, wsA)).toBe(true);
    expect(await canSeeProject(db, owner, p2)).toBe(true);
    // ws-grant user: ws + both projects
    expect(await canSeeWorkspace(db, wsUser, wsA)).toBe(true);
    expect(await canSeeProject(db, wsUser, p1)).toBe(true);
    expect(await canSeeProject(db, wsUser, p2)).toBe(true);
    // project-only user: can TRAVERSE the ws (3rd clause) but sees only p1
    expect(await canSeeWorkspace(db, projUser, wsA)).toBe(true);   // traverse
    expect(await canSeeProject(db, projUser, p1)).toBe(true);
    expect(await canSeeProject(db, projUser, p2)).toBe(false);     // NOT p2
  });
});
```

- [ ] **Step 2: Run, verify fail** (no `access.ts`).

- [ ] **Step 3: Implement `access.ts`.** Pure functions over `db`; one query each.

```ts
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { users, workspaceAccess, projectAccess, projects } from '../db/schema.ts';

export type Role = 'owner' | 'admin' | 'member';

export async function userRole(db: DB, userId: string): Promise<Role> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return (u?.role as Role) ?? 'member';
}

export async function hasWorkspaceAccess(db: DB, userId: string, workspaceId: string): Promise<boolean> {
  const r = await db.query.workspaceAccess.findFirst({
    where: and(eq(workspaceAccess.userId, userId), eq(workspaceAccess.workspaceId, workspaceId)),
  });
  return !!r;
}

export async function hasProjectAccess(db: DB, userId: string, projectId: string): Promise<boolean> {
  const r = await db.query.projectAccess.findFirst({
    where: and(eq(projectAccess.userId, userId), eq(projectAccess.projectId, projectId)),
  });
  return !!r;
}

// canSeeWorkspace: owner || ws-grant || project-grant-to-some-project-in-this-ws (TRAVERSE)
export async function canSeeWorkspace(db: DB, userId: string, workspaceId: string): Promise<boolean> {
  if ((await userRole(db, userId)) === 'owner') return true;
  if (await hasWorkspaceAccess(db, userId, workspaceId)) return true;
  // traverse clause: any project_access row whose project is in this workspace
  const grant = await db
    .select({ id: projectAccess.projectId })
    .from(projectAccess)
    .innerJoin(projects, eq(projects.id, projectAccess.projectId))
    .where(and(eq(projectAccess.userId, userId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  return grant.length > 0;
}

// canSeeProject: owner || ws-grant on parent || direct project-grant
export async function canSeeProject(db: DB, userId: string, projectId: string): Promise<boolean> {
  if ((await userRole(db, userId)) === 'owner') return true;
  if (await hasProjectAccess(db, userId, projectId)) return true;
  const proj = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!proj) return false;
  return hasWorkspaceAccess(db, userId, proj.workspaceId);
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.**

```bash
git add apps/server/src/lib/access.ts apps/server/src/lib/access.test.ts
git commit -m "phase-2: access convergence point (canSeeWorkspace/Project, traverse clause)"
```

### Task 7: Rewrite `resolveWorkspace` + `resolveProject` (scope.ts)

**Files:**
- Modify: `apps/server/src/middleware/scope.ts:21-100`
- Test: `apps/server/src/middleware/scope.test.ts` (rewrite the membership-based cases)

> Replace the `memberships` lookup. `role` ← `users.role`; access ← `canSeeWorkspace`/`canSeeProject`. Keep the instance-reach token bypass (`isInstanceReach` → role 'owner'). `resolveProject` must enforce `canSeeProject` (today it only checks `project.workspace_id == ws.id`).

- [ ] **Step 1: Update the scope.test.ts expectations first** (TDD on behavior): a `member` with `workspace_access` to A passes; one without 403s; a `project_access`-only user passes `resolveWorkspace` (traverse) but 403s in `resolveProject` on a non-granted project. (Spell out the cases using `makeTestApp` + extra seeded users.)

- [ ] **Step 2: Run, verify fail** (old code reads memberships).

- [ ] **Step 3: Rewrite `resolveWorkspace`** (scope.ts:21-59). Replace the membership block:

```ts
import { canSeeWorkspace, canSeeProject, userRole } from '../lib/access.ts';
// ...
  if (token && isInstanceReach(token)) {
    c.set('role', 'owner');
  } else {
    const role = await userRole(db, user.id);
    if (role !== 'owner' && !(await canSeeWorkspace(db, user.id, ws.id))) {
      throw new HTTPError('FORBIDDEN', 'no access to this workspace', 403);
    }
    c.set('role', role);
  }
  c.set('workspace', ws);
  return next();
```

- [ ] **Step 4: Rewrite `resolveProject`** (scope.ts:61-87) — after resolving the project, gate it:

```ts
  // post-tenancy: enforce per-project visibility (owner || ws-grant || project-grant)
  const role = c.get('role');
  if (role !== 'owner') {
    const user = getUser(c);
    if (!(await canSeeProject(db, user.id, p.id))) {
      throw new HTTPError('PROJECT_NOT_FOUND', `project "${pslug}" not found`, 404);
    }
  }
```

(404 not 403 on a project the user can't see — don't leak existence to a non-grantee at the content layer. The traverse clause already let them reach the ws shell; an ungranted project reads as not-found.)

- [ ] **Step 5: Run, verify pass.**

- [ ] **Step 6: Typecheck + commit.**

```bash
git add apps/server/src/middleware/scope.ts apps/server/src/middleware/scope.test.ts
git commit -m "phase-2: resolveWorkspace/resolveProject use access grants, not memberships"
```

### Task 8: Rewrite `requireInstanceAdmin` + add owner-only gate; fix `roleToScopes` source

**Files:**
- Modify: `apps/server/src/lib/system-workspace.ts:271-344` (`requireInstanceAdmin`, `getSystemRole`, `isInstanceAdmin`, `findSystemOwnerId`)
- Modify: `apps/server/src/middleware/auth.ts` or wherever a new `requireInstanceOwner` belongs (co-locate with `requireSessionUser`)
- Modify: `apps/server/src/routes/tokens.ts` (ceilingRole source)
- Test: `apps/server/src/lib/instance-admin.test.ts` (new) + update `tokens` tests

> `requireInstanceAdmin` stops querying `__system` membership; reads `users.role ∈ {owner,admin}`. Add `requireInstanceOwner` (owner only) for the role-change route (OQ-3). `roleToScopes` logic unchanged; input becomes `users.role`.

- [ ] **Step 1: Failing test** — `requireInstanceAdmin` passes for owner+admin, 403 for member; `requireInstanceOwner` passes only for owner.

```ts
test('instance admin gate reads users.role', async () => {
  const { db } = await makeBareTestDb();
  const mk = async (role: 'owner'|'admin'|'member') => {
    const id = nanoid(); await db.insert(schema.users).values({ id, email: `${role}@t`, name: role, role }); return id;
  };
  const o = await mk('owner'), a = await mk('admin'), m = await mk('member');
  await expect(requireInstanceAdmin(db, o)).resolves.toBe('owner');
  await expect(requireInstanceAdmin(db, a)).resolves.toBe('admin');
  await expect(requireInstanceAdmin(db, m)).rejects.toThrow();   // 403
  await expect(requireInstanceOwner(db, a)).rejects.toThrow();   // admin can't
  await expect(requireInstanceOwner(db, o)).resolves.toBe('owner');
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Rewrite the gates.** `requireInstanceAdmin` (system-workspace.ts:271-298):

```ts
export async function requireInstanceAdmin(db: DB, userId: string): Promise<'owner' | 'admin'> {
  const role = await userRole(db, userId);
  if (role !== 'owner' && role !== 'admin') {
    throw new HTTPError('FORBIDDEN', 'instance administration requires owner or admin', 403);
  }
  return role;
}

export async function requireInstanceOwner(db: DB, userId: string): Promise<'owner'> {
  const role = await userRole(db, userId);
  if (role !== 'owner') throw new HTTPError('FORBIDDEN', 'this action requires the instance owner', 403);
  return 'owner';
}
```

Update `getSystemRole`/`isInstanceAdmin`/`findSystemOwnerId` to read `users.role` (findSystemOwnerId → the single `users` row with `role='owner'`). These now live more naturally in `access.ts`; move them there if it reduces the `system-workspace.ts` surface (the file is largely DEAD after Phase 4).

- [ ] **Step 4: Fix `roleToScopes` callers** — in `tokens.ts`, `ceilingRole` comes from `userRole(db, user.id)` (not a membership row). The `roleToScopes` function itself (agent-schema.ts:113) is unchanged.

- [ ] **Step 5: Run, verify pass** (gate tests + token mint tests).

- [ ] **Step 6: Typecheck + commit.**

```bash
git add apps/server/src/lib/system-workspace.ts apps/server/src/middleware/auth.ts apps/server/src/routes/tokens.ts apps/server/src/lib/instance-admin.test.ts
git commit -m "phase-2: instance-admin/owner gates + token ceiling read users.role"
```

### Task 8.5: Migrate the remaining live `memberships` readers (the under-enumerated cluster)

**Files (each has a live `memberships` read that must move to the new model BEFORE Phase 4 drops the table):**
- `apps/server/src/services/comments.ts` (`loadWorkspaceMembers`) — "who's in this workspace" for @mention parsing → join `workspace_access` to `users` instead (a user can be @mentioned if they have access to the ws; owner sees all but isn't in `workspace_access` — for mention-resolution, listing grant-holders is correct; the operator/owner-mention path is handled elsewhere). Replace the `memberships` join with a `workspaceAccess` join.
- `apps/server/src/services/agent-runs.ts:163` (fresh-run caller-role derivation) — `const membership = ...memberships.findFirst(...); const callerRole = membership?.role` → `const callerRole = await userRole(db, actor.id)` (the caller's INSTANCE role now bounds run authority; this is the per-run caller ceiling). Verify the downstream `if (!callerRole)` deny-path still behaves (userRole never returns undefined — it defaults 'member'; so adapt the guard: a user with no access to the run's workspace should still be denied — gate on `canSeeWorkspace(db, actor.id, workspace.id)` before deriving the role, deny if they can't see it).
- `apps/server/src/routes/workspaces.ts:154` (create seeds a `memberships` owner row) → seed a `workspace_access(ownerUserId, id)` grant instead (the creator gets access to the workspace they made). The creator's instance role is separate (already on users.role). Keep it inside the same `txWithEvents`.
- `apps/server/src/routes/workspaces.ts:260` (workspace member list) → list `workspace_access` holders joined to `users` (+ their instance `users.role`).
- `apps/server/src/routes/settings.ts` (3 reads — the per-workspace AI-keys GET/POST/DELETE gates) → replace each `memberships.findFirst` + `if (!m) 403` with `canSeeWorkspace`; the POST/DELETE admin check (`m.role !== 'owner' && m.role !== 'admin'`) → `userRole(db, user.id)` admin check. (This is the on-branch per-workspace AI-keys route; it stays per-workspace on this branch.)

> NOTE: `services/workspaces.ts` (`listWorkspaces` + `isSystemMember`) is migrated by **Task 9**, not here — don't double-do it. `system-workspace.ts`'s `findSystemOwnerId`/`grantOwner`/`resolveAgentForRun`/provenance reads + the transitional `harness.ts` insert are **Phase 4** teardown — leave them.

**Approach:** TDD per site where behavior is testable (settings access gate, workspaces create→grant, agent-runs caller ceiling). For each: write/adjust a test proving the new-model behavior (a user with a grant passes; without, 403/denied; the run caller ceiling = instance role), watch it fail, migrate the read, watch it pass. Run the full server suite after each file; keep it green. Commit per file or as one cohesive commit `phase-2: migrate remaining live memberships readers to users.role + access`.

**Gate:** after this task, `grep -rn "memberships" apps/server/src --include=*.ts | grep -v "\.test\." | grep -v "/migrations/" | grep -v "system-workspace.ts" | grep -v "test/harness.ts" | grep -v "services/workspaces.ts"` returns NOTHING. (The remaining allowed refs: system-workspace.ts + harness.ts → Phase 4; services/workspaces.ts → Task 9.)

**Phase 2 integration gate:** server suite green; the live-`memberships`-read grep is clean except the Phase-4/Task-9 deferrals named above. The auth convergence points (1/4/7) now route through `users.role` + `access.ts`. Proceed to Phase 3.

---

## Phase 3 — Routes/services + invitation surface + MANDATORY boundary tests

> Goal: visibility filters on list endpoints; NEW invitation + role + enumeration routes; `/me` signals; AND the §8.1 boundary-regression tests for `/events` (project-granularity + traverse leak), token reach, and grant visibility. These tests are acceptance criteria, NOT follow-ups (T-A: the human eye no longer catches a widened boundary).
>
> **Integration gate:** server suite green; all §8.1 step-3 tests present and passing; the traverse-leak events test (the one the naive test misses) explicitly exercised.

### Task 9: `listWorkspaces` / `listProjects` filter by access

**Files:**
- Modify: `apps/server/src/services/workspaces.ts` (`listWorkspaces`)
- Modify: `apps/server/src/services/projects.ts` (`listProjects`)
- Test: update their service/route tests + add the visibility cases

> `listWorkspaces` = "workspaces I can open" (owner→all; else ws-grants + traversable shells). `listProjects` MUST filter by `canSeeProject` per item (NOT merely "in a ws I can reach") — else the traverse clause leaks the project list (spec #2/#3).

- [ ] **Step 1: Failing tests** —
  - a `member` with `workspace_access` to A but not B: A in `listWorkspaces`, B absent.
  - a `project_access`-only user (P1 in A): `listProjects(A)` returns ONLY P1, not P2.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** `listWorkspaces`: owner → all; else select workspaces where a `workspace_access` row exists OR a `project_access` row maps into them (union, deduped). `listProjects(wsId, userId)`: owner or ws-grant → all in ws; else filter to projects with a direct `project_access` row. Reuse `access.ts` helpers; do a set-based query, not N+1 (`inArray` on the granted ids).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-3: listWorkspaces/listProjects filter by access grants"`

### Task 10: `/events` — per-user project-granularity narrowing (FIX #2)

**Files:**
- Modify: `apps/server/src/routes/events.ts` (replay loop ~line 137; live subscriber ~line 225)
- Test: `apps/server/src/routes/events-access.integration.test.ts` (new)

> Today the filter narrows by AGENT allow-list (F3) but NOT by the calling human's project visibility — because membership = workspace-wide. Now a `project_access`-only user can traverse the ws and reach `/events`. Add a per-user `canSeeProject` narrowing alongside the existing agent narrowing, in BOTH paths. The naive "no grant → zero events" test PASSES TRIVIALLY for a project-only invitee (they have a grant) — the traverse-leak test below is the one that matters.

- [ ] **Step 1: Failing test — the traverse leak (§8.1 mandatory).**

```ts
// A user granted ONLY project P1 in workspace B subscribes to B's /events.
// They must receive P1 events and ZERO events from P2 (another project in B).
test('project-only invitee receives only their granted project events from /events', async () => {
  const { app, db, seed } = await makeTestApp();           // seed.user = owner of acme/web
  // create a second project P2 in the same workspace, and a member granted only `web`
  // (P1). Emit an event scoped to P2. Subscribe as the member. Assert no P2 event arrives,
  // a web(P1) event does.
  // (Drive the SSE stream via app.request with a short read window; assert the delivered ids.)
  // Exact event-emit uses txWithEvents / emitEvent to insert a project-scoped row.
});
```

- [ ] **Step 2: Run, verify fail** (P2 events leak to the project-only user today).

- [ ] **Step 3: Implement the per-user narrowing.** Resolve the caller's visible-project predicate once before `streamSSE` (session users only; agent tokens already handled by F3). Compute the set of project ids the user can see in this ws (or a `canSeeProject` check). Then:
  - **Replay loop (~line 137-141):** add, alongside the agent allow-list check:
    ```ts
    // per-user visibility: project-scoped rows must be visible to the calling human
    if (userVisibleProjects && row.projectId !== null && !userVisibleProjects.has(row.projectId)) continue;
    ```
  - **Live subscriber (~line 225-232):** mirror it:
    ```ts
    if (userVisibleProjects && e.projectId != null && !userVisibleProjects.has(e.projectId)) return;
    ```
  Workspace-level rows (`projectId === null`) follow the existing `isAgentEventVisible` subject rules — unchanged. `userVisibleProjects = null` for owner / ws-grant holders (unrestricted within the ws); a `Set<string>` for project-only invitees. Build it from `listProjects`-style access.

- [ ] **Step 4: Run, verify pass** + add the negative "no grant at all → 403/zero" case for completeness.

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-3: /events narrows by per-user project visibility (fix #2 traverse leak)"`

### Task 11: Invitation routes (`instance-access.ts`) — T-B

**Files:**
- Create: `apps/server/src/routes/instance-access.ts`
- Modify: `apps/server/src/app.ts` (mount under `/api/v1/instance/access`, session-only)
- Test: `apps/server/src/routes/instance-access.test.ts`

> Grant/revoke `workspace_access` + `project_access`. Session-only (`requireSessionUser`), `requireInstanceAdmin` (owner+admin per OQ-3). FK-validate the referenced user + resource. T-B: a `member` cannot reach this (403); a malformed/foreign resource id is rejected.

- [ ] **Step 1: Failing tests (T-B):**
  - owner grants ws-access to a member → 201, row exists.
  - admin grants project-access → 201 (admin CAN invite, OQ-3).
  - member calls grant → 403.
  - token (non-session) calls grant → 403 (session-only).
  - grant referencing a non-existent workspace/project/user → 404/400 (FK-validated, no dangling row).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** Zod body `{ userId, workspaceId? , projectId? }` (exactly one of ws/project). Validate referents exist. Insert with `onConflictDoNothing` (idempotent). Emit an event (invariant 5 — wrap in `txWithEvents`). DELETE mirror for revoke.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-3: invitation routes (workspace_access/project_access), session-only + admin-gated"`

### Task 12: Role-change route + invite-target enumeration (`instance-users.ts`) — OQ-3 + #5

**Files:**
- Create: `apps/server/src/routes/instance-users.ts`
- Modify: `apps/server/src/app.ts` (mount `/api/v1/instance/users`)
- Test: `apps/server/src/routes/instance-users.test.ts`

> `PATCH /instance/users/:id/role` — **owner-only** (`requireInstanceOwner`); admins 403 (OQ-3). `GET /instance/users` — list users+roles (admin+owner). `GET /instance/invite-targets` — workspace/project names+ids for the invite picker, owner+admin, regardless of grant (existence-vs-contents, #5) — returns NO documents/events.

- [ ] **Step 1: Failing tests:**
  - owner PATCHes a member→admin → 200; member is now admin.
  - admin PATCHes a role → 403 (only owner changes roles).
  - admin GETs invite-targets → 200 with all ws/project names (existence), even ungranted ones.
  - admin GETs invite-targets → response contains NO document/event payloads (contents stay gated).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** Role PATCH: `requireInstanceOwner`, Zod `{ role: 'owner'|'admin'|'member' }`, update `users.role`, `txWithEvents`. Guard: don't allow demoting the last owner (count owners; refuse if it would reach 0). invite-targets: `requireInstanceAdmin`, return `workspaces` + `projects` (id, slug, name, workspace_id) — a thin enumeration query, explicitly not the content list endpoints.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-3: role-change route (owner-only) + invite-target enumeration"`

### Task 13: `/me` signals + token-reach boundary test

**Files:**
- Modify: `apps/server/src/routes/auth.ts` (`/me`)
- Test: update auth `/me` test; add the token-reach §8.1 test

> `/me`: `is_instance_admin` ← `users.role ∈ {owner,admin}`; add `role`; DROP `is_system_member`. Token-reach test (§8.1): a `member`-minted token cannot reach a project the member lacks.

- [ ] **Step 1: Failing tests** — `/me` returns `role` + correct `is_instance_admin`, no `is_system_member`. Token-reach: mint a token as a `member` scoped to their granted project; assert it 403s on a different project (the `roleToScopes ∩ grant` ceiling).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** the `/me` change; the token-reach behavior should already hold from Phase 2 (this test PINS it — if it fails, the ceiling regressed).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-3: /me instance-role signals; pin token-reach boundary (§8.1)"`

**Phase 3 integration gate:** `/integration`. All §8.1 step-3 tests green (events traverse-leak, token reach, ws/project visibility). The invitation + role + enumeration surfaces exist and are correctly gated (T-B). Proceed to Phase 4.

---

## Phase 4 — `__system` teardown: rehome, collapse, then the CONTRACT migrations

> **PLAN CORRECTION (freshness review at Phase-4 entry, 2026-06-05) — ground-truthed against current source on `spec/drop-workspace-tenancy`; 2 open decisions resolved with the user. The plan's Task-16/17/20 code samples drifted from the post-Phase-3 source. Build to THESE, not the original samples:**
>
> - **D-A (Task 16 — `OPERATOR_SLUG`):** the plan's Task 16 test references `OPERATOR_SLUG`, but NO such constant exists today — the operator slug is *derived* from `OPERATOR_AGENT_TITLE='folio-operator'` via `slugify()`, and `isReservedSlug` (system-workspace.ts:32, `slug.startsWith('_')`) does NOT cover it. **DECISION (user, 2026-06-05): `OPERATOR_SLUG = '_operator'`** — `_`-prefixed so it's already unspawnable by `isReservedSlug` with ZERO new logic. `operator.ts` exports `OPERATOR_SLUG='_operator'` + `isOperator(slug)===slug===OPERATOR_SLUG`. The old `folio-operator` documents row (seeded on existing installs in `__system`) is orphaned and dies with the Task-20 `__system` teardown — no rename migration needed.
>
> - **D-B (Task 20 — `user.role.changed` event):** confirmed concrete — `events.workspace_id` is `.notNull()` + FK→workspaces (schema.ts:474), and `routes/instance-users.ts:107-113` emits `user.role.changed` scoped to `getSystemWorkspaceId(db)`. Dropping `__system` (Task 20) breaks both the FK and the `getSystemWorkspaceId` call. **DECISION (user, 2026-06-05): option (c) — DROP the `user.role.changed` emit entirely.** Audit-only, no consumer beyond SSE; removing it needs zero migration AND closes **CR-11** (the `__system`-grantee role-change leak) by construction. Remove the emit + the `getSystemWorkspaceId` import in instance-users.ts; the role PATCH still writes `users.role` in its tx (just no event). Update/delete the instance-users role-change *event* test (the PATCH-writes-role test stays). Frontend (Phase 5) learns role changes on next `/auth/me` refetch — acceptable.
>
> - **D-C (Task 17 — `resolveAgentForRun` has 7 call sites across 3 files, NOT the 3 in trigger-matcher the plan names):** trigger-matcher.ts (245 `handleCommentMentioned`, 344 resume, 439 `handleTriggerFired`), **agent-tools-registry.ts (1765, 1927)**, **routes/runs.ts (387, 505)**. The single definition lives in `system-workspace.ts:348-378` (NOT 360-390). Task 17 MUST rewire ALL 7 to the new collapsed resolver, or the runs route + MCP run-tools break. `agent-tools-registry.ts:96` also imports `getSystemWorkspaceId` + `isReservedSlug` from system-workspace (used at 360-362, 390 for the library-workspace filter) — Task 18 must rewire/delete those too.
>
> - **D-D (Task 14 — `loadAgentDefinition` reads `documents` not a Skills *table*):** runner.ts:497-532 currently queries the `__system` `skills` *project*'s `page` documents (via `getSystemWorkspaceId` + a projects.findFirst for slug='skills'), and derives `trusted` from each doc's `frontmatter.trusted===true`. `instance_skills` (schema.ts:448) is schema-only — NO code reads/writes it yet. Task 14 re-points to `getInstanceSkill(db, name)` and reads `trusted` from the **typed column**. `buildSkillsPreamble`/`buildUntrustedSkillsPreamble`/`buildUntrustedContext`/`UNTRUSTED_DATA_DIRECTIVE` (runner.ts) are UNAFFECTED — they consume `ctx.agentSkills` regardless of source.
>
> - **D-E (Task 14/16 — `system-skills.ts` exports 7 constants, ZERO functions):** `FOLIO_SKILL_SLUG`, `FOLIO_SKILL_FRONTMATTER` (`{trusted:true, description, when_to_use}`), `OPERATOR_AGENT_TITLE='folio-operator'`, `OPERATOR_TOOLS` (10 tools incl. get_skill/set_skill_trust), `FOLIO_SKILL_BODY`, `OPERATOR_PROMPT`, `SETUP_PROJECT_REF_BODY`. The folio-skill content (BODY+FRONTMATTER) moves to `instance-skills.ts` seeding; OPERATOR_PROMPT/OPERATOR_TOOLS move to/re-export from `operator.ts` (Task 16). `SETUP_PROJECT_REF_BODY` was a `__system` reference *page* — it dies with teardown unless re-homed; it is NOT a skill, so it does NOT go to `instance_skills`. Decide its fate at Task 18 (likely delete — it was operator setup-reference content, now stale).
>
> - **D-F (Task 19/16 — boot already converged):** `runBootTasks` (system-workspace.ts:614) = `bootstrapSystemWorkspace` → `designateInstanceOwner`(→`grantOwner` sets `users.role='owner'` [CR-6 fix already landed] + `ensureOperatorAgent`). Task 19's `designateInstanceOwner` rewrite (backfill-authoritative + `INSTANCE_OWNER_CONFLICT`) replaces the current first-wins `grantOwner`; new `runBootTasks` = `seedInstanceSkills` + `designateInstanceOwner` (NO bootstrap, NO ensureOperatorAgent — operator is now the code singleton).
>
> - **D-G (Task 17 — caller-bounded authority ALREADY converged in Phase 3):** `visibleProjectIds(db,userId,wsId)` + `resolveCallerProjectAllowList` (runs.ts:101) + `resolveAgentProjects`/`intersectAgentProjects` (agent-projects.ts) + `effectiveReach` (token-reach.ts:39) all exist from the CR-9/CR-10 fixes. Task 17 PRESERVES these — the collapse deletes only the home-predicate gate (runner.ts:327-350) + the library branch of token rebind (runner.ts:399-416, the `isLibraryAgent` fork); both ceilings (project via intersectAgentProjects, caller via effectiveReach) stay.
>
> Goal: delete DEAD cross-workspace machinery; rehome MIGRATE content (folio skill → `instance_skills`; operator → runtime singleton); collapse `resolveAgentForRun` across the 3 D11 paths keeping both ceilings; re-point skill-trust at the typed column; reconcile owner-designation; THEN author the contract migrations (`__system` teardown, drop `memberships`). Verdicts per spec §4.4.
>
> **PLAN CORRECTION (2026-06-05) — Phase 4 is 7 tasks (largest, riskiest phase). One end-of-phase review over a 7-task `__system`-teardown diff is too coarse: the irreversible contract migrations would be reviewed in the same pass as refactors. Phase 4 is split into THREE review clusters, each a STOP-AND-REVIEW boundary. The executing agent MUST halt at each `── REVIEW GATE ──` marker, hand back for `/integration` + `/code-review` on that cluster's diff, and NOT begin the next cluster until review is clear:**
> - **Cluster 4a — skill-source migration (Tasks 14-15):** load + trust re-point onto `instance_skills`. (Reviews the ~4 rewritten skill/trust tests.)
> - **Cluster 4b — operator + collapse + delete (Tasks 16-18):** operator runtime singleton, `resolveAgentForRun` collapse (7 call sites, D-C), delete dead `__system` machinery.
> - **Cluster 4c — owner reconciliation + IRREVERSIBLE contract migrations (Tasks 19-20):** the `__system` teardown + `memberships` drop. Highest-stakes, hardest-to-undo — gets its own dedicated review. Run `/security-review` here too, not just `/code-review`.
>
> **Integration gate (Phase 4 close — after cluster 4c):** server suite green; `grep -rn "__system\|getSystemWorkspaceId\|findSystemWorkspaceId\|resolveAgentForRun\|bootstrapSystemWorkspace\|library" apps/server/src --include=*.ts | grep -v "\.test\."` returns only intentional survivors (isReservedSlug, the SYSTEM_WORKSPACE_SLUG constant used by the teardown migration). The agent-run-authority §8.1 test green. `memberships` no longer in schema.

### Task 14: Instance-skills seeder + loader; re-point `loadAgentDefinition`

**Files:**
- Create: `apps/server/src/lib/instance-skills.ts`
- Modify: `apps/server/src/lib/runner.ts` (`loadAgentDefinition` ~line 502-537 — the `__system` Skills-project read)
- Modify boot wiring (`runBootTasks` / `index.ts`) to call `seedInstanceSkills`
- Test: `apps/server/src/lib/instance-skills.test.ts` + a runner skill-load test

> The folio skill body (`FOLIO_SKILL_BODY` etc. in `system-skills.ts`) moves to `instance_skills` (seeded on boot, idempotent). `loadAgentDefinition` loads named skills from `instance_skills` (by name) instead of the `__system` Skills project. The `trusted` flag rides the typed column.

- [ ] **Step 1: Failing test** — `seedInstanceSkills` is idempotent and inserts the folio skill; `getInstanceSkill('folio')` returns it; re-seeding doesn't duplicate (UNIQUE name).

```ts
test('seedInstanceSkills idempotently seeds the folio skill', async () => {
  const { db } = await makeBareTestDb();
  await seedInstanceSkills(db);
  await seedInstanceSkills(db);                       // idempotent
  const rows = await db.select().from(schema.instanceSkills);
  expect(rows.filter((r) => r.name === 'folio').length).toBe(1);
  const folio = await getInstanceSkill(db, 'folio');
  expect(folio?.body.length).toBeGreaterThan(100);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `instance-skills.ts` (move the constants from `system-skills.ts`; `seedInstanceSkills` uses `onConflictDoNothing` on name; `getInstanceSkill` by name). Re-point `loadAgentDefinition`: replace the `getSystemWorkspaceId` + Skills-project query with `getInstanceSkill(db, slug)`; on miss throw `MISSING_SKILL` (preserve the no-broad-fallback guarantee, spec Deliberate-exception). Thread `trusted` from the column into the trusted/untrusted channel split (invariant 11).

- [ ] **Step 4: Run, verify pass** (seeder test + a runner test that an agent declaring `skills:['folio']` loads it as trusted).

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-4: instance_skills seeder/loader; loadAgentDefinition reads instance skills"`

### Task 15: Skill-trust re-point at the typed column (T-E / invariant 11)

**Files:**
- Modify: `apps/server/src/lib/skill-trust.ts` (`setSkillTrust`, `canBlessSkill`)
- Modify: `apps/server/src/services/documents.ts` (`stripManagedSkillTrust` / `isSystemSkillPage` — now mostly obsolete for instance_skills)
- Test: `apps/server/src/lib/skill-trust.test.ts` + the T-E forging test (§8.1)

> `setSkillTrust` flips `instance_skills.trusted` (the typed column) + emits `skill.trust.changed` in one `txWithEvents`. Because `trusted` is a column, import/restore/edit (which write body+frontmatter) physically cannot set it — the forging path is closed structurally. `stripManagedSkillTrust` is no longer needed for `instance_skills` (nothing to strip); keep it ONLY where a `documents`-shaped skill could still carry incoming `trusted` (confirm in the sibling sweep — likely none survive).

- [ ] **Step 1: Failing test — T-E forging (§8.1 mandatory).**

```ts
test('an import/edit payload carrying trusted:true cannot set instance_skills.trusted', async () => {
  const { db } = await makeBareTestDb();
  await seedInstanceSkills(db);
  // Simulate the skill-write/import path (whatever surface edits an instance skill body):
  // attempt to write the folio skill with frontmatter { trusted: true } in the payload.
  // Assert the column stays false.
  // Then setSkillTrust(db, 'folio', true) flips it -> true.
  const before = await getInstanceSkill(db, 'folio');
  expect(before?.trusted).toBe(false);
  // ... call the edit/import surface with trusted:true in frontmatter ...
  const after = await getInstanceSkill(db, 'folio');
  expect(after?.trusted).toBe(false);                 // import cannot forge
  await setSkillTrust(db, 'folio', true, /* actor */);
  expect((await getInstanceSkill(db, 'folio'))?.trusted).toBe(true);  // sanctioned mutator works
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** Re-point `setSkillTrust`/`canBlessSkill` at `instance_skills`. Ensure the edit/import surface for instance skills writes only `body`+`frontmatter` (never `trusted`). Keep `unattendedFloor: true` on `set_skill_trust` (invariant 11 — trust-elevation refused on unattended runs).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-4: skill-trust on instance_skills.trusted typed column (T-E closed)"`

> **── REVIEW GATE 4a (STOP — cluster 4a complete: Tasks 14-15) ──**
> Commit 14 + 15, then HALT. Run `/integration` on the `14-15` diff, then `/code-review` (this cluster rewrote ~4 skill/trust tests — verify the denials still bite: MCP-PAT-cannot-bless, the typed-`trusted`-column-can't-be-forged, MISSING_SKILL fail-closed). Optionally run `test-effectiveness` (Situation A) on the diff first. **Do NOT start Task 16 until this cluster's review is clear.**

### Task 16: Operator runtime singleton (`operator.ts`) — OQ-1 (d), unspoofable

**Files:**
- Create: `apps/server/src/lib/operator.ts`
- Modify: `apps/server/src/lib/system-skills.ts` (keep `OPERATOR_PROMPT`/`OPERATOR_TOOLS`/`OPERATOR_AGENT_TITLE` as constants; re-export from operator.ts)
- Test: `apps/server/src/lib/operator.test.ts`

> The operator is resolved from code, never a `documents` row (OQ-1 (d)). Identity unspoofable (spec §4.5): `isReservedSlug` blocks a user creating an agent with the operator slug, AND the resolver returns the code singleton — never a queried row — so a user row can never BE the operator.

- [ ] **Step 1: Failing test** — `isOperator(OPERATOR_SLUG)` true; `getOperatorDefinition()` returns prompt+tools; a user-created `documents` row with the operator slug is NOT resolvable as the operator.

```ts
test('operator is a code singleton; a user agent cannot impersonate it', async () => {
  expect(isOperator(OPERATOR_SLUG)).toBe(true);
  const def = getOperatorDefinition();
  expect(def.prompt.length).toBeGreaterThan(100);
  expect(def.tools).toContain('folio_api');
  // even if a documents row somehow bore the slug, resolveAgentForRun returns the
  // code singleton for the operator slug, never the row (asserted in Task 17).
  expect(isReservedSlug(OPERATOR_SLUG) || OPERATOR_SLUG.startsWith('_')).toBe(true); // guarded at creation
});
```

> NOTE: confirm `OPERATOR_SLUG` is reserved by `isReservedSlug`. If the operator slug isn't `_`-prefixed today, either prefix it OR extend `isReservedSlug` to include it explicitly. The plan REQUIRES the operator slug be unspawnable by users — verify and, if needed, add a task-local sub-step to reserve it.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `operator.ts`: `OPERATOR_SLUG`, `isOperator(slug)`, `getOperatorDefinition()` (prompt/tools from the constants). Ensure `OPERATOR_SLUG` is covered by `isReservedSlug`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-4: operator runtime singleton (OQ-1 d), reserved-slug guarded"`

### Task 17: Collapse `resolveAgentForRun` across the 3 D11 paths (keep both ceilings)

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (home-predicate gate ~328-350; token rebind ~401-416; the resolver)
- Modify: `apps/server/src/lib/trigger-matcher.ts` (3 call sites: `handleTriggerFired` ~439, `handleCommentMentioned` ~245, resume ~344)
- Delete: `resolveAgentForRun` in `system-workspace.ts:360-390` (dual-workspace lookup)
- Test: `apps/server/src/lib/runner.test.ts` (rewrite home-predicate/library cases) + the agent-run-authority §8.1 test

> The dual-workspace `{run-ws, __system}` lookup collapses. Custom agents resolve by slug, project-scoped, bounded by `frontmatter.projects` (invariant 3). The operator resolves via `operator.ts` (Task 16). `effectiveReach` survives (caller authority). The library-agent branch of token rebind is deleted; instance-reach narrowing stays. BOTH ceilings retained on all 3 paths.

- [ ] **Step 1: Failing test — agent-run-authority (§8.1 mandatory).** Three sub-cases:
  - a custom agent run cannot act on a project off its `frontmatter.projects` allow-list (invariant 3).
  - a comment @mention by a `member` runs with at most `member` authority ∩ agent ceiling (caller-bounded).
  - the operator slug resolves to the code singleton, not a same-slug documents row (anti-impersonation).

- [ ] **Step 2: Run, verify fail** (current code routes through `__system`).

- [ ] **Step 3: Implement the collapse.** New resolver logic: if `isOperator(slug)` → `getOperatorDefinition()`; else `db.query.documents.findFirst({ where: and(eq(type,'agent'), eq(slug, slug)) })` (instance-wide, no workspace predicate), then bound by `resolveAgentProjects`. Delete the home-predicate gate and the library branch of rebind. Update all 3 trigger-matcher call sites to the new resolver. Keep `effectiveReach(token.workspaceId ?? null, run.workspaceId)` for the per-run narrowing. Delete `resolveAgentForRun` from `system-workspace.ts`.

- [ ] **Step 4: Run, verify pass** (the 3 §8.1 sub-cases + the rewritten runner tests). DELETE obsolete library-agent/home-predicate tests (`runner.test.ts` ~2224-2251, the C1 cases in `trigger-matcher.test.ts`).

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-4: collapse agent resolution (3 paths), keep project+caller ceilings; operator singleton"`

### Task 18: Delete DEAD `__system` machinery + library badging/union

**Files:**
- Modify/Delete in `apps/server/src/lib/system-workspace.ts`: `assertSystemProvenance`, `resolveSystemWorkspace`, `ensureSystemProject`, `ensureSystemPage`, `bootstrapSystemWorkspace`, `findSystemWorkspace`, `requireSystemWorkspace`, `getSystemWorkspaceId`, `findSystemWorkspaceId`, `ensureOperatorAgent`, `ensureOperatorToken` (operator is now a singleton).
- Modify: `apps/server/src/routes/workspace-documents.ts` (delete library badging ~139-145)
- Modify: `apps/server/src/services/documents.ts` (delete `unionSystemRows` + `__system` union ~1375-1401)
- Modify: `apps/server/src/lib/token-reach.ts` (`isOperatorToken` — re-examine; operator singleton may not need a token-origin check anymore, but if any code mints an operator token, keep an equivalent. Decide based on Task 16's operator wiring.)
- Test: delete `system-workspace.test.ts` cases for the deleted functions; keep reserved-slug tests.

- [ ] **Step 1:** Run the DEAD-grep to enumerate every consumer; for each, delete or rewire. Update tests first (delete obsolete assertions; a deleted function needs no test).

- [ ] **Step 2: Delete the functions + their call sites.** `runBootTasks` drops the `bootstrapSystemWorkspace` call (Task 19 handles its new boot duties).

- [ ] **Step 3: Run the server suite** — green (deletions shouldn't break anything if Tasks 14-17 rewired the live consumers). Fix any straggler import.

- [ ] **Step 4: Typecheck + commit.** `git commit -m "phase-4: delete DEAD __system machinery (bootstrap, union, library badging, operator-seed)"`

> **── REVIEW GATE 4b (STOP — cluster 4b complete: Tasks 16-18) ──**
> Commit 16-18, then HALT. Run `/integration` on the `16-18` diff, then `/code-review` (focus: the `resolveAgentForRun` collapse touched 7 call sites across 3 files (D-C) — confirm all rewired, both ceilings intact; and the dead-machinery deletion left no live consumer). **Do NOT start Task 19 (the irreversible migrations) until this cluster's review is clear.**

### Task 19: Owner-designation reconciliation in boot tasks (fix #3)

**Files:**
- Modify: `apps/server/src/lib/system-workspace.ts` (`designateInstanceOwner`, `runBootTasks`) — or move to a new `lib/instance-boot.ts` if `system-workspace.ts` is now nearly empty.
- Test: `apps/server/src/lib/instance-boot.test.ts`

> Backfill authoritative on migrated instances; boot task fresh-instance-only; disagreement throws `INSTANCE_OWNER_CONFLICT` (no silent first-wins).

- [ ] **Step 1: Failing tests:**
  - fresh instance (no owner), `FOLIO_INSTANCE_OWNER=alice@x` → alice becomes owner.
  - migrated instance (owner already set to bob), `FOLIO_INSTANCE_OWNER` unset → bob stays owner (boot doesn't override).
  - migrated (owner=bob), `FOLIO_INSTANCE_OWNER=carol@x` (different) → boot THROWS `INSTANCE_OWNER_CONFLICT`.
  - owner=bob, `FOLIO_INSTANCE_OWNER=bob@x` (same) → succeeds, no-op.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `designateInstanceOwner`: read current owner (`users` where role='owner'); if none and env set → set that user owner; if one exists and env set and differs → throw `INSTANCE_OWNER_CONFLICT`; if matches or env unset → no-op. `runBootTasks` now: `seedInstanceSkills` + `designateInstanceOwner` (no bootstrap).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-4: reconcile owner designation (backfill-authoritative, fail-loud on conflict)"`

### Task 20: CONTRACT migrations — `__system` teardown, then drop `memberships`

**Files:**
- Create: `apps/server/src/db/migrations/00XX_drop_system_workspace.sql` + journal
- Create: `apps/server/src/db/migrations/00XX_drop_memberships.sql` + journal (the LAST migration)
- Modify: `apps/server/src/db/schema.ts` (remove the `memberships` table export)
- Test: `apps/server/src/db/migrations/00XX_drop_memberships.test.ts`

> ONLY now — after Phases 2-4 removed every `memberships` read — is it safe to drop. `__system` teardown deletes the system workspace + its projects/documents + its memberships (idempotent, no-op if absent). Then drop `memberships`.

> **DEPENDENCY (discovered at T12, 2026-06-04): `user.role.changed` events are scoped to `__system`.** `routes/instance-users.ts` (T12) emits `user.role.changed` with `workspaceId = getSystemWorkspaceId(db)` because `emitEvent` hard-requires a non-null `workspaceId` (DB `.notNull()` + FK) and a role change is instance-level with no natural workspace. When THIS task deletes `__system`, that emit breaks (FK to a deleted ws, and `getSystemWorkspaceId` throws). **Phase 4 MUST resolve this** — pick one when wiring T18/T19/T20: (a) relax `events.workspace_id` to nullable for instance-level events + teach the SSE filter to treat null-ws events as instance-broadcast, OR (b) re-home instance-level audit events to a sentinel/first workspace, OR (c) drop the role-change event emit (audit-only, low value) — decide with the operator-home decision (OQ-1) since both touch "what is the instance's non-workspace home." The same applies to any other instance-level event added since (currently only `user.role.changed`; `access.granted`/`access.revoked` already scope to a real workspace/project, so they're unaffected). Do NOT let the `__system` teardown ship without addressing this — the `instance-users` role-change test bootstraps `__system`, so it will GO RED at the drop and surface the coupling.

- [ ] **Step 1: Failing test** — after all migrations, `memberships` table does NOT exist; `__system` workspace row does NOT exist (when seeded then migrated).

```ts
test('memberships dropped and __system removed after migrations', () => {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: resolve(import.meta.dir, '.') });
  const tbls = sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='memberships'`).all();
  expect(tbls.length).toBe(0);
});
```

- [ ] **Step 2: Run, verify fail** (memberships still exists).

- [ ] **Step 3: Author the migrations.** `__system` teardown (idempotent deletes guarded so they no-op when `__system` absent). `drop_memberships`: `DROP TABLE memberships;`. Remove the `memberships` export from `schema.ts`. Register BOTH in the journal. (Use the row-count guard pattern only where asserting a precondition; the drops are unconditional.)

- [ ] **Step 4: Run the FULL server suite** — green. This is the moment the drop could break something: if any test or code path still references `memberships`, it fails HERE. Fix by completing the sibling sweep (no live reads should remain).

- [ ] **Step 5: Typecheck + commit.** `git commit -m "phase-4: contract migrations — teardown __system, drop memberships (final migration)"`

**Phase 4 integration gate:** `/integration`. The DEAD-grep is clean; agent-run-authority §8.1 test green; `memberships` gone from schema + DB; `__system` teardown idempotent. The backend is now fully on the new model. Proceed to Phase 5.

---

## Phase 5 — Frontend

> Goal: extend the EXISTING instance `/settings` route (it already has AI + tokens tabs from the instance-AI work) with Roles + Invitations tabs; remove the per-workspace role UI; remove the `library` agent badge; point the cockpit-chat at the operator singleton; keep the workspace switcher + grouping. Web tests via `npx vitest run`.
>
> **Integration gate:** `cd apps/web && npx vitest run` green; `bun x tsc --noEmit` (web) clean.

### Task 21: API hooks for the new instance surfaces

**Files:**
- Create: `apps/web/src/lib/api/instance-access.ts` (mirror `instance-ai-keys.ts` shape — uses the one `client`, key factory)
- Create: `apps/web/src/lib/api/instance-users.ts`
- Test: co-located `.test.tsx`

> Follow invariant 6 (web): all HTTP via the one `client`; react-query keys from per-resource key factories. Mirror `lib/api/instance-ai-keys.ts` exactly.

- [ ] **Step 1: Failing tests** — hooks call the right endpoints, expose mutations (grant/revoke access, change role, list invite-targets, list users).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `useInstanceAccess`/`useGrantAccess`/`useRevokeAccess`, `useInstanceUsers`/`useSetUserRole`/`useInviteTargets` — each via `client`, with `instanceAccessKeys`/`instanceUsersKeys` factories.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "phase-5: web API hooks for instance access + users"`

### Task 22: Roles + Invitations tabs in `/settings`

**Files:**
- Create: `apps/web/src/components/settings/roles-tab.tsx`, `invitations-tab.tsx` (+ tests)
- Modify: `apps/web/src/routes/settings.tsx` (register the new tabs alongside AI/tokens)

> Roles tab: list users + role; role select is owner-only (disabled/hidden for admins — mirror server OQ-3 gate; don't rely on UI alone, the server enforces). Invitations tab: pick a user + a workspace/project (from invite-targets enumeration) → grant; list + revoke grants. Owner+admin.

- [ ] **Step 1: Failing tests** — owner sees editable role selects; admin sees read-only roles but can invite; the invite picker lists all workspaces (enumeration).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the two tabs (shadcn components, inline-edit pattern per CLAUDE.md UX commitments; optimistic writes + toast rollback).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "phase-5: Roles + Invitations tabs in instance Settings"`

### Task 23: Remove per-workspace role UI + the `library` badge; point cockpit at operator

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.settings.tsx` (remove per-ws member/role UI; keep non-role ws settings if any)
- Modify: `apps/web/src/components/triggers/trigger-agent-field.tsx` (remove `library` badge ~16,21,71-73)
- Modify: `apps/web/src/lib/api/workspace-documents.ts` (remove the `library` prop + comment ~21-22)
- Modify: cockpit-chat operator reference (cross-check `2026-06-03-operator-cockpit-chat-design.md`) → resolve the operator via the singleton, not a `__system` lookup
- Modify: `/me` consumers — drop `is_system_member`; use `role` + `is_instance_admin`
- Test: update the affected component tests

- [ ] **Step 1: Failing/updated tests** — no `library` badge rendered; per-ws role UI gone; cockpit resolves the operator; `/me`-driven admin gates use `is_instance_admin`/`role`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the removals + rewires.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "phase-5: remove per-ws role UI + library badge; cockpit -> operator singleton"`

**Phase 5 integration gate:** web suite + tsc clean. The switcher + grouping still work; instance Settings owns roles + invitations.

---

## Phase 6 — Invariants doc + final sweep

### Task 24: Update `ARCHITECTURE-INVARIANTS.md`

**Files:**
- Modify: `ARCHITECTURE-INVARIANTS.md`

> Rewrite the `__system`-specific language so the doc matches reality after teardown.

- [ ] **Step 1:** Invariant 11 — rewrite "the `trusted` flag on a `__system` skills page" → "on an `instance_skills` row (typed `trusted` column)"; name `setSkillTrust` as the sole writer and the column as the structural guarantee.
- [ ] **Step 2:** The two Deliberate exceptions (loadAgentDefinition skill read; runner AI-key read) — rewrite their `__system`/`workspaceId` language to the instance-skills / instance-key homes.
- [ ] **Step 3:** Add an invariant-10 Deliberate exception: `workspace_access`/`project_access` are relational join tables (authorization data, indexed reverse lookup), a justified exception to data-before-tables.
- [ ] **Step 4: Commit.** `git commit -m "phase-6: update ARCHITECTURE-INVARIANTS for instance model (inv 11 + exceptions)"`

### Task 25: Final sibling-site sweep + doc updates

- [ ] **Step 1:** Run all four greps clean: live `memberships` reads; `__system`/`getSystemWorkspaceId`/`resolveAgentForRun`; `is_system_member`; `library` (web). Any straggler is a bug.
- [ ] **Step 2:** Update `CLAUDE.md` "Decisions Already Made" + `memory/DECISIONS.md` to record the model change (workspaces are org folders; roles instance-level; access invite-based; `__system` removed; operator = singleton). Update `docs/FOLIO-BRIEFING.md` glossary if it still calls a workspace a tenancy container.
- [ ] **Step 3: Commit.** `git commit -m "phase-6: final sweep + docs (CLAUDE.md, DECISIONS, briefing glossary)"`

---

## Shake-out + finish (Stage 3 — after all phases)

- [ ] Run `/integration` (defense in depth) — server + shared + web + tsc per-app.
- [ ] Run `/shakeout` — re-runs integration, E2E (Playwright if configured), and dispatches reviewer agents on the full branch diff: `invariant-auditor` (verify no convergence-point bypass — esp. inv 1/4/7/11), `security-sentinel` (T-A…T-F), plus the others. The threat model (spec §7) is the convergence target.
- [ ] **User real-key shake-out gate** (per project pattern for auth/agent work): exercise an actual agent run + a comment @mention + the operator chat against a real key, confirming the 3-path ceilings hold end-to-end. This is the user-side merge gate; do not merge without it.
- [ ] `superpowers:finishing-a-development-branch`.

---

## Self-review (run before handing off — writing-plans checklist)

**Spec coverage** — every spec section maps to a task:
- §2 decisions (D1-D11, OQ-1 d, OQ-3) → Tasks 1-23 (roles T1/T8, access T2/T6/T7/T9, instance_skills T3/T14/T15, operator T16/T17, invitations T11/T12).
- §3 visibility (incl. traverse) → T6 (rules), T7 (middleware), T9/T10 (list/events filters).
- §4.1 schema + expand-contract → Phase 1 + T20 (contract).
- §4.1 security note (typed trusted) → T3 + T15 (+ §8.1 T-E test).
- §4.2 auth → T7/T8. §4.3 routes → T9-T13. §4.4 teardown → T14-T20. §4.5 agent exec + operator predicate → T16/T17.
- §6 invariants → T24. §7 threat model → distributed (T-A T7/T9/T10, T-B T11, T-C T17, T-D T8/T13, T-E T15, T-F T4). §8.1 mandatory tests → T10 (events traverse), T13 (token reach), T9 (visibility), T17 (agent-run authority), T4 (T-F backfill).
- §5 frontend → Phase 5. §9 OQ-1/3 → resolved, encoded T16/T12.

**Placeholder scan** — migration numbers are `00XX` (resolved at `db:generate` time — intentional, the engineer assigns the next number); all test code is concrete; no "TBD"/"handle errors"/"similar to". The few "spell out in the real task" notes (backfill seed SQL, SSE drive harness) are flagged as needing exact expansion AT execution — acceptable because the shape + assertions are given; the implementer fills seed boilerplate against the live harness. (If stricter: expand those two inline during execution before dispatch.)

**Type consistency** — `canSeeWorkspace(db, userId, wsId)` / `canSeeProject(db, userId, projId)` / `userRole(db, userId)` / `requireInstanceAdmin(db, userId)` / `requireInstanceOwner(db, userId)` / `isOperator(slug)` / `getInstanceSkill(db, name)` / `seedInstanceSkills(db)` — signatures consistent across all tasks that call them. `instance_skills.trusted` is `mode:'boolean'` (stored int) everywhere.

---

## Execution options

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, netdust addendum appended verbatim to every dispatch. Best for this plan's size + security weight.

**2. Inline Execution** — executing-plans, batch with checkpoints.
