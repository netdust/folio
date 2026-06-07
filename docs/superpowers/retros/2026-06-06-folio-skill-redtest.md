# RED-test (adapted) — folio operator skill — 2026-06-06

The `folio` skill is **not** a netdust *plugin* discipline skill (no `red-tests.md`).
It's the operator agent's in-app reference manual (a runtime string in
`apps/server/src/lib/system-skills.ts`: `FOLIO_SKILL_BODY` + `OPERATOR_PROMPT`),
loaded into the operator's context at run time. So the standard red-test (toggle the
skill on/off in a subagent system prompt) doesn't map. Ran an **adapted A/B**: old
skill body = baseline, new skill body = skill-on.

## Scenario 1 — "delete the todos view", workspace already known
- **Baseline (OLD skill):** 4 calls (list views → ask_choice → delete → re-list verify), **no** reflexive `list_workspaces`. Already the cheap path.
- **Verdict:** scenario **too easy** — does not discriminate. The §5 "fewest calls" guidance already existed in the OLD skill; the live stall's drivers (the OPERATOR PROMPT "ORIENT FIRST" pulling against §5, + the blind 404) were not exercised because I told the subagent the workspace and injected no 404.
- **Regression?** no.

## Scenario 2 — malformed-path 404 self-correction
- **Baseline (OLD skill):** **INVALID RUN.** The general-purpose subagent had the live `folio` MCP server connected and called the **real** API (reported ~50 real workspaces, real view ids, project `stride`) instead of role-playing the injected 404 environment. The injected bare-null-404 trap never fired → no apples-to-apples comparison.

## The real result of this exercise — a method finding
1. A subagent red-test **cannot** faithfully pressure-test this skill while the live `folio` MCP server is connected: subagents call the real API and the injected-failure scenario is bypassed.
2. The genuine failure mode (a bare-null 404 → path guess-loop) reproduces under the operator's **runtime model** (Sonnet, long context), **not** an Opus-class subagent that composes the correct `/w/ + /p/` shorthand on the first try.
3. **Faithful verification** = run the *real* operator (Sonnet) against a dev DB with the old vs new skill body and count calls — an integration/shakeout test, not a subagent red-test.

## What IS proven
The unit layer lands the discriminator: `pathHint()` + the live-app
"no-route-matched 404 → `body:null`" test in `folio-api-tool.test.ts` (68 pass,
full server suite 1591 pass). That proves the *mechanism* (the hint fires on the
malformed-path 404 and not on a resource-absent 404). The *behavioral* claim —
that the operator spends fewer calls and self-corrects — needs the live-operator
A/B above, which is the right place for it.
