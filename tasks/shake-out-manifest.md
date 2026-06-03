# Shake-out manifest — instance AI config in `__system`

Branch: `spec/instance-ai-config` | Swept: 2026-06-03 | Type: Bun/TS monorepo (server + web SPA)

Unit/integration: server 1404 pass / shared 63 / web 766 — all green. tsc clean (3 pkgs).
Sweep target: code paths the test suite doesn't exercise — stale references to the
removed per-workspace AI-key route/column after the instance consolidation.

## Bugs

### Cluster A — live consumer of the DELETED per-workspace AI-key route
The server route `GET /api/v1/w/:wslug/settings/:workspaceId/ai-keys` was removed
(T7), but a web client + one live consumer still call it. They now 404 silently.

- **A1 — CRITICAL** — `apps/web/src/components/slideover/document-slideover.tsx:33,581`
  uses `useWorkspaceAiKeys(wslug, workspace.id)` to compute `aiConfigured`, which
  gates the body editor's AI slash commands (`/ai`, `/draft`, …). The route is gone →
  404 → `aiConfigured` is ALWAYS false → **AI slash commands silently vanish from the
  editor for every user.** A real user-facing regression the unit tests didn't catch
  (the component test likely mocks the hook).
  → FIX: repoint at `useInstanceAiKeys()`.

- **A2 — IMPORTANT** — `apps/web/src/lib/api/settings.ts` still exports
  `useWorkspaceAiKeys` / `useUpsertAiKey` / `useDeleteAiKey`, all pointing at the
  removed route. Dead, misleading code; `settings.test.tsx` tests it (a green test for
  a 404 route). Once A1 is repointed, the three hooks have no consumer.
  → FIX: delete the three dead hooks (keep `AiProvider` + `AiKey` type re-exports,
  still imported for typing); delete the dead hook tests in `settings.test.tsx`.

### Cluster B — dev/diagnostic scripts broken against the new schema/route
Not shipped (the binary doesn't include `scripts/`), but they're this phase's own
smoke tooling and will fail if run.

- **B1 — MINOR** — `apps/server/scripts/seed-ollama-key.ts:27,34` inserts/queries
  `ai_keys` with a `workspace_id` column that no longer exists (migration 0023). Will
  throw `no such column`.
  → FIX: drop `workspace_id` from the insert/select.

- **B2 — MINOR** — `apps/server/scripts/{diagnose-http-chain,shakeout-cross-ws-operator,
  shakeout-cross-ws-triggers}.ts` POST the AI key via the removed per-workspace path.
  Will 404.
  → FIX: repoint at `POST /api/v1/instance/ai-keys` (session-cookie as a __system admin).
  NOTE: these are larger scripts; if the repoint is non-trivial, DEFER with a header
  note rather than block the merge (they're manual smoke tooling, not CI).

### Cluster C — stale comments (cosmetic)
- **C1 — MINOR** — `apps/web/src/components/settings/ai-tab.tsx:68,75` comments
  reference `useUpsertAiKey` (old hook name). Cosmetic.
  → FIX: update the comment hook name, or leave (harmless).

## Non-bugs (swept, confirmed OK — do not fix)
- `folio-api-tool.test.ts` tests `pathToScope`/`isSecretWrite` against the old path
  STRING — still valid: the classifier guards the `/ai-keys` keyword branch regardless
  of whether a route exists at that exact path. Green.
- `phase-gate-a.integration.test.ts` asserts a `folio_api` PATCH to the old ai-keys
  path is REFUSED — still holds (SECRET-class refusal fires before routing; the 404 is
  never reached). Verified green.
- `ai-tab.tsx` / `provider-model-field.tsx` import only the `AiProvider` TYPE from
  settings.ts — legitimate, keep.

## Status
- [x] A1 — CRITICAL — FIXED. Root cause: editor's aiConfigured read the admin-gated
      key LIST via a deleted route. Fix: added presence-only `ai_configured` boolean to
      /auth/me (readable by ANY member, no key material), editor reads `me.ai_configured`.
      Correctly preserves AI slash commands for non-admin members (naive repoint to the
      admin-gated list would have regressed them). +1 server test.
- [x] A2 — IMPORTANT — FIXED. settings.ts reduced to types-only (AiProvider/AiKey);
      3 dead hooks removed; settings.test.tsx (tested only the dead hooks) deleted.
- [x] B1 — MINOR — FIXED. seed-ollama-key.ts rewritten for the instance model
      (dropped workspace lookup + workspace_id column; idempotent on (provider,label)).
- [x] B2 — MINOR — FIXED. All 3 diagnostic scripts repoint the ai-key POST to
      /api/v1/instance/ai-keys. tsc clean. Runtime exercise needs a live server +
      real key (the user smoke gate) — compiles correctly against the new route.
- [x] C1 — MINOR — FIXED. Stale `useUpsertAiKey` comment refs → `useUpsertInstanceAiKey`.
