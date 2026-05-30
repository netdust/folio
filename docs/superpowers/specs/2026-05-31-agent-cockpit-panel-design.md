# Agent Cockpit Panel — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorm) — pending spec review.
**Branch:** `phase-3/agent-runner` (UI-cleanup pass, post-Phase-3-build)

## Why (the thesis correction)

Folio's north-star is **"the agent is the power user, the human is the reviewer"** — agents are first-class users ([[project_folio-agent-thesis]]). The first cut of the agent UI (Sub-phase E) put runtime surfaces in a transient *side-panel* opened from the rail; the subsequent "fix" for a naming collision folded everything into a *destination page* (`/w/:wslug/agents`, commit `21ef82d`). Both are wrong for a first-class actor: a destination page means you **navigate away from your work** to "manage agents," then back. You want to **watch the agent work next to the thing it's working on** — assign a work-item in the table, see the run spin up and the result land, approve/reject — without leaving the table.

**This design replaces the page-consolidation with a persistent agent COCKPIT panel** beside the worktable (the Linear/Cursor "agent panel" pattern). The `21ef82d` page-consolidation is reverted (the agents page reverts to the agent list it was before E; its tabbed Activity/Run move into the panel).

## The shape

```
┌──────┬───────────────────────────┬─────────────────┐
│ rail │   center (worktable)      │  agent cockpit  │
│      │   — table / board / doc   │  panel (~360px) │
│      │     stays put, just       │  PERSISTENT,    │
│      │     narrower               │  pushes center  │
└──────┴───────────────────────────┴─────────────────┘
```

- **Persistent agent cockpit panel** mounts in `Shell`'s existing `panel` slot (a fixed-width flex child → it pushes `main` left; `Shell` is already `flex` with `flex-1 min-w-0` main). It is NOT a slideover/overlay — it's a real layout column that reflows the center. Toggleable (rail tool + Cmd-K); stays open while you work in the table.
- **Width:** the panel itself is a fixed, narrow ~360px cockpit. It does NOT resize for config (that's what the slideover is for).

### Panel contents (the runtime cockpit — narrow is fine)
A compact NocoDB-style icon-tab header (reuse the `panel-header.tsx` pattern — but that file was deleted in `21ef82d`; rebuild a minimal header) with screens:
- **⚡ Activity** (default) — the workspace-wide run feed (`useActivityFeed` + `RunRow`/feed-row), rows click → open the parent doc + its comments (co-presence: the run's target opens in the center). KEEP `activity-feed-screen.tsx`.
- **▶ Run** — the launcher (`agent-run-launcher.tsx`, KEEP): pick agent → target → instruction → `POST /runs`; on launch → switch to Activity.
- **Agents (list)** — the agent list (pick/see agents). Clicking an agent → opens the **config slideover** (below). This is the list currently on the agents page; it moves into the panel.
- Approve/reject stays in comments (E-6), surfaced via the Activity feed linking to the parent.

### Config slideover (option A + resizable)
The agent DOCUMENT (create/edit: system_prompt, model/provider, tools, project allow-list) opens as a **slideover anchored to the panel** — it overlays the panel AND spills LEFT over the center's right edge, wider than the panel, so config gets room WITHOUT widening the always-on cockpit and WITHOUT shrinking the worktable further.
- **Resizable:** a drag handle on the slideover's LEFT edge lets the user widen/narrow it (for a long system_prompt). Width persists (localStorage, per the existing width-persistence-free codebase → a small `useResizableWidth(key, default, min, max)` hook). Min ~360px, max ~70vw, default ~480px.
- The slideover is the EXISTING agent config surface (`workspace-document-slideover.tsx`'s Fields tab — the FrontmatterForm with ProviderModelField/ToolsField/ProjectsField) — re-homed to open over the panel instead of from the agents page. Its Runs/Activity tabs (per-agent history) come along.
- Closing the slideover returns to the cockpit panel (still open behind it).

## What changes (delta from the current `21ef82d` state)

1. **Revert the page-consolidation tabs**: `workspace-agents-page.tsx` goes back to just the agent LIST (no Agents|Activity|Run page tabs). The `view` search param on `w.$wslug.agents.tsx` is removed. (The page still exists as the dropdown destination + the list source the panel reuses; OR the dropdown "Agents" now just toggles the cockpit panel — decide at plan time, lean: dropdown toggles the panel, the page becomes a thin list the panel embeds.)
2. **Rebuild the persistent panel**: a new `AgentCockpitPanel` mounted in `Shell.panel` via `w.$wslug.tsx`, toggled by a rail tool (label: **"Agents"** is now unambiguous again — there's no competing page) + Cmd-K "Run agent…" (opens the panel on ▶ Run). Re-introduce a panel open/close state (a small bus or a context — the deleted `agent-panel-bus.ts` pattern, rebuilt; or lift to the `w.$wslug` route state).
3. **Config slideover**: the agent config opens as the resizable left-spilling slideover anchored to the panel. Reuse `workspace-document-slideover.tsx` content; change its mount/positioning + add the resize handle.
4. **New**: `useResizableWidth` hook + a `ResizeHandle` affordance (net-new; no existing infra).
5. **Keep**: `activity-feed-screen.tsx`, `agent-run-launcher.tsx`, `useActivityFeed`, `useRuns`/`useRunsLiveSync`, `RunRow`/`RunStatusChip`, the per-agent slideover content.

## Width behavior (the resolved tension)
- Cockpit panel: **fixed ~360px** (narrow, ambient, always the same width — no jumping).
- Config slideover: **resizable, overlays the panel + spills left**, default ~480px, persists. The worktable's width is unchanged when config opens (the slideover floats over the panel + the center's right edge, it doesn't reflow the flex layout).

## Open decisions for spec/plan review
- **Dropdown "Agents"**: toggle the cockpit panel, OR keep a thin list page? (Lean: toggle the panel — one agent surface.)
- **Panel persistence across navigation**: stays open as you move between projects/docs? (Lean: yes — it's ambient.)
- **Mobile/narrow viewport**: below some width the panel becomes an overlay rather than pushing center? (Defer — desktop-first per the "keyboard-fast Linear-like" wedge.)

## Testing
- `AgentCockpitPanel`: renders the icon-tab header + 3 screens; toggle open/close; Cmd-K opens on Run; rail tool opens on Activity.
- `useResizableWidth`: drag updates width, clamps to min/max, persists + restores from localStorage.
- Config slideover: opens over the panel; resize handle widens it; closing returns to the panel.
- Revert: the agents page no longer has page tabs; `view` param gone; no dangling refs.
- Full web suite green; the deleted-then-rebuilt panel components re-tested.

## Threat model
No new server surface — pure web layout/interaction reshape over already-gated endpoints (runs, documents, comments). Inherits Phase 3 mitigations 1–66. No threat-model extension.
