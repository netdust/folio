# Folio — Tasks

Active task list for the current branch / session.

For phase-level checkboxes that survive across branches, see `docs/PHASES.md`. This file is short-lived working memory.

---

## Current branch: `harden/m3-quality`

Executing M3 (audit Milestone 3 — quality & polish) per `docs/superpowers/plans/2026-06-16-m3-quality-polish.md`.
Class B (executing a written plan). Subagent-driven, cluster-by-cluster, gate between. Autonomous to shake-out; Stefan gates the merge.

Branched from `main` @ `5579e99` (M0/M1/M2/M2-RunSink all merged; invariant 19 named).
Baseline suites: server **1828** / web **946** / shared 70, 0 fail.

Order: A → E → D → B → C. Each cluster = a `── REVIEW GATE ──`. Tiers: A=LIGHT, E/D/B/C=STANDARD (FULL held for one-way escalation).

### Cluster A — Docs accuracy (LIGHT)
- [x] A1 — API.md AI-keys path + term + conversations/runs surfaces (4896e0f)
- [x] A2 — MCP.md tool count 20→33 (0f26cec) [my brief said 31; real=33, +2 API-bridge]
- [x] A3 — crypto-term drift libsodium→AES-256-GCM (8bff533)
- [x] A4 — PHASES.md layering-inconsistency note (4080992, addition-only)
- [x] A5 — SKIPPED per scope decision
- [x] A-fold — FOLIO-BRIEFING master-key base64→64hex (e73d5bf, review-surfaced)
- [x] ── REVIEW GATE A ── LIGHT: 0 Critical, 1 Important folded, CLOSED

### Cluster E — Test gaps + Playwright IOUs + flake + dispatcher (STANDARD)
- [x] E1 — email.ts URL round-trip test (Tier A) — 41e074c
- [x] E2 — autonomy-gate.ts suppression-record test (Tier A) — 15f0741 [plan drift: file is the emitter not a predicate]
- [x] E3 — per-tool denial matrix (Tier A) — fc24af9 — 33/33 tools deny, NO un-gated tool, coverage-guard
- [x] E4 — DELETE 8 skip-IOUs + deferred-e2e backlog doc — fe4f39f
- [x] E5 — replace 7 raw setTimeout sleeps with deterministic waits — c52838c (3× determinism each file)
- [x] E6 — Milkdown teardown flake: worker-lifetime targeted filter in test-setup.ts — d04711a (12 clean runs)
- [x] E7 — dispatcher cursor batch-advance (Tier A) — 592bf39 — 4→1 write/drain, contract preserved
- [x] ── REVIEW GATE E ── CLOSED. invariant-auditor: no bypass (inv 2/5). generalist (full E): 0 Crit/0 Imp, 2 Sugg → #1 fixed (1f8a3b8 finally-restore), #2 skipped (doc). No 1a → no escalation.
- NOTE: 3-parallel-implementer race scrambled E1/E2/E3 SHAs (recovered clean); web batch ran SERIAL — no further races

### Cluster D — Typing cleanup (STANDARD)
- [ ] D1 — discriminated RunContext kills `as unknown as Workspace/Project` — DISPATCHED
      STEP-2.5 CORRECTION: can't key union on runSink.isConversation (runSink is `undefined as unknown as RunSink` at construction, assigned after — circular ctx↔sink). Use a `kind:'document'|'conversation'` literal set at construction. Ground-truth: workspace/project read at EXACTLY 2 sites (run-sink.ts:125-126, document path only); conversation path never reads them → union is safe.
- [x] D1 — discriminated RunContext kills as-unknown-as Workspace/Project — 8da5398 (type-only narrowing, 0 assertions changed)
- [x] D2 — typed rowToDocument mapper for comments — cb966d3 (5 casts gone, byte-identical wire, 61 tests identical)
- [x] ── REVIEW GATE D ── CLOSED. invariant-auditor: no bypass (union STRENGTHENS inv-19). generalist (verified, not just read): 0 Crit/0 Imp, 2 doc Sugg → both folded (ad4a899). No 1a → no escalation.

### Cluster B — Client pagination (STANDARD + browser)
- [x] B1 — wire server ?filter= (priority) + useInfiniteDocuments(nextCursor) + delete client post-filter — 6e586d9. LABELS = path 2b (kept client-side, backlog #9: compiler has no array-contains; priority server-side). web 946→959.
- [x] ── REVIEW GATE B ── CLOSED. generalist: 0 Crit/0 Imp, 3 Sugg → #1 folded (b990222), #2/#3 skipped. Labels deferral verified unavoidable; page-2 fix real; no invariant bypass/attack surface. No 1a → no escalation. Browser-acceptance → consolidated Stage-3 /shakeout (B+C, one boot).

### Cluster C — Rail-fetch batching (STANDARD + browser)
- [x] C1 — batched GET /views?tables= (pScope, cross-project guard) + rewire P×T→P + useRailHandlers — 160a181. rail-tree UNCHANGED; stale-rail batchPrefix sweep complete. server 1845→1851.
- [x] ── REVIEW GATE C ── CLOSED. invariant-auditor: no bypass (4a guard airtight, check:invariants clean). generalist: 0 Crit/0 Imp, 3 Sugg → #1/#2 folded (cc36666), #3 design-agreement. No 1a → no escalation.

## Stage 3 — spec-close (ALL 5 CLUSTERS CLOSED)
- [x] /integration full branch — server 1852 / web 959 / shared 70, 0 fail; all 3 tsc clean; check:invariants 20/0/0
- [x] test-effectiveness audit over M3 diff — DONE: all paths covered or accepted-blind (labels #9); 0 tests authored (no genuine blind spot). Manifest captured.
- [x] feature-acceptance BROWSER drive — DONE, both flows PASS in real Chrome. B: page-2-match found (the fix), empty/last-page/no-dupe all green. C: V3 collapse→expand view survives + 1-batched-req-per-project confirmed via API log. No defects in M3 fixes. not-reachable: 2 edges/flow (concurrent SSE, mid-flow 500 — need fault injection); unverified-no-browser: in-app new-view-create CLICK trigger (chrome-ws fallback limitation, NOT app bug — wire+rail-render halves proven). FOLLOW-UP: Playwright spec for the create-trigger edge.
- [x] /shakeout STANDARD panel — CLOSED. invariant-auditor: 0 bypass, no new invariant (20/0/0). generalist: 1 Important (API.md missing C's ?tables= = A-before-C cross-cluster drift) → fixed (150ff28); +1 Sugg folded (test-setup listener dedup); 2 self-flagged notes. No 1a → STANDARD held.
- [x] finish-branch — branch ready, presenting options to Stefan (DO NOT MERGE — his gate)
- [x] compound — report-only: M3 memory written; CODE-MAP.md authoring DEFERRED (doesn't exist, own task); optional inv-4a note recorded as follow-up

## FINAL: server 1852 / web 959 / shared 70, 0 fail · 3 tsc clean · lint 0-err · check:invariants 20/0/0 · both browser acceptance flows PASS

### Stage 3 — spec-close
- [ ] /integration full branch
- [ ] test-effectiveness audit (E3/E2/E7 load-bearing)
- [ ] feature-acceptance drive (B + C matrices, real browser)
- [ ] /shakeout (branch tier STANDARD; escalate to FULL on any 1a finding)
- [ ] finish-branch — DO NOT MERGE (Stefan gates)
- [ ] compound (CODE-MAP deltas + scoped skill-audit, report-only)

### Design forks to surface (controller-decided at dispatch)
- A5: build doc-path checker? → default SKIP
- B1: server-side frontmatter filter vs honest page-local affordance → default smaller/honest
- C1: batched views endpoint vs expand-gating → default batched endpoint

### Deferred (NOT this branch)
virtualization · a11y (32) · reapStalePendingOps chunking · auth_rate_limits reaper · CI bun-pin · /mcp 413→JSON-RPC · full server-side frontmatter filter (if B1 picks affordance)

---

## Phase 6 (Views) — branch `phase-6/views`

### Cluster 1 (renderAs foundation) — DONE, at FULL REVIEW GATE (Stefan sign-off)
- [x] 1.0 views.settings JSON column (`1e0b9e85`)
- [x] 1.0b backfill list→table + seed default=table (`a2e86dea`)
- [x] 1.1 widen view-type enum, all 4 sites — closes type:'table' 422 (`778309ab`)
- [x] 1.2 ViewRouter + useActiveView (renderer convergence, inv 18) (`0a0b71a2`)
- [x] 1.3 unified /t/$tslug renders ViewRouter; legacy URLs redirect, no 404 (`19f196ec`)
- [x] 1.5 resolveViewNav/resolveTableNav → always unified route (`c1d18b25`)
- [x] 1.4 new-view sheet offers 5 user-creatable types (`f77b220b`)
- [x] 1.6 project tabs → saved-view switcher + G4 operator toggle (`c3da9a23`)
- [x] 1.7 invariant 18 updated; check:invariants 0/0/0 (`3527ff2e`)
- [x] FULL review panel (reviewer + invariant-auditor + security-sentinel) — 0 Critical, 0 Important
- [x] S1 review fix: removed dead activeTabFromPath (`1e443378`)
- FINAL: server 1869 / web 967 / shared 80, 0 fail · 3 tsc clean · check:invariants 20/0/0

### Deferred review items (carry into later clusters)
- [ ] **Cluster 2b:** route table-view.tsx / kanban-view.tsx / board-controls.tsx through `useActiveView` (they open-code its `urlViewId→isDefault→list[0]` logic — pre-existing 4-copy convergence-debt; mind the `?? null` vs `undefined` boundary). [invariant-auditor concern]
- [ ] **Cluster 2b:** add the GROUP-BY picker (+ aggregate specs + row layout) to the new-view sheet for `list` views — group-by is the list type's defining feature (like kanban's). Deliberately NOT added in Cluster 1 (Stefan, 2026-06-16): wire it together with the grouped-list renderer that reads it, not a half-wired control ahead of the renderer. The kanban group-by control in `new-view-sheet.tsx` is the pattern to extend to `list`.
- [ ] **Cluster 4/5/6:** when a renderer first READS `views.settings` (settings.dateField etc.), add read-time value-shape validation + a payload-size bound on settings (today it's stored-only, freeform `z.record(z.unknown())`). [security-sentinel deferral]
- [ ] **Later/cosmetic:** share `iconForViewType` so rail-tree row icons match the 5-way tab icons (rail currently 2-way kanban?Columns3:List). [reviewer S2]
- [ ] **If "one table view per table" ever becomes an invariant:** add a server guard (table-view-creation is client-only-excluded today). [reviewer S3]

### Cluster 2a (group-summary endpoint) — DONE, at FULL REVIEW GATE (Stefan sign-off)
- [x] L.1 group-summary validator + service + endpoint, 8 threat-model mitigations as code (`63d7d441`)
- [x] L.2 grouped-list settings types + useGroupSummary hook (`372dc444`)
- [x] integration gate: route-level un-mocked-wire acceptance tests, 8 cases (`191d1b71`)
- [x] FULL review panel: security-sentinel (8/8 mitigations IN-PLACE, 0 crit/imp) + generalist (found I-1) + performance-oracle (safe at v1, 0 crit)
- [x] review fixes (`abfc1554`): FIX-1 ungrouped distribution no longer empty (+RED test) · MAX_DISTRIBUTION_SPECS=3 cap · index comment
- FINAL: server 1909 / shared 80, 0 fail · tsc clean · group-summary tests 40 pass ×3 deterministic

### Cluster 2a — deferred perf items (NOT v1 blockers; only matter at ~10k+ docs/project)
- [ ] Perf I-2: parallelize the distribution sub-query loop — DEPRIORITIZED (bun:sqlite is synchronous; won't help until async pool).
- [ ] Perf I-3: fold the ungrouped scalar bucket into the main GROUP BY (removes one full scan on the common path).
- [ ] Perf S-2: constrain the distribution sub-query to the kept top-N groups (IN(...) on keptRows) instead of materializing all group×value pairs.

### Cluster 2b (grouped-list renderer + config UI) — DONE, at STANDARD REVIEW GATE (Stefan sign-off)
- [x] L.3 GroupedListView + 4 sub-components; page-2 guard (header=endpoint full-set, not loaded rows) (`8f8f11d3`)
- [x] L.4 grouped-list config UI: group-by + aggregate builder (AGGREGATIONS whitelist sibling-site) + row-layout → settings (`95ff6417`)
- [x] L.5 wire list → GroupedListView in viewRouter (`851063bb`)
- [x] STANDARD review panel: generalist (neither escalation trigger fired; spec-key parity + page-2 guard correct; 3 Important) + simplicity (lean, 2 wins). NO security-sentinel (no 1a surface).
- [x] LIVE browser feature-acceptance (seeded 128 docs in va-proj): grouped list renders; "done 82 items / status=done:100" header = FULL-set while pager "1–50 van 128"; Load more → "1–100 van 128" reaches todo/in_progress groups. Page-2 guard proven end-to-end.
- [x] DEBUG (systematic): a stale `bun --hot` dev server 500'd live — root-caused to dev-env NOT code (direct call + green tests + fresh-server 200). Restarted server. Memory: feedback_stale-bun-hot-dev-server-500.
- [x] review fixes (`32fe7755`): I-3 useInfiniteDocuments + Load more · I-1 surface summary.error · I-2 filter incomplete specs · S-1 dedupe defaults · S-2 hoist aggregateKey
- FINAL: web 995 / server 1909 / shared 80, 0 fail · tsc clean. Seeded test data cleaned from dev DB.

### Cluster 3 (image field type) — DONE, at FULL REVIEW GATE (Stefan sign-off)
- [x] 2.1 enum across 4 boundaries (3 TS + the SQL CHECK the plan missed) + migration 0039 table-rebuild (`f208eb96`) + row-preservation migration test (`b964cc37`, controller-added)
- [x] 2.2 image renderer + isSafeImageUrl scheme guard (gates render + commit) (`f56d2ab0`)
- [x] 2.3 infer image from image-extension URLs (`584a3a29`); type-picker N/A (no <select> exists — types inferred/pinned)
- [x] ESCALATED to FULL (migration = 1h data-layer trigger). Panel: security-sentinel (3/3 PASS: migration non-destructive, guard sound, no SSRF; ReDoS-tested) + generalist (0 Crit/0 Imp, "merge-ready"). Sibling-site audit clean.
- FINAL: server 1915 / web 1002 / shared 82, 0 fail · tsc clean all 3.

### Cluster 3 — deferred (optional, not blockers)
- [ ] S1 (BOTH reviewers): server-side scheme reject on field write (defense-in-depth) — DO THIS when a 2nd image renderer lands (e.g. a table-grid image cell), so the client guard isn't the only defense. Today client-only is accepted (server never dereferences; the one renderer makes unsafe schemes inert).
- [ ] S2: <img> onError → "(no image)" fallback (polish; matches UrlField's dead-link behavior). Optional.
- [ ] S3: image inference is path-based (query-param image URLs without extension → url). Deliberate trade-off; do NOT "fix" into over-matching.

### Cluster 4 (calendar view) — DONE, at STANDARD REVIEW GATE (Stefan sign-off)
- [x] 3.1 calendar-grid pure date math, TZ-safe (Date.UTC + ISO-slice), verified ×3 under UTC-8/+14 (`86469073`)
- [x] 3.2 calendar-view render: month grid + nav + slideover + unscheduled tray + empty/error/skeleton (`9867dbaf`)
- [x] 3.3 drag-to-reschedule writes frontmatter[dateField] to the DOCUMENT not the view (invariant 16 asserted) (`b48860a5`)
- [x] 3.4 wire calendar → CalendarView in viewRouter (`593753d4`)
- [x] STANDARD panel: generalist (invariant-16 trigger did NOT fire; TZ-safe; 0 Crit/0 Imp) + simplicity (Low). 
- [x] review simplifications (`eb774762`): export bucketKey → collapse 3 byDay scans to O(1) · delete dead dayOf · remove unused buildWeekGrid (YAGNI)
- FINAL: web 1031 / server 1915 / shared 82, 0 fail · tsc clean all 3.
- DEFERRED: real-browser pointer-drag (jsdom can't drive it; synthetic onDragEnd only) → Playwright spec, same as kanban [backlog]. a11y: doc-chip drag aria-roledescription [later a11y pass].

### Cluster 5 (timeline view) — DONE, at STANDARD REVIEW GATE (Stefan sign-off)
- [x] 4.1 timeline-lanes pure scale/range math, TZ-safe, verified ×3 LA/Tokyo/Kiritimati (`5c652792`)
- [x] 4.2 timeline render + zoom toggle persists settings.zoom to the VIEW (invariant 16 view-side) (`73f405a2`)
- [x] 4.3 range-preserving drag (start+end shift same day-delta, duration preserved) writes the DOCUMENT (invariant 16 doc-side) + router wire (`6db68429`)
- [x] STANDARD panel: generalist (BOTH invariant-16 triggers CLEAR: zoom→view, drag→document; range-preservation UTC-safe; 0 Crit/0 Imp, merge-ready) + simplicity (Low).
- [x] review simplifications (`bcb3ba9b`): extract shared date-utils.ts (DAY_MS/isoOf/msOfIso/mondayIndex were triplicated) · drop dead test no-op · converge computeRange idiom
- FINAL: web 1064 / server 1915 / shared 82, 0 fail · tsc clean · TZ-determinism re-verified post-extraction.

### Cluster 5 — deferred (optional)
- [ ] Generalist #2 (medium): the single-date dateField precedence (fallback→start→end) is duplicated in placeOnTimeline AND the drag onDragEnd — latent-divergence smell. A shared resolveSingleDateField(frontmatter, fields) helper would converge the rule. Not a current bug (both consistent); do if the precedence ever changes.
- [ ] Generalist #3: todayCol could reuse columnIndexFor (exported) for the same containment logic as bar placement. Consistency nit.
- [ ] VERIFICATION GAP (both reviewers): the real pointer-drag is never driven (jsdom synthesizes onDragEnd) — drive ONE real timeline drag through Playwright/Chrome at /shakeout before merge. Same gap as calendar + kanban.
