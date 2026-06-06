# Folio — Focus Roadmap (the coming weeks)

> **Status:** planning reference, NOT a plan yet. Authored 2026-06-06 to consolidate three external
> evaluations (Multica architecture comparison + a codebase/security quality review) with a
> ground-truth audit of the current codebase. Purpose: a single accurate document to brainstorm
> from later, so the right things — and only the right things — get built.
>
> **How to use this:** read §3 (the gap map) first — it's the part that decides where weeks go;
> §3.5 within it is the source-grounded structural-debt assessment (the four "weak/risky" points
> checked against code). §1 is the strategic thesis. §2 is what's already done (so we don't rebuild
> it). §4 is the three external reports' verbatim signal + how it reconciles. §5 is the open
> brainstorm questions to bring to the working session. **§6 is the sequence & gates — the
> "what we do and when": the discrete shippable chunks, their order, and dependencies (this is
> NOT one build plan).** §7 is the one-screen priority summary.
>
> Sibling docs: `2026-06-06-multica-architecture-study.md`, `2026-06-06-multica-agent-layer-gap-map.md`,
> `ARCHITECTURE-INVARIANTS.md` (the convergence-point contract), `tasks/retro-follow-ups.md`
> (the close-tracking for the two security gaps named below).

---

## 0. TL;DR

- **Folio's security strength is confirmed twice over** (Multica comparison + quality review): the auth /
  authorization / event-integrity core is enterprise-grade (security scored 9/10), built on
  centralized convergence points and intersection-based authorization. Two independent
  evaluations land on the same conclusion the project already believed.
- **The roadmap's "Phase 1 must-haves" are MOSTLY ALREADY BUILT.** Unified auth ✅, event
  backbone ✅ (40+ named event types), operator substrate ✅. Spending weeks "finishing" them
  would be motion without progress.
- **Two real gaps, confirmed by source audit, are exactly where the roadmap intuited them:**
  1. **Work-item state machine** — status is a bare per-project label today; no transitions, no
     guards. This is the *differentiator* (it's what makes "stateful work items" literally true).
  2. **Audit trail** — `events.actor` exists but captures no actor-TYPE (human/operator/Claude/
     external-MCP) and no "why"/reason; no unified audit view.
- **The sharpest framing of what Folio IS** (control-plane-OS evaluation, the third report): *a
  stateful artifact-production system where agents generate evolving outputs and humans steer,
  evaluate, and trigger progression through a governed control plane.* The core primitive is
  **Artifact + State + Lineage** — not the work-item, not the agent. **Caveat (source-verified):
  that evaluation wrongly claims these foundations already exist** — artifact identity is partial,
  and artifact lineage / agent re-entry / derivation are ABSENT. Right destination, wrong position
  estimate; reaching it is an additive data-model reshape (§1, §3.1a).
- **The real long-term risk is not insecurity — it is complexity, from BOTH ends.** The quality
  review's verdict (developer-side): *"Folio is not at risk of being insecure — it is at risk of
  becoming too powerful for its own complexity to remain safely reasoned about."* The
  control-plane-OS evaluation's twin (user-side): *the control plane must stay invisible until
  needed — the default flow must feel like "AI produces good stuff fast," not "I manage a lifecycle
  system."* Every chunk must REDUCE cognitive load (dev) and keep the simple path frictionless
  (user), not add to either (§3.4).

---

## 1. The thesis (the endgame framing)

The single sharpest articulation of Folio's position, from the Multica comparison:

> **A work operating system where humans and agents collaborate through stateful work items.**

The load-bearing word is **stateful**. Not "AI project management," not "agent platform," not
"AI task runner" — those are all *replaceable*. A work-OS where the work item is the durable
source of truth and the agent is a replaceable executor is *much harder to build and much harder
to replace.*

This reframes priority: **the work-item state model is the differentiator, so it gets the
majority of engineering effort** — not sophisticated agent orchestration (which both evaluations
say to delay until users repeatedly ask for it).

The quality review independently classifies the codebase the same way:

> Folio is NOT a CRUD app / agent wrapper / workflow tool. It is **a control-plane operating
> system for work execution** — closer to Kubernetes controller logic, Stripe API internals, or
> Temporal workflow concepts than to a typical web app. Correctness is *structural*, not
> functional/UI/feature-driven. That's why the code "feels dense."

That density is a *consequence of the thesis*, not a defect — but it is the thing to manage (§3.4).

**Refinement (2026-06-06, the "control-plane OS" evaluation — a third report).** When Stefan
described the product from the user's side — *agents produce content (research, articles, leads);
humans evaluate, steer, and trigger more work; the system preserves state + lineage; repeat until
an output is shippable (SEO pages, a blog, newsletters, PDF dossiers, a build plan…)* — a third
evaluation sharpened the thesis further. The precise mental model underneath "work OS" is:

> **A stateful artifact-production system where agents generate evolving outputs and humans
> continuously steer, evaluate, and trigger progression through a governed control plane.**
> Short form: *a control plane for evolving human + AI produced artifacts.*

The key insight worth absorbing: **the core primitive is "Artifact + State + Lineage" — not the
work-item, and not the agent.** A work-item is *execution scaffolding*; the **artifact** (the
evolving article / dossier / SEO page / plan) is what the human actually cares about and what
accumulates value over weeks (an SEO page improved 12 times, not regenerated). The system's job is
not to *do* work — it is to **govern how work evolves**: generation (agents) → evaluation (humans)
→ steering (control plane) → memory (state + lineage), looping until shippable. That is a more
specific category than "task execution" or "agent orchestration": **iterative artifact refinement
with governance.**

**BUT — one load-bearing correction to that evaluation (verified against source 2026-06-06).** The
report claims these foundations *already exist* ("you are not inventing missing foundations, just
connecting existing ones"). **That is the one wrong sentence in it.** Of the five pillars the
artifact model rests on, source says: human-intervention substrate ✅ exists (the operator);
artifact *identity* ⚠️ partial (outputs are scattered across a run transcript + a result comment on
the parent — no independent, re-targetable artifact); **lineage of artifacts ❌ absent** (lineage
exists for *events*, but there is NO `derived_from` link — a newsletter cannot declare it came from
a blog post); **agent re-entry ❌ absent** (agents create new *sibling runs on a parent*; you
cannot say "improve THIS article"); **derivation/fan-out ❌ absent** (no one-source → blog +
newsletter + PDF mechanism). So the *destination* is right and worth steering by; the *position
estimate* is wrong — building toward it is a **data-model reshape** (additive: `derived_from`
links, run-targets-a-document re-entry, multi-output derivation), NOT a wiring job over existing
foundations. The control FLOW (event-driven, transactional, the runner) is solid and stays; the
DATA MODEL grows. Take the destination, reject the "you already have it" optimism — believing the
foundations exist is exactly how chunk 1 gets badly under-scoped. *(This evaluation, like the
quality review, is an LLM's elegant systematization of Stefan's own pitch — coherent ≠ built,
coherent ≠ simple. Useful north star; not a position report.)*

---

## 2. What is ALREADY built (do not rebuild)

Ground-truthed against source on 2026-06-06. The roadmap lists several of these as "must-have /
finish it" — they are done. Confirming this is the point of §2: it stops weeks being spent on
solved problems.

| Capability | State | Evidence |
|---|---|---|
| **Unified authentication** | ✅ Done | One `AuthContext` primitive (`middleware/auth.ts` + `middleware/bearer.ts` are the ONLY identity setters — invariant 1). Web (session) / REST (token) / MCP / operator / agents all read the same context primitive; none re-parses the raw credential. |
| **Unified authorization** | ✅ Done | Every tool call funnels through `executeTool`'s scope double-check, token ∩ caller, fail-closed (invariant 2). HTTP gated by `requireScope`/`requireResource` (invariant 4). Project ceiling = `agent ∩ token ∩ caller` in one place (invariant 3). Role ceiling via `roleToScopes` (invariant 7). Human visibility via `lib/access.ts` only (invariant 4a). |
| **Event backbone** | ✅ Done — richer than the roadmap's wishlist | Every write goes through `txWithEvents` (invariant 5, 16 server files). **40+ named event types already emitted:** `document.created/updated/deleted`, `agent.run.started/running/completed/failed/transcript`, `agent.task.assigned`, `comment.created/updated/deleted/mentioned`, `access.granted/revoked`, `field.*`, `status.*`, `view.*`, `table.*`, `project.*`, `workspace.*`, `user.role.changed`. The roadmap's wishlist (`workitem.created`, `agent.started`…) is a SUBSET of what exists. |
| **Operator control-plane SUBSTRATE** | ✅ Substrate done; product depth is the work (§3.3) | Multi-turn cockpit chat (`lib/operator.ts`, `routes/conversations.ts`) with 16 tools incl. the general `folio_api`/`folio_api_get` read+write escape hatch, plus `create_document`, `update_document`, `list_projects/views/statuses/fields`, `run_view`, `get_skill`, `set_skill_trust`, `show_link_panel`, `ask_choice`. It reads+writes across the instance, bounded by caller authority. |
| **Skill trust** | ✅ Done | `instance_skills.trusted` is a typed column, set only via `setSkillTrust`/`canBlessSkill`; trust-forging is structurally impossible (invariant 11). |

**Implication:** the roadmap's items 1 (auth), 3 (event backbone) are done; item 5 (operator) is a
substrate that needs product depth, not foundation. The work is items 2 (state machine) + 4
(audit) + operator depth — see §3.

---

## 3. The gap map — where the coming weeks go

Three items, in priority order. The order is set by the thesis (§1): the state machine earns the
word "stateful," so it leads.

### 3.1 — Work-item state machine  ❌ GENUINE GAP — **highest leverage, the differentiator**

**Current reality (audited):** `documents.status` (`db/schema.ts:270`) is `text('status')` that
matches a `statuses.key` row — a per-project-configurable label (CLAUDE.md: "per-project
configurable, not hard-coded states"). There are **no allowed-transition rules and no transition
guards.** (The grep hits for "transition" are all `agent-run` lifecycle + tooling, NOT work-item
status.) A work item can jump from any status to any status with no validation. "No hidden magic"
is the roadmap's phrasing; today there's no *machine* at all — just a label.

**What the roadmap wants:** explicit states (draft → ready → running → blocked → review →
completed → cancelled, "or whatever your states become") with **explicit, validated transitions.**

**The tension to resolve in brainstorming:** per-project-configurable statuses (a locked decision,
DECISIONS.md) must coexist with transition rules. So the state machine is likely *per-project
configurable transitions over configurable statuses*, not a hard-coded enum. That's the design
question, not a foreknown answer.

**Why it's the differentiator, not just a feature:** it's the thing that makes "humans and agents
collaborate through STATEFUL work items" literally true. An agent picking up a `ready` item,
moving it to `running`, then `review` — with the transitions being a contract the system enforces
— is the core collaboration primitive. Today that's convention; the state machine makes it
structural.

**Interactions to design against:** the event backbone (§2 — a transition should emit a typed
event), the agent runner (an agent run is bound to a work item's state), and the audit trail
(§3.2 — who/why moved the state).

**What's left:** essentially all of it — schema for allowed transitions, a transition-guard
convergence point, the configurable-transition UI, agent/runner integration, events on transition.

#### 3.1a — The artifact refinement (from the control-plane-OS evaluation — decide this FIRST in the chunk-1 brainstorm)

The §1 refinement reshapes what chunk 1 actually is. The state machine described above is framed
as state over **work-item status**. The control-plane-OS evaluation argues the primitive the user
cares about is the **artifact** (the evolving article / dossier / page), with the work-item as
*orchestration around it*. That changes the chunk-1 design question from "what's the status
state-machine?" to **"is the state machine over work-item STATUS, over ARTIFACT state, or both —
and how do they relate?"** This is the first thing to settle in the brainstorm, because it decides
the schema.

Two **absent primitives** (source-verified — see §1) belong on the chunk-1 table, because they are
what make this a *production* system rather than a status tracker — and they interact directly with
the state machine:
- **Agent re-entry** — today agents create new *sibling runs on a parent*; there is no "improve THIS
  artifact." A state machine over artifacts implies a run can TARGET a document and advance its
  state (draft → improved → review), not just append a comment. Decide whether re-entry is part of
  chunk 1 or the chunk immediately after — but don't design the state machine blind to it.
- **Derived-from lineage** — no `derived_from` link exists (one source → blog + newsletter + PDF is
  absent). This is arguably its own chunk, but the state machine's schema should not foreclose it
  (e.g. leave room for a document to reference a source artifact + the run that derived it).

**Do NOT silently expand chunk 1 to include re-entry + derivation** — that would be the
complexity-creep §3.4 warns against. The point is narrower: **bring these to the chunk-1 brainstorm
as explicit scope decisions** (in §5), so the state-machine schema is chosen knowing they're coming,
rather than being re-cut later. The likely outcome: chunk 1 = state machine (status and/or artifact
state) built to *not foreclose* re-entry/derivation; re-entry + derivation become their own
sequenced chunks (candidates to slot into §6 between the state machine and operator depth, pending
the brainstorm).

---

### 3.2 — Audit trail enrichment  🟠 PARTIAL — **second; smaller than it looks**

**Current reality (audited):** the `events` table (`db/schema.ts:471`) has `actor: text('actor')`
= "user_id or api_token_id" — but **no actor-TYPE** (human vs operator vs Claude vs external-MCP)
and **no "why"/reason** field. `pending_ops` captures `executedBy`/`executedAt` for the
irreversible-op confirm gate (audit T7), but there is no unified audit *view*. So the data to
answer "who did what, when" is mostly there; "*which kind of actor*" and "*why*" are not, and
there's no read surface that presents it as an audit log.

**What the roadmap wants:** for every action — who / what / when / **why** — and crucially
*whether* the actor was human / operator / Claude / Codex / external-MCP client. "Everything
leaves tracks." The roadmap calls audit "massively undervalued," and it's right.

**Why it's smaller than it sounds:** the event backbone already fires on every write through one
convergence point (`txWithEvents`). Enriching audit = adding two dimensions (actor-type, reason)
to a table that's *already on every write path*, then a read view — not building a new capture
mechanism. It's adjacent to the invariant-5 emit-label work already committed 2026-06-06.

**Interactions:** invariant 5 (the event IS the audit substrate — keep them one system, don't fork
a second audit table unless the read patterns demand it); the actor-type maps cleanly onto the
existing identity primitives (session user / agent token / operator / external MCP token).

**What's left:** actor-type derivation at emit time (from `AuthContext`), an optional reason field,
a unified audit read view/endpoint, and a decision on whether audit stays unified with `events` or
gets a purpose-built projection.

---

### 3.3 — Operator depth (Understand → Decide → Execute)  🟡 SUBSTRATE DONE — **third; the unique position**

**Current reality (audited):** the operator is a real multi-turn chat with a broad read+write tool
surface (§2). It is a control-plane *substrate*, not a dashboard. What it is NOT yet: a proactive
"what is happening / what should happen / do it" loop across projects, work items, agents, users.

**What the roadmap wants:** the operator as the genuinely-unique thing — Understand ("what is
happening?"), Decide ("what should happen?"), Execute ("do it") — across the whole instance. The
Multica comparison's sharpest point: most systems ship a *dashboard*; Folio is building a *control
plane*. "A dashboard observes. A control plane governs."

**Why it's third, not first:** the primitives exist; this is product depth on top of a working
substrate. The two gaps above (state machine, audit) are *foundation* the operator depth will
itself want to stand on (the operator reasons about work-item state and reads the audit trail).
Build the floor before the penthouse.

**What's left:** product/UX design on top of the existing tool surface — proactive surfacing,
decision support, cross-entity reasoning. Lower urgency, higher ceiling.

---

### 3.4 — The cross-cutting constraint: contain complexity, don't add to it (developer-side AND user-side)

This is not a feature — it's a *how* that applies to all three items above, and it's the real
long-term risk **all three** evaluations flag — from two directions. The quality review names the
**developer-side** cost (cognitive load to reason about the system safely); the control-plane-OS
evaluation names the **user-side** twin (the product feeling like a lifecycle system to operate
rather than a way to produce output fast). They are the same constraint seen from two ends.

**The quality review's central finding:** the codebase is at "platform-kernel complexity in
application code." Symptoms: many layered authorization rules, intersecting scope systems
(role ∩ token ∩ agent ∩ resource), multiple access models (workspace vs project vs instance),
dual paths (MCP / REST / internal runner / SSE). *"Close to understanding-threshold risk"* — new
contributors will struggle to build correct mental models fast.

**The residual security risk is therefore cognitive, not runtime:** *"developer misunderstanding
becomes a security bug."* Not exploits — incorrect usage of correct primitives. And some
invariants are still "documentation-first correctness" (discipline + routing conventions, not
compiler-enforced).

**What this means for the coming weeks (a design constraint, not a task):**
- The state machine (§3.1) must be built as ONE convergence point (a transition guard), the way
  auth already is — NOT scattered transition checks. Add it to `ARCHITECTURE-INVARIANTS.md` as a
  named invariant when built.
- Audit (§3.2) should stay *unified* with the event system where possible — adding a parallel
  audit path is exactly the dual-path complexity the review warns about.
- Where an invariant is currently "trust-based" (relies on don't-bypass-this-function), prefer
  making it *structural/mechanical* when touching that area — the `instance_skills.trusted`
  typed-column move (invariant 11) is the model: it made forging *physically impossible* rather
  than defended-against.
- **The bar for new work: does it lower the cognitive load of reasoning about the system, or
  raise it?** A feature that adds a fourth access model or a fifth execution path needs to justify
  the cognitive cost, not just the functional benefit.

**The user-side twin — "the control plane must stay invisible until needed" (control-plane-OS
evaluation §10).** The risk on the product side is *over-control-plane-ing*: too many states, too
many transitions, too much governance per artifact, friction in simple flows — until users feel
like they are *operating a system* instead of *producing output*. The default flow must feel like
**"AI produces good stuff fast,"** not **"I manage a lifecycle system."** This is a direct
acceptance criterion for chunk 1 (§3.1): the state machine must be *progressive* — invisible/zero-
friction for the simple "agent makes a thing, human approves it" path, and only surfacing states +
transitions + governance when the work genuinely needs them. A v1 default state set that forces
every artifact through draft → ready → running → blocked → review → completed would FAIL this test.
The state machine earns "stateful" (§1) only if statefulness is *available*, not *imposed*. Treat
"does the simple path stay frictionless?" as co-equal with "does the state machine work at all?"
when shaking out chunk 1.

§3.5 below is the source-grounded breakdown of the four specific structural-debt symptoms behind
this constraint — confirming each against the code and showing how three of the four collapse into
work already on this roadmap.

---

### 3.5 — Structural-debt assessment (the quality review's four "weak/risky" points, ground-truthed)

The codebase quality review (§4b) named four concrete structural-debt symptoms. Each was checked
against source on 2026-06-06. **All four are REAL — none is a surprise — but they are not equal:
two are active design targets already in motion, and three of the four collapse into work already
on this roadmap.** The value of the source check is that a reviewer working from architecture
*description* can name the *shape* of a risk but not see how far the mitigation already is.

| Point | Real? | Status |
|---|---|---|
| #1 Complexity density | ✅ Yes | **The meta-risk** — already the governing constraint (§3.4) |
| #2 Documentation-first invariants | ✅ Yes | **Actively closing** — a traceability checker just landed in-tree |
| #3 Event/state coupling | ✅ Yes | **Resolved by the state machine** (§3.1) — not separate work |
| #4 Agent "infra-visible" | ✅ Yes, smallest | **Two narrow carve-outs**, possibly irreducible |

**#1 — Complexity density → REAL; it IS the meta-risk (already §3.4).**
Every symptom is literally true in source: `role ∩ token ∩ agent ∩ resource` intersection (invariants
2/3/7), three access models (workspace/project/instance via `lib/access.ts`), four execution paths
(MCP / REST / runner / SSE). **But most of that density is intentional and load-bearing** — it's the
cost of being a control plane, not a CRUD app (the review itself says "closer to Kubernetes/Stripe/
Temporal"). The risk is not that the complexity *exists* but that it stops being *reasoned-about*. So
the mitigation is NOT "simplify the auth model" (that would weaken the 9/10 security) — it's the two
moves already in flight: (a) name the convergence points (DONE — `ARCHITECTURE-INVARIANTS.md`), and
(b) make them mechanically checkable (in progress — see #2). This is the lens §3.4 applies to every
other item.

**#2 — "Documentation-first correctness" → REAL, but actively closing; sharper than the review states.**
There is NEW tooling in the working tree: `scripts/check-invariants.ts` (225 lines) + a pre-commit
hook (`scripts/hooks/pre-commit-invariants.sh`), wired via `scripts/hooks/install.sh` and the
`check:invariants` package script. **But the precise truth is sharper than "not all invariants are
mechanically enforced":** that checker verifies **traceability, NOT enforcement.** Its own header
says so — it confirms each invariant's `Converges on` clause cites a real file/symbol (errors on a
dead citation, warns on line-drift), so the doc can't rot off its anchors. It does NOT verify the
code *obeys* the invariant. The enforcement ladder therefore has three rungs:

  1. **Structural** (bypass is *physically impossible*) — e.g. `instance_skills.trusted` as a typed
     column (invariant 11): a frontmatter write *cannot* reach the trust flag. The strongest rung.
  2. **Mechanical-traceability** (NEW) — `check-invariants.ts` pre-commit: the doc's citations can't
     silently drift off the code. Non-blocking by design (advisory drift shouldn't train `--no-verify`).
  3. **Discipline + review** — the `invariant-auditor` agent at `/shakeout` + `/code-review` must
     *find* a bypass; nothing *prevents* one.

The review's claim is TRUE: most invariants are still rung 3 (auditor-found, not prevented); only a
few are rung-1 structural. **The trajectory is exactly right** — the §3.4 prescription "promote
trust-based invariants to structural when you're in the relevant code" is the move that walks
invariants UP this ladder. The new checker added rung 2 beneath rung 3; the standing work is moving
more invariants to rung 1.

**#3 — Event/state coupling "transition-state architecture" → REAL; the state machine resolves it.**
True and already mapped. `txWithEvents` is universal on the *write* side (invariant 5), but the
*read/UI* side is mixed: SSE-teaches-refetch is the default (invariant 8) with TWO ratified exceptions
that build UI state directly from events (`useReactorHealth`, `useActivityFeed`). That mixedness is
the "not uniformly modeled" the review sees. **The deeper version: today the event stream records
*that* things changed, but state itself has no model** — work-item status is a bare label (§3.1).
What converges event + state into one uniformly-modeled system is **the work-item state machine**:
once a transition is an explicit, guarded, event-emitting operation, the event stream and the state
model stop being two loosely-coupled things. So #3 is not separate work — **it is the downstream
benefit of building §3.1.**

**#4 — Agent layer "infra-visible" → REAL but the smallest; two narrow carve-outs, possibly irreducible.**
For its actual *work*, the agent is ALREADY "just another scoped API consumer": the runner mints a
real scoped token (`token.scopes ∩ callerScopes`, `runner.ts` ~492–509), routes every tool through
the same `executeTool` gate as MCP/REST, and revokes the token in `finally`. No god-mode path. The
"infra-visible" surface is exactly **TWO** documented system-authority reads a normal client can't do
(both already in `ARCHITECTURE-INVARIANTS.md` Deliberate exceptions):
  1. `loadAgentDefinition` — reads the agent's own body + named skills to materialize its prompt.
  2. the AI-key decrypt in `loadContext` (`runner.ts` ~414–429) — reads+decrypts the BYOK secret for
     the provider call only.
Both are **module-private, not registered as tools, not routable** — a caller physically cannot invoke
them, and they're bounded (exact-slug match, throw-on-miss, no fallback). They are the *irreducible
minimum*: an executor must be able to load its own definition and the credential it runs under. So
"close to unifying, not fully there" is accurate — but the remaining gap may be **inherent**, not debt
to pay down. This is the smallest of the four and arguably not actionable.

**Net:** all four valid, none surprising. #1 is the lens; #3 is a *benefit* of §3.1, not separate;
#2 is mid-flight (the in-tree checker proves it); only #4 is standalone, and it's the smallest and
possibly irreducible. The brainstorm should weigh #1 as the governing constraint and treat #2's
ladder-climb as something to do opportunistically while building §3.1 and §3.2 — not as its own phase.

---

## 4. The three external evaluations — signal + reconciliation

### 4a. Multica architecture comparison (the first report)

Already captured in `2026-06-06-multica-architecture-study.md` and memory
(`project_multica-study`). Net: Multica is ahead on *current product maturity + agent runtime*;
Folio is ahead on *security model + extensibility + multi-agent future + platform architecture*,
because Folio is **work-item-first** where Multica is **agent-first**. Work-first survives every
shift in the AI landscape; agent-first needs redesign each time. The three things to steal from
Multica: **versioned reusable skills/playbooks** (Research Competitor / Write Proposal / Prepare
Release / Code Review), **agent visibility** ("Claude is working…" even if it's just an execution
engine), and **runtime abstraction** (treat Claude Code / Codex / Gemini as interchangeable
runtimes, don't tie to one).

### 4b. Codebase / security quality review (the second report — new, 2026-06-06)

**Scores:** Code quality 7.5/10 ("misleading — it's intentionally at system-kernel complexity"),
Security design **9/10**, Architecture maturity 8.5/10 and rising ("past early design, now in
stabilization-vs-complexity-containment phase").

**Confirmed strengths** (these match the prior audit, so they're trustworthy):
- Clean intentional domain boundaries (auth / access / runner / agent-tools / events / skills / db).
- Centralized control points (`executeTool`, `AuthContext`, `txWithEvents`, `access.ts`,
  `agent-projects.ts`) — *"distributed logic = security risk; most codebases fail here, you don't."*
- Strong anti-bypass thinking, structurally enforced (no alternate auth parsing, no duplicate
  permission eval, no ad-hoc event emission, no scattered scope logic).
- Capability-intersection authorization (token / role / agent / project / caller scopes, all
  intersected) — *"exactly how Stripe / AWS IAM / Kubernetes admission are designed."*
- Fail-closed everywhere (empty scope = deny, missing context/resource/project = deny).
- `txWithEvents` atomic mutation+event = real security property (prevents silent state divergence,
  event spoofing, missing audit).

**Named risks** (all reconcile with what we already know — none contradicts):
- The review's **four structural-debt symptoms** (complexity density; documentation-first invariants;
  event/state coupling; agent infra-visibility) are checked against source and reconciled in **§3.5**
  above — don't duplicate them here. Net of that section: all four real, #1 is the governing lens,
  #3 is a benefit of building §3.1, #2 is mid-flight (the in-tree invariant checker), and #4 is the
  smallest (two possibly-irreducible carve-outs).
- The one risk §3.5 does NOT cover: **MCP / external boundary evolving** (static tokens, no full OAuth
  lifecycle) → already recorded as the MCP-credential watch-item in `ARCHITECTURE-INVARIANTS.md` gaps
  + `tasks/retro-follow-ups.md`. Enforcement is fine (scopes route through `executeTool`); it's the
  credential *lifecycle* that's the watch-item.

**The one-sentence verdict, worth pinning:**
> *Folio is not at risk of being insecure — it is at risk of becoming too powerful for its own
> complexity to remain safely reasoned about. That is a good problem, but it is now the real one.*

### 4c. The roadmap's "do NOT build yet" list — confirmation, not new constraint

The roadmap says delay: **agent memory** (keep memory attached to work-items/projects/artifacts,
not agents), **multi-agent orchestration** (users want "get this done," not a Research/Planning/
Coding/QA agent fleet), and **complex planning engines** ("don't become LangGraph / CrewAI /
AutoGen — your advantage is simplicity"). All three align with decisions already locked in memory
(`FOLIO_AGENT_CHAINS_ENABLED` gated off; work-item-attached not agent-attached). So this list is
*confirmation* of existing direction, and it directly reinforces §3.4 (simplicity is the moat).

### 4d. Control-plane-OS evaluation (the third report — new, 2026-06-06)

Triggered by Stefan describing the product from the user's side: *agents produce content (research,
articles, leads); humans evaluate, steer, trigger more work; the system preserves state + lineage;
repeat until shippable (SEO pages, blog, newsletters, PDF dossiers, a build plan…)*. The evaluation
asked: "is this a control-plane-OS-type app, and are we heading the right way?"

**Verdict: direction RIGHT, position estimate WRONG.** The framing is the sharpest yet (folded into
§1): the core primitive is **Artifact + State + Lineage**; the system *governs how work evolves*
(generate → evaluate → steer → remember, looping until shippable) — "iterative artifact refinement
with governance." That's a more precise category than "work OS" and worth steering by.

**The one load-bearing error (source-verified 2026-06-06, the reason this isn't pure validation):**
the evaluation claims the foundations *already exist* — they largely do NOT. Of the five pillars:

| Pillar | Eval claims | Source reality |
|---|---|---|
| Human intervention (operator) | ✔ have it | ✅ EXISTS — the substrate is real |
| State | ✔ have it | ⚠️ only RUN-lifecycle state; ARTIFACT state is chunk 1, unbuilt |
| Lineage | ✔ strong (txWithEvents) | ⚠️ EVENT lineage yes; ARTIFACT lineage (`derived_from`) ABSENT |
| Agent re-entry ("improve THIS artifact") | ✔ "missing in most frameworks, you have it" | ❌ ABSENT — runs are new siblings on a parent |
| Derivation (one source → blog/newsletter/PDF) | ✔ implied natural | ❌ ABSENT — no transform/fan-out |

So three of five pillars are absent or partial. The evaluation's §9 ("not inventing missing
foundations, just connecting existing ones") is **the one wrong sentence** — building toward the
artifact model is an additive DATA-MODEL reshape (`derived_from` links, run-targets-a-document
re-entry, multi-output derivation), not a wiring job. The control FLOW (event-driven, transactional,
runner) is solid and stays. **Take the destination; reject "you already have it" — believing it is
how chunk 1 gets under-scoped.** (Like the quality review, this is an LLM's elegant systematization
of Stefan's own pitch: coherent ≠ built, coherent ≠ simple. North star, not a position report.)

**What it concretely changed:** NOT the §6 sequence. It sharpened chunk 1's inputs — see §3.1a (the
state machine is plausibly state-over-ARTIFACTS, and re-entry + derivation are explicit scope
decisions for the brainstorm) and §3.4 (the user-side "invisible until needed" acceptance criterion).

**Its one risk worth pinning (§10):** *over-control-plane-ing* — folded into §3.4 as the user-side
twin of the complexity constraint.

---

## 5. Open questions for the brainstorm (do NOT answer here)

These are the decisions to bring to the working session. Listed so nothing gets lost between now
and then.

**State machine (§3.1) — and the §3.1a artifact refinement (decide FIRST):**
- **State over WHAT?** Work-item STATUS, ARTIFACT state, or both — and how do they relate? (This is
  the §3.1a question that decides the schema; settle it before the rest.)
- How do configurable-per-project statuses coexist with transition rules? (configurable
  transitions over configurable statuses? a default transition graph projects can edit?)
- Where does the transition-guard convergence point live, and what's its bypass-is-a-bug rule
  (for the new invariant)?
- What states are the v1 default set, and are `blocked` / `cancelled` first-class or just statuses?
- How does an agent run bind to / drive a transition? (the collaboration primitive)
- What events does a transition emit, and how does the audit trail capture who/why?
- **Scope decision — agent re-entry (§3.1a):** is "an agent run TARGETS a document and advances its
  state (improve THIS article)" part of chunk 1, or the chunk right after? Design the state machine
  so it doesn't foreclose it either way.
- **Scope decision — derived-from lineage (§3.1a):** likely its own chunk, but does the
  state-machine / document schema leave room for a `derived_from` (source artifact + deriving run)
  link, so one source → blog/newsletter/PDF stays buildable later?
- **Acceptance criterion (§3.4 user-side):** does the SIMPLE path ("agent makes a thing, human
  approves it") stay zero-friction and invisible-by-default? A v1 that forces every artifact through
  the full state graph fails this. Statefulness must be *available*, not *imposed*.

**Audit (§3.2):**
- Does audit stay unified with `events`, or get a purpose-built read projection?
- How is actor-type derived (from `AuthContext` — human / operator / agent / external-MCP)?
- Is "why/reason" a free field, a structured enum, or derived from the triggering action?
- What's the read surface — an endpoint, a UI view, both?

**Operator depth (§3.3):**
- What does "Understand → Decide → Execute" look like as a concrete UX on the existing tool surface?
- How proactive should the operator be (surfacing vs waiting to be asked)?

**Steal-from-Multica (§4a) — sequencing:**
- Versioned skills/playbooks (Phase 2.7 Templates is parked + specced — does it move up?).
- Agent visibility ("Claude is working…") — how much, where?
- Runtime abstraction — is the Claude-Code-CLI coupling (memory: `claude-code-runner-cli-not-sdk`)
  the thing to generalize, and when?

**Cross-cutting (§3.4):**
- For each feature above: does it lower or raise the cognitive load of reasoning about the system?
- Which currently "documentation-first" invariants should be made structural while we're in the
  relevant code anyway?

---

## 6. Sequence & gates — what we do and when

This doc covers everything at once because strategy needs the whole picture — but **we do NOT build
it as one plan.** Forcing all of §3 into a single build plan is exactly the complexity-creep the
doc warns against (§3.4). Instead the work is a SEQUENCE of discrete, independently-shippable chunks,
each its own harness cycle (brainstorm → plan + gates → execute → shake-out → ship). You finish and
ship one before the next is even planned. Each chunk's design questions (§5) get answered when you
REACH it — not all upfront.

**This section is the sequencing layer between strategy (§1–§5) and tasks. It names the chunks,
their order, and their dependencies. It is NOT a task breakdown — those come per-chunk, at brainstorm
time.**

| # | Chunk | Depends on | Why this slot | Rough size |
|---|---|---|---|---|
| **0** | **Merge what's in flight** — the operator cockpit chat + the in-tree invariant checker (`scripts/check-invariants.ts`), off `spec/operator-cockpit-chat` | — | Clean base. New work can't start cleanly on a branch carrying two unrelated in-progress features. Each later chunk branches from a clean `main`. | small |
| **1** | **Work-item state machine** (§3.1) | clean `main` | The differentiator; earns the word "stateful." Everything downstream leans on it (audit records its transitions; the operator reasons about state). Build FIRST. Build as ONE convergence point (a transition guard) + a new named invariant. | large |
| **2** | **Audit-trail enrichment** (§3.2) — actor-type + why; unified with events | #1 (transitions are the richest thing to audit, and #3 needs it) | Smaller — the event backbone already fires on every write. Slots naturally once state transitions exist to record. Keep unified with `events`; do NOT fork a parallel audit path. | medium |
| **3** | **Operator depth** (§3.3) — Understand → Decide → Execute | #1 + #2 (it reads work-item state + the audit trail) | Product depth on a working substrate. The floor (state + audit) must exist before the operator can reason over it. The unique position, but it stands on #1/#2. | large |
| **—** | **Steal-from-Multica** (§4a) — versioned playbooks (Phase 2.7 parked), agent visibility, runtime abstraction | independent of #1–#3 | NOT on the critical path. Parallel / opportunistic — sequence one in when it's wanted (e.g. versioned playbooks if a customer demo needs them). Don't let them displace the #1→#3 spine. | varies |

**The gates between chunks (non-negotiable, per CLAUDE.md harness):**
- Each chunk is entered via `harnessed-development` — brainstorm its §5 questions, THEN plan.
- A chunk touching a security boundary (the state machine touches authorization-adjacent transition
  rules; audit touches actor identity) fires the **threat-modeling** gate at plan time.
- Each chunk that introduces a convergence point (#1's transition guard especially) adds a named
  invariant to `ARCHITECTURE-INVARIANTS.md` — and where feasible makes it *structural*, not
  trust-based (§3.5 rung 1, not rung 3).
- A chunk ships via `/shakeout` + `/finish-branch` before the next is planned. No overlapping
  half-built chunks (that's the §0/#0 lesson restated).

**What "continue building" means concretely:** do chunk 0 (merge), then START chunk 1 by brainstorming
its §5 state-machine questions — NOT by writing a combined task list for 1+2+3. The sequence is the
plan-of-plans; each chunk gets its real plan when reached.

---

## 7. Priority summary (the one-screen version)

1. **Work-item state machine** — the differentiator; earns "stateful." Build as ONE convergence
   point. *(❌ genuine gap)*
2. **Audit-trail enrichment** — actor-type + why; keep unified with events. Smaller than it looks.
   *(🟠 partial)*
3. **Operator depth** — Understand/Decide/Execute on the existing substrate. The unique position.
   *(🟡 substrate done)*

Throughout: **contain complexity** — the real risk is cognitive, not runtime. Every feature must
justify its cognitive cost. Delay agent memory, multi-agent orchestration, and planning engines
until users repeatedly ask.

*Steal from Multica when sequenced in: versioned playbooks, agent visibility, runtime abstraction.*

*Do NOT rebuild: unified auth, the event backbone, the operator substrate — they're done.*
