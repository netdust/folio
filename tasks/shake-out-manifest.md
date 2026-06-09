# Shake-out manifest — fix/provider-seam-hardening

**Date:** 2026-06-09 | Type: Bun/TS monorepo (server + web SPA)
**Range:** `6baeb94..HEAD` (G1–G6 provider-seam fixes + tests)
**Threat model:** `docs/superpowers/plans/2026-06-09-provider-seam-hardening.md`

## Phase 1 — SWEEP results

| # | Check | Result |
|---|-------|--------|
| 1 | All 4 adapters parse a normal stream end-to-end (no G1–G6 regression) | PASS |
| 2 | G1 cross-adapter: truncated → no done; complete → done (ollama/anthropic/openai) | PASS (feature-acceptance verified all 3 un-mocked) |
| 3 | G2 runner path: UNMETERED warn uses a valid providerLabel; run completes | PASS |
| 4 | **G4 partial-malformed edge:** a chunk with BOTH a malformed AND a valid tool_call → skips bad, keeps good | PASS (live-verified — surfaced only `good`) |
| 5 | G3 synthesized-id round-trips like a real id | PASS (unit) |
| 6 | Biome on touched files | 2 errors — **PRE-EXISTING** (openai.ts:66 noImplicitAnyLet, :132 noAssignInExpressions; present in the `6baeb94` base via git show; my diff added none — `let sawTerminal` is typed) |
| — | Feature-acceptance (un-mocked seam parsers) | PASS (3/3) |
| — | Full server suite | 1723 pass, tsc clean |

## Phase 2 — MANIFEST

**Bugs found in this changeset: ZERO.**

The only sweep flag (biome, #6) is pre-existing lint debt in openai.ts — verified
present in the pre-branch base (same debt the thinking-model shake-out flagged
2026-06-08). Out of scope (codebase-wide lint cleanup, not this branch).

The G2 ground-truth correction (MAX_TOOL_ROUNDS already bounds the loop → G2 is an
observability gap, not unbounded spend) was made DURING execution and is recorded in
the punch-list + commit. Token-estimation deferred (threat model deferral).

## Phase 3 — FIX

No bugs to fix (manifest empty). Skipped per shake-out protocol.

## Status: CLEAN — proceed to the reviewer pass.
