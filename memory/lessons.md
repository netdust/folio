# Folio — Lessons

Self-improvement log per global CLAUDE.md workflow. After any user correction, append a rule that prevents the same mistake.

## Format

```
## YYYY-MM-DD — <short title>

**Mistake:** what I did wrong.
**Why:** root cause / faulty assumption.
**Rule:** the corrected behavior, written as a directive to future-me.
**Trigger:** when this rule kicks in (file pattern, task type, keywords).
```

## How this is used

- Read this file at session start when working in this project.
- Each entry should be specific enough to act on without re-explanation.
- If two entries conflict, the newer one wins — delete the older.
- Generic lessons that apply across all projects belong in `~/.claude/CLAUDE.md` instead.

---

## Entries

## 2026-05-26 — Audit `components/ui/` before claiming a primitive doesn't exist

**Mistake:** Started writing a `<Chip>` primitive for Phase 2.5 BUG-010 after telling the user "no other generic chip exists" — `grep -rln "rounded-pill"` would have shown me `apps/web/src/components/ui/chip.tsx` already existed. Caught it 30 seconds into Phase 1 of systematic-debugging by reading the audit grep output I'd just run. Would have shipped a second `Chip` next to the first if I hadn't caught it; that's exactly the design-system drift the user was complaining about.

**Why:** I framed the "audit" as a grep for chip-like CSS patterns and skimmed the results. The pre-existing `ui/chip.tsx` was in the grep output but I parsed it as "a Tailwind token reference" because I was looking for `rounded-full + bg-primary` shapes, not for an actual `Chip` export. Confirmation bias against the result.

**Rule:** Before writing ANY new primitive in `apps/web/src/components/ui/`, run TWO checks: (1) `ls apps/web/src/components/ui/` to see file names, and (2) `grep "export.*<Name>" apps/web/src/components/ui/*.tsx`. If a file with that name exists OR a matching export exists, READ THE FILE before deciding it doesn't fit — don't assume from the filename or a partial grep. If it doesn't fit cleanly, the right move is usually to rename/refactor the existing one, not to add a sibling with a similar name.

**Trigger:** Any sentence like "no other generic X exists in the codebase" or "I'll add a new primitive for X". Stop, run the two checks, READ the matches in full, then proceed.

## 2026-05-26 — Verify the test scenario, not the test data state

**Mistake:** During Phase 2.5 verification-before-completion, ran a live curl on the BUG-001 fix and saw HTTP 200 instead of the expected 403. Almost claimed "fix regressed." The fix was fine — the agent's `frontmatter.projects` had drifted during the shake-out (an earlier PATCH I'd run added the disallowed project to the allow-list). Iron Law'd correctly enough to investigate first, but only by luck did I check the agent's current state before re-debugging the middleware.

**Why:** Verification uses the CURRENT system state, not the state at the time of the original bug repro. Test data can drift between repros (manual PATCHes during sweep, prior test runs, schema migrations, hot-reload state). I assumed the curl call was running against the "as filed" scenario; it wasn't.

**Rule:** When a live curl re-sweep contradicts an existing test that's green, check the test data state BEFORE re-investigating the code. For Folio specifically: any verification curl that involves an agent's `frontmatter.projects` allow-list must first `GET /api/v1/w/<ws>/documents/<agent-slug>` and confirm the current allow-list matches the scenario the test asserts. If it drifted, either re-PATCH or create a fresh agent — never debug against drifted data.

**Trigger:** Any verification curl that returns the OPPOSITE of what the unit/integration suite asserts. The unit suite controls its own data via the test harness; live curls use whatever is in the dev DB. Drift is the most likely explanation, not a regression.

## 2026-05-26 — Design-system primitives: build when the third copy appears, not after

**Mistake:** Phase 2.5 second-sweep polish added THREE near-duplicate `Chip` definitions (`ProjectChip` in workspace-agents-page, `Chip` in projects-field, `Chip` in tools-field) over three commits across three sessions. Each was a 10-line component, justified locally ("this caller needs a tweak"). The user flagged it on the fourth-sweep manual review: "please make sure that we have a solid set of components that we reuse. no messy design system." Refactoring it out after the fact cost more than building the primitive on the first or second copy would have.

**Why:** Pattern-matching from individual call sites. Each chip felt like a "small local thing" because each call site had a slightly different visual requirement (one neutral, one primary-tinted, one monospaced). The fact that I was repeatedly writing `'rounded-full px-2 py-0.5 text-[11px]' +` should have triggered a "third copy = primitive" reflex.

**Rule:** When writing a component, ask: "have I written this shape (props + JSX) in the last 5 commits in this branch?" If yes → that's the primitive. If no → fine, ship the local version. If unsure → grep the codebase for the at-rest CSS triple I'm about to type (`rounded-`, `px-`, `text-[1`). Three matches with similar surrounding markup = build the primitive NOW, don't defer it. Acceptable to defer ONLY if the third call site is in a planning doc, not in code.

**Trigger:** Any `<span className={`rounded-* px-* …`}>` or `function NamedChip / NamedBadge / NamedTag` written from scratch inside a feature component. Compare against `components/ui/` first. If absent, build the primitive instead of yet another inline.

## 2026-05-26 — Phase shake-out: budget per-bug verification, not just per-suite

**Mistake:** During Phase 2.5 shake-out, the 4-minute Playwright cold-start dominated my verification cadence. I kept marking tasks "RESOLVED — re-sweep pending" and only ran the e2e at the end of multiple polish bundles (BUG-009/010/011/012 shared one e2e run). When BUG-002 itself failed on first re-run despite my fix, I had to wait another 4.5 minutes to verify the second attempt. Compressed by clustering, but inefficient and risky — if a polish bundle had broken the e2e, I'd have to bisect.

**Why:** Treated the e2e as "one regression check at the end" rather than "the test that proves the bug is dead." The shake-out skill's per-bug fix cadence is right: fix → re-sweep that bug → next. I bundled to save time and ended up with a longer feedback loop.

**Rule:** For Folio shake-outs, when a bug's verification needs Playwright (cold-start ~4.5 min), invoke `run_in_background: true` immediately after the fix lands, then continue working on the NEXT bug while the e2e runs. The bg notification fires when it completes; I switch back, check, then move on. Don't batch e2e runs to save cold-start cost — the cost is still paid once per session, batching just delays which bug's signal you get back. Unit tests still run synchronously between fixes (they're fast).

**Trigger:** Any "fix → e2e → next fix" sequence in shake-out. After the first commit, switch to "fix → bg-launch e2e → start next investigation → bg notification → check → next bg-launch."

## 2026-05-27 — Changing a server-side canonical form requires sweeping every UI consumer in the SAME commit

**Mistake:** F11 changed comment `frontmatter.author` from `agent:<slug>` to `agent:<id>` server-side. The fix landed with passing tests because (a) the migration was app-layer only — no UI code touched, (b) test fixtures still used the legacy slug form, so vitest stayed green. Three UI surfaces silently broke: `AuthorDisplay` rendered raw nanoids instead of slugs, `resolveIsAuthor` never matched (lost Edit/Delete affordances), and `ApprovalButtons.findResolution` never resolved approvals (because `target_agent` still stored slug while the plan author now stored id). The second code-review caught all three; the first review missed them because no test in CI exercised the new shape.

**Why:** A canonical-form change is a *protocol* change, not a service-layer change. Every consumer that pattern-matches on the prior shape is broken until updated. "I only edited services/comments.ts" was the trap — F11's blast radius was every file that ever called `author.startsWith('agent:')` or `.slice('agent:'.length)`.

**Rule:** Before changing a server-emitted canonical string (author identity, slug shape, id format), grep the WHOLE repo for the prior form's pattern (`'agent:'`, `startsWith('agent:')`, `slice('agent:'.length)`, etc.). Every match is a consumer that must be updated in the same commit. Update test fixtures to the NEW form so CI exercises the post-change reality. If consumers need extra context (workspace agent list), add a shared helper (`lib/author-ref.ts`) and route every site through it — never let two files independently decode the same string.

**Trigger:** Editing any function that returns a string with a `kind:value` shape (`agent:<id>`, `user:<id>`, `event:<key>`, `cache:<bucket>`), or changing what `value` contains. Bonus trigger: any commit message that mentions "canonical" or "migrate to <new form>." Step zero: `git grep -F "'<prefix>:'"` and budget the audit.

## 2026-05-27 — Zod `.default(...)` fills AFTER your route-layer guard runs

**Mistake:** F2's `assertAgentAllowListWidening` short-circuited when the create payload had no `projects` key — reasoning: "no widening requested." But the agent Zod schema declares `projects: z.array(z.string()).default(['*'])`. The default fires during `agentFrontmatterSchema.safeParse(...)` INSIDE `createDocument`, AFTER the guard ran. A restricted parent agent (`projects: ['projA']`) could mint a child by omitting the field — Zod filled `['*']` and the guard never saw it. G4 fixed it with an `op: 'create' | 'patch'` parameter so create treats missing as widening-to-`'*'`.

**Why:** Schema defaults are a SECOND mutation pass that runs at the service boundary, not at the route. Guards installed at the route level see the user's payload; guards installed at the service level see the post-default payload. A guard placed at the route boundary, gating a write that ALSO defaults fields downstream, is incomplete by construction.

**Rule:** When writing a security guard against a write payload, ask: does the receiver of this payload run any `.default(...)`, `.transform(...)`, or `.refine(...)` that could ADD a field this guard would reject? If yes, either: (a) move the guard to AFTER the schema parse (right altitude — guards in the service layer), or (b) make the guard treat "missing key" as the most permissive value the default could fill. Don't trust the input shape to match what hits the DB.

**Trigger:** Any `assert*` or `require*` guard placed in a route handler that calls a service whose input goes through Zod with `.default(...)`. Especially `frontmatter.projects`, `tools`, `requires_approval`, `max_delegation_depth` — anything where `agentFrontmatterSchema` fills a default.

## 2026-05-27 — Cron field normalization belongs to the SET, not the range endpoints

**Mistake:** F13 fixed dow=7 by normalizing the range endpoints in `parseField`: `if (a === 7) a = 0; if (b === 7) b = 0;`. Looked correct for `* * * * 7` (single value). Broke completely for ranges crossing the rollover: `5-7` became `start=5, end=0` → `start > end` → returned null; `0-7` became `start=0, end=0` → set `{0}` only (dropped Mon-Sat); `1-7` became `start=1, end=0` → null. The original code-review caught dow=7 single-value; the follow-up review caught dow=7 inside ranges.

**Why:** Normalizing at the endpoint level treats `7` as "literally 0" — but in cron `7` means "ALSO 0" inside a range, i.e. set-union semantics. The two cases (single value vs range) have different correct behaviors that can't be expressed with the same operation on the endpoint.

**Rule:** When normalizing input for a parser that uses ranges, apply the normalization to the EXPANDED SET, not to the endpoints. For dow=7: widen the domain to accept 7 during expansion, then post-process the result set to remap 7→0. Same pattern applies to any cron-like field with aliases (`SUN`, `MON`, `JAN`, etc.) — the alias substitution must happen per-value after expansion, not on the range bounds.

**Trigger:** Any field-parser that does `for (let i = start; i <= end; i += step)` AND has a value-aliasing rule (`7 → 0`, `JAN → 1`, etc.). Don't translate `start`/`end` — translate inside the loop.

## 2026-05-27 — bun-sqlite + drizzle doesn't roll back async throws — the SQL row persists

**Mistake:** F6 deferred `eventBus.publish` to post-commit via `txWithEvents` + a per-tx WeakMap queue, on the assumption that throwing inside `db.transaction(async tx => …)` would also roll back any `tx.insert()` calls. It doesn't — bun-sqlite + drizzle has a documented quirk where async throws don't propagate to the rollback. F6 ended up with an inverse phantom: the bus publish was suppressed (correct), but the events row PERSISTED (wrong). Two simultaneously-open clients diverged until reload — the live one missed the event, the reconnecting one got it via Last-Event-Id replay. G10 fixed it by having the catch issue a manual `DELETE FROM events WHERE id IN (...)`.

**Why:** "Transaction rollback handles cleanup" is a foundational mental model from every other SQL stack. With bun-sqlite + drizzle, it's not true for async callbacks. Synchronous throws roll back; awaited throws don't. The driver and ORM both look healthy in isolation — the bug is at their seam.

**Rule:** When using `db.transaction(async tx => …)` on bun-sqlite, never rely on rollback to clean up. If you await inside the callback AND any awaited statement can throw, the prior writes will persist. Either: (a) reify the rollback at the app layer (track inserted ids, delete on catch — what `txWithEvents` does now), or (b) use synchronous `db.transaction(tx => …)` with `tx.run()` for everything you care about rolling back. Document this constraint in any helper that wraps `db.transaction`.

**Trigger:** Any new `db.transaction(async (tx) => ...)` block where the inner code can throw after a row insert. Especially in event-emitting services where the inner write is paired with a side effect that callers depend on being all-or-nothing.

## 2026-05-27 — A canonical-form migration must drop the back-compat path, not preserve it

**Mistake:** F11 introduced a slug back-compat path in `assertAuthor` ("if id check fails, also match by current slug") so pre-F11 comments stayed editable. Looked safe. Was a privilege escalation: hard-delete an agent → slug freed → create new agent with same slug → new agent's token now matches OLD agent's pre-F11 comments via the back-compat branch. The second review caught it as G6. Fix was a migration (0008) that backfills every pre-F11 row to id-canonical AND dropping the back-compat path entirely.

**Why:** Back-compat paths for authorization are different from back-compat paths for data shape. A schema migration that preserves both shapes is fine. A guard that accepts both shapes is a permission bug if either shape can be reused/recycled. Slug back-compat seemed bounded by "agent must currently exist with that slug" — but in a hard-delete world that's a recyclable identifier.

**Rule:** When changing the canonical form of an identifier used in authorization (author, owner, parent, assignee), write the migration FIRST. Backfill every row to the new form. Then drop the back-compat path in the SAME commit. Don't ship a guard that accepts both shapes; rows that can't be backfilled (deleted parent agent, mid-rename) should become uneditable on purpose — that's the security property, not a UX regression to soften.

**Trigger:** Any change to an `assertAuthor` / `assertOwner` / `assertAssignee` style guard. Or any change to the canonical form of a string used in such a guard. Step zero: write the migration. Step one: drop back-compat. Step two: tests must use the new form.

## 2026-05-27 — Code-review caps are an output limit, not a defect limit

**Mistake:** Ran `/code-review` with the xhigh-effort prompt that returns ≤ 15 findings. 16 candidates were verified-confirmed; I cut #16 to stay under the cap and reported "15 findings." The user noticed the cap implicitly: "15 again, is that a limit?" The next review found that I had ALSO introduced new bugs in my fixes (F11's UI consumers — 3 of them — would all have been in #16-#18 if the cap allowed). The cap creates a false sense of "we got them all."

**Why:** The review pipeline is calibrated to a fixed output size for readability. The number of real defects in a code change is not fixed. A clean PR fits well under the cap; a PR that touches a canonical form or moves a guard has more.

**Rule:** When a code-review report says "15 findings," ALWAYS report verified-but-cut findings to the user with the verdict and a one-line summary, even if abbreviated. If the cap forced a cut, name that explicitly. The user should know what was deferred. Better: rank by severity, mention the count of verified findings, then truncate displayed detail — don't truncate the count.

**Trigger:** Running `/code-review` or any reviewer pipeline with a fixed output cap. If the verified-confirmed count exceeds the cap, the closing summary must say so (e.g., "18 verified, top 15 below, remainder: …"). Don't let a presentation limit hide a correctness signal.

## 2026-05-28 — When the plan was written before the convention, re-read it against the live codebase

**Mistake:** Phase 3's plan was authored 2026-05-26. Phase 2.6's reviewer pass (later in the same week) codified two Folio conventions: Zod schema consts use camelCase (every peer schema in `apps/server/src/lib/*-schema.ts` does), and frontmatter schemas always call `.strict()`. The Phase 3 A-4 plan reproduced the older convention verbatim — PascalCase consts, no `.strict()`. The implementer shipped it as written. Stage 2 code-review caught it, but at fix-up cost (commit `bc4b5ee`). Same root cause behind A-4b's installer-heredoc bug: the plan was written before the worktree-portability concern got attention.

**Why:** A plan is a snapshot of conventions at the time it was authored. Between writing and executing, the codebase keeps moving. Patterns codified in reviewer passes (BUG-* fixes, code-review findings) settle into the codebase but DON'T propagate backward into already-written plans. The plan is a stale rubric the moment a new pattern lands.

**Rule:** When the executing-skill cycle (`ntdst-execute-with-tests` → `subagent-driven-development`) opens a plan that's more than a few days old, the controller's pre-flight MUST include: for each new module/class/schema the plan introduces, grep peer files in the target directory (`apps/server/src/lib/*-schema.ts`, `apps/web/src/lib/api/*.ts`, etc) and verify the plan's example matches the live convention. If a peer file uses `.strict()`, the plan's schema must too; if peers are camelCase, the plan's must be too. Caught at pre-flight = zero fix-up cycles; caught at Stage 2 review = one extra commit per drift.

**Trigger:** Any `superpowers:executing-plans` or `superpowers:subagent-driven-development` invocation on a plan file with `mtime > 5 days`. Or any plan task that introduces a NEW file matching a pattern that other peer files in the codebase already follow. Look at the FIRST peer file for each pattern; if it disagrees with the plan, the live code wins.

## 2026-05-28 — When the plan rebuilds an existing table, audit columns against the live schema

**Mistake:** A-2's plan included a SQLite table-rebuild migration for `documents`. The plan's CREATE TABLE block declared `author_id` and `target_agent_id` as real columns — but in the live schema (post-migrations 0007/0008/0011) those names are JSON fields inside `frontmatter`, not real columns. The plan's `INSERT INTO documents_new SELECT * FROM documents;` would have failed at runtime because the column counts didn't match. The controller pre-flight caught it; if it hadn't, the subagent would have shipped a broken migration and the test would have failed cryptically (SQLite error about column count mismatch, not "your plan was wrong"). A-2's subagent ALSO surfaced a third drift mid-execution: the plan referenced `tables.title` when the real column is `tables.name`.

**Why:** SQLite's lack of `ALTER TABLE CHANGE CHECK` forces table-rebuild migrations to re-declare every column of the original table. Any column the plan misses or misnames silently breaks the data copy. The plan author was working from a mental model of the schema that drifted from the actual schema between when the plan was written and when it ran. Drizzle's generated schema files (`schema.ts`) are the source of truth, not the plan's CREATE TABLE.

**Rule:** Whenever a plan introduces a `CREATE TABLE <existing_table>_new (...)` rebuild block, the controller pre-flight MUST do two grep checks BEFORE dispatching:

1. Open `apps/server/src/db/schema.ts` and grep for the target table's column list (e.g. `documents` table). Compare line-by-line against the plan's CREATE TABLE. Any plan-listed column that doesn't appear in `schema.ts` is a phantom column → strike it from the plan SQL.
2. Open the most recent `documents_new`-style migration in `apps/server/src/db/migrations/` (e.g. `0007_phase_2_6_comments.sql`) and copy the column list verbatim. Cross-reference with `schema.ts`. That column list is the canonical one for the next rebuild migration.

Pre-flight catches in ~2 minutes what shipping the broken plan would cost ~20 minutes to debug + 1 corrective commit. ALSO: when the plan references column names from sibling tables (`tables.title` vs `tables.name`), grep `apps/server/src/db/schema.ts` for the actual definition and correct in the dispatch brief.

**Trigger:** Any plan task that contains the text `CREATE TABLE` and includes a column list, OR any plan SQL block that references columns of an existing table by name. Pre-flight is required even if the plan was written yesterday — schema drift can happen across a single sub-phase if a backfill migration ran in between.

## 2026-05-28 — Generated-script heredocs must be single-quoted

**Mistake:** A-4b's plan supplied an `install.sh` containing this block:

```bash
cat > "$HOOK_DST" <<EOF
#!/usr/bin/env bash
"$HOOK_SRC_DIR/pre-commit-migration-journal.sh"
EOF
```

The unquoted `<<EOF` heredoc tells bash to interpolate `$HOOK_SRC_DIR` AT INSTALLATION TIME, baking the installer's machine-absolute path into the generated `.git/hooks/pre-commit`. That makes the hook non-portable: another developer cloning the repo and running `./scripts/hooks/install.sh` would get a hook pointing at the FIRST developer's home directory. Caught by Stage 2 code-review (`13e5954`), fixed with `<<'EOF'` (single-quoted, no interpolation) + a runtime `$(git rev-parse --show-toplevel)` lookup inside the generated script.

**Why:** Bash heredoc quoting has two modes that look almost identical but behave opposite. `<<EOF` interpolates variables (and command substitutions, backticks, etc.) before writing the body to the destination. `<<'EOF'` writes the body literally, deferring all interpolation to whenever the generated script runs. For ANY generated artifact that should be portable across machines, runtimes, or working trees, the literal mode is correct — but the unquoted form is more common in casual examples, so it sneaks into plans.

**Rule:** Any plan that includes a heredoc inside a script-generator (installer, scaffolder, codegen helper) MUST use single-quoted heredocs (`<<'EOF'`) unless there is a specific reason to interpolate at generation time. If interpolation IS needed, the plan must justify why in a comment above the heredoc. The default is to defer. Also: prefer runtime lookups (`$(git rev-parse --show-toplevel)`, `${BASH_SOURCE[0]}`, `$(dirname ...)`) over baked absolute paths.

**Trigger:** Any plan or commit that contains a heredoc inside a shell script that writes to another shell script (hooks, helpers, generated commands, dotfile setup). Grep the plan SQL/bash blocks for `<<EOF` (without quotes) and flag every occurrence. The fix is a 4-character change (`<<'EOF'`) but catching it pre-execution avoids a portability bug that only surfaces when a second developer/machine touches the repo.


## 2026-05-28 — Plans for features touching user-controlled URLs require a Threat model section before task breakdown

**Mistake:** Folio Phase 3 Sub-phase B's plan had functional requirements ("BYOK is libsodium-encrypted") but no threat model. The plan author treated "BYOK + libsodium" as covering security — it didn't. It covered storage-at-rest but not the URL + outbound-request + cross-route consistency surface. Seven tasks of provider + UI code shipped. Two rounds of `/code-review` at `--effort=medium` surfaced ~30 security-class findings across the surface (SSRF + IPv4-mapped IPv6 bypass, credential exfiltration via attacker-controlled baseUrl, persistence-path validation gap, Ollama localhost default, error-message leaks, JSON.parse stream aborts). Critical-class items kept emerging in round 2 that round 1 missed.

**Why:** Without an explicit threat model, every `/code-review` round independently re-discovers the attack surface from scratch. Each round catches a different subset. The cap-of-15 on medium-effort reviews can hide critical findings below the threshold across multiple rounds. Convergence is slow and probabilistic. The "BYOK + encrypted" language is a property statement, not a security spec — the implementer built what the plan asked for, and the plan didn't ask for the right things.

**Rule:** When writing a plan that touches user-controlled URLs (webhooks, BYOK provider URLs, OAuth redirects, embed URLs, CMS bridge endpoints), auth/session/token surfaces (new auth methods, scope additions, multi-tenancy boundaries), untrusted parsing (frontmatter from external sources, AI tool-call args, webhook payloads, file uploads), BYOK credentials, file handling, or any surface where the server makes outbound requests to user-supplied URLs — invoke `netdust-core:threat-modeling` alongside `superpowers:writing-plans`. The threat-modeling skill produces a `## Threat model` section the plan embeds inline, BEFORE task breakdown, with named assets, named attacks, named mitigations, and explicit deferrals. `/code-review` then checks against the named mitigations instead of free-form bug hunting — converges in one round.

**Trigger:** Any plan whose feature description includes the words webhook, URL, baseUrl, redirect, OAuth, upload, parse, untrusted, third-party, BYOK, credential, key, token (in auth context), workspace boundary, cross-workspace, scope-check, or any surface where the server makes outbound HTTP requests to addresses the user supplied. Also: any feature that adds a new public-ish endpoint. Worked example: `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` section `## Threat model` — written retrospectively at the cost of 2 rounds of review-fix iteration. Future plans should write it proactively.

## 2026-05-28 — Convergence signal for a threat model: anti-regression scan returns `[]`

**Mistake-prevention pattern, not a mistake.** Sub-phase B went through 7 rounds of `/code-review` (rounds 1-6 medium, round 7 ultra-effort 9-angle local). Findings per round: 15, 15, 9, 9, 11, 7, 15. The threat-model section was iteratively enriched after rounds 2, 4, 5, 6, 7. Round 7's ultra-effort review dispatched an anti-regression angle that walked all ~50 prior findings and confirmed each was still fixed in the current code. That anti-regression scan returned `[]` — zero regressions across 7 rounds of fix-on-fix.

**Why that's the signal:** when a threat model has matured from "checklist" (a list of routes) to "spec" (a rule the codebase enforces), new review rounds find genuinely-new attack classes, not asymmetry leftovers from the previous round's incomplete fixes. Round 7's 15 findings were: 2 new attack classes on adjacent surfaces (HTTP twin of MCP agent-CRUD; PII leak via /members), 1 Sub-phase C data-contract gap (agent_run schema missing slots for refusal/pause_turn), 5 provider long-tail bugs, 4 defense-in-depth gaps, 3 hygiene items. None were "round N missed asymmetric route Y" — that pattern was extinct.

**Rule:** when running `/code-review` in iterative rounds on a security-rich surface, dispatch an anti-regression angle alongside the discovery angles. The anti-regression angle re-verifies every prior finding's fix is still in place. When that angle returns `[]`, you have evidence that the threat model is now a spec, not a checklist. Stop iterating; the remaining findings are new surface, not leftover gaps.

**Trigger:** ≥3 rounds of `/code-review` on the same surface, OR explicit user request for ultra-effort. The anti-regression angle is angle B' in the ultra pattern. Cost: one more subagent dispatch, ~3 minutes wall-clock.

## 2026-05-28 — Implementation:review-cycle time ratio benchmark

**Reference data, not a rule.** Sub-phase B benchmark: 42 min B-1..B-7 implementation, 5h27m review-fix cycles. Ratio 1:7.7. Sub-phase A benchmark: ~50 min total, no review cycles (clean threat-model-free plan). Sub-phase B's high ratio is the cost of NOT writing the threat model at plan-time.

**Hypothesis to test on Sub-phase C:** with the threat model carried forward from B + the new pre-dispatch security check (per Sub-phase B retro recommendation §1), the ratio should drop closer to 1:2 or 1:3. If Sub-phase C also runs 1:7+, the discipline isn't holding. Re-measure at Sub-phase C close.

## 2026-05-28 — Sub-phase C.1 implementation:review ratio (hypothesis test result)

**Result of the hypothesis test from the Sub-phase B entry above.** Sub-phase C.1 ratio: ~2h primary implementation : ~3h review work (counting bundles 1-8 across freeform review + review-of-review). Ratio ~1:1.5. The hypothesis ("dropping closer to 1:2 or 1:3 with the threat model carried forward") was wrong direction but right magnitude — review-fix work was LESS than 1:7, but a second review layer (review-of-review) added unanticipated time.

**New benchmark**: phase-3 sub-phases with services-layer cross-cutting concerns are running ~1:1.5 to 1:2. The 1:7 of Sub-phase B was a threat-model-write-time tax, not a permanent regime. Future sub-phases should plan for 1:2 review time as baseline.

## 2026-05-28 — `tx.all<T>` with RETURNING * is a runtime type lie

**Mistake found in C-3, fixed in F12 (bundle 1).** When Drizzle's bun-sqlite query helper is called via raw SQL with `tx.all<Document>(sql\`UPDATE ... RETURNING *\`)`, the generic type `T` does NOT match the runtime shape. `RETURNING *` yields raw SQLite columns in snake_case (`workspace_id`, `parent_id`, `frontmatter`), but `Document = typeof documents.$inferSelect` is camelCase (`workspaceId`, `parentId`). Only `.id` reads happen to work (no case difference).

**Why it slips past tsc:** the cast is a generic argument, not a runtime check. TypeScript trusts the annotation; the raw row at runtime has snake_case keys; any `.workspaceId` access reads `undefined`.

**Rule:**
- If you read more than `.id` off a `tx.all<T>(sql\`...RETURNING *\`)` row, either (a) restrict `T` to a snake_case shape literal matching what `RETURNING *` produces, or (b) convert RETURNING to a narrow column list with camelCase aliases (`RETURNING id, workspace_id AS workspaceId, ...`).
- The pattern `tx.all<{ id: string }>(sql\`UPDATE ... RETURNING id\`)` is safe — only reads `.id`, only returns `id`.
- If the function is supposed to return a typed `Document`, follow the RETURNING with a typed `tx.query.documents.findFirst(...)` re-read. That's the canonical shape (used by `claimNextPlanningRun`).

**Trigger:** any new `tx.all<>(sql\`...\`)` call with `RETURNING *` OR with a `T` that's a Drizzle `$inferSelect` type. Audit at write time AND at every code review.

## 2026-05-28 — Cross-cutting changes need a sibling-site audit at plan-write time

**Meta-pattern from Sub-phase C.1 reviews.** Across two layers of code-review (freeform 9-angle, then review-of-review 5-angle), every primary fix that touched a CROSS-CUTTING concern had 1-2 SIBLING SITES that needed the SAME change but were missed by the primary fix:

- C-1 widened `DocumentType` to include `'agent_run'` on the server. Bundle 4 hardened agent_run writes (5 route guards). Bundle 6 hardened agent_run reads (4 more route guards) AND FE+shared union widening (2 more files). Same root change rippled to 11+ sites.
- F6 in bundle 1 changed `json_extract(...status)` → `status` column predicate in 2 places (claim + recovery). Bundle 6 found `countPendingPlanning` was the 3rd site, also needed the change.
- F4 in bundle 3 fixed `workspace.provider.*` event scope to `projectId: null`. Audit of similar workspace-wide events (`runs_table.lazy_seeded`, etc.) not done — open question.
- F5 in bundle 3 tightened SQL filter. Bundle 6 (R4) added the recency-floor that should have shipped together.

**Rule:** when a plan task touches any of these cross-cutting concerns, the task body includes a `## Sibling-site audit` block enumerating the surface to check:

- TypeScript union / enum / discriminator: audit FE union + shared union/enum + every consumer's switch/narrow.
- SQL predicate on a JSON-extract → column change: audit ALL read sites of the same field (count, filter, sort).
- Event scope (projectId, workspaceId, documentId): audit every emitter of similar-class events.
- Cross-route guard (writes hardened → audit reads; reads hardened → audit writes).
- Closed-enum literal: audit every site that writes/compares the literal.

The audit lives in the plan, gets verified by the implementer, reviewed at code-review time. Per-task cost: 5-10 minutes at plan-write; net savings ~1-2 review-fix bundles per sub-phase.

## 2026-05-29 — ground-truth the dependency surface before expanding a runner/integration plan (Sub-phase C.2)

A plan expanded as an outline before its dependency surface was read will drift. C.2's plan assumed a Vercel-AI-SDK-shaped provider — `continueWithToolResult(streamHandle, ...)` continuation + an injectable `AbortController` — that the actual Sub-phase B layer (`lib/ai/provider.ts`) does NOT have: `stream(opts)` is one-shot, no continuation, no abort param; the tool round-trip is via message history (re-call `stream()` with appended `{role:'assistant', tool_calls}` + `{role:'tool', tool_use_id, content}`). It also named `error_reason` enum members that don't exist, an `actor:'system:runner'` that violates the `documents.updated_by`→`users.id` FK, and a `kind=cancel` comment kind that doesn't exist.

All three C.2 tasks shipped DIVERGED_DEFECT — but every drift was caught at controller PRE-FLIGHT (reading `provider.ts`/`agent-runs.ts`/`comments.ts`/`agent-run-schema.ts` against the plan) and corrected in the plan BEFORE/at dispatch (3 inline plan-corrections). Rule: when expanding/executing a plan that integrates against another sub-phase's code, READ that code's actual exported signatures + types + enums first — the plan's prose is a hypothesis, the source is truth. Reinforces [[plan-server-source-audit]]. Third sub-phase (A, C.1, C.2) to surface plan-freshness drift → promoted to a HUMAN_DECISION follow-up (plan-freshness check as a writing-plans skill rule).

## 2026-05-29 — `bun run db:generate` contaminates migrations on this project (Sub-phase C.3)

This project maintains HAND-WRITTEN raw migrations from 0007 onward with no live Drizzle snapshot. Running `bun run db:generate` re-emits contaminated DDL — for C-10b's `reactor_cursors` table it also re-emitted `events.seq`, the seq indexes, and `workspaces.provider_health` (everything the drifted snapshot thinks is "missing"). Rule: to add a migration, HAND-WRITE the next `00NN_<name>.sql` (one `CREATE TABLE`, tab-indented, backtick-quoted identifiers, matching the 0007+ style) AND hand-add the `meta/_journal.json` entry (idx/version/when/tag). Do NOT trust `db:generate`'s output — discard it. The A-4b pre-commit hook still verifies the `.sql`↔journal pairing. Reinforces [[drizzle-migration-journal]]. C.3 caught this at the implementer (correctly recovered); the plan said "run db:generate" — corrected at `21dd2c0`.

## 2026-05-29 — plan-freshness ground-truthing is now a skill rule (Sub-phase C.3 gate)

THIRD consecutive sub-phase (A, C.2, C.3) to surface plan-vs-source drift caught only by the controller reading live signatures before dispatch (C.3: `recoverOrphanRuns({staleThresholdMs})` vs the plan's `recoverOrphanRuns(db)`, plus the db:generate trap above). The standing HUMAN_DECISION was answered at the C.3 gate: PROMOTED to a skill rule — `netdust-core:ntdst-execute-with-tests` now has **Step 2.5 (plan-freshness gate)**, a per-task controller obligation to ground-truth each task's named dependencies (signatures/enums/scopes/columns/payloads) against live source after the upstream skill loads, before writing that task's dispatch. The edit is live in the plugin cache; the netdust-core plugin SOURCE repo needs the same edit to survive a plugin re-sync. This [[plan-server-source-audit]] discipline is no longer honor-system.

## 2026-05-30 — ground-truth "reuse X for new data-type Y" premises at SPEC/PLAN-write, not task-dispatch (Sub-phase E)

Step 2.5 (plan-freshness) catches dependency-signature drift at TASK dispatch — but Sub-phase E showed a class of drift that surfaces TWO documents earlier and costs far more: a wrong *architectural premise*. The E spec, the mega-plan, AND the readiness handoff all asserted "the runs table renders through the existing `TableView`." One `grep` of `routes/documents.ts` falsifies it: `agent_run` rows are deliberately walled off from the generic `/documents` endpoint (`AGENT_RUN_REQUIRES_RUNNER_PATH` — they carry system_prompt/tokens) and are readable ONLY via `/runs`; plus the web UI has no multi-table nav and `TableView` doesn't type-scope. The premise survived plan-write + plan-expansion + handoff and was only caught when E-3/E-4's Step-2.5 ground-truthing actually read the endpoint at dispatch — forcing a mid-execution STOP → re-brainstorm → re-plan. Rule: when a spec/plan's core approach is "reuse existing infrastructure X (component / endpoint / table) for new data-type Y," ground-truth that X actually ACCEPTS Y (read X's source) DURING writing-plans/brainstorming self-review — before the plan ships — not deferred to task dispatch. Step 2.5 is the task-level safety net; this is the spec-level extension that prevents building two plan-documents on a false foundation. The data layer (E-1/E-2/E-2b) survived the redesign untouched because it was built on `/runs` (the real source), not the premise. See [[project_runs-not-a-tableview]] (auto-memory, written mid-execution) + [[plan-server-source-audit]].

## 2026-05-30 — invoke systematic-debugging PER BUG via the Skill tool, not just "in spirit" (Phase 3 Sub-phase F shake-out)

The shake-out FIX phase mandates `Skill("superpowers:systematic-debugging")` for EVERY bug — "no exceptions, not even obvious ones" — and "ONE bug at a time." During F's fix phase I invoked the skill formally for C1 (the merge-blocker) but then worked I1/I2/I3 through the skill's four phases *in reasoning only* (root-cause → pattern → hypothesis → failing-test-first → verify) without re-invoking the tool, and bundled I2+I3 into one cycle. Outcomes were sound (each carried a genuine RED→GREEN proof; 0 fail; tsc clean), but the process drifted: the per-bug skill invocation is what makes the discipline auditable from the transcript (same class as the testing-workflow addendum lesson). The pull toward "I already see the fix, the phases are obvious here" is exactly the rationalization the skill's red-flags table names. Rule: in a shake-out (or any multi-bug fix session), invoke the debugging skill once per bug via the Skill tool, fix one bug per cycle, and re-sweep between — even when the root cause is already established by the sweep. The sweep finding a bug ≠ the fix being authorized without the per-bug gate. User accepted the 4 already-verified F fixes but directed the skill be invoked properly for all remaining work.

## 2026-06-01 — derived local state must not re-seed from a value React Query toggles (unified-save)

Building buffered draft-and-save for document slideovers, `useDocumentDraft` held a `{body, frontmatter}` buffer seeded from the loaded `doc`. The slideover parent passed `doc ?? placeholder` (an empty fallback while loading). EVERY in-place re-seed strategy I tried oscillated and blanked the editor + made it perpetually dirty: render-phase `setDraft` keyed on `doc.id+updatedAt`, then an `id!==''`-guarded variant, then a `useEffect` re-seed. Root cause (found only by adding a render-time `console.log` of `doc`/`draft` and reading the live oscillation — `docFmKeys: 9 → 0 → 0`): React Query toggles the `doc` reference to `undefined` on refetch (staleTime expiry, window-focus, post-mutation invalidation), so `doc ?? placeholder` flips to the empty placeholder mid-session and the re-seed stomps the user's buffer. This also caused the agent-save 422 (echoing a stale/empty frontmatter that includes server-managed `api_token_id`).

Rules:
1. **Don't re-seed derived local state from a prop whose identity a data layer toggles.** TanStack Query refetches flip `data` to `undefined` and back constantly. Any "re-seed when the prop changes" (render-phase OR effect) races those toggles. The robust pattern is **seed-once + remount via React `key`**: the OWNER renders the state-holding component `key={`${id}:${version}`}`, mounted only when real data exists; a genuine change (switch / save-bump) changes the key → clean remount → fresh `useState` seed. No mid-render setState, no effect lag, no oscillation.
2. **When a UI bug only reproduces live (not in jsdom tests), instrument the actual render and read the runtime values** before theorizing — `Object.toString`/key-counts logged per render exposed the oscillation in one repro that four rounds of source-reading missed. Unit tests passed throughout because jsdom doesn't reproduce React Query's refetch toggling. Reinforces [[measure-dom-for-layout-bugs]] generalized to state bugs.
3. **Round-tripping a server object back to its own PATCH endpoint fails if the server injects managed fields.** Agent/trigger frontmatter carries server-owned keys (`api_token_id`, `last_fired_at`, …) under `.strict()` schemas. A whole-object buffered save echoes them → 422. Strip server-managed keys (one shared `SERVER_MANAGED_FRONTMATTER_KEYS` list) before diffing/sending. The old per-key auto-save never hit this because it only sent the touched field. Reinforces [[mock-the-wire-not-the-response]].
4. After 3+ fixes fail on the SAME mechanism, STOP and question the architecture (the debugging skill's Phase 4.5) — I should have abandoned in-place re-seed after attempt 2 instead of 3.

---

## 2026-06-03 — Security-boundary edits need threat-modeling even with no plan

**Context:** "set up ollama" required editing `validatePublicUrl` (the SSRF guard) to add a loopback escape hatch. The edit was sound, but `netdust-core:threat-modeling` never fired — its CLAUDE.md trigger is keyed to *writing a plan*, and this was a direct ad-hoc task on `main`.

**Rule:** When a task — planned OR ad-hoc — edits a named security-boundary file (`apps/server/src/lib/url-allow-list.ts`, auth/session/token surfaces, `apps/server/src/lib/crypto.ts`), invoke `netdust-core:threat-modeling` on the diff before committing, even absent a plan. The guard held this time by reading-the-mitigations luck, not by a harness gate.

**Also (product, not discipline):** "Add a provider" should be trivial but isn't — the Settings → AI UI rejects keyless providers (Save disabled without an apiKey) and loopback base_urls (hardcoded "rejected" help text), so the only way to add Ollama was a direct DB seed. See [[project_provider-setup-gap]] and tasks/retro-follow-ups.md.

## 2026-06-06 — Reseed FIRST when a bug might be data-vs-code; verify the real shape before fixing

Debugging the operator's `agent_missing`: I twice built fixes on UNVERIFIED assumptions about the operator's token shape (reverted eb981bf gated on isOperatorToken — but the operator token's createdBy is the USER, not null). The unit test "passed" only because I constructed an unrealistic token (test-world≠real-world). 
- **Lesson 1:** when a live bug could be data-corruption OR code, RESEED to a clean state FIRST — it removes the variable in one move. The 57 duplicate operator rows were a total red herring; the bug reproduced cleanly on a fresh DB, proving it was code. I wasted effort theorizing about the corruption.
- **Lesson 2:** before writing a fix that gates on a token/identity shape, CAPTURE the real shape (instrument the failure point, or read the mint code to ground truth) — do NOT infer it. The fix's discriminant must match production, not a plausible-looking test fixture.
- **Lesson 3:** when a fix touches a value used for TWO things (here serviceActor's id = FK column AND event actor), check BOTH consumers before changing it. The naive fix (actor→real user) would have silently broken the agent-chain autonomy gate. The split (eventActor) preserved it.

---

## 2026-06-08 — Skipped the harness on a multi-step fix that crept up from a question

A session that began as a casual question ("can we run Kimi locally?") evolved through
wire-it-in → it's-broken → harden-it → commit, and I NEVER loaded
`netdust-core:harnessed-development`. I reached for the single best-fit skill at each step
(`systematic-debugging`, `test-effectiveness`) but never stepped back to see the whole arc had
become non-trivial security-adjacent work the harness should have wrapped.

**The concrete miss:** the diff touched provider adapters (untrusted streamed parsing), error
sanitization (no-leak contract), and an IPv6/baseURL change (SSRF-adjacent). Those are the
EXACT named triggers for CLAUDE.md's threat-modeling + architecture-invariants gates — which the
harness fires automatically. I skipped both. Testing discipline was strong; the two SECURITY
gates were the gap.

- **Lesson 1:** re-evaluate harness need at each turn, not just at message #1. When an ad-hoc
  thread accretes into multi-file work on a security boundary, STOP and load
  `harnessed-development` — even mid-session, even if earlier steps were legitimately ad-hoc.
- **Lesson 2:** the trigger isn't only the user saying "build/ship/do this properly." It's also
  the SURFACE: any diff to auth/token/URL-allow-list/crypto/provider-parsing/error-sanitization
  fires the threat-model gate on its own (CLAUDE.md §2). Check the surface, not just the verb.
- **Lesson 3:** "I loaded a skill" ≠ "I ran the harness." Single skills cover single stages;
  the harness sequences ALL gates so none gets silently skipped. Don't let good local discipline
  mask a skipped global gate.

---

## 2026-06-08 — A fix-round "done" can introduce a worse bug than it fixed; gap-hunt before declaring victory

After fixing /code-review findings on the provider streaming seam, I declared the round done.
A follow-up gap-hunt (parallel deep-dive agents over the whole provider→runner boundary) found
that my OWN altitude fix had introduced a SAFETY regression: the gate
`collectedToolCalls.length > 0 && doneReason !== 'max_tokens'` was a blacklist excluding only
max_tokens, so a 'refusal' carrying a tool call now EXECUTED the tool (a refused action acting).
Plus it silently completed truncated (max_tokens) tool turns as success.

- **Lesson 1:** when a fix changes a GATE/guard condition, enumerate EVERY value the guarded
  variable can take and ask "is the new behavior correct for each?" — not just the one case you
  were fixing. doneReason has 5 values (stop/tool_use/max_tokens/refusal/pause_turn + unknown);
  my fix only reasoned about stop vs max_tokens and got refusal/pause_turn wrong.
- **Lesson 2:** prefer a WHITELIST (fail-closed) over a blacklist for safety-relevant gates. "Run
  tools only on stop|tool_use" is safe against a new/unknown reason; "run unless max_tokens" is
  fail-open — any reason I didn't think of executes the tool.
- **Lesson 3:** a seam that has produced bugs in N consecutive rounds is SYSTEMATICALLY
  under-tested, not unlucky. Run a dedicated gap-hunt (adversarial agents per gap class) over the
  WHOLE seam before calling it done — it found 6 more pre-existing bugs (FIX#2 defeated by
  default-'stop', budget-meter-zero, empty tool-call id, ollama deref, anthropic server_tool_use)
  filed at tasks/followup-provider-seam-hardening.md.
