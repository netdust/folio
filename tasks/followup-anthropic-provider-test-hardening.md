# Follow-up: Anthropic provider test-effectiveness hardening

**Filed:** 2026-06-08, split out of `fix/thinking-model-tool-calls` (commit d4d9ce0).
**Priority:** Low — test-hardening only. No behavioral bug exists.

## Context

While fixing the thinking-model tool-call bug class in the Ollama + OpenAI/OpenRouter
providers, a parallel cross-provider audit (`netdust-core:test-effectiveness`, seven-mode)
checked Anthropic too. **Anthropic has NO behavioral defect** — unlike the OpenAI-compatible
path, it detects `tool_use` by the structural `content_block_start{type:'tool_use'}` event,
not by the finish label, so the thinking-interleave / `stop_reason:'stop'`-with-tool-call
case cannot drop a tool round. There is also no hardcoded base URL (uses the SDK).

The exposure is purely **test effectiveness**: several paths are correct *by construction*
but a future edit could break them with the suite staying green. File: `apps/server/src/lib/ai/anthropic.ts`, tests in `anthropic.test.ts`.

## Punch list (ranked)

- [ ] **1. (highest value) Assistant `tool_use` request-echo is unverified — wire-mock leak.**
  `anthropic.ts:21-34` re-serializes a prior assistant turn's tool calls into a `content`
  array (`{type:'tool_use', id, name, input: tc.arguments}`) so follow-up `tool_result`
  messages correlate. The mock (`anthropic.test.ts:22`) ignores its arguments — breaking the
  echo (drop it, mis-map `arguments`→`input`, or emit `arguments` instead of `input`) leaves
  EVERY test green. Add a `messages.stream` argument spy; assert the assistant turn serializes
  to a `content` array with `{type:'tool_use', id, name, input}` and a `role:'tool'` message
  maps to `{type:'tool_result', tool_use_id, content}`. (Mirror the request-body assertions
  added for ollama/openai in this commit.)

- [ ] **2. Thinking-block guard test (the thinking-model class for Anthropic).**
  `anthropic.ts:94` emits text ONLY on `delta.type === 'text_delta'`, so `thinking_delta` /
  `signature_delta` are correctly NOT leaked as text — but nothing asserts it. Add a stream
  with `content_block_start{type:'thinking'}` + `thinking_delta` + `signature_delta` before a
  `text_delta`; assert thinking is NOT yielded as `text` while the trailing text/tokens/done
  still fire. (The existing "pause_turn" test at ~line 147 is MISLABELED — it sends a plain
  `text_delta` named 'thinking...', not a real thinking block.)

- [ ] **3. Multiple parallel `tool_use` blocks unverified.**
  Anthropic emits parallel tool calls by default. `anthropic.ts` keys each by `ev.index` and
  emits at its own `content_block_stop` — correct, but zero coverage. Add a stream with two
  `tool_use` blocks (index 0 and 1); assert two distinct `tool_call` events.

- [ ] **4. (minor) `stop_reason:'max_tokens'` mapping untested.**
  One-line Tier-B mapping; add a case for parity with the `refusal`/`pause_turn` tests.

## Acceptance

Each new test must be proven RED-on-revert (break the corresponding code path, confirm the
test fails) per the test-effectiveness discipline — not just green-when-added.
