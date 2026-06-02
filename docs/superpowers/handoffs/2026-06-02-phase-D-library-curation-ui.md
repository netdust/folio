# Phase D — Library Curation UI — Execution Handoff

_Written 2026-06-02. Phase D is the FINAL phase of the cross-workspace operator: the human surface for curating the `__system` library. UI-only — no execution-model change. **Phases A + B (+ C) must be built + merged before this runs.** After D, the full A→D operator merges to main + an `/evaluate` close-out retro runs on the whole arc._

---

## 🎯 READ FIRST

- **The plan to execute:** `docs/superpowers/plans/2026-06-02-phase-D-library-curation-ui.md` — 6 tasks, threat model **D1–D4** inline (LIGHT — visibility only, no new write/auth surface). Build-ready.
- **PREREQUISITES:** Phases A (`__system` library), B (cross-workspace execution), and ideally C (triggers) merged. D reuses Phase A's `SYSTEM_WORKSPACE_SLUG` + `grantOwner`/`isSystemMember`-able membership, and pins the redaction of Phase B's cross-workspace agent-union endpoint.
- **The governing spec (the why):** `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 2 — "surfaced via Settings, visible only to `__system` members").
- **Auto-memory to load:** `project_operator-is-an-agent-not-a-seeded-bot` (read first), `feedback_state-consequences-and-dont-flatter`, `feedback_redact-at-the-loader-not-the-handler` (relevant to D4 — the cross-workspace agent list must not leak the prompt).

---

## The one-paragraph model (don't re-derive)

`__system` is a NORMAL workspace; its agents, triggers, and skill/reference docs are NORMAL documents. So the curation UI is the EXISTING per-workspace surfaces (`workspace-automation-page` / `workspace-agents-tab` / `workspace-triggers-page` / the wiki/document views) pointed at `__system` — Phase D builds NO new management UI. Phase D's real work is VISIBILITY: exclude `__system` from the ambient workspace switcher (it's not a customer workspace), expose a server-authoritative `is_system_member` signal, gate a **Settings → System Library** entry on it that NAVIGATES into `/w/__system/agents` (the existing UI), and confirm the server membership gate (Phase A M6) — not the UI hide — is the real boundary.

---

## What Phase D builds (6 tasks)

- **T1** — `listWorkspaces` EXCLUDES `__system` from the ambient list + `isSystemMember(userId)` (D1).
- **T2** — expose a server-authoritative `is_system_member` to the client (fold into `GET /workspaces` envelope or the session/me payload — NOT a new endpoint) (D2).
- **T3** — a **Settings → System Library** entry, rendered ONLY when `isSystemMember`, that NAVIGATES to `/w/__system/agents` (reuse the existing automation/agents page — do NOT build new UI) (D2).
- **T4** — pin the switcher excludes `__system` + a non-member's direct `/w/__system/...` request is 403/empty (inherited Phase A M6) (D1/D3).
- **T5** — confirm/redact: the cross-workspace agent-union list (Phase B Task 7) exposes only invokable fields (name/slug/id/`library:true`), NOT the agent `body`/`system_prompt`, to a non-member (D4 — the one real content-leak risk).
- **T6** — integration gate + a manual walk-through (member sees + curates; non-member sees nothing).

---

## Ground-truth verified this session (build to this, not assumptions)

- `GET /workspaces` → `listWorkspaces(user.id)` (`services/workspaces.ts:13`) — a membership join, so a `__system` member would see `__system` in the switcher BY DEFAULT (D1 filters it). It's the SOLE ambient feeder (the switcher + workspace-picker read `useWorkspaces` → this endpoint) — confirm at HEAD, then filtering there covers all ambient surfaces.
- Settings is a tabbed page: `routes/w.$wslug.settings.tsx` + `components/settings/{tokens-tab,ai-tab}.tsx` + the `Tabs` primitive + a `?tab=` search param. The System Library entry follows this pattern (T3).
- The existing agents/triggers management UI: `components/views/workspace-automation-page.tsx` (agents | triggers tabs) at route `/w/:wslug/agents` — works for `__system` as a normal workspace (T3 navigates to `/w/__system/agents`).
- Phase A M6: `__system` content is membership-gated by the existing `resolveWorkspace` + membership gate (a non-member gets 403/empty) — D3 confirms this isn't weakened; the UI hide is convenience, the server is the control.
- D4: the Phase-B cross-workspace agent-union endpoint (Task 7) must return only invokable fields. If it returns the full agent doc (incl. `body` = the prompt), that leaks the library agent's prompt to every customer — redact (mirror `redactRunForApi`, the precedent for stripping a prompt from a cross-tenant surface). Confirm what Phase B actually shipped at HEAD.

---

## How to execute

1. **Load `ntdst-execute-with-tests`** (CLAUDE.md rule #1). Subagent-driven, tasks 1→6 in order. Two-stage review per task; the threat model (D1–D4) is the `/code-review` convergence target. (`/code-review` MEDIUM is fine — UI + one server filter, low security surface — except verify D4 carefully.)
2. **Per task:** ground-truth the dependency surface (Step 2.5 gate) — the switcher feeder, where the `is_system_member` signal should live, the Phase-B union endpoint's actual fields, the settings-tab pattern, navigate-vs-embed. Read live; append the netdust addendum verbatim.
3. **D4 (Task 5) is the only real security check** — the cross-workspace agent list must expose name-not-prompt to a non-member. Everything else is visibility-hiding over a server boundary that already holds. The UI hide must NEVER be mistaken for the control (D3).
4. **After Task 6:** `/code-review` (medium — D1–D4), `/integration`, merge — **this completes the cross-workspace operator (A→D)**. Then run the **`/evaluate` close-out retro on the WHOLE A→D arc** (the operator build's process retro — it had a wrong-model reset worth capturing).

## Gates / commands (verified this session)

- Server: `cd apps/server && bun test` (from INSIDE apps/server). Shared: `cd packages/shared && bun test`. Web: `cd apps/web && npx vitest run` (NOT bun test). tsc per-app.
- ⚠️ Re-verify the branch after each subagent task (`git rev-parse --abbrev-ref HEAD`) — the auto-memory hook has moved HEAD to main before.
- Branch: `phase-op-3/the-agent` (or wherever A+B+C landed — confirm). Main is LOCAL-ONLY. A+B+C+D merge to main TOGETHER as the coherent operator (after D).
- **Phase D adds NO `.sql` migration** (`is_system_member` is a derived read; `__system` is from A; the switcher filter is a `where` clause). If you reach for a migration, STOP and re-read.
- **No real-key shake-out needed for D** (no agent run — it's UI + a list filter). A manual/headless UI walk-through (Task 6 Step 2) is the exercise.

## Pointers

- Plan: `docs/superpowers/plans/2026-06-02-phase-D-library-curation-ui.md`
- Spec: `docs/superpowers/specs/2026-06-02-cross-workspace-agents-and-system-library-design.md` (Component 2)
- Phase A/B/C plans + handoffs: `docs/superpowers/{plans,handoffs}/2026-06-02-phase-{A,B,C}-*.md`
- Carried follow-ups (`tasks/retro-follow-ups.md`): OP-LIB-1 (the `frontmatter.published` library-agent visibility filter — still deferred; D surfaces ALL `__system` agents to MEMBERS for curation, which is correct).
- **D is the LAST plan.** After it merges, the cross-workspace operator (A→D) is complete; the `/evaluate` close-out retro on the arc is the final step.
