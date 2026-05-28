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

### Sub-phase B → F (later sessions)

Branches stay on `phase-3/agent-runner`; each future session opens with the next sub-phase loaded into this todo list and the previous one moved to the Review section at the bottom.

- **B (8 tasks)** — provider abstraction + 4 implementations + AI settings tab.
- **C (13 tasks)** — runner core (services + poller + 6 recursion guards + lazy-seed runs table).
- **D (8 tasks)** — routes + MCP parity + admin stats. BUG-002 folds into D-3/D-4.
- **E (9 tasks)** — web: runs table + link tiles + Cmd-K + banner + body editor wiki-links.
- **F (8 tasks)** — shake-out + Playwright + branch close.

---

## Carried over from prior branches (not blocking Phase 3)

- BUG-002 (MCP create_agent slug schema) — folded into D-3/D-4 per pre-execution decision.
- BUG-003 (Milkdown teardown intermittent) — deferred to a UX polish pass.
- BUG-004 (web bundle size) — defer to Phase 7.
- 23 SHOULD-FIX + 24 NICE-TO-HAVE from Phase 2.6 reviewer backlog — untouched.
- Pre-existing TS errors in `apps/server/src/index.ts` and `packages/shared/src/{filter-compile,slug}.test.ts` — sweep before next merge.
