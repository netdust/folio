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
- [ ] E1 — email.ts URL round-trip test (Tier A)
- [ ] E2 — autonomy-gate.ts direct test (Tier A)
- [ ] E3 — per-tool denial matrix test (Tier A, highest-value)
- [ ] E4 — resolve 8 it.skip Playwright IOUs (write or delete)
- [ ] E5 — replace 7 raw setTimeout sleeps with deterministic waits
- [ ] E6 — silence Milkdown teardown flake (comments-tab.test.tsx)
- [ ] E7 — dispatcher cursor batch-advance (Tier A)
- [ ] ── REVIEW GATE E ── (STANDARD + invariant-auditor on E3/E7)

### Cluster D — Typing cleanup (STANDARD)
- [ ] D1 — discriminated RunContext (reuse RunSink.isConversation) kills `as unknown as Workspace`
- [ ] D2 — typed rowToDocument mapper for comments (5 cast sites)
- [ ] ── REVIEW GATE D ── (STANDARD + invariant-auditor)

### Cluster B — Client pagination (STANDARD + browser)
- [ ] B1 — consume nextCursor + fix page-local filter wrongness (FORK: server-side vs page-local affordance — report at gate)
- [ ] ── REVIEW GATE B ── (STANDARD + feature-acceptance browser pass)

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
