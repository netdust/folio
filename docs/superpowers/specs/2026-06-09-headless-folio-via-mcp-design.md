# Headless Folio via MCP — design

**Date:** 2026-06-09
**Status:** Phase 1 detailed (implement now); Phases 2–3 outlined (deferred follow-ups).
**Origin:** an MCP-only eval (`tasks/mcp-eval-manifest.md`) drove the hardened `/mcp`
endpoint through realistic project-management flows and surfaced (a) a real default-table
divergence bug, and (b) that an MCP-only operator cannot create/manage agents headlessly.

---

## North star

An owner/admin operator can run **all of Folio's day-to-day operations through MCP**, never
opening the app — **except** the *root-of-trust class*, which stays session-only by design.

### The framing that governs everything (read first)

The Folio MCP endpoint is **the operator from outside** — same authority model
(`agent ∩ caller` ceiling), same tool registry, same `folio_api` general primitive the
in-app operator drives. "MCP can do everything" is therefore a GIVEN, not new scope.

So most of this work is **convergence, not expansion**: where the external-MCP surface can't
do something the operator can, that is a divergence to align. (See `D2`, `D3` below — those
are pure convergence.)

**The one place this framing does NOT apply — and we are honest about it:** agent lifecycle
(`D1`). Agent create/update/delete reject human PATs on **all** surfaces today (MCP AND HTTP)
— a deliberate, consistently-applied decision with a written rationale (`agent-guards.ts:238`)
that the `agents:write` gate is *insufficient* because a stolen admin PAT could mint an agent
token and pivot through it. Opening `D1` is a **genuine loosening** of that decision, accepted
with eyes open (see the Threat model). It is not dressed up as convergence.

### The root-of-trust class (the deliberate carve-out — stays session-only / app-only)

These remain reachable **only via a logged-in session**, never via any bearer token:

- **Mint any token** — instance reach (`instance-tokens.ts`) OR per-workspace (`tokens.ts`).
- **Create owner/user accounts** — `auth.ts /register`.
- **Change instance ROLE** — promote/demote owner/admin (`instance-users.ts`, owner-only).
- **Write AI/BYOK keys** — `instance-ai-keys.ts` (secret-class). *Reading* "is AI configured?"
  may be headless; writing the encrypted key stays session-only.

Rationale: a leaked admin PAT must not be able to mint fresh credentials, self-promote, or
write provider secrets. Blocking exactly these keeps the leak blast-radius bounded even when
everything else is headless.

---

## Phase 1 — Agents + B1 + skill (implement now)

Three divergences. D2/D3 are convergence; D1 is the accepted loosening.

### D1 — open the agent lifecycle to admin PATs (the security core)

**Current state (ground-truthed):** FOUR surfaces reject human PATs consistently:
- MCP `create_agent` / `update_agent` / `delete_agent` → `mcpRejectHumanPat(token)`
  (`agent-tools-registry.ts:1524,1587,1653`).
- HTTP `POST/PATCH/DELETE /w/:wslug/documents type=agent` →
  `assertNotHumanPatForAgentLifecycle(type, token)` (`agent-guards.ts:254`, called at
  `workspace-documents.ts:75,173,223`).

Both currently allow ONLY: session callers (`!token`) and agent-bound bearers
(`token.agentId` / operator `isOperator`). Both REJECT every human PAT.

**Change:** introduce ONE shared predicate and route all four sites through it:

```
mayManageAgentLifecycle(token):
  session (no token)                 → allow   (unchanged — UI admin)
  agent-bound bearer (isAgentBound)  → allow   (unchanged — self-mgmt / operator)
  human PAT holding 'agents:write'   → ALLOW   (NEW — owner/admin only; member never holds it)
  else                               → reject  (escalation guard — unchanged)
```

- `agents:write` is granted by `roleToScopes` to owner/admin ONLY (`member` never gets it),
  so "holds `agents:write`" IS the owner/admin signal — no role lookup needed.
- Minted agent scope stays **agent ∩ caller** (unchanged; mirrors the trust boundary
  "you are already admin"). Width-guards (`assertAgentAllowListWidening`,
  `assertAgentToolsWidening`) still apply.
- The MCP `-32000` rejection and the HTTP `403 HUMAN_PAT_AGENT_LIFECYCLE_HTTP` error shapes
  are preserved for the still-rejected case (non-admin / no-scope PAT).
- **Convergence requirement:** the MCP and HTTP gates MUST use the SAME predicate. Today they
  are two functions in two files that agree by coincidence; after this change they must agree
  by construction (shared helper), or a future edit re-diverges them.

### D2 — pin the MCP default-table resolver to `work-items` (the B1 bug)

**Current:** `resolveTableForArgs` (`agent-tools-registry.ts:318`) resolves the no-`table_slug`
case via `ORDER BY order ASC LIMIT 1`. HTTP routes pin to `slug='work-items'`
(`scope.ts:119-120`). With a 2nd table (both get `order:0` — `tables.ts:78` never increments),
the MCP rule is a **non-deterministic tie** and disagrees with HTTP. Proven live: after a 2nd
table, `create_document{status:"todo"}` (no `table_slug`) FAILS with
`status "todo" not in registry` because it routed to the wrong, status-less table.

**Change:** the fallback resolver prefers `slug='work-items'`:

```
resolveTableForArgs(p, args):
  if args.table_slug → that table (unchanged)
  else:
    t = table WHERE projectId=p.id AND slug='work-items'
    if !t: t = table WHERE projectId=p.id ORDER BY order ASC, createdAt ASC LIMIT 1   # fallback
    if !t: throw 'project has no tables'
    return t
```

MCP and HTTP now agree, and the skill's documented claim becomes true. The `order=0`-on-create
and the missing `createdAt` tiebreak (B1a/B1b) are left as-is — harmless once the resolver pins
to work-items. (Recorded as accepted residual.)

### D3 — skill correctness + efficiency (`system-skills.ts` folio skill body)

- **Agent-creation recipe** — document that an admin operator creates agents via `create_agent`
  (now works) — `create_agent(workspace_slug, title, frontmatter)` returns `agent_token` ONCE.
- **View enum** — pin `type: "kanban"` verbatim in the views recipe (the natural word "board"
  400s with a Zod enum error; costs a round-trip). Also note `groupBy:"status"` not
  `config.group_by`.
- **B2 status-seeding recipe** — "a table created via `folio_api` has NO statuses; after
  creating a 2nd table, seed its statuses (`folio_api POST …/t/<tbl>/statuses`) before adding
  work_items, or they land status-less and unkanban-able." (Skill-only fix per decision; table
  creation is NOT changed to auto-seed.)
- **Default-table claim** — confirm/keep the existing line (it's now TRUE after D2).

---

## Threat model

> For the D1 agent-lifecycle loosening. Written BEFORE implementation. This is the
> `/code-review` convergence target — reviews verify against the named mitigations, not
> free-form. D2/D3 are not security-loosening (D2 narrows non-determinism; D3 is docs) and
> need no threat model beyond "the resolver still scopes by project + token reach."

### What we're defending

1. The instance's authority model — an admin PAT must not become a path to MORE authority than
   the admin already has.
2. The set of live bearer credentials — every minted `agent_token` is a credential that
   outlives the request; it must stay enumerable and revocable.
3. The root-of-trust carve-out — token-minting, account-creation, role-promotion, AI-key-write
   must remain unreachable by ANY bearer.

### Who we're defending against

- **Stolen admin PAT** (IN scope) — attacker holds an owner/admin instance PAT.
- **Stolen member/low-scope PAT** (IN scope) — must stay unable to touch agent lifecycle.
- **Compromised/prompt-injected agent** (IN scope for width, not for this change) — existing
  width-guards (`assertAgentAllowListWidening`/`assertAgentToolsWidening`) already bound it.
- **Insider with a valid session** (OUT of scope) — a logged-in admin is trusted by definition;
  identical to today.

### Attacks → mitigations

1. **Stolen admin PAT mints a pivot agent** (the code author's stated objection, re-opened by
   D1). Attacker mints an agent with full scopes; the resulting `agent_token` is a SECOND
   credential that survives revocation of the original PAT and is harder to audit.
   - **ACCEPTED RESIDUAL, bounded.** Rationale (decision 2026-06-09): an admin PAT ALREADY
     holds `documents:delete` + `config:write` — a thief with it can already delete/exfiltrate
     and reshape the instance. A pivot agent token is NOT a materially larger blast radius than
     what the stolen PAT already grants.
   - **Mitigation (must hold) — LOAD-BEARING, verify FIRST in Phase 1:** minted agent tokens
     remain LISTABLE and REVOCABLE via the app's token surface, so an operator who rotates the
     leaked PAT can see and revoke any agent it minted. This is the ONLY thing making the
     accepted residual auditable, so it is an explicit, unconditional Phase-1 task (not a
     conditional aside): the first task confirms an MCP-minted agent's token appears in the
     app's revocable-token list and that revoking it kills the agent's authority. If it does
     NOT, that gap is closed IN Phase 1 before D1 ships — the loosening is not acceptable
     without it.

2. **Stolen member / low-scope PAT touches agent lifecycle.** → BLOCKED: the predicate gates on
   `agents:write`, which `roleToScopes` never grants to `member`. RED-first test: a PAT without
   `agents:write` → rejected on all three ops, both MCP and HTTP.

3. **The two gates re-diverge** (a future edit loosens MCP but not HTTP, or vice-versa, leaving
   one surface a privilege-escalation hole). → MITIGATED by construction: a SINGLE shared
   predicate (`mayManageAgentLifecycle`) backs both `mcpRejectHumanPat` and
   `assertNotHumanPatForAgentLifecycle`. Test: the same (token, op) decision is asserted equal
   across the MCP tool and the HTTP route.

4. **Agent minted with scopes WIDER than the caller** (privilege gain, not just pivot). →
   BLOCKED, unchanged: minted scope is `agent ∩ caller`; the width-guards reject an allow-list
   / tools widening beyond the caller. Test: an admin PAT minting an agent requesting a scope
   the PAT lacks → rejected.

5. **Root-of-trust reached via the loosened path.** D1 touches ONLY agent CRUD. Token-mint,
   account-create, role-promote, AI-key-write are untouched and remain session-only. Test: an
   admin PAT still gets 401/403 on each root-of-trust route (regression guard).

### Out of scope (explicit deferrals)

- Confirm-gate + audit-event on every agent mint (the "gate harder" option) — deferred; the
  accepted-residual posture above is the v1 decision.
- Short-TTL / mandatory rotation for admin PATs — operational, tracked in
  `followup-mcp-auth-model.md`.
- Phases 2–3 surfaces (triggers, member/access management) — separate threat models when built.

### How to use this section

- Controller pre-flight: verify mitigations 1-(enumeration), 3-(shared predicate), 4-(width),
  5-(root-of-trust regression) are in plan-supplied code before dispatching tasks.
- `/code-review`: check the diff against these 5 numbered mitigations.
- Downstream phases: cross-reference, don't re-litigate; extend for their surfaces.

---

## Architecture invariant (to author at plan-time, Phase 0)

A new invariant in `ARCHITECTURE-INVARIANTS.md` — the **root-of-trust boundary**:

> **Invariant N — root-of-trust is session-only.** Minting any token (instance or workspace),
> creating user/owner accounts, changing instance roles, and writing AI/BYOK keys are reachable
> ONLY via a logged-in session (`requireSessionUser`), NEVER via a bearer token. Every other
> operation is reachable by an admin PAT (gated on the relevant scope). A new admin surface is
> EITHER in this root-of-trust list (session-only) OR admin-PAT-reachable — there is no third
> option. The agent-lifecycle gate (`mayManageAgentLifecycle`) and the per-route session gates
> are the convergence points; a new write path must route through one of them.

This lets future MCP-headless work (Phases 2–3) review mechanically: "does this new admin
surface route through the admin-PAT gate, or is it correctly in the root-of-trust list?"

---

## Phases 2–3 (outlined — deferred follow-ups)

### Phase 2 — Triggers headless
Open `type:trigger` create/update/delete to admin PATs via MCP (currently HTTP-endpoint-only
per the `create_document` rejection). Its own threat model: triggers fire agents UNATTENDED, so
the surface interacts with the chain-fanout autonomy gate (`FOLIO_AGENT_CHAINS_ENABLED`) — a
distinct attack surface (an admin PAT creating an automation that spawns agent runs without a
human in the loop). Not bundled with Phase 1 for exactly this reason.

### Phase 3 — Instance-admin surfaces headless (minus root-of-trust)
Make member invite/remove (at same-or-lower role), access grant/revoke, workspace management,
and AI-configured-READ reachable by admin PATs over MCP. EXCLUDES the root-of-trust class
(token-mint, role-promote, account-create, AI-key WRITE stay session-only). Heaviest threat
model: member-management and access-grant over a bearer, the role-promotion carve-out enforced
inside an otherwise-opened `instance-users` surface. Likely requires splitting each session-only
mount into "admin-PAT-ok" vs "session-only" handlers rather than opening the whole mount.

---

## Testing posture (Phase 1)

- **D1** is Tier A (auth boundary): RED-first on the denial path (member PAT rejected; admin PAT
  allowed; agent-bound allowed; widened-scope rejected) AND the cross-surface equality
  (MCP decision == HTTP decision for the same token/op). Plus the root-of-trust regression
  guard (mitigation 5).
- **D2** is Tier A (resolution rule feeding create_document): RED-first with a 2-table project —
  no `table_slug` resolves to work-items on BOTH MCP and HTTP; `create_document` succeeds (was
  the live failure).
- **D3** is doc-only (Tier B) — no bespoke test; verified at shake-out by driving the skill
  recipes through the real MCP endpoint (the eval harness).
- **Shake-out / feature-acceptance:** re-run the MCP-only eval flows (multi-table build + agent
  create-run-update-delete) against the real endpoint; the manifest's failing flows must now
  pass.
