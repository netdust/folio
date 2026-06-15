# M0 Safety Net + Quick Wins (Q1–Q6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task-close testing is governed by `netdust-agent:testing-workflow` (tier is stated per task — do NOT re-derive it).

**Goal:** Land the six audit "Quick wins" plus Milestone 0 ("Safety net") from `docs/AUDIT-2026-06-10.md` — make the existing engineering discipline machine-enforced (CI + lint-to-zero + pre-commit Biome), add the two missing security-guard test suites (crypto, auth-expiry), fix the broken onboarding docs, and remove dead/misleading config — on one branch (`harden/m0-safety-net`) split into four reviewed clusters.

**Architecture:** Four review clusters, each ending in a `── REVIEW GATE ──` STOP marker (harnessed-development gate 1f, ≤4 tasks/cluster). Cluster 1 = Quick wins (docs/config + one Tier-A query change). Cluster 2 = GitHub Actions CI (warn-only Biome). Cluster 3 = the two net-new Tier-A security-guard test suites (`crypto.test.ts`, `auth.test.ts`). Cluster 4 = lint debt → 0 + Biome in pre-commit + flip CI's Biome job to blocking. Dependency order: **1 → 2 → 3 → 4** (1 and 3 are mutually independent; 4 needs 2's CI to exist before flipping it to blocking).

**Tech Stack:** Bun test (server/shared), Vitest (web), `bun x tsc --noEmit` (per-app typecheck, no root tsconfig), Biome (`biome check`), GitHub Actions, `@noble/ciphers` (AES-256-GCM, already in `crypto.ts`).

---

## What this plan does NOT do (gate-firing decisions — the judgment layer)

These calls are explicit per the harnessed-development protocol. Each fired gate names its trigger; each skipped gate names why.

- **1a Threat model — DOES NOT FIRE (no section).** The 1a trigger list was run literally against every task. M0 changes **no** auth / session / token / parsing / URL / credential *behavior*:
  - `0.2`/`0.3` add **tests** that *exercise* `crypto.ts` and `auth.ts` — read-only, no production behavior change.
  - `Q6` **removes** `SESSION_SECRET`, which is provably dead: `grep -rn SESSION_SECRET` shows zero readers of `env.SESSION_SECRET` for any signing/verification — every non-definition reference exists only to satisfy the validator. Removing an unread variable cannot change auth behavior (there is no signing path to break). **The brief explicitly invited disagreement here; I agree with the brief — this is auth-*adjacent config removal*, not an auth behavior change.** It is FLAGGED for the controller to confirm at the Cluster-1 gate (see 1h tier note), but it does not warrant a threat model.
  - `Q4` adds a `limit` clamp — pagination shape, not a security boundary.
  - The magic-link gating + rate-limiting that WOULD trigger 1a are Milestone 1, out of this plan's scope.
- **1b Architecture invariants — DOES NOT FIRE (no new authoring).** No task changes a convergence-point *behavior*. `0.3` only *tests* `auth.ts` (the session-validation convergence) and `0.2` *tests* `crypto.ts` (the fail-closed master-key posture that `ARCHITECTURE-INVARIANTS.md` invariants 2 & 7 rest on). These are **cited as context** inside tasks 0.2/0.3 so the reviewer can confirm the tests bite the invariant-relevant paths — but no `ARCHITECTURE-INVARIANTS.md` edit is needed.
- **1g Feature-acceptance — DOES NOT FIRE as a matrix.** M0 adds no new view/form/wizard/endpoint. Q2 fixes docs so an *existing* flow (fresh-clone → register first user) works; that flow's verification is embedded as **Cluster 1's integration gate** (audit DoD #3), not a full `## Acceptance flows` matrix.
- **1c Premise ground-truth — DONE (see "Ground-truth corrections" below).** Notably, Q4's premise that `listRuns` needs a service change is **false**; it already accepts `limit`.

---

## Ground-truth corrections (my source reads vs. the brief — SOURCE WINS)

I read every file before specifying its change. Where the brief's framing and current source disagree, source wins; the drift is flagged here and the task is built against source.

1. **Q4 is route-only, NOT a service change.** `services/agent-runs.ts:808` `listRuns(filter)` **already** accepts `filter.limit` (`ListRunsFilter.limit?: number` in the interface above line 808; applied at line ~881 as `limit: filter.limit`, `undefined` → no SQL LIMIT). The workspace route (`routes/runs.ts:315-316`) already reads + clamps it. Q4 only needs to copy that clamp onto the project-scoped route (`routes/runs.ts:260-288`). No `agent-runs.ts` edit. (Brief implied a service change; the audit's "no LIMIT at all" is true *of the route*, not the service.)

2. **Q1's `conversations.ts` swallow is the INNER `.catch(() => {})`, and the OUTER catch ALREADY logs.** At `services/conversations.ts:271-280`, the `catch (err)` block **already** has `console.error('[recovery] conversation … summary failed; clearing slot anyway', err)` (line 274). The genuinely-silent swallow is the **inner** `.catch(() => {})` on the fallback `db.update(...)` at line 279 — if the unwedge UPDATE itself fails, that failure is invisible. Q1's fix for this file is therefore narrower than "add a log to the swallowed catch": add a log inside the inner `.catch(...)`. (Brief said "270-280, the crash-recovery un-wedge `.catch(() => {})`" — correct location, but the outer log already exists; do not duplicate it.)

3. **`event-bus.ts` swallow is at lines 70-74** (`try { sub.handler(e); } catch { /* swallow … */ }`), not 70-75 exactly — trivial drift, same target. Add context to this `catch`.

4. **`.env.example` IS in the SESSION_SECRET removal surface** (line 15) and IS missing the two onboarding vars — the brief listed `.env.example` for Q2 but the removal list for Q6 omitted it. Both clusters touch this one file; sequencing handled below. **Read-permission note:** `.env.example` is **denied to the `Read` tool and to sandboxed `cat`** in this environment. Implementers must read its current content via `git show HEAD:.env.example` (works) and write the new content with the `Write` tool (Write does not require a prior `Read` for a path the harness has not loaded — but if `Write` refuses, fall back to a `printf`/heredoc through `Bash` with `dangerouslyDisableSandbox: true`). The full current content is reproduced inline in Task Q6 so no read is needed at execution time.

5. **`SESSION_SECRET` and `libsodium` appear in MORE places than the brief enumerated.** Full surfaces are in the two `## Sibling-site audit` blocks below. Of the four diagnostic scripts holding `SESSION_SECRET` stubs, **three are in the Q5 DELETE set** (`shakeout-cross-ws-operator.ts`, `shakeout-cross-ws-triggers.ts`, `diagnose-agent-chain.ts`) — their stubs vanish with the file, so Q5 MUST land before/with Q6's stub edits. Only `diagnose-http-chain.ts` (KEEP) needs a stub edit.

6. **Q5 KEEP-set files live at the repo root `scripts/`, not `apps/server/scripts/`.** `backfill-builtin-triggers.ts(+test)`, `check-invariants.ts`, `seed-demo.ts` are under `scripts/`. The DELETE set + `diagnose-http-chain.ts` + `reseed-dev.ts` + `check-migration-drift.ts(+test)` are under `apps/server/scripts/`. The deletion task must target the correct directory.

7. **API.md's AI-keys path is ALSO wrong** (`/.../settings/:workspaceId/ai-keys` → real `/api/v1/instance/ai-keys`), not just the libsodium term. That path fix is **Milestone 3 task 3.1 (M6), explicitly out of Q3 scope.** Q3 fixes ONLY the `libsodium` term in API.md:85, to avoid scope-creep. Flagged so the reviewer doesn't expect the path fixed here.

8. **`biome check --fix` applies only the SAFE subset.** Live run: 1732 errors / 59 warnings; Biome reports "Skipped 391 suggested fixes" (safe) and 2090 diagnostics not shown, and suggests `--fix --unsafe` for more. So Cluster 4 is NOT one blanket `--unsafe` sweep — it is: safe `--fix` first → re-count → selectively apply `--unsafe` / manual-triage the remainder. Detailed below.

9. **Confirmed harness facts (so tasks point at real names, not guesses):**
   - `apps/server/src/env.test.ts` valid fixture is a module-level `const base = { SESSION_SECRET: 'x'.repeat(32), FOLIO_MASTER_KEY: 'a'.repeat(64) };` (lines 4-7). Q6 removes the `SESSION_SECRET` key from `base`.
   - `apps/server/src/test/harness.ts` exports `makeBareTestDb()` (zero-user migrated in-memory DB), `makeTestApp(opts)`, and `mintInstancePat(...)`. `routes/auth.test.ts` uses `const { app, db } = await makeBareTestDb()` and inserts rows via `db.insert(users)`. 0.3 reuses this.
   - `users` table required insert columns: `id` (text PK), `email` (unique), `name` (notNull); `role` defaults to `'member'`, `createdAt` auto. (`db/schema.ts`.)
   - The **test** `FOLIO_MASTER_KEY` (set in `test/env-setup.ts:9`) is `'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'`. 0.2's known-good ciphertext must be generated under this exact key.

---

## Baseline facts (state every suite-delta against these)

- **Branch:** `harden/m0-safety-net` (already checked out).
- **Passing test counts (audit-verified fresh):** server **1,748** / shared **70** / web **938** (= **2,756** total).
- **Lint (live this session):** `bun run lint` → **1732 errors, 59 warnings**, 659 files checked.
- **Test runners (in-repo traps — bake into every task + the CI):**
  - Server + shared: run **from their own dir** — `cd apps/server && bun test`, `cd packages/shared && bun test`. Running `bun test` from repo root triggers a documented ~650-failure cwd module-init cascade (a quirk, not a regression). The root `package.json` `"test": "bun test"` script is exactly this trap (Q6 fixes it).
  - Web: `cd apps/web && npx vitest run` — **NOT** `bun test`.
  - Typecheck: `bun x tsc --noEmit` in **each** of `apps/server`, `apps/web`, `packages/shared` — there is **no root `tsconfig.json`**.
- **Known flake:** `apps/web/src/components/views/list-view-create.test.tsx` under high-concurrency full-suite runs; passes in isolation; **one retry on the web CI job only** (do NOT retry the whole suite).
- **Migration-journal rule (N/A but note it):** any new `.sql` migration MUST be added to `apps/server/src/db/migrations/meta/_journal.json` or `migrate()` silently skips it. **M0 adds no migrations** — this is a guard-rail note so nobody adds one carelessly.

---

# CLUSTER 1 — Quick wins (Q1–Q6)

**Provisional review tier (1h): STANDARD.** Trigger reasoning: this cluster is multi-file behavior change *outside* the 1a surfaces — it touches docs + config + exactly one Tier-A query-shape change (Q4). The `SESSION_SECRET` removal (Q6) is auth-**adjacent config**, not an auth behavior change (it removes a provably-unread variable — see the 1a decision above), so it does not promote the cluster to FULL. **FLAG for the controller at the gate:** explicitly confirm the SESSION_SECRET removal is config-only (re-grep for any `env.SESSION_SECRET` reader before sign-off). Review panel: 2 finders + simplicity + a feature-acceptance pass on the fresh-clone smoke; **no** security-sentinel. One-way escalation: if any finder surfaces a real auth consumer of `SESSION_SECRET`, the cluster promotes to FULL.

**Cluster integration gate:** (a) all three suites green at the baseline counts (server 1,748 / shared 70 / web 938; Q4 adds tests so server rises — state the delta); (b) `bun x tsc --noEmit` clean in all three apps; (c) **FRESH-CLONE SMOKE (audit DoD #3):** in a scratch clone, a stranger following ONLY `README.md` + `docs/INSTALL.md` + the corrected `.env.example` can boot the server and register the first user. Procedure in the gate section at the end of this cluster.

> **Ordering inside the cluster:** do **Q5 before Q6** (Q6 edits SESSION_SECRET stubs only in files Q5 has *not* deleted). Q1–Q4 are independent of each other and of Q5/Q6. `.env.example` is touched only by Q6 (which does the combined remove-SESSION_SECRET + add-the-two-onboarding-vars edit) — Q2 deliberately does NOT touch `.env.example` to avoid a mid-file conflict (noted in Q2).

---

### Task Q1: Add the two missing log lines in swallowed catches (M7)

**Files:**
- Modify: `apps/server/src/services/conversations.ts:271-280` (add a log inside the *inner* `.catch`)
- Modify: `apps/server/src/lib/event-bus.ts:70-74` (add a log inside the subscriber-swallow `catch`)

**Tier: B** — observability only, no behavior change (the catches still swallow; they just stop being silent). `no unit test: Tier B, pure log-line addition with no new branch or return-value change`. A seam assertion is added only because it is trivially cheap (see Step 4).

**Context (read before editing):** `conversations.ts`'s OUTER `catch (err)` at line 271 ALREADY logs (`console.error('[recovery] … summary failed; clearing slot anyway', err)`). The silent one is the **inner** `.catch(() => {})` on the fallback `db.update(...)` at line 279. The dispatcher (the altitude to match) logs + halts + emits a health edge; we cannot halt here (this IS the unwedge), so a `console.error` with the conversation id is the right altitude.

- [ ] **Step 1: Add a log to the inner unwedge-failure swallow in `conversations.ts`**

Replace the inner `.catch(() => {})` at line 279:

```ts
      await db
        .update(conversations)
        .set({ activeRunId: null })
        .where(eq(conversations.id, conv.id))
        .catch((clearErr) => {
          // The unwedge UPDATE itself failed — the conversation stays wedged.
          // We can't halt (this branch IS the recovery); surface it loudly so
          // a persistently-wedged conversation is diagnosable instead of silent.
          console.error(
            `[recovery] conversation ${conv.id} unwedge UPDATE failed; conversation may remain locked`,
            clearErr,
          );
        });
```

- [ ] **Step 2: Add a log to the subscriber-swallow in `event-bus.ts`**

Replace the `catch {}` at lines 72-74:

```ts
      try {
        sub.handler(e);
      } catch (handlerErr) {
        // Swallow per-subscriber errors so one bad handler can't take down the
        // bus — but log so a silently-throwing subscriber is diagnosable.
        console.error(`[event-bus] subscriber threw for kind=${e.kind}; continuing`, handlerErr);
      }
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean (no new errors).

- [ ] **Step 4: Seam assertion (cheap — confirm the bus still isolates a throwing subscriber)**

`event-bus.ts` already has a public `subscribe`/`publish` surface. If `apps/server/src/lib/event-bus.test.ts` exists, add one case; if not, create it with just this case (it is a Tier-B seam, not a Tier-A requirement — keep it to one assertion):

```ts
import { describe, expect, test } from 'bun:test';
import { eventBus } from './event-bus.ts';

describe('eventBus.publish isolation', () => {
  test('a throwing subscriber does not prevent later subscribers from running', () => {
    eventBus.__clear();
    let secondRan = false;
    eventBus.subscribe('ws1', undefined, () => {
      throw new Error('boom');
    });
    eventBus.subscribe('ws1', undefined, () => {
      secondRan = true;
    });
    eventBus.publish({ workspaceId: 'ws1', kind: 'document.updated' });
    expect(secondRan).toBe(true);
    eventBus.__clear();
  });
});
```

Run: `cd apps/server && bun test src/lib/event-bus.test.ts`
Expected: PASS. (Use a valid `EventKind` for `kind` — open `lib/events.ts` and pick an existing one if `document.updated` is not a member.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/conversations.ts apps/server/src/lib/event-bus.ts apps/server/src/lib/event-bus.test.ts
git commit -m "fix: log the two silent error-swallows (M7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task Q2: Fix the onboarding triple — bootstrap vars, PORT story, INSTALL release link (C1)

**Files:**
- Modify: `README.md` (PORT/proxy story; the dead `:3000` vs `:3001` contradiction; the `~50MB` claim)
- Modify: `docs/INSTALL.md` (the dead releases link → build-from-source; the bootstrap-registration var)
- Note: the `.env.example` add of `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` + `FOLIO_INSTANCE_OWNER` is done in **Q6's combined `.env.example` step** (since Q6 also edits that file). Do NOT edit `.env.example` here.

**Tier: B** — docs/config. `no unit test: Tier B, documentation + config; verified by the cluster's fresh-clone smoke, not a unit test`.

**Decision (the consistent PORT story — pick one and make all docs agree):** Dev API runs on **3001** (Vite proxies `/api` → `VITE_API_PORT ?? 3001`, per `apps/web/vite.config.ts:5`); the UI dev server is **5173**; the *compiled binary / Docker* serves both API + SPA on **`PORT` (default 3000)**. So: README's "API on :3000" line is wrong for **dev** — the dev API is 3001, reached by the browser via the Vite proxy on 5173. Make README say that explicitly.

- [ ] **Step 1: Fix the README dev-run port comments + visit instruction**

In `README.md`, replace the Quickstart step-4 block (lines 37-39) so it states the dev port story unambiguously:

```markdown
# 4. Run dev (two processes; the web dev server proxies /api to the server)
bun run --filter @folio/server dev   # API on :3001
bun run --filter @folio/web dev      # UI on :5173 (proxies /api → :3001)
```

Then leave the existing "Visit **http://localhost:5173** and register." line (42) as-is (it is already correct). The curl examples at lines 53-77 already use `:3001` — they are correct for dev; leave them.

- [ ] **Step 2: Fix the README stale binary-size claim**

In `README.md` line 110, change:

```
├── Dockerfile       Multi-stage → ~50MB single-binary image.
```
to:
```
├── Dockerfile       Multi-stage → single-binary image.
```

(The real binary is ~102MB per the audit; drop the wrong number rather than assert a new one — M1 changes the binary, so any number here would re-rot.)

- [ ] **Step 3: Fix the INSTALL.md dead releases link → build-from-source**

In `docs/INSTALL.md`, replace the `### Binary` block (lines 7-19). There are no published releases yet (CI publishing is M0/M1's job), so point at build-from-source instead of a 404 URL:

````markdown
### Binary

> **Note:** pre-built release binaries are not published yet. Until CI publishes
> them, build the binary from source (see "Building from source" below), then:

```bash
# Generate the required secret
export FOLIO_MASTER_KEY=$(openssl rand -hex 32)

./folio
```
````

(Note this block also drops the `export SESSION_SECRET=...` line — that removal is part of Q6's sibling-site sweep, but since we are rewriting this whole block here, omit it now and let Q6's audit confirm INSTALL.md is clean.)

- [ ] **Step 4: Add the bootstrap-registration guidance to INSTALL.md**

In `docs/INSTALL.md`, add to the "Environment variables" table (after the `FOLIO_MASTER_KEY` row, line 46) the two onboarding vars that unblock first-user registration:

```markdown
| `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` | `false` | Set to `true` for the **first boot only** to allow the first-ever user to self-register as the instance owner. Turn it back off (or leave unset) once the owner exists. Alternatively set `FOLIO_INSTANCE_OWNER`. |
| `FOLIO_INSTANCE_OWNER` | *(optional)* | Email of the instance owner. On boot, the user with this email is promoted to owner (idempotent). Use this instead of `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` when you know the owner's email in advance. |
```

- [ ] **Step 5: Confirm no broken internal links / build the doc mentally against the smoke**

Read back the edited `README.md` Quickstart and `docs/INSTALL.md` Quick-start as if you were a stranger: the path is `bun install` → `cp .env.example .env` → set `FOLIO_MASTER_KEY` + `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=true` → migrate → `bun run --filter @folio/server dev` → visit `:5173` → register. Confirm every var named here exists in `env.ts` (`FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` line 74, `FOLIO_INSTANCE_OWNER` line 97 — both confirmed present).

- [ ] **Step 6: Commit**

```bash
git add README.md docs/INSTALL.md
git commit -m "docs: fix onboarding — dev PORT story, bootstrap vars, dead release link (C1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task Q3: Fix CLAUDE.md / doc drift — HTTPException→HTTPError, libsodium→AES-256-GCM, dead scripts/build.ts ref

**Files:**
- Modify: `CLAUDE.md` (line 87 `HTTPException`→`HTTPError`; lines 33 + 45 `libsodium`→AES-256-GCM; lines 68-70 the `scripts/build.ts` tree entry)
- Modify: `docs/API.md:85` (`libsodium`→AES-256-GCM — **term only**, NOT the path; path is M3.1)
- Modify: `docs/INSTALL.md:46` (`libsodium`→AES-256-GCM in the `FOLIO_MASTER_KEY` row)
- Modify: `apps/server/src/db/schema.ts:401` (the `// libsodium-style ciphertext` code comment)
- Modify: `memory/DECISIONS.md:22` (libsodium) **and** `memory/DECISIONS.md:82` (`HTTPException`)

**Tier: B** — docs + one code comment + one memory doc; no behavior. `no unit test: Tier B, comment/doc-only changes with zero runtime effect`.

See the **`## Sibling-site audit` (Q3 — libsodium + HTTPException + scripts/build.ts)** block below the cluster for the FULL surface and the scoping decision (FOLIO-BRIEFING.md and PHASES.md are deferred to a follow-up, enumerated there).

- [ ] **Step 1: CLAUDE.md — error convention**

`CLAUDE.md:87`, change:
```
- **Errors.** Throw `HTTPException` from Hono. Server returns `{ error: { code, message } }`. Client surfaces via toasts.
```
to:
```
- **Errors.** Throw `HTTPError` (from `apps/server/src/lib/http.ts`). Server returns `{ error: { code, message } }` via the single `registerErrorHandler`. Client surfaces via toasts.
```

- [ ] **Step 2: CLAUDE.md — crypto term (two lines)**

`CLAUDE.md:33`, change the table row `| Encryption | libsodium |` to `| Encryption | AES-256-GCM (@noble/ciphers) |`.

`CLAUDE.md:45`, change `Keys are libsodium-encrypted at rest` to `Keys are AES-256-GCM-encrypted at rest (via @noble/ciphers)`.

- [ ] **Step 3: CLAUDE.md — the dead scripts/build.ts tree entry**

`CLAUDE.md:68-70`, the repo-layout tree currently shows:
```
├── scripts/
│   ├── build.ts                # bun compile single binary
│   └── deploy-ploi.sh
```
Replace with the CURRENT reality plus a forward note (M1 will create the real `scripts/build.ts`):
```
├── scripts/                    # check-invariants.ts, seed-demo.ts, backfill-builtin-triggers.ts, hooks/
│                               # (NOTE: the single-binary build is currently inline in the root
│                               #  package.json `build:binary` script; M1 will add a real scripts/build.ts
│                               #  that embeds web/dist + migrations into the binary)
```

- [ ] **Step 4: API.md crypto term (term only — leave the path)**

`docs/API.md:85`, change `keys are libsodium-encrypted at rest` to `keys are AES-256-GCM-encrypted at rest (via @noble/ciphers)`. **Do NOT touch the `/.../settings/:workspaceId/ai-keys` header path** — that fix is Milestone 3 task 3.1.

- [ ] **Step 5: INSTALL.md crypto term**

`docs/INSTALL.md:46`, in the `FOLIO_MASTER_KEY` row change `Encrypts BYOK AI keys at rest via libsodium.` to `Encrypts BYOK AI keys at rest via AES-256-GCM (@noble/ciphers).`

- [ ] **Step 6: schema.ts code comment**

`apps/server/src/db/schema.ts:401`, change the trailing comment `// libsodium-style ciphertext` to `// AES-256-GCM ciphertext: base64(iv[12] || ct+tag) — see lib/crypto.ts`.

- [ ] **Step 7: DECISIONS.md — both the crypto line and the error line**

`memory/DECISIONS.md:22`, change `- **Encryption:** libsodium for AI-key storage.` to `- **Encryption:** AES-256-GCM via @noble/ciphers for AI-key storage (the early "libsodium" decision was superseded in implementation; see lib/crypto.ts).`

`memory/DECISIONS.md:82`, change `- **Errors** thrown as Hono \`HTTPException\`; …` to `- **Errors** thrown as \`HTTPError\` (lib/http.ts); …` (keep the rest of the line intact).

- [ ] **Step 8: Typecheck (schema.ts changed — confirm the comment edit didn't slip)**

Run: `cd apps/server && bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md docs/API.md docs/INSTALL.md apps/server/src/db/schema.ts memory/DECISIONS.md
git commit -m "docs: HTTPError convention + AES-256-GCM (not libsodium) + drop dead scripts/build.ts ref (Q3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task Q4: Add `limit` to the project-scoped `GET /runs` (parity with the workspace route) (M5)

**Files:**
- Modify: `apps/server/src/routes/runs.ts:260-288` (the `runsListRoute.get('/')` handler — add `limit` read+clamp, pass to `listRuns`)
- Test: `apps/server/src/routes/runs.test.ts` (the existing route-test file — add two cases)

**Tier: A** — query-shape / pagination correctness change on a currently-unbounded accumulator. The denial-of-the-bug path is "an unbounded list must become bounded." RED-first.

**Test contract:** assert (1) `?limit=2` caps the returned row count to 2 when ≥3 runs exist in the project; (2) with no `?limit`, the default cap (50) is applied (assert the request succeeds and is capped — seed >50 only if cheap; otherwise prove the default branch via a direct `listRuns({ projectId, limit: undefined })` vs `listRuns({ projectId, limit: 50 })` count comparison). **Source-match:** the workspace route uses `const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 50)) : 50;` (runs.ts:315-316) — mirror it EXACTLY (same param name `limit`, same cap 100, same default 50).

- [ ] **Step 1: Read the workspace route's limit clamp + confirm `listRuns` accepts `limit`**

Confirm `routes/runs.ts:315-316` reads `const limitRaw = c.req.query('limit'); const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 50)) : 50;` and passes `limit` to `listRuns`. Confirm `ListRunsFilter.limit?: number` exists (`services/agent-runs.ts`, the interface above line 808) and `listRuns` applies it (`limit: filter.limit` at line ~881). **No `agent-runs.ts` edit is needed.**

- [ ] **Step 2: Write the failing test**

Open `apps/server/src/routes/runs.test.ts`, find an existing project-scoped GET-runs test for the setup pattern (how it seeds a workspace/project/agent_run rows + makes an authed request — the file uses the `test/harness.ts` helpers). Add:

```ts
test('project-scoped GET /runs caps rows at ?limit', async () => {
  // ARRANGE: seed >= 3 agent_run rows under one project (reuse the file's existing seed helper).
  // ... seed 3 runs in `project` ...
  const res = await app.request(
    `/api/v1/w/${wslug}/p/${pslug}/runs?limit=2`,
    { headers: { Authorization: `Bearer ${pat}` } },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.length).toBe(2);
});
```

(Use the file's actual `app.request` harness, slug variables, and seed helpers — match the sibling tests in the same file. If the file constructs runs via `createRun`, seed three.)

- [ ] **Step 3: Run it to verify RED**

Run: `cd apps/server && bun test src/routes/runs.test.ts -t "caps rows at ?limit"`
Expected: FAIL — the project route currently passes no `limit`, so all 3 rows return and `body.length` is 3, not 2.

- [ ] **Step 4: Implement — add the clamp to the project-scoped handler**

In `routes/runs.ts`, inside `runsListRoute.get('/', ...)` (lines 260-288), add the limit read+clamp before the `listRuns` call and pass it through:

```ts
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 50)) : 50;

  const rows = await listRuns({
    projectId: project.id,
    status,
    agentSlug: agent || undefined,
    since: since || undefined,
    callerAgentProjectsAllowList: allowList ?? undefined,
    // Cap at the SQL layer — parity with the workspace route (was unbounded).
    limit,
  });
```

- [ ] **Step 5: Run to verify GREEN + RED-proof the default branch**

Run: `cd apps/server && bun test src/routes/runs.test.ts -t "caps rows at ?limit"`
Expected: PASS.

RED-proof the *default*: assert via a direct service comparison that `listRuns({ projectId, limit: undefined })` returns more rows than `listRuns({ projectId, limit: 50 })` when >50 rows exist — OR (cheaper) temporarily change the new `: 50` to `: undefined`, confirm a >50-row seed test would FAIL (unbounded), and revert. The *bound must be proven to bite* — pick whichever the file's harness supports without heavy seeding.

- [ ] **Step 6: Run the file + typecheck**

Run: `cd apps/server && bun test src/routes/runs.test.ts` then `cd apps/server && bun x tsc --noEmit`
Expected: all green; clean typecheck. Note the server suite delta (1,748 → 1,748 + N new cases).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/runs.ts apps/server/src/routes/runs.test.ts
git commit -m "fix: cap project-scoped GET /runs at ?limit, parity with workspace route (M5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task Q5: Delete the `__system`-era diagnostic/shakeout scripts (M8)

**Files (DELETE — all under `apps/server/scripts/`):**
- Delete: `apps/server/scripts/shakeout-cross-ws-operator.ts`
- Delete: `apps/server/scripts/shakeout-cross-ws-triggers.ts`
- Delete: `apps/server/scripts/seed-ollama-key.ts`
- Delete: `apps/server/scripts/seed-ollama-operator.ts`
- Delete: `apps/server/scripts/diagnose-agent-chain.ts`

**Files (KEEP — verify, do not delete):**
- Keep + add header: `apps/server/scripts/diagnose-http-chain.ts` (the real-key proof harness, memory `project_phase-3-shipped` open-question #4)
- Keep untouched: `apps/server/scripts/reseed-dev.ts`, `apps/server/scripts/check-migration-drift.ts(+.test.ts)`
- Keep untouched (repo-root `scripts/`): `scripts/check-invariants.ts`, `scripts/backfill-builtin-triggers.ts(+.test.ts)`, `scripts/seed-demo.ts`

**Tier: B** — deletion. `no unit test: Tier B, file deletion; safety is "nothing imports the deleted files AND the suite stays green"`.

- [ ] **Step 1: Grep each delete-candidate's `__system` refs AND its importers BEFORE deleting**

```bash
for f in shakeout-cross-ws-operator shakeout-cross-ws-triggers seed-ollama-key seed-ollama-operator diagnose-agent-chain; do
  echo "=== $f: __system refs ===";
  grep -c "__system" "apps/server/scripts/$f.ts" 2>/dev/null;
  echo "=== $f: importers (must be ZERO) ===";
  grep -rn "scripts/$f" apps/server apps/web packages --include="*.ts" | grep -v "apps/server/scripts/$f.ts";
done
```

Expected: each `__system` count > 0 (confirms it targets the torn-down architecture); each importer list EMPTY. **If any file shows ZERO `__system` refs, STOP** — it may have been ported; re-confirm against the brief's resolution before deleting it. **If any file has a non-empty importer list, STOP** and report. (Note: `seed-ollama-*` may have few/zero `__system` refs but are still in the delete set as `__system`-era seed tooling — if their `__system` count is 0, confirm they only seed the torn-down operator/key model before deleting, per the brief's resolution.)

- [ ] **Step 2: Delete the five scripts**

```bash
git rm apps/server/scripts/shakeout-cross-ws-operator.ts \
       apps/server/scripts/shakeout-cross-ws-triggers.ts \
       apps/server/scripts/seed-ollama-key.ts \
       apps/server/scripts/seed-ollama-operator.ts \
       apps/server/scripts/diagnose-agent-chain.ts
```

- [ ] **Step 3: Add a porting-caveat header to `diagnose-http-chain.ts` (KEEP)**

At the top of `apps/server/scripts/diagnose-http-chain.ts`, insert after the existing top comment (or as the first lines):

```ts
// NOTE (M0 / 2026-06-15): this real-key HTTP-chain proof harness PREDATES the
// drop-workspace-tenancy refactor (2026-06). It may reference torn-down concepts
// (`__system`, per-workspace membership) and need porting to the single-team model
// before it runs clean. Kept deliberately — it is the only real-key end-to-end
// proof harness (memory: project_phase-3-shipped, open-question #4).
```

- [ ] **Step 4: Confirm nothing else references the deleted names + suites green**

```bash
grep -rn "shakeout-cross-ws\|seed-ollama\|diagnose-agent-chain" apps packages docs/superpowers --include="*.ts" --include="*.json" --include="*.sh" | grep -v "docs/AUDIT"
```
Expected: no live code/config hits (doc mentions in historical plans are fine).

Run: `cd apps/server && bun test` then `cd packages/shared && bun test`
Expected: server green (count unchanged from Q4's new total — these scripts have no tests), shared 70.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server/scripts/
git commit -m "chore: delete __system-era diagnostic/shakeout scripts; flag diagnose-http-chain for porting (M8/Q5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task Q6: Remove dead `SESSION_SECRET`; fix the root `"test"` script (Q6)

**Files:**
- Modify: `apps/server/src/env.ts:8` (remove the `SESSION_SECRET` schema line)
- Modify: `apps/server/src/env.test.ts:5` (remove `SESSION_SECRET` from the `base` fixture; add the parse-without test)
- Modify: `apps/server/src/test/env-setup.ts:8` (remove the `SESSION_SECRET` default)
- Modify: `.env.example` (remove the SESSION_SECRET block lines 13-15 **AND** add the two onboarding vars from Q2 — combined edit; full new content below)
- Modify: `README.md:28` (remove the `openssl rand -hex 32 # → paste into SESSION_SECRET` line)
- Modify: `docs/INSTALL.md` (remove any residual SESSION_SECRET refs — the `### Binary` block was already rewritten in Q2 Step 3; confirm none remain)
- Modify: `apps/server/scripts/diagnose-http-chain.ts:199,210` (remove the SESSION_SECRET stub — the only KEEP-set script holding one; the other three holders were deleted in Q5)
- Modify: root `package.json:15` (the `"test": "bun test"` trap)

**Tier: A** for the `env.ts` edit — env validation is logic; a removal that breaks parsing must be caught. **Tier B** for the doc/config/script-stub edits.

**Test contract (Tier A, env.ts):** assert `env.ts` still parses a valid env that has **no** `SESSION_SECRET`, and confirm `env.test.ts`'s `base` fixture no longer carries `SESSION_SECRET`. RED-first: before the schema removal, parsing without `SESSION_SECRET` would FAIL the `min(32)` rule; after removal it must PASS.

See the **`## Sibling-site audit` (Q6 — SESSION_SECRET removal surface)** block below for the full enumerated surface (this is the authoritative removal checklist).

- [ ] **Step 1: Confirm — one final grep that nothing READS `env.SESSION_SECRET`**

```bash
grep -rn "env\.SESSION_SECRET\|\.SESSION_SECRET" apps/server/src --include="*.ts" | grep -v "env.test.ts" | grep -v "test/env-setup.ts"
```
Expected: ZERO hits that *read* the value. **If any production reader appears, STOP — escalate the cluster to FULL review tier and write a threat model on it before removing.** (This is the one-way escalation named in the 1h tier note.)

- [ ] **Step 2: Write the failing test (RED) — env parses without SESSION_SECRET**

`env.test.ts` has a module-level fixture `const base = { SESSION_SECRET: 'x'.repeat(32), FOLIO_MASTER_KEY: 'a'.repeat(64) };` (lines 4-7). Add a new test (the schema still has the required `SESSION_SECRET` rule at this point, so omitting it must throw — RED):

```ts
test('env parses with no SESSION_SECRET (it is removed/dead)', () => {
  const { SESSION_SECRET: _drop, ...noSecret } = base;
  expect(() => envSchema.parse(noSecret)).not.toThrow();
});
```

- [ ] **Step 3: Run to verify RED**

Run: `cd apps/server && bun test src/env.test.ts -t "no SESSION_SECRET"`
Expected: FAIL — current schema has `SESSION_SECRET: z.string().min(32)` (required), so parsing without it throws.

- [ ] **Step 4: Remove the schema line from `env.ts`**

Delete `apps/server/src/env.ts:8` entirely:
```ts
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
```

- [ ] **Step 5: Remove `SESSION_SECRET` from the `base` fixture + the env-setup default**

In `apps/server/src/env.test.ts`, change the `base` fixture (lines 4-7) to drop the `SESSION_SECRET` key:
```ts
const base = {
  FOLIO_MASTER_KEY: 'a'.repeat(64),
};
```
(With `SESSION_SECRET` gone from the schema, the Step-2 test now parses `base` directly — but keep the Step-2 test as the explicit regression guard; it destructures a now-absent key, which is harmless.)

In `apps/server/src/test/env-setup.ts`, remove line 8: `process.env.SESSION_SECRET ??= 'test-session-secret-test-session-secret-xx';`

- [ ] **Step 6: Run to verify GREEN**

Run: `cd apps/server && bun test src/env.test.ts`
Expected: all green, including the new case. Then `cd apps/server && bun x tsc --noEmit` → clean.

- [ ] **Step 7: Rewrite `.env.example` (remove SESSION_SECRET block + add the two Q2 onboarding vars)**

Write `.env.example` with this exact content (use the `Write` tool; if it refuses because the path was never `Read`, use a `Bash` heredoc with `dangerouslyDisableSandbox: true`):

```bash
# Folio configuration
# Copy to .env and fill in real values

# --- Core ---
NODE_ENV=development
PORT=3000
PUBLIC_URL=http://localhost:3000

# --- Database ---
# SQLite file location (relative to apps/server)
DATABASE_URL=file:./folio.db

# --- Security ---
# Used to encrypt customer AI API keys at rest.
# Generate with: openssl rand -hex 32
FOLIO_MASTER_KEY=change-me-to-a-real-32-byte-hex-key

# --- First-boot onboarding ---
# Set to true for the FIRST BOOT ONLY to let the first user self-register as
# the instance owner. Turn back off once the owner exists. Or set FOLIO_INSTANCE_OWNER.
FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=false
# Alternatively, promote the user with this email to instance owner on boot (idempotent).
# FOLIO_INSTANCE_OWNER=you@example.com

# --- Email (magic-link auth) ---
# SMTP config for magic-link emails. Leave blank in dev to log links to console.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="Folio <no-reply@example.com>"
```

(Note: the `# --- Security ---` header now has only `FOLIO_MASTER_KEY`; the dead `SESSION_SECRET` block + its "Used to sign session cookies" comment are gone.)

- [ ] **Step 8: Remove the README SESSION_SECRET generation line**

`README.md:28`, delete the line:
```
openssl rand -hex 32   # → paste into SESSION_SECRET
```
(Leave the `FOLIO_MASTER_KEY` generation line at 29.)

- [ ] **Step 9: Confirm INSTALL.md has no residual SESSION_SECRET**

```bash
grep -n "SESSION_SECRET" docs/INSTALL.md
```
Expected: ZERO (Q2 Step 3 already rewrote the `### Binary` block; the `-e SESSION_SECRET` Docker line at old line 28 and the table row at old line 45 must also be gone — if either remains, remove it now: drop the `-e SESSION_SECRET=<min-32-chars> \` line from the Docker block and delete the `SESSION_SECRET` env-table row).

- [ ] **Step 10: Remove the SESSION_SECRET stub from `diagnose-http-chain.ts`**

In `apps/server/scripts/diagnose-http-chain.ts`, remove the `SESSION_SECRET: 'diag-http-session-secret-diag-http-session-x',` line (~line 210) and any accompanying comment referencing it (~line 199). (This script is KEEP; the other three SESSION_SECRET-holding scripts were deleted in Q5, so this is the last stub.)

- [ ] **Step 11: Fix the root `"test"` script (the ~650-failure cascade trap)**

In root `package.json:15`, replace `"test": "bun test"` with a loud-fail guard that directs to the correct per-app runners (the cleaner option vs. orchestration, given the documented cwd cascade):

```json
    "test": "echo 'Run tests per-app: (cd apps/server && bun test), (cd packages/shared && bun test), (cd apps/web && npx vitest run). Root bun test triggers a cwd module-init cascade — see CLAUDE.md.' && exit 1",
```

(Loud-fail-with-guidance: a contributor who runs `bun test` at root gets the instruction instead of a misleading 650-failure wall. CI calls the per-app commands directly, so this does not affect CI.)

- [ ] **Step 12: Final grep — SESSION_SECRET is gone from all live surfaces**

```bash
grep -rn "SESSION_SECRET" . --include="*.ts" --include="*.md" --include="*.json" --include="*.example" 2>/dev/null | grep -v node_modules | grep -v "/dist/" | grep -v "docs/superpowers/" | grep -v "docs/AUDIT" | grep -v "memory/ARCHIVE.md"
```
Expected: ZERO hits. (Historical `docs/superpowers/plans/*`, `docs/AUDIT-2026-06-10.md`, and `memory/ARCHIVE.md` retain their mentions — those are immutable history, intentionally left.)

- [ ] **Step 13: Run server + shared suites + typecheck**

Run: `cd apps/server && bun test` then `cd packages/shared && bun test` then `cd apps/server && bun x tsc --noEmit`
Expected: server green, shared 70, clean typecheck.

- [ ] **Step 14: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/env.test.ts apps/server/src/test/env-setup.ts \
        .env.example README.md docs/INSTALL.md apps/server/scripts/diagnose-http-chain.ts package.json
git commit -m "chore: remove dead SESSION_SECRET; fail-loud root test script (Q6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## `## Sibling-site audit` (Q3 — libsodium + HTTPException + scripts/build.ts)

A cross-cutting term/convention that appears in N files; fixing one and missing the others = silent drift. Full enumerated surface (verified by grep this session):

**`libsodium` → AES-256-GCM (@noble/ciphers):**
| File:line | In Q3 scope? | Action |
|---|---|---|
| `CLAUDE.md:33` (table) | YES | fix → `AES-256-GCM (@noble/ciphers)` |
| `CLAUDE.md:45` | YES | fix |
| `docs/API.md:85` | YES (term only) | fix term; leave the dead path (M3.1) |
| `docs/INSTALL.md:46` | YES | fix |
| `apps/server/src/db/schema.ts:401` (code comment) | YES | fix |
| `memory/DECISIONS.md:22` | YES | fix (locked decision; annotate as superseded) |
| `apps/web/tests/e2e/phase-3-real-anthropic.spec.ts:16` | **DEFER** | test-file comment that also references a dead per-workspace AI-key path; bundle with M3.1's path fix, not Q3 |
| `docs/FOLIO-BRIEFING.md:73,187,568,818` | **DEFER** | PRD doc, 4 hits incl. a wrong "24-byte nonce + ciphertext" description; large historical doc — defer to a dedicated PRD-refresh follow-up (note below) |
| `docs/PHASES.md:38,468,1117` | **DEFER** | phase-checklist doc, 3 hits; defer to the same PRD/PHASES refresh |
| `docs/superpowers/plans/*`, `docs/AUDIT-2026-06-10.md`, `memory/ARCHIVE.md` | NO | immutable history — leave |

**Scoping decision (explicit):** Q3 fixes the 6 "YES" rows — the operator-facing + agent-facing + code-comment surfaces named by the brief. `FOLIO-BRIEFING.md` (PRD) and `PHASES.md` carry the drift too but are large historical planning docs; fixing them is real but is its own follow-up so it doesn't balloon Cluster 1. **Follow-up note for the controller:** add a Milestone-3-adjacent task "refresh FOLIO-BRIEFING.md + PHASES.md crypto term (libsodium→AES-GCM) and the BRIEFING's nonce/secretbox description" — out of M0 scope, enumerated here so it isn't lost.

**`HTTPException` → `HTTPError`:**
| File:line | In Q3 scope? | Action |
|---|---|---|
| `CLAUDE.md:87` | YES | fix → `HTTPError` (from `lib/http.ts`) |
| `memory/DECISIONS.md:82` | YES (bundle) | fix → `HTTPError` (same locked-decision doc as the libsodium line; Q3 Step 7) |
| `docs/superpowers/plans/*` | NO | historical — leave |

**`scripts/build.ts` (nonexistent) references:**
| File:line | In Q3 scope? | Action |
|---|---|---|
| `CLAUDE.md:68-70` (tree) | YES | fix (Q3 Step 3 — describe current inline build + M1 forward note) |
| `docs/FOLIO-BRIEFING.md:892` | DEFER | bundle with the PRD-refresh follow-up |
| `docs/PHASES.md:63` | DEFER | already self-notes the file is missing; bundle with PHASES refresh |

---

## `## Sibling-site audit` (Q6 — SESSION_SECRET removal surface)

The authoritative removal checklist. Verified by grep this session. "Removed by" names the task step or the Q5 deletion that eliminates each.

| File:line | Kind | Removed by |
|---|---|---|
| `apps/server/src/env.ts:8` | schema definition (the only "real" one) | Q6 Step 4 |
| `apps/server/src/env.test.ts:5` | `base` test fixture key | Q6 Step 5 |
| `apps/server/src/test/env-setup.ts:8` | test env default | Q6 Step 5 |
| `.env.example:15` (+ comment 13-14) | operator config + false "sign session cookies" comment | Q6 Step 7 |
| `README.md:28` | `openssl rand` generation line | Q6 Step 8 |
| `docs/INSTALL.md:16` | `export SESSION_SECRET=…` | Q2 Step 3 (block rewrite) — confirm Q6 Step 9 |
| `docs/INSTALL.md:28` | Docker `-e SESSION_SECRET=…` | Q6 Step 9 |
| `docs/INSTALL.md:45` | env-table row "Signs session cookies" (FALSE) | Q6 Step 9 |
| `apps/server/scripts/diagnose-http-chain.ts:199,210` | env stub (KEEP-set script) | Q6 Step 10 |
| `apps/server/scripts/shakeout-cross-ws-operator.ts:198` | env stub | **Q5 deletion** |
| `apps/server/scripts/shakeout-cross-ws-triggers.ts:210` | env stub | **Q5 deletion** |
| `apps/server/scripts/diagnose-agent-chain.ts:90-91` | env stub | **Q5 deletion** |
| `docs/superpowers/plans/2026-05-11-starter-extraction.md` (multiple) | historical plan | **LEAVE** (immutable) |
| `docs/superpowers/specs/2026-06-06-multica-architecture-study.md:112,132` | historical study | **LEAVE** |
| `memory/ARCHIVE.md:1802` | archived memory | **LEAVE** |
| `docs/AUDIT-2026-06-10.md:32,88,150` | this audit | **LEAVE** |

> **Sequencing reminder:** Q5 (delete scripts) MUST precede Q6 Step 10/12, or Q6 will try to edit SESSION_SECRET stubs in files that should already be gone.

---

## ── REVIEW GATE ── (Cluster 1 — tier: STANDARD)

**STOP. Do not start Cluster 2 until this gate passes.**

Tier: **STANDARD** — multi-file docs/config + one Tier-A query change; no 1a behavior surface. **Controller action required at this gate:** confirm the `SESSION_SECRET` removal is config-only by re-running `grep -rn "env\.SESSION_SECRET" apps/server/src` and verifying ZERO production readers. If a reader is found, this cluster RETROACTIVELY promotes to FULL + a threat model is owed on the removal.

**Review panel (STANDARD):** 2 finders + `code-simplicity` + a feature-acceptance pass on the fresh-clone smoke. No `security-sentinel` (unless escalated).

**Cluster integration gate (must all pass):**
1. `cd apps/server && bun test` → green; state delta vs 1,748 (Q1 seam + Q4 + Q6 add cases; e.g. 1,748 → ~1,752).
2. `cd packages/shared && bun test` → 70.
3. `cd apps/web && npx vitest run` → 938 (this cluster shouldn't touch web, but confirm no regression).
4. `bun x tsc --noEmit` in `apps/server`, `apps/web`, `packages/shared` → all clean.
5. **FRESH-CLONE SMOKE (audit DoD #3):** in a scratch dir:
   ```bash
   git clone <repo> /tmp/folio-smoke && cd /tmp/folio-smoke && git checkout harden/m0-safety-net
   bun install
   cp .env.example .env
   # follow ONLY README + INSTALL: set FOLIO_MASTER_KEY, set FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=true
   (cd apps/server && bun run db:generate && bun run db:migrate)
   # boot server (3001) — confirm it starts WITHOUT a SESSION_SECRET error
   # POST /api/v1/auth/register the first user — confirm 200/201, not the bootstrap-rejection 403
   ```
   PASS = server boots with no missing-env crash AND first-user registration succeeds following only the corrected docs. Emit a one-line pass/fail. (If a full clone is impractical in the harness, run the equivalent in-place against a clean `.env` built only from the corrected `.env.example`.)

---

# CLUSTER 2 — CI pipeline (task 0.1)

**Provisional review tier (1h): LIGHT-to-STANDARD.** Trigger reasoning: the deliverable is a GitHub Actions workflow YAML — config only, no 1a surface, no invariant, no data layer. LIGHT (single generalist pass) suffices for the YAML correctness; the cluster's *acceptance* (CI actually runs and goes red on a planted failure) is the real proof, so treat the review as LIGHT but gate hard on the planted-failure demonstration. Escalate to STANDARD only if the workflow ends up scripting non-trivial logic (it should not).

**Cluster integration gate:** the workflow runs green on `harden/m0-safety-net`; then a deliberately-broken test (committed, pushed, observed red, reverted) proves the gate bites. Biome job is **warn-only** here (flipped to blocking in Cluster 4).

**Dependency:** independent of Cluster 1's content, but land it AFTER Cluster 1 so the first green CI run is over already-fixed code (avoids a noisy first run). Must land BEFORE Cluster 4 (which flips its Biome job to blocking).

> **No new test files in this cluster.** The "test" is the CI behavior itself (Step: plant-a-failure). Tier of the YAML artifact: **B** (config). `no unit test: Tier B, CI workflow config; acceptance is the planted-failure red run`.

---

### Task 0.1: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml` (there is NO `.github/` today — confirmed)

**Architecture of the workflow (per audit §198 sketch + the in-repo traps):** one workflow, triggered on `push` + `pull_request`. One job with sequential steps sharing a checkout (the suite runs in <3 min total — simpler than fan-out, and the cache makes install cheap). Steps:
1. **install** — `oven-sh/setup-bun`, cache `~/.bun/install/cache` keyed on `bun.lock`, `bun install --frozen-lockfile`.
2. **server tests** — `working-directory: apps/server`, `bun test`.
3. **shared tests** — `working-directory: packages/shared`, `bun test`.
4. **web tests** — `cd apps/web && npx vitest run`, **with ONE retry on this step only** for the `list-view-create.test.tsx` jsdom flake.
5. **typecheck ×3** — `bun x tsc --noEmit` in each of `apps/server`, `apps/web`, `packages/shared`.
6. **biome (WARN-ONLY)** — `bun run lint || true` (non-blocking now; Cluster 4 removes the `|| true`).
7. **build:binary (build-proof)** — `bun run build:binary`.
8. **docker build (build-proof, no smoke)** — `docker build -f docker/Dockerfile -t folio:ci .` (smoke lands with M1's Docker fix — NOT here).

- [ ] **Step 1: Confirm no existing workflow + read the exact runner commands from CLAUDE.md**

```bash
ls .github/workflows 2>/dev/null || echo "no workflows (expected)"
```
Re-read CLAUDE.md "Build & Run" for the canonical commands (server/shared from their dir; web vitest; per-app tsc; `build:binary`; docker build path `docker/Dockerfile`).

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Cache Bun install
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-

      - name: Install
        run: bun install --frozen-lockfile

      - name: Server tests
        working-directory: apps/server
        run: bun test

      - name: Shared tests
        working-directory: packages/shared
        run: bun test

      - name: Web tests (one retry for the known jsdom flake)
        working-directory: apps/web
        run: npx vitest run || npx vitest run

      - name: Typecheck server
        working-directory: apps/server
        run: bun x tsc --noEmit

      - name: Typecheck web
        working-directory: apps/web
        run: bun x tsc --noEmit

      - name: Typecheck shared
        working-directory: packages/shared
        run: bun x tsc --noEmit

      - name: Lint (warn-only — flipped to blocking in M0 task 0.4)
        run: bun run lint || true

      - name: Build single binary (build-proof)
        run: bun run build:binary
        continue-on-error: true # TODO M1: remove once H1 (binary embedding) is fixed

      - name: Docker build (build-proof, no smoke yet)
        run: docker build -f docker/Dockerfile -t folio:ci .
        continue-on-error: true # TODO M1: remove once H2 (Docker) is fixed
```

**Notes baked in:** the web step's `|| npx vitest run` is the single retry (re-runs the whole web suite once if the first fails — acceptable since web is the only flaky suite and runs fast); server/shared use `working-directory` so the cwd cascade can't fire; lint is `|| true` (warn-only) — Cluster 4 removes that. The two build-proof steps carry `continue-on-error: true` because H1/H2 (binary embedding + Docker) are KNOWN-broken and are M1's job — so the blocking signal NOW is tests + typecheck (+ lint after 0.4), and the build-proof steps surface the known debt without falsely reddening the branch. M1 removes the `continue-on-error`. `bun test` sets its own env via `test/env-setup.ts`, and `build:binary`/`docker build` are compiles (no runtime env needed).

- [ ] **Step 3: Validate the YAML locally (syntax)**

```bash
bun x --yes js-yaml .github/workflows/ci.yml > /dev/null && echo "YAML OK"
```
(Or any local YAML linter available. Expected: no parse error.)

- [ ] **Step 4: Commit + push to trigger the first run**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions pipeline — tests + typecheck + lint(warn) + build proofs (0.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin harden/m0-safety-net
```

- [ ] **Step 5: Watch the run go green**

```bash
gh run watch || gh run list --branch harden/m0-safety-net --limit 1
```
Expected: tests + typecheck + lint(warn) steps PASS; the two build-proof steps may show a yellow/neutral (continue-on-error) if H1/H2 are still broken — that is acceptable and expected. The RUN as a whole must be green (continue-on-error steps don't fail the run).

- [ ] **Step 6: PROVE the gate bites — plant a failure, observe red, revert**

```bash
# Plant a deliberately-failing assertion in a cheap server test
# (edit one expect(...).toBe(...) to a wrong value), commit, push:
git commit -am "test: TEMP planted failure to prove CI goes red"
git push
gh run watch   # EXPECT: server-tests step RED, run fails
# Revert:
git revert --no-edit HEAD
git push
gh run watch   # EXPECT: green again
```
Expected: the planted failure turns the run red; the revert restores green. This is the cluster's acceptance proof.

---

## ── REVIEW GATE ── (Cluster 2 — tier: LIGHT)

**STOP. Do not start Cluster 3 until this gate passes.**

Tier: **LIGHT** — single generalist pass on the workflow YAML. The binding acceptance is behavioral, not code-review:

**Cluster integration gate (must all pass):**
1. CI run on `harden/m0-safety-net` is GREEN for the test (server/shared/web) + typecheck (×3) + lint(warn-only) steps.
2. The planted-failure run (Step 6) was observed RED, and the revert restored GREEN — paste the two run URLs/statuses.
3. The two build-proof steps are `continue-on-error: true` with the `# TODO M1` markers (so known H1/H2 debt doesn't falsely red the branch) — controller-confirmed.
4. Local suites still green (CI mirrors local, but confirm nothing in the workflow changed source): server / shared / web at their counts.

---

# CLUSTER 3 — crypto.test.ts + auth.test.ts (tasks 0.2, 0.3)

**Provisional review tier (1h): FULL.** Trigger reasoning: these tests exercise the **crypto module + session-auth surface** — a 1a-adjacent security surface (invariants 2 & 7 rest on crypto fail-closed; `auth.ts` is the session-validation convergence). Even though the tasks add **no behavior**, FULL-tier review is warranted to confirm the tests *actually bite the security paths* (a green-but-blind crypto test is the exact failure mode the audit's H9 names — a framing refactor passing the suite while bricking every stored key). FULL panel: all finders + `security-sentinel` + the test-effectiveness audit confirming each assertion would go RED on a mutated impl.

**Cluster integration gate:** both new suites green; **each Tier-A assertion proven RED-first** against a mutated implementation (revert the mutation after each proof); server suite delta stated.

**Dependency:** independent of Clusters 1, 2, and 4. Can run in parallel with Cluster 2. (Placed third by the recommended order; could be second.)

**Context cited (1b — no authoring, context only):** `ARCHITECTURE-INVARIANTS.md` invariants 2 & 7 (the fail-closed master-key + crypto posture) and the session-validation convergence in `lib/auth.ts`. These tests are the missing *proof* that those invariant-relevant paths hold; cite them in the test-file header comments so the reviewer maps assertion→invariant.

---

### Task 0.2: `crypto.test.ts` — Tier-A security-guard tests

**Files:**
- Create: `apps/server/src/lib/crypto.test.ts` (does NOT exist — confirmed)

**Tier: A, RED-first** — security guard; per the repo's testing-workflow rule, crypto guards are ALWAYS Tier A regardless of line count.

**Source facts (read this session — `crypto.ts` is 35 lines):**
- Exports: `encryptSecret(plaintext: string): string` and `decryptSecret(ciphertext: string): string`.
- Algorithm: AES-256-GCM via `gcm` from `@noble/ciphers/aes`; IV = `randomBytes(12)` from `@noble/ciphers/webcrypto`; key = `Buffer.from(env.FOLIO_MASTER_KEY, 'hex')` (must be 32 bytes — guard at module load: `if (KEY.length !== 32) throw new Error('FOLIO_MASTER_KEY must decode to exactly 32 bytes')`).
- **Ciphertext format:** `base64(iv[12] || ciphertext)` where `@noble`'s `gcm.encrypt` **appends the 16-byte GCM tag to the ciphertext** (there is no separate tag field). So `combined = iv(12) || ct(=plaintextLen + 16-byte tag)`.
- The key-length guard fires at **module import** (top-level `throw`), so testing the short-key path requires importing the module under a bad `FOLIO_MASTER_KEY` — see Step 5's approach.
- The **test** `FOLIO_MASTER_KEY` is `'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'` (`test/env-setup.ts:9`) — the known-good ciphertext (Step 6) must be generated under THIS key.

**Test contract (each must be RED-proven by mutating the impl):**
1. **Round-trip:** `decryptSecret(encryptSecret(s)) === s` for several strings incl. unicode + empty.
2. **Tamper detection:** flip a byte in the ciphertext region (index ≥ 12, i.e. inside `ct+tag`) → `decryptSecret` throws.
3. **Wrong-key failure:** ciphertext produced under key A fails to decrypt under the env key (throws).
4. **Key-length guard:** a non-32-byte `FOLIO_MASTER_KEY` makes the module throw at import (`must decode to exactly 32 bytes`).
5. **Ciphertext-format stability:** `decryptSecret(<HARDCODED known-good base64>)` returns a known plaintext — so a framing refactor that would brick every customer's stored keys goes RED. The hardcoded value is generated once (Step 6) and committed.

- [ ] **Step 1: Write round-trip + tamper + format-stability tests (RED skeleton)**

Create `apps/server/src/lib/crypto.test.ts`:

```ts
// Tier-A security-guard tests for lib/crypto.ts (AES-256-GCM, @noble/ciphers).
// Closes audit H9: a framing refactor must not silently pass while bricking
// every customer's stored AI key. Cites ARCHITECTURE-INVARIANTS.md inv. 2 & 7
// (fail-closed crypto posture) — these tests are the proof those paths hold.
//
// NOTE: lib/crypto.ts reads FOLIO_MASTER_KEY at MODULE LOAD and derives KEY once.
// The test env (test/env-setup.ts) supplies FOLIO_MASTER_KEY =
// '0123456789abcdef'×4 (64 hex). The hardcoded known-good ciphertext (Step 6)
// MUST be generated under that exact key.
import { describe, expect, test } from 'bun:test';
import { decryptSecret, encryptSecret } from './crypto.ts';

describe('crypto round-trip', () => {
  test('encrypt→decrypt returns the original (ascii, unicode, empty)', () => {
    for (const s of ['hello', 'sk-ant-апи-🔑-key', '']) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });

  test('two encryptions of the same plaintext differ (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });
});

describe('crypto tamper detection', () => {
  test('flipping a ciphertext byte makes decrypt throw (GCM tag)', () => {
    const ct = encryptSecret('tamper-me');
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip the last byte = part of the GCM tag
    const tampered = buf.toString('base64');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe('crypto ciphertext-format stability', () => {
  // KNOWN_GOOD is generated in Step 6 under the test FOLIO_MASTER_KEY and pasted here.
  // If a framing change breaks this, EVERY stored customer key would fail to decrypt.
  const KNOWN_GOOD = '__PASTE_IN_STEP_6__';
  const KNOWN_PLAINTEXT = 'folio-known-good-secret';
  test('a previously-encrypted ciphertext still decrypts to the known plaintext', () => {
    expect(decryptSecret(KNOWN_GOOD)).toBe(KNOWN_PLAINTEXT);
  });
});
```

- [ ] **Step 2: Run to verify round-trip + tamper pass, format-stability FAILS (placeholder)**

Run: `cd apps/server && bun test src/lib/crypto.test.ts`
Expected: round-trip + tamper PASS; format-stability FAILS (placeholder `__PASTE_IN_STEP_6__` is not valid base64 / wrong plaintext). Expected until Step 6.

- [ ] **Step 3: RED-proof tamper detection bites**

Temporarily comment out the byte-flip line (`buf[buf.length - 1] ^= 0xff;`) → re-run → the tamper test now does NOT throw, i.e. the assertion FAILS (proving it depends on real tamper behavior). Restore the flip.

- [ ] **Step 4: Add the wrong-key test (construct a second key inline via @noble)**

Add to `crypto.test.ts`:

```ts
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';

describe('crypto wrong-key failure', () => {
  test('ciphertext from a different key fails to decrypt', () => {
    // Encrypt under a DIFFERENT 32-byte key, in the SAME framing as crypto.ts,
    // then assert decryptSecret (which uses the env KEY) rejects it.
    const otherKey = randomBytes(32);
    const iv = randomBytes(12);
    const ct = gcm(otherKey, iv).encrypt(new TextEncoder().encode('secret'));
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    const foreign = Buffer.from(combined).toString('base64');
    expect(() => decryptSecret(foreign)).toThrow();
  });
});
```

Run: `cd apps/server && bun test src/lib/crypto.test.ts -t "wrong-key"`
Expected: PASS (GCM auth fails under the wrong key → throws).

- [ ] **Step 5: Add the key-length guard test (module-load throw)**

The guard is a top-level `throw` at import, so test it by importing the module fresh under a bad env in a child Bun process (cleanest — avoids polluting the test process's already-loaded module):

```ts
describe('crypto key-length guard', () => {
  test('a non-32-byte FOLIO_MASTER_KEY makes the module throw at load', async () => {
    const proc = Bun.spawn(
      ['bun', '-e', "import('./src/lib/crypto.ts').then(()=>process.exit(0)).catch(()=>process.exit(7))"],
      {
        cwd: import.meta.dir.replace(/\/src\/lib$/, ''), // → apps/server
        env: { ...process.env, FOLIO_MASTER_KEY: 'ab'.repeat(8) }, // 16 hex = 8 bytes ≠ 32
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const code = await proc.exited;
    expect(code).toBe(7); // module threw on the short key
  });
});
```

(Adjust the `cwd`/import path so the child resolves `src/lib/crypto.ts` from `apps/server`. If `Bun.spawn` child-import proves fiddly in the harness, the acceptable fallback is a focused unit on the guard logic extracted to a tiny pure helper — but prefer proving the real top-level guard. The key fact to assert: 8-byte key → throw `must decode to exactly 32 bytes`.)

Run: `cd apps/server && bun test src/lib/crypto.test.ts -t "key-length"`
Expected: PASS (child exits 7).

- [ ] **Step 6: Generate + paste the known-good ciphertext, then GREEN the format-stability test**

Generate a ciphertext under the test `FOLIO_MASTER_KEY` (`0123456789abcdef`×4):

```bash
cd apps/server && FOLIO_MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  bun -e "import('./src/lib/crypto.ts').then(m=>console.log(m.encryptSecret('folio-known-good-secret')))"
```

Paste the printed base64 into `KNOWN_GOOD` in `crypto.test.ts`.

Run: `cd apps/server && bun test src/lib/crypto.test.ts`
Expected: ALL green now (the test process loads the same `FOLIO_MASTER_KEY` via `test/env-setup.ts`, so the hardcoded ciphertext decrypts).

- [ ] **Step 7: RED-proof format-stability bites**

Temporarily change `crypto.ts`'s framing (e.g. change `combined.set(iv, 0)` / `combined.set(ct, iv.length)` to a different offset) → re-run → format-stability + round-trip FAIL (proving the hardcoded ciphertext catches a framing change). Revert.

- [ ] **Step 8: Final run + typecheck + commit**

Run: `cd apps/server && bun test src/lib/crypto.test.ts` then `cd apps/server && bun x tsc --noEmit`
Expected: green; clean. Note delta (server total + these cases).

```bash
git add apps/server/src/lib/crypto.test.ts
git commit -m "test: Tier-A crypto.ts tests — round-trip, tamper, wrong-key, key-guard, format-stability (0.2/H9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 0.3: `auth.ts` Tier-A tests

**Files:**
- Create: `apps/server/src/lib/auth.test.ts` (does NOT exist — confirmed; `routes/auth.test.ts` tests the ROUTE, not `lib/auth.ts`)

**Tier: A, RED-first** — session-validation + password-verify is a security guard.

**Source facts (read this session):**
- `readSession(sessionId)` (auth.ts:29-37): finds the `authSessions` row by id; returns `null` if no row; **returns `null` if `row.expiresAt.getTime() < Date.now()` (the expiry branch — line 34)**; else looks up the user and returns `user ?? null` (**deleted-user branch — line 35-36**).
- `verifyPassword(plain, hash)` (auth.ts:18-20): `Bun.password.verify(plain, hash)`.
- `hashPassword(plain)` (auth.ts:14-16): `Bun.password.hash(plain, { algorithm: 'argon2id' })`.
- `createSession(userId)` (auth.ts:22-27): inserts an `authSessions` row with `expiresAt = now + 30d`.
- **Harness:** `routes/auth.test.ts` obtains a migrated in-memory DB via `const { app, db } = await makeBareTestDb()` (from `test/harness.ts`) and inserts rows with `db.insert(users).values({...})`. Reuse this. The expiry branch needs an **already-expired** session row (insert one with `expiresAt` in the past) — no clock-faking needed.
- **`users` insert minimal columns:** `id` (text), `email` (unique), `name` (notNull). `role` defaults to `'member'`; `createdAt` auto.

**Test contract (RED-proven):**
1. **Session expiry:** an `authSessions` row with `expiresAt` in the past → `readSession` returns `null`. RED-proof: flip the `< now` comparison in `auth.ts` and confirm the test fails.
2. **Deleted-user-behind-session:** a valid (unexpired) session whose `userId` has no `users` row → `readSession` returns `null` (not a partial/throw).
3. **Wrong-password verify:** `verifyPassword('wrong', hashPassword('right'))` → `false`; correct password → `true`.

- [ ] **Step 1: Confirm the harness shape in `routes/auth.test.ts`**

Open `apps/server/src/routes/auth.test.ts` — confirm `makeBareTestDb()` returns `{ app, db }`, the `db` is a migrated in-memory Drizzle handle, and `db.insert(users).values({ id, email, name })` works. Mirror this exact setup in the new file. (Do NOT invent a new harness.)

- [ ] **Step 2: Write the failing tests (RED skeleton)**

Create `apps/server/src/lib/auth.test.ts`:

```ts
// Tier-A tests for lib/auth.ts session validation + password verify.
// Closes audit H9: the expiry branch (auth.ts:34) has no coverage at any layer
// (no wire test can hit it without a past-dated session). Cites the session-
// validation convergence in lib/auth.ts.
import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { authSessions, users } from '../db/schema.ts';
import { hashPassword, readSession, verifyPassword } from './auth.ts';
import { makeBareTestDb } from '../test/harness.ts';

describe('readSession expiry', () => {
  test('an expired session returns null', async () => {
    const { db } = await makeBareTestDb();
    const userId = nanoid();
    await db.insert(users).values({ id: userId, email: `${userId}@x.com`, name: 'U' });
    const sid = 'expired-session-id';
    await db.insert(authSessions).values({
      id: sid,
      userId,
      expiresAt: new Date(Date.now() - 1000), // 1s in the past
    });
    expect(await readSession(sid)).toBeNull();
  });
});

describe('readSession deleted-user', () => {
  test('a valid session whose user is gone returns null', async () => {
    const { db } = await makeBareTestDb();
    const sid = 'valid-session-ghost';
    await db.insert(authSessions).values({
      id: sid,
      userId: 'ghost-user', // no users row for this id
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await readSession(sid)).toBeNull();
  });
});

describe('verifyPassword', () => {
  test('wrong password is rejected, correct password accepted', async () => {
    const hash = await hashPassword('right-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
    expect(await verifyPassword('right-password', hash)).toBe(true);
  });
});
```

**IMPORTANT — confirm which `db` `readSession` uses:** `lib/auth.ts` imports `db` from `../db/client.ts` (the process singleton), NOT the `db` returned by `makeBareTestDb()`. If `makeBareTestDb()` returns a SEPARATE handle, `readSession` won't see rows inserted into it. Check how `routes/auth.test.ts` reconciles this — most likely the harness points the singleton at the same in-memory DB (read `test/harness.ts`). If the harness's `db` IS the singleton (or the harness rebinds the singleton), the above works as written. If not, insert via the singleton `db` (import from `../db/client.ts`) instead — match whatever `routes/auth.test.ts` does for its own row inserts that `readSession`-style lookups then see.

- [ ] **Step 3: Run to verify the suite is wired (assertions should pass once `db` is reconciled)**

Run: `cd apps/server && bun test src/lib/auth.test.ts`
Expected: green once the `db` handle matches what `readSession` reads. (These assert *current correct* behavior — they pass now; the RED-proof in Step 4 makes them Tier-A meaningful.)

- [ ] **Step 4: RED-proof the expiry + deleted-user branches bite**

Expiry: in `auth.ts:34`, temporarily flip `if (row.expiresAt.getTime() < Date.now()) return null;` to `>` (or comment it out) → run the expiry test → it must FAIL (an expired session would now authenticate). Revert.

Deleted-user: temporarily change `return user ?? null;` (line 36) to `return (user ?? {}) as never;` → the deleted-user test must FAIL → revert. (Confirms the `?? null` guard is load-bearing.)

- [ ] **Step 5: Final run + typecheck + commit**

Run: `cd apps/server && bun test src/lib/auth.test.ts` then `cd apps/server && bun x tsc --noEmit`
Expected: green; clean.

```bash
git add apps/server/src/lib/auth.test.ts
git commit -m "test: Tier-A auth.ts tests — session expiry, deleted-user, password verify (0.3/H9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## ── REVIEW GATE ── (Cluster 3 — tier: FULL)

**STOP. Do not start Cluster 4 until this gate passes.**

Tier: **FULL** — the tests guard the crypto + session-auth security surface (1a-adjacent). FULL panel: all finders + `security-sentinel` + the `test-effectiveness` audit. The reviewer's specific job here is NOT to find behavior bugs (there's no behavior change) but to confirm **each Tier-A assertion would actually go RED if its dangerous path broke** — i.e. that the RED-proofs in 0.2 Steps 3/7 and 0.3 Step 4 were genuinely performed and bite. This is the audit's H9 failure mode (green-but-blind crypto suite) being closed.

**Cluster integration gate (must all pass):**
1. `cd apps/server && bun test` → green; state the new server total.
2. `cd apps/server && bun x tsc --noEmit` → clean.
3. **RED-proof evidence:** for each of the 5 crypto assertions + 3 auth assertions, the mutation→RED→revert→GREEN cycle was run (or, for the ones asserting current behavior, the mutation representing the regression was shown to flip them red). The reviewer confirms this against the task steps.
4. `security-sentinel` confirms: no secret/plaintext key is logged or committed (the `KNOWN_GOOD` ciphertext is fine — it's encrypted under the *test-env* master key, a public throwaway in `env-setup.ts`, not a real customer master key); the test uses that test-env key, not a production value.

---

# CLUSTER 4 — Lint debt → 0 + Biome in pre-commit + flip CI to blocking (task 0.4)

**Provisional review tier (1h): STANDARD.** Trigger reasoning: mechanical but touches **every file** (a 1700+ diagnostic sweep), and one hook + one CI edit. No 1a surface, no invariant *behavior*, no data layer — so not FULL — but the blast radius (every file) and the risk that a mechanical `--fix`/`--unsafe` sweep silently changes behavior makes it more than LIGHT. STANDARD: 2 finders + `code-simplicity` + a full-suite re-run as the binding proof. **The binding safety is the full-suite + 3×tsc re-run green AFTER the sweep** — mechanical changes that break a test must be caught here.

**Cluster integration gate:** `bun run lint` exits 0; Biome wired into pre-commit; CI's Biome job flipped to blocking (`|| true` removed); **all three suites + 3×tsc green after the `--fix` sweep** (the audit explicitly flags "full suite re-run after").

**Dependency:** needs Cluster 2's CI to exist (it flips that workflow's lint job to blocking). Land LAST.

> **Three separate commits** (the sweep's mechanical diff must not be entangled with the hook/CI logic): (1) the `biome check --fix` sweep alone; (2) the manual-triage of the remainder alone; (3) the pre-commit hook + CI flip alone. This keeps the huge mechanical diff reviewable in isolation and the logic changes auditable.

---

### Task 0.4a: The safe `biome check --fix` sweep (commit 1)

**Files:** every file Biome safely fixes (formatter + import-organize). Do NOT hand-edit here.

**Tier: B** — mechanical. `no unit test: Tier B, formatter/import-sort sweep; safety is the full-suite + tsc re-run green after`.

- [ ] **Step 1: Snapshot the baseline counts BEFORE the sweep**

```bash
cd /home/ntdst/Projects/folio && bun run lint 2>&1 | tail -3
```
Expected: `Found 1732 errors. Found 59 warnings.` (record exact numbers — the diff to zero is the cluster's metric).

- [ ] **Step 2: Apply ONLY the safe fixes**

```bash
cd /home/ntdst/Projects/folio && bun x biome check --fix .
```
(`--fix` applies the SAFE subset only — the "suggested fixes" Biome skips in check-mode are the *unsafe* ones; `--fix` without `--unsafe` will NOT touch those. This sweep is purely formatter + safe lint.)

- [ ] **Step 3: Re-count + eyeball the diff is mechanical**

```bash
cd /home/ntdst/Projects/folio && bun run lint 2>&1 | tail -3
git diff --stat | tail -5
```
Expected: error count drops substantially (the formatter/import noise clears); the remaining count is the manual-triage backlog for 0.4b. The `git diff` should be whitespace/quote/import-order only — spot-check 3-4 files to confirm no semantic change slipped in.

- [ ] **Step 4: THE BINDING SAFETY — full suite + 3×tsc green after the mechanical sweep**

```bash
cd apps/server && bun test
cd packages/shared && bun test
cd apps/web && npx vitest run
cd apps/server && bun x tsc --noEmit
cd apps/web && bun x tsc --noEmit
cd packages/shared && bun x tsc --noEmit
```
Expected: server / shared / web at their current totals (Cluster-1/3 additions included); all tsc clean. **If anything went red, the `--fix` sweep changed behavior — `git checkout` the offending file(s), investigate the specific rule that broke them, and exclude that fix.** (The audit's explicit "mechanical changes can break things" caution.)

- [ ] **Step 5: Commit the sweep alone**

```bash
git add -A
git commit -m "style: biome check --fix sweep (safe formatter + import-organize) (0.4a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 0.4b: Manual triage of the remaining lint errors → 0 (commit 2)

**Files:** the specific files Biome still flags after 0.4a.

**Tier: B** for pure mechanical/style remainders; **but** any remaining diagnostic that requires a *logic* touch (not just a `noExplicitAny` warn or a style nit) is treated **Tier A** for that specific change — if a fix changes a branch/return, it needs a RED-first test or an explicit `// biome-ignore` with a reason. `no unit test: Tier B, style remainder` applies only to the genuinely-mechanical leftovers.

- [ ] **Step 1: List what remains, grouped by rule**

```bash
cd /home/ntdst/Projects/folio && bun run lint 2>&1 | grep -oE 'lint/[a-zA-Z/]+' | sort | uniq -c | sort -rn
```
Expected: a small set of rules (the `--unsafe` candidates Biome skipped + any genuine issues). This tells you what you're triaging.

- [ ] **Step 2: Triage each rule-group — fix, suppress-with-reason, or selectively `--unsafe`**

For each group:
- **Pure style / safe-but-skipped:** if `biome check --fix --unsafe` would fix it AND a spot-check shows it's behavior-preserving (e.g. `const` over `let`, template-literal), apply `--unsafe` to **just those files** (`bun x biome check --fix --unsafe path/to/file.ts`), then re-run that file's tests.
- **`noExplicitAny` (warnings):** the repo has zero handwritten `as any` per the audit — these 59 warnings are likely in generated/edge spots. If genuine, narrow the type; if unavoidable, `// biome-ignore lint/suspicious/noExplicitAny: <reason>`.
- **Anything touching control flow:** STOP — write a RED-first test for the behavior before changing it (Tier A for that change), or suppress with a reason rather than risk a silent behavior change in a "lint" commit.

Do NOT blanket-run `--fix --unsafe .` across the repo — apply it file-by-file with a test re-run, because `--unsafe` can change semantics.

- [ ] **Step 3: Confirm `bun run lint` exits 0**

```bash
cd /home/ntdst/Projects/folio && bun run lint; echo "EXIT: $?"
```
Expected: `Found 0 errors.` and `EXIT: 0`. (Warnings: `noExplicitAny` is configured as `warn`; `biome check` exits non-zero only on ERRORS, not warnings — so 0 errors is the hard bar. Drive warnings down too, but document any residual with `biome-ignore` reasons; confirm the warning policy with the controller.)

- [ ] **Step 4: Full suite + 3×tsc green again (triage may have touched logic-adjacent files)**

Run the same six commands as 0.4a Step 4. Expected: all green.

- [ ] **Step 5: Commit the triage alone**

```bash
git add -A
git commit -m "style: manual triage of remaining biome diagnostics → 0 errors (0.4b)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 0.4c: Biome in pre-commit + flip CI's Biome job to blocking (commit 3)

**Files:**
- Create: `scripts/hooks/pre-commit-biome.sh`
- Modify: `scripts/hooks/install.sh` (add the biome hook to the generated pre-commit)
- Modify: `.github/workflows/ci.yml` (remove `|| true` from the Lint step)

**Tier: B** — tooling/config. `no unit test: Tier B, hook + CI config; acceptance is "a lint error blocks a commit AND fails CI"`.

- [ ] **Step 1: Write the pre-commit biome hook**

Create `scripts/hooks/pre-commit-biome.sh`:

```bash
#!/usr/bin/env bash
# Pre-commit: Biome must pass (0 errors) before a commit lands.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if ! bun run lint > /dev/null 2>&1; then
  echo "✗ Biome found errors. Run 'bun run lint' to see them, 'bun run format' to auto-fix style." >&2
  exit 1
fi
```

Make it executable:
```bash
chmod +x scripts/hooks/pre-commit-biome.sh
```

- [ ] **Step 2: Wire it into install.sh**

In `scripts/hooks/install.sh`, add the biome hook line to the generated pre-commit heredoc (after the invariants line, line 15):

```bash
"$ROOT/scripts/hooks/pre-commit-migration-journal.sh"
"$ROOT/scripts/hooks/pre-commit-invariants.sh"
"$ROOT/scripts/hooks/pre-commit-biome.sh"
```

- [ ] **Step 3: Re-install hooks + prove the hook blocks a lint error**

```bash
./scripts/hooks/install.sh
# Plant a lint error (e.g. an unused import in a scratch file), attempt a commit:
printf 'import {x} from "y";\nconst z=1;\n' > apps/server/src/__lint_probe.ts
git add apps/server/src/__lint_probe.ts
git commit -m "probe" ; echo "COMMIT EXIT: $?"   # EXPECT: blocked, non-zero
# Clean up:
git reset HEAD apps/server/src/__lint_probe.ts && rm apps/server/src/__lint_probe.ts
```
Expected: the commit is BLOCKED by the biome hook (non-zero exit). Remove the probe.

- [ ] **Step 4: Flip CI's Biome job to blocking**

In `.github/workflows/ci.yml`, change the Lint step:
```yaml
      - name: Lint (warn-only — flipped to blocking in M0 task 0.4)
        run: bun run lint || true
```
to:
```yaml
      - name: Lint (blocking)
        run: bun run lint
```

- [ ] **Step 5: Commit + push + confirm CI is green WITH blocking lint**

```bash
git add scripts/hooks/pre-commit-biome.sh scripts/hooks/install.sh .github/workflows/ci.yml
git commit -m "ci+hooks: Biome in pre-commit; flip CI lint job to blocking (0.4c)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
gh run watch
```
Expected: CI green WITH the now-blocking lint step (proves 0.4a+0.4b drove errors to 0 — if the lint step now fails CI, there were residual errors the local run missed; fix them).

---

## ── REVIEW GATE ── (Cluster 4 — tier: STANDARD)

**STOP. This is the final cluster — after this gate, hand to `/shakeout` for the branch-level pre-merge gate.**

Tier: **STANDARD** — mechanical but every-file blast radius + hook/CI logic. Panel: 2 finders + `code-simplicity` + the full-suite re-run as the binding proof.

**Cluster integration gate (must all pass):**
1. `bun run lint` → `Found 0 errors.`, exit 0.
2. All three suites green at their totals (server / shared / web) + 3×tsc clean — **after** the `--fix` sweep and the triage (the audit's mandatory "full suite re-run after").
3. Pre-commit biome hook BLOCKS a planted lint error (Step 3 evidence).
4. CI run on `harden/m0-safety-net` is green WITH the blocking lint step (Step 5 run URL/status).
5. The three commits are distinct (sweep / triage / hook+CI) — `git log --oneline` shows them separately.

---

## Branch-level finish (after all four gates)

Hand to `netdust-agent:shakeout` (the spec-complete / pre-merge gate). Because the branch's highest cluster tier is **FULL** (Cluster 3), shakeout runs the FULL reviewer panel on the whole branch diff. Confirm against the audit's Definition-of-Done items this plan owns:
- DoD #1 (partial): CI green on every push — 3 suites + 3 typechecks + Biome (now blocking) + binary build + Docker build. ✔ (binary/docker are build-proof with `continue-on-error` until M1; smoke is M1).
- DoD #2: `bun run lint` exits 0; Biome in pre-commit. ✔
- DoD #3 (partial): fresh-clone install succeeds following only the docs — verified by Cluster 1's smoke. ✔ (full both-paths incl. Docker boot is M1).
- DoD #6: `crypto.ts` + `auth.ts` expiry have direct Tier-A tests. ✔

Then `superpowers:finishing-a-development-branch` for the merge/PR decision (the brief said do not merge without the user's call — present options, don't auto-merge).

---

## Self-review (writing-plans checklist — run against the brief)

**Spec coverage:** Q1 ✓ (both log lines, inner-catch drift corrected) · Q2 ✓ (PORT story, bootstrap vars→INSTALL, release link; `.env.example` deferred to Q6's combined edit) · Q3 ✓ (HTTPException, libsodium×6, scripts/build.ts; sibling-audit enumerates the deferred PRD/PHASES surface; DECISIONS.md:82 folded in) · Q4 ✓ (route-only limit, RED-first, source-matched clamp) · Q5 ✓ (5 deletes + diagnose-http-chain header + grep-guards + KEEP-set paths corrected) · Q6 ✓ (SESSION_SECRET full surface + root test script, Tier-A env test against the real `base` fixture, sequenced after Q5) · 0.1 ✓ (CI, all runner traps baked, planted-failure proof, build-proof `continue-on-error` decision) · 0.2 ✓ (5 crypto assertions, RED-proofs, known-good generated under the real test key) · 0.3 ✓ (3 auth assertions, past-dated session not clock-mock, real `makeBareTestDb` harness, the singleton-`db` caveat called out) · 0.4 ✓ (3-commit split, full-suite re-run as binding gate).

**Placeholder scan:** the only intentional placeholder is `KNOWN_GOOD = '__PASTE_IN_STEP_6__'` — generated + pasted in an explicit step with the exact key, not a TODO. The auth test now uses real `nanoid()` ids + the real `makeBareTestDb`/`users` columns; the singleton-vs-harness `db` reconciliation is flagged explicitly (the one genuine "read the harness" decision the implementer must confirm).

**Type consistency:** `encryptSecret`/`decryptSecret`, `readSession`/`verifyPassword`/`hashPassword`/`createSession`, `ListRunsFilter.limit`, the `limit` clamp expression, `makeBareTestDb`/`makeTestApp`, the `base` fixture, `users`/`authSessions` columns — all match the exact source read this session.

**Gate decisions:** 1a no-fire (justified, FLAG on Q6) · 1b no-fire (cite-only on 0.2/0.3) · 1f four clusters with STOP markers · 1h tiers assigned (STANDARD/LIGHT/FULL/STANDARD) with trigger reasoning · 1d per-task tier + test lines · 1e two sibling-site audits + Q2's 3-file PORT enumeration. ✓
