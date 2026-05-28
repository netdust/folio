# Folio — Tasks

Active task list for the current branch / session. Mark items off as you complete them. Add a `## Review` section at the bottom when a batch wraps up.

For phase-level checkboxes that survive across branches, see `docs/PHASES.md`. This file is short-lived working memory.

---

## Current branch: `phase-3/agent-runner`

Implementing Phase 3 per `docs/superpowers/specs/2026-05-26-phase-3-agent-runner-design.md` via the plan at `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md`. Wrapped in `netdust-core:ntdst-execute-with-tests` → `superpowers:executing-plans`.

Plan branched from `main` at `984b31c` (Phase 2.6 merge). Sub-phases A → F, one batched per session per user direction.

**Pre-execution decisions (this session):**
- Stay in main working tree on `phase-3/agent-runner` (no worktree).
- BUG-002 (MCP `create_agent` slug schema, deferred from 2.6) folds into D-3/D-4.

### Sub-phase A — Foundation (this session)

Migrations applied · Zod schema importable · state-machine helper unit-tested · new event kinds in shared · builtin triggers flipped · dev DB auto-migrates on boot · migration↔journal pre-commit guard.

- [ ] **A-0** — Auto-migrate on boot (`apps/server/src/db/auto-migrate.ts` + test + wire into `index.ts`)
- [ ] **A-1** — Phase 3 event kinds in `packages/shared/src/events.ts` (agent.run.*, ai.action, runs_table.lazy_seeded, workspace.provider.degraded/recovered)
- [ ] **A-2** — Migration 0012 — widen `documents.type` CHECK to include `'agent_run'` + indexes for poller + rate-limit queries (update `_journal.json`)
- [ ] **A-3** — Migration 0012a — flip `builtin-on-assignment` + `builtin-on-mention` to `enabled=true`
- [ ] **A-4** — agent_run frontmatter Zod + state-machine helper (planning → running → awaiting_approval / completed / failed / rejected / canceled)
- [ ] **A-4b** — Pre-commit hook: any staged `.sql` migration must have a `_journal.json` entry in the same commit
- [ ] **A-5** — Sub-phase A integration gate (`netdust-core:integration` skill → server + shared unit + integration + type-check)

### Acceptance for this session

- All 7 A tasks committed atomically per task on `phase-3/agent-runner`.
- Server unit suite + shared unit suite green.
- Server TS clean for touched files; pre-existing errors unchanged.
- Sub-phase A integration gate (A-5) reports green.

### Sub-phase B — retroactive split into review-sized groups

> **Why retroactive split:** Sub-phase B was originally scoped as one 8-task batch. Two rounds of `/code-review` at `--effort=medium` surfaced 15 findings each, and the 15-finding cap *compounded across rounds* — each round was 15-deep into a defect pool that stayed >15. The structural fix is **planning sub-phases sized so each group's defect surface fits within /code-review's cap.** B was too big; future sub-phases should be sized smaller. See `memory/lessons.md` 2026-05-28 entry on this. Splitting B retroactively for the purposes of per-group `/code-review` tracking + the B-8 integration gate.

Each group below has:
- A scope statement + the shipped commit SHA(s)
- A code-review tracking table (one row per round)
- A known-open-findings list (cleared as fixes land)
- A close-criteria checklist (must be all green before B-8 can run)

### Group B' — Foundation (B-1)

**Scope:** AIProvider interface + factory.
**Commits:** `3ab475e`

| Round | Effort | Surfaced | Open after fix | Status |
|---|---|---|---|---|
| _none yet_ | | | | TODO: run a targeted pass against just B-1's diff |

**Known open findings:**
- #11 `__testing` exported from production module (latent — `provider.ts`)
- #12 proxy cache dead-logic (latent — proxy created fresh per call, cache never hits)

**Close-criteria:**
- [ ] At least one `/code-review --base=...3ab475e^..3ab475e` pass run
- [ ] 0 open security-class findings
- [ ] 0 open correctness findings
- [ ] Latent/UX findings either fixed OR added to retro-follow-ups.md with explicit deferral

### Group B'' — Anthropic provider (B-2 + B-2 fixup)

**Scope:** Anthropic SDK wrapper into AIProvider interface.
**Commits:** `cba0ef6` (B-2) + `20b1ff0` (boundary-cast fixup)

| Round | Effort | Surfaced | Open after fix | Status |
|---|---|---|---|---|
| _none yet against this slice alone_ | | | | TODO: targeted pass |

**Known open findings:**
- #10 Anthropic error messages may embed key tails — not yet sanitized
- #13 baseUrl threaded but Anthropic SDK doesn't consume it (interface lies)

**Close-criteria:**
- [ ] At least one `/code-review` pass against the slice
- [ ] 0 open security-class findings
- [ ] Error sanitization (mitigation #5 in threat model) verifiably routed through

### Group B''' — OpenAI family (B-3 + B-4)

**Scope:** OpenAI SDK wrapper + OpenRouter (thin OpenAI wrapper with base-URL override).
**Commits:** `4ff4e0e` (B-3) + `0b0f89f` (B-4)
**Why grouped:** OpenRouter imports from `openai.ts` directly; reviewing them apart misses cross-file consistency.

| Round | Effort | Surfaced | Open after fix | Status |
|---|---|---|---|---|
| _none yet against this slice alone_ | | | | TODO: targeted pass |

**Known open findings:**
- #6 OpenRouter testKey false-positive (`/models` is public, returns OK for bogus keys) — MERGE BLOCKER
- B-3 `as never` cast (line 38 of `openai.ts`) — never got the B-2-style fixup that `20b1ff0` shipped for Anthropic
- #3 (round 2) tc.function unguarded — SDK marks optional; TypeError risk mid-stream

**Close-criteria:**
- [ ] At least one `/code-review` pass against the slice
- [ ] OpenRouter testKey switched to an authenticated endpoint (matching Anthropic + OpenAI patterns)
- [ ] `as never` cast replaced with `OpenAI.ChatCompletionMessageParam[]` (or equivalent typed boundary cast)
- [ ] 0 open security-class findings

### Group B'''' — Ollama + AI route (B-5 + B-6)

**Scope:** Ollama provider (HTTP fetch, NDJSON parsing, no SDK) + `POST /api/v1/w/:wslug/ai/test-key` route + URL allow-list (added in fix batch).
**Commits:** `70c9f19` (B-5 Ollama) + `d6b6637` (B-6 ai.ts route) + any fix-batch commits adding `url-allow-list.ts`

| Round | Effort | Surfaced | Open after fix | Status |
|---|---|---|---|---|
| 1 (whole sub-phase) | medium | ~15 of ~22+ | 4 (#1, #2, #4, #5 of round 1) | partial |
| 2 (whole sub-phase) | medium | 15 fresh | 5 critical (#1+#2+#4+#5+#6 of round 2) | partial |
| 3 (whole sub-phase) | medium | 15 (incl. 4 merge-blockers) | unfixed | open |

**Known open findings (MERGE BLOCKERS):**
- #1 cookie-presence guard bypass on `ai.ts:16` — `Cookie: folio_session=garbage` passes the `requireUser` check (current implementation is name-presence, not session-validity)
- #2 `settings.ts` allows `ollama` without `baseUrl` — persistence-path bypass, runner defaults to localhost
- #4 url-allow-list IPv6 trailing-dot bypass — `endsWith('.localhost')` misses `.localhost.`
- #5 url-allow-list IPv4-mapped IPv6 expanded forms bypass — 3-segment `::ffff:0:7f00:1`, 6to4 `2002:7f00:0001::/48`, NAT64 `64:ff9b::7f00:1` all unhandled

**Other open:**
- #3 Ollama `testKey` leaks raw error context (mitigation #5 not applied)
- #7 Ollama final-buffer not flushed at end-of-stream
- #15 Ollama token-count cast suppresses type errors

**Close-criteria:**
- [ ] **All 4 merge-blockers fixed** (#1, #2, #4, #5)
- [ ] At least one `/code-review --effort=high` (NOT medium) pass against the slice — this group's defect surface exceeded medium's cap
- [ ] 0 open security-class findings
- [ ] Threat-model mitigations #1–#10 all verifiably implemented in this slice's code

### Group B''''' — UI (B-7)

**Scope:** AI settings tab — React component + react-query hook.
**Commits:** `39118df`

| Round | Effort | Surfaced | Open after fix | Status |
|---|---|---|---|---|
| _none yet against this slice alone_ | | | | TODO: targeted pass |

**Known open findings (none security-class — all UX/correctness):**
- #7 (round 3) onSave lacks provider-switch guard (toast misnames provider on rapid switch)
- #8 non-default labels create duplicate-row UX
- #9 providerRef microtask race
- #14 non-default rows hide baseUrl (admin can't tell loopback from public)

**Close-criteria:**
- [ ] At least one `/code-review` pass against the slice (medium effort is fine — frontend-only, no security surface)
- [ ] All correctness findings fixed (provider-switch guard is the only one worth fixing pre-merge; rest can defer to retro-follow-ups)

### Group B'''''' — Integration gate (B-8)

**Scope:** Sub-phase B integration close-out.

**Cannot fire until:**
- [ ] B' close-criteria all checked
- [ ] B'' close-criteria all checked
- [ ] B''' close-criteria all checked
- [ ] B'''' close-criteria all checked (the 4 merge-blockers are HERE)
- [ ] B''''' close-criteria all checked
- [ ] All round-3 findings either fixed OR explicitly deferred to retro-follow-ups.md

**Steps once unblocked:**
1. Run `/integration` (compiles + tests pass).
2. Run `/evaluate` (process retro — should capture the cap-compounding + sub-phase-sizing lesson).
3. Confirm `tasks/retro-follow-ups.md` lists any deferred items per group.
4. Confirm threat-model mitigations are all implemented (use the threat model as the convergence checklist, not free-form code-review).
5. Mark Sub-phase B complete in `docs/PHASES.md`.

---

### Sub-phase C → F (future sessions — sized smaller this time)

> **Lesson from B:** size future sub-phases so each one's expected defect surface fits within `/code-review`'s 15-finding cap at medium effort. Roughly: ≤500 LOC of new code OR ≤3 security-sensitive tasks per group. When you write/expand the plans for C/D/E/F, split aggressively.

- **C (runner core)** — currently 13 tasks; will need splitting per the lesson above. Expect 3-4 groups. Especially security-sensitive: runner makes outbound requests using BYOK credentials, executes provider configs in unattended runs. Threat-model extension required (see Folio plan §Threat model — "Threat model for runs table data exfil" is Sub-phase C's concern, already flagged as out-of-scope-for-B).
- **D (routes + MCP)** — currently 8 tasks; ≤3 security-sensitive (the MCP tools surface, the per-task scope-check refactor). Split into ~2 groups. BUG-002 (MCP create_agent slug schema) folds into D-3/D-4.
- **E (web UI)** — currently 9 tasks; mostly frontend, lower security surface. Likely splits into 2 groups but the per-group cap pressure is lower.
- **F (shake-out + branch close)** — single group, runs once. No per-task split.

---

## Carried over from prior branches (not blocking Phase 3)

- BUG-002 (MCP create_agent slug schema) — folded into D-3/D-4 per pre-execution decision.
- BUG-003 (Milkdown teardown intermittent) — deferred to a UX polish pass.
- BUG-004 (web bundle size) — defer to Phase 7.
- 23 SHOULD-FIX + 24 NICE-TO-HAVE from Phase 2.6 reviewer backlog — untouched.
- Pre-existing TS errors in `apps/server/src/index.ts` and `packages/shared/src/{filter-compile,slug}.test.ts` — sweep before next merge.
