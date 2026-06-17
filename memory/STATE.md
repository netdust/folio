# 🎯 CURRENT (2026-06-17) — Phase 6 (Views), branch `phase-6/views` (UNMERGED)

**Stopped for the day mid-Phase-6.** Full live state in auto-memory `project_views-rework-list-is-grouped-table`. Resume there.

- **Done + GATED this session, awaiting Stefan sign-off:** Chunk A (list = group-aware TableView, card renderer deleted) + Chunk B (ONE unified `ViewControls` = shared FilterBar + per-type settings slot, mounted once in `w.$wslug.p.$pslug.tsx`; filter+settings persist per-view via `useUpdateView`, inv-16 clean). B.7 restyled `list-controls.tsx` to the board's Popover-pill look.
- **Gate caught + FIXED a CRITICAL (C1, commit `d11c6576`):** shared filter only narrowed table/list — kanban/calendar/timeline ignored it (B.3 never implemented; green suite missed it). Now wired (`parseFilters`/`clausesToListParams`) into all 3, RED-first seam tests, kanban merge preserves `board_position`. Browser-verified live.
- **Reviews:** invariant-auditor CLEAN, generalist (C1 fixed + I1/I2 folded), simplicity LOW. Web **1094** / tsc clean. Tip `53427c04`.
- **DEFERRED follow-up (not blocking):** extract shared `GroupByPopover` (~50-line dup ListControls↔BoardToolbar).
- **NEXT (pending sign-off):** Cluster 6 (gallery + G3) — still HELD; then Stage-3 shake-out over whole branch + finish-branch.

---

# v1-hardening from docs/AUDIT-2026-06-10.md (background — M0–M2 merged)

**Driving the audit to v1 via `netdust-agent:harnessed-development`, scope = EVERYTHING (M0→M3), as ~5 gated branches, one milestone per session, Stefan gates each merge.** Full plan-of-plans + locked decisions: auto-memory `project_v1-hardening-audit-2026-06-10`.

**✅ M0 (safety net) + audit quick wins — MERGED to main 2026-06-15** (merge `a98982d`, pushed). Branch `harden/m0-safety-net` (kept, not deleted; 22 commits). What shipped:
- Quick wins: logged 2 silent error-swallows (M7); onboarding docs fixed — dev PORT story + bootstrap vars + dead release link (C1); HTTPError + AES-256-GCM doc drift (M6); project `GET /runs` capped at `?limit` (M5); 2 `__system`-era shakeout scripts deleted (M8, kept seed-ollama-*/diagnose-* per Stefan); dead `SESSION_SECRET` removed + fail-loud root test script.
- M0: **GitHub Actions CI** (`.github/workflows/ci.yml` — 3 suites + 3 typechecks + blocking Biome + binary/docker build-proofs, gate proven via plant-failure red→revert); **Tier-A crypto.ts + auth.ts tests** (H9); **lint 1219→0 errors**, Biome BLOCKING in pre-commit (`scripts/hooks/pre-commit-biome.sh`) + CI.
- Suites now: **server 1761 / shared 70 / web 938, 0 fails**. CI green with lint blocking. Suite is SELF-CONTAINED (bunfig preload forces test FOLIO_MASTER_KEY — no env vars needed to run `bun test`).
- Decisions made this session: `noNonNullAssertion`→`off` (deliberate `!` usage, ~1015×); a11y findings→`warn` (tracked follow-up, NOT mass-suppressed); `biome.json` now `vcs.useIgnoreFile` so lint ignores hook-state files. 2 CI-surfaced pre-existing bugs fixed (env `.env`-dependency; tool-registry worker-leak flake — see auto-memory `feedback_ci-surfaced-two-local-only-bugs`).

**✅ M1 (critical fixes) — MERGED to main 2026-06-15** (merge `a6b7c2f`, pushed; CI green). Branch `harden/m1-critical` (kept, not deleted; 15 commits). All 6 audit findings closed + 3 review-surfaced fixes:
- **H5** magic-link account creation gated to invite-OR-existing-user via a new `magic_links.kind` ('signin'|'invite') column (DRIFT: there was NO invites table — admin invites + self-service links shared `magic_links` with no provenance; `kind` is the minimal honest fix). `request` for a stranger → generic 200, no row, no mail (no enumeration/flooding).
- **H6** SQLite rate-limit (`auth_rate_limits`, per-IP + per-email) on login + magic-link; `clientIp()` helper (SA-4); argon2 dummy-verify on the unknown-user login branch (closes timing oracle). Fail-OPEN on store error.
- **H1** real single binary — `scripts/build.ts` embeds `web/dist` + migrations via `Bun.embeddedFiles` (static-import-of-committed-stub manifest; `build-manifest.ts` is a committed empty stub, regenerated per build, restored via `git checkout`; `pre-commit-build-manifest.sh` guards against committing the populated form).
- **H2** Docker — **glibc** base (`oven/bun:1.3.8` build + `debian:bookworm-slim` runtime; libc must match the --compile binary), `bun install --frozen-lockfile --ignore-scripts` (biome's untrusted postinstall fails frozen-install; --ignore-scripts is safe — biome is dev-only, CLI is an optional-dep binary), `/healthz` healthcheck, dead web/dist+migrations copies removed, `.dockerignore` excludes the dirty manifest + secrets, CI docker smoke-boot.
- **H7** events retention reaper (`services/events-reaper.ts`) — deletes events older than `FOLIO_EVENTS_RETENTION_MS` (90d default) AND `seq < MIN(reactor_cursors.last_seq)`; empty-cursor → no-op (Math.min([])=Infinity guard); CHUNKED DELETE (1000/batch) so a large first-run backlog can't hold the SQLite writer lock; emits no event (inv-5 deliberate exception, like pending-ops).
- **M10** global `hono/body-limit` (`FOLIO_MAX_BODY_BYTES` 5MB default) → 413 via HTTPError standard envelope.
- **Review-surfaced (not in audit):** CR-A1 email normalization at all auth boundaries + `users.email` COLLATE NOCASE unique index (security-sentinel Medium-1; closes rate-limit case-cycling + dup-account); CR-B1 build:binary clean-checkout fix (CI docker red — dirty manifest into container); CR-C1 atomic consume CAS (`UPDATE ... WHERE usedAt IS NULL` claim before user-creation — closes concurrent double-principal window M1 escalated).
- **Suites now:** server **1795** / shared 70 / web 938, 0 fails. CI fully green incl. **un-gated** binary + docker build-proofs + docker smoke-boot (the `continue-on-error` markers are GONE). Lint 0-error.
- **Gates fired:** threat-model + invariants + feature-acceptance (plan, `docs/superpowers/plans/2026-06-15-m1-critical.md`); per-cluster two-stage reviews + FULL whole-diff reviewer panel (0 blockers, 3 SHOULD-FIX all fixed); 3 security-sentinel passes (no Crit/High/Med beyond the fixed Medium-1); test-effectiveness + feature-acceptance ALL-PASS driven against the real compiled binary (incl. 8-way concurrent invite CAS, byte-exact 413, login timing parity).
- **2 CI-caught real bugs** (both only surfaced on clean GH runner, not local): docker frozen-install postinstall gate (→ CR-B1/--ignore-scripts), dirty-manifest-into-container.

**✅ M2 (leverage) — MERGED to main 2026-06-16** (merge `a18925b`, pushed; CI runs on GitHub). Branch `harden/m2-leverage` (kept, not deleted; 14 commits). Audit tasks 2.1–2.5 (2.6 RunSink deferred to Session 4 per plan-of-plans). What shipped:
- **2.1 (H8) SSE multiplexing** — `apps/web/src/lib/api/event-stream-context.tsx` `EventStreamProvider`: ONE workspace EventSource against the UNION of all consumers' kinds + client-side `matchesFilter` demux (mirrors `routes/events.ts` incl. the null-project/BUG-021 exemption). `useEventStream` keeps its signature → all 7 consumers unchanged; strictly-additive fallback-to-own-socket when no provider. Collapses 5-7 sockets → 1 (dodges the 6-per-origin cap / "stuck on Saving" on Apache/non-H2 — Stefan: deploys are Ploi/nginx OR Combell/Apache, so the cap is a REAL prod surface). **Real-browser verified: exactly 1 connection.**
- **2.2 (M4) body-less lists + debounce** — `listDocuments` projects explicit columns OMITTING `body` (return `Omit<Document,'body'>[]`); `?include=body` opt-in (ONLY the wiki view passes it, for excerpts); `useLiveDocuments` 250ms trailing debounce. Per-documentId targeted invalidation DEFERRED (SSE payload lacks table slug + the list key is table-scoped — would need an emit-payload change).
- **2.3 (H11) slideover dedup** — `SlideoverShell` + `useSlideoverLifecycle` (parametrized by `paramKey` doc/wdoc); two slideovers → thin wrappers; -341 lines; **both existing suites pass UNMODIFIED** (the dedup contract).
- **2.4 (M3) single update path** — markdown-PATCH route delegates to `updateDocument(mode:'merge'|'replace')` (default merge); deleted its inline txWithEvents + 2 emits → ONE emission site for `document.updated` + `agent.task.assigned` (inv 5/15); replace strips reserved keys; eventActor=user.id preserved.
- **2.5 (M1,M2) de-cycle tool system** — operator/agent resolver converges in NEW leaf `lib/agent-identity.ts` (`resolveCore` marker-FIRST → two wrappers: throw-variant `resolveAgentDocForToken` / soft-variant `resolveCallingAgentDoc`); both old forked copies DELETED; `createRunForParent`+`loadRunScopedByToken` moved to `services/agent-runs.ts`; **lib→routes cycle GONE**; tool registration LAZY-on-first-use via `initToolRegistry()` (killed the position-dependent bottom-call TDZ hazard); invariant-13 lockstep note removed from ARCHITECTURE-INVARIANTS.md. NOTE: a benign STATIC cycle `agent-identity→mcp-errors→agent-guards→agent-identity` remains (function-only edges, no TDZ) — the single-resolver property holds.
- **Gates fired:** threat-model (cluster 2.5, 4 mitigations all verified in code) + invariants 5/8/13/15 cited + feature-acceptance (ALL flows pass, driven through real browser + un-mocked wire). **9 review passes** (STANDARD ×2 for clusters A/B, FULL ×1 for cluster C = 4-reviewer panel + `/code-review --effort=high` + `/security-review` + test-effectiveness + perf-oracle + whole-branch generalist) — **0 Critical/Important/High/Medium**. Cluster A caught 2 real Important bugs (null-project frame drop; wiki-excerpt regression → `include=body`). test-effectiveness: 16 covered / 2 fixed (authored bite-proven tests) / 1 blind-acceptable (slideover Cmd-S, UI glue).
- **Suites:** server **1809** / web **946** / shared 70, 0 test failures. All 3 typechecks clean. check:invariants 0/0.
- **KNOWN NON-BLOCKER (user-accepted, follow-up tracked):** the full web suite intermittently exits non-zero with `@milkdown/ctx` teardown `ReferenceError: removeEventListener is not defined` — a setTimeout firing after jsdom teardown, ALL originating in the M2-UNTOUCHED `comments-tab.test.tsx` (renders Milkdown), ZERO from M2 code. No test FAILS (946 pass always); it's an unhandled-rejection flipping vitest's exit code nondeterministically (~40% of M2 runs, 0/2 main runs — small sample). M2's +8 tests shifted worker timing enough to surface it more. Stefan chose merge-now + fix-flake-separately. **Follow-up: silence the race (unmount Milkdown in comments-tab afterEach, OR a vitest onUnhandledError filter for this known lib pattern) — may intermittently red the GH web job until then.**

**✅ M2 RunSink (2.6 / audit H10) — SHAKEN OUT, NOT MERGED (Stefan's gate)** — branch `harden/m2-runsink` off main `022ea01`, ~22 commits. The H10 god-function is GONE: `runner.ts` **37 → 0** `ctx.sink` branches; `runLoop` **~451 → 149 lines**; the dual-mode loop is now a `RunSink` polymorphism. What shipped:
- **New `lib/run-sink.ts`** — `RunSink` interface + `makeDocumentRunSink`/`makeConversationRunSink` (the conv impl COMPOSES the existing `chat-thread-sink.ts` `ConversationSink`; it was NOT greenfield — Step-2.5 caught that). 8 methods (post/toolStep/trackTokens/complete/fail/wasCancelled/cancel + isConversation + conversationSink) each byte-reproduce today's `if (ctx.sink)` branch.
- **3 FULL-tier review clusters** (audit said "break down before starting"): **A** = build RunSink + wire an always-set `ctx.runSink` field (pure addition); **B** = slice `runLoop` into `consumeStream`/`executeToolRound`/`finishTerminal` (149 lines); **C** = migrate the 23 use-sites to `ctx.runSink`, delete legacy `sink?`, C-3 ISOLATED the inv-12 catch-ordering guards.
- **Behavior-preservation net = the existing runner suite**: server 1809→**1828**, **0 fail**; ONLY +47 new `expect()` (run-sink unit + C-3a discriminator + a conversation-completion drive) and **1** removed (a C-4 dead-field ref) — **ZERO existing behavioral assertion changed**. tsc + biome clean; check:invariants 0/0.
- **Gates fired:** threat-model (10 attacks, refactor-framed — "what could the extraction silently drop"); invariants 2/3/5/12/15 cited; feature-acceptance 6/6 flows PASS through the un-mocked wire. **11 specialist reviews across the 3 cluster gates (invariant-auditor/security-sentinel/generalist/perf-oracle), 0 BLOCKING.** Only 1 Important finding the whole branch (a test-net gap on conv `complete()`) — closed RED-first (`7f3947c`). `/security-review`: clean (no new vuln, 6/6 categories 9/10).
- **3 Step-2.5 plan-corrections** caught wrong premises before any implementer hit them: (1) `ctx.sink` double-duties as the `executeTool` `conversationSink` thread → `RunSink.conversationSink` bridge; (2) flipping `sink` always-set would invert all 23 mode-tests → a SEPARATE always-set `runSink` field (two-field bridge); (3) the C-3a "missing runner-level confirm test" premise was stale — `runner.test.ts:3217` already drives it.
- **FOLLOW-UPS (in `tasks/todo.md`, do at/after merge):** (a) **name a new invariant** in `ARCHITECTURE-INVARIANTS.md` — "run output+lifecycle is decided by `ctx.runSink`, never an inline `if (mode)` branch" (convergence: `lib/run-sink.ts`; the invariant-auditor said it's READY now that `ctx.sink`=0) — do this at the compounding step; (b) optional: fold `executeToolRound`'s 7-flag return into an `outcome` discriminated union (generalist suggestion #2, behavior-adjacent — separate PR); (c) optional: collapse `ctx`-derivable helper params (runId/fm/providerLabel).

**▶ NEXT: Session 5 = M3 polish** (docs incl. API.md AI-keys path = M3.1, pagination, typing, the 7 Playwright IOUs) — AFTER Stefan gates the M2 RunSink merge. Plan at `docs/superpowers/plans/2026-06-16-m2-runsink.md`. Start with `harnessed-development`.

**Open follow-ups (non-blocking, recorded from M1 shakeout):** `reapStalePendingOps` shares the same unbounded-first-run-DELETE cliff CR-C1's perf-S1 fixed in the events reaper (chunk it too); `/mcp` oversized body returns HTTP 413 not a JSON-RPC error object (no client known to break); embedded-migration temp dir not cleaned up (one/boot, negligible); `auth_rate_limits` table never reaped (slow disk growth under IP-flood); a11y backlog (32, at `warn`); refresh FOLIO-BRIEFING.md + PHASES.md crypto term (libsodium→AES-GCM); API.md AI-keys path → `/instance/ai-keys` (M3.1). CI uses `bun-version: latest` (1.3.14) while dev/docker pin 1.3.8 — minor, consider `packageManager` pin.

---

## (historical) Next up — Sub-phase E (web UI) — SUPERSEDED by the v1-hardening effort above

> **🎯 READ FIRST (E session)**: `docs/superpowers/handoffs/2026-05-30-phase-3-sub-phase-E-readiness.md` — Sub-phase E readiness (web UI: runs table + link tiles + Cmd-K + provider/reactor-halt banners + body wiki-links). E is server-API-complete (D shipped every endpoint E consumes); E is almost all `apps/web`. Two cheap pre-steps: (1) `/integration` to advance the marker `9748a64`→`255c3e1` (D-9 shipped past it); (2) optional D + D-9 `/evaluate` retros. Then EXPAND the outline-only E-1..E-9 (writing-plans, Step 2.5 reconcile vs the D response shapes + existing Phase-1.5/1.6/2.6 web components + the SSE-client design decision). Skill order in the handoff. **The (historical) D readiness handoff is below; D is DONE.**

## Phase

Phase numbering aligned with `docs/PHASES.md` (canonical) as of 2026-05-24 reorg. Original Phase 2 (Agents) and Phase 3 (AI/runner) stayed as the v1 spine; new phases slotted around them.

- **Phases 0–2.6:** shipped + merged — per-phase detail archived 2026-06-09 (see ARCHIVE.md).
- **Phase 1.8 (Time-aware views):** queued — timeline view + This Week dashboard.
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

### Phase 2 deferrals (intentional, not blocking PR)

- Inline-rename of token name in tokens tab (Phase 2.1).
- Structured trigger form (cron input with validate affordance + event-kind select). Current slideover uses generic frontmatter form — round-trips correctly but doesn't pretty-render cron.
- Bulk MD export including triggers under `projects/<pslug>/trigger/<slug>.md` (Phase 7 polish).
- `get_folio_workflow` MCP tool (Phase 2.1).
- `requires_approval` + `max_tokens_per_run` enforcement (Phase 3 runner-side).
- The `## Approved` body convention (Phase 3 — human-in-the-loop).
- `search_documents` MCP tool (v1.1 — needs sqlite-fts5).

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

### Open UX issue at session end (DO NOT touch without re-reading)

After Phase 1.7's ColumnPicker hoist (`3614ed4`), a follow-up issue remains:
- The picker icon now sits in the FilterBar row, right-aligned to the whole viewport.
- Stefan reports it "floats above the table in empty space" — visually disconnected from the columns.
- He also still sees a horizontal scrollbar even when the table content fits the viewport.
- His ask: picker should be "right aligned in the last column" — i.e. visually inside the table header, top-right of the columns area, not floating above.

I attempted an `absolute right-0` overlay approach in a non-committed edit and reverted it on Stefan's request. **Next session: investigate via Chrome DevTools FIRST**, don't guess. The scroll trigger needs measurement; the visual disconnect needs a different layout strategy than "separate row above table."

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
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-03] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-04] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)
[2026-06-05] — session ended (no significant changes captured)

---
### 2026-06-05 — tagged capture

**Decisions**
- **API tab on Agents & Triggers**, and **delete the standalone Workspace-settings page entirely**. This consolidates everything:

---
### 2026-06-05 — tagged capture

**Decisions**
- **API tab on Agents & Triggers**, and **delete the standalone Workspace-settings page entirely**. This consolidates everything:
[2026-06-05] — session ended (no significant changes captured)

---
### 2026-06-09 — tagged capture

**Decisions**
- **agent self-contained, core drops the trio.** netdust-agent keeps the full hook set (Stop/SessionStart/PreToolUse/SubagentStop); netdust-core drops Stop/SessionStart/PreToolUse.
- **Fix both copies identically.** Both `session-stop.py` files get the watermark + continuation fixes; core's hooks.json drops the trio so it doesn't fire, but the file stays correct.

---
### 2026-06-09 — tagged capture

**Decisions**
- **agent self-contained, core drops the trio.** netdust-agent keeps the full hook set (Stop/SessionStart/PreToolUse/SubagentStop); netdust-core drops Stop/SessionStart/PreToolUse.
- **Fix both copies identically.** Both `session-stop.py` files get the watermark + continuation fixes; core's hooks.json drops the trio so it doesn't fire, but the file stays correct.
[2026-06-09] — session ended (no significant changes captured)
[2026-06-09] — session ended (no significant changes captured)
[2026-06-10] — session ended (no significant changes captured)
[2026-06-15] — session ended (no significant changes captured)
[2026-06-16] — session ended (no significant changes captured)
[2026-06-17] — session ended (no significant changes captured)
