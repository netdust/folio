# Multica → Folio: Architecture Study (Hardening + Agent-Model Pressure-Test)

**Date:** 2026-06-06
**Subject repo:** [multica-ai/multica](https://github.com/multica-ai/multica) (Go + Postgres/pgvector + Next.js 16; mature, shipped, self-hostable agent platform)
**Goal:** harden Folio's security/architecture and pressure-test Folio's agent model against a mature peer.
**Method:** multi-agent workflow — 5 paired Multica subsystem readers → adversarial per-finding verification against *actual* Folio source → synthesis. Two synthesis passes (the second after backfilling rate-limited verifications) converged on the same verdict. Load-bearing claims were additionally spot-checked by hand (see Verification status).

---

## Verification status (read this first)

The study ran under sustained API rate-limiting. Of the per-finding verifications, a portion (~21–27 across runs) failed with rate-limit errors and were dropped. **This affects the §6 "already-handled" confidence items and some §4 validation points, NOT the three actionable deltas in §3.** The three deltas, and the one with a live-credential consequence (3.1), were verified by direct source reading:

- **3.1 premise confirmed by hand:** `runner.ts:1601` writes `outcome.transcript` to the run body and `:1636` posts `finalText` as a `kind=result` comment — raw. Folio scrubs *error messages* (`sanitizeProviderError`) but there is **no scrub of the model's free-form output**. `ccToken` is minted live at `runner.ts:1528` and revoked only in the `finally` at `:1614` — so a mid-run echo exposes a *usable* credential.
- The authority convergence cites (`agent-tools.ts:329`, `runner.ts:513`) were confirmed by the second synthesis agent against source.

Treat §3 as actionable. Treat §6 as high-confidence-but-not-exhaustively-re-verified.

---

## 1. TL;DR

Multica is a **mature, multi-tenant, daemon-on-the-user's-machine** agent platform: a central Go server is the sole authority; untrusted-but-authenticated local daemons poll for claimed tasks, spawn one of 12 agent CLIs, and stream `stream-json` back live. Its maturity went into the things a long-running, multi-workspace, daemon-fleet design *forces* you to solve — idle watchdogs, preemptive subprocess kill, per-task minted tokens, atomic claim-and-clear scheduling, and a single output-redaction chokepoint.

**Folio is in genuinely good shape.** Of ~25 hypotheses, only **three real deltas** survived verification — all low/medium, all bounded by Folio's single-team, caller-scoped, turn-based model. On the load-bearing security properties Folio came out **equal-or-stronger** than the mature peer: caller-bounded authority, fail-closed secrets-at-rest, forge-proof skill trust, anti-enumeration 404s, atomic-claim scheduling. Most flagged "gaps" turned out to be **dead code** (the hard-disabled `claude-code` CLI path) or **structurally-absent risk classes**.

- **Single biggest thing to steal (security):** a standalone, content-based **output-secret redactor** (Multica's `pkg/redact`) at the one seam where model output is persisted/broadcast. → delta **3.1**.
- **Single biggest thing to steal (product):** the **dispatch-time admission discipline** for triggers — skip-vs-fail classification, per-trigger overlap policy, payload-as-fenced-data. → §5.
- **Agent-model verdict:** the study **validates Folio's direction on every contested axis** and shows Folio is *ahead* of where a mature competitor landed on authority and skill-trust. The work ahead is operational maturity, not redesign.

---

## 2. Subsystem-by-subsystem: Multica vs Folio

**Execution-runtime.** Multica: streaming daemon, no wall-clock cap but a per-task idle watchdog (separate budget for in-flight tools), ~5s preemptive subprocess SIGKILL on cancel, fail-closed completion criteria, slot semaphore acquired *before* claiming. Folio: in-process in one Bun/Hono binary — a well-bounded API-provider agentic loop (`MAX_TOOL_ROUNDS`, token budget, hourly rate limits, delegation-depth cap) plus a **hard-disabled** `Bun.spawn claude` CLI path. Genuine differences: liveness (Folio cancel is cooperative, checked at tool boundaries, not preemptive) and fan-out backpressure (`FOLIO_POLLER_CONCURRENCY`, enqueue-only `planning` rows — already a global ceiling).

**Authority-sandbox.** Multica's `mat_` task token narrows *only* the workspace and is otherwise **owner-equivalent within it** (X-User-ID = owner; agent-id is attribution, not a capability ceiling). Folio is materially stronger: authority is the intersection `agent ∩ token ∩ caller` plus a separate project ceiling, enforced at three convergence points — `executeTool`'s double-membership check (`agent-tools.ts:329`), `intersectAgentProjects`, and `effectiveReach` fail-closed (`runner.ts:513`). A Folio agent *never* inherits caller-equivalent authority; `callerScopes` defaults deny-all.

**Secrets-redaction.** Multica: three clean convergence points — encryption-at-rest (but only for Lark; provider keys are **plaintext** in `custom_env`), a single-seam output redactor, and structural serializer suppression with an audited reveal endpoint. Folio is stronger at rest (BYOK keys libsodium-encrypted, injected into the provider call only, never into messages) and on serialization (`redactRunForApi` strips `system_prompt`), but **lacks the content-based output redactor** entirely.

**Skills-model.** Multica: runtime DB-row skills, no integrity hash; trust is structural (who-can-manage RBAC + the explicit agent-bind act); `allowed-tools` frontmatter is advisory, not enforced; bound bodies written verbatim to the CLI's native discovery dir. Folio is stronger: trust is a **forge-proof typed `trusted` column** (invariant 11) flipped only by `setSkillTrust` behind `canBlessSkill`; blessed vs unblessed bodies enter *different channels* (instruction vs fenced untrusted-data); all execution still bounded by `agent ∩ caller` scopes regardless of skill content.

**Scheduler-data.** Multica: re-runs the full caller-bound admission gate *at every dispatch tick* keyed to the autopilot creator, claims due triggers in one atomic `UPDATE ... RETURNING`, skips (≠ fails) when the runtime is offline, DB-clock canonical time, per-trigger `concurrency_policy` (skip/queue/replace). Folio's reaction plane already has an atomic claim and is genuinely single-team; no confirmed gap surfaced, though several Multica patterns are worth borrowing as product hardening (§5).

---

## 3. Confirmed hardening deltas (ranked)

Only `confirmed-gap` / `partial-gap` verdicts that are security-relevant and **live** (not dead-code-gated). All three are bounded by Folio's single-team, caller-scoped, turn-based model.

### 3.1 — No content-based output redactor on the model-output seam — **MEDIUM**

- **Today:** Folio persists/broadcasts model output verbatim — `kind=result` comment, run body, conversation SSE. Secret handling is all *structural* (BYOK keys encrypted + injected into the provider call only; minted MCP token revoked at run end; decrypt errors swallowed; `redactRunForApi` strips `system_prompt`). There is **no regex/pattern scan of what the model itself prints**. Confirmed by hand: `runner.ts:1601` (`setRunBody`), `:1636`/`:1693` (`postAgentComment`).
- **Multica does better:** `server/pkg/redact/redact.go` scrubs a pattern bank (tokens, keys, Bearer headers, DB conn strings) at the *one* ingest seam (`ReportTaskMessages`) before both DB persist and broadcast, independent of where the secret originated.
- **Recommended change:** wrap the two existing output seams — `postAgentComment()` (`runner.ts:1693`, the funnel all model output passes through, incl. `ctx.sink.text`) and `setRunBody()` (`runner.ts:1601`, the cc transcript) — in one redactor *before* persist/broadcast. Place it at the **loader, not per-handler** (the repo's own lesson: `system_prompt` leaked 3× from per-handler redaction). Scope tight (false positives cheap): (1) `folio_pat_[A-Za-z0-9_-]{40}` — highest value, can be **live mid-turn**; even better, scrub the *exact* `ccToken` string the runner just minted (a known value); (2) `Bearer <token>`; (3) `sk-...` provider keys; (4) DB conn strings with embedded passwords. Mask to a fixed sentinel. **Do not** port Multica's full AWS/GitHub/Slack/JWT bank — BYOK keys never enter the message stream by construction, so the token-echo case is the only one with a concrete live-credential consequence.
- **Why medium, not high:** the cc path (where `cat .env` is most plausible) is disabled; the minted token is short-lived; BYOK keys are structurally out of the message stream. The live window is the API path echoing its own still-valid `folio_pat_` token into a comment.
- **Process:** this touches the token + BYOK surfaces → if built, do it as a scoped follow-up with a `## Threat model` section (threat-modeling gate fires).

### 3.2 — No sweep-on-revoke for in-flight runs — **LOW (defense-in-depth)**

- **Today:** run-create freezes the caller's authority into the `agent_run` frontmatter from live `workspace_access`/`project_access`. The runner reads **only** that frozen snapshot — never re-consults `access.ts` mid-loop. `DELETE /instance/access` deletes the row and emits `access.revoked` but does nothing to in-flight runs and doesn't invalidate the auto-minted run token. The only mid-run kill switch (`wasCancelled`, via a `kind=rejection` comment) is unrelated to revocation and absent on conversation runs.
- **Multica does better:** `revokeAndRemoveMember` (`workspace_revoke.go`) is a single transaction that archives agents, cancels in-flight tasks, force-offlines runtimes, and removes the member.
- **Recommended change (right-sized — do NOT port the daemon-convergence template; Folio has no runtimes/daemons/per-member agents):** on `access.revoked`, sweep any non-terminal `agent_run` whose target project is now unreachable by the revoked user → post `kind=rejection` (or transition to `cancelled`) via the existing `wasCancelled`/handle-cancel terminal path (`runner.ts:1239/1433/1752`). Cheaper interim: a live-access re-check at the per-tool boundary where `wasCancelled` already polls.
- **Why low:** single-team, owner/admin-gated revocation, turn-based short-lived runs. The window is one in-flight turn against an authenticated team member whose access an admin just pulled — defense-in-depth, **not** a tenancy leak.

### 3.3 — `token-reach.ts` not named as a convergence point in the invariants doc — **IDEA-ONLY / process**

- **Today:** the caller-ceiling discipline is mechanically real and converged — `mintToken` routes through the single ceiling (`token-reach.ts:91`, the 9f75c40 CRITICAL fix), reach classified by `isOperatorToken`/`effectiveReach`, unattended runs floored by `UNATTENDED_FLOORED_SCOPES` (`agent-tools.ts:161`). Folio already *does* the thing Multica's review-gate protects.
- **Multica does better (process only):** a written contract forcing every new machine-credential auth branch to be classified human- vs machine-equivalent at the same review.
- **Recommended change:** only if `ARCHITECTURE-INVARIANTS.md` is being revised anyway — extend the reach invariant to name `token-reach.ts` as the reach-classification convergence point: "any new reach kind / credential source MUST declare its position relative to the caller ceiling (`effectiveReach`), and if it can act unattended, against `UNATTENDED_FLOORED_SCOPES`." Changes no runtime behavior. **Skip unless the doc is open.**

---

## 4. Agent-model pressure-test

Studying a mature peer **strongly VALIDATES** Folio's direction; where it challenges Folio, the divergence is the *correct* tradeoff for Folio's wedge.

- **Caller-bounded authority — VALIDATED, Folio is AHEAD.** The single most important finding. Multica — the mature platform — settled on a task token that is **owner-equivalent within the workspace**, the only narrowing being workspace, the only capability fence an account-billing denylist *explicitly not applied globally*. Folio's `agent ∩ token ∩ caller` intersection with fail-closed `effectiveReach` is a **stronger, more principled posture than the mature peer reached.** A peer with years of production runtime did *less* narrowing than Folio. **Do not regress this** — keep `agent-tools.ts:329` and `runner.ts:513` test-covered.

- **Spawn-the-CLI — VALIDATED as a hard problem; gating it is correct.** Multica spent enormous maturity on exactly what the CLI path costs: env-marker stripping, `--permission-mode bypassPermissions` + control-request auto-approval, stream-json parsing, idle/tool watchdogs, path mutexes, exact-bytes workdir cleanup, per-task minted tokens, poisoned-session detection. Folio's `claude-code` path is **hard-disabled at preflight** (`runner.ts:791`) and lacks most of that. Lesson: the CLI fork is a multi-quarter hardening commitment; keep it gated until funded. When it revives, Multica's `mergeEnv`/`isFilteredChildEnvKey` denylist and `bypassPermissions` + `--disallowedTools AskUserQuestion` are the reference port. (See the dead-code checklist in §6.)

- **Turn-based — VALIDATED.** Multica is streaming, which is *why* it needs an idle watchdog and preemptive kill. Folio's turn-based "do the task, stop, report" means a runaway run is already round-capped and budget-capped; cooperative cancel at tool boundaries is a contained tradeoff, not a vulnerability. Honest challenge: a long *pure-text* generation with no tool calls can't be interrupted until it finishes — a deliberate, threat-model-documented v1 deferral, low severity.

- **Typed-trust skills — VALIDATED, Folio is AHEAD.** Multica gates *who* can change a skill (RBAC) but nothing about *what it contains*, and `allowed-tools` is unenforced advisory metadata. Folio's forge-proof typed `trusted` column + blessed/unblessed channel split + `canBlessSkill` separation-of-duties is **stronger than the mature peer**, and the hard authority boundary holds even if a blessed skill instructs damage. Don't be tempted by Multica's `skills-lock.json` — confirmed to be dev-time vendoring with **zero runtime consumers**, not a trust gate.

- **SQLite-polled triggers — VALIDATED.** Multica's autopilot poller is *also* a polled scheduler whose entire concurrency primitive is an atomic claim-and-clear — the same shape as Folio's reaction plane. Its expensive lease/heartbeat machinery is reserved for distributed multi-replica system jobs, which Folio's one-binary model doesn't have. Folio's poller is right-sized.

**Bottom line:** the places Folio diverges from this mature peer are the places Folio is *deliberately smaller* (single-team, in-process, turn-based, gated CLI) — and that smallness is precisely what lets Folio be *stricter* on authority and skill-trust than the peer that had to generalize. The study challenges nothing structural. The honest to-do list is three narrow items, none of which touch the architecture.

---

## 5. Ideas worth stealing (non-security)

Fit Folio's wedge (single-binary, markdown-as-truth, agent-first):

- **STEAL — Skip-vs-fail dispatch classification.** Split `skipped` (admission/readiness — never attempted, no one at fault) from `failed` (attempted and broke), via a sentinel, so a flaky/offline condition doesn't pollute run history or trip a future auto-pause circuit-breaker. Cheap, honest signal; fits markdown run records directly. Check Folio's trigger reactor for this distinction.
- **STEAL — Per-trigger overlap policy (skip/queue/replace).** Prevents N overlapping copies of a slow recurring agent doing the same task. A natural frontmatter field on a trigger document (`concurrency: skip|queue|replace`) — markdown-native, fits the wedge.
- **STEAL — Webhook/event payload as fenced untrusted data.** Multica injects event payloads inside an explicit ` ```json ` fenced block under a labeled header, separated by `---` from operator instruction. Folio already has the trusted/untrusted *channel* concept for skills; extend the same framing to external trigger payloads. Pure prompt-hygiene win, no schema change.
- **STEAL (backlog) — Stream-json on the cc path when revived.** Switch cc argv to `--output-format stream-json --verbose`, parse line-by-line into the existing `tool_step`/`incrementTokens` seams the API path uses. No data-model change. Backlog enhancement, not a gap.
- **SKIP — `skills-lock.json` / content-hash integrity.** Dev-time vendoring metadata; Folio's skills are code-seeded from in-repo constants (`system-skills.ts`) with no external origin to re-verify. A hash adds value only for untrusted external imports — not Folio's model.
- **SKIP — DB-clock canonical time / lease-heartbeat scheduler.** Solves multi-replica clock skew — clashes with Folio's one-binary, single-process invariant.
- **SKIP — Slot-semaphore-over-shared-host-resources.** Multica's slots index physical host resources for a daemon fleet; Folio's `FOLIO_POLLER_CONCURRENCY` is the right in-process analog and already exists.
- **SKIP (wedge clash) — the 12-backend abstraction / local-daemon fleet / plaintext `custom_env` + reveal endpoint.** All contradict "one binary, no sidecar services" and/or regress Folio's stronger at-rest encryption.

---

## 6. Explicitly NOT a gap (don't re-investigate)

Verifier checked these against real Folio source and found Folio already handles them — confidence-builders. (Subject to the §0 verification caveat — the highest-confidence ones are also corroborated by the two-pass convergence and by hand-checks.)

- **Caller-bounded authority ceiling** — `agent ∩ token ∩ caller` with fail-closed `effectiveReach` is **stronger than Multica's owner-equivalent task token**. A do-not-regress, not a gap.
- **Master-key / secret fail-closed at boot** — `FOLIO_MASTER_KEY` (64-hex) and `SESSION_SECRET` (≥32) validated in an eager Zod schema (`env.ts:100`) that aborts boot. No hardcoded dev-default secret, no JWT signing path (opaque DB sessions + sha256 bearer tokens). Multica's `*-dev-secret-change-in-production` footgun is structurally impossible here. (Minor tidy: `SESSION_SECRET` is required-but-unused.)
- **Anti-enumeration 404s** — denied project/document reads return 404-indistinguishable-from-absent, tested as such. The only 403/404 distinction is the workspace boundary — an *intentional non-tenancy* choice under one-instance-one-team.
- **Authority never selected from client input** — authority is server-derived everywhere (`userRole → roleToScopes`), re-validated at `executeTool`. No trusted header to strip-then-stamp because there's no trusted header at all.
- **Forge-proof skill trust** — typed `trusted` column, blessed/unblessed channel split, `canBlessSkill` blessing gate (invariant 11). Stronger than Multica's plain RBAC. MCP admin PAT excluded from self-blessing by construction.
- **The minted-and-bound MCP token Multica recommends already exists** in `ccExecute` (scope-clamped to the caller-narrowed token, `--strict-mcp-config` Bearer, revoked in `finally`, unit-tested). *Doc-only cleanup:* delete the stale "v1 passes no MCP token" line at `runner.ts:1516`.
- **Global fan-out concurrency ceiling** — `FOLIO_POLLER_CONCURRENCY` (default 5) + enqueue-only `planning` rows is exactly the over-claim protection Multica's slot semaphore provides.
- **Resume poisoning** — structurally absent. Folio's resume is document-lineage-based (rebuilt from persisted markdown every turn); no opaque provider session to poison.
- **Agent-supplied-env override at spawn** — N/A: Folio's spawn contract has no env channel from agent/instance config, so there's no override vector.
- **The entire cc-CLI dead-code cluster** (unfiltered child env incl. `FOLIO_MASTER_KEY`/`DATABASE_URL`, missing `--permission-mode`, opaque stdout, exit-0-means-completed, server-cwd no-isolation) — all real code, all **unreachable** behind the preflight gate (`runner.ts:791`) *and*, on the conversation path, behind the operator's hardcoded `anthropic` provider. A **cc-re-enablement checklist**, not live gaps. Fold into the same work that re-threads the documented S-1/S-2 cc-authority blocker.

---

## Actionable summary

| # | Item | Severity | Effort | When |
|---|------|----------|--------|------|
| 3.1 | Output-secret redactor at `postAgentComment`/`setRunBody` (scoped to `folio_pat_` + a few shapes) | MEDIUM | small, +threat-model | Worth a scoped follow-up |
| 3.2 | Sweep in-flight runs on `access.revoked` | LOW | small | Defense-in-depth backlog |
| 3.3 | Name `token-reach.ts` as a convergence point in invariants doc | idea-only | trivial | Only if doc is open |
| §5 | Trigger discipline: skip-vs-fail, per-trigger overlap policy, payload-as-fenced-data | product | small each | When triggers get more use |
| §6 | Doc cleanups: stale `runner.ts:1516` line; unused `SESSION_SECRET` | trivial | trivial | Opportunistic |

**The cc-CLI dead-code cluster (§6) is the single biggest pre-existing checklist** — fold it into the documented S-1/S-2 cc-authority-revival work, not a standalone effort.
