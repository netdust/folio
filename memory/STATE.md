# Folio — STATE

_**🎉 Operator-Agent PHASE 1 (caller-identity delegation) MERGED to local `main` (`c32daa5`, `--no-ff`) 2026-06-01; feature branch `phase-op-1/caller-delegation` deleted.** First slice of the built-in Folio operator agent (the "OS for Folio" — spec `docs/superpowers/specs/2026-06-01-builtin-folio-operator-agent-design.md`). **An agent run now carries the CALLER's authority — an agent can never exceed the human who started it** (`effective = agent ∩ caller` for scopes AND projects, fail-closed). Built TDD + subagent-driven (8 tasks + 4 plan-corrections + 2 review-fix tasks), two-stage-reviewed per task, hardened by `/code-review high` (10 findings — the green two-stage review MISSED a project-clamp LEAK through 3 enumeration tools + claude-code; `/code-review` caught it; fixed at the right altitude + re-reviewed FIX SOUND), `/integration` + `/shakeout` clean (boot/composed-loop/migration/ceiling all green live). **What landed:** `caller_scopes`/`caller_project_ids` on run frontmatter (server-derived from membership role via `roleToScopes`: owner/admin→all 4 scopes, member→read+write; NEVER client-supplied); SCOPE ceiling central in `executeTool` (double-membership, fail-closed); PROJECT ceiling central via `loadContext` narrowing `token.projectIds` ONCE (`/code-review`-forced altitude — do NOT re-introduce per-call-site clamping); resume inherits original snapshot (D6); non-member owner fails loud (`RUN_OWNER_NOT_A_MEMBER` 403); migration `0020` backfills history fail-closed. Threat model D1–D10 inline in the plan. **Handoff for Phases 2 & 3: `docs/superpowers/handoffs/2026-06-01-operator-agent-phase-2-3-readiness.md`** (Phase 2 = token-scoped write surface + `dryRun`; Phase 3 = `folio_api` + skill + 2-layer memory + seeded agent; carried obligations OP1-F7/F8/F9 + the claude-code SCOPE-bypass gap in `tasks/retro-follow-ups.md`). Gates at merge: server 1092/0, shared 63/0, web 725/8-skip/0, tsc clean ×3. `main` still LOCAL-ONLY (~784 ahead of origin, unpushed). **Next: Phase 2 (API completion) per the handoff — `writing-plans` + `threat-modeling`.**_

_**Health audit + fixes 2026-06-01 (on `main`, post-merge).** Whole-codebase architectural health audit (architecture + cleanliness + performance, 3 parallel auditors). Verdict: **Healthy-with-debt** — churn didn't rot it; locked decisions hold; claude-code left no scar. **FIXED:** C1 — `system_prompt` leaked across ALL run-read surfaces (HTTP + MCP get_run/retry_run/cancel_run + MCP list_runs); the earlier BUG-2 fix only covered HTTP. Root-caused to redaction-per-handler + a `lib→routes` import inversion; fixed at the shared loader (`f3e9575`) + the list path (`f016315`), guard tests both. C2 — `listRuns` now SQL-`LIMIT`ed not fetch-all-slice-JS (`f3e9575`). O5 — TableView relation queries gated behind has-relation-column (`2022bc6`). Gates: server 1055/0, shared 63/0, web 705/8-skip/0, tsc clean ×3. **Tracked debt (logged, NOT fixed) → `tasks/health-audit-debt-2026-06-01.md`:** lib→routes inversion (D1, the C1 root), agent-runs.ts god-file split (D2), triplicated assignee-emit (D3), slug/provider/FieldType/orphan-export consolidations (D4), backlink-scan index ceiling (S1, deferred), json_extract sort indexes (S2, deferred). **Dormant-by-decision (keep, don't delete):** parked manual board-sort chain (~250 LOC) + `board_position` undocumented-column exception. `main` still LOCAL-ONLY (unpushed)._

_**MERGED to `main` (`1af18eb`, `--no-ff`) 2026-06-01 — `phase-3.x/agents-page` (agent management/interaction split + 10 code-review fixes + 2 shake-out fixes); feature branch deleted.** `main` is LOCAL-ONLY (~635 ahead of origin, not pushed). Gates on merged main: server 1052/0-fail, shared 63/0-fail, web 705/8-skip/0-fail, tsc clean ×3 (run server/shared from their app dirs — root cwd fakes the ~650-fail cascade). **What landed:** (1) Agent MANAGEMENT moved to a combined `/w/:wslug/agents` page with **Agents | Triggers** tabs (`?tab=`); `/triggers` redirects there (forwarding `?wdoc=`); editing via the existing `?wdoc=` slideover; the cockpit panel is now INTERACTION-only (`AgentPanelScreen` dropped `'agents'`; `agent-panel/agent-list.tsx` deleted → logic in `views/workspace-agents-tab.tsx`); switcher exposes two destinations: "Agents & Triggers" (page) + "Work with an agent" (panel). Uses shared `Tabs` + `Chip` primitives. (2) **10 code-review fixes** (from /code-review high on the prior relation+fixes range): agent superRefine re-checked on PATCH; placeholder-slug re-slug now provenance-gated (title still 'Untitled', not just slug-shape); `model:''`/`null` clears the key + schema coerces both→undefined; CC executor reads stderr (surfaced in detail + drains both pipes); `runAgentResume` branches to ccExecute for claude-code; untrusted CC context wrapped in a BEGIN/END "treat as data" fence (bounded mitigation, NOT a full injection solve); `setRunBody` emits `agent.run.transcript` (honors every-write-emits-event); redirect forwards `wdoc`; Tabs/Chip reuse. (3) **2 shake-out fixes:** BUG-1 — Activity feed had NO history (SSE-live-tail only) → added workspace `GET /w/:wslug/runs` (listRuns by workspaceId, recency, capped, allow-list-gated) + `useWorkspaceRuns` + `useActivityFeed` seeds history then live-tails; BUG-2 (security) — `/runs` list leaked `frontmatter.system_prompt` to members (pre-existing on project list, widened by BUG-1) → `redactRunForApi` strips it from all 3 `/runs` response paths (service unchanged; verified live absent). Specs/plan: `docs/superpowers/{specs,plans}/2026-05-31-agent-management-vs-interaction*`; manifest `tasks/shake-out-manifest-agents-page.md`. **DEFERRED (not built):** runs-view / result-rendering polish ("not clear what I was looking at"); claude-code is functional but deprioritized + slow (~8s CLI floor). **Pending: Stefan's optional Track-B visual QA + eventual origin push.** Supersedes the prior board-view/relation merge entry below as the main tip._

_**MERGED to `main` (`9556657`, `--no-ff`) 2026-05-31 — `phase-3.x/board-view` (board view grouping/ordering + QA + relation fields & backlinks) is now on main; feature branch deleted.** Stefan chose merge-locally after the relation-fields shake-out (Track A clean / 0 bugs; Track B = a manual browser checklist in `tasks/shake-out-manifest-relation-fields.md`, NOT yet visually confirmed by Stefan — slideover relation editing + Linked-from panel are covered by green unit tests + proven-live backlink data, but not eyeballed in a real browser). `main` is LOCAL-ONLY (~575+ ahead of origin, not pushed). Gates on merged main: server 1011/0-fail, shared 63/0-fail, web 698/8-skip/0-fail, tsc clean ×3. ⚠️ Run server tests from `apps/server` (root cwd triggers the ~650-fail module-init cascade). All "board-view pending QA / NOT merged" entries below are SUPERSEDED by this merge._

_**Relation fields + backlinks BUILT on `phase-3.x/board-view` 2026-05-31 (rides on the board-view branch per Stefan; NOT merged).** 8-task TDD plan, subagent-driven + final whole-diff review. Closes the #1 gap from an Airtable-template analysis (linked records — universal to all 7 sampled templates). Commits `b3fb951..041e68f` (incl. `041e68f` Finding-9 fix). **What shipped:** a `relation` field type = the pinned/targeted upgrade of `document_ref`; SAME frontmatter shape `"[[slug]]"` (single) / `["[[slug]]",…]` (multi) → NO data migration, opt-in per field. Target (`wiki` | `table:<id>`) + cardinality (`single`|`multi`) in `fields.options` (`options[0]`,`options[1]`); validated in `routes/fields.ts::validateOptions` (POST+PATCH). **Backlinks = query-time only** (`services/backlinks.ts::findBacklinks`, SQLite `json_each` matching the `[[slug]]` token as a string value OR array element; `json_valid` guards inner scan; bound param, no injection); `GET …/documents/:slug/backlinks` added to `documentsRoute` (inherits scope mw at both pScope+tScope mounts; `requireScope('documents:read')`; 404 via `getDocument`). Backlinks span the WORKSPACE (project_id arg unused — intended; workspace = membership boundary). **work_item/page slugs are now IMMUTABLE** — `maybeRegenerateSlug`+`isSlugAutoDerived` removed from `services/documents.ts` AND the second call site in `routes/documents.ts` (md-PATCH path) neutralized (plan missed it; caught at T3 — plan-correction `c170b33`); pinned by a `documents.test.ts` test. **UI:** add-column UI gains relation + target/cardinality selects (`table-add-column.tsx`, fed `tables` via `useTables` in `table-view.tsx`); pure `RelationPicker` (`components/relations/relation-picker.tsx`, `excludeSlugs`); read-only `RelationCell` chips (struck-through only when genuinely unresolved); `FieldRenderer` relation case = editable picker+chips WHEN given `relationCandidates` (slideover via `frontmatter-form.tsx`), else read-only `RelationCell`. **Finding 9 (whole-diff review caught, fixed `041e68f`):** table cells rendered EVERY valid link as struck-through because TableCell passed no resolver → now TableView builds a project-wide slug→title `relationResolve` (page+work_item `useDocuments`) threaded TableView→TableRow→TableCell→FieldRenderer as `resolveSlug` (stays read-only — no candidates). **Editing is slideover-only for v1; table inline-edit of relations deferred.** Three `FieldType` defs kept in sync (server `field-type-change.ts` = SoT, web `lib/api/fields.ts`, shared `index.ts` — the last was stale/missing `currency`, fixed). Migration `0019_relation_field_type.sql` (journal idx 20) widens the `fields.type` CHECK via table-rebuild (matches 0004 style). Lookups/rollups/formulas + Calendar/Timeline/Form/Attachments EXPLICITLY CUT — backlog `docs/superpowers/specs/2026-05-31-airtable-gap-backlog.md`. Design `…/specs/2026-05-31-relation-fields-and-backlinks-design.md`, plan `…/plans/2026-05-31-relation-fields-and-backlinks.md`. **Gates (run from app dirs):** server 1011/0-fail, shared 63/0-fail, web 698/8-skip/0-fail (1 known flake passed on rerun), tsc clean all 3. **Pending: browser shake-out of the relation editing UX (picker/chips/backlinks panel not yet exercised live) + Stefan QA + merge.** ⚠️ **Run server tests from `apps/server` (`cd apps/server && bun test`) — `bun test apps/server` from repo root triggers a cwd-dependent ~650-fail module-init cascade (NOT a regression).**_

_**Board view grouping + ordering BUILT on `phase-3.x/board-view` 2026-05-31 (pre-Phase-4 UX, 3rd slice; NOT merged — paused for Stefan's browser QA + sign-off).** 7 commits (`a0d9fb6..aed2ae8`, board ones), subagent-driven + final holistic review. **(1) Group by any field** — board columns come from `view.groupBy` (status default, or any field except multi_select); pure `buildColumns` helper (`board-grouping.ts`); select→options as columns, else distinct observed values; "unset"/"No status" column when non-empty. Drag between columns patches status (status group) or `frontmatter[groupBy]` (field group). **(2) In-column ordering = field-sort + manual.** Field-sort reuses the server sort. **Manual** = one global `board_position TEXT` fractional-rank column on documents (migration `0018`, journal idx 19); `rankBetween(lo,hi)` helper in `@folio/shared` (base-62, ASCII-monotonic, lexically comparable; stress-tested 8000+ inserts). Server sort key `board_position` (nulls-last via `coalesce(...,'￿')` text affinity — followed the keyset discipline, regression-tested, NO drop this time). **(3) Sort wins; manual is default** — within-column drag-reorder only when `effectiveSort===null` (cards `useSortable`+`SortableContext`); field-sort active → cards `useDraggable`, card-over-card is a no-op. **Board toolbar** (`board-toolbar.tsx`): Group-by + Sort menus, persist to view (autosave-gated on `?view=`). **TWO holistic-review bugs caught + fixed (`aed2ae8`):** C1 (CRITICAL) — in manual mode (default), dropping a card onto a card in ANOTHER column only reordered, never regrouped (snap-back); fixed via pure `resolveDrop` 4-way decision (none/reorder/regroup/regroup-reorder) — cross-column-on-a-card now regroups AND sets boardPosition in one patch. I1 — number/boolean group-by stored stringified values; fixed with `coerceGroupValue`. Also B6 found+fixed a B3 wire gap: `boardPosition` was missing from the shared `documentPatchSchema` (zod boundary) + web `DocumentPatch` → PATCH silently stripped it; added + round-trip route test. Spec `docs/superpowers/specs/2026-05-31-board-view-grouping-ordering-design.md`, plan `…/plans/2026-05-31-board-view-grouping-ordering.md`. Counts: web 679/8-skip/0-fail, shared 63/0-fail, server board-suites 98/0-fail isolated (full server suite is the KNOWN mock.module-leak+concurrency flake — use per-file isolation). **Pure helpers worth knowing: `board-rank.ts` (rankBetween), `board-grouping.ts` (buildColumns), `board-drag.ts` (resolveDrop/coerceGroupValue), `board-reorder.ts` (computeReorderPosition).**_

_**Board QA fixes ALSO on `phase-3.x/board-view` 2026-05-31 (Stefan QA round, 5 commits `955f2ed..515ee4b`).** Fixed 3 reported issues: **(1) "Manual not working"** — root cause: group-by/sort were gated behind `?view=` (board reached at `/board` with no view param → changes silently no-op'd). Fix: new **`board-controls-bus.ts`** module bus holds per-view ad-hoc `{groupBy,sort}` overrides; controls ALWAYS apply via the bus (override wins, incl. `sort:null`=manual → `listParams.sort='board_position'`), and persist to the view only when `?view=` is pinned. **(2) Column bg height** — board row `items-stretch` + column wrapper `min-h-0` + body `flex-1` → tinted bg fills full board height regardless of card count. **(3) Controls placement** — group-by + sort moved OUT of the board's internal strip INTO the **project tab row** after a vertical divider, board-tab-only, via new **`board-controls.tsx`** (SOLE WRITER: bus + view persist); **`KanbanView` is now a pure READER** of the bus (`useSyncExternalStore`). CRITICAL contract: BoardControls + KanbanView resolve `activeView` independently but IDENTICALLY (same cached `useViews`, same default-pick) so they share the bus key — guarded by `board-controls-integration.test.tsx` (verified FAILS if ids diverge). Holistic review APPROVED (0 crit/0 imp/3 minor — cosmetic/intended). Plan `docs/superpowers/plans/2026-05-31-board-fixes.md`. Counts: web 689/8-skip/0-fail, shared 63, server board-suites 98 isolated. **Board view (feature + QA fixes) on the branch — pending Stefan browser QA + merge.**_

_**Board QA round 2 (`f99f790`, park commit, test commit `a6542b3`) 2026-05-31 — Stefan re-QA found 2 issues, both fixed + VERIFIED IN THE LIVE APP via chrome DevTools DOM measurement (not guessed).** **(A) Column height "round 1 didn't work":** diagnosed by measuring the real DOM — the `items-stretch` fix DID equalize column heights (all bodies 472px), but a column with many cards had `overflow-y:visible` so its cards (scrollH 834) SPILLED OUT below the tint and pushed the whole BOARD to scroll. Real fix: column body gets `min-h-0 overflow-y-auto folio-scroll` (dropped `min-h-[200px]`) → tall columns scroll INTERNALLY, tint always fills board height, page no longer scrolls. Verified live: 8-card column `internalScroll:true h:472`, `mainScrollerOverflows:false`. **LESSON: for layout bugs, MEASURE the live DOM (chrome use_browser eval getBoundingClientRect + computed styles) — a from-source guess was wrong once; the isolated repro AND the real-app measurement found the true cause (overflow, not stretch).** **(B) Manual sort PARKED** (Stefan: "manual sort is not working, park this for now"): "Manual" item removed from the Sort menu (commented, not deleted), `reorderEnabled` hardcoded `false`, null board sort now defaults to `updated_at desc` (not `board_position`). All manual machinery (board_position column/sort key, rankBetween, board-reorder.ts, board-drag.ts) stays DORMANT in code for un-parking — search "PARKED" comments to restore. 3 manual-sort tests retargeted to field sorts. Verified live: Sort menu = Title/Status/Updated, no Manual, label "Updated ↓". Counts: web 689/8-skip/0-fail, shared 63, server board-suites green isolated. **Still pending Stefan QA + merge.**_

_**TableView UX cleanup MERGED to `main` (`eacc9bf`) 2026-05-31** — slices 1+2 (sort fix, sortable custom fields, pinned settings column, tab bar icons + Wiki-off-top, wiki cards). Root-dnd kept as-is per Stefan. NOT pushed to origin (main is local-only, 545+ ahead). [original entry below kept for the sort/keyset detail.]_

_**TableView UX cleanup BUILT on `phase-3.x/tableview-ux` 2026-05-31 (pre-Phase-4 polish; MERGED — see entry above).** First slice of the "serious UX cleaning" round. 6 commits `0dfc857..cc6f16a`, subagent-driven w/ per-task verify + final holistic review. **(1) Server-side sort now WORKS** — was fully broken (route ignored `sort`/`dir`; `listDocuments` hard-coded `updated_at desc`). Now built-ins only (title/status/updated_at) with a **sort-aware keyset cursor** (cursor carries sortKey+value; mismatched-sort cursor restarts page 1). **CRITICAL caught by holistic review + fixed (`cc6f16a`):** sort-by-status dropped NULL-status rows across page boundaries (SQLite `NULL > ''` falsey) — fixed by `coalesce(status, '￿')` sentinel applied identically in ORDER BY + keyset predicate + cursor; regression test seeds NULLs across a boundary. Custom-field sort still deferred (headers non-clickable, no false affordance). **(2) Pinned right-most settings column** — column-picker moved from the top bar into a sticky-right header slot (`w-11`), empty sticky cell per row, mirrors the sticky-left Title column; FilterBar now alone in the top bar. **(3) Project tab bar** — Work items (List icon) + Board (Columns3 icon); **Wiki dropped from the top tabs** (still reachable via rail; `/wiki` route untouched); `FrameTab` gained optional `icon`; `onCreate` wiki branch + `actionLabel` removed. **(4) Wiki overview = cards** — root pages render as a card grid (title + body excerpt + child count via new `bodyExcerpt` helper); expanding a card reveals the existing TreeRow subtree (drag-to-reparent preserved INSIDE expanded cards). `DocumentSummary` widened with `body` (server already sent it un-projected; `Document` now aliases `DocumentSummary`). Spec `docs/superpowers/specs/2026-05-31-tableview-ux-cleanup-design.md`, plan `…/plans/2026-05-31-tableview-ux-cleanup.md`. Counts: server 990/1-skip/0-fail, web 652/8-skip/0-fail, shared 53/0-fail, tsc clean. **OPEN DECISION for Stefan (review MINOR):** root pages are no longer drag-reparent sources/targets (only children inside expanded cards are) — confirm acceptable or restore root-level dnd. **Plan-command bug found+fixed mid-flight: the web app uses `vitest` (`npx vitest run`), NOT `bun test` — the plan said bun test for web.**_

_**Sortable custom fields ADDED on `phase-3.x/tableview-ux` 2026-05-31 (same branch, follow-up — Stefan: "every column sortable is the correct UX").** 4 commits `00de88e..c4e0fb2`. `listDocuments` now sorts by ANY custom frontmatter field, validated against the table's `fields` rows + `^[a-zA-Z0-9_]+$` (no raw input in SQL; `json_extract` path bound as param). Type-aware: number/currency → `cast(json_extract as real)` + numeric sentinel `9e18`; everything else → `cast(json_extract as text)` + text sentinel `'￿'` (the cast is sort-critical — see bug below). Cursor `decodeCursor` loosened to accept field keys (sortKey widened to `string`; expr always built from the REQUEST's validated sort, never the cursor's key). Client: `table-header.tsx` `sortable = true` for every column (dropped `SORTABLE_BUILTIN_KEYS`). **TWO CRITICALs caught by holistic review + fixed (same keyset-affinity bug class):** (1) `cc6f16a` NULL-status drop (built-in slice); (2) `c4e0fb2` a NON-numeric field holding JSON numbers (e.g. a `select` field with values 2,10,3) sorted numerically in ORDER BY but the text cursor compared with text affinity → rows dropped across page boundaries. Fix = `cast(json_extract as text)` so ORDER BY + keyset + cursor all use consistent text affinity (verified empirically in bun:sqlite; the reviewer's one-side cast proposal was INSUFFICIENT — consistent affinity via the shared `fieldSortExpr` is the real fix). Lexical order for numeric-in-untyped-field is the accepted tradeoff (pin as number/currency for numeric order). Regression tests seed numbers + missing values across a page boundary. Plan `docs/superpowers/plans/2026-05-31-sortable-custom-fields.md`. Counts: server 995/1-skip/0-fail, web 653/8-skip/0-fail, shared 53/0-fail, tsc clean. **LESSON: keyset pagination over any nullable/variant-typed sort column needs ORDER BY + predicate + cursor-encode to share IDENTICAL affinity + sentinel — three places, verify each.**_

_Last updated: 2026-05-31 — **🎉 PHASE 3 (Agent runner) BUILT + SHAKEN-OUT — MERGE-READY on `phase-3/agent-runner`, NOT yet merged/pushed. F-8 (`--no-ff` merge to main) is the ONLY remaining gate, paused for Stefan.** All sub-phases A→F + D-9 + the E redesign are done + reviewed. The agent runner is PROVEN end-to-end with a real Anthropic key via `apps/server/scripts/diagnose-http-chain.ts` (deterministic: assign → run → kind=result comment, t+1s/t+2s). Full detail in auto-memory `project_phase-3-shipped.md`._

_**Body-as-prompt SHIPPED on `phase-3/agent-runner` 2026-05-31 (still pre-merge, F-8 bundle).** An agent's PROMPT is now its markdown **body**, not `frontmatter.system_prompt`. The runner snapshots `(agent.body ?? '').trim()` onto each run at `createRun` (reproducibility preserved — the run's `system_prompt` field is the snapshot; runner reads `ctx.fm.system_prompt` unchanged); empty body → `createRun` throws `AGENT_PROMPT_EMPTY` (422). Agent frontmatter `system_prompt` is now `.optional()` (legacy). **Migration `0016_agent_body_as_prompt`** (journal idx 17) backfills existing agents' body from `system_prompt` (no-clobber) + strips the key. Web: agent form drops the `system_prompt` row, new agents seed a `# Prompt` starter body, the body editor is labelled "Prompt". Plan `docs/superpowers/plans/2026-05-31-agent-body-as-prompt.md` (inline threat-model; the plan's `0013` was corrected to `0016` — 0013/14/15 already existed). 5 tasks subagent-driven + final holistic review. Server 973/0-fail, web 643/8-skip/0-fail, tsc clean. **Also this session:** trigger Fields full-height + no Edit/Raw toggle (`1be75e7`); Edit/Raw moved into the ⋯ menu (`412238a`); rail "Agents" tool removed + cockpit tab icons → lucide line-icons (`2f94fe2`); NocoDB single-row slideover headers + body-editor-only-on-Fields (`1535793`); RunsHistorySection id→slug fix (`fe0bd67`). **Deferred (`tasks/retro-follow-ups.md`):** no create-time prompt guard on MCP `create_agent` / HTTP agent-create → a body-less agent is creatable-but-unrunnable (runtime guard catches it; not a blocker)._

_**UI-cleanup pass — Agent Cockpit Panel SHIPPED on `phase-3/agent-runner` 2026-05-31 (still pre-merge, part of the F-8 bundle).** Replaced the `/w/:wslug/agents` destination PAGE (the `21ef82d` consolidation) with a persistent ~360px **agent cockpit panel** in `Shell.panel` (pushes the worktable left), toggled by the workspace-dropdown "Agents" + a rail "Agents" tool + Cmd-K "Run agent…". Icon-tab header (⚡Activity/▶Run/🤖Agents) over the kept E screens. Agent/trigger config opens as a **resizable** slideover (drag left edge, width persists in localStorage via new `useResizableWidth`). Plan `docs/superpowers/plans/2026-05-31-agent-cockpit-panel.md`, spec `…specs/2026-05-31-agent-cockpit-panel-design.md`. 9 commits `4375744..ea1ceb9` + collision fix `d00187d`, all subagent-driven w/ two-stage review. **The `/agents` page + route are DELETED** (routeTree regenerated). **Key fix (final holistic review caught it): the workspace agent/trigger slideover now keys on `?wdoc=` NOT `?doc=`** — mounting it at the layout collided with the project work-item `DocumentSlideover` (both on `?doc=`) → dual stacked Radix modals; `?wdoc=` (workspace docs) vs `?doc=` (work-items) are now disjoint. Web suite 638/8-skip/0-fail, tsc clean. New lib: `agent-panel-bus.ts` (module singleton: open/close/toggle/subscribe), `use-resizable-width.ts`, components `agent-cockpit-panel.tsx`/`agent-list.tsx`/`panel-header.tsx`/`ui/resize-handle.tsx`._

_**Sub-phase F (shake-out) — what it caught + fixed (6 real bugs no unit test surfaced):** C1 (`GET ?type=agent_run` leaked system_prompt — SECURITY, `7741b63`), I1 (agent-token cross-agent read leak, `a00a0d0`), I2 (setInterval re-entrancy latch, `b7493b9`), I3 (unvalidated runner env knobs, `b7493b9`), **F-D5** (Bun reaped idle SSE streams at 10s → `idleTimeout:0`, `5e184ce`), **F-D6** (dispatcher cursor seeded lazily on first tick → boot-race dropped assignments; my first fix seed-at-0 would've caused a worse historical-replay stampede on existing-instance upgrade — **F-6 /code-review caught that** — final fix is EAGER seed-at-MAX-at-boot `seedReactorCursors`, `f54df04`). F-6 also fixed stale docs + a loose env floor (`32c3628`). Test counts at F close: server **968** / 1-skip / 0-fail, web **631** / 8-skip / 0-fail, shared **53** / 0-fail; tsc clean._

_**NOT done / deferred (do NOT assume these work):** the **awaiting_approval gate is UNBUILT** (model-initiated approval = Phase 3.x, plan `2026-05-30-phase-3.x-model-initiated-approval.md`) — so approve-via-button/mention/MCP isn't exercised end-to-end, and **F6-D1: E-4b/E-6 ship INERT** (nothing stamps `run_id` on a plan comment yet). **Cron triggers** = Phase 3.5. The real-Anthropic Playwright spec is **skip-gated** (`FOLIO_E2E_REAL_ANTHROPIC=1`, harness-flaky-not-product). Open follow-ups in `tasks/retro-follow-ups.md` (D-R-*, E-FOLLOWUP-1..6, F-D*, F6-D1); **F-D2 (cancel/retry HTTP↔MCP duplication) is MANDATORY before `FOLIO_AGENT_CHAINS_ENABLED` is flipped on.** D + D-9 `/evaluate` retros never ran (acceptable — both were /code-review'd). **Next after F-8 merge: Phase 3.x (model-initiated approval) or Phase 4 (inbound webhooks).** PRIOR ENTRY: ——_

_Last updated: 2026-05-29 (later) — **C.3 (Reaction Plane) SHIPPED + reviewed + retro'd. Sub-phase C is COMPLETE.** Built in ~1h, single session, subagent-driven (two-stage review per task, every task caught real issues at review): C-10a (system-event `workspaceId:null` bus rule + `reactor.*` kinds) `770fcac` · C-10b (durable dispatcher + `reactor_cursors` table, per-reactor cursor, at-least-once, edge-triggered halt) `8c7655d` · C-11 (trigger-matcher as first reactor — document-as-trigger + allow-list + autonomy gate `FOLIO_AGENT_CHAINS_ENABLED` + idempotency) `2520214` · C-12 (runner poller — claim loop + concurrency cap + boot recovery) `17fa1f9`. `/integration` GREEN. `/code-review` (medium, base `2a2dca2`, 7 angles + 2 verify passes) → 5 findings: **3 fixed** `ed0d009` (system-event `projectId:null`+`documentId:null` broadcast so `?project=X` SSE subscribers see reactor health; matcher reuses canonical `resolveAgentProjects`; run-owner falls back to `apiTokens.createdBy` for human PATs), **2 deferred** (C.3-R-1 suppressed-event idempotency + C.3-R-2 `run_id` false-positive — both unreachable/low-harm in V1, fix with autonomy work). Both standing HUMAN_DECISIONs RESOLVED at the gate `817e5d0`: plan-freshness PROMOTED to `netdust-core:ntdst-execute-with-tests` Step 2.5 (cache-live; plugin SOURCE repo needs the same edit to survive re-sync); `/code-review` cap KEPT at 15. `/evaluate` retro `9a6e57d` (1 plan defect: `db:generate` contaminates migrations on this project — corrected `21dd2c0`; lessons `3bd6c57`). Server **851 → 874 pass / 1 skip / 0 fail**, shared **51 → 53**, tsc clean (C.3 files). `.last-integration`=`cad6443`, `.last-evaluate`=`3bd6c57`. Branch NOT pushed. **Next: Sub-phase D (routes + MCP parity + REAL tools in D-3 [mitigation 27 + tool-error feedback] + D-5 fills the matcher's internal_action resume_run/reject_run stubs). First "agent does work" smoke is C-13's manual step — runs the loop end-to-end with `__echo`; real tool work waits for D.** PRIOR ENTRY: ——_

_2026-05-29 (late) — **C.2 SHIPPED + retro'd; C.3 REDESIGNED (Option A → Reaction Plane) + fully planned — ready to BUILD in a fresh session.** This session: closed C.2 (`/code-review` 9/10 fixed incl. a CRITICAL regression caught at re-review, 1 deferred to D-3), ran the C.2 `/evaluate` retro (`92b2ab6`), then a design discussion reshaped C.3. The trigger-matcher was going to be inline-in-tx (Option A); after an event-system discussion + external evaluation it's now the **Reaction Plane** (Option B-minimal): a durable, at-least-once, per-reactor-cursor event dispatcher with the matcher as its first reactor (document-as-trigger reached via the durable log, no per-emit hand-wiring). Brainstorm → spec → plan all shipped. Server suite **851 pass / 1 skip / 0 fail** (unchanged — C.3 is design-only this session, no code). Branch NOT pushed. **Next gate: BUILD C.3 (5 tasks) per the execution handoff below.**_

_2026-05-30 (latest) — **Sub-phase E `/code-review` DONE + all fixable findings fixed. Only `/evaluate` (E retro) + Sub-phase F remain.** `/code-review --base=cf5b2f6 --effort=medium` (7 angles + verify): 5 findings survived → **4 FIXED** (`204cb66`: clear `?tab=` on manual tab click [CONFIRMED — was re-asserting on doc-switch]; carry-forward `fired_by` in activity feed [CONFIRMED — transition emits omit it]; narrow approval-gate guard to past-gate statuses [PLAUSIBLE]; `11a4f6f`: runs-history queries ALL the agent's projects via `useQueries` not just primary [CONFIRMED — closes E-FOLLOWUP-2]). **2 DEFERRED** to retro-follow-ups (E-FOLLOWUP-5 useRunsLiveSync over-invalidates runsKeys.all; E-FOLLOWUP-6 N SSE connections/page, no multiplexing — v1-acceptable). 2 REFUTED (wiki multi-node; PanelHeader-vs-TabStrip). Web **626→631** / 8 skip / 0 fail, server 962 unchanged, tsc clean. `.last-integration`=`48d9eea`. **REMAINING: `/evaluate` (E retro), then Sub-phase F (shake-out w/ real BYOK key + Playwright + merge to main).** PRIOR ENTRY: ——_

_2026-05-30 (later) — **Sub-phase E BUILD COMPLETE — E-1..E-8 all shipped + two-stage-reviewed; E-9 automated gate GREEN. Only the user-run `/code-review` + `/evaluate` remain.** All 9 build tasks done on the redesigned agent surface. Shipped (each spec+quality reviewed, most caught a real fix at review): E-3 RunStatusChip+RunRow (`ae58ef5`+`734b5e0` shared relativeTime), E-4 RunsHistorySection in agent slideover runs tab (`c6ef604`), E-4b server run_id passthrough (`4b40def`+`61a87b6`; nanoid schema relax), E-5a panel shell+NocoDB header+bus (`177bc69`), E-5b run launcher+Cmd-K (`8615f6f`+`964cc60` shared formatApiError), E-5c activity feed+screen+?tab= deep-link (`045c141`), E-6 approval buttons live run state (`eb9ddb7`+`b60189e`; hooks-order fix; reviewer's "dead fallback" suggestion CORRECTLY refused — status is nullable), E-7 banners+AI-tab deep link (`bb8391b`+`e7c93bd` flex-column layout fix), E-8 [[ wiki-link picker (`4fe101c`+`2e3e99f`; fixed a real markdown-corruption double-bracket bug at review). **E-9 gate:** web **559→626** / 8 skip / 0 fail, server **960→962** / 1 skip / 0 fail (E-4b +2), shared 53 (unchanged), web+server tsc clean. `.last-integration`=`e9a8f1a`. 4 review follow-ups tracked (E-FOLLOWUP-1..4 in retro-follow-ups.md). Branch NOT pushed. **REMAINING (user-run, billed): `/code-review --base=cf5b2f6 --effort=medium` over the E diff (verify it inherits mitigations 1–66; E-4b is the only server change), then `/evaluate` (E retro). After that: Sub-phase F (shake-out with a real BYOK key + Playwright + branch merge).** PRIOR ENTRY: ——_

_2026-05-30 — **Sub-phase E IN PROGRESS (subagent-driven). The "runs are a TableView" plan was DROPPED mid-execution + REDESIGNED.** Ground-truthing E-3/E-4 proved runs CANNOT render through TableView: `agent_run` rows are walled off from the generic `/documents` endpoint (security — system_prompt/tokens), readable only via `/runs`; also no multi-table web nav exists. See `~/.claude/.../memory/project_runs-not-a-tableview.md`. Re-brainstormed (visual companion) into a new design: **runs = execution metadata, NOT the deliverable** (the deliverable is the docs the agent writes). Three surfaces: (1) approval-in-comments (E-6), (2) run-history-on-the-agent slideover (E-4 ✓), (3) a toggleable **agent side-panel** with a NocoDB-style icon-tab header + two screens — ▶ Run (launcher, Cmd-K-opened) + ⚡ Activity (SSE-driven feed). Spec `docs/superpowers/specs/2026-05-30-phase-3-E-agent-surface-design.md`; plan `docs/superpowers/plans/2026-05-30-phase-3-E-agent-surface.md` (10 tasks E-3..E-9). **SHIPPED so far (all two-stage-reviewed):** E-1 useEventStream (`9a05c00`+`0726767`), E-2 runs hooks+useRunsLiveSync (`029c20d`+`6858ba7`), E-2b provider/reactor health (`bae6c14`+`9a8fb09`), E-3 RunStatusChip+RunRow (`ae58ef5`+`734b5e0`), E-4 RunsHistorySection (`c6ef604`). Web suite 559→585 / 8 skip / 0 fail; tsc clean. `.last-integration`=`cf5b2f6`. **NEXT: E-4b (server run_id passthrough — SPEC CORRECTED: plan comments are API-posted not runner-stamped) → E-5a/b/c (panel) → E-6 → E-7 → E-8 → E-9 gate.** Drift caught + fixed at review each task: jsonOk envelopes `{data}` (not bare array), reactor payload key is `error_summary` (not error_class), reused Badge + shared relativeTime. Two follow-ups tracked in retro-follow-ups.md (E-FOLLOWUP-1 doc-slideover NocoDB-header retrofit; E-FOLLOWUP-2 workspace-wide runs endpoint). Branch NOT pushed. PRIOR ENTRY: ——_

Living snapshot of where the project actually is. Read at session start. Update at session end if anything below changed.

## Next up — Sub-phase E (web UI) IN PROGRESS — see 2026-05-30 marker above. (Historical readiness handoff below predates the runs-surface redesign.)

> **🎯 READ FIRST (E session)**: `docs/superpowers/handoffs/2026-05-30-phase-3-sub-phase-E-readiness.md` — Sub-phase E readiness (web UI: runs table + link tiles + Cmd-K + provider/reactor-halt banners + body wiki-links). E is server-API-complete (D shipped every endpoint E consumes); E is almost all `apps/web`. Two cheap pre-steps: (1) `/integration` to advance the marker `9748a64`→`255c3e1` (D-9 shipped past it); (2) optional D + D-9 `/evaluate` retros. Then EXPAND the outline-only E-1..E-9 (writing-plans, Step 2.5 reconcile vs the D response shapes + existing Phase-1.5/1.6/2.6 web components + the SSE-client design decision). Skill order in the handoff. **The (historical) D readiness handoff is below; D is DONE.**

## (HISTORICAL) Sub-phase D — SHIPPED + reviewed + D-9 done. C.3 SHIPPED. D PLAN EXPANDED + RECONCILED + THREAT-MODELED.

> **🎯 STATE UPDATE 2026-05-29 (D plan-correction):** STOP-gate 2 (expand + reconcile the D plan) is **DONE**. The executable D plan is `docs/superpowers/plans/2026-05-29-phase-3-D-routes-mcp-real-tools.md` — D-1..D-8 with full Steps/Tests/Commit bodies, a ground-truth reconciliation table (verified vs live source at HEAD `7d20d05`), and a **Sub-phase D threat-model extension (mitigations 54–63)** on top of the inherited B(1–22)+C(23–47)+C.3(48–53). This SUPERSEDES the outline-only D section in the mega-plan (~line 4486). **Key reconciliations baked in:** `executeMcpTool`→`executeTool(token, actor, name, args, tx?)`; `mcp-dispatch.ts`→`agent-tools.ts`; the two-ToolDef-shape merge (agent-tools' Zod `ToolDef` is canonical, `description`/`inputSchema` added optional for MCP `tools/list`); HTTP cancel uses `error_reason='cancelled'` (verified in the live enum, NOT `cancel_requested`); retry = `createRun(firedBy:'retry-of:<id>')` + poller claim, NOT a synchronous `runAgent` call (poller already branches on `resume_of`→`runAgentResume`, verified `poller.ts:63-68`). **Carried-obligation calls:** C.1-R-1 (FK cascade) stays PARKED — D ships `cancel` not hard-delete, so the orphan attack is unreachable; mitigation 27 (C.2-R-1) lands as D mitigation 57 (carry every lifecycle guard into agent-tools handlers); C.2-R-2 (tool-error feedback) RE-SCOPED out of the D-2/D-3 pure extraction into a standalone deferred **D-9**. **STOP-gate 1 (C-13 smoke) — PASSED HEADLESSLY 2026-05-29.** Stefan was on remote-control (no browser), so instead of the manual dev-server UI smoke I wrote a HEADLESS wiring smoke driving the REAL composed loop — `runDispatcherOnce(db, REACTORS)` + `runPollerOnce(db, deps)` (the same functions `index.ts` wires on boot) — with ONLY `runAgent` stubbed (no key, no credits burned). File: `apps/server/src/lib/c13-wiring-smoke.test.ts` (3 tests, now permanent). Proves: (1) assignment → durable event → dispatcher → matcher → planning run → poller claims → runAgent dispatched (full happy path); (2) autonomy gate suppresses agent-originated assignment + emits `agent.chain.suppressed`, human assignment fires; (3) reactor halt → `reactor.halted` + frozen cursor → `reactor.recovered`. Server suite **874 → 877 / 1 skip / 0 fail**, tsc clean, deterministic 3× + alongside all sibling reaction-plane tests (22/22). **No wiring bug — C.3 composes correctly.** Two NON-bug insights surfaced (both correct V1 behavior): (a) reactor cursors SEED at MAX(seq) on first registration — a reactor only processes events emitted AFTER boot, never replays history (smoke primes one tick before emitting, mirroring `index.ts`); (b) the matcher's owner-resolution gate (trigger-matcher.ts step 6, closing C.2-R-3 — no `system:` user, FK-valid owner) blocks pure-agent actors INDEPENDENTLY of the autonomy flag: even with `FOLIO_AGENT_CHAINS_ENABLED=true`, an `actor='agent:<slug>'` run can't fire (no human owner); agent-originated chains need an ownership story V1 defers. **D IS NOW UNBLOCKED.** Next: dispatch D-1 first via `ntdst-execute-with-tests` (Step 2.5 per task). Local `key` file (no credits) added to `.gitignore`.
>
> **✅ SUB-PHASE D ESSENTIALLY DONE — D-1..D-7 shipped + two-stage-reviewed, D-8 integration gate GREEN + `/code-review` done (4 findings fixed + re-verified). Only `/evaluate` (user-run retro) + the branch merge remain (Sub-phases E+F still ahead).** Server suite **877 → 950 / 1 skip / 0 fail**, tsc clean, web 559/shared 53 unaffected. `.last-integration`=`9748a64`. **D-8 `/code-review`** (medium, 7 angles, base `cad6443`, threat model 1–63): 4 findings fixed (`9748a64`) — (1) HIGH `target_agent` `agent:`-prefix mismatch silently no-op'd approval/rejection → `normalizeAgentSlug`+prefer `target_agent_id`; (2) HIGH autonomy gate (mit 54) missing on BOTH retry faces → added + extracted shared `lib/autonomy-gate.ts::emitChainSuppressed` across all 5 gate sites; (3) MED MCP `run_agent` stray comment on duplicate → early `getActiveRun` before input-comment; (4) LOW admin-runner-stats reachable by admin-created agent bearer → `authMethod==='token'` 403 (session-only). +8 tests; re-review CONFIRMED all 4 correct + no regression; 1 finding REFUTED (existence-oracle — gate fires workspace-globally not per-project). 3 cleanup/altitude findings DEFERRED as D-R-1..D-R-3 in `tasks/retro-follow-ups.md` (allow-list-derivation triplication, cancel-via-rejection overload, create/cancel/retry verb duplication). **REMAINING (user-run): `/evaluate` (D retro). Then Sub-phase E (web UI) → F (shake-out + merge).**
>
> **✅ D-9 (tool-error feedback) SHIPPED + reviewed 2026-05-30** (no longer deferred). Plan `docs/superpowers/plans/2026-05-29-phase-3-D9-tool-error-feedback.md` (approved as-written: both invalid-args + handler-throws feed back, `MAX_CONSECUTIVE_TOOL_ERRORS=3` hardcoded). **D-9.1 `695330c`** — added `'tool_error'` to `runErrorReasonSchema`; verified+tested `checkProviderHealth`'s allow-list filter auto-excludes it (model failure ≠ provider failure). **D-9.2 `b8e6886`** — `runLoop` now feeds RECOVERABLE tool errors back as `{role:'tool'}` messages so the model self-corrects (invalid-args → paths-only; handler-throws → `safeToolErrorMessage` surfacing the safe `HTTPError.code`/`mcpInvalidParams .data.reason`, NEVER the message/values/SDK body — mitigation 65); FATAL errors (scope-denied `forbidden: scope`, unknown-tool `method not found`) still terminate `provider_error`; per-run consecutive-error sub-cap of 3 (resets on any successful tool result) → `tool_error` (mitigation 64), inside the existing 25-round cap + token budget; mixed-batch aborts whole round on any fatal sibling. Threat-model mitigations **64–66** added to the D-9 plan. The 3 locked-spec terminal-on-tool-error tests REPLACED. Two-stage review ✅ APPROVED (verified no value leak, counter reset correct, untouched paths byte-identical); a follow-up refinement closed a usability gap (status-less throws were sanitizing to misleading "Network error" — now surface the safe code). Server suite **950 → 960 / 1 skip / 0 fail**, tsc clean. HEAD `b8e6886`. **HISTORICAL (mid-dispatch detail):**
>
> **🚧 D DISPATCH — D-1..D-7 ALL SHIPPED + two-stage-reviewed (2026-05-29); only the user-run D-8 gate remains.** Server suite **877 → 942 / 1 skip / 0 fail** (self-verified at D-8 controller gate), tsc clean, web/shared unaffected (D server-only). Commits: D-1 `2ecb1b4`, D-2 `4f17050`, D-3 `f7db7a6`, **D-4 `a316508`** (5 run MCP tools, HTTP-twin parity via exported `createRunForParent`+`loadRunScopedByToken`; cancel_run actor=`ctx.actor` FK-valid users.id), **D-5 `fe20e8a`** (resume_run creates `planning`+`resume_of`+inherited chain_id→poller routes to runAgentResume; reject_run→rejectRun; idempotency via getActiveRun excludeRunId; **fixed latent schema bug: `resume_of` was `.uuid()` but run ids are nanoid → `.min(1)`**), **D-6 `d32f78e`** (admin runner-stats, owner/admin gate, workspace-scoped counts mit 60, jsonOk envelope), **D-7 `707f070`** (SSE `?agent=`[slug]/`?table=`, enriched 3 lifecycle emitters' payloads additively, consumers verified unaffected). All plan corrections in the D plan's "D execution outcomes" section. **D-8 REMAINING (user-run, billed):** `/code-review --base=cad6443 --effort=medium` (combined threat-model contract — verify mitigations 1–63: B 1-22 + C 23-47 + C.3 48-53 + D 54-63) + sibling-site audit on the D diff + `/evaluate` (D retro). D-9 (tool-error feedback) still DEFERRED. **HISTORICAL (cluster detail):**
>
> **🚧 D DISPATCH IN PROGRESS — D-1/D-2/D-3 SHIPPED + two-stage-reviewed (2026-05-29).** Subagent-driven, two-stage review (spec then quality) per task, all suite counts self-verified (per `[[verify-subagent-test-counts]]`). Commits: **D-1** `2ecb1b4` (`routes/runs.ts` 6 verbs — list/get/create/cancel/retry/provider-health; mitigations 54-59,63; 26 tests; cancel-of-running posts `kind=rejection`+target_agent — the `kind=cancel` plan wording was wrong, corrected `3bedd58`; review caught + fixed an idempotency-vs-input-comment ordering regression from the createRunForParent extraction). **D-2** `4f17050` (migrated all 20 real MCP tools into the shared registry `lib/agent-tools-registry.ts` via `registerTool`; ToolDef gained optional `description`/`inputSchema` + `listToolDefs()`; mitigation 57 — every agent-lifecycle guard carried into handlers, verified line-by-line vs mcp.ts, anchored to `ctx.token.agentId`; error helpers extracted to `lib/mcp-errors.ts`; circular-import resolved via explicit `registerRealTools()`). **D-3** `f7db7a6` (`routes/mcp.ts` 1271→186 lines — thin transport over `executeTool`; `mapToolErrorToJsonRpc` mit-61 paths-only verified by sentinel-absence test; tools/list via `listToolDefs()` unfiltered mit-62; existing mcp.test.ts 46/0 UNCHANGED = the regression contract held; D-3 caught + fixed a D-2 latent behavior change — `create_document.type` strict enum masked the service's `COMMENT_REQUIRES_COMMENT_TOOL`, reverted to `z.string()` with handler+service+DB-CHECK as the real gates). **The D-2/D-3 tool-migration cluster (the riskiest part of D) is COMPLETE — one unified tool surface, two faces.** Server suite **877 → 919 / 1 skip / 0 fail** (self-verified), tsc clean. **REMAINING: D-4** (5 run MCP tools `list_runs/get_run/run_agent/cancel_run/retry_run`, HTTP-twin parity — share D-1's `createRunForParent` seam), **D-5** (fill `handleInternalActionStub` → resume_run/reject_run; poller already routes `resume_of`→`runAgentResume`), **D-6** (admin runner-stats, mit 60), **D-7** (SSE `?agent=`/`?table=`), **D-8** (integration gate → `/code-review --base=cad6443` with the combined threat-model contract 1-63 → sibling-site audit → `/evaluate`). **D-9 still deferred** (tool-error feedback). PRIOR ENTRY: ——


> **🎯 READ FIRST**: `docs/superpowers/handoffs/2026-05-29-phase-3-sub-phase-D-readiness.md` (READINESS handoff — D is NOT yet planned to executable depth). Two STOP-gates before any D code: (1) run the C-13 **manual dev-server smoke** (never executed — C.3 closed on unit gates only), (2) **expand + reconcile the D plan** — the D task bodies are outline-only AND reference renamed C-7 symbols (`executeMcpTool`→`executeTool`, `mcp-dispatch.ts`→`agent-tools.ts`); D also needs its own `netdust-core:threat-modeling` extension (mitigations 54+). Carried obligations land in D-1 (C.1-R-1 events FK), D-3 (C.2-R-1 mitigation 27 + C.2-R-2 tool-error feedback), D-5 (fills the matcher's internal_action resume/reject stubs). Skill order: writing-plans + threat-modeling FIRST (expand), then ntdst-execute-with-tests (Step 2.5 plan-freshness per task).
>
> **(historical) C.3 execution handoff**: `docs/superpowers/handoffs/2026-05-29-phase-3-sub-phase-C.3-execution.md` — drove the C.3 build; kept for trace.
>
> **Plan to execute:** `docs/superpowers/plans/2026-05-29-phase-3-C3-reaction-plane.md` (standalone, 5 tasks, real code in every step). **Design spec:** `docs/superpowers/specs/2026-05-29-reaction-plane-design.md`. **Decision brief (why B not A):** `docs/superpowers/specs/2026-05-29-event-delivery-decision.md`.
>
> **C.3 = the Reaction Plane.** Tasks: **C-10a** (system-event bus rule: `workspaceId:null` broadcast + `reactor.halted`/`reactor.recovered` kinds) → **C-10b** (durable dispatcher: `reactor_cursors` table + per-reactor cursor + at-least-once + edge-triggered halt) → **C-11** (trigger-matcher as first reactor: reads trigger DOCUMENTS + allow-list + autonomy gate `FOLIO_AGENT_CHAINS_ENABLED` + idempotency) → **C-12** (runner poller) → **C-13** (gate). Sequential, subagent-driven.
>
> **Two corrections already baked into the plan (don't re-discover):** (1) system events are bus-only, NOT durable rows — `events.workspace_id` is a NOT NULL FK; durable truth = cursor-lag. (2) `z.coerce.boolean()` mis-coerces `'false'`→`true` — use an explicit string transform for the autonomy flag.
>
> **Two HUMAN_DECISION items (plan-freshness skill rule; `/code-review` cap) still open in `tasks/retro-follow-ups.md`** — surface at the C-13 review step. The C.2 `/evaluate` retro is at `92b2ab6`.
>
> **⚠️ SUPERSEDED:** the earlier `2026-05-29-...-C.3-readiness.md` handoff + the Option-A C.3 section in the mega-plan (`docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` lines ~4257-4401, now marked SUPERSEDED) described the inline-in-tx matcher. Do NOT execute against those — the Reaction Plane plan replaces them.

> **✅ Sub-phase C.2 SHIPPED (2026-05-29).** C-7/C-8/C-9 all done via subagent-driven-development. C.2 commit range (`2acbff2..HEAD`):
> - **C-7** `lib/agent-tools.ts` `executeTool` shared dispatcher — `2825181` + fix `dd9f736` + plan-correction `79df93d`. SKELETON only (`__echo` test tool; real `TOOLS` extraction is D-3). Mitigation 27 (self-vs-peer lifecycle gate) **RE-SCOPED to D-3** (the blanket gate contradicted the live per-tool guards in `routes/mcp.ts`; dispatcher is now transport+scope+Zod only).
> - **C-8** `lib/runner.ts` `runAgent` core loop — `ac6d3c7` + fix `1716846` + plan-correction `73a6ea4`. 6 pre-flight checks + an OUTER while-loop over provider rounds (tool round-trip via message history; provider has NO continueWithToolResult/AbortController — that was the plan's biggest drift). FK-valid transition actor uses `run.createdBy` (not `system:runner` — `updated_by` FK→`users.id`).
> - **C-9** `lib/runner.ts` `runAgentResume` + `rejectRun` — `4bda465` + fix `c06f654` + plan-correction `33a3b7b`. Resume reuses C-8's `runLoop(ctx, messages)`; rejectRun catches BOTH `RUN_TRANSITION_RACED` + `INVALID_RUN_TRANSITION` (running→rejected is an invalid transition, so the state-machine guard fires, not the WHERE race). Resume idempotency excludes the lineage (`resume_of`) row via `getActiveRun`'s new optional `excludeRunId`.
> - **`/code-review` (medium, 7 angles)** over the diff: 10 findings, 9 fixed (`1486296` + `481f8e8`), 1 deferred. Headline: a strict `>` cancel boundary dropped same-ms rejections (non-deterministic suite failure that passed prior reviews by luck) — fixed inclusive + 5×-determinism-pinned. The first fix introduced a CRITICAL `done_reason:null` materialization regression (schema-invalid on failed/rejected rows) — caught at re-review, fixed in `481f8e8`. Follow-ups recorded in `tasks/retro-follow-ups.md` (`2a2dca2`): **C.2-R-2** (feed tool errors back to model → D-3), **C.2-R-3** (system-actor FK decision → C.3), + a noted pre-existing `transitionRun` null-materialization cleanup before the MD-export wedge.
>
> **Next gate:** (1) `/evaluate` — C.2 sub-phase retro. (2) **C.3 plan-correction** expanding C-10..C-13 (same per-task format as C.1/C.2), folding in the **C-12 autonomy gate** (V1↔autonomous decision point, below) + the carried obligations (mitigation 27 → D-3; tool-error feedback → D-3; system-actor → C.3). (3) Two HUMAN_DECISION items in `tasks/retro-follow-ups.md` (plan-freshness skill rule; `/code-review` cap raise) now directly pressure C.3 planning.

> **🎯 C.2 reference (historical)**: `docs/superpowers/handoffs/2026-05-28-phase-3-sub-phase-C.2-readiness.md` — the readiness handoff that drove the C.2 dispatch (mandatory skill order, per-task pre-flight, verbatim prompt template). C.2 followed it; kept for traceability + as the template for the C.3 handoff.

> **⛔ Runner prerequisite — tool-execution layer extraction (added 2026-05-28, reframed).** **Decision: inside-agent === outside-agent, ONE authorization model.** Folio's runner agent and a customer's external MCP agent are the same kind of agent (same identity/tools/scopes/auth check) — only the transport differs. The runner is NOT an MCP client; it does not speak JSON-RPC to itself. The fix: lift the tool *implementations* + `TOOLS` registry + scope check out of the Hono route (`routes/mcp.ts:1253-1314`) into a shared `lib/agent-tools.ts` (NOT `mcp-dispatch` — not MCP-specific) exposing `executeTool(token, actor, name, args)` + `listTools(token)` (scope-filtered). MCP route shrinks to pure JSON-RPC transport calling that layer; the runner calls `executeTool(agentRun.token, …)` **directly** (no JSON-RPC, no self-HTTP). The token carries authority, so the layer needs no "which caller" param — an agent can't do more in-process than over the wire (same code path below transport). Without this, every `tool_call` from the model hits a wall (runner has no HTTP request). Pure extraction; existing MCP route tests pin the behavior. Task block in `docs/PHASES.md` under "Tool-execution layer — one tool surface, two faces (runner prerequisite)", before the Runner section. Product framing: `memory/project_folio-agent-thesis.md`.
>
> _Build-decision (2026-05-28): hand-roll the runner loop on the existing `lib/ai/provider.stream()` generators — NOT the Vercel AI SDK. The provider layer already normalizes events (`text|tool_call|tokens|done`) and the tool round-trip; the SDK would force re-adapting 4 finished, tested provider files for ~40 lines of glue. Net loss._
>
> **🎚️ V1 = "agent does one task, waits" — build the whole autonomous substrate, gate the exposure (decision 2026-05-28).** Do NOT rescope the Phase 3 plan. Build runner + poller + six guards + chain machinery + resume gate as written; drive the engine in first gear and fine-tune `runAgent` on SINGLE turns until it really works before enabling agent→agent chains. The V1↔autonomous line is exactly: *can an agent's own output fire another agent run?* Human-initiated runs (person assigns / `@`-mentions an agent) are V1-allowed; agent-*originated* fan-out is gated OFF. Encoded as a new task block in `docs/PHASES.md` ("Autonomy gate — V1 ships…", under the trigger-wiring section): `FOLIO_AGENT_CHAINS_ENABLED` flag (default false) + `isAgentOriginated(event)` short-circuit in the trigger-matcher + `agent.chain.suppressed` observability + a boundary test. The six guards stay LIVE regardless (they cap a single run too — flag governs cross-run fan-out, guards govern resource caps; orthogonal). Product thesis: `memory/project_folio-agent-thesis.md`.

**C.1 is shipped + threat-model-reviewed + freeform-reviewed + fully fixed.** Two phases of review:

1. **Threat-model review (2 medium-effort rounds, both CONFIRMED)** — verified all 12 C.1-bound mitigations (23, 24, 28, 29, 36, 37, 38, 39, 40, 45, 46, 47) are in place with file/line evidence. Zero defects against named mitigations. Produced A1 (worker_crash literal → enum constant) + 2 plan corrections (mitigation 36 DEFERRED-vs-BEGIN-IMMEDIATE, mitigation 40 worker_started_at null-vs-undefined).

2. **Freeform code-review (9 angles × up to 8 candidates + 10 verifiers + dedup)** — surfaced 15 bugs the threat-model review missed because the bound rounds couldn't see across files. 4 CRITICAL, 4 HIGH, 3 MEDIUM, 4 LOW. **ALL 15 SHIPPED as 5 atomic bundles** with passing regression tests. Two findings (F11 counter cap + F13 ISO offset enforcement) reduced to documentation after verification proved them already-enforced-by-design — locked in via comments + tests so the invariants don't silently drift.

The freeform review surfaced this entire class of bug **that the threat-model review couldn't see**: C-1 widened `DocumentType` to include `agent_run`, which opened mutation paths through generic routes (PATCH /documents, DELETE /documents, POST markdown) that bypassed every state-machine + sanitizer + edge-emission mitigation. The threat-model review verified mitigations 28/39/40 in their CALL SITES, but didn't audit cross-route attack surfaces. Bundle 4 (`e505ae7`) closes that gap with 5 cross-route agent_run guards + 5 regression tests.

**Next blocking step**: **plan-correction commit expanding C-7..C-9 task bodies** before ANY C.2 code work. Per plan §"Sub-phase C.1 close-out" line 1015: *"Plan-correction commit: expand C.2 (runner + dispatcher) task bodies. Following the same per-task format as C.1 above, with per-task mitigation pointers into the C-extension threat model."*

C-7..C-9 today are header-only outlines at plan lines 3818–3845 (no Steps / no Files / no Tests body). Dispatching against them is the failure mode the C-section audit caught (handoff `8beec5e`). The plan-correction must produce executable bodies in the same shape as C.1's expanded section (lines 423–993).

> **⚠️ MUST APPLY when expanding C-7/C-8/C-12 — three 2026-05-28 decisions contradict the stale outlines. Inline `⚠️ EXPANSION RECONCILIATION` blocks now sit ON those task outlines in the plan; do not expand the stale shapes underneath them.** C-9/C-10/C-11/C-13 are unaffected — expand as-is. The three reconciliations:
> 1. **C-7** — (a) rename `lib/mcp-dispatch.ts`/`executeMcpTool`/`McpAuthContext` → `lib/agent-tools.ts`/`executeTool(token, actor, name, args)`/plain `{token, actor}`. Inside-agent === outside-agent, one auth model, runner is NOT an MCP client. (b) decide deliberately: skeleton-`__echo`-now (real tools in D-3) vs. pull the real `TOOLS` extraction forward — the former means the "set up a project for me" demo can't work until Sub-phase D. (c) **TOOLS = few GENERAL primitives, NOT a feature-menu** (`memory/project_folio-tools-as-primitives.md`): `read`/`query`/`write_document` on schemaless frontmatter + skills-as-workspace-content, NOT 40 narrow verbs. Reasoning unlimited; permission always scoped. Most consequential agent-layer call.
> 2. **C-8** — runner dispatches via `executeTool(...)` **directly** (not `executeMcpTool`); hand-roll the loop on `provider.stream()`, NOT the Vercel AI SDK.
> 3. **C-12 (CRITICAL)** — fold in the autonomy gate: `FOLIO_AGENT_CHAINS_ENABLED` (default false) + `isAgentOriginated(event)` short-circuit so agent-originated `@`-mentions create ZERO rows in V1 (human-originated still fire) + `agent.chain.suppressed` + boundary test. This is the V1↔autonomous decision point. See `docs/PHASES.md` task blocks + `memory/project_folio-agent-thesis.md`.

**Branch state at session end (Phase 3 C.2 SHIPPED):**
- HEAD: `2a2dca2` (C.2 code-review follow-ups). C.2 range = `2acbff2..HEAD` (C-7/C-8/C-9 impls + 3 fixes + 3 plan-corrections + 2 review-fix commits + follow-ups).
- Server suite: **851 pass / 1 skip / 0 fail** (C.2 delta: 810 → 851 = +41 across agent-tools + runner + the C.2 review-fix regression tests). `/integration` green at `6dcfec8`; `.last-integration` advanced.
- Web suite: **559 pass / 8 skip / 0 fail** (unchanged through C.2 — server only)
- Shared: **51 / 0 fail**
- TSC: clean both apps for touched files
- `.last-integration` marker: `666635a` (pre-review; rerun /integration to advance to `126a7b2`)

### Sub-phase C.1 review-fix bundles (this session)

| Bundle | Commit | Findings | Bug class |
|---|---|---|---|
| 1 | `799238f` | F8 + F12 + F6 | ISO→ms-epoch in raw SQL · `tx.all<Document>` type tightened · `status` column predicate replaces `json_extract` (partial-index now used) |
| 2 | `3ff4d8c` | F2 + F1 | `worker_started_at` stamped on every →running (orphan recovery reaches them) · `transitionRun` TOCTOU race fix (status predicate + rowcount check + 50-iter race test) |
| 3 | `cb5ab5e` | F4 + F5 + F7 + F11 | `workspace.provider.*` events `projectId:null` (cross-project SSE delivery) · provider-relevant filter at SQL (worker_crash no longer resets degraded) · orphan-recovery flushes per-(workspace, provider) · counter-cap semantics documented |
| 4 | `e505ae7` | F3 + F9 + F10 | Cross-route agent_run guards (PATCH md/JSON + DELETE + createDocument + DOCUMENT_TYPES) — closes the attack surface DocumentType-widening opened |
| 5 | `126a7b2` | F13 + F14 + F15 | Zod `.datetime()` Z-only enforcement documented · `ensureRunsTable` race resolved via `onConflictDoNothing` (resolves retro-follow-up C.1-R-2) · Drizzle partial-index limitation documented |

### Sub-phase C.1 review-of-review bundles (this session, layer 2)

Medium-effort review of bundles 1-5 — 5 angles + 6 verifiers — surfaced 15 MORE bugs that the bundle-fixes themselves missed. Meta-finding: **the same pattern that bit C.1 originally (cross-file/cross-route guards needing lockstep) bit the review-fix work too**. Bundles 6-7 close that gap; if Stefan wants a layer-3 review-of-review-of-review it stays on the same diff range as future work touches it.

| Bundle | Commit | Findings | Bug class |
|---|---|---|---|
| 6 | `772b124` | R1 + R2 + R3 + R4 + R5 + R6 + R7 + R8 | FE+shared DocumentType lockstep (R1) · agent_run READ paths guard (R2 — closed the read-side counterpart to bundle 4's writes) · `countPendingPlanning` predicate misses partial index (R3 — F6's missed 3rd site) · F5 recency floor (R4 — fixes "locked degraded forever" + F7 spurious recovered) · F1 distinct race-loser code (R5 + R6 — `RUN_TRANSITION_RACED` + `err.observedFrom`) · recoverOrphanRuns enum hygiene (R7) · F1 deterministic inner-throw test (R8) |
| 7 | `2acbff2` | R9 + R10 + R11 + R13 | `PRAGMA busy_timeout = 5000` for serializing concurrent writes (R9) · migration drift guard script + test (R10) · DB-level CHECK constraint via triggers for worker_started_at Z-suffix (R11 — migration 0014) · simplified provider-health JS loop (R13) |

R12 (F2 COALESCE branch is dead code through current state machine) + R14 (F7 idle workspace is indirectly fixed by R4's recency floor) + R15 (F11 stale `consecutive_failures > threshold` data — academic on this branch with no pre-F5 deploys) all resolved via code comments / retro-follow-up notes, no behavioral change.

### Plan-expansion status (DON'T FORGET — gates the next sub-phase)

The Sub-phase C plan is **partially expanded**. Tasks have an executable body (Steps + Files + Tests + Commit) ONLY where listed below. Tasks without a body must be expanded via a plan-correction commit (same per-task format as C.1) BEFORE they can be picked up by `executing-plans` or subagents.

- **C.1 services (C-1..C-6)** — EXPANDED ✓ in `23ae2d1`. Bodies at plan §"Sub-phase C.1 — Services layer (expanded task bodies — written 2026-05-28)", lines 423–993. **ALL 6 SHIPPED + REVIEW-CLOSED.**
  - C-1 `07869cc` · C-2 `a8ad551` · C-3 `9e217ea` · C-4 `bc3aa67` · C-5 `11f74a7` · C-6 `b4d84c1`.
- **C.2 runner+dispatcher (C-7..C-9)** — EXPANDED ✓ in `bdf49d0` + **SHIPPED ✓ + REVIEW-CLOSED ✓ (2026-05-29)**. Commits: C-7 `2825181`(+`dd9f736`+`79df93d`), C-8 `ac6d3c7`(+`1716846`+`73a6ea4`), C-9 `4bda465`(+`c06f654`+`33a3b7b`); code-review fixes `1486296`+`481f8e8`; follow-ups `2a2dca2`. Three further plan-corrections landed at dispatch time (provider-interface drift, mitigation-27 re-scope, C-9-align-to-C-8) on top of the original 3 EXPANSION RECONCILIATIONs. Original outlines remain at plan lines 4248+ under the "DO NOT execute against these" divider.
- **C.3 wiring+triggers (C-10..C-13)** — **REDESIGNED + PLANNED as the Reaction Plane (Option B), ready to build.** Standalone plan `docs/superpowers/plans/2026-05-29-phase-3-C3-reaction-plane.md` (tasks C-10a/C-10b/C-11/C-12/C-13); spec `docs/superpowers/specs/2026-05-29-reaction-plane-design.md`. The autonomy gate (`FOLIO_AGENT_CHAINS_ENABLED`) is folded into C-11. The Option-A inline-in-tx expansion that briefly lived at mega-plan lines ~4257-4401 is now marked SUPERSEDED (kept for trace). Execute via the C.3 execution handoff (linked in "Next up" above).

**What this means in practice for the next session(s):**
1. C.1 is DONE. /integration + 2-round /code-review + freeform 9-angle + review-of-review-of-review all verified.
2. C.2 plan expansion is DONE (`bdf49d0`). Next session can dispatch C-7 directly via `executing-plans` / `subagent-driven-development`.
3. Sibling-site audit from C.1 retro is now in the C.2 pre-flight invariants — controller MUST scan the 5 lockstep classes (TS unions, JSON↔column predicates, event scopes, cross-route guards, closed-enum literals) before dispatching each C.2 task.
4. After C-9 closes: plan-correction commit expanding C-10..C-13. The C-12 critical reconciliation (autonomy gate `FOLIO_AGENT_CHAINS_ENABLED` + `isAgentOriginated` short-circuit + boundary test) is the highest-priority item in that expansion.
5. NEVER dispatch a subagent against an unexpanded `### Task C-N` outline OR against the historical outlines below the expansion divider — that was the failure mode the C-section audit caught (handoff `8beec5e`).

### Sub-phase C.1 progress detail (COMPLETE)

Six tasks shipped on top of the readiness handoff `2b9e768`. Plus A1 audit-trail fixup + 2 plan corrections + retro-follow-ups + STATE tick:

| Task | Commit | Tests | Mitigations |
|---|---|---|---|
| C-1 createRun + transitionRun + incrementTokens | `07869cc` (+ 3 quality follow-ups) | +20 | 23, 28, 39, 40 |
| C-2 getActiveRun + getPendingApprovalRun + listRuns | `a8ad551` (+ `58fcd3b` quality) | +8 | 23, 24 |
| C-3 claimNextPlanningRun + recoverOrphanRuns + countPendingPlanning | `9e217ea` | +8 | 36, 37 |
| C-4 checkRunRateLimits + checkChainGuards + EXPLAIN volume | `bc3aa67` | +12 | 29 (partial), 30 (helper) |
| C-5 checkProviderHealth + getProviderHealth + tipping-edge | `11f74a7` + migration 0013 | +11 | 45, 46, 47 |
| C-6 ensureRunsTable + nextChainId | `b4d84c1` | +7 | 23 inherited, 29 chain_id |
| A1 worker_crash → runErrorReasonSchema.enum | (this session) | 0 (refactor) | 39 audit |

Server suite delta: 716 (B close) → **782 (C.1 complete)** = **+66 tests**.

**Plan-vs-code drift caught in C.1** (documented in commit bodies, captured in `memory/lessons.md`):
- C-1: plan's `txWithEvents` shape was loose; real C-1 manages its own tx via `txWithEvents(db, ...)`. Same convention for transitionRun.
- C-2: plan's `since` filter silently dropped invalid timestamps; quality fix throws `INVALID_QUERY (422)` matching `listComments`.
- C-3: plan's race-test cleanup used `errorReason: 'cancel_requested'` — actual enum is `'cancelled'`. `transitionRun(tx, ...)` shorthand in plan was wrong (real signature `transitionRun(runId, args)`).
- C-4: plan put `tx` first in `checkRunRateLimits(tx, args)` — actual convention is `(args, tx?)` matching getActiveRun/listRuns. Helpers stayed pure (env-default reads deferred to caller in C-10), not internal.
- C-5: plan returned `{old, new}`; `new` is reserved JS keyword — renamed to `{current, next}`. Migration plan said `JSON` type; SQLite has no JSON type — used TEXT + Drizzle `mode: 'json'`.
- C-6: plan said "re-use services/tables.ts::createTable, statuses.ts::createStatus, views.ts::createView" — those functions DON'T EXIST. Followed `lib/seed-project-defaults.ts` precedent (direct inserts + manual emitEvent).
- Plan corrections shipped this session (post-C.1 review): mitigation 36 (BEGIN IMMEDIATE → DEFERRED-with-load-bearing-status-predicate, documented why), mitigation 40 acceptance text (worker_started_at "=== undefined" → "null OR cleared", documented why JSON null is correct).

### C.1 code-review findings deferred to other sub-phases

Captured in `tasks/retro-follow-ups.md` (this session) as **C.1-R-1**, **C.1-R-2**, **C.1-R-3**:

- **C.1-R-1 (→ Sub-phase D)**: `events.document_id` has no FK to `documents.id`. `checkProviderHealth` INNER JOIN drops events whose target document was individually deleted. Surfaces when `DELETE /runs/:id` lands.
- **C.1-R-2 (→ Sub-phase C.2)**: `ensureRunsTable` existence-check + INSERT is not race-safe for concurrent first-callers. Runner-loop author should pick fix (a/b/c).
- **C.1-R-3 (housekeeping)**: `tasks/todo.md` C-section is stale — update-in-place or retire.

**Earlier C-section history (pre-C.1):**
- `2b9e768` Sub-phase C readiness handoff (lays out C.1/C.2/C.3 split + 16-attack inventory + 8 known-unknowns)
- `c2796e9` Sub-phase C threat-model extension (25 mitigations: 23–47)
- `23ae2d1` C.1 expanded task bodies (the executable Steps + Files + Tests + Commit format)
- `8beec5e` handoff note: plan-vs-handoff gaps surfaced by C-section audit

**Sub-phase B context (still relevant — threat model inheritance):**

Sub-phase B retro headline: 42 min B-1..B-7 implementation, 5h27m across 7 review-fix rounds = 1:7.7 ratio. Root cause: missing `## Threat model` in the plan at write-time. Plan correction `4fd7dd6` added it after round 2; rounds 3-7 enriched it iteratively to 22 mitigations + 21 attacks. Round-7 ultra-effort review's anti-regression scan returned `[]` — convergence signal. Captured in `memory/lessons.md` (2026-05-28 entries) and `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_phase-3-sub-phase-B-shipped.md`.

Sub-phase B threat model lives in `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` `## Threat model` section. 22 mitigations enumerate per-route gates, sanitization sites, validation symmetry, and a "future routes MUST" rule. Sub-phase C extends this with mitigations 23–47 (the threat model committed at `c2796e9`); does NOT re-litigate it.

---

## Earlier context — Sub-phase A + Phase 2.6

**Phase 2.6 merged to main** at `984b31c` on 2026-05-27 evening. Pushed. Handoff doc at `docs/superpowers/handoffs/2026-05-27-phase-2.6-complete-and-merged-handoff.md`.

**Phase 3 Sub-phase A shipped** on `phase-3/agent-runner` 2026-05-28 morning (50-min single session under subagent-driven-development). Seven tasks + two review-fixups + two plan-corrections + one retro:

- `edeff54` A-0 — auto-migrate on boot
- `52439c6` A-1 — Phase 3 event kinds in shared (`agent.run.*`, `ai.action`, provider degraded/recovered, `runs_table.lazy_seeded`)
- `13c76d8` A-2 — migration 0012 widens `documents.type` to `agent_run` + 4 partial indexes
- `d6fd994` A-3 — migration 0012a flips runner-bound builtins (`builtin-on-assignment` + `builtin-on-mention`) to `enabled: true`
- `02c4564` A-4 — `agent-run-schema.ts` (Zod + `isValidTransition` state machine)
- `a9b3ae8` plan corrections — mandatory skill invocation + A-2/A-3 defect notes (folded controller pre-flights)
- `bc4b5ee` A-4 fixup — Stage-2 review caught 2 BLOCKERs + 2 IMPORTANTs (PascalCase→camelCase rename, missing `.strict()`, tightened regexes, `resume_of.uuid()`)
- `24d96c7` A-4b — pre-commit hook + bash harness + installer + CLAUDE.md note
- `13e5954` A-4b fixup — Stage-2 review caught 1 IMPORTANT (install.sh unquoted heredoc baked absolute path; fixed to `<<'EOF'` + runtime `$(git rev-parse --show-toplevel)`)
- `32862a7` plan correction — A-4 Zod house-style drift callout (post-A retro)
- `23cc7e8` plan correction — A-4b install.sh heredoc portability callout (post-A retro)
- `499f033` retro — Sub-phase A
- `b05761a` lessons A + C from Sub-phase A retro (auto-mined: schema-vs-plan column audit + heredoc quoting rule)

**A-5 integration gate green** (server 544/1/0, web 547/8/0, shared 51/0, TS clean for both apps + root, dev DB migrates clean). `/code-review --base=9e27fda` at medium effort returned `[]` (no defects).

**Open work for Sub-phase B (next session):**
1. **Plan tasks B-1 through B-8** in `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` — provider abstraction + 4 implementations (Anthropic, OpenAI, OpenRouter, Ollama) + `POST /ai/test-key` + workspace AI-settings tab UI.
2. **BUG-002 (MCP `create_agent` slug schema)** still parked from Phase 2.6. Per user decision 2026-05-28, folds into D-3/D-4 (MCP dispatch refactor) — not Sub-phase B.
3. **A-1 reviewer NICE-TO-HAVEs** (events.ts phase-rot file-header comment, sync-guard test comment precision, describe-block "Phase 3 additions" suffix) deferred to next-touch in B+. See `tasks/retro-follow-ups.md`.
4. **3 follow-ups for human review** at `tasks/retro-follow-ups.md`: skill-invocation contract tightening, A-1 cleanup timing, writing-plans freshness-check promotion.

**Test counts on `phase-3/agent-runner`:**
- Server **544 / 1-skip / 0-fail** (524 → 544 across Sub-phase A; +20 from A-0+A-2+A-3+A-4)
- Web **547 / 8-skip / 0-fail** (unchanged — Sub-phase A was server + shared only)
- Shared **51 / 0-fail** (46 → 51 from A-1; +5)
- Scripts (backfill) **7 / 0-fail** (unchanged)
- Playwright NOT run this session (Sub-phase A is foundation — no UI surfaces).
- Server + web `tsc --noEmit` both clean for touched files. Pre-existing errors elsewhere unchanged.

**Discipline notes reinforced this session (in memory):**
- `bun test` from repo root mixes Vitest into Bun's runner → false fails (440-fail count seen mid-session). Always `cd apps/server && bun test` or `cd apps/web && bun run test`. Reinforced [[bun-test-from-repo-root-forbidden]].
- Drizzle's migrator is journal-idempotent — to test a migration's UPDATE against pre-seeded rows, use `sqlite.exec(readFileSync(<sql>))` after the migrator runs once. Captured at [[drizzle-migrate-is-idempotent]] (NEW).
- Plan-vs-reality drift caught twice (phantom columns in 0012, wrong `tables.title` column name). Reinforced [[plan-server-source-audit]].
- House-style drift in plans authored before Phase 2.6's reviewer pass codified camelCase + `.strict()`. Captured in `memory/lessons.md` (NEW 2026-05-28 entry).
- Generated-script heredocs MUST be single-quoted (`<<'EOF'`) for portability. Captured in `memory/lessons.md` (NEW 2026-05-28 entry — auto-mined).


## Phase

Phase numbering aligned with `docs/PHASES.md` (canonical) as of 2026-05-24 reorg. Original Phase 2 (Agents) and Phase 3 (AI/runner) stayed as the v1 spine; new phases slotted around them.

- **Phase 0–0.5 (Foundation + Design system):** shipped.
- **Phase 1 (Core CRUD):** shipped — backend + frontend + slideover + raw-MD round-trip.
- **Phase 1.5 (Tables + Spreadsheet UI):** shipped + merged to main at `af3c0f1` on 2026-05-24. 21 subagent-driven tasks across 1.5a (tables foundation) and 1.5b (spreadsheet UI). Plans: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md` (now Phase 1.5a) + `2026-05-24-phase-2b-spreadsheet-table-ui.md` (now Phase 1.5b).
- **Phase 1.6 (Saved views in rail):** shipped + merged to main at `cfe4ed6` on 2026-05-24. Saved views nest in rail with `?view=<id>` URL contract, filter/sort/columnOrder/visibleFields auto-save to active view, table last column hugs right edge. Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. Merge bundled Phase 1.6.1 (see below).
- **Phase 1.6.1 (Rail completeness):** shipped 2026-05-24, absorbed into `phase-1.6/saved-views` branch. NocoDB-style hover-reveal `+`/`⋯` affordances on every rail row (workspace, project, table, view), double-click rename, confirm-delete dialog. `+ New project` in workspace switcher popover. Wiki as a rail leaf under each project. Per `[[rail-ux-pattern]]` auto-memory.
- **Phase 1.7 (Lightweight CRM polish):** shipped on `phase-1.7/crm-polish` 2026-05-24. 3 of 4 sections shipped (Playbook linking deferred): `last_touched_at` column + Log Activity endpoint + ?stale_for=Nd filter, Activity panel in slideover, color-coded `next_action_due`. 116 server / 173 web / 28 shared. Awaiting manual QA + merge.
- **Phase 1.8 (Time-aware views):** queued — timeline view + This Week dashboard.
- **Phase 1.9 (Field management UI):** shipped + merged to main at `a73b7da` on 2026-05-25 (PR #2). Inline `+ Add column`, column header `⋯` menu (Rename via InlineEdit + Hide + Delete with confirm dialog), "Suggested columns" in picker (deduped + type-inferred), `useFields` table-scoped.
- **Phase 1.9.1 (Type-change UI + useUpdateView fix):** shipped + merged to main at `d12c598` on 2026-05-25 (PR #3). Compatible-only type-change in column `⋯` menu (`string ↔ text`, `number ↔ currency`, `* → text`); 422 with `INVALID_TYPE_CHANGE` for anything else. Default ISO `EUR` auto-injected on `* → currency`; options auto-cleared on `currency → *`. `useUpdateView` envelope unwrap fixed. Web 254 / 1-skip, server 135 / 135, shared 28 / 28, web TS clean.
- **Phase 2 (Agents):** **shipped + merged to main** at `3431301` on 2026-05-26 (PR #4). Bearer auth + scope middleware, in-memory event bus + SSE endpoint with Last-Event-Id replay, migration 0006 widens documents.type to agent + trigger, agent/trigger frontmatter Zod schemas + auto-token-mint + revoke + delegation guard, hand-rolled JSON-RPC MCP server at /mcp with 12 v1 tools, web tokens settings tab + assignee picker + Agents/Triggers rail leaves + DocumentTypeList, 4 reference doc files (API/MCP/AGENTS/TRIGGERS), README walkthrough. Shake-out caught 4 bugs (A/B/C/D), all fixed and committed before merge.
- **Phase 2.5 (Workspace-scoped agents):** **shipped + merged to main + pushed** at `7d73124` on 2026-05-26. 45 commits (18 plan-execution + 12 shake-out fixes + 14 memory/auto-capture + the merge commit + the Phase 3.5 doc draft). `documents.workspace_id NOT NULL` + nullable `project_id` + CHECK constraint; agent + trigger Zod gain `projects: string[]` (default `['*']`); new `requireResource` middleware mounted on `pScope` blocks cross-allow-list bearer access; `/api/v1/w/:wslug/documents` endpoints for agent + trigger CRUD; project-level POST/GET reject those types; MCP `list_projects` filters by allow-list, project-scoped tools return `-32602 agent_not_in_allow_list` on disallowed projects, agent-lifecycle tools rejected (HTTP-only in 2.5). Project-delete cascades through workspace agents' frontmatter.projects transactionally. UI: rail leaves removed, workspace popover gains Agents/Triggers entries, new `/w/:wslug/agents` + `/triggers` pages with full slideover CRUD, new design-system `<Chip>` primitive (BUG-010), ProjectsField + ToolsField + ProviderModelField multi-selects, per-agent-field help text. Shake-out caught 12 bugs, 11 fixed, 1 deferred as pre-existing (table-cell assignee picker — never wired pre-2.5). Suite at merge: server 259 / 1-skip / 0-fail, web 339 / 1-skip / 0-fail, shared 28 / 0-fail, Web TS clean. Phase 2.5 Playwright e2e: 1/1.
- **Phase 2.6 (Comments + tabbed slideover + trigger form + reconciler):** **shipped + merged to main + pushed** at `984b31c` on 2026-05-27 evening. All 5 sub-phases (A–E1) + the 15-bug code-review fix pass. Suite at merge: server 524 / 1-skip / 0-fail, web 547 / 8-skip / 0-fail, shared 46 / 0-fail. Handoff: `docs/superpowers/handoffs/2026-05-27-phase-2.6-complete-and-merged-handoff.md`.
- **Phase 3 (Agent runner + provider abstraction + runs as documents):** **Sub-phase A shipped** on `phase-3/agent-runner` 2026-05-28 morning (auto-migrate on boot, event kinds, migration 0012 widens documents.type to agent_run + 4 partial indexes, migration 0012a flips runner builtins, agent_run Zod + state machine, pre-commit hook for migration↔journal pairing). 9 substantive commits in a 50-min session under subagent-driven-development with two-stage review per task. Two plan defects surfaced (A-4 house-style drift, A-4b heredoc portability) and corrected in the plan. Retro at `docs/superpowers/retros/2026-05-28-phase-3-sub-phase-A-retro.md`. **Sub-phases B (provider abstraction + AI settings tab) → C (runner core) → D (routes + MCP parity) → E (web UI) → F (shake-out + merge)** queued.
- **Phase 4 (Inbound webhooks):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-4-inbound-webhooks.md`. 7 tasks.
- **Phase 5 (CMS bridge — Statamic):** queued — plan ready at `docs/superpowers/plans/2026-05-24-phase-5-statamic-cms-bridge.md`. 10 tasks. WordPress is Phase 5.1.
- **Phase 6 (Per-view render modes):** queued — kanban becomes a render mode; calendar added.
- **Phase 7 (UX polish + admin UIs):** queued — Cmd-K depth, keyboard shortcuts, admin screens for webhooks + sync targets.
- **Phase 8 (Ship):** queued — release pipeline, landing page, first paying customer.

## Current branch

`phase-3/agent-runner` at `b05761a` — branched from main at `984b31c` (Phase 2.6 merge). Sub-phase A shipped; Sub-phase B (provider abstraction, 8 tasks) ready to start in a fresh session per user direction "batch them, do A first, then B in new session." Not pushed.

Tests on this branch: **server 544 / 1-skip / 0-fail, web 547 / 8-skip / 0-fail, shared 51 / 0-fail, scripts/backfill 7 / 0-fail**. Server + web TS clean for touched files. Pre-existing errors elsewhere unchanged. `.last-integration` marker at `13e5954`; `.last-evaluate` marker at `b05761a`.

**Known flake:** `apps/web/src/components/views/list-view-create.test.tsx` intermittently fails in full-suite runs due to high-concurrency jsdom interaction. Passes in isolation. See `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_known-test-flakes.md`.

**Handoff doc:** `docs/superpowers/handoffs/2026-05-27-phase-2.6-handoff.md` — written end of A+B+C; sub-phases D+E1 layered on top in this session. Manual QA scenarios live at `apps/web/tests/manual-qa-phase-2.6.md`.

### Phase 2.6 sub-phases A + B + C — what shipped

**Sub-phase A (Comments core, 8 tasks):** migration 0007 (`comment` type + CHECK + index), `lib/comment-schema.ts` (Zod with strict refines), `lib/mention-parser.ts` (regex + agent/member resolution + approval-keyword grammar w/ pos-1 adjacency whitelist), 4 new event kinds + `?parent` + `?run` SSE filters, `services/comments.ts` (create/update/delete/get/list + transactional events + soft-delete + idempotency), `routes/comments.ts` (5 REST endpoints under `pScope`), workspace-level `/documents/:slug/activity` for agents (Phase 2.5 deferral resolved). A5 caught + fixed a latent bug where A1's migration was missing from `_journal.json`.

**Sub-phase B (MCP comment tools, 2 tasks):** 4 new tools (`create_comment` / `list_comments` / `update_comment` / `delete_comment`) added to the hand-rolled JSON-RPC dispatch in `routes/mcp.ts`. Author resolution from bearer token (agent or human PAT). Author-only enforcement on update/delete. `docs/MCP.md` updated.

**Sub-phase C (Tabbed slideover + Comments UI, 11 tasks):** `TabStrip` primitive, `lib/api/comments` hooks (with optimistic updates locked by mid-flight assertion test), `MentionPicker` (allow-list-filtered agents + members, keyboard nav), `WikiLinkPicker` (project docs by title — current-project scope per user decision), `CommentComposer` (Milkdown-lite + @-mention + [[ -wiki-link + Cmd+Enter + localStorage draft + focus return), `CommentRow` (author/timestamp/kind/body/hover-affordances + soft-delete + plaintext markdown + inline mention/wiki-link chips), `ApprovalButtons` (Approve/Reject on `kind=plan` + resolution detection), `CommentsTab` (composer + list + visibility toggle + inline edit + delete confirm), slideovers rewrapped with TabStrip, workspace ActivityPanel + LogActivityButton (sibling components for workspace docs + new server `GET /:slug/events` endpoint).

### Phase 2.6 sub-phase D — what shipped

**D (9 tasks, all green):** D1 `packages/shared/src/cron.ts` exports `nextFires(cron, n, now?)` + relocated `validateCronShape` from server. D2 `triggerFrontmatterSchema` accepts `agent: $event.<key>|null|optional`, `builtin: bool`, `internal_action: 'resume_run'|'reject_run'`; updateDocument + deleteDocument enforce `BUILTIN_TRIGGER_LOCKED` (422). D3 `apps/server/src/lib/builtin-triggers.ts` defines 4 builtin trigger seeds; `POST /api/v1/workspaces` inserts them inside its existing transaction. D4 `scripts/backfill-builtin-triggers.ts` — idempotent, emits `document.created` per insert (spec §9). D5 `apps/web/src/components/triggers/cron-input.tsx` live ✓/✗ + 3-fire preview. D6 `trigger-form.tsx` schedule/event toggle + cron-input + event-kind dropdown sourced from `KNOWN_EVENT_KINDS` (relocated to shared), filter rows, agent dropdown + custom `$event.<key>` option, JSON payload textarea, enabled toggle, builtin read-only mode. D7 `workspace-document-slideover.tsx` renders TriggerForm for `type='trigger'` inside a `TriggerFieldsTabPane` (local-draft + Save button). D8 4 new MCP tools (`create_agent`, `update_agent`, `delete_agent`, `get_agent_self`) + new `agents:write` scope wired through `toolsToScopes` + tokens-tab UI (checkbox + Read+write/Full presets). D9 docs (MCP/AGENTS/TRIGGERS/PHASES).

### Phase 2.6 sub-phase E — what shipped (E1) / user-side (E2)

**E1:** `apps/server/src/lib/reconciler.ts::reconcileAllowLists(db, opts?)` scrubs orphan project ids from non-wildcard agents' `frontmatter.projects`, emits `agent.allow_list.reconciled` per scrubbed agent. Boot wiring in `index.ts` via `setInterval` gated on `NODE_ENV !== 'test'`. New env `FOLIO_RECONCILER_INTERVAL_MS` (min 60s, default 1h). 6 unit tests cover orphan scrub / wildcard skip / no-op / idempotency / multiple orphans / custom actor.

**E2 (user-side, not in-session):** Manual QA per `apps/web/tests/manual-qa-phase-2.6.md` (40 scenarios) → Playwright e2e → `netdust-core:shake-out` → STATE/DECISIONS final tick → `superpowers:finishing-a-development-branch` to merge `--no-ff` into main.

### Phase 2.6 commit list (newest first, top of `phase-2.6/comments-and-slideover`)

- `d305810` phase-2.6: allow-list reconciler — periodic orphan scrub (E1)
- `d18440e` phase-2.6: docs — agent-lifecycle MCP tools + builtin triggers + $event syntax + structured trigger form (D9)
- `151977a` phase-2.6: MCP agent-lifecycle tools + agents:write scope (D8)
- `f245387` phase-2.6: trigger slideover Fields tab renders TriggerForm (D7)
- `3428b5b` phase-2.6: trigger-form — schedule/event toggle + cron + filters + JSON payload + builtin read-only (D6)
- `086fccc` phase-2.6: cron-input — live validation + next-3-fires preview (D5)
- `72c7c90` phase-2.6: backfill-builtin-triggers script (D4) — idempotent restore
- `a565fed` phase-2.6: auto-seed 4 builtin triggers on workspace create (D3)
- `1aa817b` phase-2.6: trigger schema — $event syntax + internal_action + builtin lock (D2)
- `f3a18e4` phase-2.6: shared/cron — nextFires(cron, n) + relocate validateCronShape (D1)
- `b5325e7` phase-2.6: pin O3 deferral — updateComment does NOT recompute target_agent
- `57c9e00` phase-2.6: handoff after sub-phases A+B+C; STATE + plan + spec tracked
- `139ee5a` phase-2.6: workspace agent slideover Activity tab wires ActivityPanel + LogActivity (Phase 2.5 deferral) — C10
- `b0a31e6` phase-2.6: wrap slideovers with TabStrip (work_item/page → 3 tabs; agent/trigger → 3 different tabs) — C9
- (older A+B+C commits omitted — see handoff doc for full list)

### Phase 2 commit list (newest first, top of `phase-2/agents-surface`)

- Docs commit (this session): docs/API.md + docs/MCP.md + docs/AGENTS.md + docs/TRIGGERS.md + README walkthrough
- `3292e01` phase-2: ai-keys hooks — fix 404 URL + thread wslug (Bug D)
- `ca7fb81` phase-2: documents list — apply type filter for agent + trigger (Bug C)
- `9164e5d` phase-2: token modal — add statuses:write + Read-only/Read+write/Full presets (Bug B)
- `76cdca3` phase-2: fix sticky-column e2e selector after header refactor (Bug A)
- `2e046ae` phase-2: rail — Agents + Triggers leaves under each project (Task 16)
- `a9cba37` phase-2: assignee picker — humans + agents (Task 15 + new /members endpoint)
- `18fa174` phase-2: workspace settings — API tokens tab (Task 14, new /w/:wslug/settings route)
- `d3ef26f` phase-2: useTokens / useCreateToken / useDeleteToken hooks (Task 13)
- `386a1db` phase-2: cover update/delete/list_statuses/run_view in MCP tests
- `4fc7e2a` phase-2: hand-rolled JSON-RPC MCP at /mcp with v1 tool set (Task 12)
- `95f41ca` phase-2: extract MCP-relevant logic into services/* (Task 12 precursor)
- `0d9b1d1` phase-2: delegation guard with parent-chain depth enforcement (Task 11)
- `97d3d47` phase-2: emit agent.task.assigned on assignee transition (Task 10)
- `3d9dbc9` phase-2: auto-mint agent token on create; revoke on delete (Task 9)
- `b7620d2` phase-2: validate agent/trigger frontmatter on documents POST/PATCH (Task 8)
- `80b1f7d` phase-2: trigger frontmatter Zod schema + cron-shape validator (Task 7)
- `3b74d76` phase-2: agent frontmatter Zod schema + toolsToScopes (Task 6)
- `d68f4eb` phase-2: widen documents.type to include agent + trigger (Task 5)
- `ab05622` phase-2: SSE endpoint with Last-Event-Id replay (Task 4)
- `fe5db61` phase-2: in-memory event bus + publish on emitEvent (Task 3)
- `fa8f292` phase-2: route mutations through requireScope for bearer requests (Task 2)
- `ee9548d` phase-2: add bearer auth middleware with scope enforcement (Task 1)

### Phase 2 deferrals (intentional, not blocking PR)

- Inline-rename of token name in tokens tab (Phase 2.1).
- Structured trigger form (cron input with validate affordance + event-kind select). Current slideover uses generic frontmatter form — round-trips correctly but doesn't pretty-render cron.
- Bulk MD export including triggers under `projects/<pslug>/trigger/<slug>.md` (Phase 7 polish).
- `get_folio_workflow` MCP tool (Phase 2.1).
- `requires_approval` + `max_tokens_per_run` enforcement (Phase 3 runner-side).
- The `## Approved` body convention (Phase 3 — human-in-the-loop).
- `search_documents` MCP tool (v1.1 — needs sqlite-fts5).

### Phase 2.5 commit list (newest first, merged into main at `7d73124`)

- `7d73124` phase-2.5: workspace-scoped agents (merge — `--no-ff`)
- `fd0cfbd` shake-out: e2e re-verified green post-BUG-012
- `7fa3d8b` docs: draft Phase 3.5 — script & webhook trigger actions (folded into this merge)
- `d43b3c1` shake-out: final status — 11 resolved, 1 deferred, ready for branch close
- `be319c4` phase-2.5: BUG-012 — soften Chip at-rest weight (rounded-md + border-border-light)
- `ebb20f5` phase-2.5: BUG-009 — field-help text on agent slideover
- `fc74886` phase-2.5: BUG-010 + BUG-011 — single `<Chip>` primitive, migrate 3 ad-hoc chips
- `bd9d492` phase-2.5: BUG-006 — paired provider/model field with AI-key annotation
- `a3a3902` phase-2.5: BUG-007 — ToolsField multi-select from V1_MCP_TOOLS
- `d805503` phase-2.5: BUG-008 — chip visible at rest on agents page (superseded by BUG-010)
- `0a3dbc3` phase-2.5: BUG-002 — Phase 2.5 e2e spec passes
- `397d224` phase-2.5: BUG-003 — icons on workspace popover Agents/Triggers
- `f94ebc5` phase-2.5: BUG-004 — workspace agents/triggers slideover + create/delete UI
- `174c3d9` phase-2.5: BUG-001 — mount requireResource on project-scoped routes
- `a10a2fa` phase-2.5: ProjectsField + assignee picker rewire + e2e spec
- `137bba9` phase-2.5: UI rail subtraction + workspace agents/triggers pages
- `7cedf08` phase-2.5: fix TS narrow on slugUniqueInWorkspaceDocuments call
- `032621c` phase-2.5: project-delete cascade — scrub id from workspace agent allow-lists
- `4663f62` phase-2.5: MCP — allow-list enforcement + list_projects filter + agent-lifecycle rejection
- `11f22e0` phase-2.5: workspace-scoped document routes — reject agent/trigger at project level
- `29bf253` phase-2.5: requireResource middleware + intersect() — bearer allow-list enforcement
- `e463c31` phase-2.5: agent frontmatter — projects allow-list with wildcard exclusivity
- `93511c1` phase-2.5: task 1 cleanup — wire workspace_id + skip Phase-2-only agent tests
- `af93935` phase-2.5: schema + migration — workspace-scoped documents + token allow-list
- `19f02b8` phase-2.5: plan — 9 tasks with testing-workflow gates
- `92c20bf` phase-2.5: spec — absorb stress-test feedback (pre-branch)
- `0fc10b8` phase-2.5: design — workspace-scoped agents (pre-branch)

### Phase 2.5 deferrals (Phase 2.6 + Phase 3)

- `create_agent` / `update_agent` / `delete_agent` / `get_agent_self` MCP tools — Phase 2.6 (agents can't create/edit other agents via MCP yet; HTTP-only in Phase 2.5).
- Single-project `project_slug` arg inference (when an agent's allow-list has exactly one id) — Phase 2.6 polish.
- Templates as a whole (instance-level Settings page, inert markdown, `template:` + `template_version:` references on instances, sync UI) — Phase 2.6.
- Background allow-list reconciler (periodic sweep that removes orphan project ids from agent `frontmatter.projects`; insurance against bugs in the cascade hook + hand-edited MD + partial restore-from-backup) — Phase 2.6.
- Human PAT `project_ids` enforcement (schema column exists from Phase 2.5; enforcement waits until human PATs get a UI for narrowing) — Phase 3+.
- Per-project action-scope overrides (read on A, write on B) — only if a real use case shows up.
- Caching the agent's `projects:` allow-list in `requireResource` — measure perf first.
- Workspace-scoped `.md` export endpoint (so the workspace slideover can offer Copy-as-MD and the bulk-export folder can include agents/triggers under `agents/<slug>.md`) — Phase 2.6 polish.
- ActivityPanel + LogActivity on workspace agent slideover (project-scoped only today) — Phase 2.6 polish.
- BUG-005 from shake-out: table-cell assignee picker (was never wired pre-2.5 either). Phase 7 UX polish.

### Phase 1.9.1 commit list (newest first)

- `1e9548f` phase-1.9.1: fix useUpdateView envelope unwrap
- `a0bccf2` phase-1.9.1: wire Change type into ColumnMenu and TableView
- `a4f84d0` phase-1.9.1: add ColumnTypeChange dialog
- `4153af4` phase-1.9.1: enforce type-change compatibility on field PATCH
- `8707020` phase-1.9.1: add validateTypeChange compatibility helper

### Phase 1.9 commit list (newest first)

- `bed090d` phase-1.9: clarify delete-column copy is page-scoped
- `47f2263` phase-1.9: polish add-column Create button disabled state
- `9c86918` phase-1.9: Suggested columns section in ColumnPicker
- `9961ae2` phase-1.9: columnSuggestions helper
- `0e336fe` phase-1.9: column header ⋯ menu (rename / hide / delete)
- `cfed068` phase-1.9: mount TableAddColumn at the right end of the header
- `bd5e96e` phase-1.9: add TableAddColumn popover form
- `85d42d0` phase-1.9: add useCreateField/useUpdateField/useDeleteField
- `99f0c30` phase-1.9: thread tslug through TableView and its callers
- `b9acb0a` phase-1.9: rescope useFields query key to (wslug, pslug, tslug)

### 2026-05-25 UX cleanup batch (5 items, all green)

Shipped on `phase-1.7/crm-polish` (uncommitted as of this snapshot). 9 new unit tests added; full unit suite at 214 / 215 web (was 173), 123 / 123 server, 28 / 28 shared. TS clean for the touched files; pre-existing TS errors in `apps/server/src/index.ts` and `packages/shared/src/filter-compile.test.ts` are unrelated.

1. **Rail tree chevron on hover.** `apps/web/src/components/shell/rail-tree.tsx` — leading folder/doc icon swaps to chevron on row hover (single slot). Non-expandable rows keep their icon always. Tests in `rail-tree.test.tsx`.
2. **Sticky horizontal scrollbar at viewport bottom.** `apps/web/src/components/table/table-view.tsx` — TableView now owns its scroll context with `flex h-full min-h-0 flex-col` outer + `flex-1 min-h-0 overflow-auto` scroll wrapper. The horizontal scrollbar sits at the bottom of that flex item, which is the viewport bottom inside MainFrame's content area. MainFrame itself is left alone.
3. **Sticky first-column right border.** `table-cell.tsx:40` + `table-header.tsx:113` — `border-r border-border-light pr-3` on the sticky branch. Test in new `table-cell.test.tsx`.
4. **Add-row at table bottom.** New `apps/web/src/components/table/table-add-row.tsx`. Renders only when there are existing docs (EmptyState already CTAs for the zero state). Click → inline title edit → on commit, `createDocument` then navigate to `?doc=<slug>` to open the slideover for the rest of the frontmatter. Three tests in `table-view.test.tsx` (renders, happy path, empty cancel).
5. **Slideover toolbar.** `document-slideover.tsx` — header right-side now Copy MD + Edit/Raw + Activity + vertical divider + ⋯ (Popover) + Close. ⋯ menu houses Delete (destructive). Delete fires a Dialog (existing `ui/dialog.tsx` primitive) with title quote + Cancel + danger Delete; on confirm, calls `useDeleteDocument` then closes the slideover. `mode` state + Alt+M listener lifted to `DocumentSlideover`. Body header simplified to just the slug pill. Three tests in `document-slideover.test.tsx`.

Decisions, locked via AskUserQuestion this session:
- Rail: icon→chevron swap on row hover (single slot).
- Delete: confirm dialog (no toast-undo / soft-delete).
- Add-row: inline title in row → open slideover for rest. NOT optimistic-create with default 'Untitled'.
- Scrollbar: sticky inside main scroll area, NOT fixed overlay.
- Toolbar: visible Copy MD + Edit/Raw + Activity; ⋯ menu houses Delete and is room to grow.

### Open UX issue at session end (DO NOT touch without re-reading)

After Phase 1.7's ColumnPicker hoist (`3614ed4`), a follow-up issue remains:
- The picker icon now sits in the FilterBar row, right-aligned to the whole viewport.
- Stefan reports it "floats above the table in empty space" — visually disconnected from the columns.
- He also still sees a horizontal scrollbar even when the table content fits the viewport.
- His ask: picker should be "right aligned in the last column" — i.e. visually inside the table header, top-right of the columns area, not floating above.

I attempted an `absolute right-0` overlay approach in a non-committed edit and reverted it on Stefan's request. **Next session: investigate via Chrome DevTools FIRST**, don't guess. The scroll trigger needs measurement; the visual disconnect needs a different layout strategy than "separate row above table."

### Phase commit list on this branch (newest first)

- `94ac10f` memory: auto-capture session end
- `3614ed4` fix: hoist ColumnPicker out of the table's horizontal scroll area (the "floats above" change)
- `527263b` memory: auto-capture
- `4bf5ff4` fix: auto-migrate dev DB on server boot
- `6bd9a47` memory: auto-capture
- `9fbe81d` fix: row height + sticky-cell hover mismatch (verified in Chrome — row 50→34px, sticky cell tracks row hover via group/row)
- `3599fb1` memory: auto-capture
- `acc535a` fix: table row height + InlineEdit hover-bg regressions from phase 1.6 (partial — these were guesses, the real fix was 9fbe81d)
- `c19763d` memory: auto-capture
- `a6f8a60` phase-1.7: fix table row height regression from urgency wrapper
- `34ed292` memory: auto-capture
- `3b334be` phase-1.7: complete — last_touched_at, activity log, due-urgency

## What's working in the UI

- Sign-up / login / magic-link flow.
- Workspace + project list, project picker.
- Spreadsheet table view at the Work Items tab — one column per pinned field (currency/date/select/multi-select all render inline), built-ins (title/status/updated_at) always sortable, columns hideable via picker, drag header to reorder, state persists per-view.
- Kanban view (drag-drop status change, per-column `+`, subtle panel surface).
- Wiki tree (parent_id hierarchy, drag-to-reparent with cycle guard).
- Slideover with Milkdown + CodeMirror raw-MD toggle; round-trips byte-for-byte per the round-trip test.
- Cmd-K palette (open via top-right Search nav OR `⌘K`).
- Theme toggle, rail collapse persistence in localStorage.
- Rail user menu: avatar/name → popover with `+ Create workspace` + **Settings** (new in Phase 2 — opens `/w/:wslug/settings`) + `Sign out`.
- Workspace switcher: workspace tile → popover with full workspace list + `+ Create workspace`. Creating a workspace from inside another no longer dead-ends.
- Inline `+ Add column` at the right end of the spreadsheet header — popover form (key + label + type + per-type options).
- Column header `⋯` menu (hover-reveal on non-builtin columns): Rename (InlineEdit on the label), Hide column, Delete column (confirm dialog with affected-doc count).
- "Suggested columns" section in the column picker — surfaces orphan frontmatter keys with inferred type; one-click `+ Pin`.
- Column `⋯ → Change type` (Phase 1.9.1) — compatible-only transitions (`string ↔ text`, `number ↔ currency`, `* → text`); server returns 422 with a clear allowed-transitions message for anything else. Default ISO `EUR` injected on `* → currency`; options cleared on `currency → *`.
- **Workspace settings page (Phase 2)** — `/w/:wslug/settings` with Tabs scaffold. Today: "API tokens" tab only.
- **API tokens tab (Phase 2)** — list/create/revoke tokens; `+ Create token` modal with name + 7 scope checkboxes (`documents:{read,write,delete}`, `fields:write`, `views:write`, `tables:write`, `statuses:write`) + Read-only/Read+write/Full access preset buttons; one-time plaintext reveal with Copy; revoke confirm dialog.
- **Assignee picker (Phase 2)** — `frontmatter.assignee` of any work item opens a Popover with Members (via `/api/v1/w/:wslug/members`) and Agents (via `useDocuments` `type=agent`) sections. Members write the email; agents write `agent:<slug>`. Picker is auto-wired by `FrontmatterForm` whenever `key === 'assignee'`.
- **Agents + Triggers rail leaves (Phase 2)** — each project shows `Agents` and `Triggers` leaves alongside `Wiki`. Routes at `/w/:wslug/p/:pslug/agents` and `/triggers` render a `DocumentTypeList` filtered by type; click → slideover.

## What's not built yet

See `docs/PHASES.md` for the canonical phase list (above-section mirrors it). Loose items not phase-tracked:

- Workspace AI-key UI in the new settings page (backend hooks now point at the correct URL after Bug D; UI lives in Phase 3 settings work).
- Single-binary build verification (`bun build --compile`).
- Docker image verification end-to-end.
- Structured trigger form (cron input with validate affordance + event-kind select). Slideover currently uses generic frontmatter form — round-trips correctly but doesn't pretty-render cron.

## Open Threads

- **Pre-Phase-2 cleanups** (per `~/.claude/projects/-home-ntdst-Projects-folio/memory/project_main-tip-and-pre-phase-2-cleanups.md`): 3 items queued before Phase 2 starts.
- **Phase 1.5 ux-polish gates** (per auto-memory `project_phase-1.5-ux-polish-shipped`): manual QA pass + visual sign-off against canonical mockups + merge to main.
- **Untracked at repo root:** `.zed/` (editor settings), `labeled-actual.png` (mockup-vs-actual comparison artifact). Leave as-is unless they need to be committed or .gitignored.

## Where things live

- **Frontend code:** `apps/web/src/`. Primitives `components/ui/`, shell `components/shell/`, views `components/views/`, kanban `components/kanban/`, slideover `components/slideover/`, inline edits `components/inline/`.
- **API client:** `apps/web/src/lib/api/` — one file per resource, returns react-query hooks.
- **Server:** `apps/server/src/` — Hono routes under `routes/`, frontmatter helpers in `lib/`.
- **Shared types + Zod schemas:** `packages/shared/src/`.
- **Tokens:** `apps/web/src/styles/tokens.css`. Tailwind mappings in `apps/web/tailwind.config.ts`.
- **Brainstorm mockups (HTML):** `.superpowers/brainstorm/94899-1778514720/content/`.

## Live tests

- `bun run test` in `apps/web/` → Vitest. 154 / 154 pass + 1 skipped (jsdom limitation on Milkdown initial render). Phase 2B added columns.test.ts (15), currency-cell.test.tsx (4), table-view.test.tsx (1).
- `cd apps/server && bun test` → 112 / 112 pass (Phase 2B added currency + columnOrder tests on top of 2A's tables/scope coverage).
- `cd packages/shared && bun test` → 28 / 28 pass.
- `bun test` from the repo root invokes Bun's runner, not Vitest — do NOT use it for web tests. Use `bun run --filter @folio/web test` or `cd apps/web && bun run test`.
- `bun run e2e` in `apps/web/` → Playwright. 26 / 26 pass when run in isolation (3 smoke + 10 click-through + 13 manual-qa). One known flake: click-through "wiki: new page" at position #25 in the long serial run can timeout (server lag, not regression — passes solo in 3.5s). Manual-qa scenario 11 (copy-as-MD clipboard) has occasionally flaked in headless Chromium against `navigator.clipboard.readText()`.
- Click-through journeys (no API shortcuts — discover bugs the way users do): `apps/web/tests/e2e/click-through.spec.ts`. Add new regressions HERE when bugs are found via manual exploration.
- API-shortcut smoke: `apps/web/tests/e2e/smoke.spec.ts`. Manual-qa map: `apps/web/tests/e2e/manual-qa.spec.ts`. Config + helpers: `apps/web/playwright.config.ts`, `apps/web/tests/e2e/global-setup.ts`, `apps/web/tests/e2e/fixtures.ts`.
- Boots its own dev stack on ports 5174 (web) / 3002 (api), isolated SQLite at `apps/server/folio-e2e.db` (gitignored, wiped on every run via `global-setup.ts`). Cold-start is ~4.5 minutes mostly Vite warmup; individual tests are 1–3s.

## Servers

- Web dev: `http://localhost:5173/` (Vite).
- API dev: `http://localhost:3001/` (Hono via Bun, `--hot`).
- `bun dev` from repo root starts both via workspace filter.
- API has no `/` or `/health` route → expect 404 on root; the auth probe at `/api/v1/auth/me` is the right liveness signal.
## Session log

- [2026-05-24 late night] Phase 1.6 "Saved views in rail" shipped via subagent-driven development on `phase-1.6/saved-views`. 9 of 10 planned tasks executed; Task 10 (Playwright e2e journey) descoped on user call — coverage via 21 new unit/RTL tests across rail-tree, buildRailTree, new-view-sheet, save-filters-action, table-view hydration + sort auto-save. Two real bugs caught in flight: (a) plan-vs-reality drift on UUIDv7 vs nanoid for view ids (CLAUDE.md aspirational, code uses nanoid — corrected mid-flight via commit `602964e`); (b) filtersEqual returning false-positives on seeded views because it included view-only `type` key + didn't coerce scalar/$eq against URL array shape (fixed in `f7fdb83`). Plan: `docs/superpowers/plans/2026-05-24-phase-1-6-saved-views-in-rail.md`. Suite: 112→113 server, 154→175 web (+21). Awaiting manual QA + merge.
- [2026-05-24 night] Merged `phase-1.5/ux-polish` → `main` with `--no-ff` (merge commit `af3c0f1`). 201 commits behind on main fast-forwarded into a single visible merge. Pushed to `origin/main`. All 294 unit tests green pre-merge (154 web + 112 server + 28 shared). Branch kept for reference; next phase will branch from `main`.
- [2026-05-24] Phase 2B "Spreadsheet table UI" shipped via subagent-driven development. 12 tasks, all spec+quality reviewed. Backend: currency type + views.columnOrder + migration 0004. Frontend: pure column helpers, TableHeader (sort+picker+drag-reorder), TableRow, TableView replaces ListView on work-items route. Seed widened default view's visibleFields + registers 4 standard fields (priority/assignee/labels/due_date) per project. Suite: 107→112 server, 134→154 web. Plan: `docs/superpowers/plans/2026-05-24-phase-2b-spreadsheet-table-ui.md`.
- [2026-05-24] Phase 2A "Tables Foundation" shipped via subagent-driven development. 9 tasks (1 → 2+3 merged → 4 → 5 → 6 → 7 → 8 → 9), all spec+quality reviewed. Schema + migration + middleware + 4 route files + tests + seed verification. Suite: 81→107 server tests, all green. Plan: `docs/superpowers/plans/2026-05-24-phase-2a-tables-foundation.md`.
- [2026-05-24] Earlier: wired all 10 skipped manual-qa Playwright scenarios (`55cb795`), silenced TanStack Router warnings via `routeFileIgnorePattern`, seeded demo data via `scripts/seed-demo.ts` for stefan@netdust.be.
- [2026-05-24 evening] Reorg of `docs/PHASES.md` after audit revealed I'd been drifting off the canonical phase plan. Original Phase 2 (Agents) + Phase 3 (AI/runner) stay as v1 spine. What I'd been calling "Phase 2A/2B" → Phase 1.5; "Phase 2C" → 1.6; "Phase 2C.5" → 1.7; original "Phase 1.5 time-aware" → 1.8; webhooks → Phase 4; CMS bridge → Phase 5; "Phase 2D" → Phase 6. Renamed the two queued plans (`phase-2-6-inbound-webhooks.md` → `phase-4-inbound-webhooks.md`; `phase-3-statamic-cms-bridge.md` → `phase-5-statamic-cms-bridge.md`) + updated cross-references inside them.
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-24] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.

---
### 2026-05-25 — tagged capture

**Risks**
- some `<button>` somewhere is *relying* on `border-style: none` to be set globally. That would be odd (border-width: 0 is invisible regardless of style) but possible if any button uses `border-color: red` without setting `border-style`. Let me grep.
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-25] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-26] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-27] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:
[2026-05-28] — session ended (no significant changes captured)

---
### 2026-05-28 — tagged capture

**Decisions**
- **accept tx (plan signature)**. Caller (Sub-phase C.2 createRun extension, or test) wraps with `txWithEvents` or `db.transaction` as appropriate.
- **the F11 finding is REFUTED by the algorithm**. Reverting my code change and removing the misleading test:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:

---
### 2026-05-29 — tagged capture

**Decisions**
- **defer the real gate to D-3, remove the wrong blanket gate from C-7**, and ship a plan-correction documenting the reconciliation. Now I dispatch the **same implementer subagent** (via SendMessage to preserve its context) to apply the fixes. The fix set:
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-29] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-30] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-05-31] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
[2026-06-01] — session ended (no significant changes captured)
