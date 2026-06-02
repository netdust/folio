# Review — Security, Code Quality & Agentic Layer (2026-06-02)

Full-codebase review on branch `claude/security-review-organization-ZL00f`. Conducted as
parallel focused deep-dives across security surfaces, code organization, and the agentic
layer. This document records findings only — **no code was changed**.

Scope of evidence: `apps/server`, `apps/web`, `packages/shared`, `scripts`, plus
`ARCHITECTURE-INVARIANTS.md` and `docs/`.

---

## 1. Security — no findings at the reporting bar ✅

Six high-risk surfaces examined; **zero high-confidence exploitable vulnerabilities**
(threshold: >= 8/10 confidence, concrete attack path). Each convergence point carries
explicit, documented mitigations.

| Surface | Verdict | Key evidence |
|---|---|---|
| Auth / session / tokens | Clean | argon2id passwords; CSPRNG (`nanoid`) tokens hashed (SHA-256) at rest; session + magic-link expiry & replay protection; cookie flags `httpOnly`/`secure`-in-prod/`SameSite=Lax`; session-only routes reject Bearer; no session fixation; mint/revoke scope ceiling via `roleToScopes` |
| Authz / multi-tenancy | Clean | membership gate in `resolveWorkspace`; bearer tokens workspace-pinned; by-slug (not by-id) lookups eliminate IDOR; historical `api_token_id` cross-tenant leak (commit `b80419b`) confirmed fixed via positive allow-list, provenance-keyed; `__system` privilege does not leak |
| BYOK crypto / secrets | Clean | AES-256-GCM, fresh random 12-byte nonce per op; master key validated at boot, no insecure fallback; decrypted keys never returned/logged; ciphertext stripped from API responses; provider errors sanitized to status+name |
| SSRF / outbound | Clean | every outbound URL is host-fixed, allow-list-validated + owner/admin-gated (Ollama base URL blocks metadata/private ranges), or in-process-only (`folio-api-tool` rejects schemes/`..`/host) |
| Injection / parsing | Clean | filter/sort SQL parameterized, whitelisted operators, `^[a-zA-Z0-9_]+$`-gated + `fields`-confirmed custom-field path; safe `yaml` parser with reserved-key stripping; no `sql.raw`; `Bun.spawn` array argv (no shell) |
| XSS | Clean | zero `dangerouslySetInnerHTML`; body via Milkdown markdown string (not HTML sink); comments render as escaped React nodes |

**Sub-threshold notes (not vulnerabilities, logged for awareness):**

- **DNS rebinding** — the SSRF allow-list (`apps/server/src/lib/url-allow-list.ts`)
  validates the URL string but does not resolve DNS. An owner/admin who deliberately
  registers a hostname resolving to a private IP could bypass it. Privileged + deliberate;
  already a logged follow-up.
- **PATs have no expiry column** (`schema.ts:324-350`) — high-entropy, hashed, revocable,
  workspace-pinned. Hardening gap, not an exploit.
- **Documented accepted gap:** human PATs skip `requireResource` (`bearer.ts:146`) —
  workspace-pinned but not project-narrowed, gated by the `roleToScopes` ceiling. Tracked
  as a Phase 3+ follow-up in `ARCHITECTURE-INVARIANTS.md`.

---

## 2. Code quality — well-organized, a few consolidation opportunities

Convention adherence is excellent: zero deep relative imports, one legitimate
`export default` (the Bun entry), zero real `: any`, convergence points hold (error
envelope, `rankBetween`, `txWithEvents`-for-all-writes, `roleToScopes`). Large files like
`runner.ts` (1508) and `documents.ts` (1377) are *justified* cohesion, not sprawl. Findings
are refactor opportunities, not defects.

### High

1. **Scope literals have no single source of truth.** The token-scope set is hand-synced
   across `apps/server/src/lib/agent-schema.ts:84`, web's
   `apps/web/src/components/settings/token-create-modal.tsx:14`, and
   `packages/shared/src/mcp-tools.ts` (comments literally say "keep in sync"). Server is the
   security ceiling so a stale web list cannot escalate, but it is fragile. → Promote the
   scope union + `Scope` type into `@folio/shared` (same pattern already used for
   `error-codes`).

### Medium

2. **Comment types duplicated server↔web** with an acknowledged TODO
   (`apps/web/src/lib/api/comments.ts:5-26` mirrors
   `apps/server/src/lib/comment-schema.ts`). → Move `CommentKind` / `CommentVisibility` /
   `ResolvedMention` into `@folio/shared` (do with #1).
3. **`agent-runs.ts` (1808 lines)** carries a self-contained ~370-line provider-health
   subsystem (`apps/server/src/services/agent-runs.ts:1277-1644`) with no data dependency on
   run lifecycle. → Extract to `services/provider-health.ts`.
4. **`agent-tools-registry.ts` (1870 lines)** is one mega-function registering 27 tools
   inline. Cohesive but merge-conflict-prone. → Split tool defs by domain.

### Low

5. **`@/` alias configured + mandated by CLAUDE.md but unused** (code uses single-level
   `../`; `apps/server/tsconfig.json:7`). → Adopt consistently or drop the rule so docs match
   reality. No deep `../../../` exists.
6. **Six route files reach into the DB directly** (`auth`, `tokens`, `workspaces`, `views`,
   `tables`, `statuses`, `fields`) — acceptable for trivial CRUD, all still go through
   `txWithEvents`. Note as a deliberate choice, not drift.
7. **Doc nit:** CLAUDE.md and the `schema.ts:364` comment say "libsodium", but the code uses
   AES-256-GCM. Cosmetic drift.

---

## 3. Agentic layer — backend excellent, frontend & contract sync trailing

**Verdict:** The backend agentic architecture is genuinely well thought out, and "agents are
first-class users" is *real*, not aspirational. The frontend lags the backend on the two
surfaces that most define that wedge, and there is one real contract drift to close. Nothing
is tangled or wrong-headed — it is "backend finished, FE and contract sync trailing."

### What is genuinely strong

- **"Agents are first-class users" is structurally real.** `folio-api-tool` mints a
  short-lived bearer mirroring the caller's exact scopes and dispatches **in-process via
  `app.request` through the same `/api/v1` routes** humans use, then revokes in `finally`.
  Runner and external MCP both call the same `executeTool` chokepoint. **No parallel
  agent-only data path.**
- **Agents cleanly modeled as documents** (invariant 10): `type:'agent'` rows, prompt =
  body, config = frontmatter, scopes *derived* via `toolsToScopes` (never hand-set). Library
  sharing is fail-closed (provenance-asserted `__system`, local-shadows-library resolution,
  positive-allow-list cross-tenant redaction at the loader union,
  `documents.ts:1275-1303`).
- **Event→reaction loop is mature.** Every domain write goes through one `txWithEvents`
  chokepoint (event + SSE same transaction); two delivery planes (lossy live SSE + durable
  cursor-driven reactors) over one append-only table; trigger→match→run→execute is complete
  and idempotent. 100% in-process/SQLite — no sidecar.
- **Execution engine coherent.** Single-source run state machine (`TRANSITIONS` +
  `transitionRun`, TOCTOU-guarded atomic updates), run loop that never throws out (always
  lands terminal), layered bounds (max rounds / consecutive-error cap / token budget), clean
  BYOK provider abstraction, real SQLite-polling driver with a re-entrancy latch.

### Gaps (prioritized — backend ahead of frontend)

**P0 — Tool contract drift (the one real "wiring" defect).** `V1_MCP_TOOLS`
(`packages/shared/src/mcp-tools.ts:10`) lists 19 tools, but the registry has 27. Because
`agent-schema.ts:23` validates an agent's `tools` as a *subset* of `V1_MCP_TOOLS`, **8–11
registered tools** (`find_documents`, `describe_workspace`, all comment tools, all run tools
incl. `run_agent`/`list_runs`) are dispatchable but **cannot be granted to an API-loop
agent**. Enforcement is fine; the advertised capability set fell behind.
→ Reconcile the list + `toolsToScopes` + `MCP_TOOL_GROUPS` in lockstep; add a test asserting
`listToolDefs()` names ⊆/= `V1_MCP_TOOLS` to prevent re-drift. (Or explicitly carve
"MCP-transport-only, not agent-grantable" and document it.)

**P1 — Slash AI commands are stubs.** Brief mandates `/draft`, `/decompose`, `/summarize`,
`/link`, `/ai`. Only `/link` works; the three AI commands `notify('Phase 3 wires this up')`
(`apps/web/src/.../slash-registry.ts:53,62,71`); `/ai` does not exist. The run backend they
would call is live — the editor→runner wiring just is not connected. Registry structure is
correct (one registry; commands merely stubbed).

**P2 — No live run / transcript view.** `useRun` feeds only the approval buttons. Runs
surface as status rows + comment threads (runner posts output as comments), but there is no
watchable streaming cockpit, and `useCancelRun`/`useRetryRun` (`lib/api/runs.ts:94,105`) have
**zero UI consumers**. Most visible FE-lags-backend gap for the "first-class" wedge.

**P3 — Engine robustness rough edges:**
- **No per-run wall-clock timeout.** Providers have `AbortController` plumbing
  (`anthropic.ts:149`) but nothing ever calls abort; a post-boot hung stream is reaped by
  nothing until restart — orphan recovery (`recoverOrphanRuns`) runs **only at boot**
  (`poller.ts:105`), not on an interval. Highest-value engine fix: thread an `AbortSignal`
  with a per-run deadline into `provider.stream()` and move orphan recovery to an interval.
- **Entire `claude-code` provider branch is dead code** — hard-disabled but ~250 lines +
  `cc-executor.ts` + a `Provider` enum member retained, forcing `as ProviderName` casts
  everywhere.
- Round-cap exhaustion reuses `fanout_exceeded` error reason (`runner.ts:1051`) —
  semantically wrong, deserves its own reason.
- `buildToolDefs` advertises an open schema (`additionalProperties:true`), so the model gets
  no per-tool arg-shape hints and relies on the recoverable-error feedback loop.

**P4 — Docs drift.** `docs/API.md` / `docs/MCP.md` materially misstate the tool count (say
20, it is 27), the file location (say `routes/mcp.ts`; tools live in
`lib/agent-tools-registry.ts`), and the scope vocabulary (`docs/API.md:19-27` lists
deprecated `*:write` aliases, omits canonical `config:write` / `agents:write`). For a product
whose wedge is a *documented* REST API + MCP server, this is a credibility gap.

**P5 — Smaller items:**
- No `skills` editor in the agent form (`frontmatter-form.tsx:40-58`) though backend supports
  + materializes `frontmatter.skills`.
- `__system` library union has no `published` filter (`documents.ts:1341`, tracked OP-LIB-1)
  — any `__system` agent is globally invokable. Fine while only the operator lives there;
  blocks adding internal library agents.
- Stale "stub" comment in `trigger-matcher.ts:92-95` — the `internal_action` path it
  describes as a stub is fully implemented.
- Unbounded live SSE queue (`events.ts:205`) — replay is capped (`MAX_DELIVERED=2000`), the
  live per-connection buffer is not.
- `running → awaiting_approval` transition has forward-compat handling
  (`agent-runs.ts:450-452`) but is not in `TRANSITIONS` today (dead defensive logic).

---

## Suggested priority order if these are ever actioned

1. **P0** — reconcile `V1_MCP_TOOLS` + guard test (small, mechanical, closes a real
   capability gap).
2. **Quality #1 + #2** — consolidate scope + comment types into `@folio/shared` (mechanical,
   closes the only forked server/web logic).
3. **P3 timeout + interval orphan recovery** — highest-value engine robustness fix.
4. **P1 / P2** — wire slash AI commands and a live run view (FE catches up to backend).
5. **P4** — refresh `docs/API.md` / `docs/MCP.md` to match implementation.
6. Remaining quality (#3, #4) and P5 items as cleanup.
