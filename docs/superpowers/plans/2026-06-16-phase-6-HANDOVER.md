# Phase 6 (Views) — Restart Handover

**Date:** 2026-06-16
**Branch:** `phase-6/views` (3 commits ahead of `main`)
**Why this doc:** Restarting Phase 6 mid-Cluster-1. Concern raised: "too many server errors — we need to be sure the code is OK." This handover records the **verified** state of the code so the next session restarts from ground truth, not from optimistic subagent reports.

---

## TL;DR — is the committed code OK?

**Yes, the committed code is green and typechecks.** Verified by the controller (not just subagent reports), 2026-06-16:

| Check | Result |
|---|---|
| `cd apps/server && bun test` | **1866 pass, 1 skip, 0 fail** |
| `cd packages/shared && bun test` | **80 pass, 0 fail** |
| `cd apps/web && npx vitest run` | **960 pass, 0 fail** |
| `cd apps/server && bun x tsc --noEmit` | clean (exit 0) |
| `cd apps/web && bun x tsc --noEmit` | clean (exit 0) |
| `cd packages/shared && bun x tsc --noEmit` | clean (exit 0) |
| `bun run lint` (repo root) | exit 0 (82 pre-existing `noExplicitAny` **warnings** — non-blocking) |
| working tree | clean (nothing uncommitted) |

The `[ai/openai] dropped malformed tool_call JSON` lines in the server test output are **intentional test-fixture log output** (a test exercising malformed-stream handling), NOT errors.

---

## ⚠️ The real reason you're seeing server errors (READ THIS)

Cluster 1 is **half-applied** — this is expected mid-cluster, but it leaves the app in an inconsistent state that WILL throw at runtime until Task 1.1 lands:

**The view-type enum is widened at only 1 of 4 sites.**
- Task 1.0b's implementer added `'table'` to `apps/server/src/db/schema.ts` ONLY (the narrowest change to make the new seed `type:'table'` typecheck).
- The other **3 sites still say `'list' | 'kanban'`:**
  1. `packages/shared/src/index.ts:10` — `ViewType` union
  2. `apps/server/src/routes/views.ts` (`baseSchema` `z.enum(['list','kanban'])`)
  3. `apps/web/src/lib/api/views.ts` (`View`/`ViewCreate`/`ViewPatch` unions)

**Consequence (the "server errors"):**
- The seed + the `0038` backfill now WRITE `type:'table'` rows.
- But `routes/views.ts` `z.enum(['list','kanban'])` **REJECTS `table` at the API boundary → 422 INVALID_BODY** on any view create/patch that carries `type:'table'`.
- And `<ViewRouter>` / `useActiveView` don't exist yet (Task 1.2), so the web app has no renderer wired for the new model.

**This is not a bug in committed code — it is an incomplete cluster.** The fix is simply to finish Cluster 1 (Task 1.1 onward). **Do NOT leave the branch in this state**; either finish Cluster 1 or, if abandoning, reset the seed/schema back to `list`.

**The test suite stays green despite this** precisely because no test yet creates a `type:'table'` view through the `routes/views.ts` boundary — that coverage arrives in Task 1.1's RED test. This is a textbook validation-vs-use gap; Task 1.1 is what closes it.

---

## What's DONE (committed, verified)

| Commit | Task | What |
|---|---|---|
| `6fb3be32` | — | Phase 6 plan committed (`docs/superpowers/plans/2026-06-16-phase-6-views.md`) |
| `1e0b9e85` | **1.0** | `views.settings` JSON column. Schema + migration `0037_views_settings.sql` (journal idx 38) + Zod widen in `routes/views.ts` + web `View`/`ViewCreate`/`ViewPatch` types. 3 round-trip tests. |
| `a2e86dea` | **1.0b** | Backfill migration `0038_backfill_list_to_table.sql` (journal idx 39, `UPDATE views SET type='table' WHERE type='list'`) + seed default view `list`→`table` (kanban Board view untouched) + `'table'` added to `schema.ts` enum ONLY. 3 tests (2 migration + 1 seed). |

Both migrations were **hand-authored** (see migration hazard below).

---

## What's NOT done (Cluster 1 remaining — resume here)

Per the plan `docs/superpowers/plans/2026-06-16-phase-6-views.md` (Cluster 1 section):

- [ ] **Task 1.1 — widen view-type enum across all 4 sites** (add `table`+`calendar`+`timeline`+`gallery`). **DO THIS FIRST on restart** — it closes the validation-vs-use gap causing the 422s. Note `schema.ts` already has `table` (not the other 3 values); the other 3 sites have neither. RED test: creating a `calendar`/`table` view is accepted at the boundary; unknown type still rejected 422.
- [ ] **Task 1.2 — `useActiveView` + `<ViewRouter>`** (CREATE `apps/web/src/lib/api/use-active-view.ts` + `apps/web/src/components/views/view-router.tsx`; the renderer convergence point, invariant 18). Neither file exists yet.
- [ ] **Task 1.3 — unified `/t/$tslug` renders `<ViewRouter>`; legacy `/work-items`+`/board`+`/t/$tslug/board` redirect** (no 404).
- [ ] **Task 1.4 — new-view-sheet offers all 5 types** (today: List/Kanban only at `new-view-sheet.tsx:144-168`).
- [ ] **Task 1.5 — `resolveViewNav` → unified route for all types** (`apps/web/src/lib/rail-nav.ts`; retire the per-type `/board` branch).
- [ ] **Task 1.6 — project tabs → saved-view switcher + G4 operator-panel toggle** (`w.$wslug.p.$pslug.tsx` TABS → per-view; `BoardControls` gate `activeTab==='board'` → `activeView?.type==='kanban'`; add visible `agentPanelBus.toggle()` button in `main-frame.tsx`).
- [ ] **Task 1.7 — update `ARCHITECTURE-INVARIANTS.md` invariant 18** (name `<ViewRouter>`/`viewRendererFor`/`useActiveView`; `check:invariants` green).
- [ ] **`── REVIEW GATE ──` (FULL tier)** — integration gate + test-effectiveness + feature-acceptance browser pass + full finder panel + `security-sentinel` (migration non-destructive) + `invariant-auditor`. **STOP for user sign-off before Cluster 2a.**

Then Clusters **2a** (group-summary SQL endpoint, FULL), **2b** (grouped-list UI), **3** (image field), **4** (calendar), **5** (timeline), **6** (gallery) — all per the plan.

---

## Hazards / decisions the next session MUST know

1. **`bun run db:generate` is UNUSABLE on this repo — hand-author every migration.** The drizzle meta snapshot (`apps/server/src/db/migrations/meta/0006_snapshot.json`) lags ~5 migrations (carries dropped `memberships`, lacks `auth_rate_limits`), so `db:generate` drops into an interactive `memberships→auth_rate_limits` rename prompt and emits destructive recreate/rename noise. Hand-author the `.sql` (clean single statement) + hand-add the `meta/_journal.json` entry. Precedent: migrations 0034/0035/0036/0037/0038 are all hand-authored. (Auto-memory: `feedback_drizzle-generate-stale-snapshot`.)
2. **Migration tests** run against a PRE-SEEDED non-empty table via `sqlite.exec(readFileSync(<.sql>))` after the real `migrate()` chain runs once (drizzle `migrate()` is idempotent). Verify the exec actually mutated rows (no silent no-op). Split multi-statement SQL on `--> statement-breakpoint`.
3. **Run server tests from INSIDE `apps/server`** (`cd apps/server && bun test`). From repo root, a cwd module-init cascade fakes ~650 failures. tsc is per-app (no root tsconfig). Web tests use `npx vitest run`, NOT `bun test`.
4. **Lint:** `noExplicitAny` is a `warn` (82 pre-existing) — `bun run lint` still exits 0. NEVER `--no-verify` on warnings; only error-severity (organizeImports/format) blocks, auto-fix via `biome check --write`.
5. **`list` vs `table` semantics (locked):** `table` = the existing spreadsheet renderer (TableView). `list` = the NEW grouped-list renderer (Cluster 2b). The `0038` backfill rewrote existing `list` rows → `table` so no existing project's default silently becomes a grouped list.

## Harness state
- This is **Class B** (executing an existing written plan). Stage-1 freshness review was DONE — two `Explore` agents ground-truthed all 23 plan claims across Clusters 1 & 2a against current source: **zero drift** (one cosmetic note: the field-key regex `/^[a-zA-Z0-9_]+$/` lives at `services/documents.ts:313`, not the ~98 the plan cited — thread the real line into the Cluster-2a L.1 dispatch).
- Gating decision (user): **stop at every `── REVIEW GATE ──`** for the tier-appropriate review panel before the next cluster.
- The `## Threat model — group-summary endpoint` (mitigations 1–8) in the plan is the convergence target for the Cluster 2a FULL review. The Cluster-2a ground-truth confirmed the reuse template: `filterCompile` whitelist+caps (`packages/shared/src/filter-compile.ts`), `fieldSortExpr` json_extract (`services/documents.ts:102`), the 8192-byte HIGH-2 guard (`routes/documents.ts:177`), `pScope`/`getProject`, and the `tx.all<T>(sql\`...\`)` raw-SQL pattern to mirror at `services/agent-runs.ts:1214`.

## How to restart
1. `git checkout phase-6/views` (3 commits ahead of main; working tree clean).
2. Re-run the four green checks in the TL;DR table to confirm nothing rotted.
3. Load `netdust-agent:harnessed-development`; resume at **Task 1.1** (the enum widen — closes the 422 gap first).
4. Continue Cluster 1 → its FULL REVIEW GATE → stop for sign-off.
