# Design — Re-enable the local Claude Code provider (attended-only)

**Date:** 2026-06-18
**Status:** Design — awaiting user review before plan
**Class:** A (feature) — touches the AI-provider boundary, subprocess execution, and a security gate. The threat-modeling gate (1a) fires; threat model embedded inline below.

---

## The ask, in the user's words

> "the cockpit now uses the default model provider. we stopped trying to get claude agents or claude -p to work. i still can't believe this is hard to do. when folio is installed on a machine where claude agents or claude -p is installed, it should easly use this — this way, when installed locally, folio can use subscription and be super powerful."

## What "we stopped trying" actually was

The `claude-code` provider **already exists and works** — `apps/server/src/lib/cc-executor.ts` spawns `claude -p` and captures the transcript; `ccExecute` in `runner.ts` wires it into the run lifecycle (per-run scoped MCP token, untrusted-context fencing, skills-into-system-prompt). It was not abandoned because it failed to integrate. It was **deliberately hard-disabled** at the runner preflight (`runner.ts:882`) during the Phase C shake-out, for two named security gaps:

- **S-1 — unattended-floor bypass.** When a *trigger* fires a run unattended, the API path enforces a "refuse HIGH-risk config writes unattended" floor (C3). The `claude` subprocess re-enters Folio over MCP and runs its own agent loop; that re-entry does not carry the unattended floor, so an unattended cc run could perform config writes the floor would block.
- **S-2 — host power.** The subprocess can do anything the OS user can (SSH, `wp`, filesystem) — "governed by the machine, outside Folio's envelope" (`cc-executor.ts:9-10`).

The disable is blanket: `if (ctx.fm.provider === 'claude-code') failRun(...)`, which makes `ccExecute` unreachable "by construction."

## The reframe (why this is now small, not hard)

The user's deployment answer collapses the risk:

- **Runs on their own machine, their own Claude seat, attended use** (driving the cockpit), **not** a per-customer SaaS deploy, **not** unattended triggers.

Under that condition:
- **S-1 does not arise.** S-1 is *specifically* about unattended runs. If cc is allowed *only* on attended operator/cockpit runs and *never* on triggers, there is no unattended cc run for the floor to be bypassed on. This is the **same "unreachable by construction" argument the disable comment already makes — narrowed to an allow instead of a blanket deny.**
- **S-2 is acceptable-by-design.** "The subprocess has full host power" is the *entire value proposition* the user is asking for ("be super powerful locally"). On the operator's own box, doing the operator's own work, host power is the feature, not the threat. It is bounded to single-operator local installs by an explicit env opt-in.

We also will **not** reuse the local Claude *subscription OAuth token* against `/v1/messages` directly (the "clean code" path): Anthropic's consumer terms forbid using Free/Pro/Max OAuth tokens in any third-party product (including via the Agent SDK), and they fingerprint + ban for it ([support.claude.com](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)). The *sanctioned* way to use a subscription locally is exactly the subprocess path: the user's own `claude` CLI, authenticated as themselves, for their own individual use — which is what `cc-executor.ts` already does.

## Decisions locked with the user

1. **Direction:** subprocess to the local Claude Code (`claude -p`) — re-enable the existing `cc-executor`/`ccExecute`, don't rebuild.
2. **Guardrail shape:** attended-only **and** env opt-in. Allow cc **only** when the run is an attended operator/cockpit run **and** `FOLIO_CLAUDE_CODE_ENABLED=true`. Triggers (unattended) stay refused.
3. **Execution model:** transcript (run to completion, capture transcript, post result). No live token streaming — matches what every Folio provider does at the cockpit today and what `cc-executor` already produces.
4. **Deployment:** the operator's own local machine, single seat, attended.

---

## Architecture

### The gate (the heart of the change)

Today (`runner.ts:882`):
```
if (ctx.fm.provider === 'claude-code') { failRun(claude_code_disabled); return true; }
```

New condition — refuse cc **unless** it's an attended operator run on an opt-in install:
```
if (ctx.fm.provider === 'claude-code') {
  const attended = ctx.conversationId != null && ctx.unattended !== true;
  if (!env.FOLIO_CLAUDE_CODE_ENABLED || !attended) {
    failRun(claude_code_disabled, <message naming which condition failed>);
    return true;
  }
  // else: fall through — ccExecute is reached only for attended + opt-in
}
```

Why this is sufficient (and why it's the convergence point):
- `ctx.unattended` is set `false` only on the operator/cockpit path (`runner.ts:799`, with the comment "A human is present in the cockpit — never the unattended floor"); triggers set `fm.unattended === true` → `ctx.unattended === true`.
- `ctx.conversationId` is present **only** on operator/cockpit runs (`runner.ts:800`); document runs and trigger runs have none.
- Both must hold. A trigger run (unattended, no conversationId) fails both halves and is refused — S-1 stays unreachable.
- This single preflight branch is the **one place** the cc-attended decision is made. No other code path reaches `ccExecute` (the preflight fires before both `runAgent` and `runAgentResume` branch to it — `runner.ts:348/460`).

### Letting the cockpit operator select claude-code

The cockpit operator's provider/model comes from the instance "operator model" setting (`operatorModelSettingSchema`, `runner.ts:709` → `resolveOperatorRunModel`). That schema currently uses `z.enum(AI_PROVIDERS)` — the **4 keyed providers only** (`packages/shared/src/operator-model-schema.ts:14`; `AI_PROVIDERS` excludes `claude-code`). So today the operator literally cannot be set to claude-code.

Change: widen the operator-model setting's provider enum to include `claude-code` (it already lives in the server `providerSchema`). `resolveOperatorRunModel` passes `provider` straight through (`runner.ts:1213`) — no logic change there. The key resolution at `runner.ts:755` then resolves a (claude-code, label) row; cc is keyless, so that needs the same keyless tolerance Ollama has (a key row with empty ciphertext, or no row → empty key, which is fine because cc ignores `apiKey`).

### Keyless config (mirror Ollama)

cc needs no API key (it uses the user's own `claude` login on the host). Mirror the keyless path Ollama already uses:
- `ai_keys` provider enum currently is `['anthropic','openai','openrouter','ollama']` (schema.ts) — cc is **not** stored there and **should not need to be**. cc carries no secret. Decision: cc requires **no `ai_keys` row** — the operator-model setting names `provider: 'claude-code'` and the keyless preflight tolerates a missing row (cc ignores `apiKey`/`baseUrl`).
- The conversation preflight's `keyRowMissing` "block loudly" rule (`runner.ts:769`, 901-ish) must **exempt claude-code** the way it conceptually exempts keyless — a missing key row is not an error for cc.

### What does NOT change

- `runLoop`, `consumeStream`, tool execution, the provider `REGISTRY`, SSE/cockpit wiring, message format, tool definitions. cc takes the separate `ccExecute` branch (it is intentionally absent from `REGISTRY`); none of the streaming-provider machinery is touched.
- `cc-executor.ts` itself — the spawn, the `-p` prompt assembly, the MCP-config wiring, the transcript capture — is reused as-is.

---

## Threat model (gate 1a)

**Assets:** the operator's host machine (full power via the subprocess); Folio's data plane (reachable by cc over MCP with the run's scoped token); the per-run scoped MCP token; the C3 unattended floor.

**Trust boundary:** the `claude` subprocess is **trusted-ish** — it runs as the operator, on the operator's box, on the operator's own seat. But its *inputs* (document bodies, comment threads folded into the `-p` prompt) are **untrusted** and already fenced by `ccExecute` in a BEGIN/END DATA envelope (`runner.ts:1876-1879`).

| # | Attack | Mitigation |
|---|---|---|
| T1 | An **unattended trigger** fires a cc run → bypasses the C3 unattended floor (S-1). | The gate requires `conversationId != null && unattended !== true`. A trigger run has neither → refused at preflight. S-1 unreachable by construction. |
| T2 | A cc run on a **per-customer SaaS deploy** routes a customer's work through the operator's seat (ToS violation + host-power exposure). | `FOLIO_CLAUDE_CODE_ENABLED` defaults **off**. The feature is an explicit single-operator-local-install opt-in; the per-customer image never sets it. Documented as such in INSTALL/env docs. |
| T3 | **Prompt injection** in a document body / comment tricks cc into a destructive host action (S-2 amplified). | (a) Untrusted context stays in the existing fenced DATA envelope (`ccExecute`). (b) cc's *Folio* powers are bounded by the per-run scoped MCP token (mirrors the agent's scopes — `ccExecute` mint at `runner.ts:1835`). (c) cc's *host* powers are inherently the operator's own — accepted by design for a local single-operator install, and the operator is attended (a human is driving the cockpit and sees the run). This is a **documented residual**, not eliminated — host power is the feature. |
| T4 | The per-run MCP token **leaks** (it's passed via `--mcp-config` argv + `FOLIO_MCP_TOKEN` env to the child). | Unchanged from existing `ccExecute`: short-lived, scoped to the run's exact scopes/agent/projects, revoked unconditionally in `finally`. Argv/env exposure is to the operator's own child process on the operator's own box. |
| T5 | cc re-enters Folio over MCP with **broader authority than the caller** (S-2: agent∩caller ceiling). | The minted `ccToken` copies `ctx.token.scopes/agentId/projectIds` (`runner.ts:1842-1844`) — the run's already-narrowed scopes. The MCP server re-applies `executeTool`'s double-membership check on every call. Attended operator runs are caller-bounded the same as the API path. |

**Explicit deferrals / residuals:**
- **Host power (S-2/T3) is a documented accepted residual**, bounded by the env opt-in + attended + single-operator-local-install posture. Not eliminated; it is the feature.
- **No mid-run cancellation** of the subprocess (existing `ccExecute` known gap, `runner.ts:1826`) — a reject during a cc run isn't observed. Out of scope for this change; carry forward.
- **Per-customer deploys are out of scope** — cc must never be enabled there; enforced by env-default-off + docs, not by code that detects deploy type (there is no such signal).

---

## Acceptance flows (gate 1g)

| Flow | Happy path | Edges (empty / denied / wrong-order / concurrent / boundary / mid-flow-fail) |
|---|---|---|
| **Operator runs on claude-code (attended)** | Set operator model to claude-code in Settings → AI; open cockpit; send a task; `claude -p` runs; transcript captured; result posted to the conversation. | **denied:** `FOLIO_CLAUDE_CODE_ENABLED` off → run fails `claude_code_disabled` with a message saying the flag is off. **mid-flow-fail:** `claude` binary missing / non-zero exit → run fails `provider_error` with the stderr tail (existing `cc-executor` behavior). **boundary:** empty task (identity-only run) → cc gets system prompt, no context envelope. |
| **Trigger tries to fire a claude-code agent (unattended)** | n/a — must be refused. | **denied (the load-bearing case):** unattended trigger run with `provider: 'claude-code'` → fails `claude_code_disabled` at preflight (fails the `attended` half even if the env flag is on). This is the S-1 guard; it gets a dedicated RED test. |
| **Set operator model to claude-code** | Settings → AI offers Claude Code (when enabled); PUT /operator-model accepts `provider: 'claude-code'`; no key row required. | **denied:** selecting claude-code while the env flag is off — decide: hide the option, or accept the setting but fail at run time with a clear message. (Recommendation: accept the setting, fail loudly at run time, so the message teaches the operator to set the flag — mirrors how the web field already gates on `claude_code_enabled`.) **empty:** no `ai_keys` row for claude-code → not an error (keyless exemption). |

UI flows verified through the real browser at shake-out (cockpit + Settings → AI); the trigger-denial + preflight-gate flows verified through the un-mocked runner.

---

## Review-group plan (1f / 1h)

Small, security-touching change → one tight cluster, **FULL tier** (it touches the AI-provider boundary + a security gate + subprocess execution — all 1a trigger surfaces).

- **Cluster 1 (one `── REVIEW GATE ──`, FULL):**
  1. Widen `operatorModelSettingSchema` provider enum to include `claude-code` (+ shared type). *Tier A test:* schema accepts claude-code, still rejects garbage.
  2. Re-write the runner preflight gate: refuse cc unless attended-operator + env opt-in; exempt cc from the keyless `keyRowMissing` block. *Tier A test (RED-first):* (i) attended + flag-on → reaches `ccExecute` (spawn injected); (ii) flag-off → `claude_code_disabled`; (iii) **unattended/trigger + flag-on → `claude_code_disabled`** (the S-1 guard); (iv) attended + flag-on + no key row → not blocked by `keyRowMissing`.
  3. Web `ProviderModelField` / Settings → AI: surface claude-code for the operator-model selector when enabled (the field already has the `claude_code_enabled` plumbing — extend it to the operator selector). *Tier B (UI)* + the existing field test extended.

`/security-review` is mandatory at the gate (a `## Threat model` exists). Shake-out drives the acceptance matrix (browser for cockpit/Settings, un-mocked runner for the trigger-denial guard).

---

## Open questions for the user

1. **Operator-model UI when the flag is off:** hide the Claude Code option entirely, or show it and fail-loud at run time with a "set FOLIO_CLAUDE_CODE_ENABLED" message? (Recommendation: show + fail-loud — the message is the affordance, and it matches the existing field's gate-on-flag pattern.)
2. **Default model string for cc:** `claude -p` defaults to the user's configured Claude Code model when `--model` is omitted. Folio's operator-model setting wants a `model` string. Use a sentinel like `default` (→ omit `--model`, let the CLI choose) or require the operator to type a model id? (Recommendation: allow empty/`default` → omit `--model`; `cc-executor` already omits it when `model` is empty — `cc-executor.ts:69`.)
