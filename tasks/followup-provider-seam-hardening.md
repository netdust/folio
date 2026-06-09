# Follow-up: provider→runner streaming-seam hardening (G1–G6)

**Filed:** 2026-06-08, from a gap-hunt over the AI provider→runner streaming boundary
(the seam that produced bugs in three consecutive review rounds on
`fix/thinking-model-tool-calls`). These are **pre-existing** latent bugs — they predate
that branch. The branch's own regressions (refusal/pause_turn executing tools;
silent max_tokens truncation) were already fixed there (commit `88fcc0d`).

**Why a dedicated branch:** this is provider-seam *hardening*, a different scope from
"thinking-model tool calls." Do it via `harnessed-development` (Class A/C) with its own
`## Threat model` (it touches untrusted provider streams + outbound BYOK) and per-fix TDD.
Each fix must be **proven RED-on-revert** (break the path → test fails) per the
test-effectiveness discipline.

Surface: `apps/server/src/lib/ai/{anthropic,openai,ollama,openrouter}.ts`,
`provider.ts`, and the consumer `runner.ts` (~1250–1590).

## Punch list (ranked by severity)

### G1 — [HIGH] Truncated stream reports fake `done:'stop'`, defeating runner FIX#2
- **Where:** `ollama.ts` (state.stopReason defaults `'stop'`, always yields `done`),
  `anthropic.ts:65,156` (same shape). `runner.ts` FIX#2 fails the run only when
  `doneReason === undefined`.
- **Bug:** if the upstream stream ends WITHOUT a chunk carrying the completion signal
  (proxy drops the connection, truncated NDJSON with a trailing newline so the flush
  sees an empty buffer), the adapter never reads the real done_reason but STILL emits
  `done:'stop'`. FIX#2 never fires → a truncated generation ships as a clean success.
- **Fix sketch:** track whether a real terminal chunk was seen (`sawDone`); if the
  stream ends without it, emit `done` with a sentinel the runner treats as failure
  (or yield no `done` so FIX#2 fires). Decide one convention across all adapters.
- **RED bar:** a stream that ends with no done-chunk → run fails (not completed).

### G2 — [HIGH] Budget meter reads {0,0} when provider omits usage → cap disabled
- **Where:** all adapters emit `tokens:{0,0}` when usage absent; `runner.ts:1261-1277`
  increments budget from it. OpenAI/OpenRouter only emit usage if the upstream honors
  `stream_options.include_usage` — many OpenRouter routes don't.
- **Bug:** a turn that burns real tokens but whose usage chunk is absent advances the
  budget by 0, so `usedIn+usedOut > fm.max_tokens` never trips → runaway loop, real
  quota/$ burned, `budget_exceeded` never fires.
- **Fix sketch:** distinguish "0 tokens" from "usage absent". Option: when no usage seen
  by stream end, estimate from char counts, or flag the run as unmetered + cap rounds
  harder. At minimum log loudly. Tie into the M8 denial-of-wallet residual already noted.
- **RED bar:** a multi-round stub that never emits usage → the budget guard still bounds it.

### G3 — [MED] OpenAI flushes a tool_call with empty `id` → echo correlation breaks
- **Where:** `openai.ts` keys by index, sets `entry.id` only `if (tc.id)`; flush skips
  empty-NAME but not empty-ID entries. Runner echoes `tool_calls[].id:''` +
  `tool_use_id:''`.
- **Bug:** providers that stream tool deltas without an `id` (some vLLM/OpenRouter
  open-weight routes) → empty/colliding ids → upstream 400 or mis-correlated results on
  parallel calls. Ollama (mints UUID) + Anthropic (provider id always present) are immune.
- **Fix sketch:** if `entry.id` is empty at flush, synthesize a stable unique id
  (e.g. `call_${index}` or crypto.randomUUID), same as Ollama.
- **RED bar:** a tool_call delta with no id → flushed event has a non-empty unique id;
  two id-less parallel calls get distinct ids.

### G4 — [MED] Ollama unguarded `tc.function.name` deref crashes the generator
- **Where:** `ollama.ts:43-51` — `for (const tc of msg.tool_calls)` reads
  `tc.function.name`/`.arguments` with no guard.
- **Bug:** a malformed `tool_calls[]` entry (no `function` key — real across
  OpenAI-tool-emulating servers like LM Studio/llama.cpp) throws a TypeError mid-stream;
  the generator dies before yielding tokens/done → hard provider_error. anthropic.ts +
  openai.ts both degrade malformed tool calls gracefully (try/catch, skip-and-warn).
- **Fix sketch:** guard `tc.function?.name`; skip + `console.warn` on a malformed entry,
  matching the other adapters' degradation.
- **RED bar:** a `tool_calls:[{id,type}]` chunk with no `function` → warns + still yields
  tokens/done (no throw).

### G5 — [MED] Anthropic silently drops `server_tool_use` / non-`tool_use` tool blocks
- **Where:** `anthropic.ts:85-91` registers into `toolCallsByIndex` ONLY when
  `content_block.type === 'tool_use'`. `server_tool_use` / `mcp_tool_use` blocks are
  ignored, their input_json_delta dropped, no tool_call emitted.
- **Bug:** with `stop_reason:'tool_use'` + a server-tool block, zero tool_call events →
  runner FIX#3 fails the run ("signalled tool_use but produced no usable tool call").
- **Fix sketch:** decide policy — either handle server_tool_use block types, or detect
  "stop_reason tool_use but an unhandled tool block was present" and surface a clearer
  error than FIX#3's generic one. (Index-keying itself is sound — keyed by absolute
  ev.index — so no mis-keying; only the type filter is the gap.)
- **RED bar:** a stream with a server_tool_use block + stop_reason tool_use → a defined,
  non-misleading outcome.

### G6 — [LOW] OpenRouter inherits OpenAI `max_tokens` (vs `max_completion_tokens`) assumption
- **Where:** `openrouter.ts` delegates to `streamOpenAICompatible`, which sends
  `max_tokens` (openai.ts). o1/o3-class routes via OpenRouter may ignore/reject it.
- **Fix sketch:** per-route token-param handling, or document the constraint. Low
  priority; compounds with G2 (uncapped + unmetered) on certain routes.

## Acceptance
Author a `## Threat model` for the seam first (untrusted provider stream parsing +
BYOK outbound). Each G-fix: one TDD cycle, RED-on-revert proven, then re-run the full
AI/runner/conversation suite. Cross-adapter conformance is the theme — fix a class once
across all four adapters where it applies (G1, G2 especially), not per-adapter.

## RESOLVED — 2026-06-09 (branch `fix/provider-seam-hardening`)

Threat model: `docs/superpowers/plans/2026-06-09-provider-seam-hardening.md`. All 6 fixed,
each RED-on-revert proven, full server suite 1722 pass.

- **G1** [HIGH] — `sawTerminal` across all 3 streaming adapters (ollama `done:true`;
  anthropic `message_stop`/stop_reason; openai `finish_reason`). Truncated stream → no done
  event → FIX#2 fails the run. (commit dc1c7ba)
- **G2** [re-scoped MEDIUM] — GROUND-TRUTH CORRECTION: the gap-hunt called it "runaway loop",
  but `MAX_TOOL_ROUNDS = 25` already BOUNDS the loop — it is NOT unbounded spend. The real
  residual is OBSERVABILITY: a run can complete UNMETERED (provider omits usage → budget meter
  reads 0 → cap never trips) with no operator signal. Fix = a loud runner warn at completion
  when `sawUsage` is false. Token ESTIMATION deferred (threat model deferral). (commit with G6)
- **G3** [MED] — synthesize `crypto.randomUUID()` for id-less OpenAI tool_calls. (commit e6a77e0)
- **G4** [MED] — guard the Ollama `tc.function` deref; skip+warn, no crash. (commit eb7d38e)
- **G5** [MED] — Anthropic warns on `*_tool_use` server-tool blocks (diagnosable FIX#3). (6030d95)
- **G6** [LOW] — documented the max_tokens-vs-max_completion_tokens constraint in openrouter.ts;
  per-route param map deferred (G2 backstop covers it). (commit with G2)
