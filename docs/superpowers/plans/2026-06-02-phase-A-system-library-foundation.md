# Phase A — System Library Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `__system` library workspace (reserved, creation-protected, ownership-verified), the instance-owner designation paths (fresh-install gated registration + existing-install promote), the `Skills`/`Reference` projects, the seeded `folio` skill + reference docs, and the operator agent living in `__system` — with NO cross-workspace execution change yet.

**Architecture:** `__system` is a normal workspace at a reserved underscore-prefixed slug (users cannot create underscore slugs — the create/rename regex `^[a-z0-9-]+$` already blocks them; we add an explicit reserved-slug reject as defense-in-depth). It is created once at boot via a direct insert (idempotent + provenance-verified: bootstrap never adopts a workspace it didn't create). The first `__system` membership (the instance owner) is designated either at gated first-user-registration (fresh install) or via a one-time `FOLIO_INSTANCE_OWNER` promote (existing install). Skills/reference docs are seeded as ordinary `page` documents; the operator agent is a normal `type='agent'` document in `__system`.

**Tech Stack:** Bun, Hono, Drizzle, SQLite. Reuses `createDocument` (`services/documents.ts:499`) for the agent + its auto-minted token, `seedProjectDefaults`, the existing boot wiring in `index.ts`, the `FOLIO_*` env schema (`env.ts`), and the membership `role` enum (`owner|admin|member`).

**Spec:** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Components 1, 2; Phase A).

---

## Threat model

> Phase A of the system-library build: the `__system` reserved workspace + instance-owner designation + reserved-slug protection. Written 2026-06-02. The surfaces are auth/session (registration gating, first-user owner) and multi-tenancy (a privileged workspace, slug hijack). This is the convergence target for `/code-review` on Phase A — verify against the named mitigations, don't free-form.

### What we're defending

1. **Instance-owner authority** — membership in `__system` (role `owner`) IS the instance-admin tier; whoever holds it curates the library and (in later phases) the agents that act cross-workspace. A wrongly-granted `__system` membership is privilege escalation to instance admin.
2. **The library workspace integrity** — the `__system` workspace row + its membership: it must be system-created, not a user-claimed workspace the library bootstraps onto.
3. **The reserved namespace** — underscore-prefixed slugs (`__system`, and any future `__*`) must remain uncreatable/un-renamable by any non-bootstrap caller (user, admin, or agent bearer).
4. **The operator agent definition** — the seeded operator's prompt/frontmatter in `__system`; it must not be readable/editable by non-`__system` members (it's the agent's capability, not customer data).

### Who we're defending against

1. **External attacker hitting an ungated fresh install** (IN scope) — races to `POST /register` to become the first user = instance owner before the legitimate operator.
2. **Authenticated workspace user/admin** (IN scope) — tries to create or rename a workspace to `__system` (or another `__*` slug) to hijack the library, or to read/edit `__system` content without membership.
3. **An agent bearer token** (IN scope) — an agent with `config:write` tries to create/reach `__system` via `folio_api` (the project routes ride `config:write`; workspace create is session-only, but verify the boundary holds).
4. **A second boot / re-run of bootstrap** (IN scope for idempotency) — must not double-create `__system`, double-seed the operator, or re-grant ownership.
5. **Insider with a stolen `__system`-owner session** (OUT of scope) — trust root; if the instance owner's session is stolen, the instance is compromised by definition.

### Attacks to defend against

1. **A1 — Registration race on a fresh self-hosted deploy.** Open `POST /register` lets whoever arrives first become the first user; if first-user auto-seeds `__system` ownership, an attacker becomes instance owner. (Class: unauthenticated privilege escalation via race.)
2. **A2 — Slug hijack via workspace create.** A user POSTs a workspace with slug `__system` (or `__anything`) to pre-create the library workspace so bootstrap adopts THEIR workspace (with their membership). (Class: reserved-resource squatting.)
3. **A3 — Slug hijack via workspace rename.** Same as A2 but via `PATCH /w/:slug` renaming an existing user workspace to `__system`. (Class: reserved-resource squatting via rename.)
4. **A4 — Bootstrap adopts a pre-existing user `__system`.** If bootstrap is "create if absent," and an attacker (or a regex-loosening regression) got a `__system` workspace created, bootstrap treats it as the library and the library lives on attacker-owned data with attacker membership. (Class: provenance confusion / TOCTOU on the reserved slug.)
5. **A5 — Existing-install stranding → manual DB grab.** On an install that already has users, first-registration never fires, so `__system` has no member; if an admin then improvises by hand-inserting a membership, they may grant it to the wrong user, or grant a non-idempotent double. (Class: missing designation path → unsafe workaround.)
6. **A6 — Non-member reads/edits `__system` content.** A customer admin in workspace B reads the operator's prompt or the skills via the generic document routes / list, leaking the agent definition or letting them tamper with it. (Class: cross-tenant read/write of the library.)
7. **A7 — Agent bearer creates/reaches `__system`.** An agent with `config:write` uses `folio_api` to create a project/table under `__system`, or to create a `__system` workspace, escalating into the library. (Class: agent escalation into the privileged workspace.)
8. **A8 — Double-bootstrap side effects.** A second boot re-creates `__system`, re-seeds the operator (duplicate agent + duplicate token), or re-runs `FOLIO_INSTANCE_OWNER` promote granting a second ownership. (Class: non-idempotent bootstrap.)

### Mitigations required

1. **M1 → gate first-registration; do NOT auto-seed instance-owner on an unguarded register.** `POST /register` gains an `OPEN_REGISTRATION` gate: registration is allowed ONLY when (a) there are zero users yet (the first-account bootstrap) AND a deploy-level flag permits it, OR (b) an authenticated path invites them — for Phase A the concrete rule: **the FIRST user to register becomes instance owner ONLY if `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=true`** (default false on a hardened deploy); otherwise registration of the first user is rejected with a clear "instance owner must be set via FOLIO_INSTANCE_OWNER" error. A test asserts: with the flag false and zero users, `POST /register` is rejected; with the flag true and zero users, the first registrant becomes a `__system` owner; a SECOND registration never grants `__system` ownership regardless of the flag.
2. **M2 → explicit reserved-slug reject in workspace CREATE.** The create route rejects any slug matching `^__` (reserved prefix) with a `RESERVED_SLUG` 400, BEFORE the uniqueness check — in addition to the existing `^[a-z0-9-]+$` regex (which already blocks underscores; the explicit check is defense-in-depth so loosening the regex can't silently reopen A2). A test posts slug `__system` → 400 `RESERVED_SLUG`.
3. **M3 → explicit reserved-slug reject in workspace RENAME.** Same `^__` reject on the `PATCH /w/:slug` rename path. A test renames a workspace to `__system` → 400 `RESERVED_SLUG`.
4. **M4 → bootstrap VERIFIES provenance, never adopts.** `bootstrapSystemWorkspace(db)` (new, called at boot after migrations): if no `__system` exists, create it via direct insert (bypassing the route) + mark it system-created by the reserved slug itself. If a `__system` row ALREADY exists, assert it is the system's: the invariant is *a `__system`-slugged workspace can only have been system-created* (users can't, by M2+regex), so an existing one is trusted ONLY if it was created by this same bootstrap path — implemented as: bootstrap is the SOLE creator of `__system` (no route can make it), so an existing `__system` at boot is by construction system-made; the verification is a guard that FAILS LOUD if the row exists but is structurally wrong (e.g. missing the expected `Skills`/`Reference` projects after a partial prior run → repair, not adopt-blindly). A test: pre-insert a `__system` workspace with a user membership (simulating a hypothetical hijack), run bootstrap → it does NOT grant that user instance-owner / does NOT treat their projects as the library (fails loud or ignores the foreign membership).
5. **M5 → one idempotent owner-designation path that works on any install age.** A `designateInstanceOwner` operation (CLI/boot): if `FOLIO_INSTANCE_OWNER=<email>` is set and that user exists and `__system` has no `owner` membership yet, grant them `__system` owner. Idempotent: a no-op if `__system` already has an owner. Works on fresh AND existing installs (existing-install promote = the same path). A test: existing install (users present, `__system` has no member), set `FOLIO_INSTANCE_OWNER` to an existing email, run → that user is `__system` owner; re-run → still exactly one owner (no double).
6. **M6 → `__system` content is membership-gated like any workspace.** No special exposure: the generic document/list routes already require workspace membership via `resolveWorkspace` + `requireResource`/session — a non-member of `__system` gets the standard 403/empty. Phase A adds NO read path that bypasses membership (the definitional skill-load exemption is Phase B, explicitly NOT in Phase A). A test: a user who is NOT a `__system` member cannot GET a `__system` document (403/404 per the existing membership gate).
7. **M7 → workspace create stays session-only; agents cannot create `__system`.** Confirm (no code change expected, but a test) that `POST /workspaces` is `requireSessionUser` (agent bearers rejected), and that `folio_api` (config:write) cannot reach workspace-create (it's not under the `config:write` routes — workspace create/rename/delete are session-only per the Phase-2 decision). A test: an agent bearer POSTing `/workspaces` with slug `__system` is rejected by `requireSessionUser` (401/403), never reaching the slug check.
8. **M8 → bootstrap + seed are idempotent.** `bootstrapSystemWorkspace` creates `__system` + `Skills`/`Reference` + the operator agent + skill/ref docs ONLY if absent (per-entity `WHERE NOT EXISTS` / findFirst guards), and `designateInstanceOwner` is a no-op if an owner exists. A test: run bootstrap twice → exactly one `__system`, one operator agent, one of each seeded doc, one owner.

### Out of scope (explicit deferrals)

- **The definitional skill-load exemption** (runner reads agent body + named skills from `__system` with system authority) — that's Phase B; Phase A keeps `__system` content behind normal membership.
- **Cross-workspace execution / library agents listed in other workspaces** — Phase B.
- **A richer instance-admin model** (multiple tiers, a queryable flag) — the spec defines instance-admin AS `__system` membership; superseding that is a later concern.
- **DNS/registration anti-automation (captcha, rate-limit on /register)** — the `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` gate + first-user-only-owner is the Phase-A defense; broader registration abuse controls are an ops concern.
- **Insider with a stolen owner session** — trust root.

### How to use this section

- **Controller pre-flight:** verify each task carries its named M-mitigation before dispatch.
- **`/code-review high`:** "Verify against the Phase A threat model (M1–M8). Pay special attention to the registration gate (A1/M1 — confirm the first-user-owner path cannot fire on an unguarded register), the reserved-slug rejects on BOTH create and rename (A2/A3, M2/M3), and bootstrap provenance (A4/M4 — confirm bootstrap never grants ownership off a pre-existing foreign `__system`). Confirm Phase A adds NO `__system` read path that bypasses membership (M6 — the definitional exemption is Phase B)."
- **`/evaluate` retro:** any missing M-mitigation → plan-correction defect.
- **Downstream (Phase B/C):** inherit M1–M8; Phase B EXTENDS with the definitional-read exemption + cross-workspace resolution — do not re-litigate the bootstrap mitigations.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/lib/system-workspace.ts` | NEW — `SYSTEM_WORKSPACE_SLUG`, `isReservedSlug(slug)`, `bootstrapSystemWorkspace(db)` (create `__system` + `Skills`/`Reference` projects + seed operator agent + skill/ref docs, idempotent), `designateInstanceOwner(db, email)` (idempotent owner grant). | Create |
| `apps/server/src/lib/system-skills.ts` | NEW — the `folio` skill body + the reference-doc bodies as exported string constants (the content seeded into `__system`). Keeps content out of the bootstrap logic. | Create |
| `apps/server/src/routes/workspaces.ts` | Add `isReservedSlug` reject to CREATE (line ~62) + RENAME (PATCH, line ~100). | Modify |
| `apps/server/src/routes/auth.ts` | Gate `POST /register` (M1): first-user-becomes-owner only behind `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION`; otherwise reject first registration with the FOLIO_INSTANCE_OWNER hint. | Modify |
| `apps/server/src/env.ts` | Add `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` (bool, default false) + `FOLIO_INSTANCE_OWNER` (optional email string). | Modify |
| `apps/server/src/index.ts` | Call `bootstrapSystemWorkspace(db)` after `runMigrationsOnBoot(db)`; call `designateInstanceOwner(db, env.FOLIO_INSTANCE_OWNER)` if set. | Modify |
| Tests per file | TDD | Create |

---

## Task 1: Reserved-slug helper + env flags

**Mitigations: M2, M3 (the helper), M1/M5 (env flags).** Pure, dependency-free — the safe first slice.

**Files:**
- Create: `apps/server/src/lib/system-workspace.ts` (the slug constants + `isReservedSlug` only this task)
- Modify: `apps/server/src/env.ts`
- Test: `apps/server/src/lib/system-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/src/lib/system-workspace.test.ts
import { describe, expect, test } from 'bun:test';
import { SYSTEM_WORKSPACE_SLUG, isReservedSlug } from './system-workspace.ts';

describe('reserved slug (M2/M3)', () => {
  test('the system workspace slug is the reserved underscore-prefixed constant', () => {
    expect(SYSTEM_WORKSPACE_SLUG).toBe('__system');
    expect(isReservedSlug(SYSTEM_WORKSPACE_SLUG)).toBe(true);
  });
  test('any underscore-prefixed slug is reserved', () => {
    expect(isReservedSlug('__anything')).toBe(true);
    expect(isReservedSlug('_x')).toBe(true);
  });
  test('normal slugs are not reserved', () => {
    expect(isReservedSlug('acme')).toBe(false);
    expect(isReservedSlug('web-2')).toBe(false);
    expect(isReservedSlug('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd apps/server && bun test src/lib/system-workspace.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the helper**

```typescript
// apps/server/src/lib/system-workspace.ts
/** The single reserved library workspace. Underscore-prefixed slugs are a
 *  reserved namespace users cannot create (the workspace create/rename regex
 *  `^[a-z0-9-]+$` already blocks underscores; isReservedSlug is the explicit
 *  defense-in-depth so loosening that regex can never silently reopen the
 *  hijack — see Phase A threat model M2/M3). */
export const SYSTEM_WORKSPACE_SLUG = '__system';

/** True for any reserved (underscore-prefixed) workspace slug. */
export function isReservedSlug(slug: string): boolean {
  return slug.startsWith('_');
}
```

- [ ] **Step 4: Add env flags** to `apps/server/src/env.ts`'s `envSchema` (alongside the other `FOLIO_*` keys):

```typescript
  // Phase A: first-user-becomes-instance-owner is allowed ONLY when this is
  // true (default false on a hardened deploy) — closes the registration race
  // (threat model A1/M1). Otherwise the owner is set via FOLIO_INSTANCE_OWNER.
  FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  // Phase A: designate the instance owner (the first `__system` member) by
  // email on any install age (M5). Optional; idempotent when applied.
  FOLIO_INSTANCE_OWNER: z.string().email().optional(),
```

(Match the file's existing coercion style — it uses `z.coerce`/`z.string().transform`. Use an explicit string→bool transform for the bool, NOT `z.coerce.boolean()` which mis-coerces `'false'`→true.)

- [ ] **Step 5: Run to verify pass + tsc** — `cd apps/server && bun test src/lib/system-workspace.test.ts && bun x tsc --noEmit` → PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/system-workspace.ts apps/server/src/lib/system-workspace.test.ts apps/server/src/env.ts
git commit -m "phase-A: reserved-slug helper + bootstrap env flags (M1/M2/M3/M5)"
```

---

## Task 2: Reject reserved slugs on workspace create + rename

**Mitigations: M2, M3.**

**Files:**
- Modify: `apps/server/src/routes/workspaces.ts` (CREATE ~line 62, RENAME/PATCH ~line 100)
- Test: `apps/server/src/routes/workspaces.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (read the file first for the session-cookie test pattern):

```typescript
test('POST /workspaces rejects a reserved (__) slug (M2)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sneaky', slug: '__system' }),
  });
  // The slug regex (^[a-z0-9-]+$) rejects underscores at validation (422);
  // the explicit isReservedSlug reject is defense-in-depth. EITHER a 422
  // (regex) or 400 RESERVED_SLUG is acceptable, but assert it is NOT created.
  expect([400, 422]).toContain(res.status);
  const exists = await seed /* query workspaces for slug __system */;
  // assert no workspace with slug __system was created
});

test('PATCH /w/:slug rejects rename to a reserved slug (M3)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/${seed.workspace.slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: '__system' }),
  });
  expect([400, 422]).toContain(res.status);
});
```

(Adapt the "assert not created" query to the test file's db access — `makeTestApp` returns `{ db }`; use `db.query.workspaces.findFirst({ where: eq(workspaces.slug, '__system') })`. Import `eq`, `workspaces`.)

> **Note for the implementer:** because the Zod slug regex `^[a-z0-9-]+$` already rejects `__system` at validation (422), the explicit `isReservedSlug` check only fires for slugs that PASS the regex but are still reserved — which, given underscores are blocked, is currently none. The explicit check is therefore defense-in-depth for a FUTURE regex change. To make the explicit check observably exercised, ALSO add a test that calls a small exported `assertSlugAllowed(slug)` (see Step 3) directly with `__system` and expects it to throw — so the reserved logic is unit-tested independent of the regex.

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — in `workspaces.ts`, import `isReservedSlug` + add a tiny guard used by both routes:

```typescript
import { isReservedSlug } from '../lib/system-workspace.ts';

/** Throw if a slug is reserved (underscore-prefixed). Defense-in-depth beyond
 *  the create/rename zod regex (threat model M2/M3). Exported for unit test. */
export function assertSlugAllowed(slug: string): void {
  if (isReservedSlug(slug)) {
    throw new HTTPError('RESERVED_SLUG', `slug "${slug}" is reserved`, 400);
  }
}
```

Call `assertSlugAllowed(explicit)` in the CREATE handler right after reading `explicit` (before the uniqueness check), and `assertSlugAllowed(explicit)` in the PATCH handler the same way. Only call it when an explicit slug is provided (auto-slugify never produces underscores).

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/workspaces.ts apps/server/src/routes/workspaces.test.ts
git commit -m "phase-A: reject reserved __ slugs on workspace create + rename (M2/M3)"
```

---

## Task 3: The skill + reference-doc content

**Mitigations: none directly (content for M8's seed).** Pure content module so the bootstrap logic stays clean.

**Files:**
- Create: `apps/server/src/lib/system-skills.ts`
- Test: `apps/server/src/lib/system-skills.test.ts` (a smoke test that the constants are non-empty + the operator prompt names the folio skill slug)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'bun:test';
import { FOLIO_SKILL_SLUG, FOLIO_SKILL_BODY, OPERATOR_AGENT_SLUG, OPERATOR_PROMPT, SETUP_PROJECT_REF_BODY } from './system-skills.ts';

describe('system skill + reference content', () => {
  test('the folio skill body is substantial and accurate', () => {
    expect(FOLIO_SKILL_SLUG).toBe('folio');
    expect(FOLIO_SKILL_BODY.length).toBeGreaterThan(500);
    expect(FOLIO_SKILL_BODY).toContain('folio_api');
    expect(FOLIO_SKILL_BODY).toContain('config:write');
  });
  test('the operator prompt references the folio skill by slug + is non-empty', () => {
    expect(OPERATOR_AGENT_SLUG).toBe('__folio_operator');
    expect(OPERATOR_PROMPT.length).toBeGreaterThan(200);
    expect(OPERATOR_PROMPT).toContain(FOLIO_SKILL_SLUG);
  });
  test('the setup-a-project reference is non-empty', () => {
    expect(SETUP_PROJECT_REF_BODY.length).toBeGreaterThan(200);
  });
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — author the content. Reuse the already-reviewed `folio` skill body shape from the archived work (tag `archive/phase-op-3-seeded-bot`, file `seed-operator.ts` had a reviewed `SKILL_BODY` + `OPERATOR_PROMPT`) as the STARTING POINT, but adjust: the operator now lives in `__system` and reads its skill from there (Phase A keeps it membership-gated; Phase B adds the definitional read). Export:
  - `FOLIO_SKILL_SLUG = 'folio'`, `FOLIO_SKILL_BODY` (the API manual: resource→route→scope table for tables/fields/views/statuses/projects = `config:write`+dryRun and documents = `documents:read|write` via narrow tools; the `folio_api`/`folio_api_get` split; schema conventions; the risk-gate protocol; the governing principle "the API is the source of truth").
  - `OPERATOR_AGENT_SLUG = '__folio_operator'`, `OPERATOR_PROMPT` (body-as-prompt: role, read the `folio` skill, use folio_api_get for reads / folio_api for writes, authority = agent ∩ caller, high-risk refused-with-plan).
  - `SETUP_PROJECT_REF_BODY` ("how to set up a project" — the worked POST sequence: project → tables → fields → statuses → views).
  - `OPERATOR_TOOLS = ['folio_api','folio_api_get','list_documents','get_document','create_document','update_document','list_projects','run_view']` (all in `V1_MCP_TOOLS`).

> Verify each tool in `OPERATOR_TOOLS` is a member of `V1_MCP_TOOLS` (`packages/shared/src/mcp-tools.ts`) — `folio_api`/`folio_api_get` were added there in the kept work.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/system-skills.ts apps/server/src/lib/system-skills.test.ts
git commit -m "phase-A: folio skill + operator prompt + setup-project reference content"
```

---

## Task 4: `bootstrapSystemWorkspace` — create + seed, idempotent + provenance-safe

**Mitigations: M4, M8.** The heart of Phase A.

**Files:**
- Modify: `apps/server/src/lib/system-workspace.ts` (add `bootstrapSystemWorkspace`)
- Test: `apps/server/src/lib/system-workspace.test.ts` (extend — integration-style, real in-memory db)

- [ ] **Step 1: Write the failing test** (uses `makeTestApp`'s db, OR a bare migrated db — read `0021_..test.ts`/`harness.ts` for the in-memory + migrate pattern; bootstrap must run against a db that has NO `__system`):

```typescript
import { eq, and } from 'drizzle-orm';
import { documents, memberships, projects, workspaces } from '../db/schema.ts';
import { bootstrapSystemWorkspace, SYSTEM_WORKSPACE_SLUG } from './system-workspace.ts';

test('bootstrap creates __system + Skills/Reference projects + operator agent + seeded docs (M8)', async () => {
  const { db } = await makeTestApp(); // makeTestApp seeds a normal ws 'acme'; __system absent
  await bootstrapSystemWorkspace(db);
  const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  expect(sys).toBeDefined();
  const projs = await db.query.projects.findMany({ where: eq(projects.workspaceId, sys!.id) });
  expect(projs.map((p) => p.slug).sort()).toEqual(['reference', 'skills']); // or your chosen slugs
  const operator = await db.query.documents.findFirst({ where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')) });
  expect(operator).toBeDefined();
  expect((operator!.frontmatter as any).provider).toBe('anthropic');
  const skill = await db.query.documents.findFirst({ where: and(eq(documents.workspaceId, sys!.id), eq(documents.slug, 'folio')) });
  expect(skill).toBeDefined();
});

test('bootstrap is idempotent — running twice yields one of each (M8)', async () => {
  const { db } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  await bootstrapSystemWorkspace(db);
  const sys = await db.query.workspaces.findMany({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  expect(sys.length).toBe(1);
  const agents = await db.query.documents.findMany({ where: and(eq(documents.workspaceId, sys[0]!.id), eq(documents.type, 'agent')) });
  expect(agents.length).toBe(1);
});

test('bootstrap does NOT adopt a pre-existing foreign __system membership (M4)', async () => {
  const { db, seed } = await makeTestApp();
  // simulate a hijack: a __system workspace already exists with a NON-owner foreign membership.
  // (In reality M2/M3 prevent users creating it, but bootstrap must not trust an existing row's memberships.)
  // Insert a __system workspace + a foreign membership directly:
  // ... insert workspace slug __system id 'sys_foreign' ; insert membership (sys_foreign, seed.user.id, 'owner')
  await bootstrapSystemWorkspace(db);
  // bootstrap must NOT have granted instance-ownership off the foreign row; assert the foreign membership
  // did not become an instance-owner grant the system relies on (i.e. designateInstanceOwner is the ONLY
  // owner-granting path; bootstrap itself grants NO membership). See M4/M5 split.
  // Concretely: bootstrap creates structure but assigns NO owner membership; owner comes only via Task 5.
});
```

> **Design note (M4):** to keep provenance simple and safe, **`bootstrapSystemWorkspace` grants NO membership** — it only creates the workspace + projects + agent + docs (structure). The OWNER is granted exclusively by `designateInstanceOwner` (Task 5) / the gated registration (Task 6). So even if a foreign `__system` row somehow existed, bootstrap would not turn a foreign membership into instance-ownership (ownership has one source). And because M2/M3 make `__system` uncreatable by users, in practice the row is always system-made. The third test encodes "bootstrap grants no membership."

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement `bootstrapSystemWorkspace(db)`** — idempotent, structure-only:
  - If a `__system` workspace exists, use it; else insert one (direct insert, `id = nanoid()`, slug `SYSTEM_WORKSPACE_SLUG`, name e.g. 'System Library'). (Wrap creation in `txWithEvents` to honor the event invariant, OR document why boot-time seeding emits no bus events — the dispatcher isn't running yet at boot, mirror how `seedProjectDefaults` is used. Prefer `txWithEvents` for consistency.)
  - Ensure the `Skills` + `Reference` projects exist (findFirst-by-slug-in-ws, else insert via the same path `seedProjectDefaults` uses — but these don't need default tables; a bare project is fine, so insert the project row directly).
  - Ensure the operator agent exists: if absent, create it via `createDocument` (so it gets its auto-minted token + `api_token_id` — reuse the established path, do NOT hand-roll the token) with `type:'agent'`, slug `OPERATOR_AGENT_SLUG`, body `OPERATOR_PROMPT`, frontmatter `{ provider:'anthropic', model:'claude-sonnet-4-6', tools: OPERATOR_TOOLS, projects:['*'], requires_approval:false }`. **NOTE:** `createDocument` requires a `user` actor for `createdBy`; at boot there may be no user yet. Resolve: pass a system actor — either the first `__system` owner once designated, OR allow a null/`system` createdBy for boot-seeded docs. DECIDE in implementation: simplest is to run the agent-seed LAZILY (when the owner is designated, Task 5) rather than at pure boot, OR seed with `createdBy = null` if the schema allows (documents.created_by is nullable). Prefer: seed structure (ws + projects + skill/ref docs with createdBy null) at boot; seed the OPERATOR AGENT when an owner exists (it needs an actor for its token's createdBy). Document the split in a comment.
  - Ensure the skill doc (`folio` in `Skills`) + the setup-project ref (in `Reference`) exist: insert `page` docs with the bodies from `system-skills.ts` if absent (createdBy null acceptable for content).

> This task has a real decision (boot-time actor for the agent's token). The plan's recommended resolution: **structure + content at boot (createdBy null); operator agent seeded by `designateInstanceOwner` (Task 5) using the owner as actor.** That keeps the token's `createdBy` FK-valid. The implementer confirms `documents.created_by` + `api_tokens.created_by` nullability and picks the clean split; tests assert the agent exists AFTER an owner is designated.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/system-workspace.ts apps/server/src/lib/system-workspace.test.ts
git commit -m "phase-A: bootstrapSystemWorkspace — create __system + projects + content, idempotent, grants no membership (M4/M8)"
```

---

## Task 5: `designateInstanceOwner` — idempotent owner grant (+ seed the operator agent)

**Mitigations: M5, M8.**

**Files:**
- Modify: `apps/server/src/lib/system-workspace.ts` (add `designateInstanceOwner`)
- Test: `apps/server/src/lib/system-workspace.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
import { hashPassword } from './auth.ts';

test('designateInstanceOwner grants __system owner to an existing user, idempotently (M5/M8)', async () => {
  const { db } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  // create a user (existing-install case)
  const uid = nanoid();
  await db.insert(users).values({ id: uid, email: 'owner@x.com', name: 'Owner', passwordHash: await hashPassword('password123') });
  await designateInstanceOwner(db, 'owner@x.com');
  const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  const m = await db.query.memberships.findMany({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
  expect(m.length).toBe(1);
  expect(m[0]!.userId).toBe(uid);
  // idempotent
  await designateInstanceOwner(db, 'owner@x.com');
  const m2 = await db.query.memberships.findMany({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
  expect(m2.length).toBe(1);
});

test('designateInstanceOwner also ensures the operator agent exists (seeded with the owner as actor)', async () => {
  const { db } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  const uid = nanoid();
  await db.insert(users).values({ id: uid, email: 'o2@x.com', name: 'O2', passwordHash: await hashPassword('password123') });
  await designateInstanceOwner(db, 'o2@x.com');
  const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  const agent = await db.query.documents.findFirst({ where: and(eq(documents.workspaceId, sys!.id), eq(documents.type, 'agent')) });
  expect(agent).toBeDefined();
  // its auto-minted token exists (createdBy = the owner)
  const tok = await db.query.apiTokens.findFirst({ where: eq(apiTokens.agentId, agent!.id) });
  expect(tok).toBeDefined();
});

test('designateInstanceOwner is a no-op if an owner already exists (M5)', async () => {
  const { db } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  const a = nanoid(); const b = nanoid();
  await db.insert(users).values({ id: a, email: 'a@x.com', name: 'A', passwordHash: await hashPassword('password123') });
  await db.insert(users).values({ id: b, email: 'b@x.com', name: 'B', passwordHash: await hashPassword('password123') });
  await designateInstanceOwner(db, 'a@x.com');
  await designateInstanceOwner(db, 'b@x.com'); // must NOT replace a with b
  const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  const owners = await db.query.memberships.findMany({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
  expect(owners.length).toBe(1);
  expect(owners[0]!.userId).toBe(a); // first designation wins
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement `designateInstanceOwner(db, email)`:**
  - Resolve `__system` (must exist — call `bootstrapSystemWorkspace` first or assert). 
  - If `__system` already has an `owner` membership → return (no-op, first-wins).
  - Look up the user by email; if absent → throw a clear `INSTANCE_OWNER_NOT_FOUND` (the email must be a registered user).
  - Insert membership `(systemWs.id, user.id, 'owner')`.
  - Ensure the operator agent exists (the boot path left it unseeded — createdBy needs an actor): if absent, `createDocument({ type:'agent', slug: OPERATOR_AGENT_SLUG, ... }, { user })` so the agent + its token are created with the owner as `createdBy`. Idempotent (skip if the agent already exists).

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/system-workspace.ts apps/server/src/lib/system-workspace.test.ts
git commit -m "phase-A: designateInstanceOwner — idempotent owner grant + operator agent seed (M5/M8)"
```

---

## Task 6: Gate `POST /register` (first-user owner only behind the flag)

**Mitigations: M1.**

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Test: `apps/server/src/routes/auth.test.ts` (extend; read it for the register test pattern)

- [ ] **Step 1: Write the failing tests**

```typescript
test('first registration is rejected when bootstrap registration is off (M1)', async () => {
  // env FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=false (default), zero users
  const { app } = await makeTestApp({ noSeedUser: true }); // OR a db with zero users — see note
  const res = await app.request('/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('REGISTRATION_CLOSED');
});

test('first registration becomes __system owner when the flag is on (M1)', async () => {
  // env FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=true, zero users
  // (set the env in this test via the env-setup hook or a per-test override)
  ...
  expect(res.status).toBe(200);
  // the registrant is a __system owner
});

test('a SECOND registration never grants __system ownership (M1)', async () => {
  // with the flag on: register first (becomes owner), register second → second is NOT a __system owner
  ...
});
```

> **Note:** `makeTestApp` always seeds a user (`alice`). For the zero-users case you need a variant or a bare db. Read `harness.ts`; add a `noSeedUser?: boolean` option to `makeTestApp` if needed (small, backward-compatible) OR test `registerHandler` logic against a bare migrated db. The env flag is read from `env.ts`; override it per-test via the existing env-setup mechanism (`test/env-setup.ts`).

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — in the `/register` handler:
  - Count users. If this would be the FIRST user:
    - if `env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` is false → throw `HTTPError('REGISTRATION_CLOSED', 'instance owner must be set via FOLIO_INSTANCE_OWNER or enable FOLIO_ALLOW_BOOTSTRAP_REGISTRATION', 403)`.
    - if true → create the user, then `await bootstrapSystemWorkspace(db); await designateInstanceOwner(db, email)` so the first registrant becomes the instance owner.
  - If NOT the first user → existing behavior (create user, no `__system` grant).
  - (Non-first registrations are unchanged. Whether non-first open registration is allowed at all is an existing product behavior — Phase A does not change it beyond the first-user gate.)

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/auth.ts apps/server/src/routes/auth.test.ts apps/server/src/test/harness.ts
git commit -m "phase-A: gate first-user registration → instance owner behind FOLIO_ALLOW_BOOTSTRAP_REGISTRATION (M1)"
```

---

## Task 7: Wire bootstrap + owner-designation at boot

**Mitigations: M4, M5, M8 (wiring).**

**Files:**
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/index.test.ts` if one exists (else a focused boot-wiring test, or rely on Task 4/5 unit coverage + a manual boot note)

- [ ] **Step 1: Write/extend the boot test** — assert that after the boot sequence on a fresh db, `__system` exists; and if `FOLIO_INSTANCE_OWNER` is set to an existing user's email, that user is the `__system` owner. (If `index.ts` is hard to unit-test — it's the server entry — extract the boot sequence into a `runBootTasks(db, env)` function in a lib and test THAT, calling it from `index.ts`. Prefer the extraction so it's testable.)

```typescript
test('boot creates __system and designates the env owner', async () => {
  const { db } = await makeTestApp();
  // simulate an existing user as the configured owner
  const uid = nanoid();
  await db.insert(users).values({ id: uid, email: 'env-owner@x.com', name: 'EO', passwordHash: await hashPassword('password123') });
  await runBootTasks(db, { FOLIO_INSTANCE_OWNER: 'env-owner@x.com' });
  const sys = await db.query.workspaces.findFirst({ where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG) });
  const owner = await db.query.memberships.findFirst({ where: and(eq(memberships.workspaceId, sys!.id), eq(memberships.role, 'owner')) });
  expect(owner!.userId).toBe(uid);
});
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement** — extract `runBootTasks(db, env)` (in `system-workspace.ts` or a new `lib/boot.ts`) that calls `bootstrapSystemWorkspace(db)` then, if `env.FOLIO_INSTANCE_OWNER` is set + that user exists, `designateInstanceOwner(db, env.FOLIO_INSTANCE_OWNER)` (swallow + log "owner email not found" rather than crash boot). Call `runBootTasks(db, env)` in `index.ts` right after `runMigrationsOnBoot(db)`. Skip in `NODE_ENV=test` if the existing boot tasks do (match `runMigrationsOnBoot`'s test behavior) — but the EXTRACTED function is what tests call directly.

- [ ] **Step 4: Run to verify pass + tsc** — PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/lib/system-workspace.ts apps/server/src/lib/boot.test.ts
git commit -m "phase-A: wire bootstrapSystemWorkspace + designateInstanceOwner at boot (M4/M5/M8)"
```

---

## Task 8: Integration gate

**Files:** verification only.

- [ ] **Step 1: Full suites** — `cd apps/server && bun test` (0 fail), `cd packages/shared && bun test` (0 fail), `cd apps/web && npx vitest run` (web likely unaffected — confirm). tsc per app.
- [ ] **Step 2: Membership-gate confirmation (M6/M7)** — add/confirm a test: a non-`__system` member cannot read a `__system` document (existing membership gate, 403/empty); an agent bearer cannot POST `/workspaces` (`requireSessionUser`, 401/403). These pin M6/M7 (mostly no new code — they assert the boundary holds).
- [ ] **Step 3: `/integration`** then announce `/code-review high` over the Phase-A branch diff with this threat model (M1–M8) as input, then merge to the branch tip. (No `/shakeout` needed for Phase A — no real-key agent run yet; that lands with Phase B.)
- [ ] **Step 4: Commit** any gate-fix.

---

## Self-Review (run before dispatch)

**Spec coverage:** `__system` reserved + creation-protected (Tasks 1,2 — M2/M3), bootstrap create+seed idempotent + provenance-safe (Task 4 — M4/M8), owner designation on any install age (Task 5 — M5), gated first-registration (Task 6 — M1), boot wiring (Task 7), membership-gate + agent-can't-create confirmation (Task 8 — M6/M7), the `folio` skill + reference docs + operator agent in `__system` (Tasks 3,4,5). Cross-workspace execution + the definitional skill-load exemption are explicitly Phase B (not here). ✅

**Placeholder scan:** the test bodies have a few `// ... insert ...` / `...` markers where the implementer fills in the seeded rows from the named tables — these are deliberate "use the real schema imports" pointers, not TBDs; the surrounding assertions are concrete. The one real decision (boot-time actor for the agent's token, Task 4) is resolved with a recommended split (structure at boot, agent at owner-designation) + the implementer confirms nullability.

**Type consistency:** `SYSTEM_WORKSPACE_SLUG`, `isReservedSlug`, `assertSlugAllowed`, `bootstrapSystemWorkspace(db)`, `designateInstanceOwner(db, email)`, `runBootTasks(db, env)`, `OPERATOR_AGENT_SLUG`, `OPERATOR_TOOLS`, `FOLIO_SKILL_SLUG`/`_BODY` used consistently across tasks. The operator agent is created via `createDocument` (reuses the auto-minted token), NOT a hand-rolled token — consistent with the kept design.

**Biggest risk flagged:** the boot-time actor for the operator agent's token (Task 4/5). Resolved: seed the agent at owner-designation (real actor), not at pure boot. If the implementer finds `documents.created_by`/`api_tokens.created_by` are NON-nullable, the agent-at-owner-designation split is REQUIRED (not optional) — confirm first.

---

## Execution Handoff

Plan complete. Recommended: **subagent-driven** per task with two-stage review; controller verifies the named M-mitigation per task + ground-truths each task's dependency surface (the `ntdst-execute-with-tests` Step 2.5 gate). After Task 8: `/code-review high` (threat model M1–M8 as input), `/integration`, merge. Phase B (cross-workspace execution + the definitional skill-load exemption) is the next plan.
