# Provider→runner streaming-seam hardening (G1–G6)

Branch: `fix/provider-seam-hardening`. Class C (bug-fix bundle from the gap-hunt over the
provider→runner streaming boundary). Surface: `apps/server/src/lib/ai/{anthropic,openai,
ollama,openrouter}.ts`, `provider.ts`, runner.ts (~1250–1620). Sibling to the Phase 3
provider threat model (`2026-05-27-phase-3-agent-runner.md ## Threat model`, mitigations
1-22) — this extends it to the STREAM-CONSUMPTION conformance + denial-of-wallet surface.
Mitigation numbers are G-prefixed.

## Threat model

> The provider stream is UNTRUSTED INPUT from a third-party endpoint (the model, or an
> OpenAI-compatible proxy / OpenRouter route the operator pointed at). The adapters parse
> it into ProviderEvents the runner trusts for completion, budgeting, and tool dispatch.
> The gap-hunt found the parsers trust the stream's well-formedness and its usage reporting.
> This section is the convergence target for the G1-G6 fixes + /code-review.

### What we're defending

- **G-A1 — run-completion integrity**: a run marked `completed` must reflect a generation
  that actually finished. A truncated stream completing as success silently ships partial work.
- **G-A2 — the token BUDGET (denial-of-wallet)**: `fm.max_tokens` is the per-run spend cap.
  If the meter under-counts, a runaway loop burns real BYOK quota / money uncapped. Ties to
  the Phase 3 M8 denial-of-wallet residual (per-key caps not built; the run-budget IS the cap).
- **G-A3 — stream-parse availability**: a malformed chunk must not crash the generator and
  abort an otherwise-recoverable run; degradation must match across adapters.
- **G-A4 — tool-call correlation integrity**: a tool_call's id must be present + unique so the
  assistant-echo round-trip and parallel-call result-matching don't collide or get rejected.

### Who we're defending against

- **A malicious / buggy MODEL or PROXY** (IN scope): the upstream the operator configured —
  a non-conformant OpenAI-compatible route (vLLM, LM Studio, llama.cpp, an OpenRouter route)
  that omits usage, omits tool-call ids, sends malformed tool_calls, or drops the connection
  mid-stream. NOT assumed hostile-with-intent, but assumed NON-CONFORMANT.
- **A network path that truncates** (IN scope): a reverse proxy / flaky link that drops the
  stream before the terminal chunk.
- **The operator who misconfigures max_tokens / a route** (IN scope, partial): a tiny cap or
  a token-param-incompatible route. We bound the blast radius, not the misconfig itself.
- **An attacker without a configured provider** (OUT of scope): no provider, no stream — the
  BYOK + key gates (Phase 3 M1-M5) already cover key access.

### Attacks to defend against

1. **G1 — truncated-stream fake-success.** The stream ends WITHOUT a terminal/done chunk
   (proxy drop, truncated NDJSON), but the adapter's `stopReason` defaults to `'stop'` and it
   ALWAYS yields a `done` event → the runner's FIX#2 (fails only on `doneReason===undefined`)
   never fires → a truncated generation is recorded `completed`. Defeats G-A1.
2. **G2 — budget meter reads {0,0} on absent usage → cap disabled.** When the provider omits
   usage (OpenAI/OpenRouter without honored `stream_options.include_usage`), the adapter emits
   `tokens:{0,0}`; the runner increments by 0 so `used > max_tokens` never trips → a runaway
   tool loop burns quota uncapped. Defeats G-A2 (denial-of-wallet LIVE).
3. **G3 — empty tool-call id → echo collision / upstream 400.** OpenAI sets `entry.id` only
   `if (tc.id)`; a route that omits ids flushes `id:''`; the runner echoes `tool_calls[].id:''`
   + `tool_use_id:''` → on parallel calls they collide (wrong result→call mapping) or the
   upstream 400s on an empty correlation id. Defeats G-A4.
4. **G4 — malformed tool_call crashes the Ollama generator.** `tc.function.name` is deref'd
   unguarded; a chunk with a `tool_calls[]` entry lacking `function` (real across OpenAI-tool-
   emulating servers) throws a TypeError mid-stream → the generator dies before yielding
   tokens/done → hard provider_error, no graceful degradation (anthropic/openai degrade). G-A3.
5. **G5 — Anthropic silently drops non-`tool_use` tool blocks.** `server_tool_use`/`mcp_tool_use`
   blocks aren't registered (only `content_block.type==='tool_use'` is) → zero tool_call events
   with `stop_reason:'tool_use'` → runner FIX#3 fails with a MISLEADING generic message. G-A3.
6. **G6 — OpenRouter inherits `max_tokens` (vs `max_completion_tokens`).** o1/o3-class routes
   may ignore/reject the param → cap not enforced upstream; compounds G2. Defeats G-A2 (partial).

### Mitigations required

1. **G1 → a real-terminal sentinel.** Each adapter tracks whether a genuine terminal chunk was
   seen (`sawDone`/`sawTerminal`). If the stream ends WITHOUT it, do NOT emit a clean
   `done:'stop'` — yield no `done` (so the runner's FIX#2 `doneReason===undefined` fires) OR a
   dedicated failure signal. ONE convention across all four adapters. Code-checkable: a stream
   with no terminal chunk → run `failed` (provider_error), not `completed`.
2. **G2 → distinguish "0 tokens" from "usage absent".** Track whether ANY usage chunk was seen.
   If none by stream end, the run is UNMETERED — log loudly (tie to M8) AND bound it: either
   estimate from accumulated char length, or hard-cap the round count so an unmetered loop can't
   run away. Code-checkable: a multi-round stub that never emits usage is still bounded
   (`budget_exceeded` or a round cap fires), not infinite.
3. **G3 → synthesize a stable unique id at flush.** If `entry.id` is empty when flushing a
   tool_call, mint `call_${index}` or `crypto.randomUUID()` (as Ollama already does). Two id-less
   parallel calls get DISTINCT ids. Code-checkable: an id-less tool_call delta → flushed event
   has a non-empty id; two id-less calls → two distinct ids.
4. **G4 → guard the tool_call shape.** `tc.function?.name` with a skip+`console.warn` on a
   malformed entry, matching anthropic/openai's degrade-don't-crash. Code-checkable: a
   `tool_calls:[{id,type}]` (no `function`) chunk → warns + still yields tokens/done (no throw).
5. **G5 → defined outcome for unhandled tool blocks.** Either handle `server_tool_use` block
   types, OR detect "stop_reason tool_use but a non-tool_use tool block was present" and surface
   a SPECIFIC error (not FIX#3's generic "no usable tool call"). Index-keying is already sound;
   only the type filter is the gap. Code-checkable: a server_tool_use + stop_reason tool_use →
   a defined, non-misleading outcome (specific error or handled).
6. **G6 → name the constraint.** Document that streamOpenAICompatible sends `max_tokens`; for
   routes requiring `max_completion_tokens`, the cap relies on the G2 round/budget backstop.
   LOW — fix-by-documentation + the G2 backstop, not a per-route param map (deferred).

### Out of scope (explicit deferrals)

- **Per-route token-param mapping** (`max_tokens` vs `max_completion_tokens` per OpenRouter
  upstream): deferred — the G2 unmetered-bound backstop covers the blast radius; a full param
  map is a maintenance burden for a moving target.
- **Char-length token ESTIMATION accuracy** (if G2 uses estimation): a rough bound, not exact
  accounting — acceptable; the goal is "not infinite", not "byte-accurate billing".
- **Handling every Anthropic server-tool block TYPE** (web_search/computer-use execution): G5
  mitigates the MISLEADING-error symptom; full server-tool support is its own feature, deferred.
- **Hostile-intent model output** (prompt-injection via tool args): covered by the existing
  trusted/untrusted envelope (Phase 3 B10a) + executeTool scope gate — not re-litigated here.
- **DNS-rebinding / SSRF on baseUrl**: covered by Phase 3 M1-M4/M12 (validatePublicUrl). Not
  re-touched by this seam work.

### How to use this section

- The fix is 6 TDD cycles (G1-G6), each RED-on-revert proven. G1/G2 are cross-adapter (fix the
  class once across all four where it applies), not per-adapter patches.
- `/code-review` verifies the diff against G1-G6 + confirms the deferrals weren't silently changed.
- `/evaluate` lists any unimplemented Gn as plan-correction defects.
- Downstream: this is the streaming-conformance baseline; a new adapter must satisfy G1-G5.
