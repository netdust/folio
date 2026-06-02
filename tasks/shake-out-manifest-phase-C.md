# Shake-Out Manifest — Phase C (cross-workspace triggers)

**Branch:** `phase-op-3/the-agent` · **Swept:** 2026-06-02 · **Diff:** `4e06b1f..HEAD`

**Artifact exercise (the "does it actually work" core):** Stefan ran the real-key trigger-fired gate (commit `56a99f1`) — DB-confirmed the operator REFUSED an injected MEDIUM table AND the C3 floor fired on a real run. The C3 deterministic bound is PROVEN on the API-provider path.

**Automated gates (Track A):** server 1261/1-skip/0 · shared 63/0 · web 750/8-skip/0 · tsc clean ×3 · no migration. All GREEN.

**Reviewer fleet:** invariant-auditor (CLEAN), architecture-strategist (SOUND), performance-oracle (NO_CONCERNS), security-sentinel (2 CRITICAL — see below), + the prior `/code-review high` (3 findings, all fixed).

---

## Findings

### S-1 — [CRITICAL] (claude-code path) The C3 unattended floor is bypassed for a `claude-code`-provider agent
**Cluster: cc-path-authority (shared root with S-2).**
- **Where:** `runner.ts:1064-1148` (`ccExecute`) + `routes/mcp.ts:172-187`. `ctx.unattended` is threaded into `executeTool` ONLY on the API-provider `runLoop` path (`runner.ts:911-915`). The claude-code provider spawns the `claude` CLI, whose tool calls re-enter via `/mcp`, which calls `executeTool` with NO `unattended` flag → treated as attended → the agents:write floor (review-fix #1) AND the folio_api MEDIUM floor are both inert.
- **Attack:** Malicious B content triggers the run AND injects the cc operator → it performs MEDIUM config writes + `agents:write` token-minting (`create_agent`/`run_agent`), unattended, unfloored.
- **Scope:** This IS the documented accepted residual **C3-CC-1** (`tasks/retro-follow-ups.md`), but the sweep found it's WORSE than documented: not just MEDIUM-config — also HIGH `agents:write` token minting.
- **Pre-existing?** The cc callback mechanism pre-dates Phase C; the floor (Phase C) just doesn't reach it. Phase C makes it reachable via an unattended trigger fire.
- **Shipped operator affected?** NO — operator defaults to `provider:'anthropic'` (floored). LIVE only for an agent explicitly set to `claude-code`, which is `FOLIO_CLAUDE_CODE_ENABLED`-gated (OFF by default).

### S-2 — [CRITICAL] (claude-code path) The caller SCOPE ceiling (agent ∩ caller) collapses to a no-op on the cc/MCP callback
**Cluster: cc-path-authority (shared root with S-1).**
- **Where:** `runner.ts:1075` (`ccToken` copies `ctx.token.scopes` — the agent's FULL declared scopes; `narrowedToken` narrows projectIds but NOT scopes — scopes are intersected with caller ONLY in executeTool) + `mcp.ts:185` (`callerScopes: token.scopes` → `token.scopes ∩ token.scopes` = no-op).
- **Attack/impact:** A trigger-fired cc library agent invoked on behalf of a low-privilege B MEMBER executes with the LIBRARY AGENT's full declared scopes (e.g. config:write, agents:write), bounded only by projectIds. The caller-bounded-authority model (Phase B B5 / C5) — the reason a member can safely fire a powerful `__system` operator — does NOT hold on the cc callback.
- **Pre-existing?** YES — this is a **Phase B gap** (the cc/MCP scope-narrowing was never wired). Phase C's cross-workspace unattended firing makes it directly reachable + materially worse (S-1 stacks: not even the floor catches it).
- **Shipped operator affected?** NO — same as S-1 (anthropic default; cc is off by default).

### (verified CLEAN by the sweep — recorded, no action)
- C1 third-workspace boundary sound (home predicate + id-handle assertion + review-fix-#3 verbatim fallback is parent-scoped → no cross-tenant reach).
- C4/C5/C6 sound ON THE API PATH (caller server-derived, unattended server-derived, C6 forbids caller-less library, autonomy gate suppresses chains).
- No secret/token leak (floor errors echo only static tool name + model's own args; minted tokens revoked in finally).
- Invariants 2/3/5/7/10 all ROUTE-THROUGH (the executeTool floor STRENGTHENS invariant 2).
- Perf: all new queries index-covered + cold-path; the `executeTool` Set.has is O(1).

### (low-severity cleanups — not blockers, optional)
- A-1 [minor] `findSystemWorkspaceId` resolved twice per fired library run (resolveAgentForRun + C2 check) — cheaper: resolveAgentForRun returns is-library.
- A-2 [minor] `TriggerAgentField` ~80% duplicates `AssigneePicker` — consolidate on rule-of-three.

---

## Disposition — RESOLVED (Stefan: "claude-code doesn't work, hard-disable it")

S-1 + S-2 share ONE root cause: the claude-code provider executes via a spawned CLI that re-enters through `/mcp`, a generic token-scoped surface UNAWARE of run-derived authority (`unattended` AND `caller_scopes`).

**FIX (commit `a5d0966`): claude-code HARD-DISABLED at the runner preflight.** The `preflight` gate (`runner.ts:~553`) now refuses ANY `claude-code` run regardless of `FOLIO_CLAUDE_CODE_ENABLED`. Because both `runAgent` (`:203`) and `runAgentResume` (`:287`) call `preflight` BEFORE branching to `ccExecute` (`:209`/`:293`), **`ccExecute` is now UNREACHABLE — S-1/S-2 are unreachable by construction** (the CLI never spawns, the `cc-run:` token is never minted, the unfloored `/mcp` callback never happens). `routes/workspaces.ts:112` reports `claude_code_enabled: false` always (UI won't offer it). The provider ENUM stays intact (historical run/agent rows with `provider:'claude-code'` still PARSE — they fail at preflight with `claude_code_disabled`, not a parse crash). `ccExecute` kept with an UNREACHABLE banner for the eventual cc-path-authority revival.

**Re-sweep VERDICT: S1_S2_CLOSED=YES, COLLATERAL=none, ENUM_INTACT=yes.** Verified `ccExecute` has no other caller; the anthropic default + seeded operator unaffected; 6 existing cc-execution tests updated to assert refusal + 3 new (hard-disable proof / anthropic no-regression / workspaces-route-false). Gates after fix: server **1260**/1-skip/0, web **750**/8-skip/0, tsc clean.

**RESIDUAL (now a REVIVAL gate, not a live gap):** cc stays disabled until the cc-path authority is threaded through the `/mcp` CLI re-entry (carry `unattended` + caller-narrowed scopes on the cc-run minted token). Re-enabling cc without that reopens S-1/S-2. The old `C3-CC-1` residual is SUPERSEDED by this hard-disable (the gap is no longer reachable). Tracked in `tasks/retro-follow-ups.md`.

## Status: ALL findings resolved or unreachable. Cleanups A-1/A-2 deferred (optional, non-blocking). Shake-out COMPLETE.
