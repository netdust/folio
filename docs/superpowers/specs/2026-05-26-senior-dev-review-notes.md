---
title: Senior dev review — pick up after 2.6 / 2.7 / 3
date: 2026-05-26
status: parked
applies_to: [phase-2.7, phase-3, phase-4]
---

# Senior Dev Review Notes

Pasted-in review from an experienced engineer evaluating the current Folio roadmap (Phase 2.5 → 2.6 → 2.7 → 3 → 4). Each item below is a risk + correction to fold into the relevant phase plan. Do **not** apply now — pick this up when Phase 2.6 is shipped and we're scoping 2.7 / 3.

The verdict: the system is "Built to Evolve" because SQLite is the source of truth and agents are first-class documents. The risks below are about keeping the API stable while the AI layer is unreliable.

---

## 1. LLM latency bottleneck → Async worker (Phase 3 / 4)

**Risk.** Current design triggers `runAgent` synchronously on assignment. LLMs take 3–30s. Webhooks (Power Automate, n8n, etc.) are impatient. If inbound email hits the API and blocks on the anonymizer agent before returning 200 OK, Hono's event loop saturates. A 10s Anthropic hiccup makes the entire API "feel" down.

**Correction.** Move `runAgent` to a **background job**. Inbound webhook flow:

1. API saves the "Inbound" document.
2. API returns **202 Accepted** to the webhook caller.
3. Async worker picks up the agent run from a queue (SQLite `agent_run_queue` table polled on an interval is fine — no Redis, per architectural rules).
4. Worker writes results back via the same `events` channel agents already subscribe to.

**Where it lands.** Phase 3 (agent runner) must ship the worker before any synchronous run path is exposed to webhooks. Phase 2.6 webhook intake can ship synchronously if it doesn't trigger an agent — but the moment Phase 3 wires agents to inbound webhooks, the worker is a prerequisite.

---

## 2. Prompt versioning / template drift (Phase 2.7)

**Risk.** Templates have "pinned versions" (good), but what happens when a template update requires a new frontmatter field that doesn't exist in the workspace agent yet? The "Diff-then-Confirm" UI as currently specced just shows code diffs.

**Correction.** Make Diff-then-Confirm a **migration engine**, not a diff viewer. When syncing a template:

- Detect missing frontmatter fields and offer to **backfill** them with sane defaults (or prompt the admin per-field).
- Detect renamed/removed fields and warn before stripping.
- Detect type changes (e.g. `model: string` → `model: { provider, name }`) and offer a transform.

Without this, updating a "Callcenter Pack" across 10 workspaces produces 10 slightly broken agents.

**Where it lands.** Phase 2.7 template design doc. The plan currently treats templates as code-only; expand the "sync" section to cover metadata migration.

---

## 3. Agent loop / runaway guard (Phase 3)

**Risk.** Phase 3 introduces agent-to-agent mentions. The "Vegas scenario": Agent A responds to a comment → triggers Agent B → asks a clarifying question → Agent A responds → infinite loop. You wake up to a $500 Anthropic bill and 50,000 comments generated in 2 hours.

**Correction.** **Hard recursion limits enforced at the runner level.**

- Every `agent_run` carries a `parent_run_id` and `depth` integer.
- If `depth > 5` (configurable per-instance), runner throws a **Circuit Breaker** error and **disables the trigger** until a human re-enables it.
- Circuit-breaker events are surfaced in the UI as a banner on the agent doc.
- Also: per-agent rolling spend cap (e.g. $X / hour) that trips the same circuit breaker.

**Where it lands.** Phase 3 agent runner design. Must be in the `agent_runs` schema from day one — adding `depth` / `parent_run_id` later is a painful migration.

---

## 4. Anonymizer security vs. utility paradox (Phase 3 — Callcenter flow)

**Risk.** Callcenter flow strips PII before the reply-drafter sees the message. If the anonymizer is too aggressive, it strips the Order ID or Tracking Number the drafter needs to actually help the customer. If it's too lenient, PII leaks to the LLM.

**Correction.** Two complementary mechanisms:

1. **Protected fields / allow-list regex** in the anonymizer's prompt + post-processing. Order IDs (e.g. `#\d{4,}`), tracking numbers (carrier-specific patterns), invoice numbers — these survive anonymization.
2. **Debug Mode for the Instance Admin.** A secure, audit-logged view of the pre-anonymized payload alongside the anonymized version. Without this, debugging "why did the agent hallucinate the wrong order number" is impossible because by the time you see the run, the original is gone.

**Where it lands.** Callcenter spec (`2026-05-26-callcenter-flow-design.md`) — currently parked. When unparked (Phase 3 / 3.5 / 4), add an "Anonymizer Safety" section covering both points.

---

## 5. Summary verdict (his words, kept for context)

> I see a system that is "Built to Evolve." By using SQLite as a robust state store and treating Agents as first-class Documents, you've avoided the "Spaghetti Code" trap that kills most AI startups. The "Spine" (Phases 2.6 → 3 → 4) is solid.
>
> Senior dev advice: focus Phase 3 heavily on the Async Worker and Circuit Breaker patterns. Don't let the "AI Magic" compromise the "API Stability." If the database is the source of truth, make sure the AI is just an external visitor that can be "kicked out" if it starts behaving badly.

---

## Pick-up checklist

When unparking after Phase 2.6:

- [ ] Phase 2.7 plan: expand template sync into migration engine (item 2).
- [ ] Phase 3 plan: lock in async worker before synchronous webhook→agent path (item 1).
- [ ] Phase 3 schema: include `parent_run_id`, `depth`, circuit breaker state on `agent_runs` from v1 (item 3).
- [ ] Callcenter spec: add Anonymizer Safety section before implementation starts (item 4).
