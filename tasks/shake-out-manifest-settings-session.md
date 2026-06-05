# Shake-out manifest — Settings/token/invite/remove session

Branch: `spec/drop-workspace-tenancy` · Range: `4ddf8f6..HEAD` (136 commits, 145 files)
Date: 2026-06-05

## Phase 1 — SWEEP

### Track A (automated, live server) — 0 bugs
- Smoke: server boots clean, `/auth/me` unauth → 401 (no 500). ✅
- `POST /instance/tokens`: happy 201, malformed→400, over-scope→403 (FORBIDDEN_SCOPE). ✅
- `GET /instance/tokens`: owner→200, member→403, bearer→401 (session-only). ✅
- `POST /instance/invites`: valid→200, malformed email→400, member→403. ✅
- `DELETE /instance/users/:id`: self→409 CANNOT_SELF_DELETE, nonexistent→404, member→403, bearer→401. ✅
- MCP content-shape fix: `folio_api_get` bare `{status,body}` now returns non-empty `content[]`; `list_workspaces` passes through. ✅
- All denial paths (member + bearer) rejected on every new instance surface. ✅

### Track B (manual, browser) — user sign-off: "yes, allgood"
- Settings page: all 4 sections render, opens in rail. ✅
- Invite / remove member flows. ✅
- Per-workspace tokens on Agents & Triggers → API. ✅
- Landing → last-opened workspace; removed surfaces gone. ✅

## Phase 2 — MANIFEST

**EMPTY — zero bugs found.** Sweep + manual both clean.

Gates: server 1499/1-skip/0, web 779/8-skip/0, shared 63/0, tsc ×3 clean,
e2e 39-pass (3 PRE-EXISTING click-through/phase-2-5 failures, byte-identical to main).

## Phase 3 — FIX

Skipped (empty manifest).

## Step 4 — reviewer panel: pending (dispatched next).
