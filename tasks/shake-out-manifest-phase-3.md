# Shake-out manifest — Phase 3 (agent runner)

**Date:** 2026-05-30
**Branch:** `phase-3/agent-runner` (pre-merge to main)
**Sweep:** F-4 live e2e (real Anthropic, USER-run — pending) + F-5 four reviewer agents (architecture / security / simplicity / performance) + controller verification of the headline finding.

> **Iron Law:** this is the SWEEP record. No fixes applied yet. Fixes happen in Phase 3 (FIX) after sign-off, one at a time via systematic-debugging.

---

## CRITICAL — blocks merge

### C1 — `GET /documents?type=agent_run` bypasses the agent_run wall, leaks `system_prompt`
**File:** `apps/server/src/routes/documents.ts:130-185` (list handler) → `services/documents.ts:145,184`
**Source:** security-sentinel (CONFIRMED by controller).
**What:** The single-doc GET, markdown GET, PATCH, DELETE, and all MCP read tools reject `type=agent_run` (`AGENT_RUN_REQUIRES_RUNNER_PATH`). The REST project-scoped LIST handler does NOT — it guards only `agent`/`trigger` (line 138), passes `agent_run` straight to `listDocuments`, which matches it in `KNOWN_TYPES` and returns full Drizzle rows **including `frontmatter.system_prompt`** (operator-authored agent instructions), provider, model, chain_id, tokens, error_detail.
**Reach:** any `documents:read` human PAT, or any agent-bound bearer allow-listed to the project (`requireResource` narrows projects, not row types).
**Not exposed:** the BYOK key itself (stays in the encrypted `aiKeys` table, never copied to frontmatter). So this is prompt/config disclosure, not credential theft.
**Defeats:** mitigation R2 (the read-side agent_run wall) — the threat model assumed the wall was complete across ALL read paths; this is the one it missed.
**Aggravator:** `documents.test.ts:1253` ("R2: explicit ?type=agent_run...") rubber-stamps it with `expect([200,422])` and a comment that FALSELY claims "an attacker ... would still be unable to dump system_prompt" — the list response IS the dump; `get_document` isn't needed.
**Fix direction:** reject `type==='agent_run'` in the list handler with the same 422 used elsewhere (mirror the `agent`/`trigger` block at `documents.ts:138`); rewrite the test to assert 422 + no `system_prompt` in any body.

---

## IMPORTANT — fix before merge (or before customer deploy)

### I1 — agent-bound tokens read other agents' `system_prompt` via workspace agent list/get
**File:** `apps/server/src/routes/workspace-documents.ts:109-121` (list), `:123-132` (get-by-slug)
**Source:** security-sentinel.
**What:** H7 closed the cross-agent leak on the event-history endpoint (`:294-301` 404s an agent reading another agent's row), but the sibling LIST and single-GET apply no such narrowing. An agent-bound `documents:read` token calls `GET /w/:wslug/documents?type=agent` → receives every agent's full row (`system_prompt`, allow-list, tools).
**Severity nuance:** the GET handlers predate this branch (only POST/PATCH guards were touched in Phase 3) → NOT a Phase-3 regression, so it doesn't strictly block THIS merge, but it's in the assembled attack surface and should be fixed before a customer deploy. Apply the H7 filter (`token?.agentId && doc.type==='agent' && doc.id!==token.agentId → 404`) to list + get.

### I2 — dispatcher + poller `setInterval` loops have no re-entrancy latch
**File:** `apps/server/src/lib/event-dispatcher.ts`, `poller.ts`, wired in `index.ts`
**Source:** architecture-strategist (+ implied by simplicity).
**What:** Both loops default to 1s; `setInterval` does NOT await the previous async callback, so a slow tick (slow `react()`, a 100-event batch) overlaps the next. Two overlapping dispatcher ticks can both read `seq > cursor` and double-invoke `react()` beyond the intended at-least-once-on-crash semantics. The trigger-matcher idempotency guard absorbs the duplicate, but it's load-dependent wasted work the design doesn't acknowledge.
**Fix direction:** a per-loop `if (running) return;` latch around `runDispatcherOnce`/`runPollerOnce` in their interval callbacks. ~2 lines each.

### I3 — five rate-limit env knobs read unvalidated in the runner's security pre-flight
**File:** `apps/server/src/lib/runner.ts:380-393`
**Source:** code-simplicity-reviewer (Finding 6).
**What:** `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE`, `_PER_AGENT`, `FOLIO_MAX_CHAIN_FANOUT`, `_DURATION_MS`, `_TOKENS` are read inline as `Number(process.env.X ?? default)` on every run, bypassing the Zod-validated `env.ts` singleton every other knob uses. A typo'd env value silently becomes `NaN` in the security-critical guard path; defaults are duplicated in string literals.
**Fix direction:** add the five to `envSchema` with `.default()` + `.min()` floors (exactly like the dispatcher/poller knobs already there); read `env.FOLIO_MAX_...`.

---

## DEFERRED — tracked follow-ups, NOT merge-blocking (record in tasks/retro-follow-ups.md)

### D1 — reactor-halt has no durable read path (banner misses a halt on fresh mount)
**File:** `event-dispatcher.ts:24-46`, `apps/web/src/lib/api/provider-health.ts:75` (`useReactorHealth`)
**Source:** architecture-strategist (I-1). `reactor.halted` is live-only (no events row, no SSE replay). A tab mounting AFTER a halt fires shows healthy. The dispatcher re-fires on the next failed tick, so a *continuously* failing reactor self-signals — but a fresh page load mid-halt misreports. **Direction:** expose cursor-lag (`MAX(events.seq) − reactor_cursors.last_seq`) via `admin-runner-stats` + seed `useReactorHealth` on mount. Worth doing soon (ops-blindness on a self-hosted box) but not a merge gate.

### D2 — cancel/retry run-management logic duplicated HTTP ↔ MCP (~150 lines, security-critical lockstep)
**File:** `routes/runs.ts:282-478` vs `lib/agent-tools-registry.ts:1482-1729`
**Source:** architecture-strategist (I-3) + code-simplicity (Finding 1) — both flagged independently, HIGH. The autonomy-gate + allow-list + idempotency-ordering are copy-pasted across both transports (the "Finding 2" retry-gate fix had to be written twice). Already partially tracked as D-R-3, but severity is under-stated. **Direction:** extract `cancelRunCore`/`retryRunCore` (+ a `prepareRunCreate` gate) into `services/agent-runs.ts`; transports map the neutral thrown error to their envelope. **MANDATORY before `FOLIO_AGENT_CHAINS_ENABLED` is ever flipped on** (five gate sites must stay in lockstep until then).

### D3 — small YAGNI cuts (future cleanup pass)
**Source:** code-simplicity-reviewer.
- `getProvider` sync-proxy-around-async-loader (`provider.ts:144-159`) — both callers are already async; collapse to `await loadProvider`.
- `executeTool` unused `tx?` param + re-declared `DBOrTx` (`agent-tools.ts:23,132`) — no tool reads `ctx.tx`; drop until needed.
- `assertAgentToolsWidening`'s dead `op` param (`agent-guards.ts:141`) — `void op;` admits it.
- `loadContext` collapses 8 distinct failures into one `null`/"skipping" (`runner.ts:234-323`) — a missing agent-row looks identical to a missing parent; split skip-vs-fail-with-reason on a future touch.

### D4 — layering inversion: route exports service-grade helpers
**File:** `lib/agent-tools-registry.ts` imports `createRunForParent`/`loadRunScopedByToken` from `routes/runs.ts`
**Source:** architecture-strategist (M-3). Move them into `services/agent-runs.ts`; bundle with the D2 refactor.

### Already-tracked (E-FOLLOWUP-5/6, D-R-1/3, RUN_KINDS triplication, wiki/slash listbox)
Performance reviewer CONFIRMED E-FOLLOWUP-5 (useRunsLiveSync over-invalidation) + E-FOLLOWUP-6 (N SSE connections/tab) are correctly rated as v1.1 follow-ups, not blockers.

---

## CLEAN — verified no finding

- **Performance:** no merge blocker. Idle cost ~4 indexed no-op SQL reads/sec; all hot-path queries hit the C.1/C.12 partial indexes; SSE fan-out is pure in-memory (no per-event DB work); runner bounded by 25-round cap + token budget; boot cost bounded + indexed. Scales fine to 10× small-team load.
- **BYOK key handling** — AES-256-GCM, keys only in the encrypted `aiKeys` table, never in frontmatter/events/SSE/tool-errors.
- **Tool-error feedback (D-9, mits 64-66)** — paths-only / safe-code-only feed-back verified; never message/values/SDK body.
- **SSRF allow-list** — IPv4/IPv6/mapped/expanded/trailing-dot bypasses all closed; only the documented DNS-rebinding gap remains (acknowledged follow-up).
- **Autonomy gate** — all 5 sites present + gated (the D-8 "2 retry faces" finding confirmed fixed).
- **SSE visibility** — F3 allow-list + `isAgentEventVisible` on both replay + live; public 5-field projection; reactor.halted carries error-class only (mit 53).
- **MCP scope/allow-list** — central scope check + allow-list + widening/self-delete guards + human-PAT rejection on lifecycle tools.
- **Architecture verdict:** sound to merge — planes/boundaries/single-binary/state-machine all right; close I2 before merge, track D1/D2.
- **Simplicity verdict:** acceptably lean (the durable plane is NOT speculative — it's the V1 human-trigger path); cut I3 + D2 region.

---

## F-4 live e2e (USER-run, real Anthropic) — PENDING
`cd apps/web && FOLIO_TEST_ANTHROPIC_KEY="$(cat ../../key)" bun run e2e phase-3-real-anthropic.spec.ts`
Result to be pasted by the user → triaged into this manifest (assign → run → kind=result comment + Runs tab). Pass = the full runner works end-to-end with a real provider. Failure → new finding(s) here.

---

## Fix plan (after sign-off, FIX phase)
1. **C1** (merge-blocker) — first, via systematic-debugging + failing test (the rubber-stamp test rewritten to assert 422).
2. **I1, I2, I3** — before merge, one at a time, each with a failing test first.
3. **D1–D4 + already-tracked** — appended to `tasks/retro-follow-ups.md`, NOT fixed in this shake-out.
4. Re-sweep C1's area + re-run the full server suite after each fix.
