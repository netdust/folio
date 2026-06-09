# Handoff — execute Headless Folio via MCP, Phase 1

**For a fresh session. 2026-06-09.** Everything below is committed; this file is just the "start here."

## One-line start

Execute `docs/superpowers/plans/2026-06-09-headless-folio-via-mcp-phase-1.md` via
`netdust-core:harnessed-development` (Class B — executing an existing written plan).
The plan is complete, self-reviewed against source, and review-clustered. Spec is at
`docs/superpowers/specs/2026-06-09-headless-folio-via-mcp-design.md` (read its `## Threat model`).

## What this builds (in one breath)

Make agents manageable headlessly via MCP for an admin PAT (D1 — a shared
`mayManageAgentLifecycle` gate on `agents:write`), fix the MCP-vs-HTTP default-table
divergence bug (D2 — pin `resolveTableForArgs` to `work-items`), and correct the `folio`
skill (D3). Phase 1 of "headless Folio via MCP"; Phases 2 (triggers) + 3 (instance-admin)
are outlined in the spec as deferred follow-ups — DO NOT start them.

## Non-obvious things the plan assumes

1. **This is a security-boundary loosening, honestly accepted.** D1 re-opens a gate the code
   author deliberately closed (the written rationale at `agent-guards.ts:238` says the
   `agents:write` gate is "insufficient"). The decision (Stefan, 2026-06-09): accept it — a
   stolen admin PAT already holds `delete`+`config:write`, so a pivot agent isn't a larger
   blast radius; bounded by the minted token staying revocable. This is the spec's threat
   model. Do NOT re-litigate it; DO implement Task 1 (verify-first) which proves the
   revocability the whole acceptance rests on.

2. **Invariant 17 is NEW and already authored** (`ARCHITECTURE-INVARIANTS.md`). Task 2 must
   update its citation from `assertNotHumanPatForAgentLifecycle` → `mayManageAgentLifecycle`
   once that symbol exists, then re-run `bun run check:invariants` (must stay 0 errors).

3. **Invariant 12 already names the headless-confirm-gate gap.** D1 is the first feature to
   lean on the documented "headless MCP skips confirm gate" Deliberate exception. Do NOT
   re-flag the missing confirm gate as a fresh bug — it's accepted state (the exception text
   was sharpened 2026-06-09 to cover agent-lifecycle).

4. **Test harness reality (the plan's self-review caught this):** D1/D2 wire tests go in
   `apps/server/src/routes/mcp.test.ts` using its `setupToken(wsId, userId, scopes)` helper +
   `app.request('/mcp', tools/call)`. `agent-tools-registry.test.ts` does NOT exist — don't
   create it. Predicate unit tests → NEW `apps/server/src/lib/agent-guards.test.ts`. Token-
   revoke test → `workspace-documents.test.ts` (has `createAgent`, `mintPAT`).

5. **Two REVIEW GATES need Stefan.** Cluster A (Tasks 1–6) closes with `/integration` +
   `/code-review high` + **`/security-review`** (auth loosening). Cluster B (Tasks 7–8) closes
   with `/integration` + `/code-review`. HALT at each marker — these are user-run.

6. **Dev DB is stale** (STATE.md note): if doing a live/manual check, the local
   `apps/server/folio.db` is on a divergent chain — reseed first (`scripts/reseed-dev.ts`).
   The MCP-only eval that motivated all this is at `tasks/mcp-eval-manifest.md`; re-running its
   flows is the Phase-close feature-acceptance step.

## Branch

Plan + spec + invariant are committed on `main` (commits `b47d625`, `8af9beb`). Start the
implementation on a fresh feature branch (e.g. `mcp/headless-phase-1`) — `harnessed-development`
/ `finishing-a-development-branch` will manage it.
