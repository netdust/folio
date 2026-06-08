# MCP transport hardening — error-leak + auth fixes

Branch: `fix/mcp-error-leak-and-auth`. Class C (bug-fix bundle from the MCP gap-hunt,
2026-06-09). Surface: `apps/server/src/routes/mcp.ts` (POST /mcp, JSON-RPC 2.0) +
its shared `executeTool` boundary. Sibling to the Phase 3 provider threat model
(`docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md ## Threat model`,
mitigations 1-22) — this extends it to the MCP transport face. Mitigation numbers
here are MCP-prefixed (M-MCP-1..) to avoid collision.

## Threat model

> The /mcp endpoint is a second transport face over the shared executeTool gate.
> The cockpit/runner bugs found this session don't reach it (it doesn't use the
> runner/streaming path), but its OWN error-mapping and JSON-RPC parsing are
> unreviewed and exhibit the same bug CLASSES (unsanitized error → leak; untrusted
> parsing). This section is the convergence target for the fix + /code-review.

### What we're defending

- **A1 — internal/infra detail**: SQL fragments, table/column names, file paths,
  stack-frame text, DB driver messages, libsodium/crypto error text — anything a
  raw `Error.message` from the service/DB layer can embed.
- **A2 — other-actor / cross-workspace content**: any document title, user email,
  or row value a handler might interpolate into an error message.
- **A3 — the /mcp endpoint availability**: a malformed request must not 500 / crash
  the handler or wedge a client.
- **A4 — token authority integrity**: an MCP call's authority is the authenticated
  token's scopes, never the request body; a userless/dangling token must fail
  cleanly, not crash or escalate.

### Who we're defending against

- **External attacker with a VALID low-priv token** (IN scope): a token-holder who
  probes tools to extract internal detail via error messages, or sends malformed
  JSON-RPC to crash/confuse the endpoint.
- **External attacker with NO token** (IN scope): blocked by `requireToken` — confirm
  no method bypasses it.
- **A demoted/over-scoped token holder** (OUT of scope for THIS fix — filed): the
  stale-token-privilege class (token scopes ceilinged only at mint-time) is a
  pre-existing auth-model decision, not an MCP-transport bug. See deferrals.
- **Insider with a stolen valid token** (OUT of scope): standard credential-theft
  assumption; manual revocation is the control.

### Attacks to defend against

1. **M-MCP-1 — Raw error-message leak via the catch-all.** `mapToolErrorToJsonRpc`'s
   final branch returns `{ message: e.message ?? String(err) }` verbatim. Because
   `HTTPError.code` is a STRING, every service-layer `HTTPError` AND every unexpected
   runtime/DB/crypto error falls through to this branch and reflects its raw message
   to the MCP client. The HTTP transport has a backstop (`registerErrorHandler.onError`
   → generic "internal error"); the MCP transport has none. (Sibling of the provider
   `sanitizeProviderError` leak.)
2. **M-MCP-2 — Userless-token crash.** `getUser(c)` is called unconditionally at the
   top of the handler, OUTSIDE the per-method try, BEFORE method routing. A valid
   token whose creator can't be hydrated (dangling `createdBy`) throws a raw Hono 500
   (not a JSON-RPC error) on EVERY method including `ping`/`initialize`/`tools/list`.
3. **M-MCP-3 — Unvalidated JSON-RPC envelope.** `body` is cast `as JsonRpcRequest`
   with no schema. A batch array, a non-object body, or an `id` of the wrong type
   (object/array/boolean) round-trips into the response, breaking JSON-RPC 2.0
   conformance (notifications get a response; `id` reflected verbatim). No crash, no
   auth bypass (verified auth is uniform), but a conformance break that can wedge a
   strict client and reflects an arbitrary `id` value.

### Mitigations required

1. **M-MCP-1 → an MCP-side error sanitizer that keeps DELIBERATE messages, sanitizes
   UNEXPECTED ones.** `mapToolErrorToJsonRpc` passes through: numeric `.code` (already-shaped
   JSON-RPC errors), `method not found` → -32601, `forbidden: scope` → -32603,
   `MCP_INVALID_ARGS` → -32602 (paths only). THEN: an `HTTPError` keeps its message (it is
   author-controlled, agent-facing validation text) with its string `code` surfaced in
   `data.code`. EVERYTHING ELSE (an unexpected raw `Error`/DB/crypto error) collapses to a
   FIXED `{ code: -32603, message: 'internal error' }` + `console.error` server-side — never
   the raw `e.message`. Code-checkable: the final fall-through must NOT interpolate `e.message`.
   NOTE (verified during the fix): the `INVALID_FILTER` HTTPError carries a `FilterCompileError`
   message which is SAFE validation text ("unknown operator …", echoes only caller filter keys),
   so it is correctly KEPT — not the leak the audit hypothesized. Agent-facing raw-`Error`
   validation throws in the registry (`document not found`, `parent not found`) are SHAPED via
   `mcpInvalidParams` so their useful message survives the keep/sanitize split.
2. **M-MCP-2 → fail-closed user resolution.** Move `getUser(c)` INTO the `tools/call`
   branch (the only place `actor.id` is needed). If no user is hydrated, return a
   JSON-RPC `{ code: -32603, message: 'internal error' }` (sanitized), not a thrown 500.
   `initialize`/`ping`/`tools/list` must not require a hydrated user.
3. **M-MCP-3 → validate the envelope.** Reject a non-object body (array/string/number/null)
   with `{ code: -32600, message: 'invalid request' }`. Coerce/validate `id` to
   `string | number | null` before echoing (others → null). Batch arrays explicitly
   rejected with -32600 (not silently mishandled). Notifications (no id) out of scope
   for this fix — documented below.

### Out of scope (explicit deferrals)

- **Stale-token-privilege (token scopes ceilinged only at mint-time, never re-derived
  against the creator's CURRENT role).** A pre-existing auth-MODEL decision affecting
  ALL token transports, not an MCP bug. Filed at `tasks/followup-mcp-auth-model.md` for
  a threat-modeled auth branch. Manual revocation is the current control.
- **Instance-PAT cross-workspace reach** (an instance-reach token is owner-equivalent
  across every workspace): BY DESIGN under the one-team model (workspaces are folders,
  not a security boundary). Documented, not changed.
- **tools/list advertising the full registry unfiltered** (M62, accepted): discovery ≠
  capability; scope is enforced at call time. The 20-tool catalogue has ~nil info value.
- **JSON-RPC NOTIFICATION semantics** (no-id requests should get no response): a
  conformance nicety, deferred — the envelope fix coerces id but still responds.
- **tools/call concurrency / double-submit**: out of scope (the runner's last-write-wins
  is the model; no MCP-specific race introduced).

### How to use this section

- The fix implements M-MCP-1..3 as three TDD cycles (Class C).
- `/code-review` verifies the diff against M-MCP-1..3 + confirms the deferrals weren't
  silently changed.
- The auth-model deferrals are tracked separately; do NOT expand this branch into them.
