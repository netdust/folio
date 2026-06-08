# Shake-out manifest — fix/thinking-model-tool-calls

**Date:** 2026-06-08
**Branch:** `fix/thinking-model-tool-calls` (provider seam: thinking-model tool calls,
IPv6 loopback, review fixes, whitelist-gate regression fix)
**Range:** `c871060..HEAD` | Type: Bun/TS monorepo (server + web SPA)

## Phase 1 — SWEEP results

| # | Check | Expected | Actual | Severity |
|---|-------|----------|--------|----------|
| 1 | Smoke: server `/healthz` + operator_model resolves | 200, key resolves | 200; `ollama/qwen3:8b base=127.0.0.1` resolves | — PASS |
| 2 | Error-sanitization no-leak (sanitize-error suite) | no baseUrl/key/model echo | green | — PASS |
| 3 | Run error-surfacing → conversation (a461d44) | failures surface, sanitized | green (4 tests) | — PASS |
| 4 | Conversation/operator integration | runs work | green | — PASS |
| 5 | `done.reason` consumers consistent with the whitelist gate change | FIX#2/#3 still key correctly | confirmed (FIX#3 keys tool_use+zero; distinct) | — PASS |
| 6/7 | No stale `tool_use` assumption after adapter relabel deletion | adapters report honest reason | confirmed | — PASS |
| 8 | Biome lint on touched files | clean | 5 errors — **ALL PRE-EXISTING** (present in `c871060` base via `git show`; my diff added none) | — NOT THIS BRANCH |
| — | Feature-acceptance: cockpit via real browser + backend wire | tool runs, real answer, no `(no output)`/network error | PASS (drove "how many work items" → `list_documents` ran → answered) | — PASS |
| — | Full suites | green | server 1695 / shared 70 / web 902, 0 fail; tsc clean | — PASS |

## Phase 2 — MANIFEST

**Bugs found in this branch's changeset: ZERO.**

The only sweep flag (biome, SWEEP 8) is pre-existing lint debt in `openai.ts`
(`noImplicitAnyLet` line 66, `noAssignInExpressions` line 132) — verified present in
the pre-branch base, not introduced here. Out of scope for this branch (would be a
codebase-wide lint cleanup).

The earlier-session gap-hunt already found + fixed the bugs this branch *could* have
shipped (the refusal/pause_turn tool-execution regression, silent max_tokens
truncation, reasoning leak, altitude divergence) — all committed with RED-on-revert
tests BEFORE this shake-out. The test-effectiveness audit (Step 0) closed 2 blind
paths (fail-closed + the dropped-intent comment). Pre-existing provider-seam bugs
(G1–G6) are filed for a separate branch at `tasks/followup-provider-seam-hardening.md`.

## Phase 3 — FIX

No bugs to fix (manifest empty). Skipped per shake-out protocol.

## Status: CLEAN — proceed to the reviewer pass.
