# Shake-out manifest — fix/mcp-error-leak-and-auth

**Date:** 2026-06-09 | Type: Bun/TS monorepo (server + web SPA)
**Range:** `e962a72..HEAD` (the 4 MCP transport fixes + audit tests)

## Phase 1 — SWEEP results

| # | Check | Result |
|---|-------|--------|
| 1 | Smoke: all 4 MCP methods (initialize/ping/tools-list/tools-call) | PASS |
| 2 | Cross-transport: registry change is MCP/runner-only (HTTP uses its own service errors) | PASS (verified — documents.ts route doesn't import the registry) |
| 3 | Runner suite (registry's other consumer, recoverable-error path) | PASS |
| 4 | agent-tools (executeTool) suite | PASS |
| 5 | MCP test trio (route + error-mapping + result-shape) | PASS |
| — | Feature-acceptance: MCP wire, 6 edge classes + happy path | PASS (7/7, un-mocked wire) |
| — | Full server suite | 1712 pass, tsc clean |

## Phase 2 — MANIFEST

### BUG-1 — [IMPORTANT] Agent-facing validation messages lost to `internal error` (M-MCP-1 side-effect)

**Symptom:** an agent calling `list_documents` (and many tools) with a wrong
`project_slug` / `workspace_slug` now gets `{ code: -32603, message: "internal error" }`
instead of the useful `"project not found"` / `"workspace not accessible"`. VERIFIED live:
`list_documents` + `list_views` on a bad project both return `internal error`.

**Root cause:** M-MCP-1 correctly sanitizes raw `Error`s (no leak), but ~10 AGENT-FACING
VALIDATION throws in `agent-tools-registry.ts` were never shaped:
- line 163/169 `workspace not accessible`
- line 237 `project not found`
- line 312 `table not found`, 319 `project has no tables`
- line 470 `skill not found`
- line 1208 `view not found`
- line 1399/1458 `comment not found`
These reach the catch-all → sanitized → the agent CANNOT self-correct (can't tell a typo'd
slug from a server fault). Degrades the core agent-first UX of the entire MCP surface.

**NOT a leak / crash** — the messages are safe + deliberate; the fix is to SHAPE them
(mcpInvalidParams, -32602 + a reason) so they survive the keep/sanitize split, exactly like
the `document not found` / `parent not found` throws already shaped in M-MCP-1.

**Cluster:** one root cause, one fix (shape the validation throws). The genuinely-internal
throws (`frontmatter must be an object`, `missing or invalid argument`) — decide per case;
`missing/invalid argument` is also agent-facing (shape it), `frontmatter must be an object`
is borderline (a type-guard, shape it for consistency).

## Phase 3 — FIX

**BUG-1 RESOLVED** (via systematic-debugging). Root cause: M-MCP-1 sanitizes raw `Error`s,
but ~17 agent-facing validation/routing throws in the registry were never shaped.

Fix (one root cause): converted all 15 agent-facing raw `throw new Error(<message>)` to
`mcpInvalidParams(<message>, { reason })` so they survive the keep/sanitize split with a
`reason` code for programmatic branching — workspace/project/table/view/skill/comment
not-found, the agent_run routing hints, frontmatter type-guard, missing-argument, and the
link-target hint. The 2 `forbidden: ui tools` throws were KEPT as raw `Error('forbidden: …')`
(the runner uses the `forbidden:` prefix to classify them FATAL — converting them would flip
fatal→recoverable) and the MCP mapper gained a `forbidden:` branch that keeps the safe
authority message instead of sanitizing it.

Live re-sweep: `project not found`, `workspace not accessible`, `view not found`,
`forbidden: ui tools …` all surface with actionable messages (was `internal error`).
RED-on-revert proven. Full server suite: 1715 pass, tsc clean. No collateral (runner /
agent-tools / HTTP consumers unaffected — the throws are registry-internal, MCP/runner-only).

## Status: 1 IMPORTANT finding — RESOLVED. Shake-out CLEAN.
