# Design — The Built-in Folio Operator Agent

_Date: 2026-06-01 · Status: design approved, awaiting spec review · Branch context: explored on `phase-3.x/unified-document-save`_

## Summary

A **built-in operator agent**, seeded into every Folio instance, that a user *talks to in the cockpit panel* to get work done across the whole instance — set up projects, author views and filters, change settings, add users, trigger other agents. Its capability is **not** a menu of admin tools. It is:

1. **A general API primitive** — `folio_api(method, path, body)` — one escape hatch that reaches any REST endpoint, alongside the ergonomic `query` / `read` / `write_document` hot-path tools.
2. **A `folio` skill** — the API + schema + conventions manual, loaded as workspace content. This is *how* the agent knows which endpoint and payload to use. A new Folio feature → documented in the skill → the agent can use it, with **no runner change**. This is the mechanism that eliminates the "maintain a tool list per task" problem.
3. **A per-instance agent memory** — a place the agent reads at start and appends to, so it *learns* this instance's specifics over time (project conventions, field meanings, who's who).

**Authority is a delegate model — the agent can never exceed the permissions of the human talking to it** (load-bearing security invariant). **Safety is a two-tier gate**: document-level writes auto-execute; mutating instance-level `folio_api` calls go *plan → human applies*. The agent self-critiques risky plans in-loop before proposing (free, no second human).

The agent rides the **entire Phase 3 spine already built** — runner, **cockpit panel** (its home — the cockpit was built for exactly this), runs-history, SSE, scopes, the agent-document model, body-as-prompt. **No new interface.**

## Why this exists / the thesis

This is **Claude-Code-for-Folio** — the locked agent thesis (`folio-agent-thesis`: agent is power user, human is reviewer; `folio-tools-as-primitives`: few general tools + skills-as-workspace-content + memory) taken to its natural end. An elite user isn't elite because of 50 buttons; they're elite because they understand the system and drive its general controls. So capability grows by **widening the reach of a few primitives**, not by adding a verb per task.

This **deliberately extends one locked decision**: `folio-tools-as-primitives` said "documents-only primitives." This spec widens the primitive to the **whole token-scoped REST surface** via `folio_api`. That widening is the entire point — mark it explicitly in `DECISIONS.md`.

## Scope: two sequenced sub-phases (folded into one spec on purpose)

The agent is meaningless without the API surface beneath it. Sub-phase 2's every capability claim is a direct cell in sub-phase 1's route table. Splitting them into separate specs would let them drift; one spec nails capability to its prerequisite route.

> **Note on phase numbering.** Phase 4 as written (`docs/PHASES.md:1059`) is **inbound webhooks** — external systems POST *into* Folio. It does **not** build the token-scoped write surface this agent needs. The prerequisite is the distinct API-completion work below (Sub-phase 1), independent of Phase 4 (can run before or after it). "Wait until after Phase 4" was the original instinct; the corrected dependency is "after API-completion," which is its own body of work.

### Sub-phase 1 — API completion (the token-scoped write surface) — the heavier, riskier half

Today Folio's REST surface is documents-mostly and session-auth-mostly. The general `folio_api` primitive is only as capable as the routes it can call **with a bearer token and a scope**. Sub-phase 1 walks every instance resource the agent must operate and guarantees, per resource:

- **(a)** a REST route exists,
- **(b)** it accepts the agent's **bearer token** (not session-only),
- **(c)** it is behind a **scope** the delegate-authority check can mirror from the caller,
- **(d)** it re-asserts the **tenant guard** (cross-workspace isolation),
- **(e)** it **emits an event** on mutation (every-write-emits-event holds for the general path).

**Resource inventory** (each row becomes a route + scope audit, and a row in the `folio` skill's reference table):

| Resource | Operations needed | Current state | Gate for agent |
|---|---|---|---|
| **Views** | create / update / delete | read-only (MCP `list_views` / `run_view`) | **auto** (reversible config) |
| **Filters** | author (part of view config) | via view config | **auto** |
| **Fields** | write (pin type, options) | read exists; write needs token-scoping | **auto** |
| **Settings** | read (redacted) / update; AI-key config | session-only | **plan → apply**; AI key write-only, never returned |
| **Users / memberships** | invite / add / role-change | session-only | **plan → apply** (highest blast radius) |
| **Workspaces / projects** | create / configure | partial; token-scope audit needed | create = **plan → apply**; configure = **auto** |

Each row lands with: route verb+path, required scope, auth method (must include token), tenant guard, event emission, and **auto vs plan→apply** classification. This table **is** the agent's API manual (it gets copied into the skill).

**Honest risk:** Sub-phase 1 opens auth on resources currently session-walled *for good reason* (users, settings). That is a real attack-surface change and is why this spec carries a mandatory threat model (below).

### Sub-phase 2 — The agent itself — the smaller, content-heavy half

On top of the completed surface:

- **The `folio_api` tool** — `folio_api(method, path, body)`, registered in the shared tool registry (`lib/agent-tools-registry.ts`), scoped at execution time by the delegate intersect (below). Mutating calls to plan→apply resources route through the approval gate.
- **The `folio` skill** — workspace content (not hardcoded), containing the resource→route→scope table, schema conventions, worked recipes for keystone tasks, and the plan→apply protocol.
- **The memory convention** — a per-instance memory document/table the agent reads at start and appends to.
- **The seeded agent document** — every fresh instance is born with the operator agent (body-as-prompt; the prompt points it at the skill + memory).
- **The finished approval gate** — Phase 3.x `awaiting_approval` (designed, not built): `docs/superpowers/plans/2026-05-30-phase-3.x-model-initiated-approval.md`.

## Authority & safety model (the security heart)

### The delegate invariant (load-bearing)

Every `folio_api` call is authorized **as if the calling human made it**. The agent holds **no standing authority of its own**. Effective scope is intersected at call time:

```
effective_permissions = agent_scopes ∩ caller_permissions
```

An owner talking to it can add a user; a member talking to it cannot — *the same agent*, different ceiling. This closes the privileged-bot escalation path entirely. **The agent can never exceed the human in front of it.**

### Keystone task (most security-sensitive line in the design)

Folio's current run model resolves authority from the **agent's own token/owner**, not from a live caller. To make authority mirror the *live caller*, Sub-phase 1 must **thread the caller's identity onto the run** and **intersect scopes at tool-execution time** in the shared `executeTool` path (`lib/agent-tools.ts`). This is a real change to the runner's auth resolution. It is the keystone — call it out first in the plan, threat-model it hardest.

### Two-tier execution gate

- **Auto (no gate):** document writes, queries, reads, triggering an already-permitted agent, reversible config (views/filters/fields). Event-emitting, auditable, undoable. Asking permission here is the fatigue trap → don't.
- **Plan → human applies:** any *mutating* `folio_api` call to instance state — users, settings, deletes, bulk ops, cross-workspace, role changes. The agent emits a **readable diff** as a plan comment; a human clicks apply. Cheap *because rare*.
- **Free self-critique:** before proposing a risky plan, the agent critiques its own plan in-loop ("what's irreversible here?"). One reasoning step, no second human; catches dumb mistakes before they reach the human.

> **Cost note:** the human's *attention* is the scarce resource, not tokens. Approval fatigue kills these products. Tier the gate by **blast radius**, never per-task.

### Threat model (mandatory — per CLAUDE.md; touches auth/token surfaces, BYOK, multi-tenancy)

The implementation plan MUST expand this into a full `## Threat model` section (invoke `netdust-core:threat-modeling`). Named surfaces to cover:

1. **Privilege escalation** via the general primitive → mitigated by the intersect-with-caller invariant.
2. **Confused deputy** — agent tricked via document/injected content into an escalating `folio_api` call → mitigated by the delegate ceiling (can't exceed caller) + plan→apply on mutations + the existing "treat untrusted context as data" fence.
3. **BYOK key exfiltration** — agent must never read an AI key back via `folio_api GET settings` → redact secrets **at the loader** (extends the locked redact-at-the-loader discipline; grep every consumer: HTTP + MCP + the new general path).
4. **Multi-tenancy / cross-workspace** — `folio_api` must not reach a workspace the caller can't → intersect handles it; every Sub-phase 1 route re-asserts the tenant guard independently.
5. **Audit** — every `folio_api` mutation emits an event → complete trail of agent-initiated instance changes.

## The skill & the memory system

### The `folio` skill — the manual that makes it elite

- Lives as **workspace content** (skills-as-workspace-content, so CC-over-MCP and the in-app agent share one source). Not hardcoded in the binary.
- Contains: the **resource→route→scope table** (the API reference), schema conventions (frontmatter-is-the-schema, snake_case keys, slug rules, document-type split), **worked recipes** for keystone tasks ("set up a project," "author a view + filter," "add a user"), and the **plan→apply protocol** (auto vs draft).
- Versioned + seeded on fresh instances; updatable. New feature → skill row → agent can use it. **This kills the maintain-a-list problem.**

### The memory system — how it learns this instance

- A **per-instance agent memory** the agent reads at run start and appends to: project naming conventions, what a custom field *means here*, who's who, past decisions. Distinct from the skill (general Folio knowledge, same everywhere) — memory is **this customer's** accrued context.
- Mechanically: a **dedicated memory document/table in the workspace**, riding the document primitive the agent already owns (no new storage, stays inside one-binary / SQLite, no sidecar). Read at start, appended via `write_document`.
- **Honest caveat:** memory needs curation (what to keep, decay of stale facts) or it bloats and degrades. v1 = append-with-light-structure; **memory curation is named as a future refinement, not a v1 solve.**

## In-app surface — no new interface

The operator agent's home is the **already-shipped cockpit panel** (~360px right panel; Run / Activity / Agents tabs). "Run agent…" via Cmd-K opens it. The cockpit was built for exactly this. Plan→apply diffs surface as **plan comments** (the existing run-deliverable model). A guided "set up a project for me" **onboarding wizard** is a **fast-follow** — after the capability is proven — not v1. v1 is about the *capability*, not net-new UI.

## What rides existing work (net-new is small)

Reuses: the runner, the cockpit panel, runs-history, SSE, the scope system, the agent-document + body-as-prompt model, the shared tool registry, the redact-at-the-loader discipline, the (designed) approval gate.

Net-new: (1) the token-scoped write routes of Sub-phase 1, (2) the caller-identity-on-run + scope-intersect keystone, (3) the `folio_api` tool, (4) the `folio` skill content, (5) the memory convention, (6) the seeded operator agent document, (7) finishing the `awaiting_approval` gate.

## Explicitly out of scope (YAGNI)

- A dedicated chat/wizard UI surface (fast-follow, not v1).
- Standing instance-admin authority for the agent (the delegate invariant forbids it by design).
- Autonomous agent→agent chains (`FOLIO_AGENT_CHAINS_ENABLED` stays off — orthogonal, governed by the existing autonomy gate).
- Memory auto-curation / decay (future refinement).
- HMAC, retry queues, rate limiting on the general path (lean on existing run guards + the approval gate).

## Open questions for the plan

- Exact shape of "thread caller identity onto the run" — new run column vs. carried in the run's actor resolution. Decide in the plan with ground-truth from `lib/runner.ts` + `lib/agent-tools.ts`.
- Whether `folio_api` is one tool or `folio_api` (writes, gated) split from `folio_api_get` (reads, ungated) for a cleaner auto/plan boundary at the tool layer.
- Memory storage: a reserved document type vs. a `page` with a known slug vs. a small dedicated table. Prefer riding the document primitive unless a table earns itself.

## Prerequisites before build

- Sub-phase 1 (API completion) lands first; Sub-phase 2 stands on it.
- The `awaiting_approval` gate (Phase 3.x) must be finished for the plan→apply tier.
- A `netdust-core:threat-modeling` pass expands the threat model section before task breakdown.
