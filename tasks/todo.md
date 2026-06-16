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
- [ ] B1 — FORK RESOLVED (ground-truth): wire existing server ?filter= + consume nextCursor + delete client post-filter — DISPATCHED. Labels-array semantics: implementer to verify compiler $in vs contains; priority MUST go server-side.
- [ ] ── REVIEW GATE B ── (STANDARD + feature-acceptance browser pass: page-2-match boundary in REAL browser)

### Cluster C — Rail-fetch batching (STANDARD + browser)
- [ ] C1 — batch O(P×T) views fan-out + useRailHandlers (FORK: batched endpoint vs expand-gate — report at gate)
- [ ] ── REVIEW GATE C ── (STANDARD + feature-acceptance browser pass)

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
