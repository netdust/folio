# Shake-Out Manifest — live-view-everywhere

**Date:** 2026-06-01
**Branch/base:** main (feature landed on main, commits a9bcdd2..4f71fc3)
**Environment:** `bun dev` running — Vite :5173, API :3001 (`--hot`). Browser logged into workspace `qa`, project `demo` (8 work items).
**Method:** Real-environment sweep via Chrome DevTools MCP. Mutated documents through the live API (same session cookie the UI uses), observed the DOM for live updates.

---

## BUG-1 — CRITICAL — document views never live-update (project filter id/slug mismatch)

**Symptom:** Edited a work item's title via the live API (the same write path an agent uses; PATCH returns 200, persists, and renders correctly after a manual reload). With the list view open, the DOM did NOT update for >5s across multiple attempts. A manual page reload was required to see the change. The entire feature's purpose — "the screen moves when an agent edits" — does not work for the views.

**Reproduction:**
1. Open `/w/qa/p/demo/work-items`.
2. `PATCH /api/v1/w/qa/p/demo/documents/demo-task-7 {title:'X'}` (200, persists).
3. Observe the list for 5s → no update. Reload → the new title appears.

**Root cause (confirmed in source):**
- `apps/server/src/routes/events.ts:137` filters live events by **project id**: `if (projectId && row.projectId !== null && row.projectId !== projectId) continue;` — `row.projectId` is the real id (e.g. `pDFAKBh_...`).
- `apps/web/src/lib/api/use-live-documents.ts:15` passes the project **slug**: `useEventStream(wslug, { project: pslug, ... })`.
- slug `"demo"` ≠ id `"pDFAKBh_..."` → every document event hits the `continue` → the view receives nothing. SSE may connect, but the live filter drops 100% of events.

**Why tests/review missed it:** the unit test mocked `useEventStream` and asserted it was called with `project: 'web'` (the slug) — baking the wrong value into the assertion. Classic mock-the-wire miss. The id-vs-slug bug class was caught + fixed for comments (`parent: parentId`) in the same feature, but missed for views.

**Fix direction (Phase 3 — do NOT apply yet):** pass the project **id**, not the slug, to the `project` filter. `useLiveDocuments` is mounted at the project route, which has the resolved project (`useProject(wslug, pslug)` → `project.id`). Pass that id. Then the SSE live-filter matches. Mirror exactly how comments-tab uses `parentId`.

**Severity rationale:** CRITICAL — the feature does not work at all for its primary surface (the views). The agent→human review loop stays broken.

---

## BUG-2 — IMPORTANT (suspected, same root cause) — slideover + comments likely also mis-filtered

**Status:** STRONGLY SUSPECTED, not yet independently reproduced in-browser (deferred to avoid over-sweeping before the root-cause fix).

**Reasoning:**
- **Slideover** (`useLiveDocument`) passes NO project/parent filter — only `{ kinds }` — and filters client-side by `docId`. So the slideover is NOT subject to the project-id bug; it should actually work. NOT part of BUG-1. (Worth a confirming test in Phase 3 after the fix, but no code change expected.)
- **Comments** (`comments-tab.tsx`) passes `parent: parentId` (the id — CORRECT, matches events.ts:137-style id comparison for `parent`). So comments should work. NOT part of BUG-1.

**Conclusion:** BUG-1 is isolated to `useLiveDocuments` (the views). Comments and slideover use the correct identifier already. BUG-2 is therefore likely a NON-issue — to be **verified** in Phase 3, not fixed speculatively.

---

## Test-artifact note

During the sweep the test doc `demo-task-7` was retitled several times and restored to "Demo task 7" at the end (PATCH 200). Its status was also flipped to `in_progress` during triangulation — **NOT restored** (left as a known sweep side-effect; harmless test data in the QA workspace). Flagging per shake-out honesty.

---

## Cluster summary

| Bug | Severity | Root cause | Fix surface |
|-----|----------|-----------|-------------|
| BUG-1 | CRITICAL | `use-live-documents.ts` passes project **slug** where events route filters by **id** | `apps/web/src/lib/api/use-live-documents.ts` + its caller (pass project id) + fix the unit test to assert the id |
| BUG-2 | (verify) | none expected — comments/slideover use correct ids | verification only |

One root cause. Fix BUG-1; verify BUG-2 is a non-issue.
