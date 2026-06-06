# Folio — Focus Roadmap (the coming weeks)

> **Status:** planning reference, NOT a plan yet. Authored 2026-06-06 to consolidate two external
> evaluations (Multica architecture comparison + a codebase/security quality review) with a
> ground-truth audit of the current codebase. Purpose: a single accurate document to brainstorm
> from later, so the right things — and only the right things — get built.
>
> **How to use this:** read §3 (the gap map) first — it's the part that decides where weeks go.
> §1 is the strategic thesis. §2 is what's already done (so we don't rebuild it). §4 is the two
> external reports' verbatim signal + how it reconciles. §5 is the open brainstorm questions to
> bring to the working session.
>
> Sibling docs: `2026-06-06-multica-architecture-study.md`, `2026-06-06-multica-agent-layer-gap-map.md`,
> `ARCHITECTURE-INVARIANTS.md` (the convergence-point contract), `tasks/retro-follow-ups.md`
> (the close-tracking for the two security gaps named below).

---

## 0. TL;DR

- **Folio's strength is confirmed twice over** (Multica comparison + quality review): the auth /
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
- **The real long-term risk is not insecurity — it is complexity.** The quality review's
  one-sentence verdict: *"Folio is not at risk of being insecure — it is at risk of becoming too
  powerful for its own complexity to remain safely reasoned about."* Both the state-machine work
  and the invariants work must be done in a way that REDUCES cognitive load, not adds to it.

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

### 3.4 — The cross-cutting constraint: contain complexity, don't add to it

This is not a feature — it's a *how* that applies to all three items above, and it's the real
long-term risk both evaluations flag.

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

---

## 4. The two external evaluations — signal + reconciliation

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
1. **Complexity density** = the main issue → addressed as the §3.4 constraint above.
2. **"Documentation-first correctness"** — not all invariants mechanically enforced; some rely on
   discipline → this is *why `ARCHITECTURE-INVARIANTS.md` + `/code-review` + `/shakeout` exist*;
   the prescription is to keep converting trust-based invariants to structural ones (§3.4).
3. **Event/state coupling still evolving** — some flows event-driven, some request-driven, some
   hybrid; a "transition-state architecture" → the state machine (§3.1) + keeping audit unified
   (§3.2) are the moves that converge this.
4. **Agent layer still "infra-visible"** — agents are partially special execution contexts, not
   fully indistinguishable from API clients → this is the "make agents boring" direction both the
   roadmap and the Multica comparison push; it's a known target, not a surprise.
5. **MCP / external boundary evolving** (static tokens, no full OAuth lifecycle) → already recorded
   as the MCP-credential watch-item in `ARCHITECTURE-INVARIANTS.md` gaps + `tasks/retro-follow-ups.md`.

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

---

## 5. Open questions for the brainstorm (do NOT answer here)

These are the decisions to bring to the working session. Listed so nothing gets lost between now
and then.

**State machine (§3.1):**
- How do configurable-per-project statuses coexist with transition rules? (configurable
  transitions over configurable statuses? a default transition graph projects can edit?)
- Where does the transition-guard convergence point live, and what's its bypass-is-a-bug rule
  (for the new invariant)?
- What states are the v1 default set, and are `blocked` / `cancelled` first-class or just statuses?
- How does an agent run bind to / drive a work-item transition? (the collaboration primitive)
- What events does a transition emit, and how does the audit trail capture who/why?

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

## 6. Priority summary (the one-screen version)

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
