# Handoff — Instance AI Config (done, awaiting smoke) → Cockpit Chat (next)

**Date:** 2026-06-04
**Current branch:** `spec/instance-ai-config` (21 commits ahead of `main`, UNPUSHED, NOT merged)
**Next work:** Operator Cockpit Chat (spec done, build-gate now satisfiable — see §3)

---

## TL;DR for the next session

Two things, in order:

1. **Finish + merge `spec/instance-ai-config`.** The code is BUILT, shaken-out, and 5-reviewer-passed (0 blockers). The ONLY thing left is a **manual smoke run** on a live server (you, not the agent) + the merge. See §1 for the exact checklist.
2. **Then start the Cockpit Chat.** Its hard build-precondition (the agent-authority branch merged) is already satisfied, AND merging instance-AI-config first keeps the operator's AI-key model current. Spec is written + reviewed; next step is `writing-plans`. See §3.

---

## 1. Instance AI config — what's done, what's left

**Branch `spec/instance-ai-config`, commits `c778d47`→`ef8f3fb` (21 ahead of `main`).**

Built via the full harness (`harnessed-development` → Class-B `executing-plans`): 11 tasks T1–T11, then `/shakeout` (1 CRITICAL + 4 lesser fixed), then a 5-reviewer pass (0 BLOCKERS, all M1–M8 hold, 0 invariant bypasses), then 4 reviewer SHOULD-FIX findings addressed.

**Fresh-verified gates at handoff:** server **1402**/1-skip/0 · web **764**/8-skip/0 · shared **63**/0 · tsc clean ×3.

### What landed (durable facts — but VERIFY against source before relying; code moves)
- `ai_keys.workspace_id` DROPPED (migration **0023**, table-rebuild + a fail-loud CHECK-constraint guard). Unique `(provider, label)`.
- The runner (`loadContext`) resolves the AI key by `(provider, ai_key_label)` with **no workspace predicate** — the **"B6 reversal"**. System-auth read, secret injected into the provider call ONLY (never a token/tool/response/run-message/frontmatter). Old B6 tests were INVERTED, not deleted.
- `ai_key_label` frontmatter field (default `'default'`) on agent + run schemas, snapshotted at createRun.
- AI-key CRUD route = **`/api/v1/instance/ai-keys`** (`routes/instance-ai-keys.ts`), session-only + `requireInstanceAdmin`, mounted on `v1` so no agent token can reach it. Per-workspace `routes/settings.ts` (AI-keys only) DELETED.
- `/auth/me` gained **`is_instance_admin`** (via non-throwing `getSystemRole`, the single `__system`-role read) + **`ai_configured`** (presence-only; ANY member can read — drives the body-editor AI slash commands).
- Web: instance AI tab moved to a NEW top-level **`/settings`** route (instance settings home); workspace `/w/:wslug/settings` keeps only Tokens. "Instance settings" in the UserMenu.
- **NO `ai_usage` table** — the `agent_run` doc IS the meter (its `tokens_in/out` written on every path incl. error/resume). Reviewers showed a separate table both duplicated run-row data AND only metered the success path; dropped at /shakeout.
- `ARCHITECTURE-INVARIANTS.md` gained a deliberate-exception entry for the runner's instance AI-key system-read (replaces the implicit B6 rule).

### THE ONE GATE LEFT (yours): smoke checklist on a live server
Needs a running server + a key (an agent can't do this). Run from a clean checkout of the branch with the dev server up:
```markdown
- [ ] Instance settings → AI (as a __system admin): add an Ollama provider key (localhost).
      Appears in the list; no secret shown. (Needs FOLIO_ALLOW_LOOPBACK_AI=true for localhost.)
- [ ] Instance settings → AI (as a plain member): the AI tab is NOT visible.
- [ ] Assign the operator to ollama + a model via its frontmatter; run it cross-workspace
      → it executes (the Ollama e2e).
- [ ] Add a PAID key (e.g. anthropic) → server log shows the denial-of-wallet residual warning.
- [ ] Body editor: AI slash commands (/ai, /draft) appear when a key exists (any member).
- [ ] DevTools console: no red errors on the instance AI settings page.
```
Diagnostic scripts repointed to the instance route if you'd rather drive it by script:
`apps/server/scripts/{seed-ollama-key,diagnose-http-chain,shakeout-cross-ws-operator,shakeout-cross-ws-triggers}.ts`.

### Then merge
This branch sits ON TOP of the merged agent-authority work (commit `2bc3334` is an ancestor of HEAD), so merging to local `main` is clean. `main` is LOCAL-ONLY/unpushed — match the prior `--no-ff` convention if you keep it.

### Pointers
- Plan: `docs/superpowers/plans/2026-06-03-instance-ai-config-in-system.md`
- Spec: `docs/superpowers/specs/2026-06-03-instance-ai-config-in-system-design.md`
- Shake-out manifest (all resolved): `tasks/shake-out-manifest.md`
- STATE.md top entry has the full record.

### Plan defects corrected in-flight (so a re-read of the plan doesn't mislead)
- The plan's fail-loud guard `SELECT RAISE(ABORT, …)` is **invalid SQLite** (RAISE only works inside a trigger). Replaced with a temp-table `CHECK(row_count=0)` guard.
- The plan's route path `/api/v1/system/ai-keys` was WRONG — corrected to `/api/v1/instance/ai-keys` (the `instance-tokens` convention; there is no `/system` mount).
- The plan's `ai_usage` table was DROPPED at /shakeout (reviewer-driven; the run doc is the meter). The locked plan decision for a metered `ai_usage` table is REVERSED — Stefan approved.
- A `bun:sqlite` gotcha surfaced: `sqlite.exec(wholeFile)` silently no-ops a migration guard (it mishandles `--> statement-breakpoint` markers) → false-passing test. Split on the breakpoint like `migrate()` does. (Captured as a memory marker.)

---

## 2. Working-tree / branch hygiene before you start

- `git status` should be CLEAN on `spec/instance-ai-config` (everything committed at handoff).
- **Auto-memory hook risk:** the session hook has moved HEAD back to `main` mid-work before. `git branch --show-current` before EVERY commit; `git checkout spec/instance-ai-config` if it drifted.
- There is one stray `memory(folio)` auto-commit in the branch history — harmless, the real work is intact.

---

## 3. NEXT: Operator Cockpit Chat (the UI chat plan)

**The cockpit becomes a multi-turn CHAT with the operator** — replaces the Activity/Run tabs. Open by default; close = human-only mode (Folio works normally without agents). You talk to the operator; it does everything (create workspaces, set up projects from `__system` reference templates, work tables/items, build views, fire other agents) through conversation, with interactive UI components (link panels, choice cards), not just prose.

### Build-gate status: NOW SATISFIABLE
The spec's hard precondition is "**`spec/agent-authority-and-skills` merged**" (it needs Piece A instance-reach tokens + Piece B `__system` skill resolution). **That branch IS merged into local `main`** (merge commit `2bc3334`, 2026-06-03). So once you merge instance-AI-config (§1), the substrate is complete and the gate is open. Merge instance-AI-config FIRST so the operator's AI-key/model model the chat inherits is the current instance one.

### Where it lives
- Spec (approved, gaps/risks-reviewed, build-precondition section first): `docs/superpowers/specs/2026-06-03-operator-cockpit-chat-design.md`
- Memory marker with the locked design points: `project_cockpit-chat-spec` (in auto-memory).
- An earlier cockpit-panel design: `docs/superpowers/specs/2026-05-31-agent-cockpit-panel-design.md` (the shell this mounts into).

### Locked design (so you don't re-derive — read the spec for the full why)
- **ONE flow, not parallel flows** (first-class constraint): reuse `runner.ts` core loop (25-round tool-use), EXTEND `handleResumeRun` for cross-turn resume, GENERALIZE the `postAgentComment` typed-output sink to write `messages` rows, reuse the SSE stream + `useEventStream`, mount in the existing `AgentCockpitPanel` shell. **Net-new = 2 tables (`conversations`/`messages`) + 1 `ui` tool + 2 thin thread↔messages adapters + render components + conversation routes + authored `__system` content.** Any task that rebuilds the runner/stream/tool layer is a red flag.
- **Storage:** dedicated `conversations`/`messages` tables, walled off like `agent_run` (no event-flood, no trigger firing). Markdown is an ON-DEMAND projection (`GET …/:id.md`) — an accepted relational-as-truth exception.
- **Authority (CRITICAL):** the chat is a TRIGGER SURFACE that INHERITS the floor. Each turn threads the conversation's `created_by` as the caller; `effective = operator ∩ caller`, resolved PER TURN (never ambient/shared). The shared instance-reach operator token = identity/capability; the caller = authority. Cross-user isolation depends on per-turn caller resolution.
- **Components:** a server-defined `ui` tool, closed Zod-validated set: `link_panel` (click navigates, cockpit stays open) + `choice_card` (click sends the validated option **ID**, not the label, as the next turn). Operator capability/voice = authored `__system` content (skill + reference files + `agent.md` + `soul.md`), NOT code.
- **Irreversible-op gate = HARD, at the tool boundary (`executeTool`), NOT a prompt rule.** Fail-closed by the EXISTING HIGH-tier risk classifier (no allowlist). Execution binds to a server-recorded `pending_ops` row (op+params+target, single-use, caller-bound) — confirm executes the RECORDED action, not the operator's turn-2 re-read (injection- + drift-proof). Scoped to conversation context only; headless HIGH runs (triggers/MCP) keep existing treatment (no regression). This absorbed a 3-round review — do NOT soften it back into a behavioral rule.

### Out of scope → separate specs
Multi-thread list (table is modeled for it; single-thread v1) · component types beyond the two · **file generation (PDF/HTML/Excel)** (its own spec+plan; operator gets an export tool when it lands) · claude-code stays hard-disabled.

### When you start it
1. Merge instance-AI-config first (§1).
2. Re-read the spec — then **`writing-plans`** (the spec is design-approved, not yet a task plan).
3. **Plan-time gates are REQUIRED:** `threat-modeling` (auth/multi-tenant/untrusted-content surface) + `architecture-invariants` (it routes through the runner loop, typed-output sink, SSE, tool registry, `handleResumeRun`, authority floor, BYOK resolution — name them).
4. Two pre-build VERIFY gates the spec calls out against the merged substrate: **#3** operation-axis role bounding (a read-only caller's operator can't write) + **#4** untrusted-envelope on content the operator READS.
5. Use `harnessed-development` as the front door (it sequences all the above).

---

## Quick reference

| | Instance AI config | Cockpit Chat |
|---|---|---|
| State | BUILT + shaken-out, NOT merged | Spec approved, NOT planned |
| Branch | `spec/instance-ai-config` | (none yet — branch off post-merge `main`) |
| Gate | your smoke run + merge | merge instance-AI-config, then `writing-plans` |
| Next action | run the §1 checklist | read the spec → `writing-plans` |
