# Design — The Built-in Folio Operator Agent

_Date: 2026-06-01 · Status: design approved, awaiting spec review · Branch context: explored on `phase-3.x/unified-document-save`_

## Summary

A **built-in operator agent**, seeded into every Folio instance, that a user *talks to in the cockpit panel* to get work done across the whole instance — set up projects, author views and filters, change settings, add users, trigger other agents. Its capability is **not** a menu of admin tools. It is:

1. **A general API primitive** — `folio_api(method, path, body)` — one escape hatch that reaches any REST endpoint, alongside the ergonomic `query` / `read` / `write_document` hot-path tools.
2. **A `folio` skill** — the API + schema + conventions manual, loaded as workspace content. This is *how* the agent knows which endpoint and payload to use. A new Folio feature → documented in the skill → the agent can use it, with **no runner change**. This is the mechanism that eliminates the "maintain a tool list per task" problem.
3. **A per-instance agent memory, split in two** — a volatile **working log** (recent timeline, decays) and a curated **workspace profile** (canonical truths). Not one append-only blob — see the memory section for why that rots by month 6.

**Authority is a delegate model — the agent can never exceed the permissions of the human talking to it** (load-bearing security invariant). **Safety is a risk-tiered gate**: low-risk → auto; medium → auto-with-undo; high → plan/apply (v1 approximates risk by resource type; the real model scores it — see the gate section). The plan/apply tier rides a **universal `dryRun` mechanism** — every mutating route returns `{would_create, would_update, ...}` — so there is no per-endpoint plan code.

**Strategic framing:** this is not a feature — it is the **operating system for Folio**. The external-MCP story is "bring your own agent"; the built-in operator is "Folio already understands itself." Complementary, not competing. The genuinely novel pieces are the **`folio` skill** and the **caller-identity delegation model** — the rest is plumbing around them.

The agent rides the **entire Phase 3 spine already built** — runner, **cockpit panel** (its home — the cockpit was built for exactly this), runs-history, SSE, scopes, the agent-document model, body-as-prompt. **No new interface.**

## Why this exists / the thesis

This is **Claude-Code-for-Folio** — the locked agent thesis (`folio-agent-thesis`: agent is power user, human is reviewer; `folio-tools-as-primitives`: few general tools + skills-as-workspace-content + memory) taken to its natural end. An elite user isn't elite because of 50 buttons; they're elite because they understand the system and drive its general controls. So capability grows by **widening the reach of a few primitives**, not by adding a verb per task.

This **deliberately extends one locked decision**: `folio-tools-as-primitives` said "documents-only primitives." This spec widens the primitive to the **whole token-scoped REST surface** via `folio_api`. That widening is the entire point — mark it explicitly in `DECISIONS.md`.

## Scope: two sequenced sub-phases (folded into one spec on purpose)

The agent is meaningless without the API surface beneath it. The agent phase's every capability claim is a direct cell in the API-completion phase's route table. Splitting them into separate specs would let them drift; one spec nails capability to its prerequisite route.

> **Note on phase numbering.** Phase 4 as written (`docs/PHASES.md:1059`) is **inbound webhooks** — external systems POST *into* Folio. It does **not** build the token-scoped write surface this agent needs. The prerequisite is the distinct API-completion work below, independent of Phase 4 (can run before or after it). "Wait until after Phase 4" was the original instinct; the corrected dependency is "after API-completion," which is its own body of work.

### Build sequence (the recommended ordering)

The genuinely novel pieces are **delegation** and **the skill**; everything else is plumbing around them. Build in this order — caller-identity delegation is **Phase 1, nothing before it** (see "the biggest technical risk" below):

1. **Finish the approval gate** (Phase 3.x `awaiting_approval`) — the plan/apply tier needs it.
2. **Caller-identity delegation** — thread the caller onto the run + intersect scopes at execution. *The real project. Lead phase.*
3. **Token-scoped API surface** — the resource inventory below, every mutating route supporting `dryRun`.
4. **`folio_api`** — the general primitive on top of (2)+(3).
5. **The `folio` skill** — the manual.
6. **Seed the operator agent** — the body-as-prompt document.

### Phase 1 — Caller-identity delegation — THE keystone, build first

**This is the real project. Everything else is straightforward plumbing.** It changes the execution model:

```
Currently:   Agent → owns token → runs tools
Target:      User → starts run
             Run  → carries caller identity
             Tool execution → resolves caller's permissions
             Agent → acts as delegate (effective = agent_scopes ∩ caller_permissions)
```

It touches **runner, scopes, tools, audit logs, and the approval gate**. Make it Phase 1; nothing else lands before it, because every route's auth assertion in the next phase needs a caller on the run to assert *against*. Threat-model it hardest.

### Phase 2 — API completion (the token-scoped write surface) — the heavier, riskier half

Today Folio's REST surface is documents-mostly and session-auth-mostly. The general `folio_api` primitive is only as capable as the routes it can call **with a bearer token and a scope**. This phase walks every instance resource the agent must operate and guarantees, per resource:

- **(a)** a REST route exists,
- **(b)** it accepts the agent's **bearer token** (not session-only),
- **(c)** it is behind a **scope** the delegate-authority check can mirror from the caller,
- **(d)** it re-asserts the **tenant guard** (cross-workspace isolation),
- **(e)** it **emits an event** on mutation (every-write-emits-event holds for the general path),
- **(f)** it supports **`dryRun=true`** — returns `{would_create, would_update, would_delete, ...}` WITHOUT mutating. This is the universal planning mechanism: the plan/apply gate calls the endpoint with `dryRun`, renders the diff, and on apply re-calls without it. **No per-endpoint plan logic ever gets written.** It also powers the medium-risk "auto-with-undo" preview. `dryRun` support is part of the route contract, not an afterthought.

**Resource inventory** (each row becomes a route + scope audit, a `dryRun` implementation, and a row in the `folio` skill's reference table):

| Resource | Operations needed | Current state | Gate for agent |
|---|---|---|---|
| **Views** | create / update / delete | read-only (MCP `list_views` / `run_view`) | **auto** (reversible config) |
| **Filters** | author (part of view config) | via view config | **auto** |
| **Fields** | write (pin type, options) | read exists; write needs token-scoping | **auto** |
| **Settings** | read (redacted) / update; AI-key config | session-only | **plan → apply**; AI key write-only, never returned |
| **Users / memberships** | invite / add / role-change | session-only | **plan → apply** (highest blast radius) |
| **Workspaces / projects** | create / configure | partial; token-scope audit needed | create = **plan → apply**; configure = **auto** |

Each row lands with: route verb+path, required scope, auth method (must include token), tenant guard, event emission, and **auto vs plan→apply** classification. This table **is** the agent's API manual (it gets copied into the skill).

**Honest risk:** This phase opens auth on resources currently session-walled *for good reason* (users, settings). That is a real attack-surface change and is why this spec carries a mandatory threat model (below).

### Phase 3 — The agent itself — the smaller, content-heavy half

On top of the delegation model + completed surface:

- **The `folio_api` tool** — `folio_api(method, path, body)`, registered in the shared tool registry (`lib/agent-tools-registry.ts`), scoped at execution time by the delegate intersect. Mutating calls route through the risk gate (`dryRun` → plan → apply for high-risk).
- **The `folio` skill** — workspace content (not hardcoded), containing the resource→route→scope table, schema conventions, worked recipes for keystone tasks, and the risk-gate protocol.
- **The memory convention** — the two-layer working-log + workspace-profile design (see memory section).
- **The seeded agent document** — every fresh instance is born with the operator agent (body-as-prompt; the prompt points it at the skill + memory).
- **The approval gate** — finished first per the build sequence (Phase 3.x `awaiting_approval`, designed-not-built): `docs/superpowers/plans/2026-05-30-phase-3.x-model-initiated-approval.md`.

## Authority & safety model (the security heart)

### The delegate invariant (load-bearing)

Every `folio_api` call is authorized **as if the calling human made it**. The agent holds **no standing authority of its own**. Effective scope is intersected at call time:

```
effective_permissions = agent_scopes ∩ caller_permissions
```

An owner talking to it can add a user; a member talking to it cannot — *the same agent*, different ceiling. This closes the privileged-bot escalation path entirely. **The agent can never exceed the human in front of it.**

### The biggest technical risk — caller-identity delegation (Phase 1, build first)

**This is the real project; everything else is plumbing.** Folio's current run model resolves authority from the **agent's own token/owner**, not from a live caller (`Agent → owns token → runs tools`). The target (`User → starts run → Run carries caller identity → tool execution resolves the caller's permissions → Agent acts as delegate`) is a change to the **execution model**, not a tweak. It touches **runner, scopes, tools, audit logs, and the approval gate** at once. The intersect (`agent_scopes ∩ caller_permissions`) happens at tool-execution time in the shared `executeTool` path (`lib/agent-tools.ts`). Build it first; threat-model it hardest. Nothing else lands before it.

### Risk-tiered execution gate

Risk is **scored, not inferred from resource type** — the same endpoint is low- or high-risk by *payload* (edit one field vs. bulk-edit 200). The score considers:

- **number of objects touched** (1 vs. 200),
- **reversibility** (undoable vs. destructive),
- **workspace-wide effects** (one project vs. the whole workspace),
- **permissions affected** (none vs. role/membership changes).

Three tiers:

- **Low-risk → auto.** Document writes, queries, reads, triggering an already-permitted agent, single reversible config edits. Asking permission here is the fatigue trap.
- **Medium-risk → auto-with-undo.** Runs, but surfaces an undo affordance (the `dryRun` diff is the undo preview). Bounded, reversible, but worth a glance.
- **High-risk → plan/apply.** Many objects, irreversible, workspace-wide, or permission-affecting. The agent emits the `dryRun` diff; a human clicks apply.

**v1 ships the resource-type approximation** (the inventory table's auto/plan→apply column) — it is the coarse proxy for the score. **The full scored model is explicitly NOT v1**, but the gate is designed so the scorer drops in later without re-plumbing: every mutation already routes through the same `dryRun`→render→apply path; the only thing v1 hardcodes is the tier decision.

- **Free self-critique:** before proposing a high-risk plan, the agent critiques its own plan in-loop ("what's irreversible here?"). One reasoning step, no second human.

> **Cost note:** the human's *attention* is the scarce resource, not tokens. Approval fatigue kills these products. Tier the gate by **risk**, never per-task.

### Threat model (mandatory — per CLAUDE.md; touches auth/token surfaces, BYOK, multi-tenancy)

The implementation plan MUST expand this into a full `## Threat model` section (invoke `netdust-core:threat-modeling`). Named surfaces to cover:

1. **Privilege escalation** via the general primitive → mitigated by the intersect-with-caller invariant.
2. **Confused deputy** — agent tricked via document/injected content into an escalating `folio_api` call → mitigated by the delegate ceiling (can't exceed caller) + high-risk plan/apply on mutations + the existing "treat untrusted context as data" fence.
3. **BYOK key exfiltration** — agent must never read an AI key back via `folio_api GET settings` → redact secrets **at the loader** (extends the locked redact-at-the-loader discipline; grep every consumer: HTTP + MCP + the new general path).
4. **Multi-tenancy / cross-workspace** — `folio_api` must not reach a workspace the caller can't → intersect handles it; every Phase 2 route re-asserts the tenant guard independently.
5. **`dryRun` parity** — a `dryRun` call must NOT mutate and must NOT leak data the real call would redact (it shares the same loader/redaction path); the diff it returns is itself subject to the delegate ceiling.
6. **Audit** — every `folio_api` mutation emits an event → complete trail of agent-initiated instance changes.

## The skill & the memory system

### The `folio` skill — the manual that makes it elite

- Lives as **workspace content** (skills-as-workspace-content, so CC-over-MCP and the in-app agent share one source). Not hardcoded in the binary.
- Contains: the **resource→route→scope table** (the API reference), schema conventions (frontmatter-is-the-schema, snake_case keys, slug rules, document-type split), **worked recipes** for keystone tasks ("set up a project," "author a view + filter," "add a user"), and the **plan→apply protocol** (auto vs draft).
- Versioned + seeded on fresh instances; updatable. New feature → skill row → agent can use it. **This kills the maintain-a-list problem.**

### The memory system — how it learns this instance (the weakest part — designed against its own rot)

Memory is distinct from the skill (general Folio knowledge, same everywhere) — memory is **this customer's** accrued context. It is also the part most likely to fail, and not because the idea is bad: **every agent-memory system sounds good until month 6.** A single append-only blob becomes *worse than useless* after ~500 runs:

```
User prefers blue fields.  →  (no wait)
User renamed sales pipeline.  →  (actually reverted)
Project alpha means X.  →  Project alpha now means Y.
```

The churn — facts that get superseded, reverted, contradicted — turns one append-only store into garbage the agent can't trust. So memory is **split in two**, never one thing:

- **Working memory (`memory.log`)** — *volatile.* The raw recent timeline (last ~30–60 days). Append-friendly, decays out. The agent's short-term "what happened lately." Bloat here is bounded by the decay window, so churn is harmless.
- **Instance profile (`workspace_profile.md`)** — *curated.* Canonical truths only: project naming conventions, **field definitions** (what a custom field *means here*), **team members**, **preferred workflow**. This is the thing the agent **trusts**. Updated deliberately (a fact changes → the profile is *edited*, not appended-over), so contradictions get resolved at write time, not accumulated.

This is the PARA-style raw-timeline-vs-distilled-knowledge split: the log is cheap and forgettable; the profile is small, authoritative, and curated. The agent reads *both* at start but **weights the profile as truth and the log as recent context**.

- Mechanically: both ride the document primitive the agent already owns (e.g. two reserved-slug `page` documents per workspace, or a small dedicated store if it earns itself) — no new storage, stays inside one-binary / SQLite, no sidecar.
- **Still-honest caveat:** even split, the profile needs a *curation discipline* (when does a log fact get promoted to the profile? when does a profile fact get retired?). v1 keeps promotion **manual/agent-proposed** (the agent suggests a profile edit, it's a normal reviewable write); **auto-promotion and log decay are explicitly future refinements, not a v1 solve.** The split is what makes those refinements *possible* without a rewrite.

## In-app surface — no new interface

The operator agent's home is the **already-shipped cockpit panel** (~360px right panel; Run / Activity / Agents tabs). "Run agent…" via Cmd-K opens it. The cockpit was built for exactly this. Plan→apply diffs surface as **plan comments** (the existing run-deliverable model). A guided "set up a project for me" **onboarding wizard** is a **fast-follow** — after the capability is proven — not v1. v1 is about the *capability*, not net-new UI.

## What rides existing work (net-new is small)

Reuses: the runner, the cockpit panel, runs-history, SSE, the scope system, the agent-document + body-as-prompt model, the shared tool registry, the redact-at-the-loader discipline, the (designed) approval gate.

Net-new: (1) the caller-identity-on-run + scope-intersect keystone (Phase 1 — the real work), (2) the token-scoped write routes + universal `dryRun` (Phase 2), (3) the `folio_api` tool, (4) the `folio` skill content, (5) the two-layer memory convention, (6) the seeded operator agent document, (7) finishing the `awaiting_approval` gate.

## Strategic assessment

This is **more important than autonomous research agents, work-item agents, or agent chains** — because it becomes the **operating system for Folio**. External MCP = "bring your own agent." Built-in operator = "Folio already understands itself." Complementary, not competing. The novel pieces are the **`folio` skill** and the **caller-identity delegation model**; the rest is plumbing around them. Prioritize accordingly: it earns its place ahead of further autonomy work.

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

- **Build in the documented sequence**: approval gate → caller-identity delegation (Phase 1) → token-scoped API surface + `dryRun` (Phase 2) → `folio_api` → skill → seed agent (Phase 3). Caller-identity delegation comes first; nothing else before it.
- The `awaiting_approval` gate (Phase 3.x) must be finished for the high-risk plan/apply tier.
- A `netdust-core:threat-modeling` pass expands the threat model section before task breakdown — delegation is the surface to model hardest.
