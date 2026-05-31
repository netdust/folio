# Phase 3 D-9 — Tool-error feedback (runner self-correction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `netdust-core:ntdst-execute-with-tests` (wraps `superpowers:subagent-driven-development`). Step 2.5 plan-freshness per task; two-stage review.

**Goal:** Change the runner so a RECOVERABLE tool error is fed back to the model as a `{role:'tool'}` error message (letting the model retry/adapt within the existing round + token caps) instead of terminating the run. FATAL tool errors still terminate.

**Architecture:** Today `runLoop` (runner.ts) calls `failRun(...) + return` on ANY tool error (terminal-on-tool-error, the "locked spec"). D-9 un-locks that for recoverable errors only: push a sanitized `{role:'tool'}` error message into `messages` and `continue` to the next round, bounded by `MAX_TOOL_ROUNDS=25` + the per-run `max_tokens` budget (both already enforced) PLUS a new per-run consecutive-tool-error sub-cap so a model that loops on the same error gives up faster than 25 rounds. Fatal errors (scope-denied, unknown-tool) still `failRun + return`.

**Tech Stack:** Bun, the existing `runLoop` generator-driven loop on `provider.stream()`, `executeTool`, `agent-run-schema.ts` enum.

**Status:** ✅ SHIPPED 2026-05-30. Approved as-written (both invalid-args + handler-throws feed back; `MAX_CONSECUTIVE_TOOL_ERRORS=3` hardcoded). D-9.1 `695330c` (enum), D-9.2 `b8e6886` (loop change + `safeToolErrorMessage` refinement). Two-stage reviewed; suite 950→960/1skip/0fail. Supersedes the D-9 stub in `2026-05-29-phase-3-D-routes-mcp-real-tools.md`. Originating follow-up: C.2-R-2 (now RESOLVED).

---

## Locked design decisions (resolved at plan-write, confirm at approval)

1. **Recoverable vs fatal split.** `executeTool` throws three distinguishable shapes (verified live):
   - `MCP_INVALID_ARGS` (Zod reject, carries `.issues` paths) → **RECOVERABLE** (feed back the issue PATHS so the model fixes its arguments; paths-only preserves mitigation 26/61 — never the bad values).
   - handler execution throw (e.g. `DOCUMENT_NOT_FOUND`, `SLUG_CONFLICT`, a 4xx from a tool's own logic) → **RECOVERABLE** (feed back the sanitized error so the model can adapt — e.g. pick a different slug, create the missing doc first).
   - `forbidden: scope <X> missing` → **FATAL** (the token cannot gain scope by retrying — terminate `provider_error`, as today). Note: `method not found` is NOT reachable from the model in practice (the model only sees tools from `listTools`/`buildToolDefs` scoped to its grants), but treat it as **FATAL** if it occurs (a hallucinated tool name — retrying won't conjure the tool; terminate).
   - **Rationale:** matches how Claude Code itself surfaces tool errors — bad-args/not-found are correctable by the model, permission/unknown-tool are not. (This is option "Feed back recoverable, terminate fatal" from the design question; confirm at approval.)

2. **The bound.** The existing `MAX_TOOL_ROUNDS=25` + per-run `max_tokens` already cap a feedback loop. ADD a tighter safety: a per-run **consecutive-recoverable-tool-error counter** — `MAX_CONSECUTIVE_TOOL_ERRORS` (default **3**). When the model hits N consecutive rounds where EVERY tool call in the round errored recoverably (no successful tool result, no clean text completion advancing the task), terminate with a NEW error_reason `tool_error` + detail "model failed to recover after N tool errors." A round with at least one SUCCESSFUL tool result RESETS the counter (the model made progress). This stops a model that loops on the same bad call from burning all 25 rounds / the whole token budget. (The round cap + budget remain as the outer backstops.)

3. **New error_reason enum value: `tool_error`.** Add `'tool_error'` to `runErrorReasonSchema` (`agent-run-schema.ts`). Used when the consecutive-error sub-cap (decision 2) is hit. FATAL tool errors (scope/unknown) keep `provider_error` (they're not "the model tried and failed to recover" — they're hard authority/registry failures; preserving `provider_error` avoids reclassifying existing behavior). This gives operators a distinguishable signal: `tool_error` = "model couldn't self-correct," `provider_error` = "hard tool/provider failure."

4. **The fed-back message content (sanitized).** For `MCP_INVALID_ARGS`: `content = "Tool '<name>' rejected the arguments. Invalid fields: <paths>. Fix and retry."` (paths from `err.issues`, NO values). For a handler throw: `content = "Tool '<name>' failed: <sanitizeProviderError(err, providerLabel)>. Adjust and retry."` (sanitized — no raw SDK strings/keys/baseUrl, mitigation 28). The `{role:'tool', tool_use_id: tc.id, content}` shape is the same as a success result; the model sees a tool result that says "error, here's why."

5. **Mixed-batch semantics.** A round can have multiple tool_calls. Current code commits results only if the WHOLE batch succeeds (else terminal). New behavior: build a tool-result message for EACH call — success → result string; recoverable error → error message (decision 4); FATAL error → abort the whole round, `failRun(provider_error) + return` (don't feed back, don't commit a half-round). So a round with one fatal call still terminates; a round where all errors are recoverable feeds all of them back. Commit the assistant message + ALL tool-result messages (success + recoverable-error) atomically, then `continue`. The consecutive-error counter increments only if the round had ZERO successful tool results.

---

## Threat model — D-9 extension (mitigations 64–66)

> Added 2026-05-29 at D-9 plan-write. EXTENDS B(1-22)+C(23-47)+C.3(48-53)+D(54-63). D-9 changes a runner loop that consumes the BYOK budget + emits to the workspace event stream + reads attacker-influenceable tool args. Inherited mitigations (esp. 26 Zod re-validation, 28 error sanitization, 30 token budget, the round cap) remain in force.

### What we're defending (new in D-9)
- **The BYOK budget + runner round capacity against a feedback loop.** Feeding errors back adds provider round-trips. A model (or a prompt-injected one) that loops on a tool error must not burn the whole token budget / all 25 rounds before stopping.
- **The fed-back error message as a NEW data sink the model (and provider abuse logs) see.** A tool error's detail must not leak workspace secrets, key fragments, baseUrl, or the bad arg VALUES into the message that goes to the provider.

### Attacks → mitigations
64. **Feedback loop budget exhaustion / runaway rounds.** A model repeatedly calls a tool with the same bad args; each error feeds back, the model retries identically, burning rounds + tokens. → **Mitigation 64:** `MAX_CONSECUTIVE_TOOL_ERRORS=3` per-run counter (decision 2): N consecutive all-errored rounds → terminate `tool_error`. A round with ≥1 successful tool result resets it. The round cap (25) + `max_tokens` remain outer backstops. Test: a tool that always throws → run terminates `tool_error` after exactly 3 rounds (not 25), tokens bounded.
65. **Bad arg VALUE leaks into the fed-back message → provider abuse logs / attacker-controlled baseUrl (cf. B#2, C#28).** → **Mitigation 65:** `MCP_INVALID_ARGS` feedback uses `err.issues` PATHS only (never values — same paths-only rule as mitigation 26/61). Handler-throw feedback routes through `sanitizeProviderError` (mitigation 28's whitelist — status-code-based, never echoes the error body). Test: a tool error whose underlying message contains `sk-secret`/`https://attacker` → the fed-back `{role:'tool'}` content contains NEITHER (assert absence), only the path/sanitized form.
66. **Fatal error fed back as recoverable → privilege-confusion / wasted loop.** A scope-denied or unknown-tool error fed back would teach the model nothing actionable and waste rounds; worse, feeding "you lack scope X" could guide a prompt-injected model to probe scopes. → **Mitigation 66:** scope-denied (`forbidden: scope`) + unknown-tool (`method not found`) are FATAL — `failRun(provider_error) + return`, never fed back (decision 1). Test: a scope-denied tool call terminates the run (does NOT feed back, does NOT loop).

### How to use
- Controller pre-flight: verify 64–66 in the task code before dispatch.
- `/code-review` (D-9 close): verify against 64–66 + inherited 26/28/30.
- `/evaluate`: unimplemented 64–66 = plan-correction defect.

---

## File structure

| File | Change | Task |
|---|---|---|
| `apps/server/src/lib/agent-run-schema.ts` | Add `'tool_error'` to `runErrorReasonSchema` | D-9.1 |
| `apps/server/src/lib/runner.ts` | Rework the tool-execution block: recoverable→feed-back, fatal→terminate; add consecutive-error counter | D-9.2 |
| `apps/server/src/lib/runner.test.ts` | Replace the 3 terminal-on-tool-error tests; add feedback + sub-cap + sanitization tests | D-9.2 |

---

## Tasks

### Task D-9.1: add `tool_error` to the error-reason enum

**Files:** Modify `apps/server/src/lib/agent-run-schema.ts` + its test.

- [ ] **Step 1: failing test.** In `agent-run-schema`'s test, assert `runErrorReasonSchema.parse('tool_error')` succeeds. Run → FAIL (not in enum).
- [ ] **Step 2: add the value.** Add `'tool_error'` to the `z.enum([...])` (after `'provider_error'`, grouped with the tool/provider family). Update any exhaustive switch/JSDoc that lists reasons.
- [ ] **Step 3: run → PASS.** Confirm no other test breaks (the enum is closed — adding a value is backward-compatible; check `checkProviderHealth`'s provider-relevant filter does NOT treat `tool_error` as a provider signal — it should be EXCLUDED like the other local-guard reasons, same as `budget_exceeded`/`chain_guard`. Verify the SQL filter in `checkProviderHealth` only counts `provider_error`; `tool_error` is correctly ignored. If the filter is allow-list-based (`= 'provider_error'`), no change needed; confirm with a test that a `tool_error` failure does NOT degrade provider health).
- [ ] **Step 4: commit.** `phase-3: add tool_error to runErrorReasonSchema (D-9.1; mitigation 64)`.

### Task D-9.2: rework the runner tool-execution block for feedback

**Files:** Modify `apps/server/src/lib/runner.ts` (the tool-execution block ~lines 615-648 + add the counter to `runLoop`). Modify `apps/server/src/lib/runner.test.ts`.

- [ ] **Step 1: write the failing feedback tests (TDD).** In `runner.test.ts`:
  - **Recoverable invalid-args feeds back:** a tool that rejects args on round 1 then (the test's fake provider) the model corrects on round 2 and completes → run ends `completed`, NOT `failed`; assert the round-2 provider call received a `{role:'tool'}` message whose content names the invalid PATH but NOT the bad value (mitigation 65).
  - **Recoverable handler-throw feeds back:** a tool throws `DOCUMENT_NOT_FOUND` round 1, model adapts round 2 → `completed`; fed-back content is sanitized.
  - **Consecutive-error sub-cap (mitigation 64):** a tool that ALWAYS throws recoverably → run terminates `tool_error` after exactly `MAX_CONSECUTIVE_TOOL_ERRORS` (3) rounds, NOT 25; assert round count + `error_reason='tool_error'`.
  - **Counter resets on progress:** error round 1, SUCCESS round 2, error rounds 3-4-5 → terminates `tool_error` at round 5 (3 consecutive AFTER the reset), not round 4.
  - **Fatal scope-denied terminates (mitigation 66):** a tool call that hits `forbidden: scope` → run `failed` `provider_error`, NO feed-back, NO extra round (assert the provider was NOT called again).
  - **Sanitization (mitigation 65):** a recoverable handler throw whose error contains `sk-secret-leak` + `https://attacker` → the fed-back `{role:'tool'}` content contains NEITHER.
  - **Mixed batch with one fatal:** round has 2 tool_calls, one recoverable error + one scope-denied → whole round terminates `provider_error` (decision 5), no feed-back.
  Run → these FAIL against the current terminal-on-tool-error code.

- [ ] **Step 2: replace the 3 locked-spec tests.** The existing tests at runner.test.ts (`mcp_invalid_args — bad args fail`, `mcp_tool_error — tool throws`, `FIX #7 — multi-tool round where the 2nd call throws fails cleanly`) assert terminal behavior that D-9 INTENTIONALLY changes. Rewrite them: invalid-args + handler-throw now feed back (so a single-round-then-give-up scenario needs the sub-cap to terminate, OR the test's fake provider completes after the error); the FIX #7 multi-tool test keeps its terminal assertion ONLY for the fatal-in-batch case (decision 5) — split it into "all-recoverable batch feeds back" vs "fatal-in-batch terminates." Update the explicit "locked spec" comment to describe the new feedback behavior + cite mitigations 64-66.

- [ ] **Step 3: implement the loop change.** In `runLoop`:
  - Add a counter before the while-loop: `let consecutiveToolErrorRounds = 0;`
  - In the tool-execution `for` loop, classify each caught error:
    - `isInvalidArgs(err)` → recoverable; push `{role:'tool', tool_use_id: tc.id, content: <paths-only message>}` (decision 4), mark `roundHadError = true`.
    - FATAL (`err.message.startsWith('forbidden: scope')` OR `err.message.startsWith('method not found')`) → `failRun(provider_error, sanitizeProviderError(err, providerLabel)) + return` (decision 1/5).
    - else (handler throw) → recoverable; push `{role:'tool', ..., content: <sanitized message>}`, mark `roundHadError = true`.
    - success → push result string, mark `roundHadSuccess = true`.
  - After the batch: commit `assistantMsg` + all tool-result messages (success + recoverable-error). Then:
    - if `roundHadSuccess` → `consecutiveToolErrorRounds = 0`.
    - else (zero successes, all recoverable errors) → `consecutiveToolErrorRounds++`; if `>= MAX_CONSECUTIVE_TOOL_ERRORS` → `failRun(tool_error, "model failed to recover after N consecutive tool errors") + return`.
  - `continue` to next round.
  - Add `const MAX_CONSECUTIVE_TOOL_ERRORS = 3;` near `MAX_TOOL_ROUNDS`.
  - Keep the existing budget check (per token event) + cancel check + round cap UNCHANGED — they remain the outer bounds.
  - **Sanitization:** the recoverable-handler-throw message MUST route through `sanitizeProviderError` (mitigation 65). The invalid-args message uses `err.issues` paths only.

- [ ] **Step 4: run all tests → PASS.** The new feedback tests + the rewritten locked-spec tests + the full runner suite. Verify the budget/cancel/round-cap tests still pass (the change is additive to the tool-error branch; those paths are untouched).

- [ ] **Step 5: commit.** `phase-3: runner feeds recoverable tool errors back to the model (D-9.2; mitigations 64-66)`.

### Task D-9.3: integration + review

- [ ] Full `apps/server` suite green; tsc clean.
- [ ] `Skill("netdust-core:integration")`.
- [ ] `/code-review --base=<D-8 close, 9748a64> --effort=medium` — reviewer prompt names mitigations 64-66 + inherited 26/28/30. Verify: no value-leak in fed-back messages; the sub-cap terminates before the round cap; fatal errors still terminate; `tool_error` doesn't degrade provider health.
- [ ] `Skill("netdust-core:evaluate")` — D-9 retro.

---

## Self-review

- **Spec coverage:** C.2-R-2 (feed tool errors back) → D-9.2 ✓. Infinite-retry guard → the `MAX_CONSECUTIVE_TOOL_ERRORS` sub-cap (decision 2 / mitigation 64) ✓. Threat-model touch → mitigations 64-66 ✓. Own review loop → D-9.3 ✓.
- **Bound:** feedback is triple-bounded (consecutive-error sub-cap 3 < round cap 25 < token budget) ✓.
- **Sanitization:** fed-back messages are paths-only (invalid-args) or sanitized (handler-throw) — never raw values ✓ (mitigation 65).
- **Distinguishability:** `tool_error` (model couldn't recover) vs `provider_error` (hard/fatal) — operator-triageable ✓.
- **Locked-spec tests:** the 3 terminal-on-tool-error tests are explicitly replaced (Step 2), not left to silently flip ✓.
- **Provider-health interaction:** `tool_error` must be EXCLUDED from the provider-health window (it's a model failure, not a provider failure) — verified/tested in D-9.1 Step 3 ✓.
- **Placeholder scan:** every step has concrete code direction + the exact file:line context from ground-truth ✓.

## Open question for approval
- **`MAX_CONSECUTIVE_TOOL_ERRORS = 3`** — reasonable default? (3 gives the model a couple of self-correction attempts without burning the budget. Could be env-configurable `FOLIO_MAX_CONSECUTIVE_TOOL_ERRORS` if you want it tunable per-deploy — say the word and I'll add it as an env var with default 3.)
- **Decision 1 split** (handler-throws are RECOVERABLE) — confirm. The alternative (only invalid-args recoverable, handler-throws fatal) is more conservative but less useful (a "doc not found" is exactly what the model should adapt to).
