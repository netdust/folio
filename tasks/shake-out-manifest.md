# Bug Manifest — Phase 2.5 Workspace-Scoped Agents

**Generated:** 2026-05-26
**Plan:** `docs/superpowers/plans/2026-05-26-phase-2.5-workspace-scoped-agents.md`
**Branch:** `phase-2.5/workspace-agents` (12 commits)
**Build status:** Server 258/1/0, Web 316/1/0, Shared 28/0; Web TS clean; Server TS = pre-existing only
**Sweep status:** Phase 1 in progress

---

## Sweep plan

Track A — Automated (Claude):
1. Server smoke: liveness + migration applied + new schema present
2. Server contract checks via curl as session user `stefan@netdust.be`
3. MCP contract checks via curl with agent-bound bearer
4. New Playwright spec: `phase-2-5-workspace-agents.spec.ts`
5. Regression Playwright: existing smoke + click-through + manual-qa
6. Log scan: server stdout for unhandled rejections / 500s

Track B — Manual (human):
- Browser sanity (workspace popover, agents page, projects field, assignee picker).

---

## Bug List

(Logged as found during Phase 1. NO FIXES until manifest is signed off.)

---

## Fix Log

| Bug | Attempts | Root Cause | Fix | Re-sweep |
|-----|----------|-----------|-----|----------|

---

## Final Status

(Filled at the end.)
