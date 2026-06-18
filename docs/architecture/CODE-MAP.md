# CODE-MAP

> **Scope.** This map tracks **what specs have touched**, growing incrementally — it is **NOT** a whole-codebase map. Each entry was written at a spec's close (via `netdust-agent:compounding`) so a future session reads the structure here instead of re-deriving it. Convergence-point entries cross-ref `ARCHITECTURE-INVARIANTS.md` by number. If an entry describes a surface that has since moved or been deleted, flag it `!` and fix at the next compound pass.

---

## The agent / operator execution path

The runner executes agent + operator runs. There are two execution shapes, chosen in `runAgent`/`runAgentResume` by `ctx.runSink.isConversation`:

- **API-provider path** (`anthropic`/`openai`/`openrouter`/`ollama`) → `runLoop`, driving `provider.stream(messages, tools)` and executing tool calls itself. Message source branches: conversation → `buildConversationMessages`; document → `buildInitialMessages` (`runner.ts` ~355).
- **`claude-code` path** → `ccExecute` (a **separate branch**; cc is deliberately ABSENT from the provider `REGISTRY`). The host `claude -p` runs its own agent loop and re-enters Folio over MCP.

### `apps/server/src/lib/cc-executor.ts` — the claude-code subprocess executor
Spawns the host `claude` CLI in print mode via `Bun.spawn` (array argv = **no shell**, so document content folded into the prompt is an inert argument, not injectable). Builds argv:
`claude -p <prompt> [--model <M>] [--mcp-config <folio MCP json> --strict-mcp-config --allowedTools mcp__folio]`.
- **`--allowedTools mcp__folio`** is the headless tool-permission grant. Pushed ONLY when `mcpToken`+`mcpUrl` are present (i.e. the Folio MCP server is wired). Scoped to the Folio MCP server only — **no host tools** (S-2 containment; chosen over `--dangerously-skip-permissions`). Without it, headless `claude` runs in default permission mode and silently denies every MCP tool call.
- `--model` is **omitted** when the model is empty or the literal `'default'` sentinel (lets the local Claude Code pick its own model).
- Returns the full transcript (no token streaming). Spawning is an injected `SpawnFn` → unit-testable without launching a process.

### Convergence point: `ccGateBlocks(ctx)` (`apps/server/src/lib/runner.ts`) — ARCHITECTURE-INVARIANTS #20
The ONE place "is a `claude-code` run allowed?" is decided. Allowed iff `env.FOLIO_CLAUDE_CODE_ENABLED === true` **AND** attended (`ctx.conversationId != null && ctx.unattended !== true`). Wired into BOTH preflights:
- `preflight()` (document/trigger path) → always hard-deny (such runs are never attended → S-1 unreachable by construction).
- `conversationPreflight()` (operator/cockpit path) → the attended-allow branch, plus a keyless exemption (cc has no `ai_keys` row, so the `keyRowMissing`/`requiresKey` blocks are skipped for cc).

A future cc entry point MUST route through `ccGateBlocks`, not re-check `FOLIO_CLAUDE_CODE_ENABLED` inline.

### `ccExecute(ctx)` (`apps/server/src/lib/runner.ts` ~1885) — the cc execution branch
- **Task source branches on `ctx.runSink.isConversation`:** conversation → `rowsToMessages(getThread(db, conversationId))` (the user's cockpit turn) with the same `CONVERSATION_HISTORY_WINDOW` tail-slice; document → `buildUntrustedContext` (parent body + comments). Both land inside the untrusted `===== BEGIN CONTEXT =====` envelope of the single `-p` string. Mirrors the API path's `isConversation` branch.
  - **Deliberately NOT `buildConversationMessages`** — that prepends a skills preamble, and cc already folds skills separately (trusted → `ccSystemPrompt`; unblessed → the untrusted envelope), so using it would double-inject skills. Cross-ref invariant **14** (skill rendering) + **11** (skill trust).
- **Completion routes through `ctx.runSink.complete()`** (conversation → no-op, the `active_run_id` slot is the liveness record; document → the real `transitionRun`). A direct `transitionRun(ctx.run.id, …)` here throws `AGENT_RUN_NOT_FOUND` on a conversation run (no `agent_run` row) — this was bug **F1**. Cross-ref invariant **19** (single failure/terminal surface).
- **Per-run MCP token:** minted as the FIRST statement INSIDE the `try` (so `finally` always revokes it), carries a short `expiresAt` TTL (defense-in-depth even if `finally` is skipped), copies the run's already-narrowed `ctx.token` scopes/agentId/projectIds. The subprocess re-enters over `/mcp` with this token → `requireResource` + `executeTool` re-apply the scope ceiling. Cross-ref invariants **2/3** (scope + project ceiling) and the **invariant 12 Deliberate exception** (headless MCP `tools/call` carries no `conversationId`, so it skips the irreversible-op confirm gate — the cc re-entry inherits this pre-existing accepted gap).

---

## Operator-model provider set (the keyed/keyless boundary)

- **`AI_PROVIDERS`** (`packages/shared/src/ai-providers.ts`) = the 4 **keyed** providers (`anthropic`, `openai`, `openrouter`, `ollama`). Drives key-CRUD + key-resolution. Must NOT be widened to include `claude-code`.
- **`OPERATOR_MODEL_PROVIDERS`** (`packages/shared/src/operator-model-schema.ts`) = `[...AI_PROVIDERS, 'claude-code']` — intentionally wider, feeds the operator-model setting schema ONLY. `claude-code` is a config-only value, deliberately NOT an `ai_keys` entity (cross-ref invariant **10**).
- **cc is keyless:** no `ai_keys` row; the PUT `/operator-model` referential key-existence check (`apps/server/src/routes/instance-ai-keys.ts`) exempts `provider === 'claude-code'` (a keyed provider with no row still 422s — the exemption is cc-only).
- `env.FOLIO_CLAUDE_CODE_ENABLED` (`apps/server/src/lib/env.ts`) — strict `z.enum(['true','false']).transform`, default false. The runtime opt-in `ccGateBlocks` checks.

---

## Web — Settings → AI operator selector

- `apps/web/src/components/settings/ai-tab.tsx` hosts the operator-model selection. Per-keyed-provider rows carry a "Use for operator" button; **`claude-code` is a synthesized keyless "Claude Code (local)" section** (always rendered — the show+fail-loud design; selecting it when the env flag is off fails at run time with a flag-naming message). Distinct `aria-label` to disambiguate from the per-key buttons.
- **Separate surface — do not confuse:** `apps/web/src/components/inline/provider-model-field.tsx` is the **per-agent** provider picker, gated on a *workspace* `claude_code_enabled` flag. That is the agent-frontmatter picker, NOT the instance operator selector above.
