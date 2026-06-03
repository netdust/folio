# Shake-Out Manifest — Agent Authority + Skill Reach (Pieces A + B)

**Date:** 2026-06-03
**Branch:** `spec/agent-authority-and-skills`
**Plan:** `docs/superpowers/plans/2026-06-03-agent-authority-and-skills.md`
**Artifact:** server-side authorization (nullable token reach, instance tokens, scope gate, operator) + skill reach (`__system` resolution, `get_skill`, `set_skill_trust` bless gate).

## Environment

Isolated standalone server: `PORT=3009`, `DATABASE_URL=file:/tmp/folio-shakeout.db` (wiped pre-run), test `FOLIO_MASTER_KEY`, `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION=true`. Exercised over real HTTP + the MCP tool endpoint (the feature is server-side authz/skills, not a browser flow — browser surface covered by the Playwright run separately).

## Phase 1 — SWEEP results

### Track A (automated, real HTTP / MCP) — ALL PASS

| # | Surface | Check | Result |
|---|---------|-------|--------|
| 1 | smoke | server boots, `/api/v1/health/healthz`, 0 server errors across whole sweep | ✅ |
| 2 | Phase A | first registration → `__system` owner (`is_system_member:true`); 2nd registration NOT owner | ✅ |
| 3 | A7 | owner mints reach=null instance token (`instance:true`, 201) | ✅ |
| 4 | A7 / T1 (neg) | non-`__system` member minting reach=null → 403 "not a member" | ✅ |
| 5 | A10 | instance bearer (no cookie) creates a workspace → 201 | ✅ |
| 6 | A4 | instance bearer creates + lists a project in a workspace it is NOT a member of → 201/200 | ✅ |
| 7 | A9 carve-out | operator token row: `workspace_id=null`, `agent_id` KEPT, `created_by=null` (T8 marker) | ✅ |
| 8 | A12 | `GET /instance/tokens` (session, `__system` admin) lists null-workspace tokens; `tokenHash` absent (redacted) | ✅ |
| 9 | A12 (neg) | non-admin `GET /instance/tokens` → 403 `requireInstanceAdmin` | ✅ |
| 10 | A6 / T6 | full-scope instance token `folio_api POST /tokens` → `refused: secret-class write…` | ✅ |
| 11 | A6 / T5 | full-scope token `folio_api` to an unmapped path → `refused: no scope mapping` (default-deny) | ✅ |
| 12 | B5 | MCP `initialize` returns the `get_skill` discovery instructions pointer | ✅ |
| 13 | B2 | `get_skill('folio')` pulls cross-`__system` body (trusted=true, 5816 bytes, description present — B4 seed) | ✅ |
| 14 | B2 / T7 (neg) | `get_skill('operator')` (an agent doc) → "skill not found" | ✅ |
| 15 | B3 / T8 (neg) | human-origin token (`createdBy`=owner) `set_skill_trust` → `refused: forbidden…`; folio stays trusted=1 | ✅ |

### Track B (manual / browser)
- The only NEW UI is the A11 token-create reach toggle + admin-scope checkboxes — covered by vitest (`token-create-modal.test.tsx`).
- Full Playwright e2e run: **29 passed, 2 skipped, 3 failed**. The 3 failures are **PROVEN pre-existing on `main`**, not regressions — see below.

## Phase 2 — MANIFEST

**Zero defects found in the auth/skills feature.** Every new authorization + skill-trust surface behaves correctly on the real wire, including all negative-path guards (T1/T5/T6/T7/T8). No server-side errors logged across the entire sweep.

### Pre-existing e2e failures (NOT this branch — recorded as debt, not fixed here)
Confirmed by: (a) this branch's only web-src change is `token-create-modal` (A11); (b) the failing specs exercise the project frame / wiki / agent-picker — surfaces untouched here; (c) re-ran with FRESH servers (after killing stale 09:13 dev servers that `reuseExistingServer` had silently reused) → same 3 failures, reproducible.

1. `click-through.spec.ts:61` "sign up → … → land on work-items" — asserts a **"Wiki" frame tab** that commit **`4694ad7` (phase-3.x, on main) deliberately removed**. Workspace+project creation itself succeeds (reaches work-items URL). Stale assertion.
2. `click-through.spec.ts:323` "wiki: new page + title edit in tree" — same wiki-surface staleness.
3. `phase-2-5-workspace-agents.spec.ts:10` "assignee picker filters by project" — agent-picker dialog interaction; pre-existing, untouched by this branch.

→ Tracked as e2e test debt on `main`. Fixing them is unrelated test maintenance, out of scope for this branch (user decision 2026-06-03).

## Phase 3 — FIX

Skipped — manifest empty (zero feature defects).

## Status

✅ Shake-out complete. Auth + skills artifact verified end-to-end in a real environment. Zero defects. 3 pre-existing e2e failures recorded as `main` debt (not blockers).
