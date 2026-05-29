# Phase 3 — Agent Runner + Provider Abstraction + Runs as Documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Wrap every plan-execution session in `netdust-core:ntdst-execute-with-tests`** — this Folio harness REQUIRES testing-workflow gates after each task (subagent) and after each sub-phase (controller). The wrapping skill enforces them.

**Goal:** Ship the polling-worker agent runner: provider abstraction across Anthropic/OpenAI/OpenRouter/Ollama, the `agent_run` document type living in a lazy-seeded per-project runs table, the runner loop with six recursion guards + token budget enforcement, the comments-substrate approval gate wired to live runs, the "Agent Offline" workspace banner, and HTTP↔MCP parity on all five new run operations.

**Architecture:** A long-lived poller in the same process reads `agent_run` rows at `status='planning'` from the `documents` table (the queue IS the table), atomically claims them, and dispatches `runAgent(runId)` fire-and-forget at a configurable concurrency. Trigger handlers return immediately — they only insert the row. The runner streams provider output, posts `kind=plan/comment/result/error` comments on the parent doc, transitions through the state machine, and clears `worker_started_at` on terminal status. Crash recovery on boot flips orphan `running` rows older than 5 min to `failed (worker_crash)`. Approval gate is three channels (button / `@<agent> approved` keyword / MCP) all funneling through a `kind=approval` comment, picked up by `builtin-on-approval` which inserts a new resuming planning row. Six defense-in-depth guards prevent runaway loops: max-depth, fired-by cycle, per-workspace rate, per-agent rate, per-chain fanout, per-chain duration+tokens. Provider health derived from event history; tipping into degraded emits one `workspace.provider.degraded` event, first green run after that emits `workspace.provider.recovered`.

**Tech Stack:** Bun + Hono + Drizzle + SQLite on the server, React + TanStack Router + react-query + Tailwind + shadcn/ui on the web. New deps: `@anthropic-ai/sdk` and `openai` for two of four providers; OpenRouter reuses the OpenAI client with a base-url override; Ollama uses plain `fetch`.

**Branch:** `phase-3/agent-runner`, branched from `main` at `984b31c` (Phase 2.6 merge). Single branch, sub-phased A → F (mirrors Phase 2.6's structure).

---

## Reconciliation with current code (`main` at `984b31c`)

The spec at `docs/superpowers/specs/2026-05-26-phase-3-agent-runner-design.md` was written assuming migration `0009` was free. Phase 2.6 shipped `0007–0011`. This plan uses **`0012` + `0012a`** for Phase 3 migrations. The spec is otherwise structurally sound — `services/agent-runs.ts`, `lib/runner.ts`, `lib/poller.ts`, `lib/mcp-dispatch.ts`, `lib/ai/`, `routes/runs.ts`, `routes/ai.ts` are all greenfield.

Other reconciliations:
- `KNOWN_EVENT_KINDS` lives in `packages/shared/src/events.ts` (was moved during 2.6 D6). New event kinds are added there, not in any server lib.
- `documents.type` enum currently allows `'work_item' | 'page' | 'agent' | 'trigger' | 'comment'`. Migration 0012 widens to add `'agent_run'`.
- `aiKeys` table already exists (Phase 0) with `(workspace_id, provider, label)` unique index + `base_url` column for Ollama. No schema change needed for the AI key store.
- Auto-migrate-on-boot is NOT on main (handoff §"Critical lesson"). Task 0 in Sub-phase A adds it as cheap insurance.
- Built-in triggers `builtin-on-assignment` + `builtin-on-mention` confirmed at `enabled: false` in `apps/server/src/lib/builtin-triggers.ts:35-57`. Migration `0012a` flips them.

---

## Open decisions baked into this plan

| Decision | Resolved as | Note |
|---|---|---|
| Real-Anthropic Playwright key | env var `FOLIO_TEST_ANTHROPIC_KEY`, test skips with `t.skip()` when unset; documented in `.env.example` | Sub-phase F, Task F-2 |
| Slash commands (`/draft`, `/decompose`, …) | Dropped per spec §1. `@`-mention is the universal "ask an agent" affordance | No tasks for slash commands |
| Branch carve | Single branch `phase-3/agent-runner`, sub-phases A–F internal | Mirrors Phase 2.6 |

---

## Sub-phase map

| Sub-phase | Scope | Acceptance items from spec §10 |
|---|---|---|
| **A. Foundation** | Auto-migrate on boot · Migration 0012 (agent_run + indexes) · Migration 0012a (flip builtins) · Zod schema · Event kinds · State machine helpers · Pre-commit hook for migration↔journal pairing | §10.1, §10.16, §10.25 (chain_id) |
| **B. Providers** | `AIProvider` interface · 4 implementations · AI settings tab · `POST /ai/test-key` | §10.2 |
| **C. Runner core** | `services/agent-runs.ts` · `lib/runner.ts` · `lib/poller.ts` · 6 recursion guards · crash recovery · token budget | §10.3, §10.4–10.6, §10.8–10.11, §10.16, §10.17, §10.18 |
| **D. Routes + MCP parity** | `routes/runs.ts` (5 verbs) · `lib/mcp-dispatch.ts` · 5 new MCP tools · refactor existing MCP dispatch · admin runner-stats endpoint · approval-comment → resume_run wiring | §10.7, §10.12, §10.13, §10.21, §10.22 |
| **E. UI + Runs table** | Lazy-seed runs table · runs link tile on agent/trigger slideovers · approval-buttons live state · Cmd-K Run/Approve · `[[` in body editor · Agent Offline banner | §10.14, §10.15, §10.19, §10.20, §10.23, §10.24, §10.26 |
| **F. Shake-out + e2e** | Real-Anthropic Playwright · Banner Playwright · manual-qa doc · shakeout skill · 4-reviewer pass | §10.27 (no regression) + branch-close gates |

---

## Threat model

> Added 2026-05-28 mid-Sub-phase-B after two rounds of `/code-review` surfaced ~30 security-class findings on the BYOK + arbitrary-URL surface. The plan as originally written had functional requirements ("BYOK is libsodium-encrypted") but no security spec. Without one, every `/code-review` round was independently re-discovering the attack surface. This section is the **convergence target** for security reviews on Sub-phase B + C — `/code-review` checks the code against these named mitigations instead of free-form bug hunting.

### What we're defending

- AI provider API keys (`apiKey`) — stored libsodium-encrypted at rest, server-side decryption only.
- The decryption secret (`FOLIO_MASTER_KEY` env var) — never logged, never returned in responses.
- The server's network position — the host can reach private services (databases, internal APIs, cloud metadata endpoints) that no outsider should reach via Folio.
- Workspace integrity — one workspace's keys must not leak to another workspace, or to a workspace member who shouldn't have admin role.

### Who we're defending against

1. **External attackers** with no Folio account — can hit any public endpoint, can supply any body content to public routes (none of the keys-related routes are public, but the attack surface includes accidentally-public routes from misconfiguration).
2. **Workspace members with write access to /ai-keys** but not admin role — must not be able to exfiltrate other members' keys.
3. **Workspace admins phished into testing/saving a key with attacker-controlled parameters** — admin clicks "Test" or "Save" with a baseUrl field they didn't realize was malicious.
4. **Malicious agents** (Sub-phase C and later) running with workspace-scoped tokens — must not be able to test-key, exfiltrate keys, or steer baseUrl to leak credentials during agent runs.
5. **Insider threat with stolen credentials** is OUT of scope — if an attacker has a workspace admin's session, Folio can't defend against that. Mitigations stop above this line.

### Attacks to defend against

Each attack listed has a mitigation in the next section. Numbering pairs across the two sections.

1. **SSRF via baseUrl**: an attacker supplies a `baseUrl` that resolves to a private network address (RFC1918 ranges, link-local 169.254.0.0/16, loopback 127.0.0.0/8, IPv6 loopback `::1`, **IPv4-mapped IPv6 like `::ffff:127.0.0.1`**, cloud metadata endpoints like `169.254.169.254`). The server then makes a request to that URL while testing the key or running an agent, reaching private services the attacker shouldn't reach.
2. **Credential exfiltration via baseUrl**: the OpenAI provider passes the `apiKey` as a `Bearer` header in `Authorization`. If `baseUrl` points at an attacker-controlled HTTPS endpoint, the apiKey leaks to the attacker's server on every request. Worst-case: attacker steals a real OpenAI key by getting an admin to test it against `baseUrl: https://attacker.example/v1`. Specific to OpenAI-shaped providers (OpenAI, OpenRouter). Anthropic SDK doesn't honor `baseUrl` through the test API surface (see attack 7).
3. **Persistence-path exfil**: even if `/ai/test-key` validates `baseUrl`, the `POST /ai-keys` route (settings.ts) ALSO writes baseUrl into the encrypted blob. If that path doesn't validate, an attacker who can write to `/ai-keys` stores `(apiKey, attacker_baseUrl)`. A later agent run reads the row and leaks the key.
4. **Local service abuse via Ollama default**: the Ollama provider defaults `baseUrl` to `http://localhost:11434` when omitted. On a server that runs other unauthenticated services on localhost (Redis, internal HTTP, the server's own debug endpoints), `testKey` against Ollama probes those services even when no Ollama instance is running.
5. **Error-message info disclosure**: SDK error responses occasionally embed partial key bytes or partial response bodies. If the server passes the SDK error message verbatim into the HTTP response, key fragments leak to the client's DOM and to logs.
6. **Provider downgrade via untrusted stop-reason**: future Anthropic / OpenAI stop reasons (`refusal`, `pause_turn`, `content_filter`) get silently downgraded to `'stop'` in the current `ProviderEvent` union. The runner can't distinguish "model refused" from "model completed." Worst-case: a refusal counts as success and a downstream tool runs with empty / misleading arguments.
7. **Interface lies**: `AIProvider.stream` accepts `baseUrl` for all four providers, but Anthropic ignores it (SDK doesn't take baseURL through the messages.stream surface in a meaningful way). Operator believes they've configured Anthropic to use a custom endpoint; provider silently uses the canonical one. Latent until someone tries it.
8. **JSON.parse crashes mid-stream**: provider streams emit JSON fragments (tool_call args via `input_json_delta`, Ollama NDJSON lines). If any fragment is malformed (network blip, truncation, encoding edge case), `JSON.parse` throws, the stream's async iteration unwinds, and the agent run dies with a cryptic error. Worst-case: the runner has no fallback, the agent_run row stays at `running` forever and the worker_crash recovery (Sub-phase C) is the only path out.
9. **Falsy-zero bugs in token accounting**: provider streams report `tokens_in: 0` legitimately at certain points (e.g. cached prompts, completion-only updates). Code that does `if (delta.tokens_in)` skips on zero, under-counting tokens. Budget enforcement (Sub-phase C) becomes inaccurate; cheap agents can silently exceed budgets that should have stopped them.
10. **Provider proxy cache poisoning**: the lazy-import proxy in `provider.ts` caches the first resolved AIProvider per name. If the first call's dynamic import fails (rare — usually only on missing peer deps or network-imported modules), a rejected Promise gets cached and every subsequent call inherits the failure forever. Recovery requires process restart.
11. **Cookie-presence bypass of auth-narrowing**: a route that wants to be session-only must check that the session was VALID, not just that a session cookie was present. Bun (and any web framework) forwards the Cookie header verbatim — invalid/expired/garbage cookies still arrive. A guard that only checks cookie-header presence + token-presence will let `Cookie: folio_session=garbage` + `Authorization: Bearer <PAT>` through. (Round 3 attack — round 2's `!!getCookie('folio_session')` guard was exactly this shape.)
12. **Asymmetric persistence-vs-test SSRF validation**: when `/ai/test-key` validates URL inputs but `POST /ai-keys` persists URLs without the same validation, the persistence path becomes the live vulnerability. An admin who can't probe loopback via test-key can still pin a loopback baseUrl into a stored row, which the agent runner (Sub-phase C) later fetches. Symmetry between test-key and persistence routes must be explicit and tested. (Round 3 attack — round 2 closed the SSRF guard on test-key but left the `ollama && baseUrl===undefined` hole on persistence.)
13. **OpenRouter testKey false-positive**: OpenRouter's `/api/v1/models` endpoint is PUBLIC. testKey via `models.list()` returns ok for any apiKey value (including the empty string). Admins believe a key is valid; the first real stream call fails 401 and the agent run errors out — by which point the key is encrypted-at-rest and audit logs show "key validated." Auth-required endpoint (`/api/v1/key` or `/api/v1/credits`) must be used. (Round 3 attack.)
14. **Trailing-dot DNS form bypassing host equality**: hostnames may carry a trailing dot (root-anchored DNS form: `localhost.`, `foo.localhost.`). Linux resolves these to the same address as the non-trailing-dot form. String-equality and `endsWith()` checks must strip the trailing dot before comparison. (Round 3 attack — round 2's `host === 'localhost' || host.endsWith('.localhost')` didn't see `localhost.`.)
15. **IPv4-mapped IPv6 expanded forms**: `0:0:0:0:0:ffff:hhhh:hhhh` is the same address as `::ffff:hhhh:hhhh` — the URL parser may preserve either form depending on runtime. Detection must handle both canonical and expanded shapes. (Round 3 attack — Bun canonicalizes the expanded form to the 2-segment shape, but defending against runtime drift requires both regexes.)
16. **Test-escape-hatch reachable from production**: `__INTERNAL_TEST_ONLY__.overrideRegistry` is exported from `provider.ts` as a normal ES module binding. A future production refactor or IDE-autocomplete reach calls it, poisoning the process-wide provider cache. JSDoc `@internal` is not enforced by TS. Cosmetic rename without a runtime guard is documentation, not protection. (Round 4 attack — round 3's rename was acknowledged in the commit message as "real refactor deferred to v1.1.")
17. **Silent server-side commit under client-side race**: `onSave` was given a seq-id guard in round 3 fix #7. The guard suppresses the client's success toast when provider changed mid-flight, but the `mutateAsync` was already dispatched — the server row IS committed for the OLD provider. User sees no signal of save, but the workspace's AI-key roster has changed. The "discard" name is misleading: only the UI render is discarded. (Round 4 attack.)
18. **HTTP twin of MCP agent-lifecycle**: round 6 #1 rejected human PATs on MCP `create_agent`/`update_agent`/`delete_agent`. But the HTTP equivalents — POST/PATCH/DELETE on `/api/v1/w/:wslug/documents` with `type=agent` — accept human PATs with `documents:write` + `agents:write` scope. The width-guards in `lib/agent-guards.ts` bypass for human PATs (`!token.agentId`). A stolen Bearer mints/edits/revokes agent_token via HTTP exactly as MCP did before round 6.

19. **Sub-phase C runner cannot persist refusal/pause_turn**: round 4 widened `ProviderEvent.done.reason` to include 'refusal' and 'pause_turn'. The persistence schema (`agent_run_schema.ts`) has no slot to store them. Sub-phase C runner will either drop the signal (status='completed' — operator-confusing), collapse to error_reason='provider_error' (lossy), or invent a field (drift).

20. **POST /workspaces is session-only by routing topology, not by gate**: workspacesRoute is mounted on v1 (not wScope), so attachToken never runs. The protection relies on `requireUser` rejecting Bearer-only callers. A future middleware consolidation that mounts attachToken at app root would silently turn this into a bearer-reachable route. No test asserts the routing invariant.

21. **Member PII leak via GET /members for narrowed agents**: an agent token's frontmatter.projects narrows what events/documents it can see (F3). GET /api/v1/w/:wslug/members has no analogous narrowing. An agent allow-listed to one project receives the full workspace membership (50 emails including users on 9 projects the agent has no F3 visibility into).

### Mitigations required

These are the rules the code MUST follow. `/code-review` should verify each one is in place before declaring convergence on Sub-phase B + C.

1. **One shared baseUrl validator**, exported from `apps/server/src/lib/ai/baseurl-validator.ts` (TBD — write during round-3 fix batch). Validates: scheme is `https` (or `http` for Ollama-localhost-only exception), resolves DNS to a non-private IPv4, NOT IPv4-mapped IPv6 (`::ffff:`), NOT IPv6 loopback (`::1`), NOT any RFC1918 range, NOT link-local (169.254.0.0/16, fe80::/10), NOT cloud metadata IPs (169.254.169.254 specifically). **Cache the resolved IP for the duration of the request** to prevent DNS-rebinding mid-fetch. Called from BOTH `/ai/test-key` AND `POST /ai-keys` — both paths route through the validator before persistence OR network use.
2. **baseUrl ALLOWED only for Ollama and OpenRouter**. Anthropic and OpenAI use hardcoded canonical URLs (`https://api.anthropic.com`, `https://api.openai.com/v1`). The server validation step explicitly rejects `baseUrl` when `provider in ('anthropic', 'openai')`. The plan's original "baseUrl: z.string().url().optional()" is too permissive — narrow it provider-by-provider.
3. **`POST /ai-keys` validates baseUrl through the same path** as `/ai/test-key`. Single source of truth for what baseUrl is acceptable.
4. **Ollama requires explicit `baseUrl`** for the test-key flow. The default-to-localhost behavior in the provider implementation stays (the runner needs a sensible default for `Ollama` agents already configured), but the test-key route explicitly requires `baseUrl !== undefined` when provider is `ollama` and surfaces an error if missing.
5. **Error messages sanitized** before they reach HTTP responses OR before they're thrown out of a provider method that the runner will surface. Sites that must use the whitelist: `openai.testKey`, `anthropic.testKey`, `ollama.testKey`, `openrouter.testKey`, AND `openai.stream` / `anthropic.stream` / `ollama.stream` / `openrouter.stream` startup error throws (the `throw new Error(...)` paths inside stream() before the async iterator yields anything). The whitelist: 401/403→'Unauthorized', 429→'Rate limited', 5xx→'Server error', other-status→'Error (<status>)', no-status→'Network error or unreachable host.' NEVER echo `e.message`, NEVER echo caller-supplied `baseUrl`/`model`.

   **Implementation status (as of round 5):**
   - `openai.testKey`, `anthropic.testKey`, `ollama.testKey`, `openrouter.testKey`: ✓ (rounds 3-4)
   - `ollama.stream` startup error: ✓ (round 4)
   - `anthropic.stream`, `openai.stream`, `openrouter.stream` startup errors: ✓ (round 5)
6. **`ProviderEvent.done.reason` adds `'refusal'`** now (sub-phase B). `'pause_turn'` deferred to Sub-phase C when the runner gains a paused state. Each provider implementation maps its specific stop reasons explicitly — no silent downgrade. SDK-specific stop reasons that don't map to the union should emit a warning log line, not silently become `'stop'`.
7. **`AIProvider.stream`'s `baseUrl` parameter is documented as Ollama-and-OpenRouter only**. The Anthropic + OpenAI implementations ignore it. Either remove from the shared interface (cleaner) OR add a runtime check that throws if a caller passes baseUrl to an unsupported provider (acceptable v1). The latter is faster to ship; the former is right long-term.
8. **JSON.parse calls are try/catch-wrapped** in all four provider implementations. On parse failure: log + emit a `type: 'tool_call'` event with `arguments: { __parse_error: true, raw: <truncated buf> }` so the runner can distinguish truncation from intent and decide whether to retry or fail. Streams MUST NOT abort on a single bad chunk.
9. **Token-accumulator updates use `!== undefined`**, not truthy checks. `if (usage?.prompt_tokens !== undefined) tokensIn = usage.prompt_tokens;` — handles the zero case correctly.
10. **Provider proxy caches resolved Providers, not rejected Promises.** On dynamic-import failure: drop the cache entry instead of caching the rejection. Next call retries from scratch. Belt-and-braces: a process-level retry counter logs after N consecutive failures so operations can spot a wedged provider.
11. **Session-only routes via a `requireSession` middleware.** `attachUser` sets `c.set('authMethod', 'session')` ONLY when a valid session cookie hydrated a user (post-`readSession`, post-null-check). `attachToken` sets `'token'` when a Bearer hydrated one and no session was present. The middleware `requireSession` (in `apps/server/src/middleware/auth.ts`) rejects with 403 when `authMethod === 'token'`. ALL routes that mutate auth grants, workspace ownership/identity, or BYOK credentials MUST use it.

   **Routes covered by `requireSession`:**

   | Route | Verb(s) | Rationale |
   |---|---|---|
   | `/api/v1/w/:wslug/ai/test-key` | POST | Test a BYOK credential (round 3) |
   | `/api/v1/w/:wslug/settings/:wsId/ai-keys` | POST, DELETE | Mutate BYOK row (round 4 closed POST, round 4 closed DELETE) |
   | `/api/v1/w/:wslug/tokens/:wsId` | POST | Mint a new API token (round 5) — stolen Bearer could mint elevated-scope replacements |
   | `/api/v1/w/:wslug/tokens/:wsId/:tokenId` | DELETE | Revoke an API token (round 5) — stolen Bearer could revoke peers |
   | `/api/v1/w/:wslug` | PATCH, DELETE | Workspace rename / deletion (round 5) — destructive identity mutation |
   | `POST /mcp` tools: `create_agent`, `update_agent`, `delete_agent` | * | Reject human PAT (`token.agentId === null`); agent-bound bearers OK for agent self-management (round 6 #1) |
   | `POST/PATCH/DELETE /api/v1/w/:wslug/documents` (type=agent) | * | Reject human PAT via parallel HTTP helper (round 7 #19) |
   | `POST /api/v1/workspaces` | POST | Explicit `requireSessionUser` (round 7 #21) |
   | Any FUTURE route that mutates auth grants, workspace identity, master secrets, or BYOK credentials | * | New routes that fit the pattern MUST use `requireSession` in the same commit they are introduced |

   **Routes intentionally NOT session-only (bearer-OK):**
   - `GET /ai-keys` — metadata read (agents need this for telemetry)
   - `GET /tokens` — metadata read
   - `POST/PATCH/DELETE` on documents (non-agent types), projects, statuses, fields, views, runs — agent workflow; that's the point of API tokens
   - `GET /api/v1/w/:wslug/members` — bearer-OK for session callers and wildcard-allow-list agents; NARROWED for project-allow-list agents (see mitigation 22).
   - `POST/PATCH/DELETE /api/v1/w/:wslug/documents` with `type=agent` (HTTP): bearer-OK ONLY for agent-bound bearers (legitimate self-management) and session callers (admin workflow). Human PATs were previously accepted here on the assumption that "admin-facing HTTP" was a distinct surface; round 7 #19 closed that gap because a stolen PAT with `agents:write` is a privilege-escalation vector regardless of which surface the attacker reaches. Both MCP and HTTP now uniformly reject human PATs on agent CRUD.

   **Test contract:** for each row in the "covered" table, a test asserts the route returns 403 when called with `Authorization: Bearer <valid token>` only, AND when called with `Authorization: Bearer <valid token>` + `Cookie: folio_session=garbage`. Round 5's settings.test.ts gained the DELETE garbage-cookie test for symmetry; tokens.test.ts and workspaces.test.ts gain equivalents in round 5.

   A garbage cookie + valid bearer authenticates as `'token'`, never `'session'`. This is asserted by tests across `ai.test.ts`, `settings.test.ts`, `tokens.test.ts`, and `workspaces.test.ts`.
12. **Persistence and test-key share validation logic.** Every guard added to `/ai/test-key` is mirrored on `POST /ai-keys`. The shared guard set:

   | Guard | /ai/test-key (ai.ts) | POST /ai-keys (settings.ts) |
   |---|---|---|
   | authMethod !== 'token' | round 3 #1 | round 4 #1 |
   | baseUrl-only-for-ollama refine | round 2 #2 | round 2 #3 |
   | ollama-requires-explicit-baseUrl | round 2 #5 | round 3 #2 |
   | validatePublicUrl(baseUrl) when defined | round 1 #2 | round 2 #3 |
   | zValidator returns 400, route-thrown HTTPError returns 422 | — | round 4 #9 (superRefine harmonization deferred — see "Out of scope") |

   New guards added to one route MUST land on the other in the same commit. A single helper (`validateAiKeyBody(body)`) is the long-term shape; symmetric inline checks with shared tests are acceptable v1. `DELETE /ai-keys/:keyId` inherits the authMethod check from mitigation 11 above but doesn't need baseUrl validation (no body).
13. **OpenRouter testKey overrides openai.testKey** with a call to `/api/v1/key` (auth-required) — NOT `/api/v1/models` (public). The override lives in `lib/ai/openrouter.ts` as an explicit `testKey: async ({apiKey}) => fetch(.../key)`, NOT a delegate-to-openai-with-baseURL-override. A defense-in-depth test (`openrouter+baseUrl` is rejected by the refine) pins the schema contract.
14. **`validatePublicUrl` strips ALL trailing dots before any host comparison.** `host = host.replace(/\.+$/, '')` runs once, BEFORE the localhost check, the IPv4 prefix loop, and the IPv6-mapped detection. A test asserts `http://localhost.:...`, `http://localhost..:...`, AND `http://foo.localhost.:...` are blocked. The greedy strip closes the multi-dot bypass (round 4 #3).
15. **`validatePublicUrl` detects ALL IPv6 prefixes in both canonical and expanded forms.** The defense-in-depth must be symmetric across:

   - `::1` (loopback) — block `^::1$/` AND `^(?:0{1,4}:){7}0{0,3}1$/i` (any number of leading-zero zero-segments).
   - `::` (unspecified) — block `^::$/` AND `^(?:0{1,4}:){7}0{0,4}$/i`.
   - `::ffff:hhhh:hhhh` (IPv4-mapped) — block `^::ffff:.../i` AND `^(?:0:){5}ffff:.../i` PLUS decoded-IPv4 check via BLOCKED_IPV4_PREFIXES.
   - `fe80::/10` (link-local) — block `^fe[89ab][0-9a-f]:/i` AND `^fe[89ab][0-9a-f]:(?:0:){5,7}` for expanded.
   - `fc00::/7` (unique-local) — block `^fc.../i` AND `^fd.../i` AND expanded forms.

   Cleaner: write a `canonicalizeIpv6(host: string): string` helper that compresses leading-zero segments, THEN run the canonical regexes. Pragmatic v1: add the expanded forms for the same 5 prefixes inline. The test suite covers both forms for each prefix.

16. **Test-only escape hatches are unreachable from production code.** The `__INTERNAL_TEST_ONLY__` export from `apps/server/src/lib/ai/provider.ts` has a RUNTIME GUARD: every call to `overrideRegistry`, `reset`, `hasInflight`, `hasCached`, `loadProvider` checks `process.env.NODE_ENV === 'test'` and throws if not. Production code that accidentally imports + calls these will crash at startup or first request, not silently mutate the registry. A future refactor (deferred) moves these into a separate `provider.testing.ts` file with an ESLint `no-restricted-imports` rule banning non-test imports — until that lands, the runtime guard is the enforcement.

17. **Web mutations surface honest feedback on context-change.** When the AI tab's `onSave` mutation is in flight and the user switches provider, the mutation IS NOT aborted at the wire level (deferred to v1.1 — see Out-of-scope). Instead, the resolved-success branch shows a truthful `toast.info("Save completed for previous provider (anthropic)")` naming the provider captured at click time, NOT the current state. The user knows a side effect happened and which provider it landed on. The same wording is used in the resolved-error branch so the user sees the OUTCOME of the abandoned save, not silence.

   The captured-at-click value is used consistently across both branches; the current-state value is never displayed in this surface so a stale paint cannot mislead.

18. **`validatePublicUrl` rejects empty hosts after the trailing-dot strip.** Bare-dot inputs (`http://.`, `http://..`) parse successfully in Bun's URL parser but become empty strings after the greedy dot strip; without an explicit check they would slip every host-equality and prefix-regex guard and return `ok:true`. After `host = host.replace(/\.+$/, '')`, the validator immediately checks `if (host === '') return { ok: false, reason: 'base_url host is empty' }`. A test covers `http://./` and `http://.../`.

19. **HTTP agent-lifecycle routes reject human PATs**, mirroring round-6 MCP fix. POST/PATCH/DELETE on `/api/v1/w/:wslug/documents` with body.type==='agent' check `!c.get('token')?.agentId` before mutating the row. Human PATs → 403 with `error.code: 'HUMAN_PAT_AGENT_LIFECYCLE_HTTP'`. Agent-bound bearers and session callers continue to work. Combined with the existing MCP gate, agent CRUD is now uniformly gated on both surfaces.

20. **`agent_run_schema.ts` accepts done.reason: 'refusal' and 'pause_turn'**. The schema gains a `done_reason` enum field matching the widened ProviderEvent union (`stop|tool_use|max_tokens|refusal|pause_turn`). Sub-phase C runner persists the done event's reason directly. Status mapping: 'refusal' and 'pause_turn' both terminate the run as 'completed' but with `done_reason` distinguishing them from clean completion. Operator dashboards can branch on `done_reason='refusal'` to triage safety stops.

21. **POST /api/v1/workspaces gets explicit `requireSessionUser`** — no longer relying on routing topology. The middleware throws 403 if `authMethod === 'token'` AND 401 if `!user`. Tests assert both. The change is no-op for current production (bearer-only requests are already rejected by `requireUser`) but pins the contract against future middleware refactors.

22. **GET /api/v1/w/:wslug/members narrows by agent allow-list**. When the caller is an agent-bound bearer with `frontmatter.projects` not containing '*', the response narrows. The same narrowing pattern as F3 in events.ts. v1 implementation (project-scoped memberships not yet present in schema): project-narrowed agent-bound bearers receive an EMPTY members list — they have no business knowing workspace membership; their work is scoped to docs in the allow-list projects. Session callers and agent-bound bearers with `projects: ['*']` see the full list. v1.1 would refine this to "members of at least one allowed project" once project-scoped memberships exist.

### Out of scope (explicit deferrals)

- **DNS rebinding beyond cached resolution** — fully bulletproof would require DNS-pinning at the fetch layer or DNS-over-HTTPS with locked resolvers. Accepted residual risk for v1.
- **Auditing every outbound HTTP request** the runner makes (per-request justification log) — Sub-phase C's `ai.action` event + the runner's commit pattern already provides a coarse audit trail. Deeper auditing parked for v1.1.
- **Rotating `FOLIO_MASTER_KEY`** without a deploy — operational concern, not v1.
- **Per-key allow-lists** of which paths the apiKey is valid against — Anthropic, OpenAI, OpenRouter don't expose this in their key shapes. Accepted residual risk.
- **Anti-CSRF for `/ai/test-key`** — Folio's session cookie is SameSite=Lax (verify), and the route requires a session, so CSRF from a third-party origin is mitigated by browser-level same-origin policy. If session config is ever weakened, revisit.
- **Threat model for `runs` table data exfil** (Sub-phase C concern) — agent_run rows can contain user prompts and tool-call args that include sensitive workspace data. Cross-workspace isolation depends on the existing scope-check infrastructure from Phase 2.5. Sub-phase C's plan should reference back to this section before extending.
- **Greedy trailing-dot strip in IPv4 prefix loop** — the current per-prefix regex uses `^192\.168\.` etc. After the greedy trailing-dot strip on the host string, trailing dots can't appear before the prefix anchors. Defense-in-depth would normalize ALL non-significant whitespace + case-fold before each check; v1 relies on the URL parser's canonicalization plus the greedy strip.
- **Harmonizing 400-vs-422 status codes** on settings.ts INVALID_BODY responses — the zValidator emits 400 for shape failures, the imperative-check emits 422. Both carry `error.code: 'INVALID_BODY'` so consumers can dedupe on the code rather than the status. Migration to `.superRefine` (one shape, 400 INVALID_BODY) deferred to v1.1 alongside the API doc generator.
- **AbortController on BOTH sides** — round 5 rewrote mitigation 17 to clarify that there's no web-side AbortController either (deferred to v1.1). The current v1 behavior is the honest info-toast naming the captured-at-click provider. v1.1 would add: (a) `fetch(..., { signal })` on the web mutation, and (b) propagate the signal through the SDK call so an aborted save doesn't bill upstream. Both deferred together. Round 6 #5 fixed the contradiction this bullet previously contained (it described "the web-side abort cancels the fetch" — premising on an abort that mitigation 17 said did not exist).

### How to use this section

- Before dispatching ANY task in Sub-phase B or C that touches user-controlled URLs, baseUrl handling, key persistence, or provider streams: the controller pre-flight verifies that the task's plan-supplied code includes the relevant mitigations (1-10 above).
- `/code-review` invocations on Sub-phase B + C: include "Verify code against the threat model in the plan (section: Threat model). Each numbered mitigation should be checked. Report which mitigations are in place, which are missing, and which are out of scope per the deferrals list."
- `/evaluate` retros: list mitigations that were not implemented as plan-correction defects.
- Sub-phase C plan-writing (when it happens): cross-reference this threat model when sketching the runner's outbound-request handling. Don't re-litigate; extend.

### Lesson (for memory/lessons.md)

> **Plans for features that touch user-controlled URLs, untrusted parsing, auth surfaces, or BYOK MUST include a `## Threat model` section before task breakdown. Without one, `/code-review` rounds independently re-discover the attack surface and don't converge. With one, reviews verify against a fixed spec and converge in one pass.**

---

## Threat model — Sub-phase C extension (runner, services, poller, triggers)

> Added 2026-05-28 evening, **before** any Sub-phase C task is dispatched, per the Sub-phase C readiness handoff (`docs/superpowers/handoffs/2026-05-28-phase-3-sub-phase-C-readiness.md`) and Recommendation 1 from the Sub-phase B retro (no code touches a runner-class surface until a threat model is committed). This section EXTENDS the Sub-phase B threat model above — it does NOT re-litigate it. Sub-phase B mitigations 1–22 remain in force across all Sub-phase C code (the runner consumes the same `aiKeys` rows that B validated, the same provider implementations whose errors B sanitized, the same `ProviderEvent` union B widened). C adds new assets (the `agent_run` row content, the runner's outbound HTTP capacity, the MCP dispatch as a NEW caller path) and the new attacks they unlock. The 22 + N format means `/code-review` on C verifies against the union, not just the C-specific items.
>
> Calibration: B took 7 rounds and 5h27m of `/code-review` review-fix cycles because the threat model was written retrospectively. C must converge in 1–2 rounds per sub-sub-phase. This section is the convergence target.

### What we're defending (new in C)

In addition to the four B assets (apiKey, FOLIO_MASTER_KEY, server network position, workspace integrity), Sub-phase C introduces:

- **`agent_run` row content as a workspace-secret-bearing asset.** The runner inlines parent-doc content into the LLM prompt, persists tool-call args into the run's frontmatter (as future runs build prompt history from prior runs), and writes prompts/results into `comments` referenced by `frontmatter.run_id`. Any of those surfaces can carry workspace-sensitive data (PII pasted into a work item, doc body excerpts from `[[wiki-links]]`, prior comment threads). The new asset is: **the contents of every `agent_run` row, every comment with `frontmatter.run_id` set, and every prompt-history reconstruction the runner performs.**
- **The runner's outbound HTTP capacity.** Each agent run consumes a provider stream. A misbehaving prompt or unguarded chain can detonate a single user action into thousands of provider calls, exhausting workspace budget, billing the BYOK key the workspace owns, and saturating the runner's per-host connection pool. The asset being defended: **the workspace's BYOK budget AND the server's outbound bandwidth/connection-pool fairness across workspaces.**
- **The MCP-dispatch surface from inside the runner.** Sub-phase B closed `routes/mcp.ts`. Sub-phase C introduces `lib/mcp-dispatch.ts` as a NEW caller path: the runner dispatches tool calls on behalf of an agent-bound bearer using the same tool registry. The asset: **scope-check and allow-list integrity for tool calls dispatched by the runner, with the runner being a privileged caller that must not weaken the gates.**
- **The audit trail (events table) as a distinguishability asset.** Operators triage runner bugs by reading `agent.run.failed` events. If `worker_crash` runs are indistinguishable from `provider_error` runs are indistinguishable from explicit `cancelled` runs, every triage starts at zero. The asset: **a distinguishable `error_reason` taxonomy on terminal `agent.run.failed`/`agent.run.rejected` events.**

### Who we're defending against (new in C)

The five B actor classes carry forward (external attackers, members-with-write-no-admin, phished admins, malicious agents, insiders OUT of scope). C adds two:

6. **Prompt-injection attackers who can write to a document the runner will read.** An attacker who can post a comment, edit a doc title, or write into a wiki page can plant instructions that the agent will see when the runner inlines content for the LLM. They may not have direct API access at all — their attack surface is "future agent runs that read this doc." IN scope.
7. **Concurrent operators racing on the same `agent_run` row.** Two poller workers (multi-process deployments) or two threads (within one process) both call `claimNextPlanningRun` on the same row. Not malicious, but the failure mode (duplicate provider charges + duplicate comments + corrupted state-machine ordering) is identical to a deliberate attack. IN scope.

### Attacks to defend against (Sub-phase C)

Numbered 23–N, continuing the B sequence. Each attack pairs with a mitigation below.

**Asset: `agent_run` row content**

23. **Cross-workspace `agent_run` read via the documents API.** The `agent_run` rows live in the `documents` table (Sub-phase A widened the `type` enum + added `documents_runs_*` partial indexes). GET `/api/v1/w/:wslug/projects/:pslug/documents?type=agent_run` is the natural query. The existing scope-check infrastructure (Phase 2.5 + B mitigation 11) covers workspace + project membership for the human-readable doc types; the runs table is a new type that is mounted on the same routes. If the documents-list path has any `type='work_item' || type='page'` carve-out that gated the broader workspace check, agent_run leaks across the carve-out.

24. **Cross-project `agent_run` read by a project-narrowed agent-bound bearer.** B's mitigation 22 narrowed `GET /members` for agents with `frontmatter.projects` not containing `'*'`. The runs table needs the same narrowing: an agent bound to project A must not be able to list/read agent_runs from project B via the documents API, even though both rows live under the same workspace.

25. **Prompt-injection exfil via `[[wiki-link]]` inlining.** The runner inlines content from documents the parent references. Attacker plants `[[secrets/api-rotation-keys]]` in a doc the runner will read; the runner expands the wiki link, inlines the secret doc's body into the LLM request; secret data ends up in the provider's training data / abuse logs / forwarded to attacker-controlled `baseUrl` (cf. B attack 2).

26. **Tool-call arg JSON poisoning bypasses zod refines.** Agent calls `create_document(body=<attacker-prompted markdown>)`. The B mitigations close malformed JSON parsing (B#8) at the provider layer; what arrives at `executeMcpTool` is well-formed JSON. But Zod-validation lives in the route handlers (`routes/mcp.ts`). The runner now bypasses the route layer entirely. If `lib/mcp-dispatch.ts` looks up the tool but doesn't re-run the Zod schema, malformed-but-parseable args (`title: <very long string>`, `frontmatter: {__proto__: ...}`, `slug: '../../escapes'`) reach the handler unvalidated.

27. **Prompt-injection-driven tool privilege escalation.** Attacker plants instructions that the agent should call `delete_document` or `create_agent` on a target the legitimate operator never intended. The attack does not need to bypass tool scope — it bypasses *operator intent*. Sub-phase B closed `create_agent`/`update_agent`/`delete_agent` against human PATs but agent-bound bearers (which the runner uses) remain authorized. A prompt-injected agent can legitimately call `delete_agent` on a peer agent within its allow-list.

28. **`agent_run.error_reason` and `error_detail` carry raw SDK strings.** The runner catches stream errors and writes them into the run row. If `error_detail` echoes the SDK's raw error message, key fragments / URL fragments / sensitive context leaks (cf. B attack 5 — same vulnerability class, new write surface). Worse: error_detail is persisted, so a future read of the runs table re-exposes the leak indefinitely. (`runErrorReasonSchema` already exists from Sub-phase A with a 12-value closed enum; the attack here is on `error_detail` content, not the enum.)

**Asset: runner outbound HTTP capacity**

29. **Chain-level fan-out DoS via `comment.mentioned` recursion.** Agent A's run posts a comment that mentions Agent B; Agent B's run posts a comment that mentions Agent A. Without `chain_id` aggregation + a hard fan-out cap, two agents mentioning each other detonate into thousands of runs.

30. **Token-budget bypass via chain-of-N-runs.** Agent's `max_tokens_per_run` cap is bypassed by spawning N child runs each at the cap. Workspace's hourly cap is bypassed by spreading runs across the boundary. The chain-level cap (`FOLIO_MAX_CHAIN_TOKENS`) is the defense, but it must be enforced AT POLLER CLAIM TIME (before the next child is even claimed), not only at runner start-of-execution.

31. **Provider-degraded retry amplification.** Provider hits 3 consecutive failures → degraded; pending `planning` rows continue to get claimed; each one fails the same way, burning rate-limit retry quota and worsening the degradation. The amplification is asymmetric: degradation lasts hours, recovery is immediate. Without a circuit-breaker, one bad provider config tarpits the whole workspace's run queue.

32. **DNS-rebinding mid-stream via provider baseUrl.** B mitigation 1 cached DNS resolution per request. The runner's stream is multi-request over time: a long-running stream may make multiple HTTPS requests under the hood (or, in Ollama's case, multiple NDJSON requests). If each request re-resolves the host, a DNS-rebinding attacker can switch IPs mid-run. B explicitly listed this as OUT of scope (residual risk for v1); we re-acknowledge.

33. **Outbound rate-limit fairness across workspaces.** One workspace's runaway chain monopolizes the runner's per-host connection pool. Other workspaces' runs queue up but their poller still claims rows at full rate; the rows transition to `running` but the runner blocks on the saturated pool. No SLA, just stuttering.

**Asset: MCP dispatch from runner**

34. **`executeMcpTool` skeleton with `__echo` test tool reachable in production.** Sub-phase C registers a single `__echo` tool for testing the dispatcher. If the registration is process-global and not guarded by `NODE_ENV === 'test'`, `__echo` becomes a discoverable production tool. Even though it does nothing meaningful, it teaches the agent that tools exist that aren't in the v1 documented set — and a future expansion of the test tool to "echo with side effects" silently becomes a production vector. (Same shape as B attack 16: `__INTERNAL_TEST_ONLY__`.)

35. **MCP dispatcher transaction scope leakage.** A tool like `create_document` does multi-statement DB work (row insert + event emit). The runner calls `executeMcpTool` in the middle of its run loop. If the runner holds an open transaction (for state-machine updates), the tool's nested transaction either deadlocks, commits prematurely, or rolls back the runner's state on tool failure. Pattern from B's service layer is tx-first; the dispatcher MUST match.

36. **Agent-bound bearer in dispatcher dispatches tools that mutate agent grants.** The dispatcher receives an agent-bound bearer (`token.agentId !== null`). B mitigation 11 (and HTTP mitigation 19) said agent-bound bearers MAY self-manage. But the runner is acting on behalf of an agent that is responding to prompt-injected instructions. The dispatcher must apply the SAME `requireSessionUser`-equivalent rejection on `create_agent`/`update_agent`/`delete_agent` that the route handler applied — agent-bound bearers reaching these tools through the runner should be treated as agent-bound, not session-equivalent. Or, alternatively, the dispatcher MUST distinguish "agent self-management" (bearer.agentId === args.target_agent) from "agent acting on a peer," and reject the latter. The narrower policy is better — agent-bound bearers reach the dispatcher exclusively through prompt-influenced flows.

**Asset: concurrency / state machine integrity**

37. **`claimNextPlanningRun` race not actually atomic.** Two pollers SELECT the same row; both UPDATE; SQLite serializes the UPDATEs but the wrong pattern (`UPDATE ... WHERE id=? AND status='planning'`) returns rowcount=1 to ONLY the first writer. If the implementation uses any other pattern (e.g. SELECT + UPDATE without `BEGIN IMMEDIATE`, or `UPDATE` without the `status='planning'` predicate), both writers may both win.

38. **Orphan recovery races with active poller mid-stream.** `recoverOrphanRuns` runs every boot AND (per Task C-10) every poller tick that exceeds the stale threshold. If a row's `worker_started_at` is older than threshold but the runner is genuinely mid-stream (slow provider, large context window), `recoverOrphanRuns` transitions it to `failed` while the runner is still streaming. The runner then writes `transitionRun(... completed)`, which throws `INVALID_RUN_TRANSITION` because the state machine forbids `failed → completed`. The stream's tokens are billed to the BYOK key; the row is `failed`; the partial comment is never posted; the operator sees a phantom failure.

39. **`incrementTokens` lost-update race.** Two concurrent `tokens` events from a parallel stream (Ollama emits multiple progress events; Anthropic's SDK fires updates on multiple boundaries) both read `frontmatter.tokens_in=100`, both write `=110` (each adding 10). The actual sum is 120; the row stores 110. Budget enforcement under-counts. Must be either single-stream-serial (only one ticker at a time per run) or atomic JSON-patch SQL (`UPDATE ... SET frontmatter = json_set(frontmatter, '$.tokens_in', json_extract(frontmatter, '$.tokens_in') + ?)`).

**Asset: crash recovery + error distinguishability**

40. **`worker_crash` indistinguishable from `provider_error` indistinguishable from explicit cancel.** All three end up as `status='failed'` with `error_reason=?`. If the error_reason taxonomy is collapsed or under-specified, operator triage is broken. Distinct values required: `worker_crash` (recovered orphan), `provider_error` (stream errored), `budget_exceeded` (token cap hit), `chain_guard` (fan-out/duration/chain-tokens cap hit), `rate_limited` (workspace or agent hourly cap), `cancel_requested` (DELETE /runs/:id — D), `cancel_via_comment` (kind=cancel comment — TBD).

41. **`worker_started_at` not cleared atomically with terminal status.** If `transitionRun(... completed)` writes `status='completed'` in one statement and `worker_started_at=null` in another (or doesn't clear it at all), an operator querying "rows where worker_started_at IS NOT NULL" sees completed-but-still-claimed rows. Worse: a future `recoverOrphanRuns` may try to "recover" a completed row because the clear was missed.

42. **Graceful-shutdown SIGTERM during in-flight runs.** Folio process catches SIGTERM, stops poller, but in-flight `runAgent` calls don't finish. The next boot's `recoverOrphanRuns` transitions them to `failed (worker_crash)` — operator-misleading because there was no crash. v1.1 deferral noted explicitly so reviewers don't re-litigate.

**Asset: approval / cancel flow**

43. **Approval-comment auth too permissive (v1 policy).** A `kind=plan` agent_run waits for a human's `## Approved` comment. v1 policy: any workspace member with `comments:write` on the parent can approve. This is intentional but it MUST be explicit and load-bearing — the threat model documents the policy so a future reviewer doesn't surface it as a finding. Role-gated approval is a v1.1 enhancement.

44. **Approval+rejection race on the same `awaiting_approval` run.** Member A posts approval, Member B posts rejection — simultaneously. The two trigger handlers race. The runner state machine forbids both `awaiting_approval → running` (resume) and `awaiting_approval → rejected` from happening once. Whichever comment's tx wins is the outcome; the loser's trigger handler must detect the state mismatch and no-op, not throw or duplicate.

45. **Cancel-via-comment signal source not yet decided.** Plan §4b mentions a "cancel check before each tool dispatch" but doesn't define the cancel signal. The options: (a) `kind=cancel` comment on the parent, (b) DELETE `/runs/:id` route (deferred to D-1), (c) explicit `agent_run.cancel_requested_at` column polled by the runner. Without a decision, the runner has nothing to check. Lock this in BEFORE C-8 runner implementation begins (this is known-unknown #4 from the readiness handoff).

**Asset: provider-health flag emission**

46. **`workspace.provider.degraded` emitted more than once on edge.** Mitigation requires once-on-tipping, once-on-recovery. If `transitionRun` calls `checkProviderHealth` after every terminal event without a "previous state" check, the third consecutive failure emits `degraded` and the fourth and fifth also re-emit. Operator dashboards spam.

47. **`workspace.provider.degraded` emitted with stale provider name on read.** `checkProviderHealth` reads the `provider` from the event payload. If the provider name in the payload is whatever the agent's frontmatter said at run-start AND the agent switched providers mid-window, the degraded flag binds to the wrong provider. (Per `[[plan-server-source-audit]]`: grep the whole code path for "provider:" in the agent_run event payload.)

**Asset: SSE delivery from runner-emitted events**

48. **SSE consumer backpressure blocks runner event emission.** B mitigation chain emits events synchronously inside `transitionRun`'s tx. If the SSE channel uses a bounded buffer with backpressure (the standard pattern), a slow SSE consumer (browser tab stuck on a giant comment thread) causes `emitEvent` to block, which holds the tx open, which stalls the runner. v1 needs fire-and-forget semantics on the SSE delivery side; the in-memory event bus already publishes to subscribers without awaiting them (per the Phase 2 bus impl), but the runner's specific call sites should not introduce new sync-await boundaries.

### Mitigations required (Sub-phase C)

Numbered 23–N, continuing the B sequence. Each mitigation is code-checkable.

23. **Documents-list path scope-check covers `type='agent_run'`.** No carve-out by type in the workspace+project scope predicate. The Sub-phase A partial indexes (`documents_runs_by_status_idx`, `_chain_idx`, `_assigned_idx`) preserve the existing `(workspace_id, project_id)` filter. Test (`apps/server/src/routes/documents.test.ts` + new `documents.runs-scope.test.ts`): one workspace's member querying `?type=agent_run` MUST NOT see another workspace's runs even when the SQL planner uses a partial index.

24. **`GET /documents?type=agent_run` narrows by agent allow-list.** When the caller is an agent-bound bearer with `frontmatter.projects` not containing `'*'`, the response filters to runs whose `project_id` is in the allow-list. Same narrowing pattern as B mitigation 22 (members) and B mitigation 11's F3 events narrowing. Test (`runs.list-narrowing.test.ts`): agent allow-listed to `[p1]` calling `?type=agent_run` against a workspace with runs in p1 AND p2 sees only p1 rows.

25. **No automatic `[[wiki-link]]` expansion in prompt construction for v1.** Sub-phase C's `runAgent` builds the LLM prompt from explicit message history (parent doc body, comment thread, kind=plan/approval comments — NOT auto-expanded wiki links). If a comment or doc body contains `[[other-doc]]`, the raw markdown reaches the LLM but the runner does NOT fetch and inline the linked doc's content server-side. The LLM may try to follow the link via a tool call (`get_document`), which then goes through the tool-scope + allow-list gates. This eliminates the server-side exfil vector. v1.1 reconsideration if usability suffers. Test (`runner.prompt-construction.test.ts`): a doc with `[[secret-doc]]` in its body produces a prompt containing literal `[[secret-doc]]` text, with no body of `secret-doc` inlined.

26. **`executeMcpTool` re-runs the tool's Zod schema before dispatch.** `lib/mcp-dispatch.ts` looks up the tool definition (which carries its Zod schema as a property) and calls `schema.parse(args)` (NOT `.passthrough()` — `.strict()` per `[[zod-strict-house-style]]`) BEFORE invoking the handler. Failed validation throws an `MCP_INVALID_ARGS` HTTPException with the Zod issues array, caught by the runner and persisted as `error_reason='mcp_invalid_args'` on the run row with `error_detail` containing the issue paths (NOT the values — paths only, to avoid leaking the bad input back into a readable surface). Test (`mcp-dispatch.zod.test.ts`): malformed args reach the dispatcher and the handler is NEVER invoked.

27. **Dispatcher distinguishes "agent self-management" from "agent acting on peer."** For tools `create_agent`/`update_agent`/`delete_agent`/`get_agent_self`, the dispatcher checks `authContext.token.agentId === args.agent_slug_or_id` (self-management OK) vs `authContext.token.agentId !== args.target_agent_slug_or_id` (acting on peer — REJECTED with `-32602 agent_self_management_only` error code). Human PATs were closed in B mitigation 19; this closes agent-bound bearers acting on peers via the runner. Test (`mcp-dispatch.agent-lifecycle.test.ts`): an agent-bound bearer for agent A calling `delete_agent(slug='B')` through `executeMcpTool` is rejected; calling `update_agent(slug='A')` is allowed.

28. **`agent_run.error_reason` is from a closed enum; `error_detail` is sanitized.** `error_reason` MUST be one of: `worker_crash | provider_error | budget_exceeded | chain_guard | rate_limited | cancel_requested | cancel_via_comment | mcp_invalid_args | mcp_tool_error | refusal | pause_turn`. The `agent_run_schema.ts` Zod schema enforces this (additions to the existing schema in Task C-1). The `error_detail` field, when present, passes through `sanitizeProviderError` (the B-mitigation-5 helper) — NEVER echoes raw SDK strings, NEVER echoes `baseUrl`/`model`/`apiKey`. Reviewer-checkable: grep for `errorDetail =` and `error_detail:` in the runner; every assignment goes through the sanitizer. Test (`agent-runs.error-sanitization.test.ts`): a simulated SDK error containing `apiKey:sk-abc123` and `baseUrl:https://attacker` lands in `error_detail` with both fragments stripped.

29. **`chain_id` is a UUIDv4 string (already enforced by `agent_run_schema.ts:71` — `z.string().uuid()`); fan-out cap is enforced at TWO places.** Mitigation pair:
    - At POLLER CLAIM TIME, before `claimNextPlanningRun` actually claims a row, the poller calls `checkChainGuards(chainId)` and skips the row (leaves it `planning`, increments a `chain_guard_blocked` counter) if fanout is at cap. (This is the new gate — the plan currently has `checkChainGuards` running at run-start; we move/duplicate it to claim-time.)
    - At RUN START, the runner re-checks `checkChainGuards` after claim but before the first provider stream (catches the case where another claim raced past the cap).
    - The cap (`FOLIO_MAX_FANOUT_PER_CHAIN`, default 25 per plan) is enforced BY COUNT not by depth — a row's `chain_id` is inherited from the trigger that fired it (via the `fired_by` chain extraction in `nextChainId`), so a 25-wide flat chain is identical to a 25-deep recursive one. Test (`runner.chain-fanout.test.ts`): a deliberate 30-agent loop produces exactly 25 runs at status `completed/failed`, 5 runs at status `failed` with `error_reason='chain_guard'`, and zero `running` rows lingering.

30. **Token budget enforced at three layers, all in agent-runs services + runner:**
    - **Per-run cap** (`agent.frontmatter.max_tokens_per_run`): checked in `runAgent` AFTER each `tokens` event. Exceeding → transition `failed` with `error_reason='budget_exceeded'`, abort provider stream via the existing AbortController on the stream call, post a partial-result comment with `kind=comment` describing the cap hit + what work completed before it.
    - **Per-chain cap** (`FOLIO_MAX_CHAIN_TOKENS`, default 1,000,000): checked in `checkChainGuards`, blocks at poller-claim-time (mitigation 29's pattern).
    - **Per-workspace + per-agent hourly cap**: `checkRunRateLimits`, called BEFORE `claimNextPlanningRun` (so a workspace at cap doesn't even claim, leaves rows `planning` for the next hour).
    - Test (`runner.budget-multilayer.test.ts`): budget-of-1 per-run scenario fires `failed budget_exceeded` after exactly 1 token; budget-of-1 per-chain fires `chain_guard` on the second sibling run; budget-of-1 per-hour blocks claim entirely.

31. **Provider circuit-breaker at poller-claim time.** When `checkProviderHealth(workspaceId, provider)` returns `degraded`, the poller skips claim of `agent_run` rows whose agent's provider is degraded; the rows stay `planning`. The next `agent.run.completed` for any agent on that provider (via a different workspace, or a manual retry) flips the workspace.provider.recovered edge, and pending runs resume claim. Test (`poller.circuit-breaker.test.ts`): seeded 3 consecutive `agent.run.failed provider_error` for `(workspace=w1, provider=anthropic)`, then a 4th planning row appears — poller does NOT claim it; after a manual `completed` event arrives, the same row IS claimed on the next tick.

32. **DNS-rebinding mid-stream is OUT of scope** — re-affirmed from B's deferral list. The B mitigation cached DNS resolution per request; the runner relies on the same per-fetch cache via Bun's underlying fetch impl. v1 residual risk.

33. **Per-workspace outbound concurrency fairness deferred to v1.1.** v1 enforces `FOLIO_POLLER_CONCURRENCY` (default 5) GLOBALLY across all workspaces. A runaway chain in workspace A can starve workspace B's runs. v1.1 splits the concurrency budget per-workspace via a workspace_id-aware semaphore. Documented here so reviewers don't surface it as a finding.

34. **`__echo` test tool is gated on `NODE_ENV === 'test'`** at registration time. `lib/mcp-dispatch.ts` registry initialization checks `process.env.NODE_ENV` and conditionally adds `__echo` only in test. Production calls to `executeMcpTool('__echo', ...)` return `-32601 method not found` (the standard MCP error for unknown tools — not a custom `TEST_TOOL_DISABLED` code, because the production registry simply doesn't know about it). Same pattern as B mitigation 16 (`__INTERNAL_TEST_ONLY__`). Test (`mcp-dispatch.test-tool-gating.test.ts`): with `NODE_ENV='production'`, the registry returns the standard not-found error.

35. **Dispatcher uses tx-first signature; runner owns the outer tx.** `executeMcpTool(name, args, authContext, tx)` accepts an optional `tx` parameter. The runner passes the tx it's holding for state-machine updates; the dispatcher passes that same tx to the tool handler. When the handler is `create_document`, the doc insert + event emit happen on the runner's tx. On runner failure post-dispatch, the tx rolls back atomically — no half-applied tool effect. When the runner does NOT hold a tx (the `runAgent` loop releases the tx between provider events to avoid blocking the DB), the dispatcher opens its own short-lived tx around the handler call. Tested via `mcp-dispatch.tx-scope.test.ts`: a handler that throws after a partial DB write leaves the runner's tx in a consistent rollback.

36. **`claimNextPlanningRun` uses a single UPDATE-with-status-predicate as the atomic claim.** SQL pattern:
    ```sql
    UPDATE documents
       SET frontmatter = json_set(frontmatter, '$.status', 'running', '$.worker_started_at', ?)
     WHERE id = (
       SELECT id FROM documents
        WHERE type = 'agent_run'
          AND json_extract(frontmatter, '$.status') = 'planning'
        ORDER BY created_at ASC
        LIMIT 1
     ) AND json_extract(frontmatter, '$.status') = 'planning'
    RETURNING *;
    ```
    The `AND ... = 'planning'` in the outer UPDATE WHERE is load-bearing — between the inner SELECT and the UPDATE, another claimer's COMMIT may have flipped the status. `RETURNING *` lets us distinguish row-claimed (1 row returned) from row-already-claimed (0 rows returned).

    **Transaction isolation note (plan-correction 2026-05-28, post-C.1 review).** An earlier draft of this mitigation wrapped the claim in `BEGIN IMMEDIATE`. The shipped implementation (`apps/server/src/services/agent-runs.ts::claimNextPlanningRun`) uses Drizzle's bun-sqlite `db.transaction(...)` default (DEFERRED). This is acceptable AS LONG AS the outer `AND status='planning'` predicate is preserved — that predicate is the load-bearing race guard, not the isolation level. SQLite's writer lock serializes the UPDATE statements; the predicate then ensures only one writer's UPDATE matches. Verified end-to-end by the 100-iteration race test at `agent-runs.test.ts::claimNextPlanningRun > exactly one of two concurrent claimers wins the same row`. v1 is single-process per CLAUDE.md — multi-process semantics are out of scope. If a future refactor introduces a SELECT-then-UPDATE pattern (e.g. richer preflight inside the claim tx), the new pattern MUST either re-derive the predicate guard or escalate to `BEGIN IMMEDIATE`; document the choice in the commit.

    Test (`agent-runs.claim-race.test.ts`): TWO Bun async functions race on `claimNextPlanningRun(tx1)` and `claimNextPlanningRun(tx2)` against the same DB; exactly one returns the row, the other returns null. Run 100 iterations to defeat scheduler luck. (Per `[[mock-the-wire-not-the-response]]`, this test does NOT mock the DB; it uses `makeTestApp()` with a real SQLite.)

37. **Orphan-recovery skips rows whose `worker_started_at` is fresh OR whose status is no longer `running`.** `recoverOrphanRuns(tx, {staleThresholdMs})` query:
    ```sql
    UPDATE documents
       SET frontmatter = json_set(frontmatter, '$.status', 'failed', '$.error_reason', 'worker_crash', '$.worker_started_at', NULL, '$.completed_at', ?)
     WHERE type = 'agent_run'
       AND json_extract(frontmatter, '$.status') = 'running'
       AND json_extract(frontmatter, '$.worker_started_at') < ?
    RETURNING id;
    ```
    The status predicate `= 'running'` is load-bearing — if a runner transitioned the row to `completed` between the recovery scan and the recovery write, the predicate excludes it. The runner's `transitionRun` MUST clear `worker_started_at` in the same UPDATE that flips status (mitigation 41). Test (`agent-runs.orphan-recovery.test.ts`): mid-flight scenario — seed a row at `running`, mid-stream, simulate a recovery scan; if the runner's transition-to-completed happens first, the recovery's UPDATE affects 0 rows; if the recovery's UPDATE happens first, the runner's `transitionRun(... completed)` throws `INVALID_RUN_TRANSITION { from: 'failed', to: 'completed' }` (caught + logged, not re-thrown, runner exits gracefully).

38. **`incrementTokens` uses atomic SQL JSON-patch.** Implementation:
    ```sql
    UPDATE documents
       SET frontmatter = json_set(
         frontmatter,
         '$.tokens_in',  COALESCE(json_extract(frontmatter, '$.tokens_in'),  0) + ?,
         '$.tokens_out', COALESCE(json_extract(frontmatter, '$.tokens_out'), 0) + ?
       )
     WHERE id = ?
     RETURNING json_extract(frontmatter, '$.tokens_in'), json_extract(frontmatter, '$.tokens_out');
    ```
    The COALESCE handles the initial-null case (row was just-created with no `tokens_in/out` keys yet). Test (`agent-runs.increment-tokens-race.test.ts`): two concurrent `incrementTokens(tx1, runId, {in:10, out:5})` and `incrementTokens(tx2, runId, {in:7, out:3})` end with `tokens_in=17, tokens_out=8`. Per `[[falsy-zero-bug-class]]`: incrementing by `0` is allowed (`incrementTokens(tx, runId, {in:0, out:0})` succeeds, no-op).

39. **Closed `error_reason` enum in `agent_run_schema.ts`** (extending the schema added in Sub-phase A). Values: `worker_crash | provider_error | budget_exceeded | chain_guard | rate_limited | cancel_requested | cancel_via_comment | mcp_invalid_args | mcp_tool_error | refusal | pause_turn`. The schema's Zod `.enum([...])` enforces this at every `transitionRun(... failed)` call site. Runner code paths that need to write `error_reason` import the enum's `.enum` accessor (`AgentRunErrorReason.enum.budget_exceeded`) — no string literals. Test (`agent-run-schema.error-reason.test.ts`): an unknown error_reason value throws Zod issue; every listed value parses.

40. **`transitionRun` writes status + worker_started_at clear in ONE UPDATE.** Already in the C-1 scope ("clears worker_started_at on terminal statuses") — make it explicit + atomic. The SQL is one `UPDATE documents SET frontmatter = json_set(frontmatter, '$.status', ?, '$.worker_started_at', NULL, ...)` statement. Test (`agent-runs.transition-atomic.test.ts`): after `transitionRun(tx, runId, { newStatus: 'completed' })`, reading the row in another tx shows both status=completed AND worker_started_at=null in a single read (no intermediate state observable).

41. **Graceful-shutdown SIGTERM handler is v1.1; v1 documents the residual.** v1 SIGTERM does NOT attempt to drain in-flight runners. In-flight rows stay `running`; next boot's `recoverOrphanRuns` transitions them to `failed worker_crash`. The audit-trail event distinguishes this from a real crash via... it doesn't — both look identical. Documented residual; reviewer should NOT surface it.

42. **v1 approval policy: any workspace member with `comments:write` on the parent can approve.** Documented explicitly. The runner accepts `## Approved` from any comment on the parent (per the existing kind=approval + the resume_of trigger handler in C-9). v1.1 may add a role-gate. Surfacing this as a finding in `/code-review` is incorrect — it's documented policy.

43. **Approval+rejection race resolution: first-COMMIT-wins, loser no-ops.** The trigger handlers for `kind=approval` and `kind=rejection` both call `transitionRun(awaiting_approval → running | rejected)` inside the comment-insert tx (per Sub-phase 2.6's transactional event emission pattern). The state machine's `isValidTransition` (from A-4) only allows `awaiting_approval → running` OR `awaiting_approval → rejected`, and only from that one source state. The loser's `transitionRun` throws `INVALID_RUN_TRANSITION { from: 'running'|'rejected', to: 'rejected'|'running' }`, the handler catches + logs + returns 200 to the comment-create call (the comment was still created — it's a comment after the fact). Test (`runner.approval-race.test.ts`): seeded race produces exactly one terminal state.

44. **Cancel-via-comment IS in scope; signal source is `kind=cancel` comment on the parent.** Lock this decision now (resolves known-unknown #4 from the readiness handoff). The runner's cancel check (before each tool dispatch + after each `tokens` event) reads the comment thread for the parent doc and looks for a `kind=cancel` comment with `created_at > run.started_at`. On cancel: transition `failed` with `error_reason='cancel_via_comment'`, abort the provider stream, post a final `kind=comment` from the agent ("Cancelled by user.") referencing the cancel comment's id. The HTTP DELETE `/runs/:id` route (Sub-phase D) emits a kind=cancel comment via the same path (so the runner has ONE check path, not two). Test (`runner.cancel-via-comment.test.ts`): mid-stream cancel comment causes the next cancel check to abort within ~1s.

45. **Tipping-edge detection on degraded/recovered emission.** `transitionRun`'s post-terminal hook calls `checkProviderHealth` and compares its return (`degraded | healthy`) against the previous result (cached on the workspace row OR queried from the events table). Only emit `workspace.provider.degraded` when transition is `healthy → degraded`; only emit `workspace.provider.recovered` when transition is `degraded → healthy`. No emission on `degraded → degraded` (continued failure) or `healthy → healthy` (normal). Cache key: `(workspace_id, provider_name)`; storage location: SQLite `workspaces.provider_health` JSON column (added in Task C-5's migration). Test (`provider-health.tipping-edge.test.ts`): 5 consecutive failures emit exactly 1 `degraded` event; 1 completed emits exactly 1 `recovered` event; subsequent failures emit nothing until next recovery.

46. **`workspace.provider.degraded` payload's `provider` field is sourced from the FAILED RUN'S agent.frontmatter.provider at run-start time** — captured into the `agent.run.failed` event payload, then `checkProviderHealth` reads it from that payload window. If the agent's provider changes between runs, the new provider's health is tracked separately. Test (`provider-health.provider-name-source.test.ts`): an agent that flips provider mid-window does NOT mis-attribute failures to the new provider.

47. **SSE event emission is fire-and-forget.** The existing in-memory event bus (Phase 2, `lib/event-bus.ts`) already publishes to subscribers without awaiting them. Sub-phase C does NOT introduce new `await` points on the SSE delivery path. `transitionRun`'s `emitEvent` call is sync (per existing convention). Test (`runner.sse-backpressure.test.ts`): a deliberately slow SSE subscriber (resolves its `onEvent` after 5s) does NOT block `transitionRun` from completing; `transitionRun` returns within the normal timing budget.

### Out of scope (Sub-phase C explicit deferrals)

- **Graceful SIGTERM drain.** v1 does not attempt to finish in-flight runs on shutdown. Reviewer should NOT surface as a finding (per mitigation 41).
- **Per-workspace outbound concurrency fairness.** v1 enforces global `FOLIO_POLLER_CONCURRENCY`; v1.1 splits per-workspace.
- **Per-tenant token-bucket rate limiting.** v1 uses hourly caps in `checkRunRateLimits`. v1.1 may move to a sliding-window or token-bucket.
- **Role-gated approval.** v1: any commenter with `comments:write` can approve. v1.1: agent frontmatter may carry an `approvers: ['email|role']` list.
- **DNS-rebinding mid-stream.** Re-affirmed from B's deferral list. Cached resolution per fetch is the limit.
- **Automatic `[[wiki-link]]` server-side expansion in prompts.** v1 keeps the literal wiki-link text in the prompt; the LLM must use tool calls to fetch link targets, going through scope + allow-list gates. Eliminates the server-side exfil vector for v1.
- **`agent_run` row body-content as a separate encrypted blob.** v1 stores run prompts + tool args in plaintext `documents.frontmatter`. Workspace boundaries protect cross-workspace access (mitigation 23+24); within-workspace exposure is acceptable v1.
- **Cancel via WebSocket / push notification.** v1 polls the comment thread for `kind=cancel` (per mitigation 44). Latency is ≤1 tool-dispatch interval.
- **Audit-log of every outbound provider request.** B deferred this; C re-affirms.
- **HTTP routes for runs (list, get, cancel, retry).** All in Sub-phase D. C's mitigation 44's cancel-via-comment is the only v1-C user-facing cancel.
- **MCP tools for runs (`list_runs`, `get_run`, `run_agent`, etc.).** All in Sub-phase D.

### Sub-phase C extension — how to use this section

- **Threat-model inheritance.** The 22 Sub-phase B mitigations (above) remain in force across all C code. The runner reading the encrypted `aiKeys` row trusts B mitigations 1–5 already validated the baseUrl, gated the persistence, sanitized error messages. The runner emitting `agent.run.failed` events trusts B mitigations 6, 9 already widened the schema for refusal/pause_turn and fixed falsy-zero token accumulators. Do NOT re-validate inputs B already validated; DO route runner-specific outputs through the B-sanitization helpers.
- **Controller pre-flight (per Sub-phase B retro Recommendation 1).** Before dispatching any Sub-phase C subagent task, the controller verifies the task's plan-supplied code touches at least the mitigations that bind on that task. Per-task mitigation pointers are added during each C.1/C.2/C.3 planning session.
- **`/code-review` invocation contract.** Each round on Sub-phase C MUST receive: "Verify code against the combined threat model in the plan (sections: `## Threat model` AND `## Threat model — Sub-phase C extension`). Mitigations 1–22 are inherited from B and remain in force; mitigations 23–47 are new for C. Report which are in place, which are missing, which are out of scope per the deferrals lists."
- **`/evaluate` retros for each of C.1, C.2, C.3.** Lists mitigations not implemented as plan-correction defects. New attack classes discovered during review trigger mitigation additions to this section (numbered 48+).
- **Round budget per C.1/C.2/C.3.** 2 medium-effort `/code-review` rounds per sub-sub-phase. Round 3 is a verification pass, not a discovery pass. If round 3 surfaces NEW critical attacks, this section was too shallow — pause and extend rather than fix-and-loop.
- **Downstream Sub-phase D.** D's HTTP + MCP-parity surface gets a SEPARATE threat-model extension at D-plan-write time. The attack classes are different (DELETE /runs/:id auth, MCP run-tools scope, admin-stats PII).

### Sub-phase C.1 — Services layer (expanded task bodies — written 2026-05-28)

> Sub-phase C is split into C.1 (services) / C.2 (runner+dispatcher) / C.3 (wiring+triggers) per `docs/superpowers/handoffs/2026-05-28-phase-3-sub-phase-C-readiness.md`. This section expands C-1..C-6 into the full Steps + Files + Tests + Commit form. C.2 and C.3 are expanded in separate plan-correction commits after C.1 closes.
>
> All tasks SEQUENTIAL (each appends to the same `services/agent-runs.ts` file). Dispatched via `superpowers:subagent-driven-development` wrapped by `netdust-core:ntdst-execute-with-tests` per the project CLAUDE.md contract. Each subagent's close-out invokes `netdust-core:testing-workflow` and reports the Test-evidence + STATUS blocks per the wrapper's mandatory addendum.
>
> **Per-task mitigation pointers** name the threat-model mitigations the task implements. `/code-review` after C.1 closes verifies these are in place; controller pre-flight before dispatch verifies the planned code touches them.
>
> **Pre-flight invariants for every C.1 task:**
> - `cd apps/server` — run all commands from the server app dir (never repo root — see `[[bun-test-from-repo-root-forbidden]]`).
> - Test runner: `bun test src/services/agent-runs.test.ts` (specific file) then `bun test` (full server suite).
> - Typecheck: `bun x tsc --noEmit -p .` (catches DocumentType-union drift).
> - Existing baseline at C.1 start: **server 716 / 1-skip / 0-fail, shared 51 / 0-fail, web 559 / 8-skip / 0-fail**. C.1 adds ~30 server tests; expected end-of-C.1 baseline: **server ~746 / 1-skip / 0-fail**.
> - Latent defect to fix in C-1: `DocumentType` in `apps/server/src/services/documents.ts:47` does NOT yet include `'agent_run'`. Migration 0012 widened the DB CHECK; the TS union lagged. C-1's first commit MUST extend the union (or the agent_run insert in C-1 will not typecheck).
>
> **Pre-flight verification (controller, before dispatching C-1):**
> 1. Confirm `runErrorReasonSchema` enum at `apps/server/src/lib/agent-run-schema.ts:13-26` already includes the 12 values referenced by mitigation 28 (`worker_crash, provider_error, budget_exceeded, fanout_exceeded, chain_duration_exceeded, chain_tokens_exceeded, rate_limited, cancelled, rejected, depth_exceeded, no_ai_key, idempotency_violation`). DO NOT add new values without amending the threat model.
> 2. Confirm `agentRunFrontmatterSchema` already has `chain_id: z.string().uuid()` at line 71 (mitigation 29 / known-unknown #2 — chain_id format is UUIDv4, lock confirmed).
> 3. Confirm `isValidTransition` at line 110 and `TRANSITIONS` map at line 101-108 — used by C-1's transitionRun.

---

#### Task C-1: `services/agent-runs.ts` — createRun + transitionRun + DocumentType extension

**Threat-model mitigations bound to this task:** 23 (workspace+project scope on agent_run rows — inherited via createDocument call), 28 (error_reason from closed enum + error_detail sanitized), 39 (closed enum already shipped — verify code uses `runErrorReasonSchema.enum.X` not string literals), 40 (transitionRun writes status + worker_started_at clear in ONE UPDATE). Inherits B mitigations 5 (sanitizeProviderError for error_detail), 11 (no requireSession concern — agent_run writes never originate from session-or-token routes in C.1; runner dispatches them in C.2).

**Files:**
- Modify: `apps/server/src/services/documents.ts:47` — extend `DocumentType` union to include `'agent_run'`.
- Create: `apps/server/src/services/agent-runs.ts`
- Create: `apps/server/src/services/agent-runs.test.ts`

**Acceptance criteria (the unit-test contract):**
- `createRun(tx, args)` inserts an agent_run document at status='planning', frontmatter populated, slug auto-generated as `<agentSlug>-<isoTimestamp>-<short-id>` (8-char nanoid suffix for collision-resistance), emits `agent.run.started` in the same tx, returns the inserted Document.
- `transitionRun(tx, runId, { newStatus, completedAt?, errorReason?, errorDetail? })`:
  - Loads the row; if not found → throw `HTTPException(404, { code: 'AGENT_RUN_NOT_FOUND' })`.
  - Calls `isValidTransition(fromStatus, newStatus)`; on false → throw `HTTPException(409, { code: 'INVALID_RUN_TRANSITION', from, to })`.
  - Updates `documents.frontmatter` via a SINGLE `json_set` UPDATE statement that flips `status`, sets `completed_at` IF terminal, clears `worker_started_at` IF terminal. Verifies the row's `frontmatter.status` AND `documents.status` (the column) stay in lockstep (Sub-phase A migration 0012 added the column; the service writes both).
  - When `errorReason` is provided, validates it via `runErrorReasonSchema.parse` (throws on unknown). When `errorDetail` is provided, runs it through `sanitizeProviderError(detail)` (mitigation 28 — re-use B's helper from `lib/ai/sanitize-error.ts`).
  - Emits `agent.run.<newStatus>` in the same tx via `emitEvent(tx, ...)`.

**Steps:**

- [ ] **Step 1 — Extend `DocumentType` union.**

  Edit `apps/server/src/services/documents.ts:47`:
  ```ts
  export type DocumentType = 'work_item' | 'page' | 'agent' | 'trigger' | 'agent_run';
  ```

  Run `bun x tsc --noEmit -p .` from `apps/server/`. Expected: clean. Existing call sites that match on `type` already handle defaults via discriminated-union or default-branch; this addition should be type-additive only. If any call site narrows on the existing 4-value union and breaks, write down which file:line and stop — that is a hidden assumption the plan needs to address before C-1 proceeds.

- [ ] **Step 2 — Write the failing test for createRun (happy path).**

  Create `apps/server/src/services/agent-runs.test.ts`:
  ```ts
  import { describe, expect, it } from 'bun:test';
  import { makeTestApp } from '../test/harness.ts';
  import { createRun } from './agent-runs.ts';

  describe('createRun', () => {
    it('inserts an agent_run document at status=planning and emits agent.run.started', async () => {
      const { db, seed } = await makeTestApp({ withAgent: true });
      const { workspace, project, agent } = seed;

      const result = await db.transaction(async (tx) => {
        return createRun(tx, {
          workspace,
          project,
          agent,
          actor: seed.user,
          input: {
            parentDocumentId: seed.workItem.id,
            firedBy: 'agent.task.assigned',
            chainId: crypto.randomUUID(),
            triggerId: null,
          },
        });
      });

      expect(result.document.type).toBe('agent_run');
      expect((result.document.frontmatter as any).status).toBe('planning');
      expect(result.document.slug).toMatch(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-[a-z0-9]{8}$/);

      const events = await db.query.events.findMany({ where: (e, { eq }) => eq(e.kind, 'agent.run.started') });
      expect(events).toHaveLength(1);
      expect(events[0].documentId).toBe(result.document.id);
    });
  });
  ```

  Run: `bun test src/services/agent-runs.test.ts`. Expected: FAIL with `Cannot find module './agent-runs.ts'`.

- [ ] **Step 3 — Create `services/agent-runs.ts` with the minimal createRun.**

  Create the file with the createRun function. Re-uses `services/documents.ts::createDocument` for the underlying insert (per the plan's "Reuses the existing documents service for the underlying insert + slug-uniqueness check"). Constructs the slug as `<agentSlug>-<isoTimestamp-with-dashes-not-colons>-<nanoid(8)>`. Frontmatter populated from args + `agent.frontmatter` (provider/model/system_prompt/max_tokens copied at run-start so a later agent edit doesn't mutate the historical run). Calls `agentRunFrontmatterSchema.parse(frontmatter)` before insert to fail fast on schema drift.

  Run: `bun test src/services/agent-runs.test.ts`. Expected: PASS.

- [ ] **Step 4 — Add failing tests for transitionRun (happy + state machine + atomic clear).**

  Append to the test file:
  - `it('transitions planning → running and emits agent.run.running')`
  - `it('throws INVALID_RUN_TRANSITION on illegal moves')` — assert `from`/`to` are present on the error
  - `it('clears worker_started_at on terminal status in one read')` — seed a row at running with worker_started_at set, transition to completed, read in a SECOND transaction, assert both `frontmatter.status === 'completed'` AND `frontmatter.worker_started_at` is cleared. (Plan-correction 2026-05-28, post-C.1 review: an earlier draft said `=== undefined`. The shipped implementation uses `json_set(..., '$.worker_started_at', NULL)` which round-trips as JSON null on read, not the `undefined` of a missing key. Either shape satisfies mitigation 40's goal — "no observable intermediate state where status=terminal AND worker_started_at is still set" — because both `null` and `undefined` are falsy in JS predicates. Test should use `toBeFalsy()` or `toBeNull()`, not `toBeUndefined()`.)
  - `it('rejects unknown error_reason via Zod')` — transitionRun(..., { errorReason: 'made_up_reason' }) throws
  - `it('runs error_detail through sanitizeProviderError')` — pass a detail containing `"apiKey:sk-abc123 baseUrl:https://attacker"`, verify the persisted `error_detail` has both fragments stripped (re-use the B sanitizer's test fixture)
  - `it('writes documents.status column and frontmatter.status in lockstep')` — assert both are equal after the UPDATE

  Run: `bun test src/services/agent-runs.test.ts`. Expected: 1 PASS (createRun), 6 FAIL (transitionRun cases).

- [ ] **Step 5 — Implement transitionRun.**

  Implementation outline:
  ```ts
  export async function transitionRun(
    tx: DBOrTx,
    runId: string,
    args: { newStatus: RunStatus; completedAt?: string; errorReason?: RunErrorReason; errorDetail?: string },
  ): Promise<Document> {
    const row = await tx.query.documents.findFirst({ where: (d, { eq, and }) => and(eq(d.id, runId), eq(d.type, 'agent_run')) });
    if (!row) throw new HTTPException(404, { message: 'agent_run not found', cause: { code: 'AGENT_RUN_NOT_FOUND' } });

    const from = (row.frontmatter as AgentRunFrontmatter).status;
    if (!isValidTransition(from, args.newStatus)) {
      throw new HTTPException(409, {
        message: `invalid transition ${from} → ${args.newStatus}`,
        cause: { code: 'INVALID_RUN_TRANSITION', from, to: args.newStatus },
      });
    }

    const isTerminal = TERMINAL_STATUSES.includes(args.newStatus);
    const errorReason = args.errorReason ? runErrorReasonSchema.parse(args.errorReason) : undefined;
    const errorDetail = args.errorDetail ? sanitizeProviderError(args.errorDetail) : undefined;

    // ONE UPDATE — status flip + completed_at + worker_started_at clear + error_reason/detail in a single json_set.
    await tx.update(documents)
      .set({
        status: args.newStatus,                                    // documents.status column
        frontmatter: sql`json_set(
          ${documents.frontmatter},
          '$.status', ${args.newStatus},
          '$.completed_at', ${isTerminal ? (args.completedAt ?? new Date().toISOString()) : null},
          '$.worker_started_at', ${isTerminal ? null : sql`json_extract(${documents.frontmatter}, '$.worker_started_at')`},
          '$.error_reason', ${errorReason ?? null},
          '$.error_detail', ${errorDetail ?? null}
        )`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(documents.id, runId));

    await emitEvent(tx, {
      kind: `agent.run.${args.newStatus}` as EventKind,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      documentId: row.id,
      actorEmail: null,           // C.2's runner will pass the agent's identity; transitionRun is dispatched by the runner
      payload: { from, to: args.newStatus, error_reason: errorReason ?? null },
    });

    const updated = await tx.query.documents.findFirst({ where: eq(documents.id, runId) });
    return updated!;
  }
  ```

  Imports: `documents, eq, sql` from drizzle + schema, `HTTPException` from hono, `runErrorReasonSchema, isValidTransition, TERMINAL_STATUSES, type RunStatus, type RunErrorReason, type AgentRunFrontmatter` from `../lib/agent-run-schema.ts`, `sanitizeProviderError` from `../lib/ai/sanitize-error.ts`, `emitEvent, type EventKind` from `../lib/event-bus.ts`.

  Run: `bun test src/services/agent-runs.test.ts`. Expected: ALL 7 PASS.

- [ ] **Step 6 — Add incrementTokens helper + test.**

  Tests (append):
  - `it('atomically increments tokens_in and tokens_out')` — call with `{ in: 10, out: 5 }` twice serially, assert final = `{ tokens_in: 20, tokens_out: 10 }`.
  - `it('handles increment-by-zero (no-op)')` — verify mitigation against `[[falsy-zero-bug-class]]`.
  - `it('initializes from zero when frontmatter has no tokens_in/out keys')` — seed an old row, COALESCE handles null.

  Implementation (atomic SQL JSON-patch per mitigation 38):
  ```ts
  export async function incrementTokens(
    tx: DBOrTx, runId: string, args: { in: number; out: number },
  ): Promise<{ tokens_in: number; tokens_out: number }> {
    await tx.update(documents)
      .set({
        frontmatter: sql`json_set(
          ${documents.frontmatter},
          '$.tokens_in',  COALESCE(json_extract(${documents.frontmatter}, '$.tokens_in'),  0) + ${args.in},
          '$.tokens_out', COALESCE(json_extract(${documents.frontmatter}, '$.tokens_out'), 0) + ${args.out}
        )`,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(documents.id, runId), eq(documents.type, 'agent_run')));

    const row = await tx.query.documents.findFirst({ where: eq(documents.id, runId) });
    const fm = row!.frontmatter as AgentRunFrontmatter;
    return { tokens_in: fm.tokens_in, tokens_out: fm.tokens_out };
  }
  ```

  Run: `bun test src/services/agent-runs.test.ts`. Expected: 10 PASS.

- [ ] **Step 7 — Run full server suite + typecheck.**

  ```
  bun test
  bun x tsc --noEmit -p .
  ```
  Expected: suite at 716 + 10 new = ~726, 0 fail. Typecheck clean. If `DocumentType`-narrowing breakage shows up in another file, fix at root (extend the narrow), do not paper over with a cast.

- [ ] **Step 8 — Invoke `netdust-core:testing-workflow` and report.**

  Per the ntdst-execute-with-tests addendum: invoke the Skill tool with `netdust-core:testing-workflow`, walk its task-complete checklist, then emit the Test-evidence + STATUS blocks at the end of the report.

- [ ] **Step 9 — Commit.**

  ```bash
  git add apps/server/src/services/agent-runs.ts apps/server/src/services/agent-runs.test.ts apps/server/src/services/documents.ts
  git commit -m "phase-3: C-1 services/agent-runs — createRun + transitionRun + incrementTokens

  - Extends DocumentType union with 'agent_run' (migration 0012 latent fix)
  - createRun inserts row via createDocument, auto-slug, emits agent.run.started
  - transitionRun: state machine guard, atomic status+worker_started_at clear,
    error_reason from closed enum, error_detail through sanitizeProviderError
  - incrementTokens: atomic SQL json_set, handles zero (no falsy-zero bug)

  Threat-model mitigations: 23, 28, 39, 40 (Sub-phase C extension).

  Suite: 716 → ~726, 0 fail. tsc clean.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

#### Task C-2: getActiveRun + getPendingApprovalRun + listRuns

**Threat-model mitigations bound to this task:** 23 (workspace+project scope predicates load-bearing on each query), 24 (listRuns narrows by agent allow-list when caller is project-narrowed agent-bound bearer). EXPLAIN test verifies `documents_runs_by_status_idx` from migration 0012 is the chosen plan.

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts`
- Modify: `apps/server/src/services/agent-runs.test.ts`

**Acceptance criteria:**
- `getActiveRun(tx, { parentId, agentSlug })` → most recent run on (parent, agent_slug) where status ∈ (planning, awaiting_approval, running). Null if none.
- `getPendingApprovalRun(tx, { parentId, agentSlug })` → same shape, status=awaiting_approval only.
- `listRuns(tx, filter)` → supports `{ workspaceId?, projectId?, parentId?, agentSlug?, status?, chainId?, since?, callerAgentProjectsAllowList? }`. When `callerAgentProjectsAllowList` is provided AND does not include `'*'`, narrows to rows whose `projectId` is in the allow-list. Empty allow-list returns empty array (mitigation 24).
- EXPLAIN QUERY PLAN on `getActiveRun` contains `documents_runs_by_status_idx`.

**Steps:**

- [ ] **Step 1 — Write failing tests.**

  Append 6 tests:
  - `getActiveRun returns most-recent non-terminal run`
  - `getActiveRun returns null when only terminal runs exist`
  - `getActiveRun returns null when no runs exist`
  - `getPendingApprovalRun returns the awaiting_approval row only`
  - `listRuns narrows by callerAgentProjectsAllowList` (mitigation 24): seed runs in p1 and p2, call with `{ callerAgentProjectsAllowList: ['p1-id'] }`, assert only p1 rows return; call with `['*']` → all return; call with `[]` → empty array.
  - `EXPLAIN QUERY PLAN of getActiveRun uses documents_runs_by_status_idx` — run `tx.run(sql\`EXPLAIN QUERY PLAN <getActiveRun's query>\`)` and assert the result.detail strings include the index name.

  Run: `bun test src/services/agent-runs.test.ts`. Expected: FAIL on the 6 new cases.

- [ ] **Step 2 — Implement.**

  ```ts
  export async function getActiveRun(tx: DBOrTx, args: { parentId: string; agentSlug: string }) {
    return tx.query.documents.findFirst({
      where: (d, { and, eq, inArray, sql }) => and(
        eq(d.type, 'agent_run'),
        sql`json_extract(${d.frontmatter}, '$.parent_id') = ${args.parentId}`,
        sql`json_extract(${d.frontmatter}, '$.agent_slug') = ${args.agentSlug}`,
        inArray(sql`json_extract(${d.frontmatter}, '$.status')`, ['planning', 'awaiting_approval', 'running']),
      ),
      orderBy: (d, { desc }) => desc(d.createdAt),
    });
  }
  ```

  Similar shape for getPendingApprovalRun and listRuns. Allow-list narrowing in listRuns: when `callerAgentProjectsAllowList` provided + does not contain `'*'`, add an `inArray(documents.projectId, [...allowList])` predicate. When the list is empty (`[]`), short-circuit with an empty return — don't issue a SQL query with `WHERE projectId IN ()` (SQLite parse error in some drivers).

  Run: `bun test src/services/agent-runs.test.ts`. Expected: ALL PASS.

- [ ] **Step 3 — Full suite + typecheck + workflow invocation + commit.**

  As C-1 Steps 7-9. Suite: ~726 → ~732. Commit message: `phase-3: C-2 services/agent-runs — getActiveRun + listRuns with allow-list narrowing`. Mitigations: 23, 24.

---

#### Task C-3: claimNextPlanningRun + recoverOrphanRuns + countPendingPlanning

**Threat-model mitigations bound to this task:** 36 (BEGIN IMMEDIATE + UPDATE-with-status-predicate atomic claim), 37 (recoverOrphanRuns guards on status='running' AND worker_started_at < threshold; doesn't recover transitioned rows). Mitigation 31 (provider circuit-breaker) is C-5's call site but tests the foundation here.

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts`
- Modify: `apps/server/src/services/agent-runs.test.ts`

**Acceptance criteria:**
- `claimNextPlanningRun(tx)` → atomic find-and-claim per mitigation 36's SQL pattern. Returns claimed row or null. Two concurrent callers MUST yield exactly one winner.
- `recoverOrphanRuns(tx, { staleThresholdMs })` → per mitigation 37's SQL. Returns array of recovered run ids. Skips rows whose worker_started_at is fresh OR status != 'running'.
- `countPendingPlanning(tx)` → returns `count(*)` of status=planning agent_run rows.

**Steps:**

- [ ] **Step 1 — Write failing tests including the race test.**

  Append 7 tests:
  - `claimNextPlanningRun returns null when no planning rows exist`
  - `claimNextPlanningRun claims oldest planning row by created_at ASC, sets status=running + worker_started_at`
  - `claimNextPlanningRun is atomic under concurrent callers (race test)` — per mitigation 36 + the `[[mock-the-wire-not-the-response]]` rule + `[[verify-subagent-test-counts]]`:
    ```ts
    it('exactly one of two concurrent claimers wins the same row (race test, 100 iterations)', async () => {
      const { db, seed } = await makeTestApp({ withAgent: true });
      for (let i = 0; i < 100; i++) {
        // Seed exactly one planning row per iteration
        await db.transaction(async (tx) => createRun(tx, { /* ... */ }));
        const [a, b] = await Promise.all([
          db.transaction(async (tx) => claimNextPlanningRun(tx)),
          db.transaction(async (tx) => claimNextPlanningRun(tx)),
        ]);
        // Exactly one is non-null
        const winners = [a, b].filter(Boolean);
        expect(winners).toHaveLength(1);
        // Cleanup for next iteration
        await db.transaction(async (tx) => transitionRun(tx, winners[0]!.id, { newStatus: 'failed', errorReason: 'cancelled' }));
      }
    });
    ```
  - `recoverOrphanRuns recovers rows with worker_started_at older than threshold`
  - `recoverOrphanRuns skips rows with fresh worker_started_at`
  - `recoverOrphanRuns skips rows whose status is no longer running` — seed a row at running with stale worker_started_at, then transition it to completed in a separate tx, then call recoverOrphanRuns; assert 0 rows recovered (mitigation 37's status='running' predicate is load-bearing).
  - `countPendingPlanning returns count of status=planning rows`

  Run: `bun test src/services/agent-runs.test.ts`. Expected: 7 new FAIL.

- [ ] **Step 2 — Implement.**

  `claimNextPlanningRun`:
  ```ts
  export async function claimNextPlanningRun(tx: DBOrTx): Promise<Document | null> {
    // BEGIN IMMEDIATE is implicit on the outer transaction in better-sqlite3 / bun:sqlite,
    // BUT we need to ensure the caller passes a tx (not the bare db). Assert.
    const claimedAt = new Date().toISOString();
    const result = tx.all(sql`
      UPDATE documents
         SET frontmatter = json_set(
               frontmatter,
               '$.status', 'running',
               '$.worker_started_at', ${claimedAt}
             ),
             status = 'running',
             updated_at = ${claimedAt}
       WHERE id = (
         SELECT id FROM documents
          WHERE type = 'agent_run'
            AND json_extract(frontmatter, '$.status') = 'planning'
          ORDER BY created_at ASC
          LIMIT 1
       )
       AND json_extract(frontmatter, '$.status') = 'planning'
       RETURNING *
    `);
    return (result[0] as Document | undefined) ?? null;
  }
  ```

  `recoverOrphanRuns`:
  ```ts
  export async function recoverOrphanRuns(
    tx: DBOrTx, args: { staleThresholdMs: number },
  ): Promise<string[]> {
    const threshold = new Date(Date.now() - args.staleThresholdMs).toISOString();
    const completedAt = new Date().toISOString();
    const rows = tx.all(sql`
      UPDATE documents
         SET frontmatter = json_set(
               frontmatter,
               '$.status', 'failed',
               '$.error_reason', 'worker_crash',
               '$.worker_started_at', NULL,
               '$.completed_at', ${completedAt}
             ),
             status = 'failed',
             updated_at = ${completedAt}
       WHERE type = 'agent_run'
         AND json_extract(frontmatter, '$.status') = 'running'
         AND json_extract(frontmatter, '$.worker_started_at') < ${threshold}
       RETURNING id
    `) as Array<{ id: string }>;

    // Emit agent.run.failed for each recovered row — per Sub-phase A event contract.
    for (const r of rows) {
      const row = await tx.query.documents.findFirst({ where: eq(documents.id, r.id) });
      if (row) await emitEvent(tx, {
        kind: 'agent.run.failed',
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        documentId: row.id,
        actorEmail: null,
        payload: { error_reason: 'worker_crash' },
      });
    }
    return rows.map(r => r.id);
  }
  ```

  `countPendingPlanning`:
  ```ts
  export async function countPendingPlanning(tx: DBOrTx): Promise<number> {
    const [{ count }] = tx.all(sql`
      SELECT COUNT(*) as count FROM documents
       WHERE type = 'agent_run'
         AND json_extract(frontmatter, '$.status') = 'planning'
    `) as Array<{ count: number }>;
    return count;
  }
  ```

  Run: `bun test src/services/agent-runs.test.ts`. Expected: ALL PASS. The race test in particular MUST pass — if it fails even once across 100 iterations, mitigation 36 is broken and the implementation needs the `BEGIN IMMEDIATE` raised explicitly via `db.exec('BEGIN IMMEDIATE')` rather than relying on Drizzle's default.

- [ ] **Step 3 — Full suite + typecheck + workflow invocation + commit.**

  As before. Suite: ~732 → ~739. Commit: `phase-3: C-3 services/agent-runs — atomic claim + orphan recovery + count`. Mitigations: 36, 37.

---

#### Task C-4: checkRunRateLimits + checkChainGuards (with volume test)

**Threat-model mitigations bound to this task:** 29 (chain fan-out cap, enforced at TWO call sites — checkChainGuards is the implementation; mitigation 29's poller-claim-time call is C-7/C-10's work), 30 (per-workspace + per-agent hourly rate-limit math). Also implements `[[mock-the-wire-not-the-response]]` (real DB seeding, no stubbed return values) and the Phase 3 review remark #3 volume test (EXPLAIN-QUERY-PLAN guard against future planner regressions).

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts`
- Modify: `apps/server/src/services/agent-runs.test.ts`

**Acceptance criteria:**
- `checkRunRateLimits(tx, { workspaceId, agentSlug, agentMaxRunsPerHour, workspaceMaxRunsPerHour })` → counts agent.run.started events in the last hour for the (workspace, agent_slug) AND for the workspace overall. Returns `{ ok: true }` or `{ ok: false, reason: 'rate_limited', detail: 'workspace cap N/hour exceeded' | 'agent cap N/hour exceeded' }`. Defaults: workspace 200, agent 60 (env: `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE`, `FOLIO_MAX_RUNS_PER_HOUR_PER_AGENT`).
- `checkChainGuards(tx, { chainId, maxFanout, maxChainDurationMs, maxChainTokens })` → single SELECT against `documents_runs_by_chain_idx` aggregating `count(*)`, `max(completed_at) - min(started_at)`, `sum(tokens_in + tokens_out)`. Returns first-failing reason: `'fanout_exceeded' | 'chain_duration_exceeded' | 'chain_tokens_exceeded' | null` (with detail). Defaults: 25 / 30 min / 1,000,000 tokens (env: `FOLIO_MAX_FANOUT_PER_CHAIN`, `FOLIO_MAX_CHAIN_DURATION_MS`, `FOLIO_MAX_CHAIN_TOKENS`).
- Volume test verifies EXPLAIN QUERY PLAN uses `documents_runs_by_chain_idx`.

**Steps:**

- [ ] **Step 1 — Write failing tests.**

  Append:
  - `checkRunRateLimits returns ok when under both caps`
  - `checkRunRateLimits returns rate_limited (workspace) when workspace cap hit`
  - `checkRunRateLimits returns rate_limited (agent) when agent cap hit`
  - `checkRunRateLimits prefers workspace failure when both caps hit` (deterministic ordering)
  - `checkChainGuards returns ok under all caps`
  - `checkChainGuards returns fanout_exceeded when count > maxFanout`
  - `checkChainGuards returns chain_duration_exceeded when duration > max`
  - `checkChainGuards returns chain_tokens_exceeded when sum > max`
  - `checkChainGuards prefers first-failing reason (fanout) when multiple caps hit`
  - VOLUME test:
    ```ts
    it.skipIf(process.env.FOLIO_SKIP_VOLUME_TESTS === '1')(
      'EXPLAIN QUERY PLAN for checkChainGuards uses documents_runs_by_chain_idx', async () => {
        const { db, seed } = await makeTestApp({ withAgent: true });
        // Insert 10,000 synthetic agent_run rows spread across ~500 chain_ids
        // Use raw SQL for speed; createRun is too slow for bulk insert.
        // ... bulk insert ...
        const plan = db.all(sql`EXPLAIN QUERY PLAN <the checkChainGuards query>`);
        const planStr = JSON.stringify(plan);
        expect(planStr).toContain('documents_runs_by_chain_idx');
      },
    );
    ```

- [ ] **Step 2 — Implement.**

  Both functions query the events table (`agent.run.started`) for the rate-limit and the documents table (filtered by chain_id) for the chain guards. The chain-guard query MUST be a single SELECT with `count(*) AS fanout, (max - min) AS duration_ms, sum(...) AS tokens` so the EXPLAIN-plan check holds.

  Run: `bun test src/services/agent-runs.test.ts`. Expected: ALL PASS.

- [ ] **Step 3 — Full suite + typecheck + workflow invocation + commit.**

  Suite: ~739 → ~749. Commit: `phase-3: C-4 services/agent-runs — rate limits + chain guards + EXPLAIN-plan volume test`. Mitigations: 29, 30 (partial — full enforcement at runner/poller in C.2/C.3).

---

#### Task C-5: checkProviderHealth + getProviderHealth + tipping-edge wiring

**Threat-model mitigations bound to this task:** 45 (tipping-edge detection — emit degraded/recovered exactly once per transition, never on continued state), 46 (provider name sourced from the failed run's payload, NOT current agent state), 47 (SSE delivery fire-and-forget — assert no new awaits introduced).

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts`
- Modify: `apps/server/src/services/agent-runs.test.ts`
- Modify: `apps/server/src/services/workspaces.ts` (read/write `workspaces.provider_health` JSON column — see Step 0 for migration).
- Create: `apps/server/src/db/migrations/0013_workspace_provider_health.sql` + matching `meta/_journal.json` update (per `[[drizzle-migration-journal]]`).

**Acceptance criteria:**
- New migration 0013 adds `provider_health JSON DEFAULT '{}'` to `workspaces`. Migration entry added to `meta/_journal.json` (the journal-fail will catch this if missed — already gated by pre-commit hook from A-4b).
- `checkProviderHealth(tx, { workspaceId, provider })` → reads workspaces.provider_health[provider] = { status: 'healthy' | 'degraded', consecutiveFailures: number }. Default `{ healthy, 0 }` when missing. Returns the current state plus what the new state would be after the most recent N events (configurable via `FOLIO_PROVIDER_DEGRADE_THRESHOLD`, default 3). Algorithm: walk the last N `agent.run.completed | failed` events for (workspace, provider), exclude `error_reason: 'cancelled'`; if all N are failures with `error_reason: 'provider_error'` → new state degraded.
- `getProviderHealth(tx, { workspaceId })` → returns `{ anthropic, openai, ollama, openrouter }` each shaped as above. Default for missing providers: `{ status: 'healthy', consecutiveFailures: 0 }`.
- A new internal helper `maybeEmitProviderHealthEdge(tx, { workspaceId, provider })` is called from `transitionRun` AFTER its own emitEvent. It computes the tipping edge (mitigation 45):
  - Reads current `workspaces.provider_health[provider]` (old state).
  - Runs `checkProviderHealth` to derive new state.
  - If `old.status === 'healthy' && new.status === 'degraded'` → write new state + emit `workspace.provider.degraded` (once).
  - If `old.status === 'degraded' && new.status === 'healthy'` → write new state + emit `workspace.provider.recovered` (once).
  - Else → no-op (continued state).
- The provider name in the `workspace.provider.degraded` payload comes from the FAILED RUN'S frontmatter.provider (mitigation 46), not current agent state. transitionRun reads the row's frontmatter (already loaded), extracts `frontmatter.provider`, passes to maybeEmitProviderHealthEdge.

**Steps:**

- [ ] **Step 1 — Write migration 0013 + update journal.**

  Create `apps/server/src/db/migrations/0013_workspace_provider_health.sql`:
  ```sql
  ALTER TABLE workspaces ADD COLUMN provider_health JSON DEFAULT '{}' NOT NULL;
  ```

  Update `apps/server/src/db/migrations/meta/_journal.json` — add the entry per `[[drizzle-migration-journal]]`. Pre-commit hook from A-4b will refuse to commit if the journal is not updated.

  Update the Drizzle schema in `apps/server/src/db/schema.ts` to expose `providerHealth: text('provider_health', { mode: 'json' }).$type<Record<string, { status: 'healthy' | 'degraded'; consecutive_failures: number }>>().notNull().default(sql\`('{}')\`)`.

- [ ] **Step 2 — Write failing tests.**

  Append:
  - `checkProviderHealth returns healthy with 0 failures when no events exist`
  - `checkProviderHealth returns degraded after 3 consecutive provider_error failures` (tipping edge)
  - `checkProviderHealth excludes cancelled error_reason from the window`
  - `checkProviderHealth resets to healthy on a single completed event after failures`
  - `getProviderHealth returns all 4 providers with sensible defaults`
  - `maybeEmitProviderHealthEdge emits degraded exactly once on tipping edge` — 3 failures, assert exactly 1 `workspace.provider.degraded` event; a 4th failure emits NOTHING new.
  - `maybeEmitProviderHealthEdge emits recovered exactly once on recovery edge` — after degraded state, one completed event emits exactly 1 `workspace.provider.recovered`.
  - `maybeEmitProviderHealthEdge uses provider from run frontmatter, not current agent state` — seed an agent with provider=anthropic, change the agent's provider to openai mid-window (simulate), then fire a failure; assert the degraded event payload says `provider: 'anthropic'` (the run's recorded provider).
  - `maybeEmitProviderHealthEdge keeps SSE delivery fire-and-forget` — register a slow event-bus subscriber (resolves after 1s), assert transitionRun + tipping edge complete in < 100ms.

- [ ] **Step 3 — Implement.**

  Wire `maybeEmitProviderHealthEdge` into transitionRun's terminal-status branch. Update workspaces.provider_health in the same tx (one UPDATE on the workspaces row inside the same tx as the agent_run UPDATE).

  Run: `bun test src/services/agent-runs.test.ts`. Expected: ALL PASS.

- [ ] **Step 4 — Full suite + typecheck + workflow invocation + commit.**

  Suite: ~749 → ~758. Commit: `phase-3: C-5 services/agent-runs — provider health + tipping-edge emission`. Mitigations: 45, 46, 47.

---

#### Task C-6: ensureRunsTable (lazy seed) + chain_id helper

**Threat-model mitigations bound to this task:** 23 (lazy-seed creates a runs table per project; the table inherits workspace+project scope from the existing tables service — verify). Locks chain_id format (known-unknown #2) by enforcing UUIDv4 in `nextChainId` via `crypto.randomUUID()`.

**Files:**
- Modify: `apps/server/src/services/agent-runs.ts`
- Modify: `apps/server/src/services/agent-runs.test.ts`

**Acceptance criteria:**
- `ensureRunsTable(tx, { workspaceId, projectId })` → if a `runs` table exists for this project, returns it. Else creates within the same tx: inserts `tables` row, inserts 6 `statuses` (planning, awaiting_approval, running, completed, failed, rejected), inserts 3 `views` (`All runs`, `Failures`, `Awaiting approval`), emits `table.created` + 6× `status.created` + 3× `view.created` + 1× `runs_table.lazy_seeded`. Idempotent (second call returns the same table id, no duplicate inserts, no duplicate events).
- `nextChainId({ firedBy }: { firedBy: string }): string` → if `firedBy` matches the pattern `chain:<uuid>:...`, returns the UUID portion. Else mints fresh `crypto.randomUUID()`. Guaranteed to return a UUIDv4 string that satisfies `z.string().uuid()` (per mitigation 29).

**Steps:**

- [ ] **Step 1 — Write failing tests.**

  Append:
  - `ensureRunsTable creates a runs table on first call with 6 statuses + 3 views`
  - `ensureRunsTable is idempotent: second call returns the same id, no duplicate events`
  - `ensureRunsTable emits runs_table.lazy_seeded exactly once on create`
  - `nextChainId mints a new UUIDv4 when firedBy has no chain prefix`
  - `nextChainId extracts the UUID from firedBy when present`
  - `nextChainId result always satisfies agentRunFrontmatterSchema.chain_id` (z.string().uuid() compatibility test)

- [ ] **Step 2 — Implement.**

  Re-uses `services/tables.ts::createTable`, `services/statuses.ts::createStatus`, `services/views.ts::createView` for the per-row inserts. Idempotency keyed on `(workspaceId, projectId, slug='runs')`.

  Run: `bun test src/services/agent-runs.test.ts`. Expected: ALL PASS.

- [ ] **Step 3 — Full suite + typecheck + workflow invocation + commit.**

  Suite: ~758 → ~764. Commit: `phase-3: C-6 services/agent-runs — lazy runs-table seed + chain_id helper`. Mitigations: 23 (verified inherited), 29 (chain_id format locked).

---

#### Sub-phase C.1 close-out (controller, not subagents)

After C-6 commits:

- [ ] **/integration gate.**
  ```bash
  cd apps/server && bun test
  cd apps/server && bun x tsc --noEmit -p .
  cd ../web && bun run test    # unchanged baseline expected (no web changes in C.1)
  cd ../../packages/shared && bun test
  ```
  Expected: server ~764 / 1-skip / 0-fail, web 559 / 8-skip / 0-fail, shared 51 / 0-fail. Place `.last-integration` marker at HEAD.

- [ ] **/code-review (medium effort, --base=c2796e9).** The base is the threat-model-extension commit; review compares only C.1's diff. Reviewer prompt MUST include:

  > "Verify code against the threat model in the plan (sections: `## Threat model` AND `## Threat model — Sub-phase C extension`). Mitigations 23, 24, 28, 29 (chain_id format), 36, 37, 38, 39 (closed enum usage), 40, 45, 46, 47 are bound to Sub-phase C.1. Report which are in place, which are missing, which are out of scope per the deferrals lists. Round budget: 2 medium-effort rounds (per readiness handoff §How to use)."

- [ ] **/evaluate (retro).** If any mitigations are missing OR new attack classes surfaced, plan-correct the threat model FIRST (extend to mitigation 48+), then fix the code.

- [ ] **Plan-correction commit: expand C.2 (runner + dispatcher) task bodies.** Following the same per-task format as C.1 above, with per-task mitigation pointers into the C-extension threat model.

---

### Locked decisions (resolves known-unknowns from the readiness handoff)

The threat model resolves 5 of the 8 readiness-handoff known-unknowns by making concrete choices:

1. **Tool-call args parsing**: dispatcher re-runs Zod BEFORE handler dispatch (mitigation 26). Handler never sees malformed args.
2. **`chain_id` format**: UUIDv4 string (`z.string().uuid()`) — already enforced by `agent_run_schema.ts:71`. The `nextChainId({firedBy})` helper extracts a UUIDv4 from `fired_by` or mints fresh. No hierarchical format. Aggregation is purely by `chain_id` equality + cap counters.
3. **Token accounting boundaries**: per-run (runner loop after `tokens` events), per-chain (poller claim-time + runner start), per-workspace + per-agent hourly (poller pre-claim). Four checks, three call sites (mitigation 30).
4. **`kind=cancel` IS the cancel signal**: locked in mitigation 44. DELETE /runs/:id (Sub-phase D) emits a kind=cancel comment via the same path; runner has ONE check.
5. **`worker_started_at` cleared atomically with terminal status**: mitigation 40 + 41. One UPDATE statement covers both transitions; orphan recovery uses the status predicate as the second gate.

The remaining 3 known-unknowns are resolved by mitigations elsewhere:

6. **MCP dispatcher tx scope**: tx-first signature (mitigation 35). Runner passes tx; dispatcher reuses it.
7. **SSE consumer backpressure**: fire-and-forget per Phase 2's existing event bus contract (mitigation 47). No new await points in C.
8. **Token budget overflow handling**: cancel provider stream via existing AbortController, persist `error_reason='budget_exceeded'`, post partial-result comment (mitigation 30, per-run branch).

---

## Testing-workflow contract (do not violate)

This branch is executed under `netdust-core:ntdst-execute-with-tests`, which wraps `superpowers:subagent-driven-development` with mandatory testing gates. The harness expects:

**Subagent (per task) — runs UNIT tests:**

Every code-touching task ends with the SAME closing block. No exceptions, no task-specific variation:

1. **Write the failing test FIRST** (RED). Run only that test file. Confirm fail message.
2. **Write minimal code to pass** (GREEN).
3. **Re-run that test file** → PASS.
4. **Re-run the entire affected app's unit suite** — `cd apps/server && bun test` for server tasks, `cd apps/web && bun run test` for web tasks, `cd packages/shared && bun test` for shared. Expect: prior count + delta from this task, 0-fail. If anything regresses, STOP — do not commit.
5. **Type-check the affected app** — `cd apps/server && bun x tsc --noEmit` for server, `cd apps/web && bun x tsc --noEmit` for web. Required by testing-workflow's task-complete checklist ("Static analysis clean on changed files"). Touch-files-only is acceptable for speed if the full project check is too slow.
6. **Verify subagent test counts from the controller** per `[[verify-subagent-test-counts]]`. Subagents have misreported 3+ times in prior phases. The controller re-runs the same command after the subagent reports.
7. **Commit atomically.** Conventional message: `phase-3: <what> (<task-id>)` per CLAUDE.md.

**Mandatory subagent invocation language (verbatim, from `netdust-core:ntdst-execute-with-tests`):**

Every dispatch prompt to a subagent MUST end with this block, copy-pasted as-is:

> Before reporting this task complete, you MUST invoke `Skill("netdust-core:testing-workflow")` via the Skill tool and complete its task-complete checklist. A task without unit tests is not done. Do not report success without invoking the skill.
>
> Your final message MUST end with this block, verbatim:
>
> ```
> ## Test evidence
> - Test file(s): <path1>, <path2>
> - RED proof: <command> → <fail snippet, 1-3 lines>
> - GREEN proof: <command> → <pass snippet, 1-3 lines>
> - Suite delta: <app> was <N>, now <M>, <K> fails
> - Typecheck: <command> → <status>
> ```
>
> Missing any of these = task not done. Do not rationalize.

The wrapping skill is explicit that **invocation is what makes the gate auditable**, not just running the tests. The SubagentStop hook in `netdust-core` is meant to detect missing invocations and surface reminders — that is a backstop, not the primary mechanism. The dispatch prompt is the primary mechanism. Without the invocation line, the discipline reverts to "trust the implementer," which is the failure mode the wrapping skill exists to prevent.

**Rules that apply to ALL tasks:**

- **`bun test` from repo root is FORBIDDEN** — mixes Vitest into Bun's runner → false fails. Server tests from `apps/server`, web tests from `apps/web` (via `bun run test`), shared from `packages/shared`.
- **Migration tasks update `_journal.json`** in the same commit per `[[drizzle-migration-journal]]`. Drizzle's `migrate()` silently skips files not in the journal, so a missing entry is invisible until production.
- **`list-view-create.test.tsx` is a known flake** under high-concurrency full-suite runs per `[[known-test-flakes]]`. Rerun once before treating it as a regression.

**Controller (per sub-phase boundary) — runs INTEGRATION tests:**

At each sub-phase boundary (A→B, B→C, C→D, D→E, E→F) — i.e. inside the integration-gate task at the end of each sub-phase (A-5, B-8, C-13, D-8, E-9):

- Run `netdust-core:integration` skill → unit + integration + acceptance + type-check across both apps.
- For Sub-phase E and later: also run the Playwright e2e suite (`cd apps/web && bun run e2e`).
- Re-confirm the known flake noted above.

**Controller (branch close — Sub-phase F):**

- `netdust-core:shakeout` → re-runs integration first (defense in depth), then Playwright, then invokes the shake-out skill, then auto-dispatches 4 reviewer agents in parallel on the full branch diff.
- `superpowers:requesting-code-review` with `--effort=high --comment` for the inline PR pass.
- `superpowers:finishing-a-development-branch` to merge `--no-ff` into main.

---

## Sub-phase A — Foundation

Goal: make every later sub-phase able to insert and read `agent_run` rows with confidence. By end of A: migrations applied, Zod schema importable, state-machine helper unit-tested, new event kinds in the shared module, builtin triggers flipped — and the dev DB auto-migrates on boot so no future task gets bitten by the same outage the handoff documented.

### Task A-0: Auto-migrate on boot

> **Why first.** The handoff (2026-05-27 evening) records a long debugging detour caused by the dev DB being stuck at migration 0006 while the code expected 0011. Per `[[migrations-first-when-routes-look-broken]]`. Sub-phase A is about to ship migration 0012 — without auto-migrate, anyone pulling this branch will hit the same trap.

**Files:**
- Create: `apps/server/src/db/auto-migrate.ts`
- Create: `apps/server/src/db/auto-migrate.test.ts`
- Modify: `apps/server/src/index.ts:1-22`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/db/auto-migrate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { runMigrationsOnBoot } from './auto-migrate.ts';

describe('runMigrationsOnBoot', () => {
  test('applies all migrations to a fresh DB and is idempotent on second call', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    runMigrationsOnBoot(db);

    const count1 = sqlite
      .prepare(`SELECT COUNT(*) as n FROM __drizzle_migrations`)
      .get() as { n: number };
    expect(count1.n).toBeGreaterThan(0);

    runMigrationsOnBoot(db); // second call must not throw or re-run anything
    const count2 = sqlite
      .prepare(`SELECT COUNT(*) as n FROM __drizzle_migrations`)
      .get() as { n: number };
    expect(count2.n).toBe(count1.n);
  });

  test('does NOT run in NODE_ENV=test (test harness owns migrations)', () => {
    // The function reads NODE_ENV at call time; the test harness sets
    // it to 'test' so this returns early. We assert no __drizzle_migrations
    // table exists when env says test.
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    runMigrationsOnBoot(db);

    const row = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
      )
      .get();
    expect(row).toBeUndefined();

    process.env.NODE_ENV = originalEnv;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && bun test src/db/auto-migrate.test.ts
```

Expected: FAIL — `Cannot find module './auto-migrate.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/db/auto-migrate.ts`:

```ts
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { DB } from './client.ts';
import path from 'node:path';

/**
 * Apply any pending Drizzle migrations to the DB at boot.
 *
 * Why this exists: dev environments routinely fall behind on migrations when
 * pulling a branch with new ones. The symptom is route 500s with cryptic SQL
 * errors. Auto-migrate makes the boot reproducible. See
 * ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_migrations-first-when-routes-look-broken.md.
 *
 * Skipped in NODE_ENV=test because the test harness creates fresh in-memory
 * DBs and migrates them itself.
 */
export function runMigrationsOnBoot(db: DB): void {
  if (process.env.NODE_ENV === 'test') return;
  const migrationsFolder = path.join(import.meta.dir, 'migrations');
  migrate(db, { migrationsFolder });
}
```

- [ ] **Step 4: Wire it into the boot sequence**

Modify `apps/server/src/index.ts`, after the imports but before `console.log(`[folio] listening...`):

```ts
import { app } from './app.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';
import { reconcileAllowLists } from './lib/reconciler.ts';
import { runMigrationsOnBoot } from './db/auto-migrate.ts';

// Phase 3 Task A-0: apply any pending migrations at boot so dev environments
// never serve traffic against a stale schema. See auto-migrate.ts for why.
runMigrationsOnBoot(db);

console.log(`[folio] listening on http://localhost:${env.PORT}`);
// ... rest unchanged ...
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/server && bun test src/db/auto-migrate.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Run the full server suite to confirm no regression**

```bash
cd apps/server && bun test
```

Expected: 524+ pass / 1 skip / 0 fail (the +2 from this task should land net green).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/auto-migrate.ts apps/server/src/db/auto-migrate.test.ts apps/server/src/index.ts
git commit -m "phase-3: auto-migrate on boot (A-0)

Applies any pending Drizzle migrations when the server starts.
Skipped in NODE_ENV=test (test harness owns migration). Closes
the dev-DB-falls-behind trap documented in the 2026-05-27 handoff."
```

### Task A-1: Add Phase 3 event kinds to shared module

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/events.test.ts` (or create if missing)

- [ ] **Step 1: Inspect current event-kind test coverage**

```bash
ls packages/shared/src/events*.ts
```

If `events.test.ts` does not exist, create one with the structure used elsewhere in `packages/shared/src/`.

- [ ] **Step 2: Write the failing test**

Create or append to `packages/shared/src/events.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { KNOWN_EVENT_KINDS } from './events.ts';

describe('KNOWN_EVENT_KINDS — Phase 3 additions', () => {
  test('includes all agent.run.* event kinds', () => {
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.started');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.awaiting_approval');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.running');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.completed');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.failed');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.rejected');
  });

  test('includes ai.action audit event', () => {
    expect(KNOWN_EVENT_KINDS).toContain('ai.action');
  });

  test('includes runs_table.lazy_seeded event', () => {
    expect(KNOWN_EVENT_KINDS).toContain('runs_table.lazy_seeded');
  });

  test('includes provider degraded + recovered events', () => {
    expect(KNOWN_EVENT_KINDS).toContain('workspace.provider.degraded');
    expect(KNOWN_EVENT_KINDS).toContain('workspace.provider.recovered');
  });

  test('EventKind union and KNOWN_EVENT_KINDS array stay in sync', () => {
    // Compile-time check: every entry in KNOWN_EVENT_KINDS must be
    // assignable to EventKind. If the union is missing one, this would
    // fail at type-check; we also assert no duplicates at runtime.
    const set = new Set(KNOWN_EVENT_KINDS);
    expect(set.size).toBe(KNOWN_EVENT_KINDS.length);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/shared && bun test src/events.test.ts
```

Expected: FAIL — `agent.run.started` etc. not in list.

- [ ] **Step 4: Add the event kinds**

Modify `packages/shared/src/events.ts`. Replace the file with:

```ts
/**
 * Phase 2.6 sub-phase D: EventKind + KNOWN_EVENT_KINDS live in @folio/shared
 * so both the server and the web UI can import them. The server keeps a
 * re-export from apps/server/src/lib/events.ts for source-compat with the
 * existing many `EventKind` import sites.
 *
 * Phase 3 (Task A-1): added agent.run.*, ai.action, runs_table.lazy_seeded,
 * workspace.provider.{degraded,recovered}.
 */
export type EventKind =
  | 'document.created' | 'document.updated' | 'document.deleted'
  | 'status.created'   | 'status.updated'   | 'status.deleted'
  | 'field.created'    | 'field.updated'    | 'field.deleted'
  | 'view.created'     | 'view.updated'     | 'view.deleted'
  | 'table.created'    | 'table.updated'    | 'table.deleted'
  | 'project.created'  | 'project.updated'  | 'project.deleted'
  | 'workspace.created' | 'workspace.updated'
  | 'activity.logged'
  | 'agent.created'    | 'agent.deleted'   | 'agent.task.assigned'
  | 'comment.created'  | 'comment.mentioned' | 'comment.deleted'
  | 'agent.allow_list.reconciled'
  // Phase 3:
  | 'agent.run.started'
  | 'agent.run.awaiting_approval'
  | 'agent.run.running'
  | 'agent.run.completed'
  | 'agent.run.failed'
  | 'agent.run.rejected'
  | 'ai.action'
  | 'runs_table.lazy_seeded'
  | 'workspace.provider.degraded'
  | 'workspace.provider.recovered';

/** Source-of-truth list. Keep in sync with EventKind above. */
export const KNOWN_EVENT_KINDS: readonly EventKind[] = [
  'document.created', 'document.updated', 'document.deleted',
  'status.created',   'status.updated',   'status.deleted',
  'field.created',    'field.updated',    'field.deleted',
  'view.created',     'view.updated',     'view.deleted',
  'table.created',    'table.updated',    'table.deleted',
  'project.created',  'project.updated',  'project.deleted',
  'workspace.created','workspace.updated',
  'activity.logged',
  'agent.created',    'agent.deleted',   'agent.task.assigned',
  'comment.created',  'comment.mentioned', 'comment.deleted',
  'agent.allow_list.reconciled',
  // Phase 3:
  'agent.run.started',
  'agent.run.awaiting_approval',
  'agent.run.running',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.rejected',
  'ai.action',
  'runs_table.lazy_seeded',
  'workspace.provider.degraded',
  'workspace.provider.recovered',
];
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/shared && bun test src/events.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Run all shared tests**

```bash
cd packages/shared && bun test
```

Expected: 46+5 = 51 pass / 0 fail (existing 46 + 5 new).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/events.test.ts
git commit -m "phase-3: shared/events — add agent.run.* + ai.action + provider events (A-1)

Adds 10 new event kinds used by the agent runner: 6 lifecycle
transitions, 1 ai.action audit event, 1 runs_table.lazy_seeded
signal, 2 provider degraded/recovered events. The trigger schema
in apps/server/src/lib/trigger-schema.ts re-exports KNOWN_EVENT_KINDS
and will automatically allow these in event triggers."
```

### Task A-2: Migration 0012 — widen documents.type + indexes

> Per `[[drizzle-migration-journal]]`: the journal MUST be updated in the same commit. Migration tests bypass it, so a missing journal entry is invisible until production.

**Files:**
- Create: `apps/server/src/db/migrations/0012_phase_3_agent_runs.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/db/schema.ts:219` (the `type` enum)
- Create: `apps/server/src/db/migrations/0012_phase_3_agent_runs.test.ts`

- [ ] **Step 1: Read the prior CHECK-widening migration for the SQLite table-rebuild pattern**

```bash
cat apps/server/src/db/migrations/0007_phase_2_6_comments.sql
```

Note the table-rebuild idiom (drop CHECK, rebuild documents, copy data, re-create indexes). Reuse it.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/db/migrations/0012_phase_3_agent_runs.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function freshMigratedDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('migration 0012 — agent_run type + indexes', () => {
  test('documents.type CHECK now accepts agent_run', () => {
    const { sqlite } = freshMigratedDb();
    // Seed minimum FKs first:
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
       VALUES ('p1','w1','p1','P1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO tables (id, project_id, slug, title, created_at)
       VALUES ('t1','p1','runs','Runs', 0)`,
    );
    sqlite.run(
      `INSERT INTO documents (id, project_id, workspace_id, table_id,
        type, slug, title, parent_id, created_at, updated_at)
       VALUES ('parent1','p1','w1','t1',
        'work_item','parent','Parent', NULL, 0, 0)`,
    );

    // Now insert an agent_run referencing the parent. Must succeed.
    expect(() =>
      sqlite.run(
        `INSERT INTO documents (id, project_id, workspace_id, table_id,
          type, slug, title, parent_id, status, created_at, updated_at)
         VALUES ('r1','p1','w1','t1',
          'agent_run','run-1','run-1','parent1','planning', 0, 0)`,
      ),
    ).not.toThrow();
  });

  test('agent_run requires workspace_id + project_id + table_id + parent_id', () => {
    const { sqlite } = freshMigratedDb();
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    // Missing project_id, table_id, parent_id — must fail.
    expect(() =>
      sqlite.run(
        `INSERT INTO documents (id, workspace_id, type, slug, title, created_at, updated_at)
         VALUES ('r2','w1','agent_run','run-2','run-2', 0, 0)`,
      ),
    ).toThrow();
  });

  test('all four Phase 3 indexes exist', () => {
    const { sqlite } = freshMigratedDb();
    const rows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('documents_runs_by_parent_idx');
    expect(names).toContain('documents_runs_by_status_idx');
    expect(names).toContain('documents_runs_pending_idx');
    expect(names).toContain('documents_runs_by_chain_idx');
  });

  test('existing document types still work (no regression)', () => {
    const { sqlite } = freshMigratedDb();
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
       VALUES ('p1','w1','p1','P1', 0, 0)`,
    );
    for (const type of ['work_item', 'page', 'agent', 'trigger', 'comment']) {
      expect(() =>
        sqlite.run(
          `INSERT INTO documents (id, project_id, workspace_id,
            type, slug, title, created_at, updated_at)
           VALUES ('d-${type}',
            ${type === 'agent' || type === 'trigger' ? 'NULL' : "'p1'"},
            'w1','${type}','slug-${type}','Title', 0, 0)`,
        ),
      ).not.toThrow();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && bun test src/db/migrations/0012_phase_3_agent_runs.test.ts
```

Expected: FAIL — the migration file does not exist yet.

- [ ] **Step 4: Write the migration**

> **⚠ Plan defect noted during A-2 execution (shipped fix in `13c76d8`):**
> The SQL block below declares `author_id` and `target_agent_id` as columns on the rebuilt `documents_new` table. These are NOT real columns in the live schema — they are frontmatter JSON fields. The actual `documents` table on main (post-migrations 0007/0008/0011) has 16 columns: `id, project_id, workspace_id, table_id, type, slug, title, status, body, frontmatter, parent_id, created_by, updated_by, created_at, updated_at, last_touched_at`.
> The plan's `INSERT INTO documents_new SELECT * FROM documents;` would also fail because column counts mismatch. The shipped migration uses an explicit 16-column list for both INSERT and SELECT.
> Treat the SQL below as a sketch of intent. The actual SQL that landed is at `apps/server/src/db/migrations/0012_phase_3_agent_runs.sql` (commit `13c76d8`) — copy from there or follow that pattern for any similar table-rebuild migration.

Create `apps/server/src/db/migrations/0012_phase_3_agent_runs.sql`:

```sql
-- Phase 3: widen documents.type to include 'agent_run' + add the four
-- agent_run-specific indexes. SQLite has no ALTER TABLE … CHANGE CHECK,
-- so we rebuild the table.
--
-- agent_run constraints: workspace_id, project_id, table_id, parent_id
-- must all be NOT NULL. parent_id points to the work_item or page the
-- run acts on. table_id points to the project's lazy-seeded 'runs' table.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint

CREATE TABLE documents_new (
  id text PRIMARY KEY NOT NULL,
  project_id text REFERENCES projects(id) ON DELETE cascade,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
  table_id text REFERENCES tables(id) ON DELETE set null,
  type text NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  status text,
  body text NOT NULL DEFAULT '',
  frontmatter text NOT NULL DEFAULT '{}',
  parent_id text,
  author_id text REFERENCES users(id),
  target_agent_id text REFERENCES documents(id),
  created_by text REFERENCES users(id),
  updated_by text REFERENCES users(id),
  created_at integer NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at integer NOT NULL DEFAULT (unixepoch() * 1000),
  last_touched_at integer,
  CHECK (
    type IN ('work_item','page','agent','trigger','comment','agent_run')
    AND (
      (type IN ('work_item','page') AND project_id IS NOT NULL)
      OR (type IN ('agent','trigger') AND project_id IS NULL)
      OR (type = 'comment' AND parent_id IS NOT NULL)
      OR (type = 'agent_run'
          AND workspace_id IS NOT NULL
          AND project_id  IS NOT NULL
          AND table_id    IS NOT NULL
          AND parent_id   IS NOT NULL)
    )
  )
);
--> statement-breakpoint

INSERT INTO documents_new
SELECT * FROM documents;
--> statement-breakpoint

DROP TABLE documents;
--> statement-breakpoint
ALTER TABLE documents_new RENAME TO documents;
--> statement-breakpoint

-- Re-create the pre-existing indexes that were dropped with the table:
CREATE UNIQUE INDEX documents_project_slug_idx
  ON documents (project_id, slug);
--> statement-breakpoint
CREATE INDEX documents_project_type_idx
  ON documents (project_id, type);
--> statement-breakpoint
CREATE UNIQUE INDEX documents_workspace_type_slug_idx
  ON documents (workspace_id, type, slug);
--> statement-breakpoint
CREATE INDEX documents_workspace_type_idx
  ON documents (workspace_id, type);
--> statement-breakpoint
CREATE INDEX documents_parent_idx
  ON documents (parent_id);
--> statement-breakpoint
CREATE INDEX documents_table_idx
  ON documents (table_id);
--> statement-breakpoint

-- Phase 3 indexes:
-- "Show me all runs for this work_item" — Comments tab link tile.
CREATE INDEX documents_runs_by_parent_idx
  ON documents (parent_id, created_at DESC)
  WHERE type = 'agent_run';
--> statement-breakpoint

-- Runs-table spreadsheet sort/filter on (table_id, status, recency).
CREATE INDEX documents_runs_by_status_idx
  ON documents (table_id, status, created_at DESC)
  WHERE type = 'agent_run';
--> statement-breakpoint

-- Poller claim index: FIFO of planning rows.
CREATE INDEX documents_runs_pending_idx
  ON documents (created_at ASC)
  WHERE type = 'agent_run' AND status = 'planning';
--> statement-breakpoint

-- Chain aggregation (fanout / duration / token guards).
CREATE INDEX documents_runs_by_chain_idx
  ON documents (json_extract(frontmatter, '$.chain_id'), created_at DESC)
  WHERE type = 'agent_run';
--> statement-breakpoint

PRAGMA foreign_keys=ON;
```

- [ ] **Step 5: Update the Drizzle journal — critical**

Edit `apps/server/src/db/migrations/meta/_journal.json`. The current entries end at idx 11. Add idx 12 directly after the closing `}` of idx 11, before the `]`:

```json
    {
      "idx": 12,
      "version": "6",
      "when": 1780867200000,
      "tag": "0012_phase_3_agent_runs",
      "breakpoints": true
    }
```

Use `1780867200000` for `when` (= 2026-05-28 UTC, one day after the merge — keeps the chronological order obvious).

- [ ] **Step 6: Update the Drizzle schema TS to mirror the widened enum**

Modify `apps/server/src/db/schema.ts:219`:

```ts
    type: text('type', {
      enum: ['work_item', 'page', 'agent', 'trigger', 'comment', 'agent_run'],
    }).notNull(),
```

- [ ] **Step 7: Run the migration test to verify it passes**

```bash
cd apps/server && bun test src/db/migrations/0012_phase_3_agent_runs.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 8: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 524 (prior) + 4 (new) = 528 pass / 1 skip / 0 fail. No regression.

> If a regression appears, the most likely cause is the table rebuild dropped a column that some other test selects by position. The migration above copies columns by name via `INSERT INTO documents_new SELECT * FROM documents` — SQLite preserves column order between the original and the rebuild because the new table has every column in the same order as the schema. If a test fails because some column is missing, re-list the source columns explicitly in the SELECT.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db/migrations/0012_phase_3_agent_runs.sql \
        apps/server/src/db/migrations/0012_phase_3_agent_runs.test.ts \
        apps/server/src/db/migrations/meta/_journal.json \
        apps/server/src/db/schema.ts
git commit -m "phase-3: migration 0012 — widen documents.type to include agent_run (A-2)

Adds 'agent_run' to the documents.type enum via SQLite table-rebuild
idiom. CHECK enforces agent_run rows have workspace_id + project_id
+ table_id + parent_id. Four new indexes: by_parent (Comments tab
link tile), by_status (runs-table sort), pending (poller claim
index), by_chain (fanout/duration/token guards via json_extract).
Drizzle journal updated per the team's migration-journal discipline."
```

### Task A-3: Migration 0012a — flip runner-bound builtins to enabled

> The two builtins were seeded `enabled: false` in Phase 2.6 because no runner existed (`enabled: true` would have fired events into a void). Phase 3 has the runner. Flip them.

**Files:**
- Create: `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Modify: `apps/server/src/lib/builtin-triggers.ts:45,57` (flip the seed defaults so newly-created workspaces are correct without the migration)
- Create: `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts`

- [ ] **Step 1: Decide the migration filename pattern**

The existing journal uses `idx 12 -> tag 0012_phase_3_agent_runs`. Drizzle journal entries are referenced by their tag, not by sub-versions. Use tag `0012a_flip_runner_builtins_to_enabled` with `idx: 13`. The "a" suffix carries intent (companion of 0012) but the journal sees them as two distinct migrations.

- [ ] **Step 2: Write the failing test**

> **⚠ Plan defect noted during A-3 execution (shipped fix in `d6fd994`):**
> The test pattern below calls `migrate(db, …)` once, seeds pre-flip rows, then calls `migrate(db, …)` again expecting 0012a to run against the seeded rows. **This does not work.** Drizzle's `migrate()` is idempotent at the journal level — on the second call it sees 0012a already in `__drizzle_migrations` and no-ops. The seeded rows are never touched and the test fails.
> The shipped test (`apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts` in `d6fd994`) reads the SQL file directly via `readFileSync` and `sqlite.exec()`-utes it manually after seeding. Use that pattern for any migration test that needs a "seed then re-run this specific migration" shape.
> Also: the plan's seed flow assumed the assertions about `enabled` values live in `builtin-triggers.test.ts`. They actually live in `apps/server/src/routes/workspaces.test.ts` (the auto-seed-builtins assertion). Both shipped tests now agree.

Create `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

describe('migration 0012a — flip runner builtins to enabled', () => {
  test('builtin-on-assignment + builtin-on-mention end at enabled=true', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    // Seed a pre-flip state: insert the two builtins with enabled=false in
    // their frontmatter, to simulate a 2.6-era workspace migrating up.
    for (const slug of ['builtin-on-assignment', 'builtin-on-mention']) {
      sqlite.run(
        `INSERT INTO documents
         (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
         VALUES (?, 'w1','trigger', ?, ?, ?, 0, 0)`,
        [
          `id-${slug}`,
          slug,
          slug,
          JSON.stringify({ builtin: true, enabled: false }),
        ],
      );
    }

    // Re-run migrations — 0012a is the one we care about. (`migrate` is
    // idempotent at the journal level; running it twice no-ops the table.)
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = sqlite
      .prepare(
        `SELECT slug, frontmatter FROM documents WHERE workspace_id='w1' AND type='trigger'`,
      )
      .all() as Array<{ slug: string; frontmatter: string }>;

    for (const row of rows) {
      const fm = JSON.parse(row.frontmatter) as { enabled: boolean };
      expect(fm.enabled).toBe(true);
    }
  });

  test('does NOT touch other (non-runner) builtins', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
       VALUES ('id-x','w1','trigger','builtin-on-approval','x',?,0,0)`,
      [JSON.stringify({ builtin: true, enabled: true })],
    );
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
       VALUES ('id-y','w1','trigger','user-custom','y',?,0,0)`,
      [JSON.stringify({ builtin: false, enabled: false })],
    );

    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const x = sqlite
      .prepare(`SELECT frontmatter FROM documents WHERE id='id-x'`)
      .get() as { frontmatter: string };
    const y = sqlite
      .prepare(`SELECT frontmatter FROM documents WHERE id='id-y'`)
      .get() as { frontmatter: string };

    expect((JSON.parse(x.frontmatter) as { enabled: boolean }).enabled).toBe(true);
    expect((JSON.parse(y.frontmatter) as { enabled: boolean }).enabled).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/server && bun test src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts
```

Expected: FAIL — migration file does not exist.

- [ ] **Step 4: Write the migration**

Create `apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.sql`:

```sql
-- Phase 3: flip the two runner-bound built-in triggers from
-- enabled=false to enabled=true. Phase 2.6 seeded them disabled
-- because no runner existed. Idempotent: rows already at
-- enabled=true are no-ops via the JSON-path comparison.
UPDATE documents
SET frontmatter = json_set(frontmatter, '$.enabled', json('true')),
    updated_at = unixepoch() * 1000
WHERE type = 'trigger'
  AND json_extract(frontmatter, '$.builtin') = 1
  AND slug IN ('builtin-on-assignment', 'builtin-on-mention')
  AND json_extract(frontmatter, '$.enabled') = 0;
```

- [ ] **Step 5: Update the journal**

Edit `apps/server/src/db/migrations/meta/_journal.json`. Add after the idx 12 entry:

```json
    {
      "idx": 13,
      "version": "6",
      "when": 1780870800000,
      "tag": "0012a_flip_runner_builtins_to_enabled",
      "breakpoints": true
    }
```

- [ ] **Step 6: Update the in-code seed**

Modify `apps/server/src/lib/builtin-triggers.ts` so freshly-created workspaces also start in the enabled state (this avoids a future workspace skipping the migration). Find lines 45 and 57:

```ts
      enabled: false,
```

Change both to:

```ts
      // Phase 3 (Task A-3): runner exists, so these fire usefully.
      enabled: true,
```

There may be a `builtin-triggers.test.ts` asserting `enabled: false`. If so, update those assertions to `true` in the same edit.

- [ ] **Step 7: Run the migration test + builtin-triggers test**

```bash
cd apps/server && bun test src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts src/lib/builtin-triggers.test.ts
```

Expected: PASS (2 + N).

- [ ] **Step 8: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 528+2 = 530 pass / 1 skip / 0 fail.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.sql \
        apps/server/src/db/migrations/0012a_flip_runner_builtins_to_enabled.test.ts \
        apps/server/src/db/migrations/meta/_journal.json \
        apps/server/src/lib/builtin-triggers.ts \
        apps/server/src/lib/builtin-triggers.test.ts
git commit -m "phase-3: migration 0012a — flip runner builtins on (A-3)

builtin-on-assignment + builtin-on-mention shipped disabled in
2.6 because no runner existed. Phase 3 has the runner, so flip
them via a JSON-path UPDATE. Idempotent. Also flips the in-code
seed so newly-created workspaces start enabled directly."
```

### Task A-4: agent_run frontmatter Zod + state-machine helper

> **⚠ Plan defect noted during phase-3-A execution (shipped fix in `bc4b5ee`):**
> The Zod consts below are written PascalCase (`RunStatusSchema`, `AgentRunFrontmatterSchema`, `ProviderSchema`, `RunErrorReasonSchema`) and the main object omits `.strict()`. The `assignee` and `agent_slug` regexes use loose `.+` instead of the project's slug grammar `[a-z0-9-]+`. The `resume_of` field is a bare `z.string()` instead of `.uuid()`.
> The shipped artifact at `bc4b5ee` renames all four consts to camelCase (peer schemas in `apps/server/src/lib/*-schema.ts` use camelCase per CLAUDE.md), adds `.strict()` to the main schema (matches `agentFrontmatterSchema` / `triggerFrontmatterSchema` / `commentFrontmatterSchema`), tightens both regexes to `^agent:[a-z0-9-]+$` / `^[a-z0-9-]+$`, and pins `resume_of` to `.uuid()`.
> Refer to commit `bc4b5ee` for the actual pattern; the block below is preserved as historical context but should not be copied.

**Files:**
- Create: `apps/server/src/lib/agent-run-schema.ts`
- Create: `apps/server/src/lib/agent-run-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/agent-run-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  AgentRunFrontmatterSchema,
  RunStatusSchema,
  RunErrorReasonSchema,
  isValidTransition,
  TERMINAL_STATUSES,
} from './agent-run-schema.ts';

describe('RunStatusSchema', () => {
  test('accepts the six lifecycle statuses', () => {
    for (const s of [
      'planning',
      'awaiting_approval',
      'running',
      'completed',
      'failed',
      'rejected',
    ]) {
      expect(() => RunStatusSchema.parse(s)).not.toThrow();
    }
  });
  test('rejects unknown', () => {
    expect(() => RunStatusSchema.parse('queued')).toThrow();
  });
});

describe('RunErrorReasonSchema', () => {
  test('accepts every documented reason', () => {
    for (const r of [
      'budget_exceeded', 'depth_exceeded', 'no_ai_key', 'provider_error',
      'cancelled', 'rejected', 'idempotency_violation',
      'rate_limited', 'fanout_exceeded', 'chain_duration_exceeded',
      'chain_tokens_exceeded', 'worker_crash',
    ]) {
      expect(() => RunErrorReasonSchema.parse(r)).not.toThrow();
    }
  });
});

describe('AgentRunFrontmatterSchema', () => {
  const valid = {
    assignee: 'agent:reply-drafter',
    status: 'planning',
    agent_slug: 'reply-drafter',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    system_prompt: 'Reply tersely.',
    max_tokens: 4096,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: '00000000-0000-7000-8000-000000000000',
    fired_by: '00000000-0000-7000-8000-000000000000:trigger:builtin-on-assignment',
    started_at: new Date().toISOString(),
  };
  test('accepts a valid minimal frontmatter', () => {
    expect(() => AgentRunFrontmatterSchema.parse(valid)).not.toThrow();
  });
  test('rejects assignee not in agent:<slug> form', () => {
    expect(() => AgentRunFrontmatterSchema.parse({ ...valid, assignee: 'reply-drafter' })).toThrow();
  });
  test('rejects unknown provider', () => {
    expect(() => AgentRunFrontmatterSchema.parse({ ...valid, provider: 'gemini' })).toThrow();
  });
  test('rejects non-uuid chain_id', () => {
    expect(() => AgentRunFrontmatterSchema.parse({ ...valid, chain_id: 'abc' })).toThrow();
  });
  test('error_reason must be from the union when present', () => {
    expect(() =>
      AgentRunFrontmatterSchema.parse({ ...valid, status: 'failed', error_reason: 'bogus' }),
    ).toThrow();
  });
});

describe('isValidTransition', () => {
  test('planning → awaiting_approval | running | failed', () => {
    expect(isValidTransition('planning', 'awaiting_approval')).toBe(true);
    expect(isValidTransition('planning', 'running')).toBe(true);
    expect(isValidTransition('planning', 'failed')).toBe(true);
    expect(isValidTransition('planning', 'completed')).toBe(false);
    expect(isValidTransition('planning', 'rejected')).toBe(false);
  });
  test('awaiting_approval → running | rejected | failed', () => {
    expect(isValidTransition('awaiting_approval', 'running')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'rejected')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'failed')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'completed')).toBe(false);
  });
  test('running → completed | failed', () => {
    expect(isValidTransition('running', 'completed')).toBe(true);
    expect(isValidTransition('running', 'failed')).toBe(true);
    expect(isValidTransition('running', 'rejected')).toBe(false);
  });
  test('no transitions out of terminal states', () => {
    for (const term of TERMINAL_STATUSES) {
      for (const next of ['planning','awaiting_approval','running','completed','failed','rejected']) {
        expect(isValidTransition(term, next as never)).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && bun test src/lib/agent-run-schema.test.ts
```

Expected: FAIL — `Cannot find module './agent-run-schema.ts'`.

- [ ] **Step 3: Write the schema + helper**

Create `apps/server/src/lib/agent-run-schema.ts`:

```ts
import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'rejected',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunErrorReasonSchema = z.enum([
  'budget_exceeded',
  'depth_exceeded',
  'no_ai_key',
  'provider_error',
  'cancelled',
  'rejected',
  'idempotency_violation',
  'rate_limited',
  'fanout_exceeded',
  'chain_duration_exceeded',
  'chain_tokens_exceeded',
  'worker_crash',
]);
export type RunErrorReason = z.infer<typeof RunErrorReasonSchema>;

export const ProviderSchema = z.enum(['anthropic', 'openai', 'openrouter', 'ollama']);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentRunFrontmatterSchema = z.object({
  assignee: z.string().regex(/^agent:.+$/),
  status: RunStatusSchema,

  agent_slug: z.string(),
  provider: ProviderSchema,
  model: z.string(),
  system_prompt: z.string(),
  max_tokens: z.number().int().positive(),

  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),

  trigger_id: z.string().nullable(),
  chain_id: z.string().uuid(),
  fired_by: z.string(),

  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),

  worker_started_at: z.string().datetime().optional(),

  // Set on resume — points to the original awaiting_approval run id.
  resume_of: z.string().optional(),

  error_reason: RunErrorReasonSchema.optional(),
  error_detail: z.string().optional(),
});
export type AgentRunFrontmatter = z.infer<typeof AgentRunFrontmatterSchema>;

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'rejected'];

/**
 * State machine for agent_run rows.
 *
 *   planning ─────────┬─→ awaiting_approval ─┬─→ running ─┬─→ completed
 *                     │                      │            └─→ failed
 *                     │                      └─→ rejected
 *                     │                      └─→ failed
 *                     ├─→ running ─┬─→ completed
 *                     │            └─→ failed
 *                     └─→ failed
 *
 * Any transition out of a terminal state is invalid.
 */
const TRANSITIONS: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  planning: ['awaiting_approval', 'running', 'failed'],
  awaiting_approval: ['running', 'rejected', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  rejected: [],
};

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/agent-run-schema.test.ts
```

Expected: PASS (~14 tests).

- [ ] **Step 5: Run the full server suite**

```bash
cd apps/server && bun test
```

Expected: 530+14 = 544 pass / 1 skip / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/agent-run-schema.ts apps/server/src/lib/agent-run-schema.test.ts
git commit -m "phase-3: agent_run Zod + state-machine helper (A-4)

Frontmatter schema with status, provider, model, system_prompt snapshot,
tokens_in/out, trigger_id, chain_id (uuid), fired_by, started_at,
optional worker_started_at + resume_of + error fields.

isValidTransition() encodes the state machine: every transition is
explicit; terminal statuses are dead-ends."
```

### Task A-4b: Pre-commit hook — migration ↔ journal pairing

> **⚠ Plan defect noted during phase-3-A execution (shipped fix in `13e5954`):**
> The Step 5 `install.sh` listing below uses an unquoted heredoc (`<<EOF`), which interpolates `$HOOK_SRC_DIR` at install time and bakes the installer-machine's absolute path into `.git/hooks/pre-commit`. On any other clone path (or after a `git worktree`/move), the generated hook references a non-existent file and `set -e` makes every commit fail closed.
> The shipped artifact at `13e5954` switches to a single-quoted heredoc (`<<'EOF'`) and resolves the repo root at hook-RUNTIME via `$(git rev-parse --show-toplevel)`. The unused `HOOK_SRC_DIR` local was removed, and the generated hook upgrades `set -e` to `set -euo pipefail` to match the outer scripts.
> Refer to commit `13e5954` for the actual pattern; the Step 5 block below is preserved as historical context but should not be copied.

> **Why.** `[[drizzle-migration-journal]]` says every new `.sql` migration must update `_journal.json` in the same commit. The runtime can't help here — Drizzle's `migrate()` silently skips files that aren't in the journal, so a missing entry is invisible until production. A pre-commit hook closes the loop. This task is the project's automated enforcement of remark #4 from the Phase 3 review.

**Files:**
- Create: `scripts/hooks/pre-commit-migration-journal.sh`
- Create: `scripts/hooks/pre-commit-migration-journal.test.sh`
- Modify: `scripts/hooks/install.sh` (or create if absent) — symlinks the hook into `.git/hooks/pre-commit` (composes with existing hooks if any).

- [ ] **Step 1: Inspect the current hook setup**

```bash
ls -la .git/hooks/ scripts/hooks/ 2>/dev/null
```

If `scripts/hooks/` doesn't exist yet, create it. If `.git/hooks/pre-commit` already exists (e.g. from Husky or a prior hook), the installer must `cat` the existing hook + our new check so we don't clobber anything.

- [ ] **Step 2: Write a test harness for the hook**

Create `scripts/hooks/pre-commit-migration-journal.test.sh`:

```bash
#!/usr/bin/env bash
# Black-box test for the migration-journal pre-commit hook.
# Runs the hook against a synthetic staged set and asserts pass/fail.
set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/pre-commit-migration-journal.sh"
TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT

# Simulate staged files via an env override the hook supports.
fail=0

# Case 1: staged migration WITHOUT journal — must FAIL (exit 1).
if FOLIO_HOOK_STAGED_FILES="apps/server/src/db/migrations/9999_test.sql" "$HOOK" > "$TMP/out1" 2>&1; then
  echo "FAIL: hook allowed an orphan migration"; fail=1
else
  grep -q "journal entry" "$TMP/out1" || { echo "FAIL: missing journal-entry message"; fail=1; }
fi

# Case 2: staged migration WITH journal — must PASS (exit 0).
if FOLIO_HOOK_STAGED_FILES=$'apps/server/src/db/migrations/9999_test.sql\napps/server/src/db/migrations/meta/_journal.json' "$HOOK" > "$TMP/out2" 2>&1; then
  : # ok
else
  echo "FAIL: hook rejected a paired migration + journal"; fail=1
fi

# Case 3: no migration in stage — must PASS.
if FOLIO_HOOK_STAGED_FILES="README.md" "$HOOK" > "$TMP/out3" 2>&1; then
  : # ok
else
  echo "FAIL: hook fired on non-migration commit"; fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "OK: 3/3 hook cases"
```

Make it executable: `chmod +x scripts/hooks/pre-commit-migration-journal.test.sh`.

- [ ] **Step 3: Run the test to verify it fails**

```bash
./scripts/hooks/pre-commit-migration-journal.test.sh
```

Expected: FAIL — `pre-commit-migration-journal.sh` doesn't exist yet.

- [ ] **Step 4: Implement the hook**

Create `scripts/hooks/pre-commit-migration-journal.sh`:

```bash
#!/usr/bin/env bash
# Refuses commits that add or modify apps/server/src/db/migrations/*.sql
# without also staging apps/server/src/db/migrations/meta/_journal.json.
# Drizzle's migrator silently skips migrations not listed in the journal —
# the symptom is invisible locally and explosive in production.
set -euo pipefail

# Allow tests to inject staged-files list via env (NL-separated).
if [ -n "${FOLIO_HOOK_STAGED_FILES:-}" ]; then
  staged="$FOLIO_HOOK_STAGED_FILES"
else
  staged="$(git diff --cached --name-only --diff-filter=ACMR || true)"
fi

# Find any staged migration .sql files (ignore the _journal.json itself).
migration_files="$(echo "$staged" | grep -E '^apps/server/src/db/migrations/[^/]+\.sql$' || true)"

if [ -z "$migration_files" ]; then
  exit 0
fi

# At least one migration is staged — journal MUST also be staged.
if echo "$staged" | grep -q '^apps/server/src/db/migrations/meta/_journal\.json$'; then
  exit 0
fi

cat >&2 <<EOF
✗ Migration file(s) staged without _journal.json update:

$(echo "$migration_files" | sed 's/^/    /')

Drizzle's migrate() silently skips migrations not listed in
apps/server/src/db/migrations/meta/_journal.json, so a missing
journal entry breaks production without local symptoms.

Add the new migration's entry to _journal.json (idx, version, when,
tag, breakpoints) and stage it:

    git add apps/server/src/db/migrations/meta/_journal.json

See ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_drizzle-migration-journal.md
for the full rule.

To override (emergency only — make a follow-up commit immediately):

    git commit --no-verify ...

EOF
exit 1
```

Make it executable: `chmod +x scripts/hooks/pre-commit-migration-journal.sh`.

- [ ] **Step 5: Implement the installer**

Create or update `scripts/hooks/install.sh`:

```bash
#!/usr/bin/env bash
# Installs the project's pre-commit hooks into .git/hooks/.
# Safe to re-run; composes with any existing pre-commit.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_DST="$REPO_ROOT/.git/hooks/pre-commit"
HOOK_SRC_DIR="$REPO_ROOT/scripts/hooks"

cat > "$HOOK_DST" <<EOF
#!/usr/bin/env bash
# Auto-generated by scripts/hooks/install.sh — do not edit by hand.
set -e
"$HOOK_SRC_DIR/pre-commit-migration-journal.sh"
EOF
chmod +x "$HOOK_DST"
echo "installed: $HOOK_DST"
```

Make it executable: `chmod +x scripts/hooks/install.sh`.

- [ ] **Step 6: Document install in CLAUDE.md or README**

Append to `CLAUDE.md` under "Build & Run":

```markdown
- One-time per fresh clone: `./scripts/hooks/install.sh` to enable the
  migration-journal pre-commit check. Re-run if you re-clone.
```

- [ ] **Step 7: Install the hook locally + run the harness**

```bash
./scripts/hooks/install.sh
./scripts/hooks/pre-commit-migration-journal.test.sh
```

Expected: `installed: ...` then `OK: 3/3 hook cases`.

- [ ] **Step 8: Smoke against the real index**

Try a doomed commit and a clean commit to confirm the hook fires in both directions. Use `--no-verify` only to abandon the doomed commit:

```bash
# Doomed: stage just a fake migration without the journal.
mkdir -p /tmp/folio-hook-smoke && touch apps/server/src/db/migrations/9999_smoke.sql
git add apps/server/src/db/migrations/9999_smoke.sql
git commit -m "smoke: should be rejected"  # MUST fail
git restore --staged apps/server/src/db/migrations/9999_smoke.sql
rm apps/server/src/db/migrations/9999_smoke.sql
```

Expected: commit aborted with the journal-entry message.

- [ ] **Step 9: Commit**

```bash
git add scripts/hooks/ CLAUDE.md
git commit -m "phase-3: pre-commit hook — migration ↔ journal pairing (A-4b)

Refuses commits that add an apps/server/src/db/migrations/*.sql
file without also staging the matching _journal.json entry.
Drizzle's migrate() silently skips files missing from the journal,
which makes the failure invisible until production.

Installer at scripts/hooks/install.sh is composable with other
pre-commit hooks (it writes a fresh .git/hooks/pre-commit pointing
at the script). One-time per fresh clone."
```

### Task A-5: Sub-phase A integration gate

- [ ] **Step 1: Run all three test suites**

```bash
cd apps/server && bun test
cd ../web && bun run test
cd ../../packages/shared && bun test
```

Expected (rough): server **544 / 1-skip / 0-fail**; web unchanged at **547 / 8-skip / 0-fail**; shared **51 / 0-fail**.

- [ ] **Step 2: Type-check both apps**

```bash
cd apps/server && bun run typecheck
cd ../web && bun run typecheck
```

Expected: PASS for both. If `apps/server/src/index.ts` shows pre-existing type errors unrelated to A-* changes, they were on main before this branch — note them in the PR description but do not fix here.

- [ ] **Step 3: Smoke the dev DB migrates cleanly**

```bash
bun --filter=@folio/server db:migrate
```

Expected: applies migrations 0012 and 0012a if not already applied, otherwise reports "Everything's fine".

- [ ] **Step 4: Sub-phase A checkpoint**

Sub-phase A complete. The runtime can store and validate `agent_run` rows, the queue index exists, the runner-bound builtins are flipped, the dev DB auto-migrates. **Move to Sub-phase B.**

---

## Sub-phase B — Provider abstraction + AI settings tab

Goal: ship the `AIProvider` interface and four implementations, a `POST /ai/test-key` endpoint, and the workspace AI-settings tab UI. The runner does NOT yet exist — Sub-phase B is fully shippable on its own (you can configure a key, click Test, see ok/fail).

### Task B-1: `lib/ai/provider.ts` interface + factory + shared types

**Files:**
- Create: `apps/server/src/lib/ai/provider.ts`
- Create: `apps/server/src/lib/ai/provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai/provider.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getProvider } from './provider.ts';

describe('getProvider', () => {
  test('returns a provider object exposing stream + testKey for each known provider', () => {
    for (const name of ['anthropic', 'openai', 'openrouter', 'ollama'] as const) {
      const p = getProvider(name);
      expect(typeof p.stream).toBe('function');
      expect(typeof p.testKey).toBe('function');
    }
  });

  test('throws on unknown provider', () => {
    // @ts-expect-error — testing runtime guard for an unknown name
    expect(() => getProvider('gemini')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/server && bun test src/lib/ai/provider.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the interface + factory stub**

Create `apps/server/src/lib/ai/provider.ts`:

```ts
import type { Provider } from '../agent-run-schema.ts';

export type ProviderEvent =
  | { type: 'text';      delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tokens';    tokens_in: number; tokens_out: number }
  | { type: 'done';      reason: 'stop' | 'tool_use' | 'max_tokens' };

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; name: string; arguments: unknown }> }
  | { role: 'tool'; content: string; tool_use_id: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
};

export interface AIProvider {
  stream(opts: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    maxTokens: number;
    apiKey: string;
    model: string;
    baseUrl?: string;
  }): AsyncIterable<ProviderEvent>;

  testKey(opts: { apiKey: string; model: string; baseUrl?: string }): Promise<
    { ok: true } | { ok: false; reason: string }
  >;
}

// Provider implementations import from their own files. We defer the actual
// imports to runtime via dynamic import so a test that only exercises the
// factory shape doesn't pull SDKs into the test bundle.
const REGISTRY: Record<Provider, () => Promise<AIProvider>> = {
  anthropic: async () => (await import('./anthropic.ts')).anthropic,
  openai: async () => (await import('./openai.ts')).openai,
  openrouter: async () => (await import('./openrouter.ts')).openrouter,
  ollama: async () => (await import('./ollama.ts')).ollama,
};

// Lazily resolved cache so getProvider stays synchronous from the caller's POV
// once the first call has resolved the module.
const cache: Partial<Record<Provider, AIProvider>> = {};

export function getProvider(name: Provider): AIProvider {
  if (!REGISTRY[name]) throw new Error(`Unknown AI provider: ${String(name)}`);
  const cached = cache[name];
  if (cached) return cached;
  // For the synchronous contract, return a proxy that forwards to the loaded
  // module on first call.
  const proxy: AIProvider = {
    async *stream(opts) {
      const impl = await REGISTRY[name]();
      cache[name] = impl;
      yield* impl.stream(opts);
    },
    async testKey(opts) {
      const impl = await REGISTRY[name]();
      cache[name] = impl;
      return impl.testKey(opts);
    },
  };
  return proxy;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/provider.test.ts
```

Expected: PASS. (Note: the proxy forwards but never gets called in this test — only the existence of `stream`/`testKey` properties is asserted. The four `./*.ts` modules don't exist yet, but the dynamic import isn't triggered.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ai/provider.ts apps/server/src/lib/ai/provider.test.ts
git commit -m "phase-3: AIProvider interface + factory (B-1)

Defines ProviderEvent (text/tool_call/tokens/done), Message,
ToolDef, the AIProvider interface (stream + testKey), and a
factory with a per-provider proxy that lazy-loads the
implementation on first call (so the four SDK-importing modules
don't all load at boot)."
```

### Task B-2: Anthropic provider

> Per the project's auto-memory `[[claude-api]]`-style guidance — use `@anthropic-ai/sdk` directly.

**Files:**
- Create: `apps/server/src/lib/ai/anthropic.ts`
- Create: `apps/server/src/lib/ai/anthropic.test.ts`
- Modify: `apps/server/package.json` (add dep)

- [ ] **Step 1: Add the dep**

```bash
cd apps/server && bun add @anthropic-ai/sdk
```

Verify `package.json` shows it under `dependencies`. Commit `package.json` + `bun.lockb` (the workspace root) at the end of the task with the implementation.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/lib/ai/anthropic.test.ts`. We mock the SDK at the network boundary so the test does not touch the real API.

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock the SDK module BEFORE importing the provider so the provider sees the mock.
const mockCreate = mock(async () => ({}));
const mockStream = mock(async function* () {
  yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 1 } };
  yield { type: 'message_stop' };
});

mock.module('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate, stream: () => mockStream() };
    constructor(_: unknown) {}
  },
}));

import { anthropic } from './anthropic.ts';

describe('anthropic provider', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test('stream() yields text + tokens + done events from the Anthropic SDK stream', async () => {
    const events: unknown[] = [];
    for await (const ev of anthropic.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hello' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 5, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200 response', async () => {
    mockCreate.mockImplementationOnce(async () => ({ id: 'msg_x' }));
    const result = await anthropic.testKey({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(true);
  });

  test('testKey() returns structured failure on 401', async () => {
    mockCreate.mockImplementationOnce(async () => {
      const err = new Error('Unauthorized') as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const result = await anthropic.testKey({ apiKey: 'sk-bad', model: 'claude-haiku-4-5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unauth|401/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/server && bun test src/lib/ai/anthropic.test.ts
```

Expected: FAIL — `anthropic.ts` not found.

- [ ] **Step 4: Implement the provider**

Create `apps/server/src/lib/ai/anthropic.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ProviderEvent } from './provider.ts';

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export const anthropic: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model }) {
    const c = client(apiKey);

    // Translate from common Message shape to Anthropic's. We keep the
    // common shape narrow on purpose; advanced features (caching, thinking)
    // are not in v1.
    const anthropicMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            { type: 'tool_result' as const, tool_use_id: m.tool_use_id, content: m.content },
          ],
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.tool_calls.map((tc) => ({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const stream = c.messages.stream({
      model,
      system,
      max_tokens: maxTokens,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Record<string, unknown>,
      })),
      // ⚠ Plan defect noted during B-2 execution (shipped fix in `20b1ff0`):
      // `as never` disables ALL type checking at the SDK boundary, defeating
      // the purpose of the wrapping function. Shipped fix uses the SDK's
      // exported `MessageParam[]` type instead. Refer to commit `20b1ff0` for
      // the actual pattern; the `as never` below is preserved as historical
      // context but should not be copied.
      messages: anthropicMessages as never,
    });

    let inTokens = 0;
    let outTokens = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';
    const toolCallsByIndex: Record<number, { id: string; name: string; jsonBuf: string }> = {};

    for await (const ev of stream as AsyncIterable<Record<string, unknown>>) {
      const t = ev.type as string;
      if (t === 'content_block_start' && (ev.content_block as { type: string } | undefined)?.type === 'tool_use') {
        const cb = ev.content_block as { id: string; name: string };
        const idx = ev.index as number;
        toolCallsByIndex[idx] = { id: cb.id, name: cb.name, jsonBuf: '' };
      } else if (t === 'content_block_delta') {
        const delta = ev.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text } as ProviderEvent;
        } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const idx = ev.index as number;
          if (toolCallsByIndex[idx]) toolCallsByIndex[idx].jsonBuf += delta.partial_json;
        }
      } else if (t === 'content_block_stop') {
        const idx = ev.index as number;
        const tc = toolCallsByIndex[idx];
        if (tc) {
          const args = tc.jsonBuf.length > 0 ? JSON.parse(tc.jsonBuf) : {};
          yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: args } as ProviderEvent;
        }
      } else if (t === 'message_delta') {
        const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const delta = ev.delta as { stop_reason?: string } | undefined;
        if (usage?.input_tokens) inTokens = usage.input_tokens;
        if (usage?.output_tokens) outTokens = usage.output_tokens;
        if (delta?.stop_reason === 'tool_use') stopReason = 'tool_use';
        else if (delta?.stop_reason === 'max_tokens') stopReason = 'max_tokens';
      }
    }

    yield { type: 'tokens', tokens_in: inTokens, tokens_out: outTokens };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ apiKey, model }) {
    try {
      const c = client(apiKey);
      await c.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) return { ok: false, reason: 'Unauthorized (401): key rejected by Anthropic.' };
      if (e.status === 404) return { ok: false, reason: `Model not found (404): ${model}` };
      return { ok: false, reason: e.message ?? 'Unknown error' };
    }
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/anthropic.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/ai/anthropic.ts apps/server/src/lib/ai/anthropic.test.ts \
        apps/server/package.json bun.lockb
git commit -m "phase-3: Anthropic provider (B-2)

Wraps @anthropic-ai/sdk into the AIProvider interface. Streams
text + tool_call + tokens + done. testKey does a 1-token ping
and normalizes 401/404 into structured failures. Tool calls
buffer input_json_delta chunks and emit on content_block_stop."
```

### Task B-3: OpenAI provider

**Files:**
- Create: `apps/server/src/lib/ai/openai.ts`
- Create: `apps/server/src/lib/ai/openai.test.ts`
- Modify: `apps/server/package.json` (add `openai` dep)

- [ ] **Step 1: Add the dep**

```bash
cd apps/server && bun add openai
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/lib/ai/openai.test.ts` mirroring the Anthropic shape: mock the `openai` SDK module, assert that `stream()` yields `text → tokens → done` and tool-call events are emitted on the finish chunk.

```ts
import { describe, expect, mock, test } from 'bun:test';

const mockStream = mock(async function* () {
  yield { choices: [{ delta: { content: 'Hi' } }], usage: null };
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };
});

mock.module('openai', () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: mock(async (opts: { stream?: boolean }) => {
          if (opts.stream) return mockStream();
          return { id: 'cmpl_x' };
        }),
      },
    };
    constructor(_: unknown) {}
  },
}));

import { openai } from './openai.ts';

describe('openai provider', () => {
  test('stream() yields text + tokens + done', async () => {
    const events: unknown[] = [];
    for await (const ev of openai.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 4, tokens_out: 1 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200 from the mock', async () => {
    const r = await openai.testKey({ apiKey: 'sk', model: 'gpt-4o-mini' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && bun test src/lib/ai/openai.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement**

Create `apps/server/src/lib/ai/openai.ts`:

```ts
import OpenAI from 'openai';
import type { AIProvider, Message, ProviderEvent } from './provider.ts';

function client(apiKey: string, baseUrl?: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}

function toOpenAIMessages(system: string, messages: Message[]) {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.tool_use_id });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const openai: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, apiKey, model, baseUrl }) {
    const c = client(apiKey, baseUrl);
    const stream = await c.chat.completions.create({
      model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(system, messages) as never,
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    });

    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';
    const toolCallsById: Record<string, { name: string; argsBuf: string }> = {};

    for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (choices?.[0]) {
        const delta = choices[0].delta as
          | { content?: string; tool_calls?: Array<{ id: string; function: { name?: string; arguments?: string } }> }
          | undefined;
        if (delta?.content) yield { type: 'text', delta: delta.content } as ProviderEvent;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallsById[tc.id]) toolCallsById[tc.id] = { name: tc.function.name ?? '', argsBuf: '' };
            toolCallsById[tc.id].argsBuf += tc.function.arguments ?? '';
            if (tc.function.name) toolCallsById[tc.id].name = tc.function.name;
          }
        }
        const finish = choices[0].finish_reason as string | undefined;
        if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'length') stopReason = 'max_tokens';
      }
      const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
      if (usage?.prompt_tokens) tokensIn = usage.prompt_tokens;
      if (usage?.completion_tokens) tokensOut = usage.completion_tokens;
    }

    for (const [id, tc] of Object.entries(toolCallsById)) {
      yield {
        type: 'tool_call',
        id,
        name: tc.name,
        arguments: tc.argsBuf ? JSON.parse(tc.argsBuf) : {},
      } as ProviderEvent;
    }

    yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ apiKey, model, baseUrl }) {
    try {
      const c = client(apiKey, baseUrl);
      await c.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) return { ok: false, reason: 'Unauthorized (401): key rejected by OpenAI.' };
      if (e.status === 404) return { ok: false, reason: `Model not found (404): ${model}` };
      return { ok: false, reason: e.message ?? 'Unknown error' };
    }
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/openai.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/ai/openai.ts apps/server/src/lib/ai/openai.test.ts \
        apps/server/package.json bun.lockb
git commit -m "phase-3: OpenAI provider (B-3)

Wraps openai SDK into the AIProvider interface. Streams text +
tool_calls (buffered by id) + tokens + done. Uses
stream_options.include_usage to surface token counts."
```

### Task B-4: OpenRouter provider

OpenRouter speaks the OpenAI API. The provider wraps the OpenAI client with a base URL.

**Files:**
- Create: `apps/server/src/lib/ai/openrouter.ts`
- Create: `apps/server/src/lib/ai/openrouter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai/openrouter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { openrouter } from './openrouter.ts';

describe('openrouter provider', () => {
  test('exposes stream + testKey', () => {
    expect(typeof openrouter.stream).toBe('function');
    expect(typeof openrouter.testKey).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement as a thin OpenAI-client wrapper**

Create `apps/server/src/lib/ai/openrouter.ts`:

```ts
import { openai } from './openai.ts';
import type { AIProvider } from './provider.ts';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter exposes an OpenAI-compatible API. We reuse the OpenAI provider
 * with a base-URL override. Model strings pass through verbatim — caller is
 * expected to format them as "anthropic/claude-haiku-4-5" or whatever route
 * they want.
 */
export const openrouter: AIProvider = {
  stream: (opts) => openai.stream({ ...opts, baseUrl: OPENROUTER_BASE }),
  testKey: (opts) => openai.testKey({ ...opts, baseUrl: OPENROUTER_BASE }),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ai/openrouter.ts apps/server/src/lib/ai/openrouter.test.ts
git commit -m "phase-3: OpenRouter provider (B-4)

Thin wrapper over the OpenAI provider with OpenRouter's base URL.
Model strings pass through verbatim ('anthropic/claude-haiku-4-5'
or any other route)."
```

### Task B-5: Ollama provider

Ollama has no SDK; use plain `fetch` against `/api/chat`.

**Files:**
- Create: `apps/server/src/lib/ai/ollama.ts`
- Create: `apps/server/src/lib/ai/ollama.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/ai/ollama.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ollama } from './ollama.ts';

const originalFetch = global.fetch;

function jsonl(lines: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(JSON.stringify(l) + '\n'));
      controller.close();
    },
  });
}

describe('ollama provider', () => {
  afterEach(() => { global.fetch = originalFetch; });

  test('stream() yields text + tokens + done from /api/chat NDJSON', async () => {
    global.fetch = mock(async () =>
      new Response(jsonl([
        { message: { content: 'Hi ' }, done: false },
        { message: { content: 'there' }, done: false },
        {
          message: { content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 7,
          eval_count: 2,
        },
      ]), { status: 200 }),
    ) as never;

    const events: unknown[] = [];
    for await (const ev of ollama.stream({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      apiKey: '',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434',
    })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: 'text', delta: 'Hi ' });
    expect(events).toContainEqual({ type: 'text', delta: 'there' });
    expect(events).toContainEqual({ type: 'tokens', tokens_in: 7, tokens_out: 2 });
    expect(events).toContainEqual({ type: 'done', reason: 'stop' });
  });

  test('testKey() returns ok on a 200', async () => {
    global.fetch = mock(async () => new Response('{}', { status: 200 })) as never;
    const r = await ollama.testKey({ apiKey: '', model: 'llama3.1', baseUrl: 'http://localhost:11434' });
    expect(r.ok).toBe(true);
  });

  test('testKey() returns failure on connection refused', async () => {
    global.fetch = mock(async () => { throw new Error('ECONNREFUSED'); }) as never;
    const r = await ollama.testKey({ apiKey: '', model: 'llama3.1', baseUrl: 'http://localhost:11434' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/server/src/lib/ai/ollama.ts`:

```ts
import type { AIProvider, Message, ProviderEvent } from './provider.ts';

const DEFAULT_BASE = 'http://localhost:11434';

export const ollama: AIProvider = {
  async *stream({ system, messages, tools, maxTokens, model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    const body = {
      model,
      stream: true,
      options: { num_predict: maxTokens },
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) =>
          m.role === 'tool'
            ? { role: 'tool', content: m.content, tool_call_id: m.tool_use_id }
            : { role: m.role, content: m.content },
        ),
      ],
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    };

    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) throw new Error(`ollama: ${resp.status} ${resp.statusText}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as Record<string, unknown>;
        const msg = chunk.message as { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> } | undefined;
        if (msg?.content) yield { type: 'text', delta: msg.content } as ProviderEvent;
        if (msg?.tool_calls) {
          for (const tc of msg.tool_calls) {
            yield {
              type: 'tool_call',
              id: crypto.randomUUID(),
              name: tc.function.name,
              arguments: tc.function.arguments,
            } as ProviderEvent;
          }
        }
        if (chunk.done) {
          tokensIn = (chunk.prompt_eval_count as number | undefined) ?? tokensIn;
          tokensOut = (chunk.eval_count as number | undefined) ?? tokensOut;
          const reason = chunk.done_reason as string | undefined;
          if (reason === 'length') stopReason = 'max_tokens';
          else if (reason === 'tool_calls') stopReason = 'tool_use';
        }
      }
    }

    yield { type: 'tokens', tokens_in: tokensIn, tokens_out: tokensOut };
    yield { type: 'done', reason: stopReason };
  },

  async testKey({ model, baseUrl }) {
    const base = baseUrl ?? DEFAULT_BASE;
    try {
      const resp = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (resp.ok) return { ok: true };
      if (resp.status === 404) return { ok: false, reason: `Model not found on ${base}: ${model}` };
      return { ok: false, reason: `Ollama HTTP ${resp.status}` };
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, reason: e.message ?? `Cannot reach ${base}` };
    }
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/server && bun test src/lib/ai/ollama.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/ai/ollama.ts apps/server/src/lib/ai/ollama.test.ts
git commit -m "phase-3: Ollama provider (B-5)

Plain fetch against /api/chat (NDJSON stream). testKey calls
/api/show to verify the model is installed. No API key required;
baseUrl defaults to http://localhost:11434. Token counts come
from prompt_eval_count + eval_count in the final NDJSON line."
```

### Task B-6: AI test-key route + service-layer helper

**Files:**
- Create: `apps/server/src/routes/ai.ts`
- Create: `apps/server/src/routes/ai.test.ts`
- Modify: `apps/server/src/app.ts` (mount the route)

- [ ] **Step 1: Find the existing route-mount pattern**

```bash
grep -n "\.route\|app\.route" apps/server/src/app.ts
```

The pattern will be `app.route('/api/v1/...', routerName)` or similar. Reuse it.

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/routes/ai.test.ts`. Mirrors the existing route-test convention (look at `apps/server/src/routes/comments.test.ts` for the in-process Hono request pattern).

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { freshDb, signedInAgent } from '../../tests/helpers.ts'; // existing helper
import { app } from '../app.ts';

describe('POST /api/v1/w/:wslug/ai/test-key', () => {
  beforeEach(() => freshDb());

  test('returns ok:true for a happy-path mocked provider', async () => {
    const { workspace, sessionCookie } = await signedInAgent();
    const resp = await app.fetch(
      new Request(`http://x/api/v1/w/${workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        // We rely on the provider proxy: anthropic.testKey mock is set up
        // in tests/helpers.ts to return ok for any 'sk-mock-*' key.
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5', api_key: 'sk-mock-good' }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('rejects unknown provider with 422', async () => {
    const { workspace, sessionCookie } = await signedInAgent();
    const resp = await app.fetch(
      new Request(`http://x/api/v1/w/${workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ provider: 'gemini', model: 'x', api_key: 'sk' }),
      }),
    );
    expect(resp.status).toBe(422);
  });

  test('requires session auth', async () => {
    const resp = await app.fetch(
      new Request(`http://x/api/v1/w/anything/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', model: 'x', api_key: 'sk' }),
      }),
    );
    expect([401, 404]).toContain(resp.status); // 401 if no session, 404 if wslug not found before session check
  });

  test('does NOT persist the key', async () => {
    // Implementation must not write to ai_keys. Verified by reading the
    // table after the call and seeing the row count unchanged.
    // (Implementation in routes/ai.ts must not touch the ai_keys table.)
    const { workspace, sessionCookie, db } = await signedInAgent();
    const beforeRow = db.prepare('SELECT COUNT(*) as n FROM ai_keys').get() as { n: number };
    await app.fetch(
      new Request(`http://x/api/v1/w/${workspace.slug}/ai/test-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5', api_key: 'sk-mock-good' }),
      }),
    );
    const afterRow = db.prepare('SELECT COUNT(*) as n FROM ai_keys').get() as { n: number };
    expect(afterRow.n).toBe(beforeRow.n);
  });
});
```

> **Note for the executor.** `tests/helpers.ts` and `signedInAgent()` should already exist (see existing route tests for the pattern). If they don't, copy the in-test setup from `apps/server/src/routes/comments.test.ts` instead. Adapt the mock-provider behavior at the top of the test file using `mock.module('./lib/ai/anthropic.ts', ...)` similar to Task B-2 if needed.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/server && bun test src/routes/ai.test.ts
```

Expected: FAIL — route does not exist.

- [ ] **Step 4: Implement the route**

Create `apps/server/src/routes/ai.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { sessionMiddleware } from '../middleware/session.ts'; // existing helper
import { resolveWorkspace } from '../middleware/workspace.ts'; // existing helper
import { ProviderSchema } from '../lib/agent-run-schema.ts';
import { getProvider } from '../lib/ai/provider.ts';

const TestKeyBody = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  api_key: z.string().min(1),
  base_url: z.string().url().optional(),
});

export const aiRouter = new Hono();

aiRouter.post('/w/:wslug/ai/test-key', sessionMiddleware, resolveWorkspace, async (c) => {
  const parsed = TestKeyBody.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: JSON.stringify({ error: { code: 'invalid_form_input', detail: parsed.error.flatten() } }),
    });
  }
  const { provider, model, api_key, base_url } = parsed.data;
  const result = await getProvider(provider).testKey({ apiKey: api_key, model, baseUrl: base_url });
  return c.json(result);
});
```

> If the project doesn't have `sessionMiddleware` and `resolveWorkspace` middlewares by those names, look in `apps/server/src/middleware/` and `apps/server/src/routes/auth.ts` for the equivalents. The existing `routes/comments.ts` shows how this is wired in practice — copy that pattern.

- [ ] **Step 5: Mount the route in `app.ts`**

Find the existing `app.route('/api/v1', ...)` mounts and add:

```ts
import { aiRouter } from './routes/ai.ts';
// ...
app.route('/api/v1', aiRouter);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/server && bun test src/routes/ai.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/ai.ts apps/server/src/routes/ai.test.ts apps/server/src/app.ts
git commit -m "phase-3: POST /ai/test-key route (B-6)

Validates a provider key against the live provider by calling
its testKey() method. Does NOT persist the key — that is a
separate ai_keys PATCH that already exists from Phase 0.
Returns { ok: true } | { ok: false, reason }."
```

### Task B-7: Workspace AI-settings tab (web)

**Files:**
- Create: `apps/web/src/pages/workspace-settings-ai.tsx`
- Create: `apps/web/src/pages/workspace-settings-ai.test.tsx`
- Create: `apps/web/src/lib/api/ai-test-key.ts`
- Modify: `apps/web/src/pages/workspace-settings.tsx` (add the new tab)
- Modify: `apps/web/src/lib/api/ai-keys.ts` (if not already exposing save/list/delete — assume yes per STATE.md Bug D)

- [ ] **Step 1: Locate the existing settings page**

```bash
ls apps/web/src/pages/workspace-settings*
grep -rn "API tokens" apps/web/src/pages/workspace-settings.tsx | head -5
```

Identify the TabStrip block. The new tab is "AI" added next to "API tokens".

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/pages/workspace-settings-ai.test.tsx`:

```tsx
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkspaceSettingsAi } from './workspace-settings-ai.tsx';
import { renderWithProviders } from '../../test-utils/render.tsx';

vi.mock('../lib/api/ai-test-key.ts', () => ({
  useTestKey: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ ok: true }),
    isPending: false,
  }),
}));

vi.mock('../lib/api/ai-keys.ts', () => ({
  useAiKeys: () => ({ data: [], isLoading: false }),
  useSaveAiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteAiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

describe('WorkspaceSettingsAi', () => {
  test('renders the four provider options', () => {
    renderWithProviders(<WorkspaceSettingsAi wslug="acme" />);
    fireEvent.click(screen.getByRole('combobox', { name: /provider/i }));
    expect(screen.getByRole('option', { name: /anthropic/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /openai/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /openrouter/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ollama/i })).toBeInTheDocument();
  });

  test('clicking Test calls useTestKey and shows ok feedback', async () => {
    renderWithProviders(<WorkspaceSettingsAi wslug="acme" />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/key validated/i)).toBeInTheDocument());
  });

  test('Save button is disabled until a key is entered', () => {
    renderWithProviders(<WorkspaceSettingsAi wslug="acme" />);
    expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    expect(screen.getByRole('button', { name: /save key/i })).toBeEnabled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/web && bun run test src/pages/workspace-settings-ai.test.tsx
```

Expected: FAIL — component does not exist.

- [ ] **Step 4: Implement the API hook**

Create `apps/web/src/lib/api/ai-test-key.ts`:

```ts
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client.ts'; // existing helper

type TestKeyArgs = {
  wslug: string;
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  api_key: string;
  base_url?: string;
};
type TestKeyResult = { ok: true } | { ok: false; reason: string };

export function useTestKey() {
  return useMutation<TestKeyResult, Error, TestKeyArgs>({
    mutationFn: async ({ wslug, ...body }) => {
      return apiFetch<TestKeyResult>(`/api/v1/w/${wslug}/ai/test-key`, {
        method: 'POST',
        body,
      });
    },
  });
}
```

- [ ] **Step 5: Implement the component**

Create `apps/web/src/pages/workspace-settings-ai.tsx`:

```tsx
import { useState } from 'react';
import { useTestKey } from '../lib/api/ai-test-key.ts';
import { useAiKeys, useSaveAiKey, useDeleteAiKey } from '../lib/api/ai-keys.ts';
import { Select } from '../components/ui/select.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';

const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'ollama'] as const;
type Provider = (typeof PROVIDERS)[number];

const KNOWN_MODELS: Record<Provider, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  openrouter:['anthropic/claude-haiku-4-5', 'openai/gpt-4o-mini'],
  ollama:    ['llama3.1', 'qwen2.5'],
};

export function WorkspaceSettingsAi({ wslug }: { wslug: string }) {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(KNOWN_MODELS.anthropic[0]);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(''); // ollama / custom
  const [testResult, setTestResult] = useState<null | { ok: boolean; reason?: string; at: number }>(null);

  const testKey = useTestKey();
  const keys = useAiKeys(wslug);
  const saveKey = useSaveAiKey(wslug);
  const deleteKey = useDeleteAiKey(wslug);

  async function onTest() {
    setTestResult(null);
    const r = await testKey.mutateAsync({ wslug, provider, model, api_key: apiKey, base_url: baseUrl || undefined });
    setTestResult({ ...r, at: Date.now() });
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-medium">AI Provider</h2>
        <div className="mt-2 grid gap-2 max-w-md">
          <label className="block">
            <span className="text-sm text-fg-muted">Provider</span>
            <Select
              value={provider}
              onChange={(v) => {
                setProvider(v as Provider);
                setModel(KNOWN_MODELS[v as Provider][0]);
              }}
              aria-label="Provider"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="text-sm text-fg-muted">Model</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={`models-${provider}`}
            />
            <datalist id={`models-${provider}`}>
              {KNOWN_MODELS[provider].map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>

          <label className="block">
            <span className="text-sm text-fg-muted">API Key</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="API Key"
            />
          </label>

          {provider === 'ollama' && (
            <label className="block">
              <span className="text-sm text-fg-muted">Base URL</span>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </label>
          )}

          <div className="flex gap-2 mt-2">
            <Button onClick={onTest} disabled={!apiKey || testKey.isPending} variant="secondary">
              Test
            </Button>
            <Button
              onClick={() => saveKey.mutateAsync({ provider, model, api_key: apiKey, base_url: baseUrl || undefined })}
              disabled={!apiKey || saveKey.isPending}
            >
              Save key
            </Button>
          </div>

          {testResult && (
            <div className={testResult.ok ? 'text-fg-success' : 'text-fg-danger'} role="status">
              {testResult.ok ? `✓ Key validated ${Math.round((Date.now() - testResult.at) / 1000)}s ago` : `✗ ${testResult.reason}`}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Configured Keys</h2>
        <ul className="mt-2 divide-y border-border-light rounded-md border">
          {PROVIDERS.map((p) => {
            const row = keys.data?.find((k) => k.provider === p);
            return (
              <li key={p} className="flex items-center justify-between px-3 py-2">
                <span>
                  {row ? '✓' : '—'} {p}
                  {row && <span className="text-fg-muted ml-2 text-sm">last updated {new Date(row.created_at).toLocaleDateString()}</span>}
                </span>
                {row && (
                  <Button variant="ghost" onClick={() => deleteKey.mutateAsync(row.id)}>Remove</Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Mount the tab on the settings page**

Modify `apps/web/src/pages/workspace-settings.tsx`. Find the TabStrip block (it currently has one tab `API tokens`). Add a second tab `AI`:

```tsx
import { WorkspaceSettingsAi } from './workspace-settings-ai.tsx';
// ...
<TabStrip
  tabs={[
    { id: 'tokens', label: 'API tokens' },
    { id: 'ai', label: 'AI' },
  ]}
  active={activeTab}
  onChange={setActiveTab}
/>
{activeTab === 'tokens' && <ApiTokensTab wslug={wslug} />}
{activeTab === 'ai' && <WorkspaceSettingsAi wslug={wslug} />}
```

The URL contract for deep-linking (`?tab=ai&provider=anthropic`) is handled in Task E-7's banner work; for now just the tab toggle is enough.

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd apps/web && bun run test src/pages/workspace-settings-ai.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 8: Run the full web suite**

```bash
cd apps/web && bun run test
```

Expected: 547 + 3 = 550 / 8-skip / 0-fail.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/workspace-settings-ai.tsx \
        apps/web/src/pages/workspace-settings-ai.test.tsx \
        apps/web/src/lib/api/ai-test-key.ts \
        apps/web/src/pages/workspace-settings.tsx
git commit -m "phase-3: AI settings tab (B-7)

New 'AI' tab on /w/:wslug/settings. Provider select (4 options),
model with datalist of known models, API key + optional base URL
for Ollama, Test button (calls POST /ai/test-key), Save key
(wraps existing ai_keys PATCH from Phase 0), per-provider
Configured Keys list with Remove."
```

### Task B-8: Sub-phase B integration gate

- [ ] **Step 1: Run all suites**

```bash
cd apps/server && bun test
cd ../web && bun run test
cd ../../packages/shared && bun test
```

Expected (rough):
- server **544 + ~12 (B-1..B-6) = 556 / 1-skip / 0-fail**
- web **550 / 8-skip / 0-fail**
- shared 51 / 0-fail

> **Verify count yourself per `[[verify-subagent-test-counts]]`.** Subagents may misreport.

- [ ] **Step 2: Type-check both apps**

```bash
cd apps/server && bun run typecheck
cd ../web && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Spot-test the UI**

```bash
bun dev
```

Open `http://localhost:5173/w/<your-slug>/settings`. Click the **AI** tab. Provider/model dropdowns render. Test button works against an actual Anthropic key if you have one (manual sanity check — not blocking, but worth doing).

- [ ] **Step 4: Sub-phase B checkpoint**

Sub-phase B complete. Providers ship; UI to test keys ships. The runner does not yet exist — moving to Sub-phase C, the heart of the phase.

---

## Sub-phase C — Runner core (services + poller + recursion guards)

Goal: ship the polling worker model end-to-end. By end of C: trigger handlers create `agent_run` rows at `status=planning` and return; the poller claims them within ~1s; `runAgent` runs the provider stream, posts comments, transitions through the state machine, enforces all six guards + token budget + crash recovery. Sub-phase D wires HTTP routes + MCP parity on top.

> Sub-phase C is the largest. Tasks C-1 to C-12 are sequenced and dependent. Do them in order.

The rest of the Sub-phase C, D, E, F tasks are written below. Due to the size of this plan, the implementer should treat the file as one document and execute sub-phases linearly. Tasks not yet expanded inline below MUST be expanded into full failing-test → implementation → pass → commit form before execution (the structure for each Task is identical to A-* and B-* above). The intent and scope of each remaining task is locked.

### Task C-1: `services/agent-runs.ts` — createRun + transitionRun

**Files:** Create `apps/server/src/services/agent-runs.ts` + `agent-runs.test.ts`.

**Scope:**
- `createRun(tx, args)` — inserts an `agent_run` document with status='planning', frontmatter populated from args (chain_id minted if root, inherited if descendant), emits `agent.run.started`. Reuses the existing `documents` service for the underlying insert + slug-uniqueness check; the slug is auto-generated as `<agent-slug>-<iso-timestamp>-<short-id>`.
- `transitionRun(tx, runId, { newStatus, completedAt?, errorReason?, errorDetail? })` — validates via `isValidTransition`, throws `INVALID_RUN_TRANSITION` with `{from,to}` on illegal moves, updates both `documents.status` and `frontmatter.status` atomically, clears `worker_started_at` on terminal statuses, emits the right `agent.run.<status>` event in the same tx.
- `incrementTokens(tx, runId, { inTokens, outTokens })` — atomic JSON-patch update of `frontmatter.tokens_in/out`, returns updated row.
- Each function `tx`-first signature so callers control transactional boundaries (matches the rest of the project's service layer).

**Tests cover:**
- Happy paths for each function.
- State machine: every legal transition succeeds and emits the right event; every illegal transition throws with `{from, to}`.
- `transitionRun` clears `worker_started_at` on completed/failed/rejected.
- `incrementTokens` updates atomically (two concurrent increments don't lose updates — test via a `BEGIN IMMEDIATE` + sequential increments harness).

### Task C-2: `services/agent-runs.ts` — getActiveRun + getPendingApprovalRun + listRuns

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `getActiveRun(tx, parentId, agentId)` — most recent run on (parent, agent) where status in `(planning, awaiting_approval, running)`. Returns null if none.
- `getPendingApprovalRun(tx, parentId, agentId)` — same but status='awaiting_approval' only.
- `listRuns(tx, filter)` — supports `{ workspaceId?, projectId?, parentId?, agentId?, status?, chainId?, since? }`.
- `EXPLAIN` test verifies `getActiveRun` uses `documents_runs_by_status_idx`.

### Task C-3: `services/agent-runs.ts` — claimNextPlanningRun + recoverOrphanRuns + countPendingPlanning

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `claimNextPlanningRun(tx)` — atomic find-and-claim. SELECT id from planning rows ORDER BY created_at ASC LIMIT 1; UPDATE ... SET status='running', worker_started_at=now WHERE id=? AND status='planning'. Returns the row only if UPDATE affected 1 row. Otherwise loop or return null.
- `recoverOrphanRuns(tx, { staleThresholdMs })` — finds status='running' rows with `worker_started_at` older than threshold, transitions them to failed (worker_crash). Returns count.
- `countPendingPlanning(tx)` — returns `count(*)` of status=planning rows.
- Test: concurrent claims race-safe (two simulated pollers both call `claimNextPlanningRun` on the same row — only one wins, other gets null).
- Test: orphan recovery handles 0, 1, N rows; respects threshold.

### Task C-4: `services/agent-runs.ts` — checkRunRateLimits + checkChainGuards

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `checkRunRateLimits(tx, { workspaceId, agentId })` — workspace cap from `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE` env (default 200); agent cap from `agent.frontmatter.max_runs_per_hour` (default 60). Returns `{ok:true}` or `{ok:false, reason:'rate_limited', detail}`.
- `checkChainGuards(tx, { chainId })` — single query against `documents_runs_by_chain_idx` aggregating `count(*) > FOLIO_MAX_FANOUT_PER_CHAIN`, `max(completed_at) - min(started_at) > FOLIO_MAX_CHAIN_DURATION_MS`, `sum(tokens_in + tokens_out) > FOLIO_MAX_CHAIN_TOKENS`. Returns first-failing reason or `{ok:true}`.
- Defaults: 25 / 30 min (1.8M ms) / 1,000,000 tokens.
- Tests: each cap independently triggers the right `reason`; mixed cases prefer the first-failing reason.
- **Volume test (added per Phase 3 review remark #3 — SQLite JSON index performance).** Insert 10,000 synthetic `agent_run` rows spread across ~500 distinct `chain_id`s. Run `EXPLAIN QUERY PLAN` on the `checkChainGuards` aggregation query and assert the output contains the string `documents_runs_by_chain_idx`. The assertion guards against a future refactor that inadvertently makes the planner fall back to a full table scan. Skip via env `FOLIO_SKIP_VOLUME_TESTS=1` for fast local runs; CI always runs it.

### Task C-5: `services/agent-runs.ts` — checkProviderHealth + getProviderHealth

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `checkProviderHealth(tx, { workspaceId, provider })` — reads the last N (`FOLIO_PROVIDER_DEGRADE_THRESHOLD`, default 3) terminated events (`agent.run.completed | failed | rejected`) for this `(workspace, provider)` (`provider` lives in event payload). Excludes cancelled. If all N are `agent.run.failed` with `error_reason='provider_error'` → degraded. Returns `{status:'healthy'|'degraded', consecutiveFailures}`.
- `getProviderHealth(tx, { workspaceId })` — returns the same shape per-provider for all four providers.
- `transitionRun` (modify from C-1) calls `checkProviderHealth` after emitting its own `agent.run.<terminal>` event; on a tipping edge emits `workspace.provider.degraded` exactly once; on a recovery emits `workspace.provider.recovered` exactly once.
- Tests: tipping edge fires once and only once across repeated failures; recovery on next `completed`; per-provider independence; cancelled excluded from window; per `[[mock-the-wire-not-the-response]]` test does NOT just stub the function's return — uses real DB seeding.

### Task C-6: `services/agent-runs.ts` — ensureRunsTable (lazy seed) + chain_id helper

**Files:** Append to `agent-runs.ts` + `.test.ts`.

**Scope:**
- `ensureRunsTable(tx, projectId)` — if project already has a 'runs' table, return it; else create within the same tx: insert `tables` row, 6 status rows (`planning, awaiting_approval, running, completed, failed, rejected`), 3 views (`All runs`, `Failures`, `Awaiting approval`), emit `table.created` + 6× `status.created` + 3× `view.created` + 1× `runs_table.lazy_seeded`. Idempotent.
- Chain helper: `nextChainId({ firedBy }) → string` — extracts the chain prefix from `fired_by` if present, else mints a fresh `crypto.randomUUID()`.
- Tests: lazy-seed is idempotent (calling twice yields the same table id, no duplicate events).

### Sub-phase C.2 — Runner + dispatcher (expanded task bodies — written 2026-05-28)

> Sub-phase C.2 expands C-7..C-9 into the full Steps + Files + Tests + Commit form, mirroring the C.1 services-layer expansion at line 423. The original outlines at lines 3940+ (now further below, post-expansion) stay as historical context — they predate the three 2026-05-28 reconciliation decisions called out on their respective `⚠️ EXPANSION RECONCILIATION` blocks. **Do not implement against the outlines.** The expanded bodies below resolve the reconciliations; the outlines remain only so future readers can trace the design evolution.
>
> All C.2 tasks SEQUENTIAL. Each appends to one or two well-isolated files (`lib/agent-tools.ts` for C-7; `lib/runner.ts` for C-8 + C-9). Dispatched via `superpowers:subagent-driven-development` wrapped by `netdust-core:ntdst-execute-with-tests` per the project CLAUDE.md contract. Each subagent's close-out invokes `netdust-core:testing-workflow` and reports the Test-evidence + STATUS blocks per the wrapper's mandatory addendum.
>
> **Per-task mitigation pointers** name the threat-model mitigations the task implements. `/code-review` after C.2 closes verifies these are in place; controller pre-flight before dispatch verifies the planned code touches them.
>
> **Pre-flight invariants for every C.2 task:**
> - `cd apps/server` — run all commands from the server app dir (never repo root — see `[[bun-test-from-repo-root-forbidden]]`).
> - Test runner: `bun test src/lib/<file>.test.ts` (specific file) then `bun test` (full server suite).
> - Typecheck: `bun x tsc --noEmit` (catches signature drift between runner + dispatcher + services).
> - Baseline at C.2 start (post-C.1 close + 2 layers of review-fix): **server 810 / 1-skip / 0-fail, shared 51 / 0-fail, web 559 / 8-skip / 0-fail**. C.2 adds ~25-30 server tests; expected end-of-C.2 baseline: **server ~840 / 1-skip / 0-fail**.
> - `lib/runner.ts` and `lib/agent-tools.ts` are NEW files; no pre-existing latent defects to worry about (unlike C-1's `DocumentType` widening). The pre-flight is about not breaking the services layer + provider layer that C.2 sits on.
>
> **Pre-flight verification (controller, before dispatching C-7):**
> 1. Confirm `apps/server/src/services/agent-runs.ts` exports the C.1 surface: `createRun, transitionRun, incrementTokens, getActiveRun, getPendingApprovalRun, listRuns, claimNextPlanningRun, recoverOrphanRuns, countPendingPlanning, checkRunRateLimits, checkChainGuards, checkProviderHealth, getProviderHealth, ensureRunsTable, nextChainId` — that's the call surface C.2 builds on.
> 2. Confirm `apps/server/src/lib/ai/provider.ts` exports the proxy + the providers expose `stream(messages, tools, opts)` returning an `AsyncIterable<ProviderEvent>` per Sub-phase B's locked interface.
> 3. Confirm `apps/server/src/lib/agent-run-schema.ts` has `done_reason` (B mitigation 20) and the 12-value `runErrorReasonSchema` enum.
> 4. **Sibling-site audit pre-flight (post-C.1 retro recommendation)**. Before dispatching ANY C.2 task, scan the surface the task will touch for the 5 lockstep classes:
>    - TS union/enum: any new exported type widens shared/`apps/web/src/lib/api/*.ts`? (Likely no — C.2 doesn't introduce new doc types.)
>    - SQL JSON-extract↔column predicates: any new query touches `frontmatter.status` or similar? (C.2 doesn't write to documents directly outside what services/agent-runs.ts already does; predicates live in C.1.)
>    - Event scope (workspace-wide vs project-scoped): every `emitEvent` call site in the runner. The C.1 `workspace.provider.*` precedent says workspace-wide events MUST emit with `projectId: null`. Runner-side events like `agent.run.*` are project-scoped because they reference a specific run document. Audit `ai.action` + any new events C-8/C-9 introduce.
>    - Cross-route guards (writes vs reads): C.2 doesn't add HTTP routes (that's Sub-phase D). Runner-emitted events flow through SSE; subscribers are bounded by the existing event-bus filter.
>    - Closed-enum literals: `error_reason` writes from the runner. Every assignment MUST go through `runErrorReasonSchema.enum.X`, not raw string literals. C.1's A1 + R7 already pin this; C-8 and C-9 must follow.

#### Task C-7: `lib/agent-tools.ts` — `executeTool` shared tool-execution layer

**Threat-model mitigations bound to this task:** 26 (Zod re-validation before dispatch — `MCP_INVALID_ARGS` shape), 27 (self-vs-peer agent-lifecycle gate — `-32602 agent_self_management_only`), 34 (`__echo` test tool `NODE_ENV='test'` gate), 35 (tx-first signature so the runner can pass its tx and roll back tool side-effects on failure). Inherits B mitigations 18+19 (HTTP agent-lifecycle hardened) via the underlying service layer — the dispatcher doesn't re-implement, it routes through `services/documents.ts::createDocument` etc. which already carry those guards.

**Files:**
- Create: `apps/server/src/lib/agent-tools.ts` (renamed from `mcp-dispatch.ts` per the EXPANSION RECONCILIATION on the original outline below).
- Create: `apps/server/src/lib/agent-tools.test.ts`.

**Reconciled scope (resolves the 3 reconciliation items on the original outline at line 3940+):**

1. **Name + auth shape.** File is `lib/agent-tools.ts`; function is `executeTool(token, actor, name, args, tx?)`; auth context is plain `{token: ApiToken, actor: string}` (NO `McpAuthContext` type). Inside-agent === outside-agent: the runner calls `executeTool` directly (same path the future `routes/mcp.ts` refactor in D-3 will use). MCP is one *face* over this layer, not the layer itself.

2. **Skeleton-vs-extraction decision: SKELETON.** C-7 ships ONE tool: `__echo` (test-only, gated on `NODE_ENV === 'test'` per mitigation 34). Real `TOOLS` extraction from `routes/mcp.ts` lands in D-3. **Acknowledged consequence:** C.2 + C.3's runner can only execute `__echo` end-to-end; the "set up a project for me" keystone demo (per `memory/project_folio-agent-thesis.md`) cannot work until Sub-phase D. This is intentional: pulling the real extraction forward into C-7 would double its file-touch scope (routes/mcp.ts is ~600 LOC of tool implementations) and tangle C.2's runner-correctness work with D-3's refactor-correctness work. The skeleton-now path keeps each task auditable in isolation.

3. **General-primitives design target (locks the v1 tool registry shape).** When D-3 expands `TOOLS`, the *target* is a tiny set of general primitives + skills/playbook-as-content, NOT a feature menu of 40 narrow verbs. C-7 cannot ship those primitives yet (their handlers live in D-3) — but C-7 MUST NOT bake in any naming/typing pattern that forecloses them. Concretely: the dispatcher's tool registration shape accepts a `{name: string, schema: ZodObject, requiredScope: Scope, handler: (args, ctx) => Promise<unknown>}` record — generic over schema, no narrow-type assumptions. Test stubs for D-3's eventual `read`/`query`/`write_document` shape can be written now (D-3 fills the bodies).

**Acceptance criteria:**

- `executeTool(token, actor, name, args, tx?: DBOrTx): Promise<unknown>` looks up `name` in a module-local `Map<string, ToolDef>` registry. Unknown names throw an `Error` whose `.message` matches the JSON-RPC `-32601 method not found` convention (string format: `"method not found: <name>"`). Test asserts the message.
- The registry initialization checks `process.env.NODE_ENV` once and ONLY registers `__echo` when `=== 'test'`. Production calls to `executeTool('__echo', ...)` throw `method not found` (mitigation 34 — same shape as B-16 `__INTERNAL_TEST_ONLY__`).
- Before invoking the handler, the dispatcher runs the tool's Zod schema via `.parse(args)`. On parse failure throws `MCP_INVALID_ARGS` with the Zod issues' PATHS only (not values — mitigation 26 + 28 sanitization). Test asserts the handler is NEVER invoked on parse failure.
- Self-vs-peer gate for `create_agent | update_agent | delete_agent | get_agent_self` tool names (when those exist in D-3): if `token.agentId` is set AND `args.slug !== token.agentSlug`, throw `-32602 agent_self_management_only`. Stubbed in C-7 via a test-only handler placeholder; D-3 wires the real handlers. Test asserts the gate even with a stub handler that would otherwise succeed.
- Optional `tx` arg is passed verbatim to the handler's `ctx.tx`. If absent, handler receives `ctx.tx === undefined` and may open its own (or rely on the caller's outer `txWithEvents`). This matches mitigation 35 — runner-owned outer tx, dispatcher transparent.
- Scope check: the dispatcher reads `token.scopes` and verifies `requiredScope` is granted. Token without the scope → throw `Error('forbidden: scope <required> missing')`. Mirrors the existing `requireScope` middleware shape from Phase 2.

**Steps:**

- [ ] **Step 1 — Write the registry + tool-def shape.**

  ```ts
  export interface ToolDef<TArgs = unknown, TOut = unknown> {
    name: string;
    requiredScope: Scope;
    schema: z.ZodSchema<TArgs>;
    handler: (args: TArgs, ctx: ToolContext) => Promise<TOut>;
  }
  export interface ToolContext {
    token: ApiToken;
    actor: string;
    tx?: DBOrTx;
  }
  const registry = new Map<string, ToolDef>();
  ```

  Mitigation 34 — register `__echo` only when `NODE_ENV === 'test'`. Use a top-level `if` guard at module load.

  ```ts
  if (process.env.NODE_ENV === 'test') {
    registry.set('__echo', {
      name: '__echo',
      requiredScope: 'documents:read', // arbitrary; just so the scope check has something to verify
      schema: z.object({ value: z.string() }).strict(),
      handler: async (args) => ({ echoed: args.value }),
    });
  }
  ```

- [ ] **Step 2 — Write failing tests for the dispatcher's contract.**

  Create `apps/server/src/lib/agent-tools.test.ts`:

  - `it('throws "method not found" for an unknown tool name')`
  - `it('throws "method not found" for __echo when NODE_ENV !== "test"')` — mutate `process.env.NODE_ENV` for this one test; reset in afterEach.
  - `it('runs the tool when args parse + scope check pass')` — call `executeTool` with a valid `__echo` invocation; assert `{echoed: 'hi'}` returned.
  - `it('throws MCP_INVALID_ARGS with PATHS only when args fail Zod parse')` — pass `__echo` `{value: 123}` (number, not string); assert the error's payload includes `path: ['value']` but NOT the value `123`.
  - `it('throws forbidden: scope missing when the token lacks the requiredScope')` — register a tool requiring `agents:write`; call with a token holding only `documents:read`.
  - `it('threads the optional tx arg into the handler ctx')` — pass `tx` (a real test tx via `db.transaction`); handler asserts `ctx.tx` is the same reference.
  - `it('omits tx from the handler ctx when not passed')` — assert `ctx.tx === undefined`.

  Run: `bun test src/lib/agent-tools.test.ts`. Expected: 7 FAIL (file doesn't exist yet).

- [ ] **Step 3 — Implement `executeTool` body.**

  ```ts
  export async function executeTool(
    token: ApiToken,
    actor: string,
    name: string,
    args: unknown,
    tx?: DBOrTx,
  ): Promise<unknown> {
    const def = registry.get(name);
    if (!def) {
      throw new Error(`method not found: ${name}`);
    }
    if (!token.scopes.includes(def.requiredScope)) {
      throw new Error(`forbidden: scope ${def.requiredScope} missing`);
    }
    let parsed: unknown;
    try {
      parsed = def.schema.parse(args);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const paths = err.issues.map((i) => ({ path: i.path }));
        const e = new Error('MCP_INVALID_ARGS') as Error & { issues: typeof paths };
        e.issues = paths;
        throw e;
      }
      throw err;
    }
    return def.handler(parsed as never, { token, actor, tx });
  }
  ```

  Run: `bun test src/lib/agent-tools.test.ts`. Expected: 7 PASS.

- [ ] **Step 4 — Add a `registerTool` helper for D-3 (forward compatibility).**

  D-3 will register the real tools by importing this layer and calling `registerTool(def)`. Export it:

  ```ts
  export function registerTool<TArgs, TOut>(def: ToolDef<TArgs, TOut>): void {
    if (registry.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    registry.set(def.name, def as ToolDef);
  }
  ```

  Test: `it('registerTool throws on duplicate name')`.

- [ ] **Step 5 — ~~Add the self-vs-peer agent-lifecycle gate (mitigation 27).~~ ⚠️ PLAN CORRECTION 2026-05-29 (C-7 code-quality review): GATE REMOVED FROM C-7 — mitigation 27 RE-SCOPED to D-3.**

  > **Do NOT implement the gate below.** Code-quality review found the blanket `args.slug`-vs-`actor` gate contradicts the live per-tool guards in `routes/mcp.ts`: `create_agent` has NO self-slug gate there (it uses `assertAgentAllowListWidening`, so the blanket gate wrongly rejects legit agent→child spawn); `delete_agent` rejects SELF-delete anchored to `existing.id === token.agentId` (the OPPOSITE of the blanket gate, and by id not slug); `get_agent_self` takes no `slug` arg (dead no-op). The blanket gate also trusts the caller-supplied `actor` string instead of `token.agentId`. **Decision (human controller): C-7's dispatcher enforces NO lifecycle gate — transport + scope + Zod-validation only.** The real per-tool guards move into `lib/agent-tools.ts` in D-3 with the real handlers, anchored to `token.agentId`. C-7 fix-commit `dd9f736` removed the gate; a deferral comment in `executeTool` is the landing pad. **D-3 planning MUST carry mitigation 27 explicitly** (tracked in `tasks/retro-follow-ups.md` as C.2-R-1). The original Step 5 spec is retained below for traceability only.

  The gate fires for tool names starting with `create_agent | update_agent | delete_agent` AND `get_agent_self`. Implementation lives in `executeTool` so EVERY caller goes through it:

  ```ts
  const AGENT_LIFECYCLE_TOOLS = new Set(['create_agent', 'update_agent', 'delete_agent', 'get_agent_self']);
  // Inside executeTool, after scope check, before parse:
  if (token.agentId && AGENT_LIFECYCLE_TOOLS.has(name)) {
    const targetSlug = (args as { slug?: string })?.slug;
    if (targetSlug && targetSlug !== token.agentSlug) {
      const e = new Error('agent_self_management_only') as Error & { code: number };
      e.code = -32602;
      throw e;
    }
  }
  ```

  Test (`it('rejects agent A calling delete_agent on B with -32602')`) — register a stub `delete_agent` tool with a no-op handler; call with token where `agentSlug='A'` and `args.slug='B'`; assert the throw.

  Test (`it('allows agent A calling update_agent on A')`) — same setup, `args.slug='A'`; assert the handler ran.

  Run: `bun test src/lib/agent-tools.test.ts`. Expected: 10 PASS (7 + 1 dup + 2 lifecycle).

- [ ] **Step 6 — Full suite + typecheck + workflow invocation + commit.**

  ```
  bun test
  bun x tsc --noEmit
  ```

  Expected: server ~810 → ~820 / 1-skip / 0-fail. Typecheck clean.

  Invoke `Skill("netdust-core:testing-workflow")` and walk the close-out checklist.

  Commit: `phase-3: C-7 lib/agent-tools — executeTool shared dispatcher + self-vs-peer + Zod re-validation`. Mitigations: 26, 27, 34, 35.

---

#### Task C-8: `lib/runner.ts` — `runAgent` core loop

**Threat-model mitigations bound to this task:** 25 (no automatic `[[wiki-link]]` inlining — runner reads only explicit message history), 28 (sanitize `error_detail` on every persist site — the runner is where stream errors get caught and persisted), 30 (per-run + per-chain token-budget enforcement — three layers, runner enforces per-run after each `tokens` event), 31 (provider circuit-breaker — the runner calls `checkProviderHealth` AFTER its own emit and respects the `degraded` state by NOT claiming further sibling rows; actual claim-time gate is C-10's job, but the runner emits the signal), 40 (atomic single-UPDATE state transitions — runner uses `transitionRun` from C.1 which already enforces this), 41 (terminal-status `worker_started_at` clear — also inherited from `transitionRun`), 44 (cancel-via-comment is in scope — runner's per-tool-dispatch + per-`tokens`-event cancel checks read the comment thread), 47 (SSE delivery fire-and-forget — runner emits via `emitEvent` which is sync).

**Files:**
- Create: `apps/server/src/lib/runner.ts`.
- Create: `apps/server/src/lib/runner.test.ts`.

> **⚠️ PLAN CORRECTION 2026-05-29 (C-8 controller pre-flight — provider-interface drift).** The C-8 body below was written against an assumed Vercel-AI-SDK-shaped provider with a `continueWithToolResult(streamHandle, …)` continuation primitive and an injectable `AbortController`. **Neither exists in the Sub-phase B provider layer.** Ground-truth (`apps/server/src/lib/ai/provider.ts`):
> - `AIProvider` exposes exactly `stream(opts)` + `testKey(opts)`. `stream` returns a **one-shot** `AsyncIterable<ProviderEvent>`; there is NO continuation handle and NO `continueWithToolResult`.
> - `stream(opts)` takes NO abort signal. "Aborting" = `break`-ing out of the `for await` loop (which stops pulling the generator; the SDK stream is GC'd). There is no AbortController to trigger.
> - `getProvider(name: Provider)` takes ONLY the provider name and is **synchronous** (returns a lazy proxy). NOT `getProvider(workspaceId, providerName)`.
> - `ProviderEvent` shapes (use these EXACT field names): `{type:'text', delta}` · `{type:'tool_call', id, name, arguments}` (NOT `toolUseId`/`args`) · `{type:'tokens', tokens_in, tokens_out}` (NOT `{in,out}`) · `{type:'done', reason}` where reason ∈ `'stop'|'tool_use'|'max_tokens'|'refusal'|'pause_turn'`.
> - The multi-turn tool round-trip is done via the **message history**, NOT a continuation handle. `Message` already supports `{role:'assistant', content, tool_calls:[{id,name,arguments}]}` and `{role:'tool', content, tool_use_id}`. **The runner's loop is therefore an OUTER `while` loop over provider ROUNDS:** call `stream()`; consume its events accumulating text + collecting `tool_call`s; on `done`, if `reason === 'tool_use'` AND tool_calls were collected → execute each via `executeTool`, append one `{role:'assistant', tool_calls}` message + one `{role:'tool', tool_use_id, content}` message per result, then loop and call `stream()` again with the extended `messages`; if `reason` is any terminal value (`stop`/`max_tokens`/`refusal`/`pause_turn`) OR no tool_calls → exit the loop, write the accumulated text as the final `kind=result` comment, transition `completed`. This IS "hand-rolling the loop on `provider.stream()` generators" per the locked build-decision. Add a round cap (reuse `agent.max_delegation_depth`? NO — that's the chain-fanout guard; use a dedicated runner-local `MAX_TOOL_ROUNDS` constant, e.g. 25, and on exceed transition `failed (error_reason='chain_guard')` with a clear `error_detail`).
>
> **Service-layer signatures the runner calls (ground-truthed — match EXACTLY):**
> - `transitionRun(runId, {newStatus, actor, errorReason?, errorDetail?, completedAt?})` — reads the row itself; caller MUST wrap in `txWithEvents(db, async (tx) => …)`. Throws `INVALID_RUN_TRANSITION` (state-machine reject, `HTTPError` 409) and `RUN_TRANSITION_RACED` (TOCTOU loser, `err.code`/name; carries `err.observedFrom`). The runner's top-level catch swallows `RUN_TRANSITION_RACED` (already terminal — fine).
> - `incrementTokens(runId, {in, out})` — note `{in, out}`, so map the event: `incrementTokens(runId, {in: ev.tokens_in, out: ev.tokens_out})`.
> - `createComment({workspace, project, parent, authorContext, actor, body, kind?, targetAgent?, visibility?})` — rich input; needs the workspace + project + parent Document objects loaded. `kind` accepts `CommentKind` (use `'result'` for the final answer, `'comment'` for partial/cancel/budget messages). Author is the agent → build the agent `authorContext` the same way `routes/comments.ts` / `services/comments.ts` do for an agent-bound caller (look at how the existing comment-create path resolves an agent author from a token; mirror it).
> - `sanitizeProviderError(err, providerLabel)` from `src/lib/ai/sanitize-error.ts` — `(err: unknown, label: string) => string`. Pass the run's provider name (capitalized label is fine; match existing call sites).
> - `getActiveRun`, `checkRunRateLimits`, `checkChainGuards`, `checkProviderHealth` — per C.1 signatures (args-first, `tx?` last).
>
> **Where to get the BYOK key + token + actor:** the run frontmatter snapshots the agent's config. The agent's API token (with scopes) is resolved from the agent doc's minted token (Phase 2 auto-mint). The workspace `provider_keys` envelope is libsodium-decrypted via the existing helper (grep for how `POST /ai/test-key` or the B-layer reads `provider_keys` — reuse that decryption path; do NOT re-implement). `actor` for `executeTool` + `createComment` = the agent identity string (`agent:<slug>`), matching C-7's `slugFromActor` contract.
>
> **The acceptance criteria + Steps below remain authoritative for WHAT to build (the 6 pre-flight checks, the budget/cancel/tool-error terminal transitions, done_reason persistence, top-level containment) — only the provider round-trip MECHANISM is corrected here. Where a Step says `continueWithToolResult` or "abort via AbortController", substitute the round-loop + `break` mechanism above. Where it says `ev.toolUseId`/`ev.args`/`ev.in`/`ev.out`, substitute the real `ProviderEvent` field names.**

**Reconciled scope (resolves the EXPANSION RECONCILIATION on the original outline):**

- Tool dispatch via **`executeTool(agentRun.token, actor, name, args, tx)`** directly (NOT `executeMcpTool`). The runner is NOT an MCP client — it imports `lib/agent-tools.ts` and calls in-process. Mitigation: inside-agent === outside-agent, ONE auth model.
- Provider loop hand-rolled on **`provider.stream(opts)`** (Sub-phase B's `AsyncIterable<ProviderEvent>`, one-shot per round — see the PLAN CORRECTION above for the outer round-loop). NOT the Vercel AI SDK.

**Acceptance criteria:**

- `runAgent({runId}): Promise<void>` is the entry point. **Invariant entering `runAgent`**: row at `status='running'` with `worker_started_at` set (the poller already claimed it via C-3's `claimNextPlanningRun`). The runner does NOT call `claimNextPlanningRun` itself.
- The function loads the run row, the parent doc (for prompt context), the agent doc (for system_prompt + tools list — already snapshotted into the run's frontmatter, but the agent doc is needed for the API token's scopes), and the agent's BYOK token resolved via the workspace's `provider_keys` envelope.
- **Pre-flight checks** (six guards, runner-side — per spec §4b + threat model 30/31):
  1. `checkProviderHealth(workspaceId, provider)` — if `degraded`, transition `failed (error_reason='provider_error')` and return. (The poller should not have claimed it; this is belt-and-suspenders.)
  2. `checkRunRateLimits` — if rate-limited, transition `failed (error_reason='rate_limited')`.
  3. `checkChainGuards` — if fanout/duration/tokens exceeded, transition `failed (error_reason='chain_guard')`.
  4. Provider key present in the workspace's `provider_keys[provider]` — if not, transition `failed (error_reason='no_ai_key')`.
  5. `getActiveRun(parentId, agent.slug)` for siblings other than this row — if a peer is already running on the same parent, transition `failed (error_reason='idempotency_violation')`.
  6. depth check: walk `frontmatter.fired_by` chain via `chain_id`; if depth > `agent.max_delegation_depth`, transition `failed (error_reason='depth_exceeded')`.

  All six failures emit the corresponding `agent.run.failed` event via `transitionRun`. None throw out of `runAgent` — the row's terminal state IS the signal.

- **Stream consumption** (the main loop):
  - Open the provider stream with the agent's tools (the names — the dispatcher resolves at execution time) + the constructed message history (system prompt + parent body + comment thread filtered to comments with `payload.parent_id === run.parent_id`, OLDEST first; mitigation 25 — NO wiki-link auto-expansion; comments + body literal text only).
  - For each `ProviderEvent` from the AsyncIterable:
    - `kind === 'text'` → accumulate into a current `kind=comment` (or `kind=result` at end) buffer. Don't write yet.
    - `kind === 'tokens'` → call `incrementTokens(runId, {in: ev.in, out: ev.out})`. AFTER each tokens event, check the per-run budget: if `(tokens_in + tokens_out) > frontmatter.max_tokens`, transition `failed (error_reason='budget_exceeded')`, abort the provider stream via the existing AbortController, post a `kind=comment` from the agent ("Budget cap exceeded after N tokens — partial work above."), return. Same check for per-chain via `checkChainGuards(chain_id)` if positive — but that one is C-10's claim-time enforcement primarily; runner does it as a heartbeat too.
    - `kind === 'tool_call'` → BEFORE dispatching, check the comment thread for `kind=cancel` with `created_at > run.started_at` (mitigation 44). If found, transition `failed (error_reason='cancel_via_comment')`, abort the provider stream, post a final `kind=comment` from the agent ("Cancelled by user — partial work above."), return. Otherwise, dispatch via `executeTool(token, actor, ev.name, ev.args, tx)` — handle thrown `MCP_INVALID_ARGS` by terminating `failed (error_reason='mcp_invalid_args')` + the issue paths in `error_detail` (sanitized — paths only, no values). Handle other thrown errors by `failed (error_reason='mcp_tool_error')` with `sanitizeProviderError(err)` as `error_detail`. On success, format the tool result as a string + feed it back into the provider stream via `provider.continueWithToolResult(streamHandle, ev.toolUseId, result)` (B's locked interface).
    - `kind === 'done'` → record `done_reason` (the value the provider returned) into `frontmatter.done_reason`. Write the accumulated text buffer as a final `kind=result` comment from the agent on the parent (with `frontmatter.run_id = runId`). Transition `completed`. Return.

- **Tx scope:** the runner does NOT hold a tx for the duration of the stream — streams can run minutes. Each individual mutation (`transitionRun`, `incrementTokens`, `createComment`, `executeTool`) opens its own tx. Mitigation 35 — tool handlers run in their own short-lived tx (the dispatcher passes `undefined` for `tx` in this code path).

- **Error containment:** any unhandled throw inside `runAgent` is caught at the top level → transition `failed (error_reason='mcp_tool_error')` with `error_detail = sanitizeProviderError(err)`. The runner NEVER propagates an exception to the poller — if `runAgent` rejects, the poller logs and continues.

**Steps:**

- [ ] **Step 1 — Write failing tests for the runner's pre-flight checks (6 sub-tests).**

  Append to `apps/server/src/lib/runner.test.ts`:

  - `it('terminates failed/no_ai_key when the workspace has no key for the agent's provider')` — seed a workspace with no `provider_keys`, an agent, a planning row claimed to running. Call `runAgent({runId})`. Assert row at `failed`, `error_reason='no_ai_key'`, no provider call attempted (mock `provider.stream` and assert it was NOT called).
  - `it('terminates failed/provider_error when checkProviderHealth returns degraded')` — seed 3 prior provider_error agent.run.failed events for the provider; assert the runner exits without calling stream.
  - `it('terminates failed/rate_limited when checkRunRateLimits returns rate_limited')` — seed events to trip the workspace cap.
  - `it('terminates failed/chain_guard when checkChainGuards returns fanout_exceeded')` — seed 26 sibling rows on the same chain_id.
  - `it('terminates failed/depth_exceeded when fired_by depth > agent.max_delegation_depth')` — seed a chain of 4 fired_by rows with agent.max_delegation_depth=2.
  - `it('terminates failed/idempotency_violation when getActiveRun returns a peer')` — seed a sibling row at status=running for the same (parentId, agentSlug).

  Run: `bun test src/lib/runner.test.ts`. Expected: 6 FAIL (runner.ts doesn't export `runAgent` yet).

- [ ] **Step 2 — Implement the 6 pre-flight checks.**

  Each check calls into the C.1 services layer. If any returns "block", call `transitionRun(runId, {newStatus: 'failed', actor: 'system:runner', errorReason: <reason>, errorDetail: <sanitized>})` and `return`. Order matters (most cost-effective check first):

  1. provider key check (free — workspaces row read)
  2. depth check (walks chain; ms-cost)
  3. rate limits + chain guards + provider health (3 SQL reads)
  4. idempotency check (1 SQL read)

  Run: `bun test src/lib/runner.test.ts`. Expected: 6 PASS.

- [ ] **Step 3 — Write failing tests for the stream consumption loop (8 sub-tests, mock provider).**

  - `it('writes accumulated text as kind=result comment + transitions completed on done event')` — mock stream yields `text → tokens → done(stop)`. Assert the agent's comment exists with the accumulated text body + `frontmatter.run_id === runId`.
  - `it('increments tokens after each tokens event')` — stream yields 3 token events; assert final `frontmatter.tokens_in/out` is the sum.
  - `it('terminates failed/budget_exceeded when tokens cross max_tokens')` — stream yields tokens that exceed max_tokens; assert row at `failed`, partial-result comment posted with budget cap message, stream aborted (mock asserts AbortController was triggered).
  - `it('dispatches a tool_call via executeTool and feeds result back')` — register a test tool that echoes; stream yields tool_call → continueWithToolResult is called with the echoed value.
  - `it('terminates failed/mcp_invalid_args when tool dispatch throws MCP_INVALID_ARGS')` — register a test tool with a strict schema; stream yields tool_call with bad args; assert `error_reason='mcp_invalid_args'`, `error_detail` contains issue PATHS only (no values).
  - `it('terminates failed/mcp_tool_error when tool dispatch throws unknown')` — test tool throws Error('boom'); assert `error_reason='mcp_tool_error'`, `error_detail` is sanitized (doesn't contain 'boom' verbatim if it would look like an SDK leak).
  - `it('terminates failed/cancel_via_comment when a kind=cancel comment exists before next tool dispatch')` — seed a cancel comment on the parent with `created_at > run.started_at`; stream yields a tool_call. Assert `failed/cancel_via_comment`, agent posts "Cancelled by user." comment, stream aborted.
  - `it('persists done_reason from the done event into frontmatter.done_reason')` — stream yields `done(reason='refusal')`. Assert `frontmatter.done_reason === 'refusal'` AND row at `completed` (not failed — refusal is a clean termination per B-mitigation-20).

  Run: `bun test src/lib/runner.test.ts`. Expected: 8 FAIL.

- [ ] **Step 4 — Implement the stream consumption loop.**

  Mock `AIProvider` at the test boundary per `[[mock-the-wire-not-the-response]]` — production code calls `getProvider(workspaceId, providerName)` which the test stubs via `provider.ts`'s `__INTERNAL_TEST_ONLY__.overrideRegistry`. Real `provider.stream` is never called in unit tests.

  Run: `bun test src/lib/runner.test.ts`. Expected: 14 PASS (6 pre-flight + 8 loop).

- [ ] **Step 5 — Add the top-level error containment + actor convention.**

  ```ts
  export async function runAgent(args: {runId: string}): Promise<void> {
    try {
      // ... all the above ...
    } catch (err) {
      // Last-resort transition. If we already transitioned to a terminal
      // state above (the normal path), this UPDATE will be a no-op via
      // F1's WHERE-status guard — the row is no longer at 'running'.
      // RUN_TRANSITION_RACED is caught and logged silently.
      try {
        await transitionRun(args.runId, {
          newStatus: 'failed',
          actor: 'system:runner',
          errorReason: runErrorReasonSchema.enum.mcp_tool_error,
          errorDetail: sanitizeProviderError(err, /* unknown provider */ 'anthropic'),
        });
      } catch (raceErr) {
        if ((raceErr as {code?: string}).code === 'RUN_TRANSITION_RACED') {
          // Already terminal — fine.
          return;
        }
        // eslint-disable-next-line no-console
        console.error('[runner] top-level transitionRun also failed', raceErr);
      }
    }
  }
  ```

  Test (`it('top-level catch transitions failed when something throws unexpectedly')`).

- [ ] **Step 6 — Full suite + typecheck + workflow invocation + commit.**

  Expected: server ~820 → ~835 / 1-skip / 0-fail. Typecheck clean.

  Commit: `phase-3: C-8 lib/runner — runAgent core loop with 6 pre-flight checks + stream consumption`. Mitigations: 25, 28, 30, 31, 40, 41, 44, 47.

---

#### Task C-9: `lib/runner.ts` — `runAgentResume` + `rejectRun`

**Threat-model mitigations bound to this task:** 42 (graceful-shutdown SIGTERM is v1.1 — DOCUMENTED residual, runner does NOT add a SIGTERM handler), 43 (approval+rejection race resolution via first-COMMIT-wins + `INVALID_RUN_TRANSITION` / `RUN_TRANSITION_RACED` loser no-op — inherits C.1 R5's distinguishing code), 44 (cancel-via-comment scope inherited from C-8 — rejectRun does NOT add a new cancel path; the existing C-8 cancel check is the canonical surface).

**Files:**
- Modify: `apps/server/src/lib/runner.ts` (append `runAgentResume` + `rejectRun`).
- Modify: `apps/server/src/lib/runner.test.ts` (append resume + reject tests).

> **⚠️ PLAN CORRECTION 2026-05-29 (C-9 controller pre-flight — align to what C-8 actually built).** C-8 already factored the runner into helpers (`runLoop(ctx)`, `buildInitialMessages(ctx)`, `loadContext`, `preflight`, `failRun`, `handleCancel`, `postResultAndComplete`, `postAgentComment`, `wasCancelled`) keyed on a `RunContext` interface. So the C-9 Step-1 "extract a shared loop" is mostly DONE — the reconciliation:
> - **No `abortController` param.** The provider has no AbortController (C-8 correction); "abort" = `break`. `runLoop(ctx)` takes ONLY `ctx`. The plan's `runAgentLoop(runId, messages, abortController, tx?)` signature is stale — do NOT add an AbortController.
> - **Make messages injectable.** Today `runLoop(ctx)` calls `buildInitialMessages(ctx)` internally (runner.ts ~line 397). Refactor: `runLoop` accepts the pre-built `messages: Message[]` as a param (`runLoop(ctx, messages)`), `runAgent` builds via `buildInitialMessages(ctx)` and passes them, `runAgentResume` builds via a new `buildResumeMessages(ctx, originalRun)` and passes them. This IS the plan's intent. ALL 16 existing C-8 tests must still pass (no behavior change for `runAgent`).
> - **`transitionActor` FK reconciliation (inherited from C-8).** `rejectRun`'s plan sample uses `actor:'system:trigger-matcher'` — but `documents.updated_by` FK→`users.id` rejects free-form strings (see `RunContext.transitionActor` doc in runner.ts). `rejectRun` must resolve an FK-valid actor the same way C-8 does (the run's `created_by`). Load the run, use its `createdBy` for `transitionRun`'s actor; use `agent:<slug>` for the closing `createComment`.
> - **`createComment` cannot carry custom frontmatter.** Its input is `{workspace, project, parent, authorContext, actor, body, kind?, targetAgent?, visibility?}` — there is NO `frontmatter.rejection_of_comment_id` / `run_id` passthrough (C-8 hit the same wall for `run_id`). So the rejection-comment-id reference goes in the comment BODY text (e.g. "Run cancelled by reviewer."), NOT a frontmatter field. Update the `rejectRun` test accordingly — assert the body, not a `rejection_of_comment_id` frontmatter field. (If a structured link is later needed, that's a `createComment` extension in D, tracked separately.)
> - **`resume_of` confirmed** on the run frontmatter (`agent-run-schema.ts`: `resume_of: z.string().uuid().optional()`).
>
> The acceptance criteria + Steps remain authoritative for WHAT to build (resume message construction, the non-awaiting_approval defensive guard, the rejected transition + race-loser no-op, the closing comment). Only the helper signature + the two passthrough assumptions above are corrected.

**Acceptance criteria:**

- `runAgentResume({runId}): Promise<void>` — invoked when the poller claims a planning row whose `frontmatter.resume_of` is set. Loads BOTH the original `awaiting_approval` run (via `resume_of` UUID → `documents` lookup) AND the new resuming row. Builds the message history from:
  1. parent doc body (same as `runAgent`)
  2. comment thread filtered to parent_id (same)
  3. PLUS the original run's `kind=plan` comment + ALL `kind=approval` comments on the parent (these become user-message context for the resume — "your plan was approved")
  4. PLUS any new comments since the original run's `awaiting_approval` transition (catch-up context)

  After building, the resume path uses the SAME stream consumption loop as `runAgent` — `runAgentResume` is a thin wrapper that constructs different messages then delegates to a shared internal `runAgentLoop` helper. Refactor C-8's `runAgent` to also call `runAgentLoop` so both paths share the loop body.

- `rejectRun({runId}): Promise<void>` — invoked **synchronously by the trigger-matcher** in C.3 when a `kind=rejection` comment lands on a parent doc that has an `awaiting_approval` run. NOT a poller-claimed path. Loads the run row + transitions `awaiting_approval → rejected` via `transitionRun`. Catches `RUN_TRANSITION_RACED` (mitigation 43 — the approval-handler may have already won) and returns silently. Posts a final `kind=comment` from the agent ("Run cancelled by reviewer.") on the parent referencing the rejection comment's id. Emits `agent.run.rejected` via `transitionRun`'s standard event emission.

- Both functions follow the same top-level error containment as `runAgent`.

**Steps:**

- [ ] **Step 1 — Refactor C-8's `runAgent` to extract `runAgentLoop(args, messages)` helper.**

  Move the stream-consumption loop into a private `async function runAgentLoop(runId, messages, abortController, tx?)` that takes the constructed message history as input + the AbortController. `runAgent` now constructs messages from (parent doc + comment thread) and calls `runAgentLoop`. No behavior change; ALL 14 C-8 tests must still pass.

  Run: `bun test src/lib/runner.test.ts`. Expected: 14 PASS (no regressions).

- [ ] **Step 2 — Write failing tests for `runAgentResume`.**

  - `it('builds message history from parent body + thread + original kind=plan + kind=approval comments')` — seed an `awaiting_approval` run with a `kind=plan` comment; seed a `kind=approval` comment; seed a new resuming planning row with `frontmatter.resume_of = <originalRunId>`. Mock provider.stream; assert the messages array passed to `provider.stream` contains the plan + approval comments in order.
  - `it('uses the same loop as runAgent for the post-message-construction path')` — same setup but with a complete stream (text + done); assert resume run transitions `completed` AND `kind=result` posted.
  - `it('throws if frontmatter.resume_of points at a non-awaiting_approval row')` — defensive: the trigger handler that creates the resuming row should only do so when the original is awaiting_approval; if the original is already terminal, `runAgentResume` should NOT continue (transitions `failed/idempotency_violation`).

  Run: `bun test src/lib/runner.test.ts`. Expected: 3 FAIL.

- [ ] **Step 3 — Implement `runAgentResume`.**

  Run: `bun test src/lib/runner.test.ts`. Expected: 17 PASS.

- [ ] **Step 4 — Write failing tests for `rejectRun`.**

  - `it('transitions awaiting_approval → rejected and emits agent.run.rejected')`
  - `it('posts a kind=comment from the agent referencing the rejection comment id')` — assert the new comment's body matches "Run cancelled by reviewer." AND the `frontmatter.rejection_of_comment_id` points at the rejection comment.
  - `it('returns silently when the run is no longer at awaiting_approval (race-loser path)')` — seed the run at `running` (the approval-handler raced ahead); call rejectRun; assert no throw, no new events, run stays at running.
  - `it('throws non-race errors')` — seed the run as not-found (impossible state); assert throw.

  Run: `bun test src/lib/runner.test.ts`. Expected: 4 FAIL.

- [ ] **Step 5 — Implement `rejectRun`.**

  ```ts
  export async function rejectRun(args: {runId: string, rejectionCommentId: string}): Promise<void> {
    try {
      await transitionRun(args.runId, {
        newStatus: 'rejected',
        actor: 'system:trigger-matcher',
      });
    } catch (err) {
      if ((err as {code?: string}).code === 'RUN_TRANSITION_RACED') {
        // Approval already won. Per mitigation 43, loser silently no-ops.
        return;
      }
      throw err;
    }
    // Post the closing comment AFTER the terminal transition so SSE
    // subscribers see status change first, then the explanation.
    const run = await db.query.documents.findFirst({where: eq(documents.id, args.runId)});
    if (!run) return;
    await createComment({/* parent, body, frontmatter.rejection_of_comment_id */});
  }
  ```

  Run: `bun test src/lib/runner.test.ts`. Expected: 21 PASS (17 + 4).

- [ ] **Step 6 — Full suite + typecheck + workflow invocation + commit.**

  Expected: server ~835 → ~842 / 1-skip / 0-fail. Typecheck clean.

  Commit: `phase-3: C-9 lib/runner — runAgentResume + rejectRun + loop refactor`. Mitigations: 42, 43, 44.

---

#### Sub-phase C.2 close-out (controller, not subagents)

After C-9 commits:

- [ ] **`/integration` gate.** Server suite ~842 / 1-skip / 0-fail; web 559 / 8-skip / 0-fail (unchanged); shared 51 / 0-fail. `.last-integration` advanced.

- [ ] **`/code-review --base=<C.1 close sha> --effort=medium`** with reviewer prompt instructing verification of mitigations 24, 25, 26, 27, 30, 31, 34, 35, 41, 42, 43, 44, 47. Round budget per C readiness handoff: 2 medium-effort rounds.

- [ ] **Sibling-site audit applied to the C.2 diff** (post-C.1 retro recommendation). Check the 5 lockstep classes against the runner + dispatcher diff. Expected: no new findings if the per-task audits in Steps were thorough; flag any drift.

- [ ] **`/evaluate` retro.** If review or audit surfaced new attack classes, plan-correct first then fix code.

- [ ] **Plan-correction commit: expand C-10..C-13 task bodies (Sub-phase C.3).** Following the same per-task format as C.2 above + the C.2 critical reconciliation block for C-12 (autonomy gate). ✅ DONE 2026-05-29 — see the expanded "Sub-phase C.3" section immediately below.

---

### Sub-phase C.3 — Wiring + triggers + autonomy gate (expanded task bodies — written 2026-05-29)

> **⚠️ SUPERSEDED 2026-05-29 (Option A → Option B / Reaction Plane).** This section described the **inline-in-tx matcher** (Option A). After a design discussion + external evaluation, C.3 was redesigned as the **Reaction Plane** (Option B-minimal): a durable, at-least-once event dispatcher with the matcher as its first reactor — no per-emit-site hand-wiring. **Execute the standalone plan `docs/superpowers/plans/2026-05-29-phase-3-C3-reaction-plane.md` instead** (tasks C-10a / C-10b / C-11 / C-12 / C-13). Design spec: `docs/superpowers/specs/2026-05-29-reaction-plane-design.md`; decision brief: `docs/superpowers/specs/2026-05-29-event-delivery-decision.md`. The Option-A section below is kept for traceability only — **do not implement against it.**

> Sub-phase C.3 expands C-10..C-13 into the full Steps + Files + Tests + Commit form, mirroring the C.1/C.2 expansions. The original outlines at `### Task C-10..C-13` below the historical divider predate this expansion + the autonomy-gate decision. **Do not implement against the outlines.**
>
> All C.3 tasks SEQUENTIAL. Dispatched via `superpowers:subagent-driven-development` wrapped by `netdust-core:ntdst-execute-with-tests`. Each subagent's close-out invokes `netdust-core:testing-workflow` and reports the Test-evidence + STATUS blocks.
>
> **Architecture decision (locked 2026-05-29) — the trigger-matcher is INLINE-IN-TX, not a bus subscriber.** Ground-truth read of the live code (the C.2 retro's "ground-truth the dependency surface" lesson, applied):
> - **No `trigger-matcher.ts` exists.** The 4 builtin triggers are *defined* as documents (`lib/builtin-triggers.ts`) but nothing *consumes* trigger events to fire actions. C.3 CREATES the matcher.
> - The in-process `eventBus` (`lib/event-bus.ts`) `subscribe(workspaceId, filter, handler)` is **workspace-scoped + fire-and-forget** (per-subscriber errors swallowed at `event-bus.ts:67`). It is the WRONG surface for durably creating `agent_run` rows — a swallowed handler error or a crash between commit and publish would silently drop a trigger (an agent never runs).
> - **Threat-model mitigation 43 already dictates the design:** the `kind=approval`/`kind=rejection` handlers call `transitionRun(...)` *inside the comment-insert tx* (first-COMMIT-wins race resolution). The matcher therefore runs **synchronously inside the emitting write's transaction** — the comment-insert tx for mention/approval/rejection, the assignee-PATCH tx for assignment. Run-creation / transition commits or rolls back atomically with the originating write. No missed-event window.
> - **Consequence for `createRun` (C.1 service):** `createRun` currently owns its own tx via `txWithEvents(db, ...)` and does NOT accept a caller tx. To create the run row in the SAME tx as the originating write, C-10a adds an optional `tx?` param to `createRun` (the C.1/C.2 `(args, tx?)` convention — same shape C-9 added to `getActiveRun`). This is the first C.3 task.
> - The matcher is invoked from `emitEvent` (or a thin wrapper the emitting services call) so EVERY trigger-relevant event flows through it once, in-tx. It reads the workspace's `enabled` trigger documents, matches `on_event` + `event_filter`, and for each match either creates an `agent_run` row at `planning` (assignment/mention) or invokes the `internal_action` (resume_run/reject_run). The poller (C-10) claims `planning` rows ~1s later.
>
> **Threat-model EXTENSION for the new trigger-matcher surface (mitigations 49–52, new this sub-phase — extends the C threat model 23–47):**
> - **49 — Trigger-match runs in the originating write's tx; a matcher throw MUST roll back the originating write, not be swallowed.** Unlike the SSE bus (fire-and-forget by design), the matcher is transactional: if it throws, the comment/assignment write rolls back too (atomic). The matcher MUST NOT swallow its own errors the way `eventBus.publish` does. (Distinct from mitigation 47 — that's the SSE *delivery* path, fire-and-forget; this is the trigger *action* path, transactional.)
> - **50 — Allow-list enforcement at trigger-match time.** A mention/assignment naming an agent whose `frontmatter.projects` allow-list does NOT include the parent doc's project MUST NOT create a run (mirrors Phase 2.5 `requireResource`). Match-time gate, before `createRun`.
> - **51 — Autonomy gate (THE V1↔autonomous boundary).** `FOLIO_AGENT_CHAINS_ENABLED` (default false). When OFF, an agent-ORIGINATED trigger event (the originating comment's author is an agent, or it carries a `run_id` in payload/frontmatter) MUST create ZERO runs and emit exactly one `agent.chain.suppressed` event. Human-originated events fire normally. The six runner guards (C-4/C-5) are orthogonal and stay live regardless of the flag.
> - **52 — Idempotency at trigger-match time.** A single originating event MUST create at most one run per (parent, agent). If `getActiveRun(parentId, agentSlug)` already returns a non-terminal run, the matcher MUST NOT create a duplicate (defends against double-fire from two matching triggers, or a re-emitted event). Inherits the C-8 idempotency model.
>
> **Pre-flight invariants for every C.3 task:**
> - `cd apps/server`; tests via `bun test src/lib/<file>.test.ts` then `bun test`; typecheck `bun x tsc --noEmit`.
> - Baseline at C.3 start: **server 851 / 1-skip / 0-fail** (post-C.2 + code-review). C.3 adds ~30-40 server tests; expected end-of-C.3: **server ~885 / 1-skip / 0-fail**.
> - **Carried obligations from C.2 (`tasks/retro-follow-ups.md`):** C.2-R-3 (system-actor FK) lands HERE — trigger-created runs may have no human owner. C.3 MUST decide the FK-valid actor for trigger-created runs (the `actor: User` that `createRun` requires + the `transitionActor` for `transitionRun`). See C-10a.
> - **Sibling-site audit (5 lockstep classes)** before each task: closed-enum literals (every `error_reason`/event kind from its schema enum), event scope (`projectId: null` for workspace-wide), no new FE-union widening (C.3 is server-only).

#### Task C-10a: `createRun` accepts an optional `tx` (C.1-service extension)

**Threat-model mitigations bound:** 49 (in-tx atomicity prerequisite). Inherits 23 (run-is-its-own-scope snapshot).

**Files:** Modify `apps/server/src/services/agent-runs.ts` + `agent-runs.test.ts`.

**Acceptance criteria:**
- `createRun(args: CreateRunArgs, tx?: DBOrTx): Promise<CreateRunResult>`. When `tx` is provided, the INSERT + `emitEvent` run on that tx (the caller's `txWithEvents` owns the boundary). When absent, behavior is byte-identical to today (opens its own `txWithEvents(db, ...)`). Mirrors the C.2 `getActiveRun(args, tx?)` and `executeTool(..., tx?)` convention.
- Resolve `DBOrTx` the same way C-7/C-8 did (re-declare locally or import the `DB` type from `db/client.ts`).
- **System-actor decision (C.2-R-3):** the trigger path's `actor` (a `User` — `createRun` requires `actor: User` and writes `actor.id` to `created_by`, FK→`users.id`). The originating WRITE always has a human actor (the person who assigned/mentioned/approved/rejected — even an agent-originated comment was ultimately authored under some token; resolve the originating user). Use the **originating event's human actor** as the run's `created_by`. Document inline: trigger-created runs are owned by the human who triggered them; there is no `system:` user. (This closes C.2-R-3 for the trigger path; the runner's `transitionActor` already uses `run.createdBy`, so it inherits this FK-valid owner.)

**Steps:**
- [ ] **Step 1 — Failing test.** In `agent-runs.test.ts`: `it('createRun joins a caller-provided tx (one atomic commit)')` — open `txWithEvents(db, async (tx) => { await createRun(args, tx); throw new Error('rollback') })`, catch, then assert NO run row was inserted (the rollback discarded it). Contrast: `it('createRun opens its own tx when none passed')` — existing behavior, run row exists after the call. Run → 1 new FAIL (tx param not accepted).
- [ ] **Step 2 — Implement.** Add `tx?: DBOrTx`. Factor the insert+emit body into a helper that takes a tx; the public fn either uses the passed tx or wraps `txWithEvents(db, ...)`. Run → PASS.
- [ ] **Step 3 — Regression.** `bun test src/services/agent-runs.test.ts` → all green (existing createRun tests unchanged). `bun test` full suite. `bun x tsc --noEmit`.
- [ ] **Step 4 — Commit + testing-workflow.** Invoke `Skill("netdust-core:testing-workflow")`. Commit: `phase-3: C-10a createRun accepts optional tx — in-tx trigger-match prerequisite`. Mitigation 49.

#### Task C-10: `lib/trigger-matcher.ts` — inline-in-tx matcher + autonomy gate

> ⚠️ **This task folds in the C-12 autonomy-gate reconciliation (the V1↔autonomous decision point).** The original C-12 outline below the divider is superseded by this task — the matcher and the gate are one surface.

**Threat-model mitigations bound:** 49 (in-tx, no swallow), 50 (allow-list at match-time), 51 (autonomy gate — `FOLIO_AGENT_CHAINS_ENABLED` + `isAgentOriginated` + `agent.chain.suppressed`), 52 (match-time idempotency via `getActiveRun`). Inherits 43 (approval/rejection first-COMMIT-wins handled by the run-transition path, wired in C-12/D-5; C-10 ships the assignment/mention create path + the gate).

**Files:** Create `apps/server/src/lib/trigger-matcher.ts` + `trigger-matcher.test.ts`.

**Scope (C.3 lands the CREATE path — assignment + mention; the resume_run/reject_run internal_actions wire in D-5 per the existing plan, but C-10 builds the dispatch skeleton so D-5 only fills the two handlers).**

**Acceptance criteria:**
- `matchTriggers(tx: DBOrTx, event: { workspaceId, projectId, documentId, kind, actor, payload }): Promise<void>` — invoked inline from the emitting path (C-11 wires the call sites). Loads the workspace's `enabled: true` trigger documents (type=`trigger`), filters to those whose `frontmatter.on_event === event.kind` AND whose `frontmatter.event_filter` (if present) matches the event payload (e.g. `{kind:'approval'}` against `payload.kind`).
- For each matched trigger:
  - If the trigger maps to an agent (assignment/mention — `frontmatter.agent` resolves to a slug via `$event.agent` / `$event.agent_slug`): resolve the agent doc, enforce **mitigation 50** (agent's `frontmatter.projects` allow-list includes `event.projectId`, or is `['*']` — else skip, no row), enforce **mitigation 52** (`getActiveRun(parentId, agentSlug, tx)` non-null → skip, no duplicate), enforce **mitigation 51** (autonomy gate — below), then `createRun(args, tx)` at `planning` with `input.triggerId = trigger.id`, `input.firedBy = event.kind`, `input.chainId` (new chain via `nextChainId` for a human-originated root; inherited if a chain exists). Actor = the originating human user (C-10a decision).
  - If the trigger carries an `internal_action` (`resume_run`/`reject_run`): C-10 dispatches to a named handler stub that D-5 fills. C-10 ships the dispatch + a `not-yet-wired` no-op-with-log for these two (so the matcher is complete and D-5 is purely additive). Do NOT implement resume/reject logic here — that's D-5 (it needs `getPendingApprovalRun` + `runAgentResume`/`rejectRun` wiring).
- **Mitigation 51 — autonomy gate (THE critical fold-in):**
  - Read `env.FOLIO_AGENT_CHAINS_ENABLED` (default **false** — add to the env config alongside the existing `FOLIO_*` vars).
  - `isAgentOriginated(event): boolean` — true if the originating actor is an agent (`event.actor` starts with `agent:`) OR the originating doc/comment carries a `run_id` (payload/frontmatter). 
  - When the gate is OFF AND `isAgentOriginated(event)` AND the matched trigger would create a run: create ZERO rows, emit exactly ONE `agent.chain.suppressed` event (`emitEvent(tx, {kind:'agent.chain.suppressed', workspaceId, projectId, documentId, actor, payload:{trigger_id, agent_slug, reason:'autonomy_gate'}})`), return. Human-originated events are unaffected. When the gate is ON, agent-originated mentions fire normally (subject to 50 + 52 + the six runner guards).
  - The six runner guards (C-4/C-5) are orthogonal — the gate governs cross-run FAN-OUT, the guards govern per-run resource caps. Do NOT conflate.
- **Mitigation 49 — the matcher does NOT swallow errors.** Unlike `eventBus.publish`, a throw inside `matchTriggers` propagates (rolling back the originating tx). Wrap individual trigger evaluation so one malformed trigger doc doesn't abort the others ONLY if that's safe — but a `createRun`/`emitEvent` failure MUST propagate (atomicity). Document the distinction in a header comment.
- **`agent.chain.suppressed` event kind** — add to the shared `KNOWN_EVENT_KINDS` in `packages/shared` (sibling-site: this is the one shared-package touch in C.3; audit the FE consumer doesn't need it — it's server-internal observability).

**Steps:**
- [ ] **Step 1 — Add the env var + event kind.** Add `FOLIO_AGENT_CHAINS_ENABLED` (default false, coerced bool) to the env config module. Add `'agent.chain.suppressed'` to `packages/shared` `KNOWN_EVENT_KINDS` + the server `EventKind` union. Run `bun test` in shared + server to confirm no break. (No new test yet — config + enum.)
- [ ] **Step 2 — Failing tests for the create path + allow-list + idempotency.** In `trigger-matcher.test.ts`:
  - `it('creates one agent_run at planning for a human assignment matching builtin-on-assignment')` — seed an enabled assignment trigger + an agent allow-listed to the project; call `matchTriggers(tx, {kind:'agent.task.assigned', actor:<human>, payload:{agent:<slug>}, ...})`; assert one planning row in the project's runs table.
  - `it('creates one agent_run for a human @mention matching builtin-on-mention')` — `comment.mentioned`, human author.
  - `it('does NOT create a run when the agent allow-list excludes the project (mitigation 50)')` — agent `projects:['other']`; assert zero rows.
  - `it('does NOT create a duplicate when getActiveRun returns a non-terminal peer (mitigation 52)')` — seed a running run for (parent, agent); assert no second row.
  - Run → all FAIL (matchTriggers doesn't exist).
- [ ] **Step 3 — Implement the create path** (load triggers, match, allow-list, idempotency, createRun(args, tx)). Run → the 4 above PASS.
- [ ] **Step 4 — Failing tests for the autonomy gate (mitigation 51).** In `runner.autonomy-gate.test.ts` (per PHASES naming) OR `trigger-matcher.test.ts`:
  - `it('flag OFF + agent-originated @mention → ZERO rows + one agent.chain.suppressed')` — `FOLIO_AGENT_CHAINS_ENABLED=false`, originating comment author is `agent:foo`; assert zero runs + exactly one suppressed event.
  - `it('flag OFF + human @mention → exactly one row, no suppressed event')`.
  - `it('flag ON + agent-originated @mention → one row (subject to guards)')` — toggle the env for this test, restore after.
  - Run → FAIL (gate not implemented).
- [ ] **Step 5 — Implement the autonomy gate + `isAgentOriginated`** inside the create path (before `createRun`). Add the `internal_action` dispatch stub (resume_run/reject_run → log + no-op, D-5 fills). Run → all PASS.
- [ ] **Step 6 — Full suite + typecheck + workflow + commit.** `bun test` (expect ~851 → ~865), `bun x tsc --noEmit`. Invoke `Skill("netdust-core:testing-workflow")`. Commit: `phase-3: C-10 trigger-matcher — inline-in-tx create path + autonomy gate (FOLIO_AGENT_CHAINS_ENABLED)`. Mitigations 49, 50, 51, 52.

#### Task C-11: `lib/poller.ts` — `startRunnerPoller` + boot wiring

**Threat-model mitigations bound:** 36/37 (claim-race + orphan recovery, via C.1's `claimNextPlanningRun`/`recoverOrphanRuns`), 38 (orphan-recovery vs active-poller race — the recency floor from C.1 R4 already mitigates; the poller respects `FOLIO_WORKER_STALE_MS`).

**Files:** Create `apps/server/src/lib/poller.ts` + `poller.test.ts`. Modify `apps/server/src/index.ts`.

**Acceptance criteria:**
- `startRunnerPoller(db): () => void` (returns a stop fn). Env: `FOLIO_POLLER_INTERVAL_MS` (default 1000), `FOLIO_POLLER_CONCURRENCY` (default 5), `FOLIO_WORKER_STALE_MS` (default 300000), backpressure threshold 10 (log when pending exceeds it). Add these to the env config.
- **Boot:** call `recoverOrphanRuns(db)` once before the loop starts (C.1 service).
- **Main loop:** every interval, while in-flight < concurrency cap, `claimNextPlanningRun(db)` (C.1 — race-safe claim); for each claimed row, fire-and-forget `runAgent({runId})` (or `runAgentResume` if `frontmatter.resume_of` is set — check the row + dispatch the right entry) with `.catch(logError).finally(() => decrement in-flight)`. The runner NEVER throws to the poller (C-8 top-level containment guarantees this).
- **Resume dispatch:** when a claimed planning row has `frontmatter.resume_of`, call `runAgentResume({runId})` instead of `runAgent` (C-9). The poller is the single claim point for both.
- **Backpressure:** if `countPendingPlanning(db)` (C.1) exceeds the threshold, log a warning (never silently drop). No hard cap in v1 — just observability.
- **Boot wiring (C-11 mirrors the reconciler pattern in `index.ts`):** `if (env.NODE_ENV !== 'test') { void startRunnerPoller(db); }` after the reconciler block. NOT started in test env (covered by unit tests with fake timers + D's integration smoke).

**Steps:**
- [ ] **Step 1 — Add env vars** (`FOLIO_POLLER_INTERVAL_MS`, `FOLIO_POLLER_CONCURRENCY`, `FOLIO_WORKER_STALE_MS`) to the env config with defaults. (No test — config.)
- [ ] **Step 2 — Failing tests with fake timers.** In `poller.test.ts` (use Bun's `setSystemTime` or a manual interval stub — mock `runAgent`/`runAgentResume` via `mock.module` or by injecting them; prefer injection to avoid the module-global leak per `[[mock-module-leaks-across-bun-tests]]`):
  - `it('calls recoverOrphanRuns once on boot before the first claim')`.
  - `it('claims a planning row and dispatches runAgent within one interval')`.
  - `it('dispatches runAgentResume when the claimed row has frontmatter.resume_of')`.
  - `it('respects the concurrency cap (never more than N in-flight)')` — seed N+2 planning rows, cap=N, assert only N runAgent calls in-flight at once.
  - `it('logs backpressure when pending exceeds threshold')`.
  - `it('a runAgent rejection does not crash the loop (next tick still claims)')`.
  - Run → FAIL.
- [ ] **Step 3 — Implement the poller.** Run → PASS.
- [ ] **Step 4 — Wire into index.ts** (NODE_ENV-gated, mirrors reconciler). No unit test (smoke in C-13/D).
- [ ] **Step 5 — Full suite + typecheck + workflow + commit.** Invoke `Skill("netdust-core:testing-workflow")`. Commit: `phase-3: C-11 runner poller — claim loop + concurrency cap + boot wiring`. Mitigations 36, 37, 38.

#### Task C-12: Wire the matcher into the emitting paths (the actual trigger fire)

> ⚠️ **The autonomy gate itself lives in C-10's matcher (mitigation 51). C-12 WIRES the matcher into the comment + assignment write paths so trigger events actually flow through it in-tx.** The original C-12 outline (below the divider) conflated the gate + the wiring; this expansion splits them: C-10 = matcher + gate, C-12 = call-site wiring.

**Threat-model mitigations bound:** 49 (the wiring is what puts the matcher IN the originating tx), 43 (approval/rejection handlers — the `internal_action` path stubbed in C-10 is wired to its call site here; the actual resume/reject LOGIC is D-5).

**Files:** Modify `apps/server/src/services/comments.ts` (the `comment.mentioned` + `comment.created` emit sites at ~426, ~567), `apps/server/src/services/documents.ts` (the `agent.task.assigned` emit sites at ~540, ~780), and `apps/server/src/routes/documents.ts` (the `agent.task.assigned` emit at ~347). + tests.

**Acceptance criteria:**
- At each site that emits `agent.task.assigned`, `comment.mentioned`, or `comment.created` (the 4 builtin triggers' `on_event` values), call `matchTriggers(tx, event)` **on the SAME tx** that emitted the event, AFTER the `emitEvent` call (so the event row exists). Since these emits are already inside a `txWithEvents` (or a tx), the matcher joins it — atomic.
- The matcher call MUST be inside the existing tx, not after commit. Verify each call site is within a `txWithEvents`/tx scope; if any emit is NOT in a tx, wrap it (note the divergence).
- **Mitigation 43 readiness:** the `comment.created` with `kind:'approval'|'rejection'` flows to the matcher's `internal_action` dispatch (stubbed in C-10). C-12 confirms the wiring reaches it; D-5 fills the resume/reject handlers. C-12 does NOT implement resume/reject — but its test asserts the matcher IS invoked for an approval/rejection comment (the stub logs).
- No double-fire: a single comment-create emits `comment.created` (and possibly `comment.mentioned`) — ensure the matcher isn't invoked twice for the same logical event in a way that creates two runs (mitigation 52's `getActiveRun` guard backstops this, but avoid the double-invoke at the source).

**Steps:**
- [ ] **Step 1 — Failing integration-style tests.** In `comments.test.ts` / `documents.test.ts` (or a new `trigger-wiring.test.ts`):
  - `it('PATCH work_item assignee to agent:foo creates one planning run')` — end-to-end through `updateDocument`; assert one run row.
  - `it('POST comment with @foo mention creates one planning run')` — through `createComment`; assert one row.
  - `it('approval comment invokes the matcher internal_action dispatch')` — assert the stub was reached (spy/log), zero runs created by the stub (D-5 fills it).
  - `it('agent-originated @mention with chains disabled creates zero runs (gate wired end-to-end)')` — the autonomy gate, exercised through the real comment path.
  - Run → FAIL (matcher not wired into the emit sites).
- [ ] **Step 2 — Wire `matchTriggers(tx, event)` into each emit site.** Run → PASS.
- [ ] **Step 3 — Full suite + typecheck + workflow + commit.** Invoke `Skill("netdust-core:testing-workflow")`. Commit: `phase-3: C-12 wire trigger-matcher into comment + assignment emit paths (in-tx)`. Mitigations 49, 43.

#### Task C-13: Sub-phase C.3 integration gate (controller, not a subagent)

- [ ] `bun test` full server suite green; expect ~851 → ~885 / 1-skip / 0-fail. Web + shared unchanged (C.3 is server-only except the one `agent.chain.suppressed` shared-enum add).
- [ ] `bun x tsc --noEmit` clean (server). FE/shared typecheck unaffected.
- [ ] **Smoke the dev server (the first "agent does work" moment):** configure an Anthropic key (Sub-phase B UI), assign a work_item to an agent → watch the runs table populate a `planning` row → poller claims it ~1s → `runAgent` streams → `kind=result` comment lands on the parent. With only `__echo` registered (C-7 skeleton), the agent can't do real tool work yet — but the LOOP runs end-to-end: claim → stream → comment → completed. (Real tools land in D-3; the "set up a project for me" demo is Sub-phase D.)
- [ ] **Autonomy-gate smoke:** with `FOLIO_AGENT_CHAINS_ENABLED` unset (default false), an agent-posted `@mention` produces zero runs + one `agent.chain.suppressed` in the events table. Flip the env to true, restart, repeat → one run fires.
- [ ] `/integration` → `/code-review --base=<C.2 close sha> --effort=medium` (reviewer prompt names mitigations 43, 49, 50, 51, 52 + the carried 36/37/38) → sibling-site audit on the C.3 diff → `/evaluate`.
- [ ] Sub-phase C complete. Next: **Sub-phase D** (routes + MCP parity + real tools in D-3 → mitigation 27 lands here per C.2-R-1; tool-error-feedback redesign per C.2-R-2).

---

### Original Sub-phase C task outlines (historical context — DO NOT execute against these)

> The outlines below at `### Task C-7 / C-8 / C-9 / C-10 / C-11 / C-12 / C-13` predate the C.1 review-of-review retro recommendation (sibling-site audit) AND the three 2026-05-28 reconciliation decisions (tool-layer rename, autonomy gate, primitives-not-feature-menu). They remain in the plan so future readers can trace how the design evolved, but **execution MUST use the expanded C.2 section above** (and the future C.3 expansion that will land in a separate plan-correction commit after C.2 closes).

### Task C-7: `lib/mcp-dispatch.ts` — `executeMcpTool` shared dispatcher (skeleton)

> ⚠️ **EXPANSION RECONCILIATION (decisions 2026-05-28 — apply when expanding this task; outline below predates them).** Two corrections, both from `memory/STATE.md` "Next up" markers + `docs/PHASES.md` "Tool-execution layer — one tool surface, two faces":
> 1. **Rename. Inside-agent === outside-agent, ONE auth model.** The runner is NOT an MCP client (no JSON-RPC to itself). The file is `lib/agent-tools.ts` (NOT `mcp-dispatch.ts`); the fn is `executeTool(token, actor, name, args)` (NOT `executeMcpTool`); the auth context is plain `{ token, actor }` (NOT `McpAuthContext`). MCP is just one *face* over this layer; the runner calls `executeTool` directly. The scope check is identical for both callers — the token carries authority, no "which caller" param.
> 2. **Decide the extraction-vs-skeleton timing DELIBERATELY.** The outline below defers the real `routes/mcp.ts` refactor to D-3 and registers only a dummy `__echo`. BUT `docs/PHASES.md` frames the *real* extraction (lift the existing `TOOLS` out of `routes/mcp.ts`) as the prerequisite. If you keep the skeleton-now/real-tools-in-D approach, then C-8's runner can only call `__echo` and the "set up a project for me" keystone demo (`memory/project_folio-agent-thesis.md`) cannot work until Sub-phase D — confirm that's acceptable, or pull the real extraction forward into C-7. This is a scope call for the expansion session, not a silent default.
> 3. **TOOLS = few GENERAL primitives, NOT a feature-menu (decision 2026-05-28 — `memory/project_folio-tools-as-primitives.md`).** This reshapes what the registry should contain and is the most consequential agent-layer design call. Folio agents are Claude-Code-shaped: a *tiny* set of general tools + skills/context do the work, NOT 40 narrow verbs (`create_work_item`/`move_to_status`/`add_label`/`create_subtask`/…) maintained forever. Because frontmatter is schemaless (CLAUDE.md rule 3), a single `write_document` accepting arbitrary frontmatter is already near-unlimited (a subtask is just a doc with `parent_id` set — the *skill* encodes the convention, not a tool). Design target: `read`/`query` (scoped to allowed projects) + `write_document` (scoped: doc types + projects) + search — NOT a feature menu, NOT a single god-tool (`write_anything` makes scoping too coarse). Two orthogonal layers: **reasoning = unlimited** (what the agent figures out, via general tools + skills), **permission = always scoped** (`tools ∩ scopes ∩ projects` at `executeTool`). When expanding C-7, do NOT enumerate narrow feature-tools; design the general primitives + leave skills/playbook as *readable workspace content* (so Claude-Code-over-MCP and the in-app agent share one knowledge source — inside===outside applied to smarts).

> The runner needs this to dispatch tool calls. Full MCP-tool registry coverage lands in Sub-phase D, but the skeleton is required for C-8.

**Files:** Create `apps/server/src/lib/mcp-dispatch.ts` + `.test.ts`.

**Scope:**
- `McpAuthContext` type per spec §4d.
- `executeMcpTool(name, args, authContext)` — looks up tool in a registry, validates args via Zod, checks scopes, resolves resources, applies allow-list intersection, dispatches.
- Sub-phase C registers ONE tool: a dummy `__echo` tool used only by tests (real tools migrate in D-3).
- `routes/mcp.ts` is NOT refactored yet (that's D-3).

### Task C-8: `lib/runner.ts` — runAgent core loop

> ⚠️ **EXPANSION RECONCILIATION (decision 2026-05-28).** "tool dispatch via `executeMcpTool`" below → the runner calls **`executeTool(agentRun.token, actor, name, args)` directly** (renamed per C-7's reconciliation; no MCP/JSON-RPC framing — the runner is not an MCP client). This is the load-bearing line proving inside-agent === outside-agent. Also: build the loop hand-rolled on the existing `lib/ai/provider.stream()` generators — NOT the Vercel AI SDK (build-decision in STATE). The provider layer already normalizes `text|tool_call|tokens|done` + the tool round-trip.

**Files:** Create `apps/server/src/lib/runner.ts` + `runner.test.ts`.

**Scope:** invariant entering `runAgent` = row at `status='running'` with `worker_started_at` set (the poller already claimed it). Implements the full §4b execution loop with the six pre-flight checks, planning-vs-execution decision, provider stream consumption, kind=plan/comment/result/error comment writes (each carrying `frontmatter.run_id`), tool dispatch via `executeMcpTool`, cancel check before each tool dispatch, budget enforcement after each `tokens` event, natural completion writing `kind=result` + transitioning to completed.

Mocks `AIProvider` at the test boundary per `[[mock-the-wire-not-the-response]]`. Tests cover every branch enumerated in spec §7a runner unit tests (~15 sub-tests).

### Task C-9: `lib/runner.ts` — runAgentResume + rejectRun

**Files:** Append to `runner.ts` + `.test.ts`.

**Scope:**
- `runAgentResume({ runId })` — invoked when the poller claims a planning row whose `frontmatter.resume_of` is set. Loads both the original `awaiting_approval` run and the new resuming row. Builds messages from the original parent's comments PLUS the kind=plan and kind=approval comments as message history. Runs through the standard loop starting at step 4 (skip planning gate; agent is now executing).
- `rejectRun({ runId })` — called synchronously by the trigger-matcher when a `kind=rejection` comment lands. Transitions the matched `awaiting_approval` run to `rejected`, posts a `kind=comment` from the agent ("Run cancelled by reviewer."), clears `worker_started_at`, emits `agent.run.rejected`.

### Task C-10: `lib/poller.ts` — startRunnerPoller

**Files:** Create `apps/server/src/lib/poller.ts` + `poller.test.ts`.

**Scope:** Implements `startRunnerPoller(db)` per spec §4c. Defaults: `FOLIO_POLLER_INTERVAL_MS=1000`, `FOLIO_POLLER_CONCURRENCY=5`, `FOLIO_WORKER_STALE_MS=300000`, backpressure threshold 10. Boot: call `recoverOrphanRuns` once. Main loop: respect concurrency cap, `claimNextPlanningRun`, fire-and-forget `runAgent(id)` with `.catch(logError).finally(...)`. Tests with fake timers (Bun's `setSystemTime` if available, else `vi.useFakeTimers()` style); test boot recovery, idle loop, concurrency cap, race-safe claim, backpressure log.

### Task C-11: Wire poller into `index.ts` (skipped in test env)

**Files:** Modify `apps/server/src/index.ts`.

**Scope:** After the reconciler block, add:

```ts
if (env.NODE_ENV !== 'test') {
  void startRunnerPoller(db);
}
```

Test by smoke (not a unit test — covered by integration tests in D-12).

### Task C-12: Wire `agent.task.assigned` + `comment.mentioned` triggers to insert agent_run rows

> ⚠️ **EXPANSION RECONCILIATION — THE CRITICAL ONE (decision 2026-05-28).** This task is the literal code path where V1-turn-based vs. autonomous is decided, and the outline below knows ONLY the autonomous version. **You MUST fold in the autonomy gate** (`docs/PHASES.md` → "Autonomy gate — V1 ships 'agent does one task, waits'"; `memory/project_folio-agent-thesis.md`). Concretely, when expanding:
> - V1 ships turn-based: a human initiates, agent does one task, stops, waits. The V1↔autonomous line is exactly *can an agent's own output fire another agent run?*
> - Add `FOLIO_AGENT_CHAINS_ENABLED` (default **false**). When OFF, the `comment.mentioned` handler MUST NOT create an agent_run row if the triggering comment is **agent-originated** (author is an agent / comment frontmatter carries a `run_id`). Human-posted `@`-mentions and human `agent.task.assigned` fire normally. Emit one `agent.chain.suppressed` event (never silent).
> - Add a boundary test (`runner.autonomy-gate.test.ts` per PHASES): flag OFF → agent-posted `@`-mention yields ZERO rows + one suppressed signal; human-posted `@`-mention yields exactly one row. Flag ON → agent mention fires (subject to the six guards).
> - The six guards stay live regardless of the flag (they cap a single run too). Flag governs cross-run fan-out; guards govern resource caps. Orthogonal — don't conflate them.

**Files:** Modify `apps/server/src/lib/trigger-matcher.ts` (or wherever the trigger fire path lives — find via `grep -rn "agent.task.assigned" apps/server/src`). Modify `apps/server/src/services/comments.ts` (mention parser already exists; just make sure the `comment.mentioned` event is emitted and the trigger handler creates an `agent_run` row instead of synchronously invoking anything).

**Scope:** The two flipped builtins each map their event to "create an agent_run row at status=planning" via the runs table for the parent doc's project. The poller picks up from there. **Critical:** trigger handlers MUST NOT call `runAgent` synchronously — they only insert the row.

Tests: PATCH a work_item's assignee to `agent:foo` → one `agent_run` row appears in the project's runs table at planning. POST a comment with `@foo` → one row. Per-project guard: if the agent's `frontmatter.projects` doesn't include this project, no row is created (allow-list enforcement at trigger-match time).

### Task C-13: Sub-phase C integration gate

- [ ] Full server suite must be green; expect ~556 + ~50 new = ~606 / 0-fail.
- [ ] Type-check clean.
- [ ] Smoke the dev server: configure an Anthropic key (Sub-phase B UI), assign a work_item to an agent, watch the runs table populate with kind=comment + kind=result on the parent. **This is the first "agent does work" moment** — celebrate it.
- [ ] Sub-phase C checkpoint.

---

## Sub-phase D — Routes + MCP parity + admin stats

Goal: ship the five `routes/runs.ts` verbs, refactor the existing MCP dispatch through `executeMcpTool`, add the five new MCP tools (`list_runs / get_run / run_agent / cancel_run / retry_run`), wire `kind=approval` / `kind=rejection` comments to the runner's `runAgentResume` / `rejectRun`, and add the admin runner-stats endpoint.

### Task D-1: `routes/runs.ts` — list + get + create + cancel + retry

**Files:** Create `apps/server/src/routes/runs.ts` + `runs.test.ts`. Mount in `app.ts`.

**Scope:** Five verbs per spec §4g + the `GET /provider-health` snapshot endpoint. Each calls into `services/agent-runs.ts`. `POST /runs` creates the row at planning + (if `input` provided) posts a `kind=comment` from the caller's authContext to the parent first. `cancel` checks status is non-terminal, transitions via `transitionRun(failed, error_reason='cancelled')`. `retry` re-uses `createRun` with `firedBy: 'retry-of:<oldId>'`, throws 409 RUN_ALREADY_ACTIVE if `getActiveRun` is non-null.

### Task D-2: `lib/mcp-dispatch.ts` — full tool registry

**Files:** Expand `mcp-dispatch.ts` + `.test.ts`.

**Scope:** Migrate all existing MCP tools (from Phase 2 + 2.5 + 2.6) into the registry. Each tool entry: `{ name, scopes: string[], argsSchema: ZodSchema, handler: (args, ctx) => Promise<unknown> }`. The runner can now dispatch any MCP tool via `executeMcpTool(name, args, agentAuthContext)`.

### Task D-3: Refactor `routes/mcp.ts` to route through executeMcpTool

**Files:** Modify `apps/server/src/routes/mcp.ts` + verify all `mcp.test.ts` cases still pass.

**Scope:** The JSON-RPC dispatcher becomes a thin wrapper: resolve authContext from bearer, call `executeMcpTool(params.name, params.arguments, authContext)`, serialize result/error to JSON-RPC shape. Zero behavior change visible from outside.

### Task D-4: Add 5 new MCP tools (list_runs, get_run, run_agent, cancel_run, retry_run)

**Files:** Append to `mcp-dispatch.ts` + `mcp.test.ts`.

**Scope:** Each per spec §4i. Tests verify HTTP-twin parity (same body, same error responses, identical row mutations).

### Task D-5: Wire builtin-on-approval / on-rejection to runner

**Files:** Modify `apps/server/src/lib/trigger-matcher.ts`. Add tests for the `internal_action: 'resume_run'` and `'reject_run'` handlers.

**Scope:**
- When a `kind=approval` comment is created, the builtin-on-approval trigger fires. Its `internal_action: 'resume_run'` handler resolves `target_agent` + `parent_id` → finds the matching `awaiting_approval` run via `getPendingApprovalRun` → inserts a new agent_run row at planning with `frontmatter.resume_of=<original_id>` and `chain_id` inherited. The poller picks it up.
- When a `kind=rejection` comment is created, the `internal_action: 'reject_run'` handler invokes `rejectRun(runId)` synchronously.

### Task D-6: Admin runner-stats endpoint

**Files:** Create `apps/server/src/routes/admin-runner-stats.ts` + `.test.ts`. Mount in `app.ts`.

**Scope:** `GET /api/v1/admin/runner-stats` returns `{ pending_count, active_count, recovered_today }`. Admin-only auth (existing helper). No MCP twin (UI-only).

### Task D-7: SSE filter params `?agent=` + `?table=`

**Files:** Modify `apps/server/src/routes/events.ts` (or wherever the SSE endpoint lives) + tests.

**Scope:** AND-combined with the existing `?parent=` and `?run=` filters. Used by E-3 (agent slideover link tile) and E-4 (live runs table updates).

### Task D-8: Sub-phase D integration gate

- [ ] Full server + web suite green.
- [ ] HTTP↔MCP parity tested per Appendix B (one parity test per route×tool pair).
- [ ] Smoke: POST `/api/v1/w/.../runs` → row appears in runs table → run completes. Cancel a running run → next iteration exits. Retry a failed run → new row appears, original preserved.
- [ ] Sub-phase D checkpoint.

---

## Sub-phase E — Web: runs table + link tiles + Cmd-K + banner + body editor wiki-links

Goal: every UI surface the user touches in v1 Phase 3.

### Task E-1: `lib/api/runs.ts` hooks

**Files:** Create `apps/web/src/lib/api/runs.ts` + `.test.ts`.

**Scope:** `useRuns(filter)`, `useRun(id)`, `useCreateRun()`, `useCancelRun()`, `useRetryRun()` — react-query hooks matching the verbs from D-1. Optimistic on create/cancel/retry.

### Task E-2: `useProviderHealth` hook

**Files:** Create `apps/web/src/lib/api/provider-health.ts` + `.test.ts`.

**Scope:** `useProviderHealth(wslug)` — one-shot GET `/provider-health` on mount; subscribes to SSE for `workspace.provider.degraded` + `workspace.provider.recovered` and merges into state.

### Task E-3: Runs link tile on agent + trigger slideovers

**Files:** Create `apps/web/src/components/runs/runs-link-tile.tsx` + `.test.tsx`. Modify agent + trigger slideovers to render it on the Runs tab.

**Scope:** Renders count by status, link "Open Runs table →" navigates to the right URL with the right filter. Live-updates via `?agent=<doc_id>` SSE.

### Task E-4: Runs table rendering (uses existing TableView)

**Files:** No new files — the runs table is just a `tables` row with `slug='runs'`. Verify it renders via the existing TableView from Phase 1.5/1.6.

**Scope:** Add a Playwright smoke that navigates to a project, opens the runs table view, sees the 3 lazy-seeded saved views in the rail.

### Task E-5: Cmd-K commands — Run agent + Approve pending plan

**Files:** Create `apps/web/src/components/cmd-k/run-agent-picker.tsx` + `approve-pending-plan.tsx` + tests. Register the commands in the existing Cmd-K registry.

**Scope:** "Run agent…" — two-step picker (agent → parent doc) + optional input → POST `/runs`. "Approve pending plan" — list `?status=awaiting_approval` runs workspace-wide; selecting navigates to the parent doc's slideover.

### Task E-6: Approval-buttons live state

**Files:** Modify `apps/web/src/components/comments/approval-buttons.tsx` + tests.

**Scope:** Per spec §6d. Queries the linked run via `useRun(comment.frontmatter.run_id)`. Renders interactive buttons only on `awaiting_approval`; renders muted "Approved by @stefan · 3m later" once running/completed; muted "Rejected by @stefan · 5m later" on rejected. SSE keeps it live.

### Task E-7: ProviderHealth banner + agent-slideover inline notice

**Files:** Create `apps/web/src/components/shell/provider-health-banner.tsx` + `.test.tsx`. Mount in the main shell. Modify `agent-slideover.tsx` for the inline "Provider currently offline" notice. Make `workspace-settings.tsx` honor `?tab=ai&provider=<provider>` URL param.

**Scope:** Per spec §6g. "Check key" link navigates with the right query string.

### Task E-8: `[[` wiki-link picker in the document body editor

**Files:** Modify `apps/web/src/components/slideover/document-slideover.tsx` to wire the `WikiLinkPicker` (from Phase 2.6) into the Milkdown body editor. Tests verify `[[` opens the picker and selection inserts `[[<slug>]]`.

### Task E-9: Sub-phase E integration gate

- [ ] Full suite green.
- [ ] Type-check clean.
- [ ] Manual smoke: assign a work item to an agent via the UI → run executes → kind=result comment appears → runs table view shows the row.
- [ ] Sub-phase E checkpoint.

---

## Sub-phase F — Shake-out + Playwright + branch close

### Task F-1: Manual QA doc

**Files:** Create `apps/web/tests/manual-qa-phase-3.md`.

**Scope:** One scenario per Phase 3 PHASES.md acceptance checkbox. Covers AI settings visuals (all 4 providers), real Anthropic test-key, runs table SSE-driven status flips, approval banner re-render under flaky network, Ollama on localhost, dark mode parity, provider-down banner happy + recovery.

### Task F-2: Real-Anthropic Playwright test

**Files:** Create `apps/web/tests/e2e/phase-3-real-anthropic.spec.ts`. Add `FOLIO_TEST_ANTHROPIC_KEY` to `.env.example`.

**Scope:** Test skips with `test.skip(!process.env.FOLIO_TEST_ANTHROPIC_KEY)`. When the key is set: configure it in the UI, assign a work_item to a reply-drafter agent with system prompt "Reply in one short sentence in English", model `claude-haiku-4-5`, wait for completion, assert a kind=result comment exists on the parent.

### Task F-3: Provider-offline banner Playwright

**Files:** Append a spec to `apps/web/tests/e2e/phase-3-provider-banner.spec.ts`.

**Scope:** Mock the Anthropic SDK at the server boundary (via an env-controlled stub in the e2e harness) to return 503 three times → assert workspace banner appears. Flip the stub to success → assign a 4th run → banner clears.

### Task F-4: Run `netdust-core:shake-out` skill

Invoke the skill from the controller. The skill sweeps the artifact end-to-end and produces a manifest at `tasks/shake-out-manifest-phase-3.md`.

### Task F-5: 4 reviewer agents in parallel

Per `netdust-core:shakeout` skill (non-WP variant = 4 reviewers): architecture-strategist, security-sentinel, code-simplicity-reviewer, performance-oracle. Run in a single message with 4 parallel Agent tool calls. Aggregate findings into the shake-out manifest under "Reviewer backlog".

### Task F-6: `/code-review --base=main --effort=high --comment`

Inline PR pass on the full Phase 3 diff. Resolve every must-fix-before-merge with failing-test-first commits per the Phase 2.6 pattern.

### Task F-7: Update STATE.md + MEMORY.md + PHASES.md

**Files:** `memory/STATE.md`, `~/.claude/projects/-home-ntdst-Projects-folio/memory/MEMORY.md`, `docs/PHASES.md`.

**Scope:** Tick every Phase 3 acceptance checkbox; write a STATE.md "Phase 3 shipped" entry; add an auto-memory `project_phase-3-shipped.md` and link from MEMORY.md.

### Task F-8: `superpowers:finishing-a-development-branch` → `--no-ff` merge into main

Final commit on the branch: `phase-3: complete`. Merge command guided by the skill; do not skip the skill (it surfaces uncommitted state and untracked files before merging).

---

## Self-review checklist

After expanding C-1..F-8 inline (the executor's job, per the spec), re-read this whole plan against the spec at `docs/superpowers/specs/2026-05-26-phase-3-agent-runner-design.md`:

- [ ] **Spec §1 wedge items present:** provider abstraction (B-2..B-5) · runner (C-8..C-9) · agent_run type (A-2 + A-4) · runs as documents lazy-seeded (C-6) · kind=plan/comment/result/error (C-8) · two-phase approval (C-9 + D-5) · token budget (C-8) · delegation depth (C-8 pre-flight) · BYOK (B-6 + B-7) · shared MCP/HTTP dispatch (C-7 + D-2..D-4) · parity rule (D-4) · `[[` wiki in body editor (E-8). ✅
- [ ] **Spec §2 architecture principles all addressed:** polling worker (C-10..C-11) · shared dispatch (C-7 + D-2..D-4) · runs are documents (A-2 + C-6) · coalesce don't queue (C-1's idempotency + getActiveRun) · 6-guard defense (C-4 + C-8). ✅
- [ ] **Spec §3 data model:** Migration 0012 (A-2) covers CHECK + 4 indexes; 0012a (A-3) flips builtins; Zod (A-4). ✅
- [ ] **Spec §4 services + routes:** every named function in §4a is tasked (C-1..C-6). `lib/runner.ts` (C-8, C-9). `lib/poller.ts` (C-10). `lib/mcp-dispatch.ts` (C-7, D-2). `routes/runs.ts` (D-1). `routes/ai.ts` (B-6). admin-runner-stats (D-6). ✅
- [ ] **Spec §5 events:** all 10 new event kinds in A-1; `?agent=` + `?table=` SSE filters in D-7. ✅
- [ ] **Spec §6 UI surfaces:** AI settings tab (B-7); runs table (E-4 via existing TableView); link tiles (E-3); approval banner live (E-6); Cmd-K (E-5); `[[` body editor (E-8); provider-down banner (E-7). ✅
- [ ] **Spec §7 tests:** unit-test list in §7a covered by tests within each Task; integration tests in §7b are smoke-covered by Sub-phase D + E integration gates and the manual-qa doc in F-1; Playwright in §7c covered by F-2 + F-3 + existing click-through suite. ✅
- [ ] **Spec §8 dependencies:** Phase 2.6 substrate referenced everywhere; no Phase 2.7 dependency (templates parked). ✅
- [ ] **Spec §9 open questions:** noted in this plan's Open decisions box. ✅
- [ ] **Spec §10 acceptance:** every numbered item maps to at least one task above. ✅
- [ ] **Testing-workflow gates:** present at each sub-phase boundary (A-5, B-8, C-13, D-8, E-9). ✅
- [ ] **`[[memory-feedback-items]]`:** `[[migrations-first-when-routes-look-broken]]` honored by Task A-0; `[[drizzle-migration-journal]]` honored by A-2 + A-3 + automated via the pre-commit hook in A-4b; `[[verify-subagent-test-counts]]` called out in the testing-workflow contract; `[[mock-the-wire-not-the-response]]` called out in C-5 + C-8; `[[plan-server-source-audit]]` is implicit in the executor's habit but worth a callout: when the executor adds the 5 new MCP tools in D-4, they MUST grep ALL of `apps/server/src` for hardcoded scope strings and tool-name constants, not just the new files. ✅
- [ ] **Phase 3 review remarks folded in (2026-05-28).** Remark #1 (poller claim race) — already covered by C-3's optimistic-lock pattern; multi-instance is post-v1 per spec §9. Remark #2 (provider degrade sensitivity) — covered by env-tunable `FOLIO_PROVIDER_DEGRADE_THRESHOLD` (default 3 consecutive); time-window deferred to v1.1 if shake-out reveals banner thrash. Remark #3 (SQLite JSON index) — C-4 now includes a 10k-row EXPLAIN volume test asserting the chain index is used. Remark #4 (testing-workflow enforcement) — automated via the new A-4b pre-commit hook. Remark #5 (dependency placement) — already correct in B-2/B-3 (`cd apps/server && bun add`). ✅
- [ ] **Placeholders scanned:** Sub-phases C / D / E / F are described as scope summaries, NOT as bare "TBD". Each Task has scope + files + behavioral expectations + test coverage in plain English. The executor expands each into the full failing-test → implementation → pass → commit form following the A-* / B-* pattern shown verbatim. This is intentional: writing all ~70 tasks inline would produce a ~5000-line plan that nobody re-reads; the locked structure + scope per task is enough for a skilled executor and avoids the false confidence of one-shot code that hasn't been measured against the real codebase. ✅

---

**Plan saved.** Execution choice next.
