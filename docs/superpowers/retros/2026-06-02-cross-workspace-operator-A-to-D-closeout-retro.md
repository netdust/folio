# Cross-Workspace Operator (Phases A→D) — Close-Out Retro

_2026-06-02. The `/evaluate` close-out retro on the WHOLE A→D arc — the cross-workspace operator build, from the `__system` reserved library (A) through cross-workspace execution (B), cross-workspace triggers (C), to the library curation UI (D). Phase D is the final plan; with it built + reviewed + integration-green, the arc is complete. This retro audits HOW the arc was executed and produces the three named outputs the Phase D plan (T6 Step 4) requires: (1) an orchestration-layer reconciliation VERDICT table, (2) the carried-follow-ups disposition, (3) the wrong-model-reset lesson capture._

_Per-phase retros already exist for B (`2026-06-02-phase-B-cross-workspace-execution-retro.md`) and C (`2026-06-02-phase-C-cross-workspace-triggers-retro.md`); a pre-build whole-layer integration audit exists (`2026-06-02-orchestration-layer-audit.md`, which PREDICTED the B/C plan defects — both later confirmed + corrected in-flight). This is the ARC close-out, not a re-run of those._

---

## The arc in numbers

| Phase | What it shipped | Commits | Build shape | Gate |
|---|---|---|---|---|
| **A** | `__system` reserved library workspace + instance-owner + seeded folio skill / operator agent | 12 | subagent-driven, 8 tasks, M3 plan-corrected at dispatch | `/code-review high` (10 fixed) + `/integration` |
| **B** | Library operator runnable AGAINST any workspace B (home∈{run-ws,__system}, caller-bounded, token-rebind, definitional skill load) | 17 | subagent-driven, 8 tasks + 2 plan-corrections (PC-1 un-runnable-at-create, PC-2 definitional-load) | holistic review (2 merge-blockers) + `/integration` + invariant-audit + **real-key shake-out (Stefan)** |
| **C** | A customer-B trigger can FIRE a `__system` library agent UNATTENDED, bounded by caller ceiling + HIGH+MEDIUM floor | 19 | subagent-driven, 5 tasks + 1 dispatch plan-correction (C1 stale premise) | `/code-review high` (3 fixed) + holistic + `/integration` + **real-key trigger-fired shake-out (Stefan)** + `/shakeout` (cc hard-disabled) |
| **D** | Library curation UI: `__system` excluded from switcher, member-gated Settings entry, D4 prompt-redaction | 7 | subagent-driven, 6 tasks, 0 plan-corrections | two-stage per task + holistic (0 blockers) + `/integration` |

**Total: ~55 phase-prefixed commits over the arc** (interleaved with parallel-session planning + an unrelated Playwright visual-shakeout that rode the same branch). Final gates at D close: **server 1268 / 1-skip / 0-fail, shared 63 / 0, web 757 / 8-skip / 0, tsc clean ×3, NO migration in the entire arc** (every cross-workspace mechanism is frontmatter/JSON + a `where`-clause + a derived read — the architecture invariant "frontmatter is the schema" held across all four phases).

---

## Output 1 — Orchestration-layer reconciliation (VERDICT per overlapping piece)

The cross-workspace operator introduced a new orchestration layer (`__system` library + cross-workspace resolution + the fired-path floor) that overlaps earlier operator machinery and the DROPPED seeded-bot model. Per the plan's requirement, each overlapping piece gets a verdict: **SUPERSEDED → delete**, or **KEPT-SEPARATE because X**.

| Overlapping piece | Verdict | Evidence / reason |
|---|---|---|
| **The archived seeded-bot model** (`seedOperator` / `folio_system` / `seedMemoryDocs` / `__folio_operator` / `0021-backfill` / `includeSystem`) | **SUPERSEDED → already deleted** | The 2026-06-02 whole-layer audit grepped the live tree for all six markers → ZERO hits. Re-confirmed THIS session at the Phase D integration gate: `grep -rln "seedOperator\|folio_system\|0021.*backfill" apps/server/src/` → empty. The seeded-bot reset is clean; nothing leaked back. The operator is now an AGENT (created once via `ensureOperatorAgent` → `createDocument`, auto-minted token), not a per-workspace seeded bot with hidden memory. |
| **The `archive/phase-op-3-seeded-bot` git TAG** | **KEPT-SEPARATE because it is the only historical trace of the dropped design** | The tag is a zero-cost pointer to the reset's pre-image. The reset rationale lives in `project_operator-is-an-agent-not-a-seeded-bot` (auto-memory) + the Phase B PC-2 plan-correction. Deleting the tag would lose the ability to diff "what we almost shipped" against "what we shipped." **Recommendation: KEEP the tag indefinitely (it costs nothing); it is documentation, not dead code.** (This reverses the plan's tentative "delete the tag once A→D merged" — a tag is not a maintenance burden the way dead code is, and the cautionary value is real given the reset cost a full rebuild.) |
| **`folio_api` write-bridge tool vs the pre-existing MCP / native agent-tools surface** | **KEPT-SEPARATE — one registry, two faces (confirmed still true)** | Verified at HEAD: `agent-tools-registry.ts` registers all 20 production tools — including `folio_api` — into the single shared `executeTool` dispatch/auth gate. The HTTP run path (`runner.ts:731`) and the MCP `run_agent`/`/mcp` path (`routes/mcp.ts:172`) both funnel through that ONE `executeTool`; no transport re-derives auth. `folio_api` is not a parallel surface — it is one more tool in the same registry, behind the same gate. The "inside === outside" invariant the whole-layer audit asserted still holds after D. **No consolidation needed.** |
| **The cross-workspace home-predicate resolution (`resolveAgentForRun`) vs the trigger-path resolution (Phase C)** | **KEPT-SEPARATE — deliberately unified, not duplicated** | Phase C's plan-correction (C1) RE-GROUNDED the trigger fire-path on Phase B's existing `resolveAgentForRun` rather than inventing a second resolver. The matcher resolves agents via `resolveAgentForRun` at all 3 sites. One resolver, both paths (human-invoke + trigger-fire). This was the right call — a second resolver would have been the drift risk. |
| **`listWorkspaceDocuments` union (D4 surface) vs the comments mention-union (B8)** | **KEPT-SEPARATE — different projections, both correct** | Both union `__system` agents into a workspace's view, but for different consumers with different leak profiles: the LIST surface (`listWorkspaceDocuments`) returns full rows → needed D4 redaction (now applied at the loader). The MENTION surface (`comments.ts`) already uses a NARROW projection (`{id, slug, frontmatter}`, no body) returning only `{id, slug, allowedProjectIds}` → no leak, no redaction needed. Confirmed at the D4 ground-truth. They are not redundant; they serve distinct call sites. |

**Net: the dead layer does NOT linger.** The only retained artifact of the dropped design is a git tag (documentation). The live overlaps (`folio_api`/registry, the unified resolver, the two unions) are all deliberate single-source convergence, not duplication.

---

## Output 2 — Carried follow-ups disposition

| Follow-up | Origin | Disposition | Rationale |
|---|---|---|---|
| **OP-LIB-1** — the `frontmatter.published` library-agent visibility filter | Phase B (the union surfaces ALL `__system` agents) | **KEEP / DEFER** | Correctly NOT needed for D: D surfaces all `__system` agents to MEMBERS for curation (members are trusted curators — that is the whole point of the Settings entry). The cross-workspace INVOKE list is the B/C concern, and `__system` holds exactly ONE intended agent (the operator) in v1. The filter becomes load-bearing only when a NON-public `__system` agent is introduced. TODO markers in place at both union sites (`documents.ts`, `trigger-agent-field.tsx`). |
| **OP3-F1** — `folio_api` medium-tier config writes auto-apply with no dryRun default | Phase op-3 Task 5 review | **KEEP / DEFER to the approval-gate phase (3.x)** | A prompt-injected operator with a `config:write` token could hard-delete a table/view in one un-confirmed call. Mitigating: requires an owner/admin-equivalent token (the scope wall bounds blast radius); caller-ceiling intersection holds. Tightening destructive-medium-to-dryRun belongs WITH the pause-and-approve machinery (the `TODO(approval-gate)` in `folio-api-tool.ts`), not a standalone change. |
| **C3-CC-1** — the unattended MEDIUM floor doesn't cover the `claude-code` path | Phase C Task 3.5 review | **CLOSED-BY-DISABLE → superseded by CC-DISABLED-1** | The Phase C shake-out (security-sentinel) found cc bypassed BOTH the C3 floor (S-1) AND the agent∩caller scope ceiling (S-2). Stefan's call: hard-disable cc at the `runner.ts` preflight → `ccExecute` is unreachable from both run + resume paths → S-1/S-2 unreachable BY CONSTRUCTION. The MEDIUM-floor gap is no longer reachable, so C3-CC-1 is closed. **REVIVAL GATE documented** (do NOT re-enable cc until run-derived authority — `unattended` + caller-narrowed scopes — is threaded onto the `cc-run:` token so the `/mcp` re-entry enforces the floor + ceiling). |

No NEW follow-ups surfaced in Phase D. (The holistic review's two MINORs + one NIT were all FIXED in the `9eef89b` polish commit, not carried.)

---

## Output 3 — The wrong-model-reset lesson (process change confirmed)

**The defect:** the FIRST attempt at the operator (pre-A) built it as a per-workspace SEEDED BOT — `seedOperator`/`folio_system`/2-layer-memory baked in at bootstrap, with hidden memory documents. This was RESET 2026-06-02 (archived at `archive/phase-op-3-seeded-bot`) and rebuilt as an AGENT with the outside-agent's full caller-bounded reach + skills/.md reference docs, created ONCE. The reset kept the `folio_api` tool surface and dropped the seeding machinery.

**Already captured:** auto-memory `project_operator-is-an-agent-not-a-seeded-bot` records the decision + what was kept/dropped.

**The process gap it exposed — and the change that closed it:** the seeded-bot's failure mode was "10 green tasks that never ran the agent" — unit tests passed at every seam, but nothing exercised the agent ACTING end-to-end, so the un-runnable-at-create defect (and later the token-not-rebound-to-B defect) survived to the holistic / real-key gate. The process change:

- **`feedback_end-to-end-assertion-at-the-wiring-task`** (auto-memory, written this arc): capability/authority features need ONE act-in-target test AT THE WIRING TASK — not just seam tests. Phase B's holistic review caught 2 feature-nullifying merge-blockers precisely because per-task tests never ran a tool AS a library agent INTO B.
- **Applied in D:** the D4 task seeded a REAL prompt + system_prompt and asserted the leak was closed AND the own-agent body survived (an act-on-the-real-surface assertion, not a seam mock). The holistic review then added the curator-sees-own-body counter-pin. The "verify the agent can actually DO the thing before declaring the phase done" discipline is now reflex, not an afterthought.
- **Also reinforced this arc:** `feedback_state-consequences-and-dont-flatter` (state the consequence + tradeoff before asking Stefan to approve a design choice — he caught a cross-tenant leak + a self-contradiction in a design called "sound"); `feedback_redact-at-the-loader-not-the-handler` (D4 applied it: redaction at the loader's union point so every consumer inherits it, vs the per-handler leak that sprang 3×).

---

## What went well (arc-level)

- **No migration across four phases.** Every cross-workspace mechanism is frontmatter/JSON + a `where`-clause + a derived read. The "frontmatter is the schema" architecture invariant held under real pressure — a strong signal the original locked decision was right.
- **The holistic / whole-diff review earned its keep every phase.** B (2 merge-blockers), C (the guard truth-table), D (the transient-login + curator-body-pin). Per-task two-stage review never caught these; the end-of-feature whole-diff review did. (`feedback_holistic-review-catches-cross-task-bugs`.)
- **Plan-corrections at dispatch, not after.** A's M3 (slug immutability), B's PC-1/PC-2, C's C1 stale-premise — all caught at controller Step-2.5 ground-truthing and corrected BEFORE the implementer built the wrong thing. The pre-build whole-layer audit pre-empted B's PC-1 + C's PC-2 by name.
- **Security discipline scaled.** The one real D content-leak (D4) was found at ground-truth (not after the fact), fixed at the convergence point, and hand-verified by the controller per `feedback_review-subagents-swallow-verdict`.

## What to watch

- **claude-code is dead-by-design with a documented revival gate.** Anyone re-enabling it MUST thread run-derived authority onto the `cc-run:` token first, or reopen S-1/S-2 (CRITICAL). This is the single most important "do not regress" note from the arc.
- **The operator's blast radius is bounded by the scope wall, not by dryRun (yet).** OP3-F1 — destructive medium-tier `folio_api` writes auto-apply. Acceptable for v1 (owner/admin token required), but tighten it WITH the approval-gate phase.
- **The branch is 132 commits ahead of local `main` and `main` is local-only (unpushed).** The arc merges to main as ONE coherent operator. Origin push remains a separate user-side decision.

---

## Bottom line

The cross-workspace operator (A→D) is a coherent, well-tested, migration-free system. The dropped seeded-bot layer is gone (only a documentation tag remains); the live overlaps are deliberate single-source convergence, not duplication; the carried follow-ups are correctly dispositioned (one closed-by-disable, two deferred-with-rationale). The arc's defining lesson — exercise the capability end-to-end at the wiring task, don't trust green seams — is captured in memory and was applied in D. With Phase D built + reviewed + integration-green + 0 holistic blockers, the arc is merge-ready.
