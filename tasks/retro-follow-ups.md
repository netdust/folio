# Retro follow-ups — items needing human judgment

Created 2026-05-28 by `/evaluate` after Phase 3 Sub-phase A. One bullet per item.

**Resolved:**
- 2026-05-28: `ProviderEvent.done.reason` widened to `'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn'`. Anthropic maps `refusal` + `pause_turn` explicitly; OpenAI `content_filter` → `refusal`. Shipped as B fix #10.

---

- **Should the implementer-prompt template in `superpowers:subagent-driven-development` require a literal `Skill('netdust-core:testing-workflow')` invocation in the subagent's report?**
  Today the discipline holds via prompt content (RED→GREEN cycle, test-count delta in every commit, full suite re-run after each task). The skill-tool invocation is honor-system. Adding it makes the invocation auditable via the SubagentStop hook but adds prompt overhead per task.
  **Decision needed:** YES / NO.
  **What changes if YES:** Updates to `subagent-driven-development`'s implementer-prompt template + the `ntdst-execute-with-tests` skill body. Subagents would need to invoke + paste the checklist into their report.
  **Source:** Phase 3 Sub-phase A retro, Harness Gap #5.

- **Should A-1's reviewer NICE-TO-HAVE suggestions (events.ts file-header "Phase 3 (Task A-1)" phase-rot marker, the sync-guard test comment precision, the describe-block name with "Phase 3 additions" suffix) be cleaned up now or deferred to next-touch?**
  Decision needed: NOW (one cleanup commit on this branch) or DEFER (handle at next-touch in B+).
  **What changes if NOW:** one ~5-line cleanup commit on phase-3/agent-runner before Sub-phase B starts.
  **What changes if DEFER:** the file collects phase markers until the next person touches it organically.
  **Recommendation:** DEFER. The comments aren't bugs and the convention "drop phase markers at next-touch" is already common in the codebase.
  **Source:** Phase 3 Sub-phase A retro, Recommendation #4.

- **Should the writing-plans skill add a "plan freshness check" to its checklist (when plan mtime > 5 days, controller re-reads against live peer files before dispatching)?**
  Two of the four plan defects in Sub-phase A were *house-style drift* (the plan was written before Phase 2.6 codified the camelCase + .strict() patterns). A pre-flight checkpoint catches them at zero cost.
  **Decision needed:** YES / NO.
  **What changes if YES:** an addition to `superpowers:writing-plans/SKILL.md` listing the freshness check. Folio's `memory/lessons.md` already has the rule (2026-05-28 entry) — promoting it to skill-level makes it cross-project.
  **Source:** Phase 3 Sub-phase A retro, Harness Gap #1.

- **B-2 minor cast tightenings deferred from code-quality review:** (a) `input_schema as { type: 'object'; [k: string]: unknown }` could become `Tool.InputSchema` if exported; (b) `stream as AsyncIterable<Record<string, unknown>>` could be `MessageStreamEvent`. Both at the SDK boundary. Defer to next-touch — neither blocks B-3/4/5.

- **Should `/code-review` raise its 15-finding cap for security-rich surfaces when invoked at `--effort=high`?** Sub-phase B's 7 rounds each hit the cap (15/15/9/9/11/7/15), driving a multi-round trickle pattern. Decision: YES → modify the medium/high `/code-review` skill to use cap=30 when invoked with `--effort=high` AND the diff includes surfaces from the `netdust-core:threat-modeling` predicate. NO → current cap stays; multi-round review accepted as v1 reality. (Surfaced by `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-B-retro.md` Harness gap §6.) Decision-needed-by: before Sub-phase C planning starts (runner surfaces fit the predicate).
