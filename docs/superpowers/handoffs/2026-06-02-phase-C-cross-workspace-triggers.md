# Phase C — Cross-Workspace Triggers — Execution Handoff

_Written 2026-06-02. Phase C lets a trigger in workspace B fire a `__system` library agent UNATTENDED. **Phases A AND B must be built + merged before this runs.** Phase D (library curation UI) is the last plan — UI-only, write it after C._

---

## 🎯 READ FIRST

- **The plan to execute:** `docs/superpowers/plans/2026-06-02-phase-C-cross-workspace-triggers.md` — 6 tasks (1, 2, 3, 3.5, 4, 5), threat model **C1–C6** inline, four pre-dispatch review fixes baked in.
- **⚠️ AUDIT CORRECTION (PC-2, 2026-06-02 — read `docs/superpowers/retros/2026-06-02-orchestration-layer-audit.md`):** Task 3.5's original file list was INCOMPLETE and would 500 every fired run. The corrected Task 3.5 now (a) adds `unattended` to the `.strict()` `agentRunFrontmatterSchema` FIRST (else `createRun`'s parse throws), (b) threads `unattended` through `ToolContext` + `executeTool` + `runner.ts` (the `folio_api` handler can't see run frontmatter otherwise — this touches the central executeTool gate, flag for `/code-review`), and (c) derives the discriminator from `triggerId !== null && !resumeOf` (NOT `firedBy`, which is a free-form string). Build Task 3.5 from the corrected plan, not the original framing.
- **PREREQUISITES:** Phase A (`__system` library) AND Phase B (cross-workspace execution) MUST be merged. Phase C reuses Phase A's `getSystemWorkspaceId`, Phase B's `createRun` `agent_home_workspace_id` stamping + caller-sole `loadContext` + the `folio_api` HIGH/MEDIUM floor, and extends the resolution predicate to the trigger-matcher.
- **The governing spec (the why):** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 3c — the trigger-matcher binding point; Phase C).
- **Auto-memory to load:** `project_operator-is-an-agent-not-a-seeded-bot` (read first), `feedback_state-consequences-and-dont-flatter`, `project_folio-api-inprocess-no-token-mint`, `feedback_holistic-review-catches-cross-task-bugs`, `feedback_verify-subagent-claims-not-just-counts`.

---

## The one-paragraph model (don't re-derive)

A trigger in workspace B can fire a `__system` library agent (e.g. "on new lead → run the SEO agent"). The matcher resolves the target agent BY ITS IMMUTABLE `target_agent_id` (which carries the home workspace), asserts `home ∈ {B, __system}`, and calls `createRun` (which Phase B already stamps `agent_home` correctly). The fired run's CALLER is the human who caused the event (`resolveOwnerUser(event.actor)`); authority = that human's reach in B (Phase B caller-sole). The NEW risk vs Phase B: the run is EVENT-FIRED, not human-invoked — an UNATTENDED injection→mutation chain is possible (malicious B content both causes the event AND is the injection). The bound is DETERMINISTIC: MEDIUM+HIGH are FLOORED on the unattended fired path (config writes refuse), caller ceiling holds; LOW is bounded by caller + a best-effort fence (accepted residual).

---

## What Phase C builds (6 tasks)

- **T1** — `resolveTriggerAgent(db, eventWorkspaceId, payload)` returns the agent DOC resolved by immutable `target_agent_id` (home-predicate `{B, __system}`, NO slug-shadow); slug is the fallback only. Replaces the by-slug resolution at all matcher sites (C1).
- **T2** — skip the project allow-list fire-gate for library agents (their `__system` projects aren't a B-fire-gate); the RUN stays caller-bounded (C2).
- **T3** — forbid library targets for caller-less (scheduled/actor-less) triggers (C6); library→library suppression test + corrected autonomy-gate ordering comment (C4); event-human caller pin (C5).
- **T3.5** — FLOOR MEDIUM on the unattended path: `createRun` stamps `frontmatter.unattended`; `folio_api` refuses MEDIUM (like HIGH) when `unattended` (C3 — the deterministic bound).
- **T4** — surface library agents in the trigger-target picker (reuse Phase B Task 7's union endpoint).
- **T5** — integration gate + the **deterministic-bound verification** (MEDIUM floor fires on a fired run — MANDATORY) + the **LOW-injection smoke test** (a signal, not a proof).

---

## Fixes baked in (do NOT re-discover — in the committed plan `d4f287a`)

Stefan's pre-dispatch review caught 4; all corrected:

1. **C3 is a DETERMINISTIC bound, not "proven by one shake-out payload."** Task 3.5 floors MEDIUM on the unattended fired path (config writes refuse like HIGH; humans keep MEDIUM via direct invocation, Phase B). The B10 fence is best-effort for LOW only; T5's injection case is a SMOKE TEST, and unattended LOW is the named accepted residual. Don't call a green payload "proof."
2. **Resolve by immutable `target_agent_id`, NOT id→slug→local-first.** The old `resolveTargetAgentSlug` converts id→slug, then downstream re-resolves by slug with local-first precedence — letting a LATER same-slug local agent silently shadow a trigger wired by id to a library agent. T1's `resolveTriggerAgent` resolves by id directly (the id carries the home).
3. **The autonomy-gate ordering claim was WRONG.** Real order in `maybeCreateRun`: resolve(418)→allow-list(434)→gate(442). The gate runs AFTER resolution and SUPPRESSES post-resolution — it is NOT a pre-resolution filter. T3 corrects the comment + adds a library→library suppression test.
4. **Caller-less (scheduled) triggers FORBID library targets** (C6). The trigger schema has a `schedule` field; a scheduled trigger has no event-human, so `resolveOwnerUser` returns null → no caller to bound the run. T3 forbids firing a library agent caller-less rather than inventing a system actor ("authority = caller, sole" requires a caller).

---

## Ground-truth verified this session (build to this, not assumptions)

- The matcher has agent-resolution at multiple sites: `resolveTargetAgentSlug` (~`trigger-matcher.ts:220`, which prefers `target_agent_id` but converts to slug — the C1 bug), and by-slug resolution in `handleInternalAction` (~230), `handleResumeRun` (~321), `maybeCreateRun` (~420). **Re-grep at HEAD — they shift.**
- `maybeCreateRun` order: resolve agent (418-425) → `resolveAgentProjects` allow-list fire-gate (434) → autonomy gate `isAgentOriginated && !FOLIO_AGENT_CHAINS_ENABLED` (442). The gate suppresses post-resolution (C4).
- `resolveOwnerUser(event.actor)` (~`trigger-matcher.ts:170`) resolves the event-human (or the human behind a PAT); returns null for an actor-less/agent event — the C6 hook.
- `createRun` (`services/agent-runs.ts`) already takes `{agent, actor, firedBy, ...}` and (Phase B) stamps `agent_home_workspace_id` from the resolved agent. The matcher calls it with a `firedBy` (e.g. the trigger) — that discriminator is the basis for the `unattended` stamp (T3.5). Confirm the exact discriminator at HEAD.
- The trigger schema has a `schedule` field (`builtin-triggers.ts:39`, set null for builtins) — scheduled triggers are a real/latent type (C6).
- Phase B Task 7 (if built) extended the agents-list endpoint to union `__system` agents — T4 reuses it, doesn't duplicate.

---

## How to execute

1. **Load `ntdst-execute-with-tests`** (CLAUDE.md rule #1). Subagent-driven, tasks 1→2→3→3.5→4→5 in order (they build a shared surface in `trigger-matcher.ts` + touch `createRun`/`folio_api` — don't parallelize). Two-stage review per task; the threat model (C1–C6) is the `/code-review` convergence target.
2. **Per task:** ground-truth the dependency surface (Step 2.5 gate) before each dispatch — the matcher sites, `resolveTargetAgentSlug`, the autonomy-gate ordering, the `unattended` discriminator, the trigger-target UI all shift; read live. Append the netdust addendum verbatim.
3. **T1 (resolve-by-id) + T3.5 (the MEDIUM floor) are the load-bearing changes.** T1's shadow test (a trigger wired by id to a library agent NOT shadowed by a later same-slug local agent) and T3.5's floor test (an unattended MEDIUM config write refuses; a human one applies) are the proofs.
4. **T5 verification is DETERMINISTIC, not a fuzzy injection pass.** Step 3 (the MEDIUM floor fires on a real fired run) is the mandatory gate; Step 3b (the LOW-injection smoke test) is a signal — a fence FAIL is a strong signal to weigh tightening, a PASS is not "proof."
5. **After T5:** `/code-review high` (C1–C6 + confirm Phase A/B/Phase-1/folio_api not weakened), `/integration`, `/shakeout` (real trigger-fired run + the deterministic-bound checks + the smoke test + the `invariant-auditor`), then **merge the full A→C cross-workspace operator to main** + `/evaluate` the A→C arc.

## Gates / commands (verified this session)

- Server: `cd apps/server && bun test` (from INSIDE apps/server). Shared: `cd packages/shared && bun test`. Web: `cd apps/web && npx vitest run` (NOT bun test). tsc per-app.
- A real-key shake-out needs an Anthropic key on a dev instance (the operator is `provider: anthropic`). Drive the fired path via the composed loop (dispatcher + matcher + poller + runner).
- ⚠️ Re-verify the branch after each subagent task (`git rev-parse --abbrev-ref HEAD`) — the auto-memory hook has moved HEAD to main before.
- Branch: `phase-op-3/the-agent` (or the integration branch the A+B builds merged into — confirm where A+B landed). Main is LOCAL-ONLY. Phases A+B+C merge to main TOGETHER as the coherent operator (after C).
- **Phase C adds NO `.sql` migration** (`unattended` is a JSON frontmatter field, `__system` is from A). If you reach for a migration, STOP and re-read.

## Pointers

- Plan: `docs/superpowers/plans/2026-06-02-phase-C-cross-workspace-triggers.md`
- Spec: `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 3c)
- Phase A/B plans + handoffs: `docs/superpowers/{plans,handoffs}/2026-06-02-phase-{A,B}-*.md`
- Kept tool surface: `apps/server/src/lib/folio-api-tool.ts` (T3.5 adds the unattended-MEDIUM floor here)
- Carried follow-ups (`tasks/retro-follow-ups.md`): OP3-F1 (medium-tier dryRun default), OP-LIB-1 (library-agent visibility flag). The fired-path LOW residual is documented in the C threat model (out-of-scope deferrals) — don't re-surface it as a finding.
- **Next after C: Phase D** (library curation UI — the Settings → System Library surface; UI-only, no execution-model change). Write its plan when you reach it.
