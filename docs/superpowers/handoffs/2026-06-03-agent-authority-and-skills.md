# Handoff — Agent Authority + Skill Reach

**Date:** 2026-06-03
**Branch:** `spec/agent-authority-and-skills` (6 commits ahead of `main`, UNPUSHED)

## TL;DR for the next session

The spec and plan are done and committed. To execute, read the plan and start at Task A1:

- **Plan:** `docs/superpowers/plans/2026-06-03-agent-authority-and-skills.md` — 17 tasks (A1–A12 authority, B1–B5 skills), TDD steps with complete code, two Phase Gates.
- **Spec (the why + decisions):** `docs/superpowers/specs/2026-06-03-agent-authority-and-skill-disclosure-design.md`.

The plan is self-contained (written for a zero-context executor). You CAN just point at it — this handoff only adds the session state the plan file can't carry.

## BEFORE you start: clean the working tree (NOT part of this plan)

`git status` on this branch shows uncommitted changes that belong to a DIFFERENT, earlier piece of work (the "set up Ollama" session), NOT to this auth/skills plan. Do not let them bleed into the auth commits.

Uncommitted / untracked:
- `apps/server/src/lib/url-allow-list.ts` + `.test.ts` — loopback SSRF escape hatch (`FOLIO_ALLOW_LOOPBACK_AI`)
- `apps/server/src/env.ts` — the `FOLIO_ALLOW_LOOPBACK_AI` env flag
- `apps/server/src/routes/ai.ts`, `routes/settings.ts` — wire the flag into the AI-key routes
- `apps/server/src/lib/system-skills.ts` — "add a provider" recipe added to the `folio` skill body
- `CLAUDE.md` — threat-modeling-on-boundary-edits rule
- `apps/server/scripts/seed-ollama-key.ts` (untracked) — one-off Ollama key seeder
- `docs/superpowers/retros/2026-06-03-ollama-provider-setup-retro.md` (untracked)
- `docs/superpowers/plans/2026-06-02-phase-C-cross-workspace-triggers.md`, `docs/superpowers/handoffs/2026-06-02-...` — stray, pre-existing

**Recommended:** commit the Ollama work on its OWN branch (off `main`) before touching this plan, so the auth branch stays clean. The Ollama changes are tested (full server suite 1280/0 at the time) but were never committed. Do NOT commit them into `spec/agent-authority-and-skills`. See the retro for what they were. (Note: `system-skills.ts` is touched by BOTH the Ollama recipe AND this plan's Task B4 — resolve that file's Ollama edit first, separately, to avoid a tangled diff.)

## Branch state

```
spec/agent-authority-and-skills (unpushed):
  e834129 docs: agent authority model + skill-reach design spec
  62676fd docs: agent authority + skill-reach implementation plan
  9365303 docs: conform plan to netdust-core:testing-workflow
  + interleaved memory(folio) auto-commits
```
Only docs are committed on this branch — NO implementation has started. Task A1 is the first code.

## How to execute (per CLAUDE.md "How to Work")

1. Load `netdust-core:ntdst-execute-with-tests` (REQUIRED for plan execution in this repo — wraps executing-plans + subagent-driven-development with the testing-workflow gates).
2. Recommended mode: **subagent-driven** — fresh subagent per task, review the diff + tests between tasks. This is security-critical (authorization + multi-tenancy), so the per-task gate matters.
3. Run server tests from INSIDE `apps/server` (`cd apps/server && bun test`) — root-cwd triggers a spurious ~650-fail init cascade. Web: `npx vitest run`. tsc per-app.
4. Honor the task ORDER (plan's self-review notes): A1→A2→(A3,A4,A5)→A6→A7→A8→A9→A10→A11→A12 → **Phase Gate A** → B1→B2→B3→B4→B5 → **Phase Gate B**.

## The two things most likely to go wrong (read the spec's threat model)

- **T4 (Task A8) is load-bearing.** Do NOT just delete the runner's line-410 workspace rebind — REPLACE it with `effectiveReach(token.workspaceId, run.workspaceId)` written into the narrowed run token, and have the resolver read THAT, never the raw token field. Skipping the intersection = a member-triggered operator run can reach a third workspace (privilege escalation). Phase Gate A integration scenario 1 is the regression test for this.
- **T8 (Task B3) bless gate keys on `createdBy IS NULL`** (system origin), NOT `agentId`. The operator token and an MCP admin PAT are both `workspaceId/agentId`-null; only `createdBy` distinguishes them (the operator is code-provisioned with `createdBy: null`; a human PAT always carries a human `createdBy`). Task A9 must provision the operator token with `createdBy: null` for B3's test to pass.

## Seed-once caveat (for merge/deploy, not execution)

`__system` seeding is seed-once. On a LIVE install, the operator-token re-provision (A9) and `folio` skill frontmatter (B4) won't auto-propagate. After merge: re-provision the operator token (A9's helper is idempotent) and `set_skill_trust('folio', true)` once. Fresh installs are fine.

## Decisions already locked (don't re-litigate — see spec)

Reach derives from a nullable `workspace_id` field (null=instance), capability-gated at CREATION; admin agents = full instance except secrets; workers = project-scoped, document scopes only; skills live only in `__system`, reached by push (loadAgentDefinition reads `__system`) + pull (`get_skill`, narrow); skill blessing separated from authoring (MCP authors, operator/human blesses).
