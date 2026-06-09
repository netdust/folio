# Follow-up: token auth-model findings (stale privilege + instance-PAT reach)

**Filed:** 2026-06-09, deferred from the MCP gap-hunt (the M-MCP-1/2/3 transport fixes
shipped on `fix/mcp-error-leak-and-auth`). These are auth-MODEL decisions affecting ALL
token transports, NOT MCP-transport bugs — they need their own threat-modeled branch,
not a drive-by. One of them is partly by-design under the one-team model.

**Do NOT bundle these into a transport fix.** They change the auth posture.

## Findings

### A1 — [RE-SCOPED: LOW, with a trigger condition] Stale token privilege: scopes ceilinged only at mint-time, never re-derived

> **Severity re-calibrated 2026-06-09 after a code+model ground-truth.** The MECHANISM
> is real and confirmed (`requireScope` reads `t.scopes` verbatim; no request-time
> re-derivation). But the HIGH label was miscalibrated for Folio's actual deployment
> shape: one instance = one team (typically 1–3 humans, often a single owner); demotion
> is a deliberate owner-only act (`instance-users.ts:97`, `assertNotLastOwner`) performed
> by someone who can revoke the demoted user's tokens in the same step; and the exploit
> requires a formerly-trusted insider — an actor class Folio's threat models mark OUT of
> scope. So this is a **defense-in-depth / hygiene gap, not an active exploitable hole**.
>
> **Decision (2026-06-09): do NOT open a threat-modeled branch now.** The "re-architect
> auth across all token transports" framing was disproportionate — the actual fix (if
> ever needed) is a one-line intersection in the token-load path, not a re-architecture.
>
> **TRIGGER to graduate back to a real fix:** if routine role-downgrade ever becomes a
> workflow (offboarding flows, or instances with several rotating admins), implement
> option (a) re-ceiling at request time OR option (b) revoke-on-demote off the existing
> `user.role.changed` event (`instance-users.ts:73`). Until then, the operational control
> (short TTL + rotation + revoke-on-demote-by-hand) is sufficient and is now documented
> at the code site (`middleware/scope.ts`, the instance-reach branch).
- **Where:** `mintToken` (token-reach.ts ~122) enforces `scopes ⊆ roleToScopes(creator's role
  AT MINT TIME)`; the resulting scopes are frozen into `apiTokens.scopes`. Every later call
  (MCP and HTTP) takes `callerScopes = token.scopes` verbatim (mcp.ts ~222; bearer.ts
  attachToken). No path re-derives the ceiling against the creator's CURRENT role.
- **Bug:** an owner mints a config:write + agents:write PAT, is later demoted to member; the
  PAT KEEPS the admin scopes and stays fully privileged until manually revoked. This is the
  temporal sibling of the already-fixed mint-time escalation (`auth-audit-2026-06-01` /
  fix/token-mint-scope-ceiling): that closed mint-time over-grant; this is mint-time grant
  OUTLIVING the grantor's authority.
- **Fix sketch (decide via threat model):** either (a) re-derive the effective ceiling at
  request time — `token.scopes ∩ roleToScopes(currentRole(token.createdBy))` — or (b)
  invalidate/downgrade a creator's tokens on role-downgrade. (a) is per-request cost +
  changes behavior for every token; (b) needs a role-change hook. Both have blast radius.
- **Current control:** manual revocation via /instance/tokens.

### A2 — [MEDIUM / partly BY-DESIGN] Instance-PAT reaches every workspace with no per-ws check
- **Where:** `resolveWorkspace` (scope.ts ~46) treats an instance-reach token (workspaceId
  null — the common MCP/CI shape) as role='owner' and SKIPS the per-workspace access check.
  `requireResource` also bypasses the project gate for human PATs (bearer.ts ~164).
- **Status:** BY DESIGN under the post-tenancy one-team model (workspaces are organizational
  folders, NOT a security boundary — see DECISIONS.md drop-workspace-tenancy). An instance PAT
  IS an instance-root credential by construction. Documented here only because it COMPOUNDS A1:
  a stale instance PAT is over-scoped across the WHOLE instance, so A1's blast radius is total.
- **Decision needed:** confirm instance PATs are intended to be instance-root (likely yes), and
  if so, document that they must be treated as root credentials (short TTL? mandatory rotation?).
  No code change unless the one-team model is revisited.
- **RESOLVED 2026-06-09:** instance PATs ARE instance-root by design (one-team model confirmed).
  Documented in-code at `middleware/scope.ts` (the `isInstanceReach` owner-equivalent branch):
  treat as root credentials → short TTL + rotation; revoke on role-downgrade. No code-behavior
  change — this is the "free part" (doc note) of the original ask; the A1 trigger covers the rest.

### A3 — [INFO, no action] Irreversible MCP ops have no confirm gate
- The cockpit confirm gate keys on `conversationId` (undefined on MCP), so an MCP token with
  delete/agents:write scope performs irreversible ops with no confirmation. BY DESIGN (the
  confirm gate is a cockpit UX, not a security boundary; scope is the boundary). Raises the
  stakes on A1 being correct. No change; named for completeness.

## Acceptance
Author a `## Threat model` for the token auth model first (it touches auth/session/token +
multi-actor authority). A1 is the real decision; A2/A3 are mostly documentation. Each code
change: RED-on-revert proven. Cross-reference `auth-audit-2026-06-01` and
`fix/token-mint-scope-ceiling` — this extends that work into the temporal dimension.
